import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { collectOne } from '../scripts/douyin_browser_collector.mjs';
import { sanitizeBrowserWorksDiagnostics } from '../lib/douyin-browser-diagnostics.mjs';
import { projectWorksOnlyFailure } from '../lib/works-only-failure.mjs';

const SEC = 'MS4wLjABAAAAPhase54ReadinessOffline';
const PROFILE = `https://www.douyin.com/user/${SEC}`;
const WORKS = `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${SEC}&max_cursor=0`;
const drain = async () => { for (let n = 0; n < 50; n++) await Promise.resolve(); };

// Independent, local event adapter: no browser launch, filesystem state,
// credentials, DB or website is involved. The production collectOne runs.
class Page extends EventEmitter {
  constructor() {
    super(); this.address = 'about:blank'; this.ready = 'loading'; this.screens = 0;
    this.frame = { url: () => this.address }; this.wheels = 0; this.moves = 0; this.bodyReads = 0;
    this.mouse = { move: async () => { this.moves++; }, wheel: async () => {
      this.wheels++; this.works(this.worksStatus ?? 200);
    } };
  }
  url() { return this.address; }
  mainFrame() { return this.frame; }
  request(url = WORKS, navigation = false) {
    return { url: () => url, frame: () => this.frame, method: () => 'GET', isNavigationRequest: () => navigation };
  }
  commit(status = 200) {
    const request = this.request(PROFILE, true); this.emit('request', request);
    this.emit('response', { request: () => request, url: request.url, status: () => status });
    this.address = PROFILE; this.ready = 'loading'; this.emit('framenavigated', this.frame);
  }
  async goto() { this.beforeCommit?.(); this.commit(this.documentStatus ?? 200); }
  works(status = 200) {
    const request = this.request(); this.emit('request', request);
    this.emit('response', { request: () => request, url: request.url, status: () => status,
      json: async () => { this.bodyReads++; return { status_code: 0, has_more: false, max_cursor: 0,
        aweme_list: [{ aweme_id: '7300000000000054054', author: { sec_uid: SEC }, statistics: { digg_count: 7 } }] }; } });
  }
  async evaluate(fn) {
    if (fn.name === 'observeBrowserFirstScreen') {
      this.screens++;
      return { observation: 'observed', readyState: this.ready, bodyPresent: this.ready !== 'loading' };
    }
    assert.equal(fn.name, 'observeFirstPageActivation');
    return this.gate ? { eligible: false, reason: 'blocked' } : { eligible: true, x: 400, y: 400, deltaY: 400 };
  }
  dom() { this.ready = 'interactive'; this.emit('domcontentloaded'); }
  load() { this.ready = 'complete'; this.emit('load'); }
}

async function execute(t, page, events = {}, timeoutMs = 2600) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let done = false;
  const promise = collectOne(page, { key: 'phase54-offline', secUid: SEC, limit: 30 }, { timeoutMs });
  void promise.then(() => { done = true; }, () => { done = true; });
  await drain();
  for (let at = 10; !done && at <= timeoutMs + 100; at += 10) {
    t.mock.timers.tick(10); events[at]?.(); await drain();
  }
  assert.equal(done, true, 'passive observation cannot extend the existing total bound');
  const result = await promise;
  for (const event of ['request', 'response', 'framenavigated', 'domcontentloaded', 'load', 'pageerror', 'requestfailed', 'requestfinished']) {
    assert.equal(page.listenerCount(event), 0, `cleanup detaches ${event}`);
  }
  assert.ok(result.failureDiagnostics.elapsedMs <= timeoutMs);
  return result;
}

test('phase54: real listener-window milestones persist alongside the unchanged DCL activation path', async t => {
  const page = new Page();
  const result = await execute(t, page, { 20: () => page.dom(), 40: () => page.load() });
  assert.equal(result.status, 'ok'); assert.equal(page.wheels, 1); assert.equal(page.screens, 2);
  assert.deepEqual(result.failureDiagnostics.lifecycle, {
    version: 1, eventAttribution: 'listener-window-not-document-identity', generation: 1,
    domContentLoadedCount: 1, loadCount: 1,
    firstDomContentLoadedElapsedMs: 20, lastDomContentLoadedElapsedMs: 20,
    firstLoadElapsedMs: 40, lastLoadElapsedMs: 40,
    firstScreenAttemptCount: 2, lastAcceptedFirstScreenAttempt: 2, lastAcceptedFirstScreenSource: 'domcontentloaded',
  });
});

test('phase54: load alone is recorded but cannot become a fabricated readiness observation or new action', async t => {
  const page = new Page();
  const result = await execute(t, page, { 20: () => page.load() });
  assert.equal(result.status, 'unavailable'); assert.equal(result.failureDiagnostics.stopReason, 'no-bound-request');
  assert.equal(page.screens, 1); assert.equal(page.wheels, 0); assert.equal(page.bodyReads, 0);
  assert.equal(result.failureDiagnostics.firstScreen.readyState, 'loading');
  assert.equal(result.failureDiagnostics.lifecycle.loadCount, 1);
  assert.equal(result.failureDiagnostics.lifecycle.domContentLoadedCount, 0);
  assert.equal(result.failureDiagnostics.lifecycle.lastAcceptedFirstScreenSource, 'commit');
});

test('phase54: load event storms add no DOM evaluations, movement or deadline extension', async t => {
  const page = new Page();
  const result = await execute(t, page, { 20: () => { for (let n = 0; n < 1000; n++) page.load(); } });
  assert.equal(page.screens, 1); assert.equal(page.moves, 0); assert.equal(page.wheels, 0);
  assert.equal(result.failureDiagnostics.lifecycle.loadCount, 1000);
  assert.equal(result.failureDiagnostics.lifecycle.firstLoadElapsedMs, 20);
  assert.equal(result.failureDiagnostics.lifecycle.lastLoadElapsedMs, 20);
});

test('phase54: DCL event storms retain the original two-probe and one-action limits', async t => {
  const page = new Page();
  const result = await execute(t, page, { 20: () => {
    page.ready = 'interactive';
    for (let n = 0; n < 1000; n++) page.emit('domcontentloaded', { cookie: 'PRIVATE_SECRET' });
  }, 40: () => page.load() });
  assert.equal(result.worksCoverage, 'complete'); assert.equal(page.screens, 2); assert.equal(page.wheels, 1);
  assert.equal(result.failureDiagnostics.lifecycle.domContentLoadedCount, 1000);
  assert.equal(result.failureDiagnostics.lifecycle.firstScreenAttemptCount, 2);
  assert.equal(JSON.stringify(result).includes('PRIVATE_SECRET'), false);
});

test('phase54: a preceding document event does not grant the new document a ready snapshot', async t => {
  const page = new Page();
  page.beforeCommit = () => { page.emit('domcontentloaded'); page.emit('load'); };
  const result = await execute(t, page, { 20: () => page.dom(), 40: () => page.load() });
  assert.equal(result.worksCoverage, 'complete');
  assert.equal(result.failureDiagnostics.lifecycle.domContentLoadedCount, 1);
  assert.equal(result.failureDiagnostics.lifecycle.loadCount, 1);
});

test('phase54: same-URL replacement and a late load leave the real second DCL read available', async t => {
  const page = new Page();
  const result = await execute(t, page, { 20: () => page.commit(), 40: () => page.emit('load'), 60: () => page.dom() });
  assert.equal(result.worksCoverage, 'complete'); assert.equal(page.wheels, 1);
  assert.equal(page.screens, 3, 'one initial read in each generation plus the current DCL read');
  assert.equal(result.failureDiagnostics.lifecycle.generation, 2);
  assert.equal(result.failureDiagnostics.lifecycle.firstLoadElapsedMs, 40);
  assert.equal(result.failureDiagnostics.lifecycle.firstDomContentLoadedElapsedMs, 60);
  assert.equal(result.failureDiagnostics.lifecycle.firstScreenAttemptCount, 2);
});

test('phase54: counterexample rejects wiring un-attributed load to the existing ready probe', async t => {
  const page = new Page();
  // Simulate the proposed load->observeFirstScreen callback using the existing
  // DCL callback. The late old load consumes the current document's second
  // observation while its DOM is loading. This is a rejected proposal, not
  // claimed evidence that the live platform emitted such an old event.
  const result = await execute(t, page, { 20: () => page.commit(),
    40: () => { page.emit('load'); page.emit('domcontentloaded'); }, 60: () => page.dom() });
  assert.equal(result.status, 'unavailable'); assert.equal(page.screens, 3);
  assert.equal(page.wheels, 0); assert.equal(result.failureDiagnostics.firstScreen.readyState, 'loading');
});

for (const gate of ['login', 'challenge']) test(`phase54: ${gate} remains blocked despite recorded lifecycle events`, async t => {
  const page = new Page(); page.gate = gate;
  const result = await execute(t, page, { 20: () => page.dom(), 40: () => page.load() });
  assert.equal(result.status, 'unavailable'); assert.equal(page.moves, 0); assert.equal(page.wheels, 0);
  assert.equal(result.failureDiagnostics.firstPageActivation.state, 'blocked');
  assert.equal(result.failureDiagnostics.lifecycle.loadCount, 1);
});

test('phase54: exact HTTP rejection still reads no body or structural ready data', async t => {
  const page = new Page(); page.documentStatus = 403;
  const result = await execute(t, page);
  assert.equal(result.errorCode, 'blocked'); assert.equal(result.failureDiagnostics.stopReason, 'http-rejection');
  assert.equal(page.screens, 0); assert.equal(page.bodyReads, 0); assert.equal(page.wheels, 0);
});

test('phase54: frozen result cannot change after cleanup or leak lifecycle event payloads', async t => {
  const page = new Page(); const result = await execute(t, page, { 20: () => page.dom() });
  const frozen = JSON.stringify(result);
  page.emit('load', { cookie: 'PRIVATE_SECRET', url: 'PRIVATE_SECRET' });
  page.emit('domcontentloaded', 'PRIVATE_SECRET'); await drain();
  assert.equal(JSON.stringify(result), frozen); assert.equal(frozen.includes('PRIVATE_SECRET'), false);
});

test('phase54: lifecycle whitelist rejects unsafe values and ignores payload strings and identifiers', () => {
  const lifecycle = { version: 1, generation: 1, domContentLoadedCount: 3, loadCount: 5,
    firstDomContentLoadedElapsedMs: 0, lastDomContentLoadedElapsedMs: 20,
    firstLoadElapsedMs: 30, lastLoadElapsedMs: 40, firstScreenAttemptCount: 2,
    lastAcceptedFirstScreenAttempt: 2, lastAcceptedFirstScreenSource: 'domcontentloaded',
    cookie: 'PRIVATE_SECRET', url: 'PRIVATE_SECRET', eventAttribution: 'PRIVATE_SECRET', secUid: SEC };
  const clean = sanitizeBrowserWorksDiagnostics({ version: 1, lifecycle }).lifecycle;
  assert.equal(clean.eventAttribution, 'listener-window-not-document-identity');
  assert.equal(JSON.stringify(clean).includes('PRIVATE_SECRET'), false);
  assert.equal(JSON.stringify(clean).includes(SEC), false);
  for (const invalid of [-1, 1.5, Infinity, '2', true, Number.MAX_SAFE_INTEGER]) {
    const row = sanitizeBrowserWorksDiagnostics({ version: 1, lifecycle: { ...lifecycle,
      generation: invalid, domContentLoadedCount: invalid, loadCount: invalid,
      firstLoadElapsedMs: invalid, firstScreenAttemptCount: invalid } }).lifecycle;
    assert.equal(row.generation, null); assert.equal(row.domContentLoadedCount, null);
    assert.equal(row.loadCount, null); assert.equal(row.firstLoadElapsedMs, null);
    assert.equal(row.firstScreenAttemptCount, null);
  }
  assert.equal(sanitizeBrowserWorksDiagnostics({ version: 1 }).lifecycle, undefined, 'old evidence stays version-compatible without invented counters');
  assert.equal(sanitizeBrowserWorksDiagnostics({ version: 1, lifecycle: { version: 2 } }).lifecycle, undefined);
});

test('phase54: fresh child JSON and actual parent failure projection preserve only canonical lifecycle evidence', () => {
  const child = sanitizeBrowserWorksDiagnostics({ version: 1, stopReason: 'no-bound-request', lifecycle: {
    version: 1, generation: 2, domContentLoadedCount: 0, loadCount: 1,
    firstDomContentLoadedElapsedMs: null, lastDomContentLoadedElapsedMs: null,
    firstLoadElapsedMs: 300, lastLoadElapsedMs: 300, firstScreenAttemptCount: 1,
    lastAcceptedFirstScreenAttempt: 1, lastAcceptedFirstScreenSource: 'commit', signedUrl: 'PRIVATE_SECRET',
  } });
  const wire = JSON.parse(JSON.stringify({ ok: true, data: { items: [{ failureDiagnostics: child }] } }));
  const parent = projectWorksOnlyFailure(wire.data.items[0]);
  const canonical = projectWorksOnlyFailure(parent);
  assert.deepEqual(parent.failureDiagnostics.lifecycle, child.lifecycle);
  assert.deepEqual(canonical.failureDiagnostics.lifecycle, child.lifecycle);
  assert.equal(JSON.stringify(canonical).includes('PRIVATE_SECRET'), false);
  assert.equal(canonical.failureDiagnostics.stopReason, 'no-bound-request', 'milestones never turn missing works into success');
});
