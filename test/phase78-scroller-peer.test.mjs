// Runs the actual collector and actual serialized region projection offline.
// Geometry and response events are fixtures, never live Douyin evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Default always imports the actual production owner. An explicit audit-only
// option executes the exact pre-change backup in memory, without editing it.
const collectorUrl = new URL('../scripts/douyin_browser_collector.mjs', import.meta.url);
let owner;
if (process.env.PHASE78_COLLECTOR_OWNER) {
  let source = await readFile(process.env.PHASE78_COLLECTOR_OWNER, 'utf8');
  source = source.replaceAll('import.meta.url', JSON.stringify(collectorUrl.href));
  source = source.replace(/from (["'])([^"']+)\1/g, (_, quote, specifier) =>
    `from ${JSON.stringify(specifier.startsWith('.') ? new URL(specifier, collectorUrl).href : import.meta.resolve(specifier))}`);
  owner = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
} else owner = await import(collectorUrl.href);
const { collectOne } = owner;

const SEC = 'MS4wLjABAAAAphase78OwnedScrollerOffline';
const OTHER = 'MS4wLjABBBBBphase78OtherScrollerOffline';
const UID = '123456789012345';
const profile = sec => `https://www.douyin.com/user/${sec}`;
const endpoint = (cursor, sec = SEC) => `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${sec}&max_cursor=${cursor}`;
const payload = (n, cursor = 100, more = n === 1, author = SEC) => ({ status_code: 0, has_more: more, max_cursor: cursor,
  aweme_list: [{ aweme_id: String(7234567890123456000n + BigInt(n)), author: { sec_uid: author, uid: UID },
    statistics: { digg_count: n * 10 } }] });
const rect = (left = 100, top = 100, right = 800, bottom = 600) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
const style = { display: 'block', visibility: 'visible', opacity: '1', overflowY: 'visible' };
const inside = (point, bounds) => point && point.x >= bounds.left && point.x < bounds.right && point.y >= bounds.top && point.y < bounds.bottom;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

class Page extends EventEmitter {
  constructor(options = {}) {
    super(); this.options = options; this.address = 'about:blank'; this.frame = { url: () => this.address };
    this.moves = []; this.wheels = []; this.insideWheels = 0; this.reads = 0; this.probes = 0;
    this.bounds = rect(); this.overlay = options.overlay ?? false; this.gate = options.gate ?? false; this.absent = options.absent ?? false;
    this.pane = { style: { ...style, overflowY: 'auto' }, scrollHeight: 2000, clientHeight: 500, scrollTop: 0,
      getBoundingClientRect: () => this.bounds, parentElement: null };
    this.child = { style, getBoundingClientRect: () => this.bounds };
    this.region = { style, scrollHeight: 500, clientHeight: 500, scrollTop: 0, parentElement: this.pane,
      getBoundingClientRect: () => this.bounds, contains: other => other === this.child };
    this.mouse = { move: async (x, y) => {
      this.point = { x, y }; this.moves.push(this.point);
      if (this.options.onMove) await this.options.onMove(this);
    }, wheel: async (x, y) => {
      this.wheels.push({ x, y, point: this.point ? { ...this.point } : null });
      if (!inside(this.point, this.bounds) || this.overlay || this.gate || this.absent) return;
      this.insideWheels++;
      if (this.options.onWheel) await this.options.onWheel(this);
      else this.respond(100, payload(2, 0, false));
    } };
  }
  url() { return this.address; }
  mainFrame() { return this.frame; }
  viewportSize() { return this.options.viewport ?? { width: 1280, height: 720 }; }
  request(cursor, extra = {}) { return { url: () => endpoint(cursor), frame: () => this.frame, method: () => 'GET', isNavigationRequest: () => false, ...extra }; }
  respond(cursor, body, extra = {}) {
    const request = extra.request ?? this.request(cursor); if (!extra.alreadyRequested) this.emit('request', request);
    this.emit('response', { request: () => request, url: () => extra.responseUrl ?? request.url(), status: () => extra.status ?? 200,
      json: async () => { this.reads++; return extra.json ? extra.json() : body; } });
  }
  navigate(url = profile(SEC)) {
    const request = this.request(0, { url: () => url, isNavigationRequest: () => true }); this.emit('request', request);
    this.address = url; this.emit('response', { request: () => request, url: request.url, status: () => 200 }); this.emit('framenavigated', this.frame);
  }
  async goto() { this.navigate(); this.respond(0, this.options.first ?? payload(1)); }
  async evaluate(fn, args) {
    if (fn.name === 'observeBrowserFirstScreen') return { observation: 'observed', readyState: 'interactive' };
    if (fn.name !== 'observeFirstPageActivation') return { observation: 'unavailable' };
    this.probes++;
    if (this.options.beforeProbe) await this.options.beforeProbe(this);
    const view = this.viewportSize();
    const gates = this.gate ? [{ style, getBoundingClientRect: () => rect(20, 20, 50, 50) }] : [];
    const document = { readyState: 'interactive', scrollingElement: null,
      querySelectorAll: selector => selector.includes('user-post-list') ? (this.absent ? [] : [this.region]) : gates,
      elementFromPoint: (x, y) => this.overlay ? { unrelatedOverlay: true } : inside({ x, y }, this.bounds) ? this.child : null };
    return vm.runInNewContext(`(${fn.toString()})(args)`, { args, URL, location: { href: this.address }, document,
      window: { innerWidth: view.width, innerHeight: view.height }, getComputedStyle: element => element.style ?? style });
  }
}
const collect = (page, options = {}, item = {}) => collectOne(page, { key: 'phase78-offline', secUid: SEC, limit: 30, ...item },
  { timeoutMs: 280, bodyTimeoutMs: 100, pageWaitMs: 65, failureGraceMs: 1, ...options });
function oneWindow(page, result) {
  assert.deepEqual(result.posts.map(p => p.statistics.digg_count), [10]);
  assert.equal(result.worksCoverage, 'latest-public-window'); assert.deepEqual(result.pagination.pages.map(p => p.requestCursor), [0]);
  for (const event of ['request', 'response', 'framenavigated', 'requestfailed', 'requestfinished', 'pageerror', 'domcontentloaded', 'load'])
    assert.equal(page.listenerCount(event), 0, `must detach ${event}`);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|cookie|signature=/i);
}

test('phase78 actual collector: nested owned pane receives qualified point and its strict next cursor response', async () => {
  const page = new Page(); const result = await collect(page);
  assert.equal(result.posts.length, 2, 'old viewport point960,576 misses the owned pane and yields only first page');
  assert.deepEqual(page.moves, [{ x: 450, y: 350 }]); assert.equal(page.insideWheels, 1); assert.equal(page.wheels.length, 1);
  assert.ok(page.wheels[0].y >= 200 && page.wheels[0].y <= 800); assert.equal(page.probes, 2);
  assert.deepEqual(result.pagination.pages.map(p => p.requestCursor), [0, 100]);
  assert.equal(result.posts[1].statistics.digg_count, 20); assert.equal(result.pagination.stopReason, 'end-of-list');
});
test('phase78 actual collector: viewport size change does not replace owned pane qualification', async () => {
  const page = new Page({ viewport: { width: 800, height: 625 } }); const result = await collect(page);
  assert.equal(result.posts.length, 2); assert.deepEqual(page.moves, [{ x: 450, y: 350 }]); assert.equal(page.probes, 2);
});
test('phase78 actual collector: initial overlay never receives a blind wheel', async () => {
  const page = new Page({ overlay: true }); const result = await collect(page);
  assert.equal(page.moves.length, 0); assert.equal(page.wheels.length, 0); oneWindow(page, result);
});
test('phase78 actual collector: visible access gate stops before mouse movement', async () => {
  const page = new Page({ gate: true }); const result = await collect(page);
  assert.equal(page.moves.length, 0); assert.equal(page.wheels.length, 0); oneWindow(page, result);
});
test('phase78 actual collector: absent works pane cannot grant arbitrary viewport scrolling', async () => {
  const page = new Page({ absent: true }); const result = await collect(page);
  assert.equal(page.moves.length, 0); assert.equal(page.wheels.length, 0); oneWindow(page, result);
});
test('phase78 actual collector: overlay arriving after hover is requalified before wheel', async () => {
  const page = new Page({ onMove: p => { p.overlay = true; } }); const result = await collect(page);
  assert.equal(page.moves.length, 1); assert.equal(page.wheels.length, 0);
  assert.ok(page.probes >= 2 && page.probes <= 4, 'original two bounded attempts may requalify the overlay, never scroll it'); oneWindow(page, result);
});
test('phase78 actual collector: login gate arriving after hover is not dismissed or scrolled', async () => {
  const page = new Page({ onMove: p => { p.gate = true; } }); const result = await collect(page);
  assert.equal(page.moves.length, 1); assert.equal(page.wheels.length, 0); oneWindow(page, result);
});
test('phase78 actual collector: changed qualified point during hover cannot authorize the earlier point', async () => {
  const page = new Page({ onMove: p => { p.bounds = rect(150, 100, 850, 600); } }); const result = await collect(page);
  assert.deepEqual(page.moves, [{ x: 450, y: 350 }, { x: 500, y: 350 }]);
  assert.equal(page.wheels.length, 1); assert.deepEqual(page.wheels[0].point, { x: 500, y: 350 });
  assert.equal(page.probes, 4, 'a newly stable point needs its own fresh qualification and after-move requalification');
  assert.deepEqual(result.pagination.pages.map(p => p.requestCursor), [0, 100]); assert.equal(result.posts.length, 2);
});
test('phase78 actual collector: point changing after every movement cannot issue a wheel within either bounded attempt', async () => {
  const page = new Page({ onMove: p => { p.bounds = rect(p.bounds.left + 50, 100, p.bounds.right + 50, 600); } });
  const result = await collect(page); assert.equal(page.moves.length, 2); assert.equal(page.wheels.length, 0); oneWindow(page, result);
});
test('phase78 actual collector: author navigation during movement cannot reuse previous qualification', async () => {
  const page = new Page({ onMove: p => p.navigate(profile(OTHER)) }); const result = await collect(page);
  assert.equal(page.wheels.length, 0); assert.equal(result.pagination.stopReason, 'navigation-changed'); oneWindow(page, result);
});
test('phase78 actual collector: same-author fresh main document retires current page ledger during movement', async () => {
  const page = new Page({ onMove: p => p.navigate() }); const result = await collect(page);
  assert.equal(page.wheels.length, 0); assert.equal(result.pagination.stopReason, 'navigation-changed'); oneWindow(page, result);
});
test('phase78 actual collector: pending natural next request after movement wins before its response arrives', async () => {
  let scheduled = false;
  const page = new Page({ onMove: p => {
    if (scheduled) return; scheduled = true; const request = p.request(100); p.emit('request', request);
    setTimeout(() => p.respond(100, payload(2, 0, false), { request, alreadyRequested: true }), 15);
  }, onWheel: () => {} });
  const result = await collect(page); assert.equal(page.wheels.length, 0, 'a bound natural request without body still has priority');
  assert.deepEqual(result.pagination.pages.map(p => p.requestCursor), [0, 100]); assert.equal(result.posts.length, 2);
});
test('phase78 actual collector: pending natural body during qualification prevents a redundant wheel', async () => {
  let release, started = false; const delayed = new Promise(resolve => { release = resolve; });
  const page = new Page({ beforeProbe: p => {
    if (started) return; started = true; p.respond(100, null, { json: () => delayed }); setTimeout(() => release(payload(2, 0, false)), 15);
  }, onWheel: () => {} });
  const result = await collect(page); assert.equal(page.wheels.length, 0); assert.equal(result.posts.length, 2);
  assert.deepEqual(result.pagination.pages.map(p => p.requestCursor), [0, 100]);
});
test('phase78 actual collector: a qualified wheel HTTP403 stops and cannot be washed by a subsequent 2xx body', async () => {
  const page = new Page({ viewport: { width: 800, height: 625 }, onWheel: p => { p.respond(100, null, { status: 403 }); p.respond(100, payload(2, 0, false)); } });
  const result = await collect(page); assert.equal(page.wheels.length, 1); assert.equal(page.reads, 1);
  assert.equal(result.errorCode, 'blocked'); assert.equal(result.pagination.stopReason, 'http-rejection'); oneWindow(page, result);
});
test('phase78 actual collector: wrong continuation cursor is not read or promoted after valid qualification', async () => {
  const page = new Page({ viewport: { width: 800, height: 625 }, onWheel: p => p.respond(101, payload(2, 0, false)) }); const result = await collect(page);
  assert.equal(page.reads, 1); assert.ok(result.failureDiagnostics.requests.rejected.firstCursor >= 1); oneWindow(page, result);
});
test('phase78 actual collector: timeout during qualification cannot run a late wheel or mutate saved outcome', async () => {
  let release; const delayed = new Promise(resolve => { release = resolve; });
  const page = new Page({ beforeProbe: () => delayed }); const result = await collect(page, { timeoutMs: 35, pageWaitMs: 25 });
  assert.equal(page.moves.length, 0); assert.equal(page.wheels.length, 0); oneWindow(page, result);
  const frozen = JSON.stringify(result); release(); await pause(10); assert.equal(page.wheels.length, 0); assert.equal(JSON.stringify(result), frozen);
});
test('phase78 actual collector: stalled mouse move cannot issue a late wheel after the owned action deadline', async () => {
  let release; const page = new Page();
  page.mouse.move = async (x, y) => { page.point = { x, y }; page.moves.push(page.point); await new Promise(resolve => { release = resolve; }); };
  const result = await collect(page, { timeoutMs: 80, pageWaitMs: 25 }); assert.equal(page.moves.length, 1);
  assert.equal(page.wheels.length, 0); oneWindow(page, result); const frozen = JSON.stringify(result);
  release(); await pause(10); assert.equal(page.wheels.length, 0); assert.equal(JSON.stringify(result), frozen);
});
test('phase78 actual collector: remaining per-page request window expires even when total account budget still remains', async () => {
  const page = new Page({ beforeProbe: () => pause(40) });
  const result = await collect(page, { timeoutMs: 280, pageWaitMs: 25 });
  assert.equal(page.moves.length, 0); assert.equal(page.wheels.length, 0); oneWindow(page, result);
  await pause(30); assert.equal(page.moves.length, 0); assert.equal(page.wheels.length, 0);
});
