import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { recordRemoteWorkPage } from '../lib/remote-work-observation.mjs';
import { ensureRemoteWorkAttempts, reserveRemoteWorkAttempt, finishRemoteWorkAttempt } from '../lib/remote-work-evaluation.mjs';
import { publicAccountCoverage } from '../lib/public-account-coverage.mjs';
import { readVerifiedRemoteWorkPages } from '../lib/remote-work-coverage.mjs';
import { getAccountHistory } from '../lib/account-history.mjs';
import { exportPublicReplica } from '../lib/public-replica-export.mjs';
import { validCoverage } from '../frontend/lib/replica-coverage.mjs';
import { checksum } from '../lib/utils.mjs';

const SEC = 'MS4wLjABAAAARemoteAccountCoverage1234567', UID = '123456789';
const IDS = ['7300000000000000001', '7300000000000000002'];
const SOURCE = 'https://demo.douyin.wtf';
const ANCHOR = '2026-11-04T10:00:00.000Z', START = '2026-11-04T10:00:02.000Z';
const OBSERVED = '2026-11-04T10:00:03.000Z', END = '2026-11-04T10:00:04.000Z';
const COMMIT = '2026-11-04T10:00:05.000Z', LATER = '2026-11-04T10:10:00.000Z';
function profile(at) {
  const mode = 'guest-ttwid-unsigned-profile';
  return { capturedAt: at, accountStatus: 'validated', accountError: null,
    profile: { user: { sec_uid: SEC, uid: UID, follower_count: 12, total_favorited: 33, aweme_count: 2 } },
    worksCoverage: 'unavailable', worksErrorCode: 'deferred', works: { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } },
    provenance: { mode, profileMode: mode, profileEndpoint: 'https://www.douyin.com/aweme/v1/web/user/profile/other/',
      accountLocator: 'sec_uid', cookiePersisted: false, runtimeAI: false, paidAPI: false },
    worksRequestPolicy: { version: 1, endpoint: 'douyin.author_posts', scope: 'endpoint-transport',
      anonymous: { transport: 'anonymous-http', attempted: false, deferred: true, errorCode: 'blocked' },
      browser: { transport: 'authorised-browser', attempted: false, deferred: false, errorCode: null } },
    worksFallbackDeferred: { version: 1, reason: 'scheduled-profile-priority', mode: 'works-only' } };
}
function fixture(t, { automatic = false } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(ANCHOR) });
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const db = database.db;
  const target = database.createTarget({ type: 'account', label: 'synthetic coverage', provider: 'public-web', locator: SEC, metadata: { platform: 'douyin' } });
  const sample = (at, change = () => {}) => {
    t.mock.timers.setTime(Date.parse(at)); const raw = profile(at); change(raw);
    const run = database.beginRun('scheduled', target.id, 1);
    database.saveCollection(target, run, normalizeCollection(target, raw, { capturedAt: at }));
    database.finishRun(run, { status: 'success', successCount: 1 });
  };
  sample(ANCHOR);
  const anchorId = db.prepare('SELECT MAX(id) n FROM snapshots').get().n;
  let attempt;
  if (automatic) {
    ensureRemoteWorkAttempts(db);
    attempt = reserveRemoteWorkAttempt(db, { targetId: target.id, sourceOrigin: SOURCE,
      startsOn: '2026-11-04', endsOn: '2026-11-10', now: ANCHOR });
  }
  const receipt = { source: SOURCE, httpStatus: 200, requestStartedAt: START, requestFinishedAt: END,
    meta: { endpoint: 'douyin.author_posts', cached: false, request_id: 'coverage-first', guest_fallback: true },
    data: { has_more: false, cursor: null, items: IDS.map((id, index) => ({
      content_id: id, platform: 'douyin', title: `已核验作品${index + 1}`, created_at: '2026-09-21T14:13:22.000Z', fetched_at: OBSERVED,
      author: { sec_uid: SEC, uid: index ? UID : SEC, nickname: 'synthetic' }, is_deleted: false, is_private: false,
      stats: { digg_count: index ? 0 : 1988, comment_count: null, share_count: 1, collect_count: 2, play_count: null } })) } };
  t.mock.timers.setTime(Date.parse(COMMIT));
  recordRemoteWorkPage(db, { targetId: target.id, receipt }, { now: Date.parse(COMMIT),
    ...(attempt ? { attemptId: attempt.id, requestCount: 4 } : {}) });
  const read = (asOf = COMMIT, overrides = {}) => {
    const works = getAccountHistory(db, target.id, { kind: 'works', asOf, pageSize: 100 });
    const daily = getAccountHistory(db, target.id, { kind: 'daily', asOf, pageSize: 100 });
    const stored = db.prepare('SELECT * FROM targets WHERE id=?').get(target.id);
    return publicAccountCoverage(db, stored, { asOf, verifiedWorks: works.items, verifiedDaily: daily.items, ...overrides });
  };
  return { database, db, target, sample, receipt, read, attempt, anchorId };
}
function mutateFacts(db, change) {
  const row = db.prepare("SELECT * FROM account_events WHERE event_type='remote-work-observation' ORDER BY id DESC LIMIT 1").get();
  const raw = JSON.parse(row.raw_json), event = JSON.parse(row.event_json); change(raw);
  db.prepare('UPDATE account_events SET raw_json=?,event_json=?,source_checksum=? WHERE id=?').run(JSON.stringify(raw),
    JSON.stringify({ ...raw, anchorSnapshotId: event.anchorSnapshotId, anchorChecksum: event.anchorChecksum }), checksum(raw), row.id);
}

test('manual and automatic proved remote pages update account coverage without promoting complete or refreshing profile', async t => {
  for (const automatic of [false, true]) await t.test(String(automatic), st => {
    const f = fixture(st, { automatic });
    const before = f.db.prepare('SELECT total_changes() n').get().n;
    f.db.exec('PRAGMA query_only=ON');
    const result = f.read();
    assert.deepEqual(result, { version: 1, profileObservedAt: ANCHOR,
      works: { status: 'limited', attemptedAt: END, observedAt: OBSERVED } });
    assert.ok(validCoverage(result, COMMIT));
    const replica = exportPublicReplica(f.db, { asOf: COMMIT });
    assert.deepEqual(replica.catalog.accounts[0].coverage, result);
    assert.equal(replica.partitions.find(part => part.path === `works/${f.target.id}.json`).items.length, 2);
    assert.deepEqual(Object.keys(result.works).sort(), ['attemptedAt', 'observedAt', 'status']);
    assert.ok(!JSON.stringify(result).includes(SOURCE)); assert.ok(!JSON.stringify(result).includes(SEC));
    assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before);
  });
});

test('internal event identity and request finish are exposed only after complete proof verification', t => {
  const f = fixture(t);
  const page = [...readVerifiedRemoteWorkPages(f.db, { since: ANCHOR, now: COMMIT })][0];
  const row = f.db.prepare("SELECT id,source_checksum FROM account_events WHERE event_type='remote-work-observation'").get();
  assert.equal(page.eventId, row.id); assert.equal(page.sourceChecksum, row.source_checksum); assert.equal(page.requestFinishedAt, END);
  f.db.exec("UPDATE account_events SET source_checksum='broken'");
  assert.deepEqual([...readVerifiedRemoteWorkPages(f.db, { since: ANCHOR, now: COMMIT })], []);
});

test('cutoff before request finish or evidence commit cannot acquire the future receipt', t => {
  const f = fixture(t);
  for (const asOf of [START, OBSERVED, END, '2026-11-04T10:00:04.999Z']) {
    const result = f.read(asOf);
    assert.equal(result.works.observedAt, null); assert.notEqual(result.works.status, 'limited');
  }
  assert.equal(f.read().works.observedAt, OBSERVED);
});

test('new zero-request profile update preserves remote observation; real later list failure remains visible', t => {
  const f = fixture(t); f.sample(LATER);
  assert.deepEqual(f.read(LATER), { version: 1, profileObservedAt: LATER,
    works: { status: 'limited', attemptedAt: END, observedAt: OBSERVED } });
  const failedAt = '2026-11-04T10:15:00.000Z';
  f.sample(failedAt, raw => { raw.worksErrorCode = 'blocked'; raw.works.stopReason = 'request-failed';
    raw.works.pagination.requestCount = 1; raw.worksRequestPolicy.anonymous.attempted = true; });
  const asOf = '2026-11-04T10:20:00.000Z'; f.sample(asOf);
  const result = f.read(asOf);
  assert.deepEqual(result.works, { status: 'unavailable', attemptedAt: failedAt, observedAt: OBSERVED });
  assert.ok(validCoverage(result, asOf));
});

test('a remote observation does not authorize a work absent from the export history', t => {
  const f = fixture(t);
  assert.notEqual(f.read(COMMIT, { verifiedWorks: [{ externalId: IDS[0] }] }).works.status, 'limited');
  assert.notEqual(f.read(COMMIT, { verifiedWorks: [] }).works.status, 'limited');
});

test('disabled account retains historical limited observation without changing enabled scope', t => {
  const f = fixture(t); f.db.exec('UPDATE targets SET enabled=0');
  assert.equal(f.read().works.status, 'limited');
  assert.equal(exportPublicReplica(f.db, { asOf: COMMIT }).counts.enabledAccounts, 0);
});

test('receipt, owner, vector, anchor and commit failures never become valid account sampling', async t => {
  const cases = [
    ['raw digest', f => f.db.exec("UPDATE account_events SET source_checksum='invalid'")],
    ['event digest', f => f.db.exec("UPDATE account_events SET event_json='{}'")],
    ['bound event key', f => f.db.exec("UPDATE account_events SET event_key='invented'")],
    ['author UID', f => mutateFacts(f.db, raw => { raw.posts[0].author.uid = '999999999'; })],
    ['page identity', f => mutateFacts(f.db, raw => { raw.identity.secUid = 'MS4wLjABAAAAForeignAccount1234567'; })],
    ['posted vector', f => f.db.exec('UPDATE post_metrics SET likes=999')],
    ['anchor checksum', f => f.db.exec("UPDATE snapshots SET source_checksum='broken'")],
    ['anchor audit', f => f.db.exec("UPDATE audits SET status='rejected'")],
    ['future anchor', f => f.db.exec("UPDATE snapshots SET captured_at='2026-11-04T11:00:00.000Z'")],
    ['future commit', f => f.db.exec("UPDATE account_events SET created_at='2026-11-04T11:00:00.000Z'")],
    ['request finish before observation', f => mutateFacts(f.db, raw => { raw.requestFinishedAt = START; })],
    ['foreign platform', f => f.db.exec("UPDATE targets SET metadata_json='{\"platform\":\"bilibili\"}'")],
  ];
  for (const [name, mutate] of cases) await t.test(name, st => {
    const f = fixture(st); mutate(f); const result = f.read();
    assert.equal(result.works.observedAt, null); assert.notEqual(result.works.status, 'limited');
  });
});

test('automatic remote coverage requires successful matching task evidence', async t => {
  for (const sql of ["UPDATE remote_work_attempts SET status='failed',error_code='network_error',post_count=0,event_key=NULL",
    "UPDATE remote_work_attempts SET event_key='foreign'", "UPDATE remote_work_attempts SET finished_at='2026-11-04T10:00:06.000Z'"]) await t.test(sql, st => {
    const f = fixture(st, { automatic: true }); f.db.exec(sql);
    assert.equal(f.read().works.observedAt, null);
  });
});

test('a later failed remote task retains the proved partial observation without claiming task health or inventing a list request', async t => {
  for (const requestCount of [0, 1, 3]) await t.test(`total requests ${requestCount}`, st => {
    const f = fixture(st, { automatic: true });
    const at = '2026-11-05T10:00:00.000Z', finishedAt = '2026-11-05T10:00:04.000Z';
    f.sample(at);
    const attempt = reserveRemoteWorkAttempt(f.db, { targetId: f.target.id, sourceOrigin: SOURCE,
      startsOn: '2026-11-04', endsOn: '2026-11-10', now: at });
    st.mock.timers.setTime(Date.parse(finishedAt));
    finishRemoteWorkAttempt(f.db, attempt.id, { status: 'failed', errorCode: 'network_error', requestCount, now: finishedAt });
    assert.deepEqual(f.read(finishedAt).works, { status: 'limited', attemptedAt: END, observedAt: OBSERVED });
    const saved = f.db.prepare('SELECT status,error_code,request_count FROM remote_work_attempts WHERE id=?').get(attempt.id);
    assert.deepEqual({ ...saved }, { status: 'failed', error_code: 'network_error', request_count: requestCount });
  });
});
