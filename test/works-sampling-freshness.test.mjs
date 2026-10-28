import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { MonitorScheduler } from '../lib/scheduler.mjs';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { BrowserWorksPagination } from '../lib/browser-works-pagination.mjs';
import { planWorksOnly } from '../lib/works-only-scheduler.mjs';
import { readWorksOnlyAnchor } from '../lib/works-only-observation.mjs';
import { readWorksSamplingState, loadVerifiedWorksOnlyRows } from '../lib/works-observation.mjs';

const BASE = Date.parse('2026-10-20T02:00:00.000Z');
const HOUR = 3600_000;
function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: BASE });
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const target = database.createTarget({ type: 'account', provider: 'public-web', label: 'offline author',
    locator: 'MS4wLjABAAAAWorksHeadFreshnessFixture1234' });
  const uid = '12345678', calls = [];
  const make = () => new MonitorScheduler(database, { worksOnlyEnabled: true, scheduleIntervalHours: 8,
    providerOptions: { accountBrowserFallback: true, fetchImpl: () => { throw Error('NO_NETWORK'); },
      execFileImpl: () => { throw Error('NO_PROCESS'); } } });
  const anchor = () => {
    const capturedAt = new Date().toISOString();
    const raw = { capturedAt, accountStatus: 'validated', accountError: null,
      profile: { user: { sec_uid: target.locator, uid, follower_count: 10, total_favorited: 20, aweme_count: 300 } },
      worksCoverage: 'unavailable', worksErrorCode: 'deferred',
      works: { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } },
      provenance: { mode: 'guest-ttwid-unsigned-profile', profileMode: 'guest-ttwid-unsigned-profile',
        profileEndpoint: 'https://www.douyin.com/aweme/v1/web/user/profile/other/', accountLocator: 'sec_uid',
        cookiePersisted: false, runtimeAI: false, paidAPI: false } };
    const run = database.beginRun('scheduled', target.id, 1);
    database.saveCollection(target, run, normalizeCollection(target, raw, { capturedAt }));
    database.finishRun(run, { status: 'success', successCount: 1, processedCount: 1 });
    t.mock.timers.setTime(Date.now() + 1000);
  };
  t.mock.method(PublicWebProvider.prototype, 'runBrowserWorks', async item => {
    calls.push(item.startCursor ?? 0);
    const cursor = item.startCursor ?? 0;
    const day = Math.floor((Date.now() - BASE) / (8 * HOUR));
    // A genuinely new head includes new IDs; old-cursor pages never include
    // them. The assertion therefore checks discovery, not just an option flag.
    const offset = cursor || day * 1000;
    const posts = Array.from({ length: 30 }, (_, i) => ({
      aweme_id: String(7300000000000000000n + BigInt(offset + i)),
      author: { sec_uid: target.locator, uid }, create_time: BASE / 1000 - 3600 + day * 8 * 3600,
      statistics: { digg_count: 5 } }));
    t.mock.timers.setTime(Date.now() + 20);
    const ledger = new BrowserWorksPagination({ limit: item.limit, startCursor: item.startCursor });
    ledger.accept({ requestCursor: cursor, body: { aweme_list: posts, has_more: true },
      normalized: { posts, maxCursor: cursor + 100, filteredCount: 0, duplicateCount: 0, locallyTruncated: false },
      observedAt: new Date().toISOString() });
    return { items: [{ key: item.key, status: 'ok', errorCode: null, ...ledger.result(1) }] };
  });
  const plan = () => {
    const scheduler = make(), slot = scheduler.collectionSlot();
    return planWorksOnly(database, scheduler.scheduledTargetAttemptStates(scheduler.scheduledDateKey(), slot),
      { now: new Date(), slot });
  };
  return { database, target, uid, calls, anchor, make, plan,
    state: () => readWorksSamplingState(database.db, target.id, readWorksOnlyAnchor(database.db, target.id), new Date().toISOString()) };
}

test('fresh head then bounded backfill; expired head discovers new posts before resuming the old chain', async t => {
  const f = fixture(t); f.anchor(); await f.make().tick();
  assert.equal(f.plan().due[0].samplingMode, 'backfill');
  await f.make().tick();
  assert.deepEqual(f.calls, [0, 100]);
  await f.make().tick(); assert.equal(f.calls.length, 2, 'two source attempts per slot remain the hard bound');
  for (const hours of [8, 16, 24]) {
    t.mock.timers.setTime(BASE + hours * HOUR + hours * 1000); f.anchor();
    assert.equal(f.plan().due[0].samplingMode, 'head');
    await f.make().tick();
  }
  const latest = loadVerifiedWorksOnlyRows(f.database.db, new Date().toISOString(), f.target.id);
  assert.ok(latest.every(row => !row.raw.continuation), JSON.stringify({ calls:f.calls, rows:latest.map(row=>({runId:row.run_id, cursor:row.raw.pagination.pages[0].requestCursor,at:row.request_finished_at})) }));
  assert.equal(f.state().continuation.cursor, 200, 'the indexed historical pin retains the deeper saved cursor');
  await f.make().tick();
  assert.deepEqual(f.calls, [0, 100, 0, 0, 0, 200]);
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM posts').get().n, 180);
  assert.ok(f.database.db.prepare('SELECT 1 FROM posts WHERE external_id=?').get('7300000000000001000'), 'the new head work is actually persisted');
  const last = loadVerifiedWorksOnlyRows(f.database.db, new Date().toISOString(), f.target.id)[0];
  assert.equal(last.raw.continuation.depth, 2);
  assert.equal(last.works_coverage, 'limited', 'freshness plus backfill is never advertised as a complete inventory');
});

test('an unvisited author head takes priority over another author historical backfill', async t => {
  const f = fixture(t); f.anchor(); await f.make().tick();
  assert.equal(f.plan().due[0].samplingMode, 'backfill');
  const other = f.database.createTarget({ type: 'account', provider: 'public-web', label: 'unvisited author',
    locator: 'MS4wLjABAAAAWorksHeadOtherFixture1234567' });
  const raw = JSON.parse(f.database.db.prepare('SELECT raw_json FROM snapshots WHERE target_id=?').get(f.target.id).raw_json);
  raw.capturedAt = new Date().toISOString(); raw.profile.user.sec_uid = other.locator;
  const run = f.database.beginRun('scheduled', other.id, 1);
  f.database.saveCollection(other, run, normalizeCollection(other, raw, { capturedAt: raw.capturedAt }));
  f.database.finishRun(run, { status: 'success', processedCount: 1, successCount: 1 });
  const due = f.plan().due;
  assert.deepEqual(due.map(row => [row.target.id, row.samplingMode]), [[other.id, 'head'], [f.target.id, 'backfill']]);
});

test('an expired head must discover a newly published work even while an old cursor exists', async t => {
  const f = fixture(t); f.anchor(); await f.make().tick();
  assert.equal(f.state().continuation.cursor, 100);
  t.mock.timers.setTime(BASE + 8 * HOUR + 5000); f.anchor();
  await f.make().tick();
  assert.deepEqual(f.calls, [0, 0]);
  assert.ok(f.database.db.prepare('SELECT 1 FROM posts WHERE external_id=?').get('7300000000000001000'));
});

test('missing identity, forged source and exact freshness deadline never become a fresh head receipt', async t => {
  const f = fixture(t); f.anchor(); await f.make().tick();
  const row = f.database.db.prepare('SELECT * FROM works_observations').get();
  const identity = { secUid: f.target.locator, uid: f.uid };
  assert.equal(readWorksSamplingState(f.database.db, f.target.id, { ...identity, uid: '88888888' }, new Date().toISOString()).headFresh, false);
  const deadline = Date.parse(row.request_finished_at) + 8 * HOUR;
  assert.equal(readWorksSamplingState(f.database.db, f.target.id, identity, new Date(deadline - 1).toISOString()).headFresh, true);
  assert.equal(readWorksSamplingState(f.database.db, f.target.id, identity, new Date(deadline).toISOString()).samplingMode, 'head');
  f.database.db.exec('DROP TRIGGER works_observations_no_update');
  f.database.db.prepare('UPDATE works_observations SET source_checksum=? WHERE id=?').run('0'.repeat(64), row.id);
  assert.deepEqual(readWorksSamplingState(f.database.db, f.target.id, identity, new Date().toISOString()),
    { headFresh: false, lastHeadAt: null, continuation: null, samplingMode: 'head' });
});

test('the head/backfill hint query uses its derived index and does not modify history', async t => {
  const f = fixture(t); f.anchor(); await f.make().tick();
  const before = f.database.db.prepare('SELECT total_changes() n').get().n;
  f.state();
  assert.equal(f.database.db.prepare('SELECT total_changes() n').get().n, before);
  const query = `SELECT id FROM works_observations WHERE target_id=? AND status='accepted'
    AND (CASE WHEN json_valid(raw_json) THEN json_type(raw_json,'$.continuation') IS NOT NULL ELSE 0 END)=?
    AND julianday(request_finished_at)<=julianday(?) ORDER BY julianday(request_finished_at) DESC,id DESC LIMIT 1`;
  const plan = f.database.db.prepare('EXPLAIN QUERY PLAN ' + query).all(f.target.id, 0, new Date().toISOString());
  assert.ok(plan.some(row => row.detail.includes('works_observations_sampling_windows')), JSON.stringify(plan));
  assert.ok(plan.every(row => !row.detail.includes('TEMP B-TREE')), JSON.stringify(plan));
});
