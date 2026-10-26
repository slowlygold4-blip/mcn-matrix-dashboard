import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { collectOne } from '../scripts/douyin_browser_collector.mjs';
import { observeBrowserFirstScreen } from '../lib/browser-render-diagnostics.mjs';

// All transport is a local EventEmitter. No Chrome, website, session or DB is opened.
const SEC = 'MS4wLjABAAAAReadinessPeer20261001';
const PROFILE = `https://www.douyin.com/user/${SEC}`;
const WORKS = `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${SEC}&max_cursor=0`;
const drain = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const workBody = () => ({ status_code: 0, has_more: false, max_cursor: 0,
  aweme_list: [{ aweme_id: '7300000000000026101', author: { uid: '1234567890', sec_uid: SEC }, statistics: { digg_count: 5 } }] });

function domProjection(fn, arg, { address = PROFILE, ready = 'interactive', gate = null, encoded = null, reads = {} } = {}) {
  const rect = { left: 40, top: 40, right: 840, bottom: 440, width: 800, height: 400 };
  const region = { scrollTop: 0, scrollHeight: 1400, clientHeight: 400, parentElement: null,
    contains: other => other === region, getBoundingClientRect: () => rect };
  const dialog = { getBoundingClientRect: () => rect, getClientRects: () => [rect] };
  const script = {};
  Object.defineProperty(script, 'textContent', { get() { reads.embedded = (reads.embedded ?? 0) + 1; return encoded; } });
  const document = { readyState: ready, body: { childElementCount: 2 }, scrollingElement: region,
    querySelectorAll(selector) {
      if (selector.includes('user-post-list')) return [region];
      if (selector === 'script' || selector === 'script[type="application/json"]') return encoded === null ? [] : [script];
      if (gate && selector.includes('role="dialog"') && selector.includes('aria-modal')) return [dialog];
      if (gate === 'verification' && selector.includes('captcha')) return [dialog];
      if (gate === 'login' && selector.includes('form[action*="/login"]')) return [dialog];
      return [];
    },
    querySelector: selector => encoded !== null && selector.includes('RENDER_DATA') ? script : null,
    elementFromPoint: () => region };
  Object.defineProperty(document, 'cookie', { get() { throw Error('Fixture forbids credential reads'); } });
  return runInNewContext(`(${fn.toString()})(arg)`, { arg, URL, location: new URL(address), document,
    window: { innerWidth: 1000, innerHeight: 700 },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', overflowY: 'auto' }) }, { timeout: 1000 });
}

class OfflinePage extends EventEmitter {
  constructor(options = {}) {
    super(); Object.assign(this, { address: 'about:blank', ready: 'loading', screens: [], activations: [], moves: 0, wheels: 0, bodyReads: 0 }, options);
    this.frame = { url: () => this.address };
    this.mouse = { move: async () => { this.moves++; }, wheel: async () => { this.wheels++; this.works(); } };
  }
  url() { return this.address; }
  mainFrame() { return this.frame; }
  request(url = WORKS, navigation = false) { return { isNavigationRequest: () => navigation, frame: () => this.frame, method: () => 'GET', url: () => url }; }
  commit(url = PROFILE, status = 200) {
    const request = this.request(url, true); this.emit('request', request);
    this.emit('response', { request: () => request, url: request.url, status: () => status });
    this.address = url; this.ready = 'loading'; this.emit('framenavigated', this.frame); return request;
  }
  domReady() { this.ready = 'interactive'; this.emit('domcontentloaded'); }
  history() { this.address = `${PROFILE}?ordinary=history`; this.emit('framenavigated', this.frame); }
  works(status = 200) {
    const request = this.request(); this.emit('request', request);
    this.emit('response', { request: () => request, url: request.url, status: () => status,
      json: async () => { this.bodyReads++; return workBody(); } });
  }
  async goto() { this.beforeCommit?.(this); this.initial = this.commit(); }
  async evaluate(fn, arg) {
    const value = domProjection(fn, arg, { address: this.address, ready: this.ready, gate: this.gate });
    if (fn.name === 'observeBrowserFirstScreen') {
      this.screens.push({ at: Date.now(), state: value?.readyState, documentStatus: arg.documentStatus });
      return this.screenResponse ? this.screenResponse(value, this.screens.length) : value;
    }
    assert.equal(fn.name, 'observeFirstPageActivation');
    this.activations.push({ at: Date.now(), value });
    return value;
  }
}

async function execute(t, page, events = {}, { timeoutMs = 2600, ...options } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let done = false;
  const pending = collectOne(page, { key: 'readiness-peer', secUid: SEC, limit: 30 }, { timeoutMs, ...options });
  void pending.then(() => { done = true; }, () => { done = true; });
  await drain();
  let ticks = 0;
  for (let at = 10; !done && at <= timeoutMs + 500; at += 10) {
    t.mock.timers.tick(10); events[at]?.(page); await drain(); ticks++;
  }
  assert.equal(done, true, 'the original wall-time deadline must terminate the attempt');
  assert.ok(ticks <= Math.ceil((timeoutMs + 500) / 10), 'waiting cannot create an unbounded local spin');
  const result = await pending;
  for (const kind of ['request', 'response', 'framenavigated', 'domcontentloaded', 'requestfailed', 'pageerror', 'requestfinished']) assert.equal(page.listenerCount(kind), 0);
  assert.ok(result.failureDiagnostics.elapsedMs <= timeoutMs);
  return result;
}

test('peer: prior-document DOM event and a 1000-event history storm leave the current ready probe available', async t => {
  const page = new OfflinePage({ beforeCommit: p => { p.ready = 'interactive'; p.emit('domcontentloaded'); } });
  const result = await execute(t, page, { 20: p => { for (let n = 0; n < 1000; n++) p.history(); }, 40: p => p.domReady() });
  assert.deepEqual(page.screens.map(s => s.state), ['loading', 'interactive']);
  assert.deepEqual(page.screens.map(s => s.documentStatus), [200, 200]);
  assert.equal(page.moves, 1); assert.equal(page.wheels, 1); assert.equal(page.bodyReads, 1);
  assert.equal(result.status, 'ok'); assert.equal(result.worksCoverage, 'complete'); assert.equal(result.posts.length, 1);
});

test('peer: timeout of the first read does not consume the real later DOM-ready opportunity', async t => {
  let release;
  const page = new OfflinePage({ screenResponse: (value, n) => n === 1 ? new Promise(resolve => { release = () => resolve(value); }) : value });
  const result = await execute(t, page, { 600: p => p.domReady() });
  assert.deepEqual(page.screens.map(s => s.state), ['loading', 'interactive']);
  assert.equal(page.wheels, 1); assert.equal(result.worksCoverage, 'complete');
  const frozen = JSON.stringify(result); release(); await drain(); assert.equal(JSON.stringify(result), frozen);
});

test('peer: slower old loading result cannot overwrite the accepted ready projection', async t => {
  let release;
  const page = new OfflinePage({ screenResponse: (value, n) => n === 1 ? new Promise(resolve => { release = () => resolve(value); }) : value });
  const result = await execute(t, page, { 20: p => p.domReady(), 60: () => release() });
  assert.equal(result.failureDiagnostics.firstScreen.readyState, 'interactive');
  assert.equal(page.wheels, 1); assert.equal(result.posts[0].statistics.digg_count, 5);
});

test('peer: same-URL document replacement cannot adopt stale ready evidence from the earlier generation', async t => {
  let release;
  const page = new OfflinePage({ screenResponse: (value, n) => n === 1 ? new Promise(resolve => { release = () => resolve({ ...value, readyState: 'complete', scriptCount: 999 }); }) : value });
  const result = await execute(t, page, { 20: p => p.commit(), 60: () => release(), 700: p => p.domReady() });
  assert.deepEqual(page.screens.map(s => s.state), ['loading', 'loading', 'interactive']);
  assert.equal(result.failureDiagnostics.firstScreen.scriptCount, 0); assert.equal(result.failureDiagnostics.firstScreen.readyState, 'interactive');
  assert.ok(page.activations.every(p => p.at >= 1700)); assert.equal(page.wheels, 1); assert.equal(result.worksCoverage, 'complete');
});

test('peer: unresolved loading without a DOM-ready event is no-bound, not evidence of a lost readiness event', async t => {
  const page = new OfflinePage(); const result = await execute(t, page, {}, { timeoutMs: 3200 });
  assert.equal(page.screens.length, 1); assert.equal(page.activations.length, 0);
  assert.equal(page.moves, 0); assert.equal(page.wheels, 0); assert.equal(page.bodyReads, 0);
  assert.equal(result.failureDiagnostics.firstScreen.readyState, 'loading'); assert.equal(result.failureDiagnostics.stopReason, 'no-bound-request');
  assert.equal(result.worksCoverage, 'unavailable'); assert.deepEqual(result.posts, []);
});

for (const gate of ['login', 'verification']) test(`peer: ${gate} overlay at real DOM readiness prevents activation and embedded-data reading`, async t => {
  const page = new OfflinePage({ gate }); const result = await execute(t, page, { 20: p => p.domReady() });
  assert.equal(page.activations.length, 1); assert.equal(page.activations[0].value.reason, 'blocked');
  assert.equal(page.moves, 0); assert.equal(page.wheels, 0); assert.equal(page.bodyReads, 0);
  assert.equal(result.status, 'unavailable'); assert.deepEqual(result.posts, []);
  const reads = {}; const snapshot = domProjection(observeBrowserFirstScreen, { secUid: SEC, documentStatus: 200 }, { gate, encoded: '{private}', reads });
  assert.equal(snapshot.render.parseState, 'gated'); assert.equal(reads.embedded, undefined);
});

test('peer: exact bound HTTP 403 remains unavailable without body reads or DOM activation', async t => {
  const page = new OfflinePage(); const result = await execute(t, page, { 20: p => { p.domReady(); p.works(403); } });
  assert.equal(result.errorCode, 'blocked'); assert.equal(result.failureDiagnostics.stopReason, 'http-rejection');
  assert.equal(result.failureDiagnostics.requests.matched, 1); assert.deepEqual(result.failureDiagnostics.httpStatuses, [403]);
  assert.equal(page.bodyReads, 0); assert.equal(page.wheels, 0); assert.deepEqual(result.posts, []);
});

test('peer: document status and loading gates do not parse an embedded JSON payload', () => {
  for (const [documentStatus, ready] of [[null, 'interactive'], [403, 'complete'], [200, 'loading']]) {
    const reads = {}; const snapshot = domProjection(observeBrowserFirstScreen, { secUid: SEC, documentStatus }, { ready, encoded: '{private}', reads });
    assert.equal(snapshot.render.parseState, 'deferred'); assert.equal(reads.embedded, undefined);
  }
});

test('peer: local embedded projection has size, array-width and depth bounds, not an unbounded JSON traversal', () => {
  let nested = 0; for (let n = 0; n < 17; n++) nested = { child: nested };
  const payloads = ['x'.repeat(2_000_001), JSON.stringify({ rows: new Array(1001).fill(null) }), JSON.stringify(nested)];
  for (const encoded of payloads) {
    const snapshot = domProjection(observeBrowserFirstScreen, { secUid: SEC, documentStatus: 200 }, { encoded });
    assert.equal(snapshot.render.parseState, 'over-limit'); assert.equal(snapshot.render.postCount, null);
    assert.equal(Object.hasOwn(snapshot, 'posts'), false); assert.equal(JSON.stringify(snapshot).includes('private'), false);
  }
});
