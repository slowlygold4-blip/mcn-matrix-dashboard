import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { checksum } from '../lib/utils.mjs';
import { initializeWorksOnlyObservations, recordWorksOnlyObservation } from '../lib/works-only-observation.mjs';

const SEC = 'MS4wLjABAAAAIndependentWorksOnlyAccount123456';
const UID = '101115710974';
const ANCHOR = '2026-09-28T15:59:00.000Z';
const START = '2026-09-28T16:00:01.000Z';
const PAGE = '2026-09-28T16:00:02.000Z';
const END = '2026-09-28T16:00:03.000Z';
const NOW = Date.parse('2026-09-28T16:01:00.000Z');
const invalid = error => error.code === 'WORKS_OBSERVATION_INVALID';

function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(ANCHOR) });
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const db = database.db;
  assert.equal(db.prepare("SELECT count(*) n FROM works_observations").get().n, 0);
  const target = database.createTarget({ type: 'account', label: 'offline-only', locator: SEC,
    provider: 'public-web', metadata: { platform: 'douyin' } });
  const raw = { capturedAt: ANCHOR, accountStatus: 'validated', accountError: null,
    profile: { user: { sec_uid: SEC, uid: UID, follower_count: 12, total_favorited: 33, aweme_count: 1 } },
    worksCoverage: 'unavailable', worksErrorCode: 'deferred', works: { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } },
    provenance: { mode: 'guest-ttwid-unsigned-profile', profileMode: 'guest-ttwid-unsigned-profile',
      profileEndpoint: 'https://www.douyin.com/aweme/v1/web/user/profile/other/', accountLocator: 'sec_uid',
      cookiePersisted: false, runtimeAI: false, paidAPI: false } };
  database.saveCollection(target, null, normalizeCollection(target, raw, { capturedAt: ANCHOR }));
  const anchor = db.prepare('SELECT * FROM snapshots WHERE target_id=?').get(target.id);
  initializeWorksOnlyObservations(db);
  const runId = database.beginRun('works-only', target.id, 1);
  const input = { targetId: target.id, runId, anchorSnapshotId: anchor.id, anchorChecksum: anchor.source_checksum,
    requestStartedAt: START, requestFinishedAt: END, result: { status: 'ok', hasMore: false, maxCursor: 0,
      posts: [{ aweme_id: '7200000000000000001', author: { sec_uid: SEC, uid: UID }, statistics: { digg_count: 9 } }],
      pagination: { version: 1, maxPages: 3, requestCount: 1, collectedCount: 1, stopReason: 'end-of-list', errorCode: null,
        pages: [{ requestCursor: 0, response: { max_cursor: 0, has_more: false }, rawCount: 1, acceptedCount: 1,
          duplicateCount: 0, filteredCount: 0, truncated: false, observedAt: PAGE }] } } };
  const save = value => recordWorksOnlyObservation(db, value, { now: NOW });
  return { database, db, target, anchor, raw, input, save };
}

function protectedState(db, { includePosts = true } = {}) {
  return Object.fromEntries(['targets', 'snapshots', ...(includePosts ? ['posts', 'post_metrics'] : []), 'audits', 'account_events']
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}

test('independent works ledger: real profile anchor, cross-BJT-midnight works persist metrics without new profile', t => {
  const { db, input, save } = fixture(t);
  const before = protectedState(db, { includePosts: false });
  const result = save(input);
  assert.equal(result.status, 'accepted'); assert.equal(result.coverage, 'limited'); assert.equal(result.observedAt, PAGE);
  assert.deepEqual(protectedState(db, { includePosts: false }), before, 'works-only may not mutate profile, audits or target freshness');
  assert.equal(db.prepare('SELECT count(*) n FROM posts').get().n, 1);
  assert.deepEqual({ ...db.prepare('SELECT captured_at,likes FROM post_metrics').get() }, { captured_at: PAGE, likes: 9 });
  const row = db.prepare('SELECT * FROM works_observations').get();
  assert.equal(checksum(JSON.parse(row.raw_json)), row.source_checksum);
  assert.equal(row.anchor_checksum, input.anchorChecksum);
  assert.equal(row.observed_at, PAGE);
  assert.throws(() => db.prepare('UPDATE works_observations SET observed_at=?').run(END), /immutable/);
  assert.throws(() => db.exec('DELETE FROM works_observations'), /immutable/);
});

const mutations = [
  ['missing actual anchor', f => { f.input.anchorSnapshotId += 100; }],
  ['anchor belongs to other target', f => { f.input.targetId += 100; }],
  ['paused target', f => f.db.prepare('UPDATE targets SET enabled=0 WHERE id=?').run(f.target.id)],
  ['changed stable locator', f => f.db.prepare("UPDATE targets SET locator='MS4wLjABAAAADifferentStableAccount12345' WHERE id=?").run(f.target.id)],
  ['changed provider', f => f.db.prepare("UPDATE targets SET provider='manual' WHERE id=?").run(f.target.id)],
  ['wrong anchor checksum', f => { f.input.anchorChecksum = '0'.repeat(64); }],
  ['tampered raw while original checksum retained', f => { f.raw.profile.user.uid = '999'; f.db.prepare('UPDATE snapshots SET raw_json=? WHERE id=?').run(JSON.stringify(f.raw), f.anchor.id); }],
  ['rejected anchor', f => f.db.prepare("UPDATE snapshots SET quality_status='rejected' WHERE id=?").run(f.anchor.id)],
  ['unavailable profile anchor', f => f.db.prepare("UPDATE snapshots SET account_status='unavailable' WHERE id=?").run(f.anchor.id)],
  ['anchor captured time contradicts raw', f => f.db.prepare('UPDATE snapshots SET captured_at=? WHERE id=?').run(START, f.anchor.id)],
  ['stale anchor over eight hours', f => { f.input.requestStartedAt = '2026-09-29T00:00:01.000Z'; f.input.requestFinishedAt = '2026-09-29T00:00:03.000Z';
    f.input.result.pagination.pages[0].observedAt = '2026-09-29T00:00:02.000Z';
    f.save = value => recordWorksOnlyObservation(f.db, value, { now: Date.parse('2026-09-29T00:00:04.000Z') }); }],
  ['future request finish', f => { f.input.requestFinishedAt = '2026-09-28T16:01:01.000Z'; }],
  ['request beyond 45 seconds', f => { f.input.requestFinishedAt = '2026-09-28T16:00:47.000Z'; }],
  ['page before actual request', f => { f.input.result.pagination.pages[0].observedAt = ANCHOR; }],
  ['page after request finish', f => { f.input.result.pagination.pages[0].observedAt = '2026-09-28T16:00:04.000Z'; }],
  ['wrong author secUID', f => { f.input.result.posts[0].author.sec_uid += 'other'; }],
  ['same secUID but conflicting UID', f => { f.input.result.posts[0].author.uid = '999'; }],
  ['missing work UID', f => { delete f.input.result.posts[0].author.uid; }],
  ['missing work ID', f => { delete f.input.result.posts[0].aweme_id; }],
  ['unknown has_more cannot be sanitized into end', f => { f.input.result.pagination.pages[0].response.has_more = 'false'; }],
  ['forged accepted count', f => { f.input.result.pagination.pages[0].acceptedCount = 2; }],
  ['failure with successful posts', f => { f.input.result.status = 'unavailable'; f.input.result.errorCode = 'blocked'; }],
  ['unsafe metric', f => { f.input.result.posts[0].statistics.digg_count = Number.MAX_SAFE_INTEGER + 1; }],
  ['original audit cannot be bypassed by rehashing tampered anchor', f => {
    f.raw.profile.user.uid = '999'; f.input.anchorChecksum = checksum(f.raw); f.input.result.posts[0].author.uid = '999';
    f.db.prepare('UPDATE snapshots SET raw_json=?,source_checksum=? WHERE id=?').run(JSON.stringify(f.raw), f.input.anchorChecksum, f.anchor.id);
  }],
  ['missing accepted audit', f => f.db.exec('DELETE FROM audits')],
  ['anchor was only committed after works request started', f => f.db.prepare('UPDATE audits SET created_at=?').run(END)],
  ['known deleted lifecycle', f => f.db.prepare(`INSERT INTO account_events(target_id,event_type,event_key,observed_at,source_checksum,event_json,raw_json,created_at)
    VALUES(?,'lifecycle','offline-deleted',?,'offline','{"state":"deleted"}','{}',?)`).run(f.target.id, START, START)],
  ['boolean target id', f => { f.input.targetId = true; }],
  ['invalid requested cap', f => { f.input.requestedLimit = 0; }],
];
for (const [name, mutate] of mutations) test(`independent works ledger rejects ${name}`, t => {
  const f = fixture(t); mutate(f);
  const before = protectedState(f.db);
  assert.throws(() => f.save(f.input), invalid);
  assert.equal(f.db.prepare('SELECT count(*) n FROM works_observations').get().n, 0);
  assert.deepEqual(protectedState(f.db), before);
});

test('independent works ledger rejects superseded actual DB snapshot', t => {
  const f = fixture(t); const nextRaw = { ...f.raw, capturedAt: '2026-09-28T15:59:30.000Z' };
  f.database.saveCollection(f.target, null, normalizeCollection(f.target, nextRaw, { capturedAt: nextRaw.capturedAt }));
  assert.throws(() => f.save(f.input), invalid);
});

test('independent works ledger same-time identity is idempotent, conflict cannot replace history', t => {
  const f = fixture(t); const first = f.save(f.input);
  const original = f.db.prepare('SELECT * FROM works_observations').all();
  const duplicate = f.save(structuredClone(f.input));
  assert.equal(duplicate.id, first.id); assert.equal(duplicate.duplicate, true);
  const conflict = structuredClone(f.input); conflict.result.posts[0].statistics.digg_count++;
  assert.throws(() => f.save(conflict), invalid);
  assert.deepEqual(f.db.prepare('SELECT * FROM works_observations').all(), original);
});

test('independent works ledger late accepted history cannot erase newer failure or renew old success', t => {
  const f = fixture(t);
  const later = structuredClone(f.input);
  later.runId = f.database.beginRun('works-only', f.target.id, 1);
  later.requestStartedAt = '2026-09-28T16:00:10.000Z'; later.requestFinishedAt = '2026-09-28T16:00:12.000Z';
  later.result = { status: 'unavailable', posts: [], errorCode: 'blocked', error: 'SECRET-SENTINEL' };
  f.save(later); f.save(f.input);
  const rows = f.db.prepare('SELECT * FROM works_observations ORDER BY request_finished_at DESC,id DESC').all();
  assert.equal(rows[0].status, 'unavailable'); assert.equal(rows[0].observed_at, null);
  assert.equal(rows[1].status, 'accepted'); assert.equal(rows[1].observed_at, PAGE);
  assert.equal(rows[0].raw_json.includes('SECRET-SENTINEL'), false);
});

test('independent works ledger persists only canonical counters, not caller secrets or invented inventory proof', t => {
  const f = fixture(t); f.input.result.cookie = 'SECRET-SENTINEL';
  f.input.result.worksCoverage = 'complete'; f.input.result.freshInventory = 1;
  Object.assign(f.input.result.posts[0], { desc: 'ordinary public caption', share_url: 'https://invalid/?token=[REDACTED]' });
  f.input.result.pagination.pages[0].headers = { cookie: 'SECRET-SENTINEL' };
  assert.equal(f.save(f.input).coverage, 'limited');
  const row = f.db.prepare('SELECT raw_json FROM works_observations').get();
  assert.equal(row.raw_json.includes('SECRET-SENTINEL'), false);
  assert.equal(row.raw_json.includes('freshInventory'), false);
});
