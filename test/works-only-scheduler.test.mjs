import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { MonitorScheduler } from '../lib/scheduler.mjs';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { planWorksOnly } from '../lib/works-only-scheduler.mjs';
import { buildPostIngestionReview } from '../lib/post-ingestion-review.mjs';
import { validationCountsMatch } from '../lib/backup-manager.mjs';
import { ownedCollectorExecutor } from '../lib/collector-ownership.mjs';

const NOW = Date.parse('2026-09-29T02:01:00.000Z');
const SEC = 'MS4wLjABAAAARootWorksSchedulerAccount123456';
const UID = '12345678';
function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const target = database.createTarget({ type: 'account', provider: 'public-web', label: 'offline fixture', locator: SEC });
  const raw = { capturedAt: new Date().toISOString(), accountStatus: 'validated', accountError: null,
    profile: { user: { sec_uid: SEC, uid: UID, follower_count: 20, total_favorited: 40, aweme_count: 1 } },
    worksCoverage: 'unavailable', worksErrorCode: 'deferred', works: { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } },
    provenance: { mode: 'guest-ttwid-unsigned-profile', profileMode: 'guest-ttwid-unsigned-profile',
      profileEndpoint: 'https://www.douyin.com/aweme/v1/web/user/profile/other/', accountLocator: 'sec_uid', cookiePersisted: false, runtimeAI: false, paidAPI: false } };
  const run = database.beginRun('scheduled', target.id, 1);
  database.saveCollection(target, run, normalizeCollection(target, raw, { capturedAt: raw.capturedAt }));
  database.finishRun(run, { status: 'success', successCount: 1, processedCount: 1 });
  t.mock.timers.setTime(NOW + 1000);
  const options = { scheduleIntervalHours: 8, worksOnlyEnabled: true,
    providerOptions: { accountBrowserFallback: true, execFileImpl: () => { throw new Error('NO_EXTERNAL_PROCESS'); } } };
  const make = () => new MonitorScheduler(database, options);
  const scheduler = make();
  t.mock.method(PublicWebProvider.prototype, 'collectAccount', async () => { throw new Error('PROFILE_MUST_NOT_RUN'); });
  const protectedState = () => JSON.stringify(Object.fromEntries(['targets', 'snapshots', 'audits', 'account_events'].map(name => [name, database.db.prepare(`SELECT * FROM ${name} ORDER BY id`).all()])));
  const respond = () => {
    t.mock.timers.setTime(Date.now() + 100);
    return { items: [{ key: String(target.id), secUid: SEC, status: 'ok', worksCoverage: 'complete', errorCode: null,
      posts: [{ aweme_id: '7200000000000000001', author: { sec_uid: SEC, uid: UID }, statistics: { digg_count: 8 } }],
      hasMore: false, maxCursor: 0, pagination: { version: 1, maxPages: 3, requestCount: 1, collectedCount: 1, stopReason: 'end-of-list', errorCode: null,
        pages: [{ requestCursor: 0, response: { max_cursor: 0, has_more: false }, rawCount: 1, acceptedCount: 1,
          duplicateCount: 0, filteredCount: 0, truncated: false, observedAt: new Date().toISOString() }] } }],
      provenance: { mode: 'authorised-browser' } };
  };
  const plan = instance => planWorksOnly(database, instance.scheduledTargetAttemptStates(instance.scheduledDateKey(), instance.collectionSlot()), { now: new Date(), slot: instance.collectionSlot() });
  return { database, target, options, make, scheduler, protectedState, respond, plan };
}

test('works scheduler persists real provider contract without another profile, and restart keeps completion', async t => {
  const f = fixture(t); const before = f.protectedState(); let requests = 0;
  t.mock.method(PublicWebProvider.prototype, 'runBrowserWorks', async () => { requests++; return f.respond(); });
  assert.equal(f.plan(f.scheduler).due.length, 1);
  await f.scheduler.tick();
  assert.equal(requests, 1);
  assert.equal(f.protectedState(), before);
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM works_observations').get().n, 1);
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM posts').get().n, 1);
  const run = f.database.db.prepare("SELECT * FROM runs WHERE trigger_type='works-only'").get();
  assert.equal(run.status, 'partial'); assert.equal(run.processed_count, 1);
  const review = buildPostIngestionReview({ database: f.database, runId: run.id });
  assert.equal(review.snapshotCount, 0); assert.equal(review.worksObservationCount, 1);
  assert.equal(review.account.profileUsable, 0); assert.equal(review.account.worksComplete, 1);
  assert.equal(review.worksOnly.profileSampled, false);
  const status = f.scheduler.getStatus();
  assert.equal(status.scheduledProfileCompletedTargetCount, 1);
  assert.equal(status.scheduledWorksLimitedTargetCount, 0);
  assert.equal(status.scheduledWorksCompleteTargetCount, 1);
  assert.equal(status.scheduledWorksAwaitingNextSlotTargetCount, 0);
  await f.make().tick(); assert.equal(requests, 1);
});

test('concurrent ticks share singleton and a pause during response cannot write posts', async t => {
  const f = fixture(t); let release;
  t.mock.method(PublicWebProvider.prototype, 'runBrowserWorks', async () => new Promise(resolve => { release = resolve; }));
  const first = f.scheduler.tick();
  while (!release) await Promise.resolve();
  await f.scheduler.tick();
  assert.equal(f.database.db.prepare("SELECT count(*) n FROM runs WHERE trigger_type='works-only'").get().n, 1);
  f.database.db.prepare('UPDATE targets SET enabled=0 WHERE id=?').run(f.target.id);
  release(f.respond()); await first;
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM works_observations').get().n, 0);
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM posts').get().n, 0);
  assert.equal(f.scheduler.running, false);
});

test('unavailable works get bounded retry after restart, never a rejected homepage audit', async t => {
  const f = fixture(t); const before = f.protectedState(); let requests = 0;
  t.mock.method(PublicWebProvider.prototype, 'runBrowserWorks', async () => { requests++; return { items: [{ key: String(f.target.id), secUid: SEC, status: 'unavailable', posts: [], errorCode: 'network_error' }] }; });
  await f.scheduler.tick(); await f.make().tick(); assert.equal(requests, 1);
  t.mock.timers.setTime(Date.now() + 15 * 60_000);
  await f.make().tick(); assert.equal(requests, 2);
  t.mock.timers.setTime(Date.now() + 15 * 60_000);
  await f.make().tick(); assert.equal(requests, 2);
  assert.equal(f.protectedState(), before);
  const rows = f.database.db.prepare('SELECT status,observed_at FROM works_observations').all();
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.status === 'unavailable' && row.observed_at === null));
});

test('denial stops that account for the slot without deleting history', async t => {
  const f = fixture(t); let requests = 0;
  t.mock.method(PublicWebProvider.prototype, 'runBrowserWorks', async () => { requests++; return { items: [{ key: String(f.target.id), secUid: SEC, status: 'unavailable', posts: [], errorCode: 'blocked' }] }; });
  await f.scheduler.tick(); t.mock.timers.setTime(Date.now() + 60 * 60_000); await f.make().tick();
  assert.equal(requests, 1); assert.equal(f.plan(f.make()).exhausted, 1);
});

test('disabled authorization and active transport cooldown launch no process/run', async t => {
  const f = fixture(t);
  t.mock.method(PublicWebProvider.prototype, 'runBrowserWorks', async () => { throw new Error('MUST_NOT_REQUEST'); });
  const off = new MonitorScheduler(f.database, { ...f.options, providerOptions: { ...f.options.providerOptions, accountBrowserFallback: false } });
  await off.tick();
  const waiting = f.make();
  waiting.worksOnlyProvider = new PublicWebProvider(f.database.getSettings(), { ...f.options.providerOptions, database: f.database });
  waiting.worksOnlyProviderSettings = JSON.stringify(f.database.getSettings());
  waiting.worksOnlyProvider.worksRequestPolicy.record('authorised-browser', { targetKey: SEC, errorCode: 'rate_limited' });
  await waiting.tick();
  assert.equal(f.database.db.prepare("SELECT count(*) n FROM runs WHERE trigger_type='works-only'").get().n, 0);
});

test('busy local browser lane reserves no run and does not consume a works retry', async t => {
  const f = fixture(t);
  t.mock.method(ownedCollectorExecutor, 'state', () => ({ busy: true, locked: false, reason: null }));
  t.mock.method(PublicWebProvider.prototype, 'runBrowserWorks', async () => { throw new Error('MUST_NOT_REQUEST'); });
  await f.scheduler.tick();
  assert.equal(f.database.db.prepare("SELECT count(*) n FROM runs WHERE trigger_type='works-only'").get().n, 0);
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM works_observations').get().n, 0);
  assert.equal(f.plan(f.scheduler).due.length, 1);
});

test('busy lane race is an append-only skipped run, not a failed source request', async t => {
  const f = fixture(t), before = f.protectedState();
  t.mock.method(PublicWebProvider.prototype, 'runBrowserWorks', async () => {
    throw Object.assign(new Error('PRIVATE_SESSION'), { code: 'BROWSER_LANE_BUSY' });
  });
  await f.scheduler.tick();
  const run = f.database.db.prepare("SELECT * FROM runs WHERE trigger_type='works-only'").get();
  assert.equal(run.status, 'success');
  assert.equal(run.skipped_count, 1);
  assert.equal(run.error_count, 0);
  assert.deepEqual(JSON.parse(run.details_json)[0], {
    targetId: f.target.id, attempted: false, mode: 'works-only', errorCode: null,
    requestPolicy: null, deferredReason: 'browser-lane-busy',
  });
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM works_observations').get().n, 0);
  assert.equal(f.protectedState(), before);
  const review = buildPostIngestionReview({ database: f.database, runId: run.id });
  assert.equal(review.worksOnly.attempted, 0);
  assert.equal(review.worksOnly.persisted, 0);
  assert.equal(f.plan(f.make()).exhausted, 0);
});

test('backup count matching cannot silently drop the optional works ledger', () => {
  const names = ['targets','board_catalog','target_boards','posts','post_metrics','snapshots','runs','audits','source_probes','author_resolution_queue','author_resolution_jobs'];
  const base = Object.fromEntries(names.map(name => [name, 0]));
  assert.equal(validationCountsMatch(base, base), true);
  assert.equal(validationCountsMatch({ ...base, works_observations: 2 }, base), false);
  assert.equal(validationCountsMatch({ ...base, works_observations: 2 }, { ...base, works_observations: 2 }), true);
  assert.equal(validationCountsMatch({ ...base, works_observations: 2 }, { ...base, works_observations: 1 }), false);
});

test('pre-cancelled schedule creates no works reservation or external call', async t => {
  const f = fixture(t); const controller = new AbortController(); controller.abort();
  t.mock.method(PublicWebProvider.prototype, 'runBrowserWorks', async () => { throw new Error('MUST_NOT_REQUEST'); });
  const scheduler = new MonitorScheduler(f.database, { ...f.options, providerOptions: { ...f.options.providerOptions, signal: controller.signal } });
  await scheduler.tick();
  assert.equal(f.database.db.prepare("SELECT count(*) n FROM runs WHERE trigger_type='works-only'").get().n, 0);
});

test('explicit pre-request rejection is not claimed as a network attempt', async t => {
  const f = fixture(t);
  t.mock.method(PublicWebProvider.prototype, 'collectWorksOnly', async () => { throw Object.assign(new Error('fixture'), { code: 'WORKS_ONLY_ANCHOR_INVALID', attempted: false }); });
  await f.scheduler.tick();
  const run = f.database.db.prepare("SELECT * FROM runs WHERE trigger_type='works-only'").get();
  assert.equal(JSON.parse(run.details_json)[0].attempted, false);
  const review = buildPostIngestionReview({ database: f.database, runId: run.id });
  assert.equal(review.worksOnly.attempted, 0);
  assert.equal(review.worksOnly.persisted, 0);
  assert.equal(f.plan(f.make()).exhausted, 0);
});
