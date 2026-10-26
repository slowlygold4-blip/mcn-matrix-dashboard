import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitorDatabase } from '../lib/database.mjs';
import { checksum } from '../lib/utils.mjs';
import { BrowserWorksPagination } from '../lib/browser-works-pagination.mjs';
import { normalizeBrowserWorks } from '../scripts/douyin_browser_collector.mjs';
import { initializeWorksOnlyObservations, recordWorksOnlyObservation } from '../lib/works-only-observation.mjs';

const SEC = 'MS4wLjABAAAAWorksOnlyFixture12345678', UID = '123456789';
const ANCHOR = '2026-09-28T23:59:00.000Z', START = '2026-09-29T00:00:00.000Z', END = '2026-09-29T00:00:10.000Z';
function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(ANCHOR) });
  const directory = mkdtempSync(join(tmpdir(), 'works-only-owner-'));
  const database = new MonitorDatabase(join(directory, 'fixture.sqlite'));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(database.db.prepare("SELECT COUNT(*) n FROM works_observations").get().n, 0);
  const target = database.createTarget({ type: 'account', provider: 'public-web', locator: SEC, label: 'offline' });
  const raw = { capturedAt: ANCHOR, accountStatus: 'validated', accountError: null,
    profile: { user: { sec_uid: SEC, uid: UID, follower_count: 12, total_favorited: 33, aweme_count: 1 } },
    worksCoverage: 'unavailable', worksErrorCode: 'deferred', works: { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } },
    provenance: { mode: 'guest-ttwid-unsigned-profile', profileMode: 'guest-ttwid-unsigned-profile',
      profileEndpoint: 'https://www.douyin.com/aweme/v1/web/user/profile/other/', accountLocator: 'sec_uid', cookiePersisted: false, runtimeAI: false, paidAPI: false } };
  const runId = database.beginRun('manual', target.id, 1);
  database.saveCollection(target, runId, { raw, capturedAt: ANCHOR, sourceChecksum: checksum(raw),
    snapshot: { followers: 12, totalLikes: 33, totalPosts: 1 }, posts: [], accountStatus: 'available', worksCoverage: 'unavailable', qualityStatus: 'warning' });
  initializeWorksOnlyObservations(database.db);
  const page = new BrowserWorksPagination({ limit: 30 });
  const body = { status_code: 0, max_cursor: 0, has_more: false,
    aweme_list: [{ aweme_id: '7200000000000000001', author: { sec_uid: SEC, uid: UID }, statistics: { digg_count: 4 } }] };
  page.accept({ requestCursor: 0, body, normalized: normalizeBrowserWorks(body, SEC), observedAt: END });
  const r = page.result(1);
  const input = { targetId: target.id, runId: database.beginRun('works-only', target.id, 1), anchorSnapshotId: database.db.prepare('SELECT id FROM snapshots').get().id,
    anchorChecksum: checksum(raw), requestStartedAt: START, requestFinishedAt: END,
    result: { status: 'ok', posts: r.posts, hasMore: r.hasMore, maxCursor: r.maxCursor, pagination: r.pagination } };
  return { database, db: database.db, target, input, now: Date.parse(END) };
}
const record = f => recordWorksOnlyObservation(f.db, f.input, { now: f.now });

test('explicit isolated ledger accepts timed works but never creates fresh profile or full coverage', t => {
  const f = fixture(t);
  const before = JSON.stringify({ snapshots: f.db.prepare('SELECT * FROM snapshots').all(), targets: f.db.prepare('SELECT * FROM targets').all(), audits: f.db.prepare('SELECT * FROM audits').all() });
  const result = record(f);
  assert.equal(result.status, 'accepted'); assert.equal(result.coverage, 'limited');
  assert.equal(result.observedAt, END);
  assert.equal(record(f).duplicate, true);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM works_observations').get().n, 1);
  assert.equal(JSON.stringify({ snapshots: f.db.prepare('SELECT * FROM snapshots').all(), targets: f.db.prepare('SELECT * FROM targets').all(), audits: f.db.prepare('SELECT * FROM audits').all() }), before);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM posts').get().n, 1);
  assert.equal(f.db.prepare('SELECT captured_at FROM post_metrics').get().captured_at, END);
  assert.throws(() => f.db.exec("UPDATE works_observations SET coverage='unavailable'"), /immutable/);
  assert.throws(() => f.db.exec('DELETE FROM works_observations'), /immutable/);
});

test('unknown raw fields and error text are stripped; same-time different evidence rejects atomically', t => {
  const f = fixture(t); f.input.result.cookie = 'SECRET'; f.input.result.posts[0].headers = { Authorization: 'SECRET' };
  record(f);
  assert.equal(f.db.prepare('SELECT raw_json FROM works_observations').get().raw_json.includes('SECRET'), false);
  f.input.result.posts[0].statistics.digg_count++;
  assert.throws(() => record(f), { code: 'WORKS_OBSERVATION_INVALID' });
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM works_observations').get().n, 1);
});

test('paused target, changed actual anchor, UID conflict and future times cannot append', async t => {
  for (const [name, mutate] of [
    ['paused', f => f.db.prepare('UPDATE targets SET enabled=0').run()],
    ['hash mismatch', f => f.db.prepare("UPDATE snapshots SET raw_json='{}'").run()],
    ['UID conflict', f => { f.input.result.posts[0].author.uid = '88888'; }],
    ['future', f => { f.now -= 1; }],
    ['invalid now', f => { f.now = NaN; }],
    ['wrong platform', f => f.db.prepare('UPDATE targets SET metadata_json=?').run('{"platform":"bilibili"}')],
    ['stale', f => { f.input.requestStartedAt = '2026-09-29T09:00:00.000Z'; f.input.requestFinishedAt = '2026-09-29T09:00:10.000Z'; f.now = Date.parse(f.input.requestFinishedAt); }],
  ]) await t.test(name, st => { const f = fixture(st); mutate(f); assert.throws(() => record(f), { code: 'WORKS_OBSERVATION_INVALID' }); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM works_observations').get().n, 0); });
});

test('caller transaction is not rolled back when isolated append cannot begin', t => {
  const f = fixture(t); f.db.exec('BEGIN');
  f.db.prepare("UPDATE targets SET label='transaction retained'").run();
  assert.throws(() => record(f), { code: 'WORKS_OBSERVATION_INVALID' });
  assert.equal(f.db.prepare('SELECT label FROM targets').get().label, 'transaction retained');
  f.db.exec('ROLLBACK');
});

test('failure preserves accepted ledger and cannot acquire observation freshness', t => {
  const f = fixture(t); record(f);
  f.input.runId = f.database.beginRun('works-only', f.target.id, 1);
  f.input.requestStartedAt = '2026-09-29T00:01:00.000Z'; f.input.requestFinishedAt = '2026-09-29T00:01:10.000Z'; f.now = Date.parse(f.input.requestFinishedAt);
  f.input.result = { status: 'unavailable', posts: [], errorCode: 'blocked', error: 'SECRET' };
  const result = record(f);
  assert.equal(result.status, 'unavailable'); assert.equal(result.observedAt, null);
  assert.deepEqual(f.db.prepare('SELECT observed_at,status FROM works_observations ORDER BY request_finished_at').all().map(x => ({ ...x })), [
    { observed_at: END, status: 'accepted' }, { observed_at: null, status: 'unavailable' },
  ]);
});
