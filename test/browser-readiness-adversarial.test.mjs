import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { collectOne } from '../scripts/douyin_browser_collector.mjs';

const SEC = 'MS4wLjABAAAAAdversarialReadinessFixture123';
const PROFILE = `https://www.douyin.com/user/${SEC}`;
const WORKS = `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${SEC}&max_cursor=0`;
const drain = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const body = () => ({ status_code: 0, has_more: false, max_cursor: 0,
  aweme_list: [{ aweme_id: '7300000000000000991', author: { uid: '123456789', sec_uid: SEC }, statistics: { digg_count: 7 } }] });

class Page extends EventEmitter {
  constructor(options = {}) {
    super(); Object.assign(this, { address: 'about:blank', ready: 'loading', screens: [], reads: 0, moves: 0, wheels: 0 }, options);
    this.frame = { url: () => this.address };
    this.mouse = { move: async () => { this.moves++; }, wheel: async () => { this.wheels++; } };
  }
  url() { return this.address; }
  mainFrame() { return this.frame; }
  request(url = WORKS, navigation = false, frame = this.frame) {
    return { url: () => url, method: () => 'GET', frame: () => frame, isNavigationRequest: () => navigation };
  }
  headers(request, status = 200) { this.emit('response', { request: () => request, status: () => status, url: request.url }); }
  commit(status = 200) {
    const request = this.request(PROFILE, true);
    this.emit('request', request);
    // Main-resource headers precede document commit, unlike several historical
    // fixtures. DOMContentLoaded is emitted only after readyState becomes ready.
    this.headers(request, status); this.address = PROFILE; this.ready = 'loading';
    this.emit('framenavigated', this.frame); return request;
  }
  dom() { this.ready = 'interactive'; this.emit('domcontentloaded'); }
  history() { this.address = `${PROFILE}?normal=history`; this.emit('framenavigated', this.frame); }
  works(value = body(), { request = this.request(), status = 200, emitRequest = true } = {}) {
    if (emitRequest) this.emit('request', request);
    this.emit('response', { request: () => request, status: () => status, url: request.url,
      json: async () => { this.reads++; return typeof value === 'function' ? value() : value; } });
    return request;
  }
  async goto() { this.initial = this.commit(); }
  project(fn, arg) {
    const document = { readyState: this.ready, body: { childElementCount: this.ready === 'loading' ? 0 : 2 },
      querySelectorAll: () => [], querySelector: () => null };
    return runInNewContext(`(${fn.toString()})(arg)`, { document, location: new URL(this.address), arg });
  }
  async evaluate(fn, arg) {
    assert.equal(fn.name, 'observeBrowserFirstScreen', 'short tests must not reach an activation action');
    const value = this.project(fn, arg); this.screens.push({ at: Date.now(), value, documentStatus: arg.documentStatus });
    return this.onScreen ? this.onScreen(value, this.screens.length) : value;
  }
}

async function execute(t, page, events = {}, options = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let done = false;
  const pending = collectOne(page, { key: 'offline-adversarial', secUid: SEC, limit: 30 },
    { timeoutMs: 250, bodyTimeoutMs: 200, failureGraceMs: 1, ...options });
  pending.finally(() => { done = true; }); await drain();
  for (let at = 10; !done && at <= 500; at += 10) {
    t.mock.timers.tick(10); events[at]?.(page); await drain();
  }
  assert.equal(done, true, 'original total deadline remains authoritative');
  const result = await pending;
  for (const event of ['request', 'response', 'framenavigated', 'domcontentloaded', 'requestfailed', 'pageerror']) assert.equal(page.listenerCount(event), 0);
  assert.equal(page.moves, 0); assert.equal(page.wheels, 0);
  return result;
}

test('adversarial readiness: actual header/commit/DOM order preserves the ready second projection', async t => {
  const p = new Page(); const r = await execute(t, p, { 10: p => p.history(), 20: p => p.dom() });
  assert.deepEqual(p.screens.map(s => s.value.readyState), ['loading', 'interactive']);
  assert.deepEqual(p.screens.map(s => s.documentStatus), [200, 200]);
  assert.equal(r.failureDiagnostics.firstScreen.readyState, 'interactive');
  assert.equal(r.status, 'unavailable'); assert.deepEqual(r.posts, []);
});

test('adversarial readiness: legal concurrent commit and DOM projections cannot let late loading overwrite ready', async t => {
  let release;
  const p = new Page({ onScreen: (value, n) => n === 1 ? new Promise(resolve => { release = () => resolve(value); }) : value });
  const r = await execute(t, p, { 20: p => p.dom(), 50: () => release() });
  assert.equal(p.screens.length, 2);
  assert.equal(r.failureDiagnostics.firstScreen.readyState, 'interactive');
});

test('adversarial readiness: a new same-URL document retires old pending projections', async t => {
  let release;
  const p = new Page({ onScreen: (value, n) => n === 1 ? new Promise(resolve => { release = () => resolve({ ...value, scriptCount: 777 }); }) : value });
  const r = await execute(t, p, { 20: p => p.commit(), 40: p => p.dom(), 60: () => release() });
  assert.equal(p.screens.length, 3);
  assert.equal(r.failureDiagnostics.firstScreen.scriptCount, 0);
  assert.equal(r.failureDiagnostics.firstScreen.readyState, 'interactive');
});

test('adversarial readiness: old request body cannot be adopted after same-URL document replacement', async t => {
  let release;
  const p = new Page();
  const r = await execute(t, p, { 10: p => p.works(() => new Promise(resolve => { release = resolve; })),
    20: p => p.commit(), 30: p => p.dom(), 50: () => release(body()) });
  assert.equal(p.reads, 1); assert.equal(r.status, 'unavailable'); assert.deepEqual(r.posts, []);
  assert.equal(r.failureDiagnostics.responses.matched, 0);
});

for (const status of [401, 403, 429]) test(`adversarial readiness: document ${status} closes before late DOM and body`, async t => {
  const p = new Page();
  const r = await execute(t, p, { 20: p => p.headers(p.initial, status), 30: p => { p.dom(); p.works(); } });
  assert.equal(r.status, 'unavailable'); assert.deepEqual(r.posts, []); assert.equal(p.reads, 0);
});

for (const kind of ['unbound-object', 'subframe', 'wrong-author', 'missing-author', 'missing-has-more']) {
  test(`adversarial readiness: ${kind} never becomes a persisted-work candidate`, async t => {
    const p = new Page();
    const r = await execute(t, p, { 20: p => {
      p.dom(); const value = body();
      if (kind === 'wrong-author') value.aweme_list[0].author.sec_uid = `${SEC}other`;
      if (kind === 'missing-author') delete value.aweme_list[0].author;
      if (kind === 'missing-has-more') delete value.has_more;
      if (kind === 'unbound-object') { p.emit('request', p.request()); p.works(value, { emitRequest: false }); }
      else if (kind === 'subframe') p.works(value, { request: p.request(WORKS, false, { url: () => PROFILE }) });
      else p.works(value);
    } });
    assert.equal(r.status, 'unavailable'); assert.deepEqual(r.posts, []);
    if (['unbound-object', 'subframe'].includes(kind)) assert.equal(p.reads, 0);
  });
}

test('adversarial readiness: valid current bound response remains a positive control', async t => {
  const p = new Page(); const r = await execute(t, p, { 20: p => { p.dom(); p.works(); } });
  assert.equal(r.status, 'ok'); assert.equal(r.posts.length, 1); assert.equal(p.reads, 1);
  assert.equal(r.pagination.pages.length, 1);
});

test('adversarial readiness: unresolved second projection cannot act or alter returned diagnostics after deadline', async t => {
  let release;
  const p = new Page({ onScreen: (value, n) => n === 2 ? new Promise(resolve => { release = () => resolve(value); }) : value });
  const r = await execute(t, p, { 20: p => p.dom() });
  const frozen = JSON.stringify(r); release(); await drain();
  assert.equal(JSON.stringify(r), frozen); assert.deepEqual(r.posts, []);
  assert.equal(p.screens.length, 2); assert.equal(p.wheels, 0);
});

test('adversarial readiness: cancellation retires a pending DOM projection and body without acceptance', async t => {
  const controller = new AbortController(); let screen, response;
  const p = new Page({ onScreen: (value, n) => n === 2 ? new Promise(resolve => { screen = () => resolve(value); }) : value });
  const r = await execute(t, p, { 20: p => { p.dom(); p.works(() => new Promise(resolve => { response = resolve; })); },
    40: () => controller.abort() }, { signal: controller.signal });
  const frozen = JSON.stringify(r); screen(); response(body()); await drain();
  assert.equal(JSON.stringify(r), frozen); assert.equal(r.status, 'unavailable'); assert.deepEqual(r.posts, []);
});
