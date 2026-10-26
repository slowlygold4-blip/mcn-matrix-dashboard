// Independent proof over the actual production owner and serialized DOM helper.
// All DOM and request/response data below are isolated synthetic fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { collectOne } from '../scripts/douyin_browser_collector.mjs';

const SEC = 'MS4wLjABAAAAphase81CollectorPeerFixture';
const OTHER = 'MS4wLjABAAAAphase81OtherCollectorFixture';
const UID = '123456789012345';
const profile = sec => `https://www.douyin.com/user/${sec}`;
const endpoint = (cursor, sec = SEC) => `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${sec}&max_cursor=${cursor}`;
const rect = { left: 100, top: 100, right: 800, bottom: 600, width: 700, height: 500 };
const style = { display: 'block', visibility: 'visible', opacity: '1', overflowY: 'visible' };
const payload = (number, more = false, cursor = more ? number * 100 : 0, author = SEC) => ({
  status_code: 0, has_more: more, max_cursor: cursor,
  aweme_list: [{ aweme_id: String(7234567890123456000n + BigInt(number)),
    author: { sec_uid: author, uid: UID }, statistics: { digg_count: number * 10 } }],
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const events = ['request', 'response', 'framenavigated', 'requestfailed', 'requestfinished', 'pageerror', 'domcontentloaded', 'load'];

class PhysicalPage extends EventEmitter {
  constructor(options = {}) {
    super(); this.options = options; this.address = 'about:blank'; this.frame = { url: () => this.address };
    this.probes = 0; this.wheels = []; this.moves = []; this.bodyReads = 0; this.requestLog = [];
    this.blocked = options.blocked ?? false; this.gate = options.gate ?? false; this.delivered = false;
    this.timers = new Set(); this.trace = []; this.child = { style, getBoundingClientRect: () => rect };
    this.pane = this.createPane(options.height ?? 4000);
    this.region = { parentElement: this.pane, scrollHeight: this.pane.scrollHeight, clientHeight: this.pane.scrollHeight,
      scrollTop: 0, getBoundingClientRect: () => rect, contains: other => other === this.child, style };
    this.document = { readyState: 'interactive', scrollingElement: null,
      querySelectorAll: selector => selector.includes('user-post-list') ? [this.region]
        : this.gate ? [{ style, getBoundingClientRect: () => rect }] : [],
      elementFromPoint: () => this.blocked ? { overlay: true } : this.child };
    // Browser globals survive evaluations within one document, like real Chrome.
    this.context = vm.createContext({ URL, location: { href: this.address }, document: this.document,
      window: { innerWidth: 1280, innerHeight: 720 }, getComputedStyle: node => node.style });
    this.mouse = { move: async (x, y) => {
      this.moves.push({ x, y, at: Date.now() }); this.trace.push('move');
      await this.options.onMove?.(this);
    }, wheel: async (x, y) => {
      const action = { x, y, before: this.pane.scrollTop, at: Date.now() };
      this.wheels.push(action); this.trace.push('wheel');
      await this.options.onWheel?.(this);
      const scroll = () => {
        if (!this.options.prevented) this.pane.scrollTop = Math.min(this.pane.scrollHeight - this.pane.clientHeight, this.pane.scrollTop + y);
        action.after = this.pane.scrollTop; this.trace.push('physical-scroll');
        this.options.afterPhysicalScroll?.(this);
        if (this.pane.scrollTop + this.pane.clientHeight >= this.pane.scrollHeight && !this.delivered) {
          this.delivered = true;
          if (this.options.onTrigger) this.options.onTrigger(this);
          else this.respond(this.options.wrongCursor ? 101 : 100, payload(2), { status: this.options.status ?? 200 });
        }
      };
      if (this.options.scrollDelayMs) this.later(scroll, this.options.scrollDelayMs); else scroll();
    } };
  }
  createPane(height, top = 0) {
    return { parentElement: null, scrollHeight: height, clientHeight: 500, scrollTop: top,
      getBoundingClientRect: () => rect, style: { ...style, overflowY: 'auto' } };
  }
  later(fn, ms) { const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, ms); this.timers.add(timer); }
  close() { for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); }
  url() { return this.address; }
  mainFrame() { return this.frame; }
  viewportSize() { return { width: 1280, height: 720 }; }
  request(cursor, extra = {}) {
    return { url: () => endpoint(cursor), isNavigationRequest: () => false, method: () => 'GET', frame: () => this.frame, ...extra };
  }
  begin(cursor, extra = {}) {
    const request = this.request(cursor, extra); this.requestLog.push({ cursor, at: Date.now() }); this.emit('request', request); return request;
  }
  respond(cursor, body, extra = {}) {
    const request = extra.request ?? this.begin(cursor, extra.requestOptions);
    this.emit('response', { request: () => request, url: () => extra.url ?? request.url(), status: () => extra.status ?? 200,
      json: async () => { this.bodyReads++; this.trace.push(`body-${cursor}`); return extra.json ? extra.json() : body; } });
  }
  navigate(sec = SEC) {
    const request = this.request(0, { url: () => profile(sec), isNavigationRequest: () => true }); this.emit('request', request);
    this.address = profile(sec); this.context.location.href = this.address;
    this.emit('response', { request: () => request, url: request.url, status: () => 200 }); this.emit('framenavigated', this.frame);
  }
  async goto() { this.navigate(); this.respond(0, payload(1, true)); }
  async evaluate(fn, args) {
    if (fn.name === 'observeBrowserFirstScreen') return { observation: 'observed', readyState: 'interactive' };
    if (fn.name !== 'observeFirstPageActivation') return { observation: 'unavailable' };
    this.probes++; await this.options.beforeProbe?.(this);
    this.context.args = args;
    return vm.runInContext(`(${fn.toString()})(args)`, this.context);
  }
}

const collect = (page, options = {}) => collectOne(page, { key: 'phase81-offline', secUid: SEC, limit: 30 },
  { timeoutMs: 1200, bodyTimeoutMs: 600, pageWaitMs: 700, failureGraceMs: 1, ...options });
const detached = page => { for (const event of events) assert.equal(page.listenerCount(event), 0, `detach ${event}`); };
const firstOnly = (page, result) => {
  assert.deepEqual(result.posts.map(row => row.statistics.digg_count), [10]);
  assert.deepEqual(result.pagination.pages.map(row => row.requestCursor), [0]);
  assert.equal(result.worksCoverage, 'latest-public-window'); detached(page);
  assert.doesNotMatch(JSON.stringify(result), /ownerId|trackScrollId|scrollTop|scrollHeight|mcn:works-scroll/);
};
const complete = (page, result) => {
  assert.deepEqual(result.posts.map(row => row.statistics.digg_count), [10, 20]);
  assert.deepEqual(result.pagination.pages.map(row => row.requestCursor), [0, 100]);
  assert.equal(result.pagination.stopReason, 'end-of-list'); assert.equal(result.worksCoverage, 'complete');
  assert.equal(page.pane.scrollTop, page.pane.scrollHeight - page.pane.clientHeight);
  assert.ok(page.wheels.length > 0 && page.wheels.length <= 8, 'finite qualified actions'); detached(page);
  assert.doesNotMatch(JSON.stringify(result), /ownerId|trackScrollId|scrollTop|scrollHeight|mcn:works-scroll/);
};

test('phase81 actual owner: 4000px tall list reaches its real end before strict second-page request', async () => {
  const page = new PhysicalPage(); const result = await collect(page); complete(page, result);
  assert.equal(page.wheels.length, 7); assert.equal(page.pane.scrollTop, 3500);
  assert.deepEqual(page.requestLog.map(row => row.cursor), [0, 100]);
  assert.ok(page.wheels.every((row, index) => index === 0 || row.before > page.wheels[index - 1].before));
});

test('phase81 actual owner: short list still completes through physical scroll', async () => {
  const page = new PhysicalPage({ height: 1500 }); const result = await collect(page); complete(page, result);
  assert.equal(page.wheels.length, 2); assert.equal(page.pane.scrollTop, 1000);
});

test('phase81 actual owner: asynchronous physical movement is observed before another wheel', async () => {
  const page = new PhysicalPage({ scrollDelayMs: 25 });
  try {
    const result = await collect(page); complete(page, result);
    assert.ok(page.wheels.every((row, index) => index === 0 || row.before > page.wheels[index - 1].before));
  } finally { page.close(); }
});

test('phase81 actual owner: a prevented wheel grants no second movement attempt', async () => {
  const page = new PhysicalPage({ prevented: true }); const result = await collect(page);
  firstOnly(page, result); assert.equal(page.wheels.length, 1); assert.equal(page.pane.scrollTop, 0);
  assert.equal(page.bodyReads, 1); assert.deepEqual(page.requestLog.map(row => row.cursor), [0]);
});

for (const gate of ['blocked', 'gate']) test(`phase81 actual owner: visible ${gate} prevents all mouse actions`, async () => {
  const page = new PhysicalPage({ [gate]: true }); const result = await collect(page);
  firstOnly(page, result); assert.equal(page.wheels.length, 0); assert.equal(page.moves.length, 0);
});

test('phase81 actual owner: overlay after the first physical movement stops further wheels', async () => {
  const page = new PhysicalPage({ afterPhysicalScroll: p => { p.blocked = true; } }); const result = await collect(page);
  firstOnly(page, result); assert.equal(page.wheels.length, 1); assert.equal(page.pane.scrollTop, 540);
});

test('phase81 actual owner: a current-cursor request suspends wheels before its delayed response', async () => {
  let began = false;
  const page = new PhysicalPage({ onWheel: p => {
    if (began) return; began = true; const request = p.begin(100);
    p.later(() => p.respond(100, payload(2), { request }), 90);
  } });
  try {
    const result = await collect(page);
    assert.equal(page.wheels.length, 1); assert.equal(result.posts.length, 2);
    assert.deepEqual(result.pagination.pages.map(row => row.requestCursor), [0, 100]); detached(page);
  } finally { page.close(); }
});

test('phase81 actual owner: pending bound body outlives page wait without any extra wheel', async () => {
  let started = false;
  const page = new PhysicalPage({ onWheel: p => {
    if (started) return; started = true;
    p.respond(100, null, { json: async () => { await pause(100); return payload(2); } });
  } });
  const result = await collect(page, { timeoutMs: 350, pageWaitMs: 45, bodyTimeoutMs: 220 });
  assert.equal(page.wheels.length, 1); assert.equal(result.posts.length, 2); assert.equal(page.bodyReads, 2); detached(page);
});

test('phase81 actual owner: a bound403 immediately stops all later action and 200 cannot wash it', async () => {
  const page = new PhysicalPage({ onWheel: p => {
    p.respond(100, null, { status: 403 }); p.respond(100, payload(2));
  } });
  const result = await collect(page); firstOnly(page, result);
  assert.equal(page.wheels.length, 1); assert.equal(page.bodyReads, 1);
  assert.equal(result.errorCode, 'blocked'); assert.equal(result.pagination.stopReason, 'http-rejection');
  const frozen = JSON.stringify(result); await pause(25); assert.equal(page.wheels.length, 1); assert.equal(JSON.stringify(result), frozen);
});

test('phase81 actual owner: wrong continuation cursor never grants a body read', async () => {
  const page = new PhysicalPage({ height: 1500, wrongCursor: true }); const result = await collect(page);
  firstOnly(page, result); assert.equal(page.bodyReads, 1); assert.ok(result.failureDiagnostics.requests.rejected.firstCursor >= 1);
});

test('phase81 actual owner: wrong response author cannot become a valid second page', async () => {
  const page = new PhysicalPage({ height: 1500, onTrigger: p => p.respond(100, payload(2, false, 0, OTHER)) });
  const result = await collect(page); firstOnly(page, result); assert.equal(result.pagination.stopReason, 'invalid-body');
});

test('phase81 actual owner: original absolute account deadline expires during progressing scrolls', async () => {
  const page = new PhysicalPage({ height: 20000 }); const started = Date.now();
  const result = await collect(page, { timeoutMs: 95, pageWaitMs: 700 });
  firstOnly(page, result); assert.equal(result.pagination.stopReason, 'deadline');
  assert.ok(page.wheels.length > 0 && page.wheels.length <= 8); assert.ok(Date.now() - started < 250);
  assert.ok(page.wheels.every(row => row.at < started + 95));
  const count = page.wheels.length; await pause(40); assert.equal(page.wheels.length, count);
});

test('phase81 actual owner: late qualification after page deadline cannot perform any action', async () => {
  let release; const delayed = new Promise(resolve => { release = resolve; });
  const page = new PhysicalPage({ beforeProbe: () => delayed });
  const result = await collect(page, { timeoutMs: 150, pageWaitMs: 35 }); firstOnly(page, result);
  assert.equal(page.moves.length, 0); assert.equal(page.wheels.length, 0);
  const frozen = JSON.stringify(result); release(); await pause(25);
  assert.equal(page.moves.length, 0); assert.equal(page.wheels.length, 0); assert.equal(JSON.stringify(result), frozen);
});

for (const sec of [SEC, OTHER]) test(`phase81 actual owner: navigation during a wheel invalidates ${sec === SEC ? 'same-author' : 'other-author'} continuation`, async () => {
  const page = new PhysicalPage({ onWheel: p => p.navigate(sec) }); const result = await collect(page);
  firstOnly(page, result); assert.equal(page.wheels.length, 1); assert.equal(result.pagination.stopReason, 'navigation-changed');
});

test('phase81 actual owner: cancellation after first movement stops further wheel actions', async () => {
  const controller = new AbortController(); const page = new PhysicalPage({ onWheel: () => controller.abort() });
  const result = await collect(page, { signal: controller.signal }); firstOnly(page, result);
  assert.equal(page.wheels.length, 1); assert.equal(result.pagination.stopReason, 'cancelled');
});

test('phase81 actual owner: same-shaped replacement scroller is not mistaken for observed progress', async () => {
  const page = new PhysicalPage({ afterPhysicalScroll: p => {
    p.pane = p.createPane(4000, p.pane.scrollTop); p.region.parentElement = p.pane;
  } });
  const result = await collect(page); firstOnly(page, result); assert.equal(page.wheels.length, 1);
});

test('phase81 actual owner: replacing the container during hover forbids the earlier point from authorizing a wheel', async () => {
  const page = new PhysicalPage({ onMove: p => {
    p.pane = p.createPane(4000, p.pane.scrollTop); p.region.parentElement = p.pane;
  } });
  const result = await collect(page); firstOnly(page, result); assert.equal(page.wheels.length, 0);
  assert.ok(page.moves.length <= 8, 'requalification remains bounded');
});

test('phase81 actual owner: real progress cannot remove the existing three-page ceiling', async () => {
  let reached = 0;
  const page = new PhysicalPage({ onTrigger: p => {
    reached++; p.pane.scrollHeight += 3500; p.delivered = false;
    p.respond(reached * 100, payload(reached + 1, true, (reached + 1) * 100));
  } });
  const result = await collect(page);
  assert.equal(result.posts.length, 3); assert.equal(result.pagination.stopReason, 'page-limit');
  assert.equal(result.worksCoverage, 'latest-public-window'); assert.equal(result.pagination.maxPages, 3);
  assert.deepEqual(page.requestLog.map(row => row.cursor), [0, 100, 200]);
  assert.deepEqual(result.pagination.pages.map(row => row.requestCursor), [0, 100, 200]);
  assert.equal(page.wheels.length, 14); detached(page);
});

test('phase81 actual owner: impossible list is bounded by the eight-action limit and original page wait', async () => {
  const page = new PhysicalPage({ height: 40000 }); const started = Date.now(); const result = await collect(page);
  firstOnly(page, result); assert.equal(page.wheels.length, 8); assert.equal(page.pane.scrollTop, 4320);
  assert.equal(result.pagination.stopReason, 'page-timeout'); assert.ok(Date.now() - started < 1000);
});

test('phase81 actual owner: late pending body cannot mutate result after the account deadline', async () => {
  let release; const delayed = new Promise(resolve => { release = resolve; });
  const page = new PhysicalPage({ onWheel: p => p.respond(100, null, { json: () => delayed }) });
  const result = await collect(page, { timeoutMs: 95, pageWaitMs: 45, bodyTimeoutMs: 600 });
  firstOnly(page, result); assert.equal(page.wheels.length, 1); assert.equal(page.bodyReads, 2);
  const frozen = JSON.stringify(result); release(payload(2)); await pause(30);
  assert.equal(page.wheels.length, 1); assert.equal(JSON.stringify(result), frozen);
});

test('phase81 actual owner: wrong request account and frame cannot promote refusal or authorize rows', async () => {
  const page = new PhysicalPage({ height: 1500, onTrigger: p => {
    p.respond(100, payload(8), { status: 403, requestOptions: { url: () => endpoint(100, OTHER) } });
    p.respond(100, payload(9), { status: 403, requestOptions: { frame: () => ({ url: () => profile(SEC) }) } });
    p.respond(101, payload(10)); p.respond(100, payload(2));
  } });
  const result = await collect(page); complete(page, result); assert.equal(page.bodyReads, 2);
  assert.equal(result.errorCode, undefined);
});

test('phase81 actual owner: malformed scroll geometry cannot authorize any wheel', async t => {
  for (const geometry of [{ scrollTop: -1 }, { scrollHeight: Infinity }, { clientHeight: NaN }]) {
    await t.test(Object.keys(geometry)[0], async () => {
      const page = new PhysicalPage(); Object.assign(page.pane, geometry);
      const result = await collect(page, { pageWaitMs: 50 }); firstOnly(page, result);
      assert.equal(page.moves.length, 0); assert.equal(page.wheels.length, 0);
    });
  }
});

test('phase81 actual owner: valid fractional physical position still permits finite progress', async () => {
  const page = new PhysicalPage({ height: 1500 }); page.pane.scrollTop = 0.75;
  const result = await collect(page); complete(page, result); assert.equal(page.wheels.length, 2);
});

// Opt-in real browser proof: every request fulfilled locally or aborted. No
// live platform requests, imported state, user browser, cookies, or proxy.
if (process.env.PHASE81_LOCAL_CHROME === '1') test('phase81 actual headless Chrome: tall, short, prevented, overlay, delayed response,403', async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    for (const scenario of ['tall', 'short', 'prevented', 'overlay', 'pending', '403']) {
      const height = scenario === 'short' ? 1500 : 4000;
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
      try {
        const observed = []; let escaped = 0;
        await context.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.pathname === `/user/${SEC}`) return route.fulfill({ status: 200, contentType: 'text/html', body:
            `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}#pane{position:absolute;left:100px;top:100px;width:700px;height:500px;overflow-y:auto}#region{height:${height}px;background:#fafafa}#overlay{position:fixed;inset:0;z-index:1000}</style></head><body><div id="pane"><div id="region" data-e2e="user-post-list"></div></div>${scenario === 'overlay' ? '<div id="overlay"></div>' : ''}<script>
            const pane=document.getElementById('pane');let next=false;window.wheelCount=0;window.scrollPositions=[];
            window.addEventListener('wheel',e=>{window.wheelCount++;${scenario === 'prevented' ? 'e.preventDefault();' : ''}},{passive:false});
            setTimeout(()=>fetch(${JSON.stringify(endpoint(0))}),20);
            pane.addEventListener('scroll',()=>{window.scrollPositions.push(pane.scrollTop);if(!next&&pane.scrollTop+pane.clientHeight>=pane.scrollHeight-1){next=true;fetch(${JSON.stringify(endpoint(100))});}});
            </script></body></html>` });
          if (url.pathname === '/aweme/v1/web/aweme/post/') {
            const cursor = Number(url.searchParams.get('max_cursor')); observed.push(cursor);
            if (scenario === 'pending' && cursor === 100) await pause(200);
            return route.fulfill({ status: scenario === '403' && cursor === 100 ? 403 : 200,
              contentType: 'application/json', body: JSON.stringify(payload(cursor === 0 ? 1 : 2, cursor === 0)) });
          }
          escaped++; return route.abort('blockedbyclient');
        });
        const page = await context.newPage();
        const result = await collectOne(page, { key: 'phase81-real-local', secUid: SEC, limit: 30 },
          { timeoutMs: 4000, bodyTimeoutMs: 900, pageWaitMs: 1200, failureGraceMs: 1 });
        const geometry = await page.evaluate(() => ({ scrollTop: pane.scrollTop, clientHeight: pane.clientHeight,
          scrollHeight: pane.scrollHeight, wheelCount: window.wheelCount, scrollPositions: window.scrollPositions }));
        console.log(JSON.stringify({ phase81LocalChrome: true, scenario, height, observedCursors: observed,
          posts: result.posts.length, stopReason: result.pagination.stopReason, geometry, fullyIntercepted: true, abortedOtherRequests: escaped }));
        if (['tall', 'short', 'pending'].includes(scenario)) {
          assert.equal(result.posts.length, 2); assert.deepEqual(observed, [0, 100]);
          assert.equal(result.pagination.stopReason, 'end-of-list'); assert.equal(geometry.scrollTop, height - 500);
          assert.ok(geometry.wheelCount <= 8 && geometry.wheelCount > 0);
        } else {
          assert.equal(result.posts.length, 1); assert.equal(result.worksCoverage, 'latest-public-window');
          if (scenario === 'prevented') { assert.equal(geometry.wheelCount, 1); assert.equal(geometry.scrollTop, 0); }
          if (scenario === 'overlay') { assert.equal(geometry.wheelCount, 0); assert.equal(geometry.scrollTop, 0); }
          if (scenario === '403') { assert.equal(result.errorCode, 'blocked'); assert.equal(result.pagination.stopReason, 'http-rejection'); }
          const wheels = geometry.wheelCount; await pause(60); assert.equal(await page.evaluate(() => window.wheelCount), wheels);
        }
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
});
