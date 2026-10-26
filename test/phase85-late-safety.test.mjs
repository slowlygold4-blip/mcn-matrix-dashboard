// Independent adversarial coverage of the actual collector and serialized helper.
// No platform requests, state files, database access, production edits or processes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const owner = process.env.PHASE85_COLLECTOR_MODULE;
const moduleUrl = owner ? (owner.startsWith('file:') ? owner : pathToFileURL(owner).href) : new URL('../scripts/douyin_browser_collector.mjs', import.meta.url).href;
const { collectOne, collectBrowserWorks } = await import(moduleUrl);
const { requestBrowserFirstPage } = await import(new URL('../lib/browser-first-works-request.mjs', moduleUrl));
const SEC = 'MS4wLjABAAAAphase85LateSafetyFixture';
const profile = `https://www.douyin.com/user/${SEC}`;
const api = `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${SEC}&max_cursor=0`;
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const responseBody = code => ({ status_code: code, has_more: false, max_cursor: 0, aweme_list: [{
  aweme_id: '7234567890123400185', author: { sec_uid: SEC }, statistics: { digg_count: 85 },
}] });

function invokeHelper(fn, args, { address = profile, fetch = () => Promise.resolve({}), gate = false, locationChange = null, pageDocument = null, duringGate = null } = {}) {
  const location = new URL(address);
  const document = Object.assign(pageDocument || {}, { readyState: 'interactive', body: { childElementCount: 1 },
    querySelectorAll() {
      duringGate?.();
      if (locationChange) location.href = locationChange;
      return gate ? [{ getBoundingClientRect: () => ({ width: 10, height: 10, left: 0, top: 0, right: 10, bottom: 10 }) }] : [];
    },
  });
  for (const name of ['cookie', 'innerHTML', 'innerText']) if (!Object.hasOwn(document, name)) Object.defineProperty(document, name, { get() { assert.fail(`Forbidden ${name} read`); } });
  return vm.runInNewContext(`(${fn.toString()})(args)`, { args, URL, URLSearchParams, Date, AbortController,
    setTimeout, clearTimeout, location, document, window: { innerWidth: 1000, innerHeight: 800, fetch },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  });
}

class FixturePage extends EventEmitter {
  constructor(config = {}) {
    super(); this.config = config; this.address = 'about:blank'; this.generation = 0;
    this.frame = { url: () => this.address }; this.gets = []; this.reads = 0; this.helperCalls = []; this.handles = [];
    this.mouse = { move: async () => assert.fail('No mouse action expected'), wheel: async () => assert.fail('No mouse action expected') };
  }
  url() { return this.address; }
  mainFrame() { return this.frame; }
  makeRequest(url, navigation = false) { return { url: () => url, isNavigationRequest: () => navigation,
    frame: () => this.frame, method: () => 'GET', resourceType: () => navigation ? 'document' : 'fetch', redirectedFrom: () => null }; }
  commit() {
    this.generation++; this.document = {}; const request = this.makeRequest(profile, true);
    this.emit('request', request); this.address = profile;
    this.emit('response', { request: () => request, url: request.url, status: () => 200 });
    this.emit('framenavigated', this.frame);
  }
  natural({ status = 200, code = 0, bodyDelay = 0, missingRequest = false, noHeaders = false } = {}) {
    const request = this.makeRequest(api);
    if (!missingRequest) this.emit('request', request);
    if (!noHeaders) this.emit('response', { request: () => request, url: request.url, status: () => status,
      json: async () => { this.reads++; if (bodyDelay) await new Promise(resolve => setTimeout(resolve, bodyDelay)); return responseBody(code); } });
  }
  async goto() { this.commit(); }
  async close() { this.closed = true; }
  async evaluateHandle(fn) {
    if (this.config.delayHandle) await new Promise(resolve => setTimeout(resolve, this.config.delayHandle));
    const value = vm.runInNewContext(`(${fn.toString()})()`, { document: this.document });
    const handle = { value, disposed: false, async dispose() { this.disposed = true; } };
    this.handles.push(handle); this.config.beforeHandleReturn?.(this);
    return handle;
  }
  async evaluate(fn, args) {
    if (fn.name === 'observeBrowserFirstScreen') return { observation: 'observed', readyState: 'interactive', bodyPresent: true };
    if (fn.name === 'readTerminalStructure') return { readyState: 'interactive', bodyPresent: true, bodyChildCount: 1, scriptCount: 0 };
    if (fn.name === 'observeFirstPageActivation') return { eligible: false, reason: 'list-not-found' };
    assert.equal(fn.name, 'requestBrowserFirstPage'); this.helperCalls.push(Date.now());
    this.config.beforeHelper?.(this);
    if (this.config.delayHelper) await new Promise(resolve => setTimeout(resolve, this.config.delayHelper));
    if (this.config.forged) return this.config.forged;
    const browserArgs = { ...args, ...(args.expectedDocument ? { expectedDocument: args.expectedDocument.value } : {}) };
    return invokeHelper(fn, browserArgs, { address: this.address, gate: this.config.gate, pageDocument: this.document,
      fetch: (url, init) => {
        this.gets.push({ at: Date.now(), generation: this.generation, url, init });
        assert.equal(init.method, 'GET'); assert.equal(init.credentials, 'same-origin'); assert.equal(init.redirect, 'error');
        assert.equal(Object.hasOwn(init, 'headers'), false);
        if (!this.config.silent) this.natural(this.config.response);
        return Promise.resolve({ json() { assert.fail('helper cannot consume body'); } });
      },
    });
  }
}

async function run(t, config = {}, { events = {}, options = {}, afterReturnMs = 0, ownedBatch = false } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const page = new FixturePage(config); let done = false;
  const item = { key: 'phase85-late-safety', secUid: SEC, limit: 30 };
  const cleanup = [];
  const promise = ownedBatch ? collectBrowserWorks({ items: [item], timeoutMs: 999_999 }, { collectOptions: options, runtime: {
    ownership: { remainingExecutionMs: () => Math.max(0, 42_000 - Date.now()) },
    readState: async () => ({ cookies: [], origins: [] }), access: async () => {},
    launch: async () => ({ newContext: async () => ({ newPage: async () => page,
      close: async () => { cleanup.push('context'); } }), close: async () => { cleanup.push('browser'); } }),
  } }) : collectOne(page, item, { timeoutMs: 45_000, ...options });
  void promise.then(() => { done = true; }); await flush();
  for (let at = 100; !done && at <= 46_000; at += 100) { t.mock.timers.tick(100); events[at]?.(page); await flush(); }
  assert.equal(done, true, 'original absolute deadline must terminate collector');
  const output = await promise;
  const result = ownedBatch ? output.items[0] : output;
  if (afterReturnMs) { t.mock.timers.tick(afterReturnMs); await flush(); }
  for (const event of ['request', 'response', 'framenavigated', 'requestfailed', 'requestfinished', 'pageerror', 'domcontentloaded', 'load'])
    assert.equal(page.listenerCount(event), 0, `cleanup ${event}`);
  for (const handle of page.handles) assert.equal(handle.disposed, true, 'every acquired document handle must be disposed');
  return { page, result, cleanup };
}

test('late safety: baseline waits full natural window then accepts observed body', async t => {
  const { page, result } = await run(t);
  assert.equal(page.gets.length, 1); assert.equal(page.gets[0].at, 25_000);
  assert.equal(result.status, 'ok'); assert.equal(result.posts.length, 1);
});

test('late safety: same-profile replacement while helper dispatches must not issue retired action', async t => {
  const { page, result } = await run(t, { beforeHelper: p => p.commit() });
  assert.equal(result.status, 'unavailable');
  assert.equal(page.gets.length, 0, 'retired document action must not move to a fresh same-URL document');
});

test('late safety: helper delayed beyond 500ms cannot issue after collector returns', async t => {
  const { page, result } = await run(t, { delayHelper: 700 }, { afterReturnMs: 1000 });
  assert.equal(result.failureDiagnostics.firstPageRequest.state, 'timeout');
  assert.equal(page.gets.length, 0, 'bounded evaluation timeout must revoke the unissued action');
});

test('late safety: cancellation after dispatch commitment rejects data and never retries', async t => {
  const controller = new AbortController();
  const { page, result } = await run(t, { beforeHelper: () => controller.abort() }, { options: { signal: controller.signal } });
  assert.equal(result.status, 'unavailable'); assert.equal(result.errorCode, 'collector_error');
  assert.deepEqual(result.posts, []); assert.equal(page.gets.length, 1); assert.equal(page.helperCalls.length, 1);
  t.diagnostic('Preserved counterexample: zero GET after post-dispatch cancellation is false (initial receipt expected 0, observed 1); the committed RPC cannot be recalled synchronously.');
});

test('late safety: cancellation before dispatch commitment stops helper', async t => {
  const controller = new AbortController();
  const { page, result } = await run(t, { beforeHandleReturn: () => controller.abort() }, { options: { signal: controller.signal } });
  assert.equal(result.status, 'unavailable'); assert.equal(page.gets.length, 0); assert.equal(page.helperCalls.length, 0);
});

test('late safety: bound natural response before dispatch commitment keeps exclusive ownership', async t => {
  const { page, result } = await run(t, { beforeHandleReturn: p => p.natural({ bodyDelay: 1000 }) });
  assert.equal(result.status, 'ok'); assert.equal(page.gets.length, 0); assert.equal(page.helperCalls.length, 0);
});

test('late safety: refusal before dispatch commitment stops helper', async t => {
  const { page, result } = await run(t, { beforeHandleReturn: p => p.natural({ status: 405 }) });
  assert.equal(result.status, 'unavailable'); assert.equal(page.gets.length, 0); assert.equal(page.helperCalls.length, 0);
  assert.deepEqual(result.failureDiagnostics.httpStatuses, [405]);
});

test('late safety: natural request and bound headers at boundary cannot be duplicated', async t => {
  const { page, result } = await run(t, {}, { events: { 24_900: p => p.natural({ bodyDelay: 1500 }) } });
  assert.equal(page.gets.length, 0); assert.equal(page.reads, 1); assert.equal(result.status, 'ok');
});

test('late safety: natural arrival after dispatch commitment permits no second helper', async t => {
  const { page, result } = await run(t, { beforeHelper: p => p.natural({ bodyDelay: 1500 }) });
  assert.equal(result.status, 'ok'); assert.equal(result.posts.length, 1); assert.equal(page.gets.length, 1); assert.equal(page.helperCalls.length, 1);
  t.diagnostic('Preserved counterexample: zero additional GET after post-dispatch natural arrival is false (initial expected 0, observed 1). No second helper dispatch or duplicate output row is allowed.');
});

test('late safety: refusal after dispatch commitment rejects later body and never retries', async t => {
  const { page, result } = await run(t, { beforeHelper: p => p.natural({ status: 405 }) });
  assert.equal(result.status, 'unavailable'); assert.deepEqual(result.failureDiagnostics.httpStatuses, [405]);
  assert.deepEqual(result.posts, []); assert.equal(page.gets.length, 1); assert.equal(page.helperCalls.length, 1); assert.equal(page.reads, 0);
  t.diagnostic('Preserved counterexample: zero GET after post-dispatch refusal is false (initial expected 0, observed 1); refusal still blocks all body acceptance and retry.');
});

test('late safety: late document-handle acquisition is disposed without helper dispatch', async t => {
  const { page, result } = await run(t, { delayHandle: 700 }, { afterReturnMs: 1000 });
  assert.equal(result.status, 'unavailable'); assert.equal(page.gets.length, 0); assert.equal(page.helperCalls.length, 0);
  assert.equal(page.handles.length, 1); assert.equal(page.handles[0].disposed, true);
});

test('late safety: forged issued metadata without events never creates success', async t => {
  const { page, result } = await run(t, { forged: { state: 'issued', status: 'ok', posts: responseBody(0).aweme_list } });
  assert.equal(result.status, 'unavailable'); assert.deepEqual(result.posts, []); assert.equal(page.reads, 0);
  assert.ok(result.failureDiagnostics.elapsedMs <= 45_000);
});

test('late safety: response event without matching request cannot create success', async t => {
  const { result, page } = await run(t, { response: { missingRequest: true } });
  assert.equal(result.status, 'unavailable'); assert.deepEqual(result.posts, []); assert.equal(page.reads, 0);
});

test('late safety: observed GET 405 is retained without retry or body acceptance', async t => {
  const { result, page } = await run(t, { response: { status: 405 } });
  assert.equal(result.status, 'unavailable'); assert.deepEqual(result.posts, []); assert.equal(page.gets.length, 1); assert.equal(page.reads, 0);
  assert.deepEqual(result.failureDiagnostics.httpStatuses, [405]);
});

test('late safety: observed numeric 2483 retains login requirement', async t => {
  const { result, page } = await run(t, { response: { code: 2483 } });
  assert.equal(result.errorCode, 'login_required'); assert.equal(result.status, 'unavailable');
  assert.equal(page.gets.length, 1); assert.deepEqual(result.posts, []);
});

test('late safety: parent remaining 35.5s caps slow body without data', async t => {
  const { result, page } = await run(t, { response: { bodyDelay: 20_000 } }, { options: { timeoutMs: 35_500 } });
  assert.equal(result.status, 'unavailable'); assert.deepEqual(result.posts, []); assert.equal(page.gets.length, 1);
  assert.equal(result.failureDiagnostics.elapsedMs, 35_500);
});

test('late safety: real batch owner keeps 6.5s reserve from 42s parent remaining', async t => {
  const { result, page, cleanup } = await run(t, { response: { bodyDelay: 20_000 } }, { ownedBatch: true });
  assert.equal(result.status, 'unavailable'); assert.deepEqual(result.posts, []); assert.equal(page.gets.length, 1);
  assert.equal(result.failureDiagnostics.elapsedMs, 35_500);
  assert.equal(page.closed, true); assert.deepEqual(cleanup, ['context', 'browser']);
});

test('late safety: cancellation after observed headers invalidates pending body', async t => {
  const controller = new AbortController();
  const { result, page } = await run(t, { response: { bodyDelay: 1000 } }, { options: { signal: controller.signal }, events: { 25_100: () => controller.abort() } });
  assert.equal(result.status, 'unavailable'); assert.deepEqual(result.posts, []); assert.equal(page.gets.length, 1);
});

test('late safety: helper confines origin identity, expiry, redirect and visible barriers', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  for (const address of ['http://www.douyin.com/user/' + SEC, 'https://evil.test/user/' + SEC,
    'https://www.douyin.com.evil.test/user/' + SEC, 'https://user:password@www.douyin.com/user/' + SEC,
    'https://www.douyin.com:444/user/' + SEC, profile + '/other']) {
    let gets = 0; const value = invokeHelper(requestBrowserFirstPage, { secUid: SEC, expiresAt: 10_000 }, { address, fetch: () => { gets++; } });
    assert.equal(gets, 0, address); assert.equal(value.state, 'not-eligible');
  }
  for (const overrides of [{ gate: true }, { locationChange: 'https://evil.test/' }]) {
    let gets = 0; invokeHelper(requestBrowserFirstPage, { secUid: SEC, expiresAt: 10_000 }, { ...overrides, fetch: () => { gets++; } }); assert.equal(gets, 0);
  }
  for (const expiresAt of [0, -1, 45_001, Infinity, NaN]) {
    let gets = 0; invokeHelper(requestBrowserFirstPage, { secUid: SEC, expiresAt }, { fetch: () => { gets++; } }); assert.equal(gets, 0);
  }
  let request;
  const value = invokeHelper(requestBrowserFirstPage, { secUid: SEC, expiresAt: 10_000, limit: 9999 }, { fetch: (url, init) => { request = { url, init }; return Promise.resolve({}); } });
  assert.equal(value.state, 'issued'); assert.equal(new URL(request.url, profile).searchParams.get('count'), '35');
  assert.equal(new URL(request.url, profile).searchParams.get('max_cursor'), '0');
  assert.equal(request.init.redirect, 'error'); assert.equal(request.init.credentials, 'same-origin'); assert.equal(request.init.method, 'GET');
});

test('late safety: action expiry rechecked after gate inspection preserves full fetch lifetime', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let gets = 0;
  const expired = invokeHelper(requestBrowserFirstPage, { secUid: SEC, expiresAt: 1000, actionExpiresAt: 100 },
    { duringGate: () => t.mock.timers.tick(100), fetch: () => { gets++; } });
  assert.equal(expired.state, 'not-eligible'); assert.equal(gets, 0);
  let signal;
  const issued = invokeHelper(requestBrowserFirstPage, { secUid: SEC, expiresAt: 1100, actionExpiresAt: 600 },
    { fetch: (_url, init) => { signal = init.signal; return new Promise(() => {}); } });
  assert.equal(issued.state, 'issued');
  t.mock.timers.tick(500); assert.equal(signal.aborted, false, 'action deadline must not shorten fetch response budget');
  t.mock.timers.tick(500); assert.equal(signal.aborted, true, 'original response deadline must still abort fetch');
});
