import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { collectOne } from '../scripts/douyin_browser_collector.mjs';
import { browserResourceFailureKind, sanitizeBrowserResourceObservation } from '../lib/douyin-browser-diagnostics.mjs';
import { createBrowserResourceObservation } from '../lib/browser-resource-observation.mjs';
import { projectWorksOnlyFailure } from '../lib/works-only-failure.mjs';

// Independent offline adapter. Tests invoke the production collector and its
// actual sanitizer; no browser, credentials, DB, platform requests or fixtures
// imported from another peer are used.
const SEC = 'MS4wLjABAAAAPhase56ResourceFailureOffline';
const PROFILE = `https://www.douyin.com/user/${SEC}`;
const drain = async () => { for (let n = 0; n < 45; n++) await Promise.resolve(); };
const exact = [
  ['net::ERR_ABORTED', 'aborted'],
  ['net::ERR_NAME_NOT_RESOLVED', 'dns'],
  ['net::ERR_DNS_TIMED_OUT', 'dns'],
  ['net::ERR_TIMED_OUT', 'timeout'],
  ['net::ERR_CONNECTION_TIMED_OUT', 'timeout'],
  ['net::ERR_CONNECTION_RESET', 'connection'],
  ['net::ERR_CONNECTION_REFUSED', 'connection'],
  ['net::ERR_CONNECTION_CLOSED', 'connection'],
  ['net::ERR_CONNECTION_ABORTED', 'connection'],
  ['net::ERR_CONNECTION_FAILED', 'connection'],
  ['net::ERR_INTERNET_DISCONNECTED', 'connection'],
  ['net::ERR_NETWORK_CHANGED', 'connection'],
  ['net::ERR_ADDRESS_UNREACHABLE', 'connection'],
  ['net::ERR_SSL_PROTOCOL_ERROR', 'tls'],
  ['net::ERR_SSL_VERSION_OR_CIPHER_MISMATCH', 'tls'],
  ['net::ERR_CERT_COMMON_NAME_INVALID', 'tls'],
  ['net::ERR_CERT_DATE_INVALID', 'tls'],
  ['net::ERR_CERT_AUTHORITY_INVALID', 'tls'],
  ['net::ERR_CERT_REVOKED', 'tls'],
  ['net::ERR_CERT_INVALID', 'tls'],
  ['net::ERR_BLOCKED_BY_CLIENT', 'blocked-client'],
];

for (const [input, expected] of exact) {
  test(`phase56 peer: exact ${input} projects only ${expected}`, () => {
    assert.equal(browserResourceFailureKind(input), expected);
  });
}

test('phase56 peer: arbitrary, partial or sensitive strings cannot become named transport proof', () => {
  const invalid = [null, undefined, false, 403, {}, [], new String('net::ERR_ABORTED'),
    'net::ERR_ABORTED ', ' net::ERR_ABORTED', '\nnet::ERR_TIMED_OUT',
    'NET::ERR_ABORTED', 'net::ERR_ABORTED\n', 'net::ERR_ABORTED\u0000',
    'net::ERR_ABORTED at https://example.test/?token=[REDACTED]',
    'https://example.test/net::ERR_NAME_NOT_RESOLVED?Cookie=PRIVATE_PHASE56',
    'HTTP 403', 'net::ERR_HTTP_RESPONSE_CODE_FAILURE',
    'net::ERR_NAME_NOT_RESOLVED'.repeat(1000),
    { toString() { throw new Error('PRIVATE_PHASE56'); } },
  ];
  for (const value of invalid) assert.equal(browserResourceFailureKind(value), 'unknown');
});

test('phase56 peer: categories preserve beforeStop, afterStop and cleanup without redefining HTTP status', () => {
  const observer = createBrowserResourceObservation({ secUid: SEC });
  const request = () => ({ resourceType: () => 'fetch', isNavigationRequest: () => false });
  let current = request(); observer.request(current); observer.failed(current, browserResourceFailureKind('net::ERR_NAME_NOT_RESOLVED'));
  observer.markStop();
  current = request(); observer.request(current); observer.failed(current, browserResourceFailureKind('net::ERR_CONNECTION_RESET'));
  observer.beginCleanup();
  current = request(); observer.request(current); observer.failed(current, browserResourceFailureKind('net::ERR_ABORTED'));
  observer.close();
  const result = sanitizeBrowserResourceObservation({ ...observer.snapshot(), captureBoundary: 'page-close-return' });
  assert.equal(result.failuresByPhase.beforeStop.kinds.dns, 1);
  assert.equal(result.failuresByPhase.afterStop.kinds.connection, 1);
  assert.equal(result.failuresByPhase.cleanup.kinds.aborted, 1);
  for (const phase of ['beforeStop', 'afterStop', 'cleanup']) assert.equal(result.failuresByPhase[phase].total, 1);
  assert.equal(result.resources.fetch.failed, 3);
  assert.deepEqual(result.resources.fetch.statusCounts, []);
  assert.equal(result.documents.lastStatus, null);
  assert.equal(result.phase, 'closed');
});

class Page extends EventEmitter {
  constructor(failureMode, kind = 'fetch') {
    super(); this.address = 'about:blank'; this.failureMode = failureMode; this.kind = kind;
    this.frame = { url: () => this.address }; this.moves = 0; this.wheels = 0; this.reads = 0; this.failureCalls = 0;
    this.mouse = { move: async () => { this.moves++; }, wheel: async () => { this.wheels++; } };
  }
  url() { return this.address; }
  mainFrame() { return this.frame; }
  async goto() {
    const documentRequest = { resourceType: () => 'document', url: () => PROFILE,
      frame: () => this.frame, isNavigationRequest: () => true, redirectedFrom: () => null, method: () => 'GET' };
    this.emit('request', documentRequest);
    this.emit('response', { request: () => documentRequest, status: () => 200, url: documentRequest.url });
    this.emit('requestfinished', documentRequest);
    this.address = PROFILE; this.emit('framenavigated', this.frame);
    this.beforeResource?.();
    const resource = { resourceType: () => { if (this.invalidResource) throw new Error('PRIVATE_PHASE56'); return this.kind; }, isNavigationRequest: () => false,
      url: () => 'https://example.test/anonymous-resource', frame: () => this.frame, method: () => 'GET' };
    this.lastResource = resource;
    if (this.failureMode !== 'missing') resource.failure = () => {
      this.failureCalls++;
      if (this.failureMode === 'throw') throw new Error('PRIVATE_PHASE56');
      if (this.failureMode === 'getter') return { get errorText() { throw new Error('PRIVATE_PHASE56'); } };
      return { errorText: this.failureMode };
    };
    this.emit('request', resource);
    if (this.failureMode === 403) {
      this.emit('response', { request: () => resource, status: () => 403, url: resource.url });
      this.emit('requestfinished', resource);
      if (this.failAfterFinished) this.emit('requestfailed', resource);
    } else {
      this.emit('requestfailed', resource);
      this.emit('requestfailed', resource); // duplicate terminal events must not double-count.
    }
  }
  async evaluate() {
    this.reads++;
    return { observation: 'observed', readyState: 'loading', bodyPresent: false };
  }
}

async function execute(t, page) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let done = false;
  const promise = collectOne(page, { key: 'phase56-offline', secUid: SEC, limit: 30 }, { timeoutMs: 2600 });
  void promise.then(() => { done = true; }, () => { done = true; });
  await drain();
  for (let at = 20; !done && at <= 2700; at += 20) { t.mock.timers.tick(20); await drain(); }
  assert.equal(done, true);
  const result = await promise;
  assert.ok(result.failureDiagnostics.elapsedMs <= 2600);
  for (const event of ['request', 'requestfailed', 'requestfinished', 'response', 'framenavigated', 'load', 'domcontentloaded', 'pageerror']) {
    assert.equal(page.listenerCount(event), 0);
  }
  assert.equal(page.moves, 0); assert.equal(page.wheels, 0); assert.equal(page.reads, 1);
  return result;
}

for (const [text, expected] of [['net::ERR_NAME_NOT_RESOLVED', 'dns'], ['net::ERR_ABORTED', 'aborted'],
  ['net::ERR_BLOCKED_BY_CLIENT', 'blocked-client'], ['net::ERR_FAILED', 'unknown'],
  ['net::ERR_ABORTED at https://example.test/?secret=PRIVATE_PHASE56', 'unknown'],
  ['throw', 'unknown'], ['getter', 'unknown'], ['missing', 'unknown']]) {
  test(`phase56 peer: actual production onFailed ${expected} stays passive and never claims works 403`, async t => {
    const page = new Page(text);
    const result = await execute(t, page);
    assert.equal(page.failureCalls, text === 'missing' ? 0 : 1, 'only the first eligible terminal may read synchronous metadata');
    assert.equal(result.status, 'unavailable'); assert.equal(result.worksCoverage, 'unavailable');
    assert.equal(result.errorCode, 'collector_error');
    assert.equal(result.failureDiagnostics.stopReason, 'no-bound-request');
    assert.deepEqual(result.failureDiagnostics.httpStatuses, []);
    assert.equal(result.failureDiagnostics.requests.matched, 0);
    assert.equal(result.failureDiagnostics.runtime.boundRequestFailedCount, 0);
    const observation = result.failureDiagnostics.resourceObservation;
    assert.equal(observation.failuresByPhase.beforeStop.kinds[expected], 1);
    assert.equal(observation.failuresByPhase.beforeStop.total, 1);
    assert.equal(observation.resources.fetch.failed, 1);
    assert.deepEqual(observation.resources.fetch.statusCounts, []);
    assert.equal(observation.failuresByPhase.afterStop.total, 0);
    assert.equal(observation.failuresByPhase.cleanup.total, 0);
    assert.equal(JSON.stringify(result).includes('PRIVATE_PHASE56'), false);
    const parentProjection = projectWorksOnlyFailure(result);
    assert.equal(parentProjection.failureDiagnostics.resourceObservation.failuresByPhase.beforeStop.kinds[expected], 1);
    assert.equal(JSON.stringify(parentProjection).includes('PRIVATE_PHASE56'), false);
  });
}

test('phase56 peer: passive failed script observation cannot grant first-page readiness', async t => {
  const page = new Page('net::ERR_CONNECTION_RESET', 'script');
  const result = await execute(t, page);
  assert.equal(result.failureDiagnostics.resourceObservation.resources.script.failed, 1);
  assert.equal(result.failureDiagnostics.resourceObservation.failuresByPhase.beforeStop.kinds.connection, 1);
  assert.equal(result.failureDiagnostics.firstScreen.readyState, 'loading');
  assert.equal(result.failureDiagnostics.firstPageActivation.actionCount, 0);
});

test('phase56 peer: an unrelated resource HTTP403 finishes normally without failure() or a works refusal', async t => {
  const page = new Page(403);
  const result = await execute(t, page);
  assert.equal(page.failureCalls, 0);
  const observation = result.failureDiagnostics.resourceObservation;
  assert.equal(observation.resources.fetch.finished, 1);
  assert.equal(observation.resources.fetch.failed, 0);
  assert.deepEqual(observation.resources.fetch.statusCounts, [{ status: 403, count: 1 }]);
  assert.equal(observation.failuresByPhase.beforeStop.total, 0);
  assert.deepEqual(result.failureDiagnostics.httpStatuses, []);
  assert.equal(result.errorCode, 'collector_error');
  assert.equal(result.failureDiagnostics.stopReason, 'no-bound-request');
});

test('phase56 peer: invalid or untracked request never reads failure metadata', async t => {
  const page = new Page('net::ERR_BLOCKED_BY_CLIENT'); page.invalidResource = true;
  const result = await execute(t, page);
  assert.equal(page.failureCalls, 0);
  assert.equal(result.failureDiagnostics.resourceObservation.resources.fetch.failed, 0);
  assert.ok(result.failureDiagnostics.resourceObservation.discarded.invalid >= 1);
  assert.equal(result.failureDiagnostics.resourceObservation.failuresByPhase.beforeStop.total, 0);
});

test('phase56 peer: overflow requests are excluded from metadata reads by the real adapter cap', async t => {
  const page = new Page('net::ERR_BLOCKED_BY_CLIENT');
  page.beforeResource = () => {
    for (let i = 0; i < 257; i++) page.emit('request', {
      resourceType: () => 'fetch', isNavigationRequest: () => false,
      url: () => 'https://example.test/anonymous-pending-resource', frame: () => page.frame, method: () => 'GET',
      failure() { throw new Error('PRIVATE_PHASE56'); },
    });
  };
  const result = await execute(t, page);
  assert.equal(page.failureCalls, 0);
  const observation = result.failureDiagnostics.resourceObservation;
  assert.equal(observation.resources.fetch.requested, 256);
  assert.equal(observation.resources.fetch.unresolvedAtClose, 256);
  assert.equal(observation.discarded.capacity, 2);
  assert.equal(observation.resources.fetch.failed, 0);
  assert.equal(observation.failuresByPhase.beforeStop.total, 0);
});

test('phase56 peer: a request already finished cannot read failure metadata when a late failed event arrives', async t => {
  const page = new Page(403); page.failAfterFinished = true;
  const result = await execute(t, page);
  assert.equal(page.failureCalls, 0);
  assert.equal(result.failureDiagnostics.resourceObservation.resources.fetch.finished, 1);
  assert.equal(result.failureDiagnostics.resourceObservation.resources.fetch.failed, 0);
  assert.equal(result.failureDiagnostics.resourceObservation.failuresByPhase.beforeStop.total, 0);
});

test('phase56 peer: retained request cannot read metadata or mutate results after observer closure', async t => {
  const page = new Page('net::ERR_NAME_NOT_RESOLVED');
  const result = await execute(t, page); const frozen = JSON.stringify(result);
  let lateReads = 0; page.lastResource.failure = () => { lateReads++; throw new Error('PRIVATE_PHASE56'); };
  for (let i = 0; i < 100; i++) page.emit('requestfailed', page.lastResource);
  await drain();
  assert.equal(lateReads, 0); assert.equal(page.failureCalls, 1);
  assert.equal(JSON.stringify(result), frozen);
  assert.equal(page.moves, 0); assert.equal(page.wheels, 0);
});
