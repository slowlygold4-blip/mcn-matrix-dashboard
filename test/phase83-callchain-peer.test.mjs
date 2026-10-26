// Independent actual-owner call-chain tests. No platform, browser, storage,
// environment credentials, service, DB mutation or production module rewrite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { collectOne, collectBrowserWorks } from '../scripts/douyin_browser_collector.mjs';

const SEC = 'MS4wLjABAAAAphase83CallchainFixture';
const OTHER = 'MS4wLjABAAAAphase83OtherFixture';
const profile = sec => `https://www.douyin.com/user/${sec}`;
const endpoint = (sec = SEC, cursor = 0) => `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${sec}&max_cursor=${cursor}`;
const drain = async () => { for (let n = 0; n < 60; n++) await Promise.resolve(); };
const rect = { left: 100, top: 100, right: 800, bottom: 600, width: 700, height: 500 };
const style = { display: 'block', visibility: 'visible', opacity: '1', overflowY: 'visible' };

class Page extends EventEmitter {
  constructor() {
    super(); this.address = 'about:blank'; this.frame = { url: () => this.address };
    this.documentNumber = 0; this.region = false; this.gate = false;
    this.reads = 0; this.moves = 0; this.wheels = 0; this.probes = [];
    this.mouse = { move: async () => { this.moves++; }, wheel: async () => {
      this.wheels++; this.onWheel?.();
    } };
  }
  url() { return this.address; }
  mainFrame() { return this.frame; }
  request(url, navigation = false, frame = this.frame, method = 'GET') {
    return { url: () => url, isNavigationRequest: () => navigation, method: () => method, frame: () => frame,
      resourceType: () => navigation ? 'document' : 'fetch', redirectedFrom: () => null };
  }
  commit({ status = 200, sec = SEC, region = this.region } = {}) {
    this.documentNumber++; this.region = region;
    const request = this.request(profile(sec), true); this.currentDocument = request;
    this.emit('request', request); this.address = profile(sec);
    if (status !== null) this.emit('response', { request: () => request, url: request.url, status: () => status });
    this.emit('framenavigated', this.frame);
  }
  deliver({ sec = SEC, author = SEC, status = 200, cursor = 0, frame = this.frame, request: existing, bodyDelay = 0, businessCode = 0 } = {}) {
    const request = existing ?? this.request(endpoint(sec, cursor), false, frame);
    if (!existing) this.emit('request', request);
    this.emit('response', { request: () => request, url: request.url, status: () => status,
      json: async () => { this.reads++; if (bodyDelay) await new Promise(resolve => setTimeout(resolve, bodyDelay));
        return { status_code: businessCode, has_more: false, max_cursor: 0,
        aweme_list: [{ aweme_id: '7234567890123400083', author: { sec_uid: author, uid: '1234567890' }, statistics: { digg_count: 83 } }] }; } });
  }
  async goto(_url, options) {
    assert.equal(options.waitUntil, 'commit'); assert.equal(options.timeout, 20_000); this.commit();
    if (this.holdNavigation) await new Promise(resolve => { this.releaseNavigation = resolve; });
  }
  async close() {}
  async evaluate(fn, args) {
    if (fn.name === 'observeBrowserFirstScreen') return { observation: 'observed', readyState: 'interactive', bodyPresent: true };
    if (fn.name === 'readTerminalStructure') return { readyState: 'interactive', bodyPresent: true, bodyChildCount: 149, scriptCount: 214 };
    assert.equal(fn.name, 'observeFirstPageActivation');
    this.probes.push({ at: Date.now(), document: this.documentNumber });
    const pane = { scrollTop: 0, scrollHeight: 1500, clientHeight: 500, parentElement: null,
      style: { ...style, overflowY: 'auto' }, getBoundingClientRect: () => rect };
    const child = { style, getBoundingClientRect: () => rect };
    const list = { scrollHeight: 1500, clientHeight: 1500, parentElement: pane, style,
      getBoundingClientRect: () => rect, contains: node => node === child };
    const document = { readyState: 'interactive', body: { childElementCount: 149 }, scrollingElement: null,
      querySelectorAll: selector => selector.includes('user-post-list') ? (this.region ? [list] : [])
        : selector.includes('role="dialog"') ? (this.gate ? [child] : []) : [],
      createTreeWalker: () => ({ nextNode: () => null }), elementFromPoint: () => child };
    for (const field of ['cookie', 'innerHTML', 'innerText']) Object.defineProperty(document, field, {
      get() { assert.fail('private or broad page content must remain unread'); }
    });
    return vm.runInNewContext(`(${fn.toString()})(args)`, { args, URL, location: new URL(this.address), document,
      window: { innerWidth: 1280, innerHeight: 720 }, getComputedStyle: node => node.style });
  }
}

async function run(t, page, { events = {}, signal, batch = false, setupMs = 0 } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let done = false;
  const item = { key: 'phase83-offline', secUid: SEC, limit: 30 };
  let capturedLaunch, capturedContext;
  const syntheticState = Object.freeze({ cookies: Object.freeze([]), origins: Object.freeze([]) });
  const pending = batch ? collectBrowserWorks({ items: [item] }, { collectOptions: { timeoutMs: 45_000 },
    runtime: { readState: async () => syntheticState, access: async () => {},
      launch: async options => { capturedLaunch = options; if (setupMs) await new Promise(resolve => setTimeout(resolve, setupMs));
        return { newContext: async options => { capturedContext = options;
          return { newPage: async () => page, close: async () => {} }; }, close: async () => {} }; } } })
    : collectOne(page, item, { timeoutMs: 45_000, signal });
  void pending.then(() => { done = true; }); await drain();
  for (let at = 100; !done && at <= 46_000 + setupMs; at += 100) {
    t.mock.timers.tick(100); events[at]?.(page); await drain();
  }
  assert.equal(done, true, 'fixture must terminate within original account ceiling plus explicit setup');
  const out = await pending, result = batch ? out.items[0] : out;
  assert.ok(result.failureDiagnostics.elapsedMs <= 45_000);
  for (const event of ['request', 'response', 'framenavigated', 'requestfailed', 'requestfinished', 'pageerror', 'domcontentloaded', 'load'])
    assert.equal(page.listenerCount(event), 0, `${event} listener cleanup`);
  return { result, page, capturedLaunch, capturedContext, syntheticState, out };
}

test('phase83: default45 is an absolute ceiling; fast no-request document ends at the existing25 response window', async t => {
  const { result, page } = await run(t, new Page());
  assert.equal(result.status, 'unavailable'); assert.equal(result.failureDiagnostics.elapsedMs, 25_000);
  assert.equal(result.failureDiagnostics.stopReason, 'no-bound-request'); assert.equal(page.wheels, 0);
});

test('phase83: second verified document at2800 yields27800, without a parent timeout or45s consumption', async t => {
  const { result } = await run(t, new Page(), { events: { 2800: page => page.commit() } });
  assert.equal(result.failureDiagnostics.lifecycle.generation, 2);
  assert.equal(result.failureDiagnostics.elapsedMs, 27_800);
  assert.equal(result.failureDiagnostics.navigation.failed, false);
  assert.equal(result.failureDiagnostics.navigation.timedOut, false);
});

test('phase83: natural valid response within the current25 window succeeds with no region or action', async t => {
  const { result, page } = await run(t, new Page(), { events: { 24_000: page => page.deliver() } });
  assert.equal(result.status, 'ok'); assert.equal(result.posts.length, 1); assert.equal(page.reads, 1);
  assert.equal(page.moves, 0); assert.equal(page.wheels, 0);
  assert.equal(result.pagination.pages[0].requestCursor, 0);
  assert.equal(result.posts[0].statistics.digg_count, 83);
});

test('phase83: existing25 contract intentionally closes before a hypothetical35s response', async t => {
  const page = new Page(); const { result } = await run(t, page, { events: { 35_000: page => page.deliver() } });
  assert.equal(result.status, 'unavailable'); assert.equal(result.failureDiagnostics.elapsedMs, 25_000);
  assert.equal(page.reads, 0); assert.equal(result.failureDiagnostics.requests.candidate, 0);
});

test('phase83: first bound2xx at24s owns its existing body budget and may finish at27s below original45s', async t => {
  const { result, page } = await run(t, new Page(), { events: { 24_000: page => page.deliver({ bodyDelay: 3000 }) } });
  assert.equal(result.status, 'ok', 'received valid first-page headers before25s;3s body is below original25s body and45s absolute ceilings');
  assert.equal(result.posts.length, 1); assert.equal(page.reads, 1);
  assert.equal(result.failureDiagnostics.requests.matched, 1); assert.equal(result.failureDiagnostics.responses.matched, 1);
  assert.equal(result.failureDiagnostics.responses.bodyTimeouts, 0);
  assert.deepEqual(result.failureDiagnostics.httpStatuses, [200]);
  assert.ok(result.failureDiagnostics.elapsedMs >= 27_000 && result.failureDiagnostics.elapsedMs <= 27_100);
  assert.equal(page.moves, 0); assert.equal(page.wheels, 0);
});

test('phase83: first2xx arriving before goto settles keeps its pending body through navigation return', async t => {
  const page = new Page(); page.holdNavigation = true;
  const { result } = await run(t, page, { events: {
    19_000: page => page.deliver({ bodyDelay: 24_000 }), 19_500: page => page.releaseNavigation()
  } });
  assert.equal(result.status, 'ok'); assert.equal(page.reads, 1); assert.equal(result.posts.length, 1);
  assert.ok(result.failureDiagnostics.elapsedMs >= 43_000 && result.failureDiagnostics.elapsedMs <= 43_100);
  assert.equal(result.failureDiagnostics.responses.bodyTimeouts, 0);
  assert.equal(page.moves, 0); assert.equal(page.wheels, 0);
});

test('phase83: first bound2xx body cannot outlive the original45s absolute ceiling', async t => {
  const { result, page } = await run(t, new Page(), { events: { 24_000: page => page.deliver({ bodyDelay: 26_000 }) } });
  assert.equal(result.status, 'unavailable'); assert.equal(page.reads, 1); assert.deepEqual(result.posts, []);
  assert.ok(result.failureDiagnostics.elapsedMs <= 45_000);
});

test('phase83: a bound request with no response headers never extends the existing25 window', async t => {
  const { result, page } = await run(t, new Page(), { events: {
    24_000: page => page.emit('request', page.request(endpoint()))
  } });
  assert.equal(result.status, 'unavailable'); assert.equal(page.reads, 0);
  assert.equal(result.failureDiagnostics.elapsedMs, 25_000);
  assert.equal(result.failureDiagnostics.requests.matched, 1);
});

test('phase83: one accepted2xx header cannot enlarge the original25s body timeout', async t => {
  const { result, page } = await run(t, new Page(), { events: { 1000: page => page.deliver({ bodyDelay: 26_000 }) } });
  assert.equal(result.status, 'unavailable'); assert.equal(page.reads, 1); assert.deepEqual(result.posts, []);
  assert.ok(result.failureDiagnostics.elapsedMs <= 26_600, 'original25s body timer plus existing500ms failure grace');
  assert.equal(result.failureDiagnostics.responses.bodyTimeouts, 1);
});

test('phase83: delayed first body remains subject to exact author and business validation', async t => {
  const { result, page } = await run(t, new Page(), { events: { 24_000: page => page.deliver({ bodyDelay: 3000, author: OTHER }) } });
  assert.equal(result.status, 'unavailable'); assert.equal(page.reads, 1); assert.deepEqual(result.posts, []);
  assert.equal(result.errorCode, 'upstream_changed');
});

test('phase83: a delayed first2483 body is still the exact login barrier', async t => {
  const { result, page } = await run(t, new Page(), { events: { 24_000: page => page.deliver({ bodyDelay: 3000, businessCode: 2483 }) } });
  assert.equal(result.status, 'unavailable'); assert.equal(page.reads, 1); assert.deepEqual(result.posts, []);
  assert.equal(result.errorCode, 'login_required'); assert.equal(page.moves, 0); assert.equal(page.wheels, 0);
});

test('phase83: replacement during a pending first body invalidates the old result', async t => {
  const { result, page } = await run(t, new Page(), { events: {
    24_000: page => page.deliver({ bodyDelay: 3000 }), 24_500: page => page.commit()
  } });
  assert.equal(result.status, 'unavailable'); assert.equal(page.reads, 1); assert.deepEqual(result.posts, []);
  assert.equal(result.failureDiagnostics.lifecycle.generation, 2);
});

test('phase83: cancellation while the first body is pending prevents late acceptance', async t => {
  const controller = new AbortController();
  const { result, page } = await run(t, new Page(), { signal: controller.signal, events: {
    24_000: page => page.deliver({ bodyDelay: 3000 }), 24_500: () => controller.abort()
  } });
  assert.equal(result.status, 'unavailable'); assert.equal(page.reads, 1); assert.deepEqual(result.posts, []);
});

test('phase83: an unused action opportunity survives a genuine same-author document replacement', async t => {
  const page = new Page(); page.onWheel = () => page.deliver();
  const { result } = await run(t, page, { events: { 1500: page => page.commit({ region: true }) } });
  assert.equal(result.status, 'ok', 'one no-container qualification consumed no mouse action; verified new document must use remaining qualification/action budget');
  assert.equal(page.moves, 1); assert.equal(page.wheels, 1); assert.equal(page.reads, 1);
  assert.equal(result.failureDiagnostics.lifecycle.generation, 2);
  assert.ok(page.probes.length <= 9, 'at most8 qualifications plus the existing movement recheck');
});

test('phase83: a mouse action already spent before replacement cannot be renewed', async t => {
  const page = new Page(); page.region = true;
  page.onWheel = () => page.commit({ region: true });
  const { result } = await run(t, page);
  assert.equal(result.status, 'unavailable'); assert.equal(page.moves, 1); assert.equal(page.wheels, 1);
  assert.equal(page.reads, 0);
});

test('phase83: eight old-document qualifications exhaust the shared budget before replacement', async t => {
  const page = new Page(); page.onWheel = () => page.deliver();
  const { result } = await run(t, page, { events: { 9000: page => page.commit({ region: true }) } });
  assert.equal(result.status, 'unavailable'); assert.equal(page.moves, 0); assert.equal(page.wheels, 0);
  assert.equal(page.probes.length, 8); assert.ok(page.probes.every(probe => probe.document === 1));
});

for (const [name, change] of [
  ['other-author document', page => page.commit({ region: true, sec: OTHER })],
  ['HTTP403 replacement', page => page.commit({ region: true, status: 403 })],
  ['unverified replacement', page => page.commit({ region: true, status: null })],
]) test(`phase83: ${name} never inherits an unused first-page action`, async t => {
  const page = new Page(); page.onWheel = () => page.deliver();
  const { result } = await run(t, page, { events: { 1500: change } });
  assert.equal(result.status, 'unavailable'); assert.equal(page.moves, 0); assert.equal(page.wheels, 0);
});

test('phase83: same-document history cannot replenish exhausted qualifications', async t => {
  const page = new Page(); page.onWheel = () => page.deliver();
  const { result } = await run(t, page, { events: { 9000: page => {
    page.region = true; page.address = profile(SEC) + '#works'; page.emit('framenavigated', page.frame);
  } } });
  assert.equal(result.status, 'unavailable'); assert.equal(page.moves, 0); assert.equal(page.wheels, 0);
  assert.equal(page.probes.length, 8); assert.equal(result.failureDiagnostics.lifecycle.generation, 1);
});

test('phase83: a gate observed before replacement cannot be treated as a retryable no-container observation', async t => {
  const page = new Page(); page.gate = true; page.onWheel = () => page.deliver();
  const { result } = await run(t, page, { events: { 1500: page => { page.gate = false; page.commit({ region: true }); } } });
  assert.equal(result.status, 'unavailable'); assert.equal(page.moves, 0); assert.equal(page.wheels, 0);
  assert.equal(page.probes.length, 1);
});

for (const [name, deliver] of [
  ['wrong author URL', page => page.deliver({ sec: OTHER })],
  ['wrong frame', page => page.deliver({ frame: { url: () => profile(SEC) } })],
  ['nonzero first cursor', page => page.deliver({ cursor: 100 })],
  ['HTTP403', page => page.deliver({ status: 403 })],
  ['wrong body author', page => page.deliver({ author: OTHER })],
]) test(`phase83: ${name} cannot exploit the late current-document opportunity`, async t => {
  const { result, page } = await run(t, new Page(), { events: { 2800: page => page.commit(), 26_000: deliver } });
  assert.equal(result.status, 'unavailable'); assert.deepEqual(result.posts, []);
  if (name !== 'wrong body author') assert.equal(page.reads, 0);
});

test('phase83: a retired document request/body cannot cross into the current document', async t => {
  const page = new Page(); let retired;
  const { result } = await run(t, page, { events: {
    1000: page => { retired = page.request(endpoint()); page.emit('request', retired); },
    2800: page => page.commit(), 26_000: page => page.deliver({ request: retired })
  } });
  assert.equal(result.status, 'unavailable'); assert.equal(page.reads, 0); assert.deepEqual(result.posts, []);
});

test('phase83: cancellation remains a hard stop before any replacement action', async t => {
  const controller = new AbortController(); const page = new Page(); page.onWheel = () => page.deliver();
  const { result } = await run(t, page, { signal: controller.signal, events: {
    1500: page => { controller.abort(); page.commit({ region: true }); }
  } });
  assert.equal(result.status, 'unavailable'); assert.equal(page.moves, 0); assert.equal(page.wheels, 0);
});

test('phase83: actual batch forwards synthetic state before navigation and has no explicit proxy rewrite', async t => {
  const { result, capturedLaunch, capturedContext, syntheticState, out } = await run(t, new Page(), { batch: true, setupMs: 2700 });
  assert.equal(capturedContext.storageState, syntheticState);
  assert.equal(Object.hasOwn(capturedContext, 'proxy'), false);
  assert.equal(Object.hasOwn(capturedLaunch, 'proxy'), false);
  assert.equal(result.failureDiagnostics.elapsedMs, 25_000);
  assert.equal(Date.now(), 27_700, 'batch setup is separate from per-account25 response wait');
  assert.equal(out.provenance.sessionLoaded, true); assert.equal(out.provenance.authenticated, null);
  assert.equal(out.provenance.runtimeAI, false);
});

if (process.env.PHASE83_LOCAL_CHROME === '1') test('phase83: actual isolated Chrome current-document and pending-body paths', { timeout: 65_000 }, async t => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const results = [];
  try {
    for (const scenario of ['late-first-body', 'unused-action-replacement']) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      let documentRequests = 0, workRequests = 0, abortedOther = 0, jsonReads = 0;
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === 'https://www.douyin.com' && url.pathname === `/user/${SEC}` && request.isNavigationRequest()) {
          documentRequests++;
          const second = url.searchParams.get('stage') === '2';
          const post = `fetch(${JSON.stringify(endpoint())}).then(r=>r.json()).catch(()=>{});`;
          const script = scenario === 'late-first-body' ? `setTimeout(()=>{${post}},24000);`
            : second ? `document.getElementById('pane').addEventListener('scroll',()=>{if(!window.sent){window.sent=true;${post}}});`
              : `setTimeout(()=>location.replace(${JSON.stringify(profile(SEC) + '?stage=2')}),1500);`;
          const region = second ? '<div id="pane"><div data-e2e="user-post-list" id="region"></div></div>' : '<button aria-label="fixture">fixture</button>';
          await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}#pane{position:absolute;left:100px;top:100px;width:700px;height:500px;overflow:auto}#region{height:1500px;width:700px}</style></head><body>${region}<script>window.wheels=0;addEventListener('wheel',()=>window.wheels++);${script}</script></body></html>` });
          return;
        }
        if (request.url() === endpoint()) {
          workRequests++;
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status_code: 0, has_more: false, max_cursor: 0,
            aweme_list: [{ aweme_id: '7234567890123400083', author: { sec_uid: SEC, uid: '1234567890' }, statistics: { digg_count: 83 } }] }) });
          return;
        }
        abortedOther++; await route.abort('blockedbyclient');
      });
      try {
        const page = await context.newPage();
        // Real Chromium emits the strict Request/Response and supplies its JSON.
        // Only adapter read latency is controlled; this is not a streamed or
        // platform-network response, and no routes escape the local fixture.
        page.on('response', response => {
          if (response.url() !== endpoint()) return;
          const read = response.json.bind(response);
          response.json = async () => { jsonReads++; if (scenario === 'late-first-body') await new Promise(resolve => setTimeout(resolve, 3000)); return read(); };
        });
        const result = await collectOne(page, { key: 'phase83-isolated-chrome', secUid: SEC, limit: 30 }, { timeoutMs: 45_000 });
        assert.equal(result.status, 'ok'); assert.equal(result.posts.length, 1); assert.equal(result.posts[0].statistics.digg_count, 83);
        assert.equal(result.pagination.pages[0].requestCursor, 0); assert.deepEqual(result.failureDiagnostics.httpStatuses, [200]);
        assert.equal(workRequests, 1); assert.equal(jsonReads, 1); assert.equal(result.failureDiagnostics.responses.bodyTimeouts, 0);
        const visual = await page.evaluate(() => ({ wheels: window.wheels, top: document.getElementById('pane')?.scrollTop ?? null, charset: document.characterSet }));
        assert.equal(visual.charset, 'UTF-8');
        if (scenario === 'late-first-body') { assert.equal(documentRequests, 1); assert.equal(visual.wheels, 0); assert.ok(result.failureDiagnostics.elapsedMs >= 26_800); }
        else { assert.equal(documentRequests, 2); assert.equal(visual.wheels, 1); assert.ok(visual.top > 0); assert.equal(result.failureDiagnostics.lifecycle.generation, 2); }
        results.push({ scenario, documentRequests, workRequests, jsonReads, abortedOther, passed: true, platformNetworkRequests: 0,
          elapsedMs: result.failureDiagnostics.elapsedMs, generation: result.failureDiagnostics.lifecycle.generation,
          actionCount: result.failureDiagnostics.firstPageActivation.actionCount, wheelCount: visual.wheels, actualScrollTop: visual.top });
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
  t.diagnostic(JSON.stringify({ isolatedChromeScenarios: results, existingSessionUsed: false, platformRecoveryClaim: false }));
});
