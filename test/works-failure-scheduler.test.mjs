import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { MonitorScheduler } from '../lib/scheduler.mjs';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { readWorksOnlyAnchor } from '../lib/works-only-observation.mjs';
import { worksOnlyRetryGate, planWorksOnly, runNextWorksOnly } from '../lib/works-only-scheduler.mjs';
import { sanitizeBrowserWorksDiagnostics } from '../lib/douyin-browser-diagnostics.mjs';

const BASE = Date.parse('2026-09-29T02:01:00.000Z');
function profileRaw(target) {
  return { capturedAt: new Date().toISOString(), accountStatus: 'validated', accountError: null,
    profile: { user: { sec_uid: target.locator, uid: String(100000000 + target.id), follower_count: 20, total_favorited: 40, aweme_count: 1 } },
    worksCoverage: 'unavailable', worksErrorCode: 'deferred', works: { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } },
    provenance: { mode: 'guest-ttwid-unsigned-profile', profileMode: 'guest-ttwid-unsigned-profile',
      profileEndpoint: 'https://www.douyin.com/aweme/v1/web/user/profile/other/', accountLocator: 'sec_uid', cookiePersisted: false, runtimeAI: false, paidAPI: false } };
}
function fixture(t, failureDetail = () => ({})) {
  t.mock.timers.enable({ apis: ['Date'], now: BASE });
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const targets = Array.from({ length: 6 }, (_, i) => database.createTarget({ type: 'account', provider: 'public-web',
    locator: `MS4wLjABAAAAGateSchedulerOfflineAccount${1000 + i}`, label: `offline ${i}` }));
  for (const target of targets) {
    const raw = profileRaw(target), runId = database.beginRun('scheduled', target.id, 1);
    database.saveCollection(target, runId, normalizeCollection(target, raw, { capturedAt: raw.capturedAt }));
    database.finishRun(runId, { status: 'success', processedCount: 1, successCount: 1 });
  }
  for (let i = 0; i < 5; i++) {
    t.mock.timers.setTime(BASE + (i + 1) * 1000);
    const runId = database.beginRun('works-only', targets[i].id, 1);
    t.mock.timers.setTime(Date.now() + 100);
    database.finishRun(runId, { status: 'error', processedCount: 1, errorCount: 1,
      details: [{ targetId: targets[i].id, mode: 'works-only', attempted: true, errorCode: 'collector_error',
        ...failureDetail(targets[i]) }] });
  }
  t.mock.timers.setTime(BASE + 6000);
  const options = { scheduleIntervalHours: 8, worksOnlyEnabled: true,
    providerOptions: { accountBrowserFallback: true, cooldownMs: 0,
      execFileImpl: () => { throw new Error('EXTERNAL_PROCESS_PROHIBITED'); },
      fetchImpl: () => { throw new Error('EXTERNAL_NETWORK_PROHIBITED'); } } };
  const make = () => new MonitorScheduler(database, options), scheduler = make();
  let worksCalls = 0;
  t.mock.method(PublicWebProvider.prototype, 'collectWorksOnly', async () => {
    worksCalls++;
    return { attempted: false, deferred: true, result: null, requestStartedAt: null, requestFinishedAt: null, requestedLimit: 30,
      requestPolicy: { version: 1, endpoint: 'douyin.author_posts', scope: 'endpoint-transport', browser: {
        transport: 'authorised-browser', attempted: false, deferred: true, errorCode: 'collector_error',
        cooldownErrorCode: 'collector_error', reason: 'transport-cooldown', nextEligibleAt: null, retryAfterStatus: null } } };
  });
  const countWorksRuns = () => database.db.prepare("SELECT COUNT(*) n FROM runs WHERE trigger_type='works-only'").get().n;
  const protectedState = () => JSON.stringify(Object.fromEntries(['targets', 'snapshots', 'audits', 'posts', 'post_metrics', 'works_observations']
    .map(table => [table, database.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])));
  return { database, targets, scheduler, make, countWorksRuns, protectedState, worksCalls: () => worksCalls,
    gate: () => worksOnlyRetryGate(database, { now: new Date(), slot: scheduler.collectionSlot() }),
    plan: () => planWorksOnly(database, scheduler.scheduledTargetAttemptStates(scheduler.scheduledDateKey(), scheduler.collectionSlot()),
      { now: new Date(), slot: scheduler.collectionSlot() }) };
}

function occludedNoBoundDetail() {
  return { failureStage: 'browser-page', failureDiagnostics: sanitizeBrowserWorksDiagnostics({
    version: 1, stopReason: 'no-bound-request', finalPageKind: 'profile',
    navigation: { observed: true, committed: true, failed: false, timedOut: false },
    requests: { candidate: 0, matched: 0 }, responses: { matched: 0 },
    httpStatuses: [], businessStatusCodes: [],
    firstPageActivation: { state: 'blocked', structure: { reason: 'visible-gate', gates: {
      version: 1, candidateCount: 8, visibleCount: 7, excludedNavigationCount: 0,
      excludedDecorationCount: 0, decision: 'unknown',
      detail: { version: 1, reason: 'navigation-absent', worksRegion: 'occluded' },
    } } },
  }) };
}

test('verified occluded no-request failures pause only their accounts for this slot, not the transport lane', async t => {
  const f = fixture(t, occludedNoBoundDetail), before = f.protectedState();
  assert.ok(occludedNoBoundDetail().failureDiagnostics.firstPageActivation.structure.gates);
  assert.equal(f.gate().deferred, false);
  assert.equal(f.gate().failureCount, 0);
  assert.deepEqual(f.plan().due.map(candidate => candidate.target.id), [f.targets.at(-1).id]);
  assert.equal(f.plan().exhausted, 5);
  assert.equal(f.protectedState(), before);
  const preselected = { target: f.targets[0], anchor: readWorksOnlyAnchor(f.database.db, f.targets[0].id, { now: Date.now() }), attempts: 1 };
  assert.equal(await runNextWorksOnly(f.scheduler, preselected), null);
  assert.equal(f.worksCalls(), 0);
  assert.equal(f.countWorksRuns(), 5);

  // A fresh, genuine profile anchor in the next eight-hour slot restores
  // eligibility; no synthetic works observation or post is needed.
  t.mock.timers.setTime(BASE + 8 * 60 * 60_000 + 1000);
  const target = f.targets[0], raw = profileRaw(target);
  const runId = f.database.beginRun('scheduled', target.id, 1);
  f.database.saveCollection(target, runId, normalizeCollection(target, raw, { capturedAt: raw.capturedAt }));
  f.database.finishRun(runId, { status: 'success', processedCount: 1, successCount: 1 });
  assert.equal(f.gate().deferred, false);
  assert.ok(f.plan().due.some(candidate => candidate.target.id === target.id));
  assert.equal(f.database.db.prepare('SELECT COUNT(*) n FROM works_observations').get().n, 0);
});

test('ordinary network and unproven gate diagnostics keep the existing circuit policy', t => {
  const f = fixture(t, () => ({ errorCode: 'network_error', ...occludedNoBoundDetail() }));
  assert.equal(f.gate().deferred, true);
  assert.equal(f.gate().failureCount, 5);
});

test('a no-request error without confirmed occlusion retains its retry allowance', t => {
  const f = fixture(t, () => {
    const detail = occludedNoBoundDetail();
    detail.failureDiagnostics.firstPageActivation.structure.gates.detail.worksRegion = 'confirmed';
    return detail;
  });
  assert.equal(f.gate().deferred, true);
  assert.equal(f.gate().failureCount, 5);
  assert.equal(f.plan().exhausted, 0);
});

test('actual tick and restarted scheduler honor deferred works gate without reserving runs or calling provider', async t => {
  const f = fixture(t), before = f.protectedState(), count = f.countWorksRuns();
  assert.equal(f.gate().deferred, true);
  assert.deepEqual(f.scheduler.scheduledDueTargetIds(f.scheduler.scheduledDateKey(), new Date(), f.scheduler.collectionSlot()), []);
  await f.scheduler.tick(); await f.make().tick();
  assert.equal(f.worksCalls(), 0); assert.equal(f.countWorksRuns(), count);
  assert.equal(f.protectedState(), before); assert.equal(f.scheduler.running, false);
});

test('direct runNextWorksOnly rechecks the durable gate even with a valid preselected candidate', async t => {
  const f = fixture(t), target = f.targets.at(-1), before = f.protectedState();
  const candidate = { target, anchor: readWorksOnlyAnchor(f.database.db, target.id, { now: Date.now() }), attempts: 0 };
  assert.equal(f.gate().deferred, true);
  const result = await runNextWorksOnly(f.scheduler, candidate);
  assert.equal(result, null); assert.equal(f.worksCalls(), 0); assert.equal(f.countWorksRuns(), 5);
  assert.equal(f.protectedState(), before); assert.equal(f.scheduler.running, false);
});

test('the gate admits one normal scheduler probe only at its real deadline', async t => {
  const f = fixture(t), due = Date.parse(f.gate().nextEligibleAt);
  t.mock.timers.setTime(due - 1); await f.scheduler.tick(); assert.equal(f.worksCalls(), 0);
  t.mock.timers.setTime(due); assert.equal(f.gate().deferred, false);
  await f.make().tick(); assert.equal(f.worksCalls(), 1); assert.equal(f.countWorksRuns(), 6);
  assert.equal(f.database.db.prepare('SELECT COUNT(*) n FROM works_observations').get().n, 0,
    'offline provider declined its request, so no observation is manufactured');
});

test('an open works-only circuit does not suppress due homepage or topic collection', async t => {
  const f = fixture(t);
  const account = f.database.createTarget({ type: 'account', provider: 'public-web', label: 'new offline account',
    locator: 'MS4wLjABAAAAGateSchedulerFreshAccount9999' });
  const topic = f.database.createTarget({ type: 'hashtag', provider: 'public-web', label: 'offline topic', locator: '离线门禁话题' });
  const calls = [];
  t.mock.method(PublicWebProvider.prototype, 'collect', async target => {
    calls.push(target.id);
    if (target.type === 'account') return normalizeCollection(target, profileRaw(target), { capturedAt: new Date().toISOString() });
    return { capturedAt: new Date().toISOString(), snapshot: { hashtagParticipants: 3, hashtagViews: 17 },
      posts: [], qualityStatus: 'validated', warnings: [], accountStatus: 'unknown', worksCoverage: 'unknown', raw: { source: 'offline-topic-test' } };
  });
  assert.equal(f.gate().deferred, true);
  await f.scheduler.tick();
  assert.deepEqual([...calls].sort((a, b) => a - b), [account.id, topic.id].sort((a, b) => a - b));
  assert.equal(f.worksCalls(), 0); assert.equal(f.countWorksRuns(), 5);
  assert.equal(f.database.db.prepare('SELECT COUNT(*) n FROM snapshots WHERE target_id IN (?,?)').get(account.id, topic.id).n, 2);
  assert.equal(f.database.db.prepare("SELECT status FROM runs WHERE trigger_type='scheduled' ORDER BY id DESC LIMIT 1").get().status, 'success');
});
