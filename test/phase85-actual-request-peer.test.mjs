// Independent actual-owner timing proof. Synthetic DOM/network only; no state,
// database, platform requests, production writes, signature or challenge work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
// The optional URL is a peer-test-only selector for Root's actual staged owner.
// Ordinary production input and runtime do not read it.
const { collectOne, collectBrowserWorks } = await import(process.env.PHASE85_OWNER_URL || '../scripts/douyin_browser_collector.mjs');
import { createCdpObservation } from '../lib/browser-cdp-observation.mjs';

const SEC = 'MS4wLjABAAAAphase85ActualRequestFixture';
const OTHER = 'MS4wLjABAAAAphase85OtherRequestFixture';
const profile = sec => `https://www.douyin.com/user/${sec}`;
const endpoint = (sec = SEC, cursor = 0) => `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${sec}&max_cursor=${cursor}`;
const drain = async () => { for (let n = 0; n < 80; n++) await Promise.resolve(); };
const rect = { left: 10, top: 10, right: 200, bottom: 150, width: 190, height: 140 };
const body = (author = SEC, code = 0) => ({ status_code: code, has_more: false, max_cursor: 0,
  aweme_list: [{ aweme_id: '7234567890123400085', author: { sec_uid: author, uid: '1234567890' }, statistics: { digg_count: 85 } }] });

class Page extends EventEmitter {
  constructor(config = {}) {
    super(); this.config = config; this.address = 'about:blank';
    this.frame = { url: () => this.address }; this.documentNumber = 0;
    this.gets = []; this.reads = 0; this.moves = 0; this.wheels = 0; this.handles = [];
    this.mouse = { move: async () => { this.moves++; }, wheel: async () => { this.wheels++; } };
  }
  url() { return this.address; }
  mainFrame() { return this.frame; }
  request(url, navigation = false, frame = this.frame, method = 'GET') {
    return { url: () => url, isNavigationRequest: () => navigation, frame: () => frame, method: () => method,
      resourceType: () => navigation ? 'document' : 'fetch', redirectedFrom: () => null };
  }
  commit({ sec = SEC, status = 200 } = {}) {
    this.documentNumber++;
    const request = this.request(profile(sec), true);
    this.emit('request', request); this.address = profile(sec); this.document = this.makeDocument();
    if (status !== null) this.emit('response', { request: () => request, url: request.url, status: () => status });
    this.emit('framenavigated', this.frame);
  }
  deliver({ sec = SEC, cursor = 0, status = 200, author = SEC, code = 0, frame = this.frame,
    headersDelay = 0, bodyDelay = 0, headers = true } = {}) {
    const request = this.request(endpoint(sec, cursor), false, frame);
    this.emit('request', request);
    if (!headers) return;
    setTimeout(() => this.emit('response', { request: () => request, url: request.url, status: () => status,
      json: async () => { this.reads++; if (bodyDelay) await new Promise(resolve => setTimeout(resolve, bodyDelay));
        return body(author, code); } }), headersDelay);
  }
  async goto(_url, options) {
    assert.equal(options.waitUntil, 'commit'); this.commit({ status: this.config.documentStatus ?? 200 });
  }
  async close() {}
  makeDocument() {
    const gate = { getBoundingClientRect: () => rect };
    const document = { readyState: 'interactive', body: { childElementCount: 149 }, scrollingElement: null,
      querySelectorAll: selector => selector.includes('role="dialog"') && this.config.gate ? [gate] : [],
      createTreeWalker: () => ({ nextNode: () => null }) };
    for (const field of ['cookie', 'innerHTML', 'innerText']) Object.defineProperty(document, field, {
      get() { assert.fail('private or broad page material must remain unread'); }
    });
    return document;
  }
  async evaluateHandle(fn) {
    assert.match(fn.toString(), /=>\s*document$/);
    const handle = { document: this.document, disposed: false,
      async dispose() { this.disposed = true; } };
    this.handles.push(handle);
    if (this.config.handleDelay) await new Promise(resolve => setTimeout(resolve, this.config.handleDelay));
    this.config.afterHandle?.(this);
    return handle;
  }
  async evaluate(fn, args) {
    if (fn.name === 'observeBrowserFirstScreen') return { observation: 'observed', readyState: 'interactive', bodyPresent: true };
    if (fn.name === 'readTerminalStructure') return { readyState: 'interactive', bodyPresent: true, bodyChildCount: 149, scriptCount: 214 };
    assert.ok(['observeFirstPageActivation', 'requestBrowserFirstPage'].includes(fn.name), fn.name);
    if (fn.name === 'requestBrowserFirstPage') this.config.beforeHelper?.(this);
    const document = this.document;
    if (args?.expectedDocument !== undefined) {
      assert.equal(args.expectedDocument.disposed, false, 'only a live private handle may serialize');
      args = { ...args, expectedDocument: args.expectedDocument.document };
    }
    const fetch = (url, options) => {
      assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'same-origin'); assert.equal(options.redirect, 'error');
      assert.equal(Object.hasOwn(options, 'headers'), false);
      const u = new URL(url, this.address);
      assert.equal(u.origin, 'https://www.douyin.com'); assert.equal(u.pathname, '/aweme/v1/web/aweme/post/');
      assert.equal(u.searchParams.get('sec_user_id'), SEC); assert.equal(u.searchParams.get('max_cursor'), '0');
      this.gets.push({ at: Date.now(), document: this.documentNumber });
      this.deliver({ headersDelay: 100, ...this.config.fallback });
      return Promise.resolve({});
    };
    return vm.runInNewContext(`(${fn.toString()})(args)`, { args, URL, URLSearchParams, Date, AbortController,
      setTimeout, clearTimeout, location: new URL(this.address), document,
      window: { innerWidth: 1280, innerHeight: 720, fetch }, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) });
  }
}

async function run(t, page, { events = {}, options = {}, batch = false } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let done = false;
  const item = { key: 'phase85-isolated', secUid: SEC, limit: 30 };
  const pending = batch ? collectBrowserWorks({ items: [{ ...item, enableUnverifiedFirstPageRequest: true }], enableUnverifiedFirstPageRequest: true,
    collectOptions: { enableUnverifiedFirstPageRequest: true } }, { collectOptions: { ...options },
    runtime: { readState: async () => ({ cookies: [], origins: [] }), access: async () => {},
      launch: async () => ({ newContext: async () => ({ newPage: async () => page, close: async () => {} }), close: async () => {} }) } })
    : collectOne(page, item, { timeoutMs: 45_000, ...options });
  void pending.then(() => { done = true; }); await drain();
  for (let at = 100; !done && at <= 46_000; at += 100) {
    t.mock.timers.tick(100); events[at]?.(page); await drain();
  }
  assert.equal(done, true, 'actual collector must stop within original45s');
  const output = await pending, result = batch ? output.items[0] : output;
  await drain();
  assert.ok(result.failureDiagnostics.elapsedMs <= 45_000);
  for (const handle of page.handles) assert.equal(handle.disposed, true, 'acquired private document handle must be disposed');
  for (const event of ['request', 'response', 'framenavigated', 'requestfailed', 'requestfinished', 'pageerror', 'domcontentloaded', 'load'])
    assert.equal(page.listenerCount(event), 0, `${event} listener cleanup`);
  return { result, page };
}

test('phase85: default late first0 GET begins only after the full25s natural opportunity', async t => {
  const { result, page } = await run(t, new Page());
  assert.equal(result.status, 'ok'); assert.equal(result.posts.length, 1);
  assert.equal(page.gets.length, 1); assert.ok(page.gets[0].at >= 25_000 && page.gets[0].at <= 25_100);
  assert.equal(result.failureDiagnostics.firstPageRequest.state, 'issued');
  assert.equal(result.failureDiagnostics.requests.matched, 1); assert.equal(page.reads, 1);
  assert.equal(page.moves, 0); assert.equal(page.wheels, 0);
});

test('phase85: a24s natural response succeeds without any extra GET', async t => {
  const { result, page } = await run(t, new Page(), { events: { 24_000: p => p.deliver() } });
  assert.equal(result.status, 'ok'); assert.equal(page.gets.length, 0); assert.equal(page.reads, 1);
});

test('phase85: a24s natural header with3s body remains owner and suppresses fallback', async t => {
  const { result, page } = await run(t, new Page(), { events: { 24_000: p => p.deliver({ bodyDelay: 3000 }) } });
  assert.equal(result.status, 'ok'); assert.equal(page.gets.length, 0); assert.equal(page.reads, 1);
  assert.ok(result.failureDiagnostics.elapsedMs >= 27_000);
});

test('phase85: a bare natural request gets no duplicate fallback or extra response time', async t => {
  const { result, page } = await run(t, new Page(), { events: { 24_000: p => p.deliver({ headers: false }) } });
  assert.equal(result.status, 'unavailable'); assert.equal(page.gets.length, 0);
  assert.equal(result.failureDiagnostics.elapsedMs, 25_000); assert.equal(result.failureDiagnostics.requests.matched, 1);
});

test('phase85: rejected wrong-frame candidate is not permission to issue a fresh first cursor', async t => {
  const { result, page } = await run(t, new Page(), { events: { 24_000: p => p.deliver({ frame: { url: () => profile(SEC) } }) } });
  assert.equal(result.status, 'unavailable'); assert.equal(page.gets.length, 0); assert.equal(page.reads, 0);
  assert.equal(result.failureDiagnostics.requests.rejected.nonMainFrame, 1);
});

test('phase85: real replacement document retains its complete new25s opportunity', async t => {
  const { result, page } = await run(t, new Page(), { events: { 2800: p => p.commit() } });
  assert.equal(result.status, 'ok'); assert.equal(page.gets.length, 1);
  assert.ok(page.gets[0].at >= 27_800 && page.gets[0].at <= 27_900); assert.equal(page.gets[0].document, 2);
});

test('phase85: natural403 remains a barrier and cannot trigger late fallback', async t => {
  const { result, page } = await run(t, new Page(), { events: { 24_000: p => p.deliver({ status: 403 }) } });
  assert.equal(result.status, 'unavailable'); assert.equal(result.errorCode, 'blocked'); assert.equal(page.gets.length, 0);
  assert.equal(result.failureDiagnostics.stopReason, 'http-rejection');
});

test('phase85: one late403 is terminal and never retried', async t => {
  const { result, page } = await run(t, new Page({ fallback: { status: 403 } }));
  assert.equal(result.status, 'unavailable'); assert.equal(result.errorCode, 'blocked'); assert.equal(page.gets.length, 1);
  assert.ok(page.gets[0].at >= 25_000); assert.equal(page.reads, 0); assert.deepEqual(result.failureDiagnostics.httpStatuses, [403]);
});

test('phase85: late2483 retains the original login barrier', async t => {
  const { result, page } = await run(t, new Page({ fallback: { code: 2483 } }));
  assert.equal(result.status, 'unavailable'); assert.equal(result.errorCode, 'login_required'); assert.equal(page.gets.length, 1);
  assert.equal(page.reads, 1); assert.deepEqual(result.posts, []);
});

test('phase85: a late wrong-author body remains unavailable', async t => {
  const { result, page } = await run(t, new Page({ fallback: { author: OTHER } }));
  assert.equal(result.status, 'unavailable'); assert.equal(result.errorCode, 'upstream_changed'); assert.equal(page.gets.length, 1);
  assert.equal(page.reads, 1); assert.deepEqual(result.posts, []);
});

test('phase85: late valid headers cannot take their body past the original45s ceiling', async t => {
  const { result, page } = await run(t, new Page({ fallback: { bodyDelay: 25_000 } }));
  assert.equal(result.status, 'unavailable'); assert.equal(page.gets.length, 1); assert.equal(page.reads, 1);
  assert.deepEqual(result.posts, []); assert.ok(result.failureDiagnostics.elapsedMs <= 45_000);
});

test('phase85: visible gate prevents any late GET', async t => {
  const { result, page } = await run(t, new Page({ gate: true }));
  assert.equal(result.status, 'unavailable'); assert.equal(page.gets.length, 0); assert.equal(page.reads, 0);
});

test('phase85: navigation during late helper eligibility cannot issue against another profile', async t => {
  const { result, page } = await run(t, new Page({ beforeHelper: p => p.commit({ sec: OTHER }) }));
  assert.equal(result.status, 'unavailable'); assert.equal(page.gets.length, 0); assert.equal(page.reads, 0);
});

test('phase85: an unissued gated helper plus a racing bare request cannot buy extra waiting', async t => {
  const { result, page } = await run(t, new Page({ beforeHelper: p => {
    p.config.gate = true;
    p.deliver({ headers: false });
  } }));
  assert.equal(result.status, 'unavailable'); assert.equal(page.gets.length, 0); assert.equal(page.reads, 0);
  assert.equal(result.failureDiagnostics.firstPageRequest.state, 'blocked');
  assert.equal(result.failureDiagnostics.elapsedMs, 25_000, 'an unissued helper and bare headers-free request cannot extend the original opportunity');
});

test('phase85: shortened absolute budget below25s never creates a late request', async t => {
  const { result, page } = await run(t, new Page(), { options: { timeoutMs: 20_000 } });
  assert.equal(result.status, 'unavailable'); assert.equal(page.gets.length, 0);
  assert.equal(result.failureDiagnostics.elapsedMs, 20_000);
});

test('phase85: verified replacement too late for a full new25s has no fallback budget', async t => {
  const { result, page } = await run(t, new Page(), { events: { 24_000: p => p.commit() } });
  assert.equal(result.status, 'unavailable'); assert.equal(page.gets.length, 0);
  assert.equal(result.failureDiagnostics.elapsedMs, 45_000);
});

test('phase85: a candidate from a retired document cannot authorize a new fallback', async t => {
  const { result, page } = await run(t, new Page(), { events: {
    500: p => p.deliver({ frame: { url: () => profile(SEC) } }), 2800: p => p.commit(),
  } });
  assert.equal(result.status, 'unavailable'); assert.equal(page.gets.length, 0); assert.equal(page.reads, 0);
});

test('phase85: parent-supplied35.5s account limit is never expanded by late body', async t => {
  const { result, page } = await run(t, new Page({ fallback: { bodyDelay: 20_000 } }), { options: { timeoutMs: 35_500 } });
  assert.equal(result.status, 'unavailable'); assert.equal(page.gets.length, 1); assert.equal(page.reads, 1);
  assert.ok(result.failureDiagnostics.elapsedMs <= 35_500); assert.deepEqual(result.posts, []);
});

test('phase85: abort before natural boundary does not grant fallback', async t => {
  const controller = new AbortController();
  const { result, page } = await run(t, new Page(), { options: { signal: controller.signal }, events: { 24_900: () => controller.abort() } });
  assert.equal(result.status, 'unavailable'); assert.equal(page.gets.length, 0); assert.equal(page.reads, 0);
});

test('phase85: ordinary batch input cannot enable the old early experimental branch', async t => {
  const { result, page } = await run(t, new Page(), { batch: true, events: { 24_000: p => p.deliver() } });
  assert.equal(result.status, 'ok'); assert.equal(page.gets.length, 0); assert.equal(page.reads, 1);
});

test('phase85: CDP authorPostsEndpoint zero counts failed requests, not absence of successful author traffic', () => {
  const observer = createCdpObservation({ mainFrameId: 'main', secUid: SEC });
  observer.request({ requestId: 'doc', frameId: 'main', loaderId: 'loader', type: 'Document', request: { method: 'GET', url: profile(SEC) } });
  observer.response({ requestId: 'doc', frameId: 'main', loaderId: 'loader', type: 'Document', response: { status: 200, url: profile(SEC) } });
  observer.commit({ frame: { id: 'main', loaderId: 'loader', url: profile(SEC) } });
  observer.finished({ requestId: 'doc' });
  observer.request({ requestId: 'post', frameId: 'main', loaderId: 'loader', type: 'Fetch', request: { method: 'GET', url: endpoint() } });
  observer.response({ requestId: 'post', frameId: 'main', loaderId: 'loader', type: 'Fetch', response: { status: 200, url: endpoint() } });
  observer.finished({ requestId: 'post' });
  const result = observer.snapshot();
  assert.equal(result.requested, 2); assert.equal(result.finished, 2); assert.equal(result.failed, 0);
  assert.deepEqual(result.failuresByPhase.beforeStop.authorPostsEndpoint, { 'current-document': 0, 'prior-document': 0, unbound: 0 });
  observer.close();
});

if (process.env.PHASE85_LOCAL_CHROME === '1') test('phase85: real isolated Chrome lateGET, late403 and late natural body', { timeout: 60_000 }, async t => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    const results = await Promise.all(['late-success', 'late-403', 'natural-body'].map(async scenario => {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      let documentRequests = 0, workRequests = 0, jsonReads = 0, abortedOther = 0;
      const helperAt = [];
      try {
        await context.route('**/*', async route => {
          const request = route.request(), url = new URL(request.url());
          if (url.origin === 'https://www.douyin.com' && url.pathname === `/user/${SEC}` && request.isNavigationRequest()) {
            documentRequests++;
            const script = scenario === 'natural-body' ? `setTimeout(()=>fetch(${JSON.stringify(endpoint())}).catch(()=>{}),24000);` : '';
            await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body:
              `<!doctype html><html><head><meta charset="utf-8"></head><body><button aria-label="fixture">fixture</button><script>${script}</script></body></html>` });
          } else if (url.origin === 'https://www.douyin.com' && url.pathname === '/aweme/v1/web/aweme/post/' && url.searchParams.get('sec_user_id') === SEC) {
            workRequests++;
            await route.fulfill({ status: scenario === 'late-403' ? 403 : 200, contentType: 'application/json', body: JSON.stringify(body()) });
          } else { abortedOther++; await route.abort('blockedbyclient'); }
        });
        const page = await context.newPage();
        const originalEvaluate = page.evaluate.bind(page), start = Date.now();
        page.evaluate = async (fn, arg) => {
          if (fn.name === 'requestBrowserFirstPage') helperAt.push(Date.now() - start);
          return originalEvaluate(fn, arg);
        };
        page.on('response', response => {
          if (!response.url().includes('/aweme/v1/web/aweme/post/')) return;
          const originalJson = response.json.bind(response);
          response.json = async () => { jsonReads++; if (scenario === 'natural-body') await new Promise(resolve => setTimeout(resolve, 3000)); return originalJson(); };
        });
        const result = await collectOne(page, { key: 'phase85-local-chrome', secUid: SEC, limit: 30 });
        assert.equal(documentRequests, 1); assert.equal(workRequests, 1);
        if (scenario === 'natural-body') {
          assert.equal(result.status, 'ok'); assert.equal(result.posts.length, 1); assert.equal(jsonReads, 1);
          assert.equal(helperAt.length, 0); assert.ok(result.failureDiagnostics.elapsedMs >= 26_800);
        } else {
          assert.equal(helperAt.length, 1); assert.ok(helperAt[0] >= 25_000 && helperAt[0] < 30_000);
          if (scenario === 'late-success') {
            assert.equal(result.status, 'ok'); assert.equal(result.posts.length, 1); assert.equal(jsonReads, 1);
          } else {
            assert.equal(result.status, 'unavailable'); assert.equal(result.errorCode, 'blocked'); assert.equal(jsonReads, 0);
            assert.deepEqual(result.failureDiagnostics.httpStatuses, [403]);
          }
        }
        return { scenario, passed: true, documentRequests, workRequests, jsonReads, helperAt, abortedOther,
          elapsedMs: result.failureDiagnostics.elapsedMs, platformRequests: 0, userStateUsed: false };
      } finally { await context.close(); }
    }));
    t.diagnostic(JSON.stringify({ isolatedChrome: results }));
  } finally { await browser.close(); }
});
