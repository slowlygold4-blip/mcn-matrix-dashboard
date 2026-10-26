import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MonitorDatabase } from '../lib/database.mjs';
import { MonitorScheduler } from '../lib/scheduler.mjs';

const NOW = Date.parse('2026-09-26T07:00:00Z');
function policy({ attempted = false, deferred = true, errorCode = 'rate_limited', until = '2026-09-26T09:00:00.000Z', ...extra } = {}) {
  return { version: 1, endpoint: 'douyin.author_posts', scope: 'endpoint-transport', anonymous: {
    transport: 'anonymous-http', attempted, deferred, errorCode, nextEligibleAt: until,
    reason: deferred ? 'transport-cooldown' : 'upstream-error', retryAfterStatus: 'valid', ...extra,
  } };
}
function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const dir = mkdtempSync(join(tmpdir(), 'scheduler-works-policy-'));
  const db = new MonitorDatabase(join(dir, 'fixture.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const target = db.createTarget({ type: 'account', provider: 'public-web', label: '独立测试作者', locator: 'MS4wLjABfixture' });
  const scheduler = new MonitorScheduler(db, { scheduleTimeZone: 'Asia/Shanghai', scheduledRetryDelaysMs: [0, 0] });
  function save({ code = 'deferred', requestPolicy, followers = 10, message = '作品暂未取得' } = {}) {
    const run = db.beginRun('scheduled', null, 1);
    db.saveCollection(target, run, { capturedAt: new Date().toISOString(), snapshot: { followers, totalLikes: 20, totalPosts: 3 },
      posts: [], qualityStatus: 'warning', warnings: [message], accountStatus: 'available', worksCoverage: 'unavailable', worksError: message,
      raw: { worksErrorCode: code, ...(requestPolicy ? { worksRequestPolicy: requestPolicy } : {}) } });
    db.finishRun(run, { status: 'success', successCount: 1, processedCount: 1, warningCount: 1 });
    return run;
  }
  return { db, target, scheduler, save };
}

test('structured blocked code defers saved profiles without depending on HTTP/Chinese wording', (t) => {
  const f = fixture(t); f.save({ code: 'blocked', message: 'Post transport denied' });
  const plan = f.scheduler.scheduledPlanSummary('2026-09-26');
  assert.equal(plan.profileCompletedCount, 1); assert.equal(plan.worksDeferredCount, 1);
  assert.equal(plan.completedCount, 0);
  assert.deepEqual(f.scheduler.scheduledDueTargetIds('2026-09-26', new Date(NOW + 60_000)), []);
});

test('upstream Retry-After defers before deadline, and permits bounded retry after deadline', (t) => {
  const f = fixture(t); f.save({ code: 'rate_limited', requestPolicy: policy({ attempted: true, deferred: false }) });
  assert.deepEqual(f.scheduler.scheduledDueTargetIds('2026-09-26', new Date('2026-09-26T08:59:59Z')), []);
  assert.deepEqual(f.scheduler.scheduledDueTargetIds('2026-09-26', new Date('2026-09-26T09:00:00Z')), [f.target.id]);
});

test('deferred work requests do not consume failure attempts or become complete', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 4; i++) { t.mock.timers.setTime(NOW + i * 1000); f.save({ requestPolicy: policy() }); }
  const plan = f.scheduler.scheduledPlanSummary('2026-09-26');
  assert.equal(plan.attempts.get(f.target.id).failedAttempts, 0);
  assert.equal(plan.worksDeferredCount, 1); assert.equal(plan.worksCompleteCount, 0);
  assert.equal(plan.exhaustedCount, 0);
  assert.deepEqual(f.scheduler.scheduledDueTargetIds('2026-09-26', new Date('2026-09-26T09:00:00Z')), [f.target.id]);
});

test('profile gaps remain retryable even when works were deferred', (t) => {
  const f = fixture(t); f.save({ requestPolicy: policy(), followers: null });
  const plan = f.scheduler.scheduledPlanSummary('2026-09-26');
  assert.equal(plan.profileCompletedCount, 0); assert.equal(plan.worksDeferredCount, 0);
  assert.equal(plan.attempts.get(f.target.id).failedAttempts, 1);
  assert.deepEqual(f.scheduler.scheduledDueTargetIds('2026-09-26', new Date(NOW + 1000)), [f.target.id]);
});

test('invalid policy cannot prevent retries and structured network code wins over legacy text', (t) => {
  const f = fixture(t); f.save({ code: 'network_error', requestPolicy: { ...policy(), endpoint: 'other' }, message: '旧诊断中包含 HTTP 403' });
  const plan = f.scheduler.scheduledPlanSummary('2026-09-26');
  assert.equal(plan.worksDeferredCount, 0); assert.equal(plan.attempts.get(f.target.id).failedAttempts, 1);
  assert.deepEqual(f.scheduler.scheduledDueTargetIds('2026-09-26', new Date(NOW + 1000)), [f.target.id]);
});

test('a real browser attempt still counts even if the anonymous lane was deferred', (t) => {
  const f = fixture(t); const requestPolicy = policy();
  requestPolicy.browser = { transport: 'authorised-browser', attempted: true, deferred: false, errorCode: 'network_error', nextEligibleAt: null };
  f.save({ requestPolicy });
  assert.equal(f.scheduler.scheduledPlanSummary('2026-09-26').attempts.get(f.target.id).failedAttempts, 1);
  assert.equal(f.scheduler.scheduledPlanSummary('2026-09-26').worksDeferredCount, 0);
  assert.deepEqual(f.scheduler.scheduledDueTargetIds('2026-09-26', new Date(NOW + 1000)), [f.target.id]);
});

test('explicit expired blocked deadline allows bounded retry instead of a legacy all-day hold', (t) => {
  const f = fixture(t); f.save({ code: 'blocked', requestPolicy: policy({ errorCode: 'blocked', attempted: true, deferred: false }) });
  assert.deepEqual(f.scheduler.scheduledDueTargetIds('2026-09-26', new Date('2026-09-26T08:59:59Z')), []);
  assert.deepEqual(f.scheduler.scheduledDueTargetIds('2026-09-26', new Date('2026-09-26T09:00:00Z')), [f.target.id]);
  for (let i = 1; i <= 2; i++) { t.mock.timers.setTime(NOW + i * 1000); f.save({ code: 'blocked', requestPolicy: policy({ errorCode: 'blocked', attempted: true, deferred: false }) }); }
  assert.deepEqual(f.scheduler.scheduledDueTargetIds('2026-09-26', new Date('2026-09-26T09:00:00Z')), [], 'real failures still exhaust the ordinary allowance');
});

test('two waiting transports defer only until the first lane becomes eligible', (t) => {
  const f = fixture(t); const requestPolicy = policy({ until: '2026-09-26T10:00:00.000Z' });
  requestPolicy.browser = { ...requestPolicy.anonymous, transport: 'authorised-browser', nextEligibleAt: '2026-09-26T08:00:00.000Z' };
  f.save({ requestPolicy });
  assert.deepEqual(f.scheduler.scheduledDueTargetIds('2026-09-26', new Date('2026-09-26T07:59:59Z')), []);
  assert.deepEqual(f.scheduler.scheduledDueTargetIds('2026-09-26', new Date('2026-09-26T08:00:00Z')), [f.target.id]);
});

test('long upstream hold remains visible without forging a retry date', (t) => {
  const f = fixture(t); f.save({ requestPolicy: policy({ until: null, retryAfterStatus: 'too-long' }) });
  assert.equal(f.scheduler.scheduledPlanSummary('2026-09-26').worksDeferredCount, 1);
  assert.deepEqual(f.scheduler.scheduledDueTargetIds('2026-09-26', new Date(NOW + 2 * 3600_000)), []);
});

test('a later actual profile failure cannot inherit an earlier works cooldown', (t) => {
  const f = fixture(t); f.save({ requestPolicy: policy() });
  t.mock.timers.setTime(NOW + 60_000);
  const run = f.db.beginRun('scheduled', null, 1); f.db.recordFailure(f.target, run, new Error('profile unavailable'));
  f.db.finishRun(run, { status: 'error', errorCount: 1, processedCount: 1 });
  assert.equal(f.scheduler.scheduledPlanSummary('2026-09-26').worksDeferredCount, 0);
  assert.deepEqual(f.scheduler.scheduledDueTargetIds('2026-09-26', new Date(NOW + 61_000)), [f.target.id]);
});

test('topic counters including real zero are complete without profile or works coverage', (t) => {
  const f = fixture(t);
  const target = f.db.createTarget({ type: 'hashtag', provider: 'public-web', label: '#离线话题', locator: '#离线话题' });
  const run = f.db.beginRun('scheduled', null, 1);
  f.db.saveCollection(target, run, { capturedAt: new Date().toISOString(), snapshot: { hashtagParticipants: 0, hashtagViews: 0 }, posts: [], qualityStatus: 'validated', warnings: [], accountStatus: 'unknown', worksCoverage: 'unknown', raw: { source: 'topic-test' } });
  f.db.finishRun(run, { status: 'success', successCount: 1, processedCount: 1 });
  const attempt = f.scheduler.scheduledTargetAttemptStates('2026-09-26').get(target.id);
  assert.equal(attempt.latestReviewState, 'complete');
  assert.equal(attempt.failedAttempts, 0);
  assert.ok(!f.scheduler.scheduledDueTargetIds('2026-09-26', new Date(NOW + 1000)).includes(target.id));
});

test('topic with only one counter remains bounded-retry instead of fabricated completion', (t) => {
  const f = fixture(t);
  const target = f.db.createTarget({ type: 'hashtag', provider: 'public-web', label: '#缺项话题', locator: '#缺项话题' });
  const run = f.db.beginRun('scheduled', null, 1);
  f.db.saveCollection(target, run, { capturedAt: new Date().toISOString(), snapshot: { hashtagParticipants: 10, hashtagViews: null }, posts: [], qualityStatus: 'validated', warnings: [], raw: { source: 'topic-partial-test' } });
  f.db.finishRun(run, { status: 'success', successCount: 1, processedCount: 1 });
  const attempt = f.scheduler.scheduledTargetAttemptStates('2026-09-26').get(target.id);
  assert.equal(attempt.latestReviewState, 'retry'); assert.equal(attempt.failedAttempts, 1);
  assert.ok(f.scheduler.scheduledDueTargetIds('2026-09-26', new Date(NOW + 1000)).includes(target.id));
});
