import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { collectOne } from '../scripts/douyin_browser_collector.mjs';
import { classifyBrowserWorksFailure } from '../lib/douyin-browser-failure.mjs';
import { WorksRequestPolicy } from '../lib/works-request-policy.mjs';
import { sanitizeBrowserWorksDiagnostics } from '../lib/douyin-browser-diagnostics.mjs';
import { projectWorksOnlyFailure } from '../lib/works-only-failure.mjs';
import { buildUpdateSla } from '../lib/update-sla.mjs';
import { accountCollectionCoverage } from '../lib/collection-coverage.mjs';
import { MonitorDatabase } from '../lib/database.mjs';
import { getProductInsights } from '../lib/product-insights.mjs';
import { projectRecordedWindow, recordedWindowCaption } from '../public/console-model.js';
import { createBrowserResourceObservation, classifyBrowserDocumentTarget } from '../lib/browser-resource-observation.mjs';

const SEC = 'MS4wLjABAAAACollectorObservationPeer12345';
const PROFILE = `https://www.douyin.com/user/${SEC}`;
const SECRET = 'UNTRUSTED_URL_COOKIE_EXCEPTION_SECRET';
class DocumentPage extends EventEmitter {
  constructor(status, { redirect = false, foreign = false } = {}) {
    super(); this.status = status; this.redirect = redirect; this.foreign = foreign;
    this.address = 'about:blank'; this.reads = 0; this.bodyReads = 0;
    this.frame = { url: () => this.address };
  }
  mainFrame() { return this.frame; }
  url() { return this.address; }
  navigation() { return { isNavigationRequest: () => true, method: () => 'GET', frame: () => this.frame, url: () => PROFILE }; }
  async goto() {
    let request = this.navigation(); this.emit('request', request); this.address = PROFILE;
    this.emit('response', { request: () => request, url: () => this.foreign ? `${PROFILE}foreign` : PROFILE,
      status: () => this.status, json: async () => { this.bodyReads++; throw new Error(SECRET); } });
    if (this.redirect) {
      request = this.navigation(); this.emit('request', request);
      this.emit('response', { request: () => request, url: () => PROFILE, status: () => 200 });
    }
    this.emit('framenavigated', this.frame); this.emit('domcontentloaded');
  }
  async evaluate() { this.reads++; return { observation: 'observed', readyState: 'interactive', bodyPresent: true, scriptCount: 1 }; }
}
const observe = (page, options = {}) => collectOne(page, { key: 'offline', secUid: SEC, limit: 30 },
  { timeoutMs: 70, failureGraceMs: 1, ...options });

test('peer: bound document 4xx and 5xx are retained as refusal evidence and stop without reading bodies or DOM', { timeout: 2000 }, async t => {
  // This fixture emits a refusal synchronously, not after a timed network wait.
  // Freeze only its wall clock so unrelated full-suite CPU scheduling cannot
  // exhaust the tiny offline budget before the first event. Real timers and
  // every production timeout remain unchanged; the refusal must end the read.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-30T18:00:00.000Z') });
  for (const status of [400, 404, 408, 500, 502, 503, 599]) {
    const page = new DocumentPage(status), result = await observe(page, { signal: t.signal });
    assert.equal(result.status, 'unavailable'); assert.equal(result.worksCoverage, 'unavailable');
    assert.deepEqual(result.posts, []); assert.equal(result.errorCode, 'network_error');
    assert.equal(result.failureDiagnostics.stopReason, 'http-rejection');
    assert.ok(result.failureDiagnostics.httpStatuses.includes(status), `HTTP ${status} must not become no-bound-request`);
    assert.equal(page.reads, 0); assert.equal(page.bodyReads, 0);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
  }
});

test('peer: document 302 followed by actual 200 and unrelated-profile refusal do not invent an authentication gate', async () => {
  for (const page of [new DocumentPage(302, { redirect: true }), new DocumentPage(500, { foreign: true })]) {
    const result = await observe(page);
    assert.equal(result.errorCode, 'collector_error');
    assert.equal(result.failureDiagnostics.stopReason, 'no-bound-request');
    assert.equal(result.failureDiagnostics.httpStatuses.includes(500), false);
    assert.equal(page.bodyReads, 0); assert.deepEqual(result.posts, []);
  }
});

test('peer: explicit auth/rate refusals retain priority and 500 cannot trigger their long global gate', () => {
  assert.equal(classifyBrowserWorksFailure({ httpStatuses: [500, 429, 403, 401] }).errorCode, 'login_required');
  assert.equal(classifyBrowserWorksFailure({ httpStatuses: [500, 429, 403] }).errorCode, 'blocked');
  assert.equal(classifyBrowserWorksFailure({ httpStatuses: [500, 429] }).errorCode, 'rate_limited');
  assert.equal(classifyBrowserWorksFailure({ httpStatuses: [500] }).errorCode, 'network_error');
  let now = Date.parse('2026-09-30T18:00:00.000Z');
  const policy = new WorksRequestPolicy({ now: () => now });
  policy.record('authorised-browser', { targetKey: 'A', errorCode: 'network_error' });
  assert.equal(policy.decision('authorised-browser').deferred, false);
  policy.record('authorised-browser', { targetKey: 'A', errorCode: 'network_error' });
  assert.equal(policy.decision('authorised-browser').deferred, false);
  policy.record('authorised-browser', { targetKey: 'B', errorCode: 'network_error' });
  assert.equal(policy.decision('authorised-browser').deferred, false);
  policy.record('authorised-browser', { targetKey: 'C', errorCode: 'network_error' });
  assert.equal(Date.parse(policy.decision('authorised-browser').nextEligibleAt) - now, 60_000);
  assert.equal(policy.decision('anonymous-http').deferred, false, 'transport lanes are not a platform-wide verdict');
  now += 60_000; assert.equal(policy.decision('authorised-browser').deferred, false);
});

test('peer: failure persistence is idempotent bounded metadata, never successful works or unsafe source strings', () => {
  const unsafe = { version: 1, stopReason: 'no-bound-request', requests: { candidate: 0, matched: 0 },
    firstScreen: { observation: 'observed', readyState: 'loading', bodyPresent: false, worksAnchorCount: 0,
      raw: SECRET, render: { version: 1, parseState: 'deferred', source: SECRET } },
    httpStatuses: [500, 500, '403', -1, 700], cookies: SECRET, headers: SECRET, url: SECRET };
  const safe = sanitizeBrowserWorksDiagnostics(unsafe);
  const persisted = projectWorksOnlyFailure({ failureDiagnostics: unsafe, failureStage: 'browser-page', raw: SECRET });
  assert.deepEqual(persisted.failureDiagnostics, safe);
  assert.deepEqual(projectWorksOnlyFailure(persisted), persisted);
  assert.deepEqual(safe.httpStatuses, [500]); assert.equal(safe.firstScreen.readyState, 'loading');
  assert.doesNotMatch(JSON.stringify(persisted), new RegExp(SECRET));
  assert.equal(Object.hasOwn(persisted, 'posts'), false); assert.equal(Object.hasOwn(persisted, 'coverage'), false);
});

test('peer: account core, complete works and two-counter topics have separate full enabled denominators', () => {
  const at = '2026-09-30T18:05:00.000Z', audited = '2026-09-30T18:05:01.000Z';
  const targets = [1, 2, 3, 4, 5].map(id => ({ id, type: 'account', provider: id === 3 ? 'manual' : 'public-web', enabled: id !== 5 }));
  targets.push({ id: 6, type: 'hashtag', provider: 'public-web', enabled: true }, { id: 7, type: 'hashtag', provider: 'public-web', enabled: true });
  const sample = (target_id, extra = {}) => ({ id: target_id, target_id, captured_at: at,
    quality_status: 'warning', account_status: 'available', followers: 0, total_likes: 0, total_posts: 0,
    works_coverage: 'unavailable', source_checksum: `offline-hash-${target_id}`,
    collectionEvidence: { provider: 'public-web', auditId: target_id, runId: 2109, targetId: target_id,
      status: 'warning', sourceChecksum: `offline-hash-${target_id}`, runStartedAt: '2026-09-30T18:00:00.000Z',
      runFinishedAt: null, auditAt: audited }, ...extra });
  const snapshots = [sample(1), sample(2, { total_likes: null, works_coverage: 'limited' }),
    sample(5, { works_coverage: 'complete' }), sample(6, { hashtag_participants: 0, hashtag_views: 0 }),
    sample(7, { hashtag_participants: 100, hashtag_views: null }),
    sample(4, { captured_at: '2026-09-30T19:00:00.000Z', works_coverage: 'complete' })];
  const result = buildUpdateSla({ targets, snapshots, now: new Date('2026-09-30T18:10:00.000Z') });
  assert.equal(result.coreAccounts.daily.total, 4); assert.equal(result.coreAccounts.daily.complete, 1);
  assert.equal(result.works.daily.total, 4); assert.equal(result.works.daily.complete, 0);
  assert.deepEqual(result.works.daily.counts, { complete: 0, limited: 1, unavailable: 1, unknown: 0, missing: 2 });
  assert.equal(result.topics.daily.total, 2); assert.equal(result.topics.daily.complete, 1);
  assert.equal(result.disabledTargetCount, 1); assert.equal(result.enabledManualAccountCount, 1);
  assert.equal(result.targetStatus, 'below-target'); assert.equal(result.status, 'incomplete');
  const carried = accountCollectionCoverage({ enabled: true, trend: [], status: { key: 'updated', lastSuccessAt: at },
    worksObservation: { coverage: 'complete', lastAttemptAt: at, observedAt: '2026-09-30T10:00:00.000Z', carriedForward: true } }, '2026-10-01');
  assert.equal(carried.profileObserved, false); assert.equal(carried.worksState, 'unknown');
});

test('peer: daily, weekly and monthly 9/12 missing baselines remain unknown while actual since window is explicit', t => {
  const mem = new MonitorDatabase(':memory:'); t.after(() => mem.close());
  const target = mem.createTarget({ type: 'account', label: 'offline-calendar-peer', locator: SEC, provider: 'public-web', metadata: { platform: 'douyin' } });
  const add = (day, value) => mem.db.prepare("INSERT INTO snapshots(target_id,captured_at,followers,total_likes,total_posts,quality_status,account_status,works_coverage,source_checksum) VALUES(?,?,?,?,?,'validated','available','unavailable',?)")
    .run(target.id, `${day}T02:00:00.000Z`, value, value * 10, value, `offline-${day}`);
  add('2026-09-14', 100); add('2026-09-30', 110);
  for (const period of ['day', 'week', 'month']) {
    const raw = getProductInsights(mem, { period, reference: new Date('2026-09-12T04:00:00.000Z'), timeZone: 'Asia/Shanghai' });
    for (const metric of Object.values(raw.summary.metrics)) assert.equal(metric.delta, null);
    assert.equal(raw.recordedWindow, null); assert.equal(raw.summary.collectionCoverage.profileObservedCount, 0);
  }
  const raw = getProductInsights(mem, { period: 'custom', startDate: '2026-09-12', endDate: '2026-10-01',
    reference: new Date('2026-09-30T18:10:00.000Z'), timeZone: 'Asia/Shanghai' });
  assert.equal(raw.summary.metrics.followers.delta, null);
  const shown = projectRecordedWindow(raw, { period: 'since' });
  assert.equal(shown.summary.metrics.followers.delta, 10);
  assert.match(recordedWindowCaption(shown), /2026-09-14 采样 → 2026-09-30 采样/);
  assert.match(recordedWindowCaption(shown), /所选 2026-09-12 至 2026-10-01 完整区间数据尚不齐全/);
  assert.equal(shown.summary.trend.at(-1).followersDelta, null);
});

function resourceRequest(kind = 'fetch', { url = PROFILE, previous = null, navigation = false } = {}) {
  const forbidden = () => { throw new Error(SECRET); };
  return { resourceType: () => kind, url: () => url, redirectedFrom: () => previous,
    isNavigationRequest: () => navigation, failure: forbidden, headers: forbidden,
    allHeaders: forbidden, postData: forbidden, frame: forbidden };
}
const resourceResponse = (request, status) => ({ request: () => request, status: () => status,
  headers: () => { throw new Error(SECRET); }, body: () => { throw new Error(SECRET); },
  json: () => { throw new Error(SECRET); }, text: () => { throw new Error(SECRET); } });

test('peer: passive resource candidate does not read secret methods and separates pre-stop, stop and cleanup failures', () => {
  const observer = createBrowserResourceObservation({ secUid: SEC });
  const [before, after, cleanup] = [1, 2, 3].map(() => resourceRequest('script', { url: `https://external.invalid/${SECRET}` }));
  observer.request(before); observer.failed(before, 'dns');
  observer.markStop(); observer.request(after); observer.failed(after, { message: SECRET });
  observer.beginCleanup(); observer.request(cleanup); observer.failed(cleanup, 'aborted');
  const result = observer.snapshot();
  assert.equal(result.resources.script.failed, 3);
  assert.equal(result.failuresByPhase.beforeStop.kinds.dns, 1);
  assert.equal(result.failuresByPhase.afterStop.kinds.unknown, 1);
  assert.equal(result.failuresByPhase.cleanup.kinds.aborted, 1);
  assert.equal(result.failuresByPhase.beforeStop.kinds.aborted, 0, 'cleanup must not be reported as an upstream abort');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${SECRET}|${SEC}|external.invalid`));
  assert.deepEqual(observer.close().resources.script.pending, 0);
});

test('peer: resource candidate caps requests, status buckets and count growth; close releases unresolved references', () => {
  const observer = createBrowserResourceObservation({ secUid: SEC, maxRequests: 2, maxStatusCodes: 2, countLimit: 3 });
  for (const status of [500, 502, 503, 504, 505, 506]) {
    const request = resourceRequest(); assert.equal(observer.request(request), true);
    assert.equal(observer.request(request), false, 'duplicate requests do not inflate counts');
    observer.response(resourceResponse(request, status)); observer.finished(request);
  }
  const pending = [resourceRequest(), resourceRequest()]; pending.forEach(request => observer.request(request));
  for (let i = 0; i < 20; i++) observer.request(resourceRequest());
  const result = observer.snapshot();
  assert.equal(result.trackedRequests, 2); assert.equal(result.resources.fetch.requested, 3);
  assert.equal(result.resources.fetch.finished, 3); assert.equal(result.resources.fetch.statusCounts.length, 2);
  assert.equal(result.resources.fetch.statusOverflow, 3); assert.equal(result.discarded.capacity, 3);
  result.resources.fetch.statusCounts[0].count = 999;
  assert.equal(observer.snapshot().resources.fetch.statusCounts[0].count, 1, 'snapshot is detached');
  const closed = observer.close(); assert.equal(closed.trackedRequests, 0);
  assert.equal(closed.resources.fetch.unresolvedAtClose, 2); assert.equal(closed.resources.fetch.pending, 0);
  assert.equal(observer.request(resourceRequest()), false); assert.equal(observer.failed(pending[0], 'dns'), false);
  assert.deepEqual(observer.snapshot(), closed);
});

test('peer: resource document classifier emits only fixed relations and never mistakes lookalike origins for the target', () => {
  assert.equal(classifyBrowserDocumentTarget(`${PROFILE}?signed=${SECRET}`, SEC), 'same-profile');
  assert.equal(classifyBrowserDocumentTarget(`https://www.douyin.com.attacker.invalid/user/${SEC}`, SEC), 'other-origin');
  assert.equal(classifyBrowserDocumentTarget(`https://name:${SECRET}@www.douyin.com/user/${SEC}`, SEC), 'invalid');
  assert.equal(classifyBrowserDocumentTarget('https://www.douyin.com/verify/', SEC), 'verification');
  assert.equal(classifyBrowserDocumentTarget('https://passport.douyin.com/login', SEC), 'login');
  const observer = createBrowserResourceObservation({ secUid: SEC });
  const first = resourceRequest('document', { navigation: true });
  const redirected = resourceRequest('document', { navigation: true, previous: first, url: `${PROFILE}?signed=${SECRET}` });
  observer.request(first, { isMainFrame: true }); observer.response(resourceResponse(first, 302));
  observer.request(redirected, { isMainFrame: true }); observer.response(resourceResponse(redirected, 200));
  assert.equal(observer.snapshot().documents.lastRelation, 'linked-http-redirect');
  assert.equal(observer.snapshot().documents.lastTarget, 'same-profile');
  assert.equal(observer.snapshot().documents.lastStatus, 200);
  observer.sameDocument(`${PROFILE}#${SECRET}`);
  assert.equal(observer.snapshot().documents.lastRelation, 'same-document');
  assert.doesNotMatch(JSON.stringify(observer.close()), new RegExp(`${SECRET}|${SEC}`));
});

test('peer: late old document responses are counted but cannot replace latest document status', () => {
  const observer = createBrowserResourceObservation({ secUid: SEC });
  const old = resourceRequest('document', { navigation: true });
  const current = resourceRequest('document', { navigation: true });
  observer.request(old, { isMainFrame: true }); observer.request(current, { isMainFrame: true });
  observer.response(resourceResponse(current, 200)); observer.response(resourceResponse(old, 500));
  const result = observer.snapshot();
  assert.equal(result.documents.lastRelation, 'new-document'); assert.equal(result.documents.lastStatus, 200);
  assert.deepEqual(result.resources.document.statusCounts, [{ status: 200, count: 1 }, { status: 500, count: 1 }]);
  const persisted = projectWorksOnlyFailure({ failureDiagnostics: { version: 1, resourceObservation: result } });
  assert.equal(Object.hasOwn(persisted.failureDiagnostics, 'resourceObservation'), true,
    'released resource telemetry crosses persistence only through its fixed allowlist');
  assert.equal(persisted.failureDiagnostics.resourceObservation.documents.lastStatus, 200);
  assert.deepEqual(projectWorksOnlyFailure(persisted), persisted);
  assert.doesNotMatch(JSON.stringify(persisted.failureDiagnostics), new RegExp(`${SECRET}|${SEC}|https?:`));
  observer.close();
});
