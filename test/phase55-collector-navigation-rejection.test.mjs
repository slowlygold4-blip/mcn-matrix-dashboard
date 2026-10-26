import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { collectOne } from '../scripts/douyin_browser_collector.mjs';
import { sanitizeBrowserWorksDiagnostics } from '../lib/douyin-browser-diagnostics.mjs';
import { projectWorksOnlyFailure } from '../lib/works-only-failure.mjs';
import { validateWorksOnlyEvidence } from '../lib/works-only-observation.mjs';
import { checksum } from '../lib/utils.mjs';

// These now run the actual root-reviewed production correction, not an
// in-memory candidate. The original RED behavior is retained in the report.
// No browser, session, production DB, platform or scheduler is opened.

const SEC = 'MS4wLjABAAAAPhase55NavigationOffline';
const PROFILE = `https://www.douyin.com/user/${SEC}`;
const WORKS = `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${SEC}&max_cursor=0`;
const drain = async () => { for (let n = 0; n < 50; n++) await Promise.resolve(); };

class Page extends EventEmitter {
  constructor() {
    super(); this.address = 'about:blank'; this.ready = 'loading'; this.screens = 0; this.wheels = 0;
    this.frame = { url: () => this.address };
    this.mouse = { move: async () => {}, wheel: async () => {
      this.wheels++; const req = this.request(WORKS);
      this.emit('request', req); this.emit('response', { request: () => req, url: req.url,
        status: () => 200, json: async () => ({ status_code: 0, has_more: false, max_cursor: 0,
          aweme_list: [{ aweme_id: '7300000000000055055', author: { sec_uid: SEC }, statistics: { digg_count: 5 } }] }) });
    } };
  }
  mainFrame() { return this.frame; }
  url() { return this.address; }
  request(url = PROFILE, navigation = false) {
    return { url: () => url, method: () => 'GET', frame: () => this.frame, isNavigationRequest: () => navigation };
  }
  startDocument() { const req = this.request(PROFILE, true); this.emit('request', req); return req; }
  commit(status = 200, address = PROFILE, emitRequest = true) {
    const req = emitRequest ? this.startDocument() : this.initial;
    if (status !== null) this.emit('response', { request: () => req, url: () => address, status: () => status });
    this.address = address; this.ready = 'loading'; this.emit('framenavigated', this.frame);
  }
  domReady() { this.ready = 'interactive'; this.emit('domcontentloaded'); }
  goto() { this.initial = this.startDocument(); return new Promise((resolve, reject) => {
    this.resolveGoto = resolve; this.rejectGoto = reject;
  }); }
  async evaluate(fn) {
    if (fn.name === 'observeBrowserFirstScreen') { this.screens++; if (this.projectionUnknown) return null; return {
      observation: 'observed', readyState: this.ready, bodyPresent: this.ready !== 'loading' }; }
    assert.equal(fn.name, 'observeFirstPageActivation');
    return this.gate ? { eligible: false, reason: 'blocked' } : { eligible: true, x: 400, y: 400, deltaY: 400 };
  }
}

async function run(t, fn, page, { status = 200, address = PROFILE, replacement = true,
  errorName = 'Error', signal, lifecycle = 'dom', historyStorm = false, redirect = false,
  gotoOutcome = 'reject' } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const events = { 20: () => {
    if (redirect) page.emit('response', { request: () => page.initial, url: () => PROFILE, status: () => 302 });
    page.commit(status, address, replacement);
    if (historyStorm) for (let n = 0; n < 1000; n++) page.emit('framenavigated', page.frame);
  }, 40: () => {
    if (lifecycle === 'dom') page.domReady();
    else if (lifecycle === 'load-only') { page.ready = 'complete'; page.emit('load'); }
    else if (lifecycle === 'stale-dcl') page.emit('domcontentloaded');
  }, 60: () => {
    if (gotoOutcome === 'resolve') page.resolveGoto();
    else if (gotoOutcome === 'reject') page.rejectGoto(Object.assign(new Error('fixture private navigation details'), { name: errorName }));
  } };
  let done = false;
  const pending = fn(page, { key: 'phase55-offline', secUid: SEC, limit: 30 }, { timeoutMs: 2600, signal });
  void pending.then(() => { done = true; }); await drain();
  for (let at = 10; !done && at <= 2700; at += 10) {
    t.mock.timers.tick(10); events[at]?.(); await drain();
  }
  assert.equal(done, true); const result = await pending;
  assert.ok(result.failureDiagnostics.elapsedMs <= 2600);
  for (const event of ['request', 'response', 'framenavigated', 'domcontentloaded', 'load', 'pageerror', 'requestfailed', 'requestfinished']) {
    assert.equal(page.listenerCount(event), 0);
  }
  assert.doesNotMatch(JSON.stringify(result), /fixture private|Cookie|signature/);
  return result;
}

test('phase55: actual production keeps a verified ready replacement and preserves its superseded command error', async t => {
  const page = new Page(); const result = await run(t, collectOne, page);
  assert.equal(result.status, 'ok'); assert.equal(result.failureDiagnostics.stopReason, 'success');
  assert.equal(result.failureDiagnostics.lifecycle.generation, 2);
  assert.equal(result.failureDiagnostics.lifecycle.domContentLoadedCount, 1);
  assert.equal(result.failureDiagnostics.firstScreen.readyState, 'interactive');
  assert.equal(result.failureDiagnostics.navigation.committed, true);
  assert.equal(result.failureDiagnostics.navigation.failed, false);
  assert.equal(result.failureDiagnostics.requests.matched, 1); assert.equal(page.wheels, 1);
  assert.deepEqual(result.failureDiagnostics.runtime.supersededNavigationError, {
    version: 1, commandedGeneration: 1, generation: 2, errorKind: 'error',
    attribution: 'goto-command-not-current-document',
  });
});

test('phase55: actual production retains existing strict response, action and pagination gates', async t => {
  const page = new Page(); const result = await run(t, collectOne, page);
  assert.equal(result.status, 'ok'); assert.equal(page.wheels, 1); assert.equal(page.screens, 2);
  assert.equal(result.failureDiagnostics.navigation.failed, false);
  assert.equal(result.failureDiagnostics.requests.matched, 1); assert.deepEqual(result.failureDiagnostics.httpStatuses, [200]);
  assert.equal(result.pagination.stopReason, 'end-of-list'); assert.equal(result.posts.length, 1);
});

for (const params of [
  { status: null }, { status: 403 }, { address: 'https://www.douyin.com/passport/web/login' },
  { address: 'https://other.example/profile' }, { replacement: false }, { errorName: 'TimeoutError' },
  { errorName: 'TypeError' }, { errorName: 'SyntaxError' }, { errorName: 'ReferenceError' },
  { errorName: 'RangeError' }, { errorName: 'UnknownNavigationFailure' },
]) test(`phase55: production cannot continue without newer verified current document ${JSON.stringify(params)}`, async t => {
  const page = new Page(); const result = await run(t, collectOne, page, params);
  assert.equal(result.status, 'unavailable'); assert.equal(page.wheels, 0); assert.deepEqual(result.posts, []);
});

for (const gate of ['login', 'challenge']) test(`phase55: production never interacts with a visible ${gate} gate`, async t => {
  const page = new Page(); page.gate = gate; const result = await run(t, collectOne, page);
  assert.equal(result.status, 'unavailable'); assert.equal(page.wheels, 0); assert.deepEqual(result.posts, []);
});

test('phase55: cancellation rejects recovery without a later action', async t => {
  const controller = new AbortController(); controller.abort();
  const page = new Page(); const result = await run(t, collectOne, page, { signal: controller.signal });
  assert.equal(result.status, 'unavailable'); assert.equal(page.wheels, 0); assert.deepEqual(result.posts, []);
});

  test('phase55: a normal HTTP redirect remains source-bound in production', async t => {
    const page = new Page(); const result = await run(t, collectOne, page, { redirect: true, gotoOutcome: 'resolve' });
    assert.equal(result.status, 'ok'); assert.equal(result.failureDiagnostics.lifecycle.generation, 2);
    assert.equal(result.failureDiagnostics.navigation.failed, false); assert.equal(page.wheels, 1);
    assert.equal(result.posts.length, 1); assert.equal(result.pagination.stopReason, 'end-of-list');
  });

test('phase55: same-document history storms cannot replace the commanded generation or grant a recovery', async t => {
  const page = new Page(); const result = await run(t, collectOne, page, { replacement: false, historyStorm: true });
  assert.equal(result.failureDiagnostics.lifecycle.generation, 1);
  assert.equal(result.failureDiagnostics.navigation.failed, true); assert.equal(result.status, 'unavailable');
  assert.equal(page.wheels, 0); assert.equal(page.screens, 2);
});

for (const lifecycle of ['load-only', 'stale-dcl']) test(`phase55: ${lifecycle} cannot substitute for an actual current ready projection`, async t => {
  const page = new Page(); const result = await run(t, collectOne, page, { lifecycle });
  assert.equal(result.status, 'unavailable'); assert.equal(result.failureDiagnostics.navigation.failed, true);
  assert.equal(result.failureDiagnostics.firstScreen.readyState, 'loading'); assert.equal(page.wheels, 0);
  assert.equal(result.failureDiagnostics.lifecycle[lifecycle === 'load-only' ? 'loadCount' : 'domContentLoadedCount'], 1);
});

test('phase55: an unknown current projection cannot recover a superseded command', async t => {
  const page = new Page(); page.projectionUnknown = true; const result = await run(t, collectOne, page);
  assert.equal(result.status, 'unavailable'); assert.equal(result.failureDiagnostics.navigation.failed, true);
  assert.equal(result.failureDiagnostics.firstScreen.observation, 'unavailable'); assert.equal(page.wheels, 0);
});

test('phase55: a hanging command retains its actual bounded timeout despite a ready replacement', async t => {
  const page = new Page(); const result = await run(t, collectOne, page, { gotoOutcome: 'hang' });
  assert.equal(result.status, 'unavailable'); assert.equal(result.failureDiagnostics.stopReason, 'navigation-timeout');
  assert.equal(result.failureDiagnostics.navigation.timedOut, true); assert.equal(page.wheels, 0);
  assert.equal(result.failureDiagnostics.elapsedMs, 2600);
});

test('phase55: actual superseded-error whitelist never exports raw attribution, identifiers or exception text', () => {
  const raw = { version: 1, runtime: { supersededNavigationError: { version: 1,
    commandedGeneration: 1, generation: 2, errorKind: 'error', attribution: 'PRIVATE_URL',
    url: 'https://private.invalid', message: 'PRIVATE_EXCEPTION', cookie: 'PRIVATE_COOKIE' } } };
  const clean = sanitizeBrowserWorksDiagnostics(raw);
  assert.deepEqual(clean.runtime.supersededNavigationError, { version: 1, commandedGeneration: 1,
    generation: 2, errorKind: 'error', attribution: 'goto-command-not-current-document' });
  assert.doesNotMatch(JSON.stringify(clean), /PRIVATE|cookie|https:/);
  for (const invalid of [-1, 1_000_001, 1.5, '2', Infinity, null]) {
    const projected = sanitizeBrowserWorksDiagnostics({ version: 1, runtime: {
      supersededNavigationError: { version: 1, commandedGeneration: invalid, generation: invalid, errorKind: 'PRIVATE' } } });
    assert.equal(projected.runtime.supersededNavigationError.commandedGeneration, null);
    assert.equal(projected.runtime.supersededNavigationError.generation, null);
    assert.equal(projected.runtime.supersededNavigationError.errorKind, 'unknown');
  }
  for (const invalid of [null, [], { version: 2 }]) {
    assert.equal(sanitizeBrowserWorksDiagnostics({ version: 1, runtime: { supersededNavigationError: invalid } })
      .runtime.supersededNavigationError, undefined);
  }
});

test('phase55: child JSON and actual parent projection retain the new exception without claiming current navigation failure', async t => {
  const page = new Page(); const result = await run(t, collectOne, page);
  const parent = projectWorksOnlyFailure(JSON.parse(JSON.stringify(result)));
  const again = projectWorksOnlyFailure(JSON.parse(JSON.stringify(parent)));
  assert.deepEqual(parent.failureDiagnostics.runtime.supersededNavigationError,
    result.failureDiagnostics.runtime.supersededNavigationError);
  assert.deepEqual(again, parent); assert.equal(parent.failureDiagnostics.navigation.failed, false);
});

test('phase55: old canonical unavailable evidence remains checksum-identical with no invented exception metadata', () => {
  const old = { version: 1, kind: 'works-only-observation', source: 'authorised-browser', targetId: 1, runId: 1,
    anchorSnapshotId: 1, anchorChecksum: 'a'.repeat(64), requestedLimit: 30,
    identity: { secUid: SEC, uid: '1234567890' }, requestStartedAt: '2026-09-28T00:00:00.000Z',
    requestFinishedAt: '2026-09-28T00:00:01.000Z', observedAt: null, status: 'unavailable',
    coverage: 'unavailable', errorCode: 'collector_error', posts: [], pagination: null,
    ...projectWorksOnlyFailure({ failureDiagnostics: { version: 1, stopReason: 'no-bound-request' } }),
  };
  const original = JSON.stringify(old), oldSha = checksum(old);
  assert.equal(old.failureDiagnostics.runtime.supersededNavigationError, undefined);
  const canonical = validateWorksOnlyEvidence(old, { now: Date.parse('2026-09-28T00:01:00.000Z') });
  assert.equal(checksum(canonical), oldSha); assert.equal(JSON.stringify(old), original);
  assert.equal(canonical.failureDiagnostics.runtime.supersededNavigationError, undefined);
  const tampered = structuredClone(old); tampered.failureDiagnostics.runtime.supersededNavigationError = {
    version: 1, commandedGeneration: 1, generation: 2, errorKind: 'error',
    attribution: 'PRIVATE', url: 'PRIVATE',
  };
  assert.throws(() => validateWorksOnlyEvidence(tampered, { now: Date.parse('2026-09-28T00:01:00.000Z') }),
    error => error.code === 'WORKS_OBSERVATION_INVALID');
});
