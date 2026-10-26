// Strict independent ACTUAL-owner proof. All data, DOM and browser events are
// local fixtures. The actual serialized helpers execute in a fresh VM. No
// fixture creates an accepted collector result or supplies eligible geometry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

const { collectOne } = await import(process.env.PHASE87_OWNER_URL || '../scripts/douyin_browser_collector.mjs');
const SEC = 'MS4wLjABAAAAphase87IndependentCollector';
const OTHER = 'MS4wLjABAAAAphase87OtherCollectorAuthor';
const profile = sec => `https://www.douyin.com/user/${sec}`;
const endpoint = (cursor, sec = SEC) => `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${sec}&max_cursor=${cursor}`;
const drain = async () => { for (let n = 0; n < 80; n++) await Promise.resolve(); };
const payload = (cursor, more = false, author = SEC) => ({ status_code: 0,
  has_more: more, max_cursor: more ? cursor + 10 : 0,
  aweme_list: [{ aweme_id: String(7234567890123400087n + BigInt(cursor)),
    author: { sec_uid: author, uid: '1234567890' }, statistics: { digg_count: cursor + 87 } }] });

class Page extends EventEmitter {
  constructor(config = {}) {
    super(); this.config = config; this.address = 'about:blank'; this.frame = { url: () => this.address };
    this.gets = []; this.reads = 0; this.wheels = 0; this.moves = 0; this.handles = [];
    this.mouse = { move: async () => { this.moves++; }, wheel: async () => { this.wheels++; } };
  }
  url() { return this.address; }
  mainFrame() { return this.frame; }
  request(url, navigation = false, frame = this.frame, method = 'GET') {
    return { url: () => url, isNavigationRequest: () => navigation, frame: () => frame,
      method: () => method, resourceType: () => navigation ? 'document' : 'fetch', redirectedFrom: () => null };
  }
  commit(sec = SEC) {
    const request = this.request(profile(sec), true);
    this.emit('request', request); this.address = profile(sec);
    const gate = { getBoundingClientRect: () => ({ left: 1, top: 1, right: 200, bottom: 100, width: 199, height: 99 }) };
    const region = { scrollTop: 0, clientHeight: 500, scrollHeight: 3000, parentElement: null,
      contains: node => node === region,
      getBoundingClientRect: () => ({ left: 100, top: 100, right: 800, bottom: 600, width: 700, height: 500 }) };
    this.region = region;
    this.document = { readyState: 'interactive', body: { childElementCount: 150 }, scrollingElement: null,
      querySelectorAll: selector => {
        if (selector.includes('role="dialog"') && this.config.gate) return [gate];
        if (!selector.includes('user-post-list')) return [];
        if (this.config.regionMode === 'projection-error') throw new Error('fixture inaccessible region');
        return this.config.regionMode ? [region] : [];
      },
      elementFromPoint: () => region,
      createTreeWalker: () => ({ nextNode: () => null }) };
    for (const key of ['cookie', 'innerHTML', 'innerText']) Object.defineProperty(this.document, key,
      { get() { assert.fail('private broad material must not be read'); } });
    this.emit('response', { request: () => request, url: request.url, status: () => 200 });
    this.emit('framenavigated', this.frame);
  }
  async goto(_url, options) { assert.equal(options.waitUntil, 'commit'); this.commit(); }
  deliver(cursor, { status = 200, body = payload(cursor, cursor === 0), delay = 20, bodyDelay = 0,
    sec = SEC, frame = this.frame, responseCursor = cursor, headers = true, requestUrl = endpoint(cursor, sec) } = {}) {
    const request = this.request(requestUrl, false, frame); this.emit('request', request);
    if (!headers) return;
    setTimeout(() => this.emit('response', { request: () => request, url: () => responseCursor === cursor ? requestUrl : endpoint(responseCursor, sec), status: () => status,
      json: async () => { this.reads++; if (bodyDelay) await new Promise(resolve => setTimeout(resolve, bodyDelay)); return body; } }), delay);
  }
  async evaluateHandle(fn) {
    assert.match(fn.toString(), /=>\s*document$/);
    const handle = { document: this.document, disposed: false, async dispose() { this.disposed = true; } };
    this.handles.push(handle);
    if (this.config.beforeHandleReturn) await this.config.beforeHandleReturn(this);
    return handle;
  }
  async evaluate(fn, args) {
    if (fn.name === 'observeBrowserFirstScreen') return { observation: 'observed', readyState: 'interactive', bodyPresent: true, worksAnchorCount: 0 };
    if (fn.name === 'readTerminalStructure') return { readyState: 'interactive', bodyPresent: true, bodyChildCount: 150, scriptCount: 214 };
    if (args?.expectedDocument !== undefined) {
      assert.equal(args.expectedDocument.disposed, false);
      args = { ...args, expectedDocument: args.expectedDocument.document };
    }
    this.config.beforeEvaluate?.(this, fn, args);
    if (this.config.evaluateDelay && fn.name === 'requestBrowserFirstPage')
      await new Promise(resolve => setTimeout(resolve, this.config.evaluateDelay(this, args)));
    const fetch = (url, options) => {
      assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'same-origin'); assert.equal(options.redirect, 'error');
      assert.equal(Object.hasOwn(options, 'headers'), false);
      const u = new URL(url, this.address), cursor = Number(u.searchParams.get('max_cursor'));
      assert.equal(u.origin, 'https://www.douyin.com'); assert.equal(u.pathname, '/aweme/v1/web/aweme/post/');
      assert.equal(u.searchParams.get('sec_user_id'), SEC);
      assert.ok(Number.isSafeInteger(cursor) && cursor >= 0);
      assert.ok(this.gets.every(get => get.cursor !== cursor), 'one explicit request at most per cursor');
      if (cursor !== 0) assert.ok(this.reads > 0, 'no nonzero GET before verified response');
      this.gets.push({ cursor, at: Date.now() });
      const next = this.config.responses?.[cursor] ?? {};
      this.deliver(cursor, { requestUrl: u.href, ...next });
      return Promise.resolve({});
    };
    return vm.runInNewContext(`(${fn.toString()})(args)`, { args, URL, URLSearchParams, Date, AbortController,
      setTimeout, clearTimeout, location: new URL(this.address), document: this.document,
      window: { innerWidth: 1280, innerHeight: 720, fetch }, getComputedStyle: node => ({
        display: node === this.region && this.config.regionMode === 'hidden' ? 'none' : 'block',
        visibility: 'visible', opacity: '1', overflowY: 'auto' }) });
  }
}

async function run(t, config = {}, { options = {}, limit = 30, events = {} } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const page = new Page(config); let done = false;
  const pending = collectOne(page, { key: 'phase87-local-only', secUid: SEC, limit }, { timeoutMs: 45_000, ...options });
  void pending.then(() => { done = true; }); await drain();
  for (let at = 20; !done && at <= 45_020; at += 20) {
    t.mock.timers.tick(20); events[at]?.(page); await drain();
  }
  assert.equal(done, true, 'owner stops within absolute45s');
  const result = await pending; await drain();
  assert.ok(result.failureDiagnostics.elapsedMs <= (options.timeoutMs ?? 45_000));
  for (const handle of page.handles) assert.equal(handle.disposed, true);
  for (const event of ['request', 'response', 'framenavigated', 'requestfailed', 'requestfinished', 'pageerror', 'domcontentloaded', 'load'])
    assert.equal(page.listenerCount(event), 0, `${event} cleanup`);
  assert.doesNotMatch(JSON.stringify(result), /https?:|cookie|authorization|signature/i);
  return { result, page };
}

test('phase87 RED: actual owner must continue verified late GET cursor when page has no works container', async t => {
  const { result, page } = await run(t);
  assert.equal(result.status, 'ok');
  assert.equal(result.pagination.pages.length, 2, 'late first-page success must have a path to its verified next cursor');
  assert.deepEqual(result.pagination.pages.map(value => value.requestCursor), [0, 10]);
  assert.deepEqual(page.gets.map(value => value.cursor), [0, 10]);
  assert.ok(page.gets[0].at >= 25_000, 'retain full original natural opportunity');
  assert.ok(page.gets[1].at < page.gets[0].at + 3_020, 'continuation dispatch remains in existing3s page window');
  assert.equal(page.wheels, 0); assert.equal(page.moves, 0); assert.equal(page.reads, 2);
  assert.equal(result.pagination.stopReason, 'end-of-list');
});

test('phase87 RED: controlled continuation stops at the original three-page ceiling', async t => {
  const { result, page } = await run(t, { responses: {
    0: { body: payload(0, true) }, 10: { body: payload(10, true) }, 20: { body: payload(20, true) },
  } });
  assert.equal(result.pagination.pages.length, 3); assert.equal(result.pagination.stopReason, 'page-limit');
  assert.deepEqual(page.gets.map(value => value.cursor), [0, 10, 20]);
});

test('phase87 negative: first page at item limit cannot trigger another GET', async t => {
  const { result, page } = await run(t, {}, { limit: 1 });
  assert.equal(result.pagination.stopReason, 'item-limit'); assert.equal(page.gets.length, 1); assert.equal(page.reads, 1);
});

test('phase87 negative: explicit end never creates continuation', async t => {
  const { result, page } = await run(t, { responses: { 0: { body: payload(0) } } });
  assert.equal(result.pagination.stopReason, 'end-of-list'); assert.equal(page.gets.length, 1); assert.equal(page.reads, 1);
});

test('phase87 RED: a verified natural first page owns the same valid continuation cursor', async t => {
  const { result, page } = await run(t, {}, { events: { 1000: p => p.deliver(0) } });
  assert.equal(result.pagination.pages.length, 2);
  assert.deepEqual(page.gets.map(value => value.cursor), [10]);
  assert.equal(result.pagination.stopReason, 'end-of-list');
});

test('phase87 negative: initial HTTP403 and business2483 remain terminal barriers', async t => {
  for (const config of [{ status: 403 }, { body: { status_code: 2483 } }]) await t.test(JSON.stringify(config), async sub => {
    const { result, page } = await run(sub, { responses: { 0: config } });
    assert.equal(result.status, 'unavailable'); assert.equal(result.posts.length, 0); assert.equal(page.gets.length, 1);
    assert.equal(page.reads, config.status === 403 ? 0 : 1);
  });
});

test('phase87 negative: malformed cursor, unknown boundary and wrong author never authorize continuation', async t => {
  for (const body of [payload(0, true, OTHER), { ...payload(0, true), max_cursor: 0 },
    { ...payload(0, true), max_cursor: Number.MAX_SAFE_INTEGER + 1 }, { ...payload(0, true), has_more: undefined }])
    await t.test(JSON.stringify(body), async sub => {
      const { page } = await run(sub, { responses: { 0: { body } } }); assert.equal(page.gets.length, 1);
    });
});

test('phase87 negative: visible access gate creates no GET', async t => {
  const { result, page } = await run(t, { gate: true });
  assert.equal(result.status, 'unavailable'); assert.equal(page.gets.length, 0); assert.equal(page.reads, 0);
});

test('phase87 negative: cancellation at first accepted body prevents continuation', async t => {
  const controller = new AbortController();
  const { result, page } = await run(t, {}, { options: { signal: controller.signal }, events: { 25_020: () => controller.abort() } });
  assert.equal(page.gets.length, 1); assert.ok(result.posts.length <= 1);
});

test('phase87 negative: late response cannot grow the supplied35.5s absolute budget', async t => {
  const { result, page } = await run(t, { responses: { 0: { bodyDelay: 20_000 } } }, { options: { timeoutMs: 35_500 } });
  assert.equal(result.status, 'unavailable'); assert.equal(page.gets.length, 1); assert.equal(page.reads, 1);
});

test('phase87 RED: a racing verified natural first-page body owns continuation independently of helper issued metadata', async t => {
  let emitted = false;
  const { result, page } = await run(t, { responses: { 0: { headers: false } }, beforeEvaluate: (p, fn, args) => {
    if (fn.name !== 'requestBrowserFirstPage' || args.continuationCursor !== undefined || emitted) return;
    emitted = true; p.deliver(0, { delay: 0 });
  } });
  assert.equal(result.status, 'ok'); assert.equal(result.pagination.pages.length, 2);
  assert.equal(result.failureDiagnostics.firstPageRequest.state, 'issued');
  assert.deepEqual(page.gets.map(value => value.cursor), [0, 10], 'accepted source cursor is authority; helper metadata is irrelevant');
  assert.equal(page.reads, 2);
});

test('phase87 negative: natural next request during continuation handle acquisition suppresses duplicate GET', async t => {
  let emitted = false;
  const { result, page } = await run(t, { beforeHandleReturn: async p => {
    if (p.gets.length !== 1 || emitted) return;
    emitted = true; p.deliver(10);
  } });
  // Baseline has no continuation path, so a missing second handle is a strict
  // failure too. It cannot be counted as passing the duplicate-avoidance proof.
  assert.equal(emitted, true, 'candidate reaches actual continuation handle');
  assert.equal(result.pagination.pages.length, 2);
  assert.deepEqual(page.gets.map(value => value.cursor), [0]); assert.equal(page.reads, 2);
});

test('phase87 negative: queued continuation evaluation expires without issuing a late GET', async t => {
  let queued = false;
  const { result, page } = await run(t, { evaluateDelay: (p, args) => {
    if (args.continuationCursor === undefined) return 0;
    queued = true; return 600;
  } });
  assert.equal(queued, true, 'must exercise candidate queued continuation');
  assert.deepEqual(page.gets.map(value => value.cursor), [0]); assert.equal(result.posts.length, 1);
  assert.equal(result.pagination.pages.length, 1); assert.equal(page.reads, 1);
});

test('phase87 negative: continuation HTTP403 keeps first page and does not read refusal or retry', async t => {
  const { result, page } = await run(t, { responses: { 10: { status: 403 } } });
  assert.deepEqual(page.gets.map(value => value.cursor), [0, 10]);
  assert.equal(result.posts.length, 1); assert.equal(page.reads, 1);
  assert.equal(result.errorCode, 'blocked'); assert.equal(result.pagination.stopReason, 'http-rejection');
});

test('phase87 negative: continuation business2483 keeps first page and never reaches third GET', async t => {
  const { result, page } = await run(t, { responses: { 10: { body: { status_code: 2483 } } } });
  assert.deepEqual(page.gets.map(value => value.cursor), [0, 10]);
  assert.equal(result.posts.length, 1); assert.equal(page.reads, 2);
  assert.equal(result.errorCode, 'login_required'); assert.equal(result.pagination.stopReason, 'login-required');
});

test('phase87 negative: replacement document during continuation handle acquisition cannot emit GET', async t => {
  let replaced = false;
  const { result, page } = await run(t, { beforeHandleReturn: async p => {
    if (p.gets.length !== 1 || replaced) return;
    replaced = true; p.commit();
  } });
  assert.equal(replaced, true, 'candidate reaches continuation document binding');
  assert.deepEqual(page.gets.map(value => value.cursor), [0]);
  assert.equal(result.posts.length, 1); assert.equal(page.reads, 1);
  assert.equal(result.pagination.stopReason, 'navigation-changed');
});

test('phase87 negative: cancellation during continuation handle acquisition cannot emit GET', async t => {
  let cancelled = false; const controller = new AbortController();
  const { result, page } = await run(t, { beforeHandleReturn: async p => {
    if (p.gets.length !== 1 || cancelled) return;
    cancelled = true; controller.abort();
  } }, { options: { signal: controller.signal } });
  assert.equal(cancelled, true, 'candidate reaches continuation document binding');
  assert.deepEqual(page.gets.map(value => value.cursor), [0]);
  assert.equal(result.posts.length, 1); assert.equal(page.reads, 1);
  assert.equal(result.pagination.stopReason, 'cancelled');
});

test('phase87 negative: hidden or unreadable region is not positive region absence', async t => {
  for (const regionMode of ['hidden', 'projection-error']) await t.test(regionMode, async sub => {
    const { result, page } = await run(sub, { regionMode });
    assert.equal(result.posts.length, 1); assert.deepEqual(page.gets.map(value => value.cursor), [0]);
    assert.equal(result.pagination.stopReason, 'page-timeout');
  });
});

test('phase87 negative: a gate appearing after first body prevents continuation GET', async t => {
  let blocked = false;
  const { result, page } = await run(t, { beforeEvaluate: (p, fn, args) => {
    if (fn.name === 'observeFirstPageActivation' && args.trackScrollId && p.reads) { p.config.gate = true; blocked = true; }
  } });
  assert.equal(blocked, true); assert.equal(result.posts.length, 1);
  assert.deepEqual(page.gets.map(value => value.cursor), [0]);
});

test('phase87 candidate RED: a rejected next-page candidate during handle acquisition cannot authorize an extra GET', async t => {
  let emitted = false;
  const { result, page } = await run(t, { beforeHandleReturn: async p => {
    if (p.gets.length !== 1 || emitted) return;
    emitted = true; p.deliver(10, { frame: { url: () => profile(SEC) }, headers: false });
  } });
  assert.equal(emitted, true, 'actual continuation handle path must be exercised');
  assert.equal(result.failureDiagnostics.requests.rejected.nonMainFrame, 1);
  assert.deepEqual(page.gets.map(value => value.cursor), [0], 'an unbound candidate is not proof of absent natural next request');
  assert.equal(result.posts.length, 1); assert.equal(page.reads, 1);
});

// Native browser proof is explicitly enabled by the independent verification
// command. Ordinary full-suite runs register only deterministic local tests.
if (process.env.PHASE87_CHROME_PROOF === '1') test('phase87 actual isolated Chrome: two pages, three-page cap and refusal', async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const startedAt = Date.now();
  try {
    await Promise.all(['two-pages', 'three-page-cap', 'continuation403'].map(async kind => {
      const context = await browser.newContext({ serviceWorkers: 'block', locale: 'zh-CN' });
      const traffic = { documents: 0, cursors: [], external: 0 };
      try {
        await context.route('**/*', async route => {
          const request = route.request(), url = new URL(request.url());
          if (request.isNavigationRequest() && url.href === profile(SEC)) {
            traffic.documents++; return route.fulfill({ status: 200, contentType: 'text/html',
              body: '<!doctype html><html><head><title>Local Phase87</title></head><body><main>Local fixture</main></body></html>' });
          }
          if (url.origin === 'https://www.douyin.com' && url.pathname === '/aweme/v1/web/aweme/post/') {
            const cursor = Number(url.searchParams.get('max_cursor'));
            assert.equal(url.searchParams.get('sec_user_id'), SEC); traffic.cursors.push(cursor);
            const refuse = kind === 'continuation403' && cursor === 10;
            return route.fulfill({ status: refuse ? 403 : 200, contentType: 'application/json',
              body: JSON.stringify(refuse ? { status_code: 1 } : payload(cursor, kind === 'three-page-cap' || cursor === 0)) });
          }
          traffic.external++; return route.abort();
        });
        const page = await context.newPage();
        const result = await collectOne(page, { key: `phase87-native-${kind}`, secUid: SEC, limit: 30 });
        const summary = { kind, elapsedMs: result.failureDiagnostics.elapsedMs, pageCount: result.pagination.pages.length,
          explicitRequests: traffic.cursors.length, stopReason: result.pagination.stopReason, documentCount: traffic.documents,
          allPlatformTrafficLocallyFulfilled: true, externalRequestsAborted: traffic.external };
        console.log(JSON.stringify(summary));
        assert.equal(traffic.documents, 1); assert.equal(traffic.external, 0);
        assert.deepEqual(traffic.cursors, kind === 'three-page-cap' ? [0, 10, 20] : [0, 10]);
        assert.equal(result.pagination.pages.length, kind === 'three-page-cap' ? 3 : kind === 'two-pages' ? 2 : 1);
        assert.equal(result.pagination.stopReason, kind === 'three-page-cap' ? 'page-limit' : kind === 'two-pages' ? 'end-of-list' : 'http-rejection');
        assert.equal(result.errorCode, kind === 'continuation403' ? 'blocked' : undefined);
        assert.ok(result.failureDiagnostics.elapsedMs <= 45_000);
      } finally { await context.close(); }
    }));
  } finally { await browser.close(); }
  assert.ok(Date.now() - startedAt < 60_000);
});
