// Actual current collector + actual serialized DOM helper. The DOM/network is
// isolated local fixture data. No browser, platform, DB, or production writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { collectOne } from '../scripts/douyin_browser_collector.mjs';

const SEC = 'MS4wLjABAAAAphase80CollectorPeerFixture';
const UID = '123456789012345';
const profile = `https://www.douyin.com/user/${SEC}`;
const endpoint = cursor => `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${SEC}&max_cursor=${cursor}`;
const rect = { left: 100, top: 100, right: 800, bottom: 600, width: 700, height: 500 };
const style = { display: 'block', visibility: 'visible', opacity: '1', overflowY: 'visible' };
const payload = (number, more) => ({ status_code: 0, has_more: more, max_cursor: more ? 100 : 0,
  aweme_list: [{ aweme_id: String(7234567890123456000n + BigInt(number)), author: { sec_uid: SEC, uid: UID },
    statistics: { digg_count: number * 10 } }] });

class PhysicalScrollPage extends EventEmitter {
  constructor({ height = 1500, blocked = false, prevented = false, status = 200, wrongCursor = false } = {}) {
    super(); this.address = 'about:blank'; this.frame = { url: () => this.address };
    this.height = height; this.blocked = blocked; this.prevented = prevented; this.status = status; this.wrongCursor = wrongCursor;
    this.probes = 0; this.wheels = []; this.bodyReads = 0; this.moves = []; this.delivered = false;
    this.pane = { parentElement: null, scrollHeight: height, clientHeight: 500, scrollTop: 0,
      getBoundingClientRect: () => rect, style: { ...style, overflowY: 'auto' } };
    this.child = { style, getBoundingClientRect: () => rect };
    this.region = { parentElement: this.pane, scrollHeight: height, clientHeight: height, scrollTop: 0,
      getBoundingClientRect: () => rect, contains: other => other === this.child, style };
    this.mouse = { move: async (x, y) => { this.moves.push({ x, y }); }, wheel: async (x, y) => {
      this.wheels.push({ x, y });
      if (!this.prevented) this.pane.scrollTop = Math.min(this.pane.scrollHeight - this.pane.clientHeight, this.pane.scrollTop + y);
      // A normal lazy list's page2 starts only when its end enters the viewport.
      if (this.pane.scrollTop + this.pane.clientHeight >= this.pane.scrollHeight && !this.delivered) {
        this.delivered = true; this.respond(this.wrongCursor ? 101 : 100, payload(2, false), this.status);
      }
    } };
  }
  url() { return this.address; }
  mainFrame() { return this.frame; }
  viewportSize() { return { width: 1280, height: 720 }; }
  request(url = endpoint(0), navigation = false) {
    return { url: () => url, isNavigationRequest: () => navigation, method: () => 'GET', frame: () => this.frame };
  }
  respond(cursor, body, status = 200) {
    const request = this.request(endpoint(cursor)); this.emit('request', request);
    this.emit('response', { request: () => request, url: request.url, status: () => status,
      json: async () => { this.bodyReads++; return body; } });
  }
  async goto() {
    const doc = this.request(profile, true); this.emit('request', doc); this.address = profile;
    this.emit('response', { request: () => doc, url: doc.url, status: () => 200 });
    this.emit('framenavigated', this.frame); this.respond(0, payload(1, true));
  }
  async evaluate(fn, args) {
    if (fn.name === 'observeBrowserFirstScreen') return { observation: 'observed', readyState: 'interactive' };
    if (fn.name !== 'observeFirstPageActivation') return { observation: 'unavailable' };
    this.probes++;
    // A single document keeps its own realm and DOM identity across probes,
    // exactly as real Chrome does. Execute the actual helper, never fake scroll.
    if (!this.projectionContext) this.projectionContext = vm.createContext({ URL,
      location: { href: this.address }, document: { readyState: 'interactive', scrollingElement: null,
        querySelectorAll: selector => selector.includes('user-post-list') ? [this.region] : [],
        elementFromPoint: () => this.blocked ? { overlay: true } : this.child },
      window: { innerWidth: 1280, innerHeight: 720 }, getComputedStyle: node => node.style });
    this.projectionContext.args = args; this.projectionContext.location.href = this.address;
    return vm.runInContext(`(${fn.toString()})(args)`, this.projectionContext);
  }
}
const collect = page => collectOne(page, { key: 'phase80-offline', secUid: SEC, limit: 30 },
  { timeoutMs: 400, bodyTimeoutMs: 80, pageWaitMs: 120, failureGraceMs: 1 });
const onlyFirst = (page, result) => {
  assert.deepEqual(result.posts.map(row => row.statistics.digg_count), [10]);
  assert.equal(result.worksCoverage, 'latest-public-window');
  assert.deepEqual(result.pagination.pages.map(row => row.requestCursor), [0]);
  assert.equal(page.bodyReads, 1);
  for (const event of ['request', 'response', 'framenavigated', 'requestfailed', 'requestfinished', 'pageerror', 'domcontentloaded', 'load'])
    assert.equal(page.listenerCount(event), 0);
};

test('phase80 physical lazy-list positive control: two real qualified wheels reach the end of a short pane', async () => {
  const page = new PhysicalScrollPage(); const result = await collect(page);
  assert.deepEqual(result.posts.map(row => row.statistics.digg_count), [10, 20]);
  assert.deepEqual(result.pagination.pages.map(row => row.requestCursor), [0, 100]);
  assert.equal(result.pagination.stopReason, 'end-of-list'); assert.equal(page.pane.scrollTop, 1000);
  assert.equal(page.wheels.length, 2); assert.ok(page.probes >= 4);
});

test('phase80 gap regression: the formerly two-wheel-limited tall pane now reaches its real lazy-list trigger', async () => {
  const page = new PhysicalScrollPage({ height: 4000 }); const result = await collect(page);
  // Original owner/fixture and explicit red are preserved in the Phase80
  // evidence plus Phase81 pre-change backup. This is the same full acceptance,
  // not a skipped witness or a smaller list substituted to produce green.
  assert.deepEqual(result.posts.map(row => row.statistics.digg_count), [10, 20]);
  assert.deepEqual(result.pagination.pages.map(row => row.requestCursor), [0, 100]);
  assert.equal(result.pagination.stopReason, 'end-of-list');
  assert.equal(page.wheels.length, 7); assert.ok(page.probes >= 14);
  assert.equal(page.pane.scrollTop, 3500); assert.equal(page.pane.scrollHeight - page.pane.clientHeight - page.pane.scrollTop, 0);
  assert.equal(page.delivered, true);
});

test('phase80 negative control: wheel delivery does not itself prove physical movement or data availability', async () => {
  const page = new PhysicalScrollPage({ prevented: true }); const result = await collect(page);
  onlyFirst(page, result); assert.equal(page.wheels.length, 1); assert.equal(page.pane.scrollTop, 0);
  assert.equal(result.pagination.stopReason, 'page-timeout');
});

test('phase80 negative control: an overlay blocks the wheel despite a scrollable list', async () => {
  const page = new PhysicalScrollPage({ blocked: true }); const result = await collect(page);
  onlyFirst(page, result); assert.equal(page.wheels.length, 0); assert.equal(page.moves.length, 0);
});

test('phase80 negative control: reaching the trigger never bypasses a bound403', async () => {
  const page = new PhysicalScrollPage({ status: 403 }); const result = await collect(page);
  onlyFirst(page, result); assert.equal(result.errorCode, 'blocked'); assert.equal(result.pagination.stopReason, 'http-rejection');
});

test('phase80 negative control: physically triggered wrong cursor is not read or accepted', async () => {
  const page = new PhysicalScrollPage({ wrongCursor: true }); const result = await collect(page);
  onlyFirst(page, result); assert.ok(result.failureDiagnostics.requests.rejected.firstCursor >= 1);
});

// Explicit independent local-browser proof. Every HTTP request is intercepted;
// fresh headless context has no imported credentials and no user browser handle.
if (process.env.PHASE80_LOCAL_CHROME === '1') test('phase80 actual headless Chrome: same owned helper completes both short and formerly failing tall list', async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    for (const height of [1500, 4000]) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
      try {
        const observed = [];
        await context.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.pathname === `/user/${SEC}`) return route.fulfill({ status: 200, contentType: 'text/html', body:
            `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}#pane{position:absolute;left:100px;top:100px;width:700px;height:500px;overflow-y:auto}#region{height:${height}px;background:#fafafa}</style></head><body><div id="pane"><div id="region" data-e2e="user-post-list"></div></div><script>
            const pane=document.getElementById('pane');let next=false;
            setTimeout(()=>fetch(${JSON.stringify(endpoint(0))}),20);
            pane.addEventListener('scroll',()=>{if(!next&&pane.scrollTop+pane.clientHeight>=pane.scrollHeight-1){next=true;fetch(${JSON.stringify(endpoint(100))});}});
            </script></body></html>` });
          if (url.pathname === '/aweme/v1/web/aweme/post/') {
            const cursor = Number(url.searchParams.get('max_cursor')); observed.push(cursor);
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload(cursor === 0 ? 1 : 2, cursor === 0)) });
          }
          return route.abort('blockedbyclient');
        });
        const page = await context.newPage();
        const result = await collectOne(page, { key: 'phase80-real-local', secUid: SEC, limit: 30 },
          { timeoutMs: 4000, bodyTimeoutMs: 500, pageWaitMs: 600, failureGraceMs: 1 });
        const geometry = await page.evaluate(() => {
          const pane = document.getElementById('pane');
          return { scrollTop: pane.scrollTop, clientHeight: pane.clientHeight, scrollHeight: pane.scrollHeight };
        });
        if (height === 1500) {
          assert.equal(result.posts.length, 2); assert.deepEqual(observed, [0, 100]);
          assert.equal(result.pagination.stopReason, 'end-of-list'); assert.equal(geometry.scrollTop, 1000);
        } else {
          assert.equal(result.posts.length, 2); assert.deepEqual(observed, [0, 100]);
          assert.equal(result.pagination.stopReason, 'end-of-list'); assert.equal(geometry.scrollTop, 3500);
          assert.equal(geometry.scrollHeight - geometry.clientHeight - geometry.scrollTop, 0);
        }
        console.log(JSON.stringify({ phase80LocalChrome: true, height, observedCursors: observed,
          posts: result.posts.length, stopReason: result.pagination.stopReason, geometry, fullyRouteFulfilled: true }));
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
});
