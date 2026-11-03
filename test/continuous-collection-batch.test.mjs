import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { MonitorScheduler } from '../lib/scheduler.mjs';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';
import { selectContinuousCollectionBatch, CONTINUOUS_COLLECTION_BATCH_LIMIT } from '../lib/continuous-collection-batch.mjs';

const NOW = Date.parse('2026-11-03T16:00:00.000Z');
const row = (id, last_checked_at, extra = {}) => ({ id, type: 'account', enabled: true, provider: 'public-web', last_checked_at, ...extra });

test('admission prioritises due topics and old attempts without changing due/backoff decisions or input order', () => {
  const targets = [row(5, null), row(1, '2026-11-03T01:00:00Z'), row(2, null, { enabled: false }),
    row(3, null, { provider: 'manual' }), row(4, '2026-11-03T10:00:00Z', { type: 'hashtag' }), row(6, null)];
  const before = structuredClone(targets);
  assert.deepEqual(selectContinuousCollectionBatch(targets, [1, 2, 3, 4, 5], new Date(NOW), 3), [4, 5, 1]);
  assert.deepEqual(targets, before);
  assert.deepEqual(selectContinuousCollectionBatch(targets, [1], new Date(NOW), 3), [1], 'a not-due new account must not re-enter');
});

test('never attempted, invalid and future clocks cannot be silently parked; ties have stable exact-ID order', () => {
  const targets = [row(4, '2027-01-01T00:00:00Z'), row(3, 'broken'), row(2, null), row(1, '2026-11-03T00:00:00Z')];
  assert.deepEqual(selectContinuousCollectionBatch(targets, [1, 2, 3, 4], new Date(NOW)), [2, 3, 4, 1]);
  assert.throws(() => selectContinuousCollectionBatch(targets, [], new Date(NaN)), RangeError);
  assert.throws(() => selectContinuousCollectionBatch(targets, [], new Date(NOW), 0), RangeError);
});

test('a smaller platform is admitted alongside a large backlog without inventing due targets or concurrency', () => {
  const large = Array.from({ length: 100 }, (_, i) => row(i + 1, '2026-11-03T01:00:00Z'));
  const small = Array.from({ length: 14 }, (_, i) => row(i + 101, '2026-11-03T02:00:00Z', { metadata: { platform: 'bilibili' } }));
  const result = selectContinuousCollectionBatch([...small, ...large], [...large, ...small].map(t => t.id), new Date(NOW));
  assert.equal(result.length, 64);
  assert.equal(result.filter(id => id > 100).length, 14);
  assert.deepEqual(result.slice(0, 4), [1, 101, 2, 102]);
  assert.equal(new Set(result).size, 64);
});

function fixture(t, { asyncPlanning = false } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const database = new MonitorDatabase(':memory:');
  t.after(() => database.close());
  const calls = [];
  for (let n = 0; n < 70; n++) database.createTarget({ type: 'account', provider: 'public-web',
    label: `Offline ${n}`, locator: `MS4wLjABofflineBatch${n}` });
  const scheduler = new MonitorScheduler(database, {
    continuousWindow: { key: 'fixture-continuous', startsAt: '2026-11-03T00:00:00.000Z', endsAt: '9999-12-31T23:59:59.999Z' },
    asyncPlanning, providerOptions: { cooldownMs: 0, execFileImpl(_file, args, _options, done) {
      calls.push(args[args.indexOf('--locator') + 1]);
      done(null, JSON.stringify({ ok: true, data: { capturedAt: new Date().toISOString(),
        profile: { user: { sec_uid: calls.at(-1), follower_count: 8, total_favorited: 10, aweme_count: 0 } }, works: { aweme_list: [] } } }), '');
    } },
  });
  // Same adapter contract as the isolated planner, using persisted attempts.
  if (asyncPlanning) scheduler.readPlanning = async (_mode, now) => ({ asOf: now.toISOString(),
    slotKey: scheduler.collectionSlot(now).key,
    dueIds: scheduler.scheduledDueTargetIds(scheduler.scheduledDateKey(now), now, scheduler.collectionSlot(now)),
    worksTargetId: null, roundSettled: false });
  return { database, scheduler, calls };
}

for (const asyncPlanning of [false, true]) test(`serial bounded batches retain every account, reopen admission and survive scheduler replacement (async=${asyncPlanning})`, async t => {
  const { database, scheduler, calls } = fixture(t, { asyncPlanning });
  await scheduler.tick();
  let runs = database.db.prepare('SELECT target_count,processed_count FROM runs ORDER BY id').all();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].target_count, CONTINUOUS_COLLECTION_BATCH_LIMIT);
  assert.equal(runs[0].processed_count, CONTINUOUS_COLLECTION_BATCH_LIMIT);
  assert.equal(new Set(calls).size, 64);
  assert.equal(scheduler.running, false);
  const added = database.createTarget({ type: 'account', provider: 'public-web', label: 'Joined during pass', locator: 'MS4wLjABJoinedDuringPass' });
  await scheduler.stop();
  const resumed = new MonitorScheduler(database, { continuousWindow: scheduler.continuousWindow, providerOptions: scheduler.providerOptions });
  t.after(() => resumed.stop());
  await resumed.tick();
  await resumed.tick();
  runs = database.db.prepare('SELECT target_count,processed_count FROM runs ORDER BY id').all();
  assert.deepEqual(runs.map(r => [r.target_count, r.processed_count]), [[64, 64], [7, 7]]);
  assert.equal(calls.length, 71);
  assert.equal(new Set(calls).size, 71, 'completed targets must not be resampled to make batch progress');
  assert.equal(database.db.prepare('SELECT COUNT(*) n FROM snapshots WHERE target_id=?').get(added.id).n, 1,
    JSON.stringify(database.db.prepare('SELECT status,message FROM audits WHERE target_id=?').all(added.id)));
});

test('manual full-refresh scope still includes all seventy accounts in one honest receipt', async t => {
  const { database, scheduler, calls } = fixture(t);
  await scheduler.runAll({ triggerType: 'manual-refresh' });
  assert.equal(calls.length, 70);
  const run = database.db.prepare('SELECT target_count,processed_count FROM runs').get();
  assert.deepEqual([run.target_count, run.processed_count], [70, 70]);
});

test('the actual scheduled provider loop preserves platform fairness and stays serial', async t => {
  const { database, scheduler } = fixture(t);
  const bili = database.listTargets().slice(-14);
  for (const target of bili) database.updateTarget(target.id, { metadata: { ...target.metadata, platform: 'bilibili' } });
  let active = 0, maximum = 0;
  const calls = [];
  t.mock.method(PublicWebProvider.prototype, 'collect', async target => {
    active++; maximum = Math.max(maximum, active); calls.push(target);
    await Promise.resolve(); active--;
    return { capturedAt: new Date().toISOString(), snapshot: { followers: 8, totalLikes: 10, totalPosts: 0 },
      posts: [], qualityStatus: 'validated', accountStatus: 'available', worksCoverage: 'complete',
      warnings: [], raw: { source: 'offline-serial-platform-fixture' } };
  });
  await scheduler.tick();
  assert.equal(calls.length, 64);
  assert.equal(maximum, 1);
  assert.equal(calls.slice(0, 28).filter(t => t.metadata.platform === 'bilibili').length, 14);
  assert.equal(database.db.prepare('SELECT COUNT(DISTINCT target_id) n FROM snapshots').get().n, 64);
});

test('failed small batch does not monopolise untouched accounts; finite backoff remains authoritative', async t => {
  const { database, scheduler } = fixture(t);
  scheduler.providerOptions.execFileImpl = (_f, _a, _o, done) => done(new Error('offline transient fixture'), '', '');
  await scheduler.tick();
  await scheduler.tick();
  assert.deepEqual(database.db.prepare('SELECT target_count FROM runs ORDER BY id').all().map(r => r.target_count), [64, 6]);
  assert.equal(database.db.prepare('SELECT COUNT(*) n FROM audits').get().n, 70);
  await scheduler.tick();
  assert.equal(database.db.prepare('SELECT COUNT(*) n FROM runs').get().n, 2, 'backoff must prevent immediate repeat of failed attempts');
});

test('small batches do not amplify failed automatic probes, but allow recovery and ignore manual-failure suppression', async t => {
  const { database, scheduler } = fixture(t);
  scheduler.scheduledSourceProbe = true;
  let calls = 0;
  t.mock.method(PublicWebProvider.prototype, 'testConnectionForPlatform', async () => { calls++; throw new Error('offline probe fixture'); });
  const targets = database.listTargets();
  await scheduler.runScheduledSourceProbe(targets, database.getSettings());
  assert.equal(calls, 1);
  t.mock.timers.setTime(NOW + 14 * 60_000);
  const reused = await scheduler.runScheduledSourceProbe(targets, database.getSettings());
  assert.equal(calls, 1);
  assert.equal(reused[0].ok, false, 'a deferred failure must not become a successful probe');
  assert.equal(reused[0].checkedAt, new Date(NOW).toISOString(), 'reuse must not freshen sampling time');
  t.mock.timers.setTime(NOW + 15 * 60_000);
  await scheduler.runScheduledSourceProbe(targets, database.getSettings());
  assert.equal(calls, 2, 'the endpoint must be eligible again after the bounded wait');
  database.recordSourceProbe('douyin-public', { ok: false, trigger: 'manual', error: 'offline manual fixture' });
  await scheduler.runScheduledSourceProbe(targets, database.getSettings());
  assert.equal(calls, 3);
});
