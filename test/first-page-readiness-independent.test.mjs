import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { collectOne } from '../scripts/douyin_browser_collector.mjs';
import { sanitizeBrowserWorksDiagnostics } from '../lib/douyin-browser-diagnostics.mjs';

const SEC = 'MS4wLjABAAAAReadinessIndependent1234567';
const PROFILE = `https://www.douyin.com/user/${SEC}`;
const WORKS = `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${SEC}&max_cursor=0`;
const drain = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };
const body = () => ({ status_code: 0, has_more: false, max_cursor: 0, aweme_list: [{ aweme_id: '7300000000000000001', author: { uid: '1234567890', sec_uid: SEC }, statistics: { digg_count: 3 } }] });

class ReadinessPage extends EventEmitter {
  constructor(options = {}) {
    super(); Object.assign(this, { address: 'about:blank', moves: 0, wheels: 0, reads: 0, projections: [], activeProjections: 0, maxConcurrent: 0 }, options);
    this.frame = { url: () => this.address };
    this.mouse = { move: async () => { this.moves++; await this.onMove?.(this); }, wheel: async () => { this.wheels++; await this.onWheel?.(this); } };
  }
  url() { return this.address; }
  mainFrame() { return this.frame; }
  viewportSize() { return { width: 1280, height: 720 }; }
  request(url = WORKS, navigation = false) { return { url: () => url, method: () => 'GET', frame: () => this.frame, isNavigationRequest: () => navigation }; }
  navigate(url = PROFILE, status = 200) {
    const request = this.request(url, true); this.emit('request', request); this.address = url; this.emit('framenavigated', this.frame);
    if (status !== null) this.emit('response', { request: () => request, url: request.url, status: () => status });
    this.emit('domcontentloaded'); return request;
  }
  beginWorks() { const request = this.request(); this.emit('request', request); return request; }
  respond(value = body(), status = 200, request = this.beginWorks()) {
    this.emit('response', { request: () => request, url: request.url, status: () => status, json: async () => { this.reads++; return typeof value === 'function' ? value() : value; } });
  }
  async goto() { this.initial = this.navigate(); }
  project(fn, arg) {
    const state = this.domAt?.(Date.now()) || {};
    const rect = { left: 100, top: 100, right: 900, bottom: 600, width: 800, height: 500 };
    const region = { scrollTop: 0, scrollHeight: 1800, clientHeight: 500, parentElement: null, contains(other) { return this === other; },
      getBoundingClientRect: () => state.hidden ? { ...rect, width: 0 } : rect };
    const gate = { getBoundingClientRect: () => rect };
    const document = { readyState: 'complete', scrollingElement: region,
      querySelectorAll: selector => selector.includes('user-post-list') ? state.absent ? [] : state.ambiguous ? [region, { ...region }] : [region] : state.gate ? [gate] : [],
      elementFromPoint: () => state.occluded ? gate : region };
    for (const key of ['cookie', 'body', 'innerHTML', 'innerText']) Object.defineProperty(document, key, { get() { throw Error('No sensitive DOM reads in readiness fixture'); } });
    return runInNewContext(`(${fn.toString()})(arg)`, { URL, arg, location: new URL(this.address), document,
      window: { innerWidth: 1280, innerHeight: 720 }, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', overflowY: 'auto' }) });
  }
  async evaluate(fn, arg) {
    if (fn.name !== 'observeFirstPageActivation') return { observation: 'observed', readyState: 'complete' };
    this.projections.push(Date.now()); this.activeProjections++; this.maxConcurrent = Math.max(this.maxConcurrent, this.activeProjections);
    try { return this.onProjection ? await this.onProjection(fn, arg, this) : this.project(fn, arg); }
    finally { this.activeProjections--; }
  }
}

async function execute(t, page, { timeoutMs = 6500, atTick = () => {}, ...options } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let settled = false;
  const pending = collectOne(page, { key: 'offline-readiness', secUid: SEC, limit: 30 }, { timeoutMs, bodyTimeoutMs: 5000, failureGraceMs: 1, ...options });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await drain();
  for (let now = 20; !settled && now <= timeoutMs + 1000; now += 20) {
    atTick(now, page); t.mock.timers.tick(20); await drain();
  }
  assert.equal(settled, true, 'collector must settle within its original total deadline');
  const result = await pending;
  for (const event of ['request', 'response', 'framenavigated', 'domcontentloaded', 'pageerror', 'requestfailed']) assert.equal(page.listenerCount(event), 0);
  return result;
}
function noActions(page, result) {
  assert.equal(page.moves, 0); assert.equal(page.wheels, 0);
  assert.equal(result.status, 'unavailable'); assert.deepEqual(result.posts, []);
}

for (const missing of ['absent', 'hidden']) test(`independent readiness: ${missing} region appearing only at five seconds can yield one normal accepted works response`, async t => {
  const page = new ReadinessPage({ domAt: now => ({ [missing]: now < 5000 }), onWheel: p => p.respond() });
  const result = await execute(t, page);
  assert.equal(page.moves, 1); assert.equal(page.wheels, 1);
  assert.equal(result.status, 'ok'); assert.equal(result.worksCoverage, 'complete'); assert.equal(result.posts.length, 1);
  assert.equal(page.projections.length, 6, 'five eligibility probes and one pre-wheel reprojection');
  assert.deepEqual(page.projections, [1000, 2000, 3000, 4000, 5000, 5000]);
  assert.equal(page.maxConcurrent, 1);
});

for (const kind of ['request', 'body', 'status-null', 'status-500', 'old-200', 'cancel', 'login', 'verification', 'refusal-401', 'refusal-403', 'refusal-429']) {
  test(`independent readiness: ${kind} after initial missing region prevents later activation`, async t => {
    const abort = new AbortController(); let changed = false; let finishBody;
    const page = new ReadinessPage({ domAt: now => ({ absent: now < 1200 }) });
    const result = await execute(t, page, { signal: abort.signal, atTick: now => {
      if (now !== 1200 || changed) return; changed = true;
      if (kind === 'request') page.beginWorks();
      if (kind === 'body') page.respond(() => new Promise(resolve => { finishBody = resolve; }));
      if (kind === 'status-null') page.navigate(PROFILE, null);
      if (kind === 'status-500') page.navigate(PROFILE, 500);
      if (kind === 'old-200') { page.navigate(PROFILE, null); const request = page.initial; page.emit('response', { request: () => request, url: request.url, status: () => 200 }); }
      if (kind === 'cancel') abort.abort();
      if (kind === 'login' || kind === 'verification') { page.navigate(`https://www.douyin.com/${kind === 'login' ? 'passport/login' : 'verify/'}`); page.navigate(); }
      if (kind.startsWith('refusal-')) page.respond(null, Number(kind.split('-')[1]));
    } });
    noActions(page, result);
    assert.equal(changed, true); assert.ok(page.projections.length >= 1);
    const frozen = JSON.stringify(result); finishBody?.(body()); await drain();
    assert.equal(page.wheels, 0); assert.equal(JSON.stringify(result), frozen);
  });
}

for (const condition of ['gate', 'occluded', 'ambiguous']) test(`independent readiness: later ${condition} remains terminal even if it disappears`, async t => {
  const page = new ReadinessPage({ domAt: now => now < 1200 ? { absent: true } : now < 2400 ? { [condition]: true } : {} });
  const result = await execute(t, page);
  noActions(page, result);
  assert.ok(page.projections.length >= 2, 'must actually inspect the later terminal condition');
});

test('independent readiness: outstanding late first projection never overlaps another probe or acts after timeout', async t => {
  let finish;
  const page = new ReadinessPage({ onProjection: (fn, arg, p) => new Promise(resolve => { finish = () => resolve(p.project(fn, arg)); }) });
  const result = await execute(t, page);
  noActions(page, result); assert.equal(page.projections.length, 1); assert.equal(page.maxConcurrent, 1);
  const frozen = JSON.stringify(result); finish(); await drain();
  assert.equal(page.moves, 0); assert.equal(page.wheels, 0); assert.equal(JSON.stringify(result), frozen);
});

test('independent readiness: old-generation deferred projection cannot act or overlap a new-generation probe', async t => {
  let finish; let changed = false;
  const page = new ReadinessPage({ onProjection: (fn, arg, p) => new Promise(resolve => { finish = () => resolve(p.project(fn, arg)); }) });
  const result = await execute(t, page, { atTick: now => { if (now === 1200) { changed = true; page.navigate(); } } });
  noActions(page, result); assert.equal(changed, true); assert.equal(page.maxConcurrent, 1);
  const frozen = JSON.stringify(result); finish(); await drain();
  assert.equal(page.moves, 0); assert.equal(page.wheels, 0); assert.equal(JSON.stringify(result), frozen);
});

test('independent readiness: canceled eligible reprojection cannot wheel after the one allowed move', async t => {
  const abort = new AbortController();
  const page = new ReadinessPage({ domAt: now => ({ absent: now < 1200 }), onMove: () => abort.abort() });
  const result = await execute(t, page, { signal: abort.signal });
  assert.equal(page.moves, 1); assert.equal(page.wheels, 0); assert.equal(result.status, 'unavailable');
});

test('independent readiness: repeated missing region has a fixed small global probe cap and unchanged deadline', async t => {
  const page = new ReadinessPage({ domAt: () => ({ absent: true }) });
  const result = await execute(t, page, { timeoutMs: 10000 });
  noActions(page, result);
  assert.ok(page.projections.length > 1, 'the new contract must permit read-only rechecks');
  assert.equal(page.projections.length, 8, 'eight eligibility probes is the global cap');
  assert.deepEqual(page.projections, [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000]);
  assert.deepEqual(result.failureDiagnostics.firstPageActivation, {
    state: 'no-container', attemptCount: 1, probeCount: 8, actionCount: 0,
    structure: { reason: 'region-absent', regionCount: 0, visibleRegionCount: 0, leafRegionCount: 0, ancestorCount: null,
      controls: { version: 1, attribution: 'controls-structure-not-works-evidence', observation: 'observed',
        candidateCount: 0, labelUnavailableCount: 0, worksControlCount: 0, visibleWorksControlCount: 0,
        selectedWorksControlCount: 0, unselectedWorksControlCount: 0, unknownSelectionWorksControlCount: 0 } },
  });
  assert.equal(page.maxConcurrent, 1);
  assert.ok(result.failureDiagnostics.elapsedMs <= 10000);
});

test('independent readiness: eighth eligibility probe may act once, then the ninth projection only checks before wheel', async t => {
  const page = new ReadinessPage({ domAt: now => ({ absent: now < 8000 }), onWheel: p => p.respond() });
  const result = await execute(t, page, { timeoutMs: 10000 });
  assert.equal(page.moves, 1); assert.equal(page.wheels, 1); assert.equal(page.projections.length, 9);
  assert.equal(result.worksCoverage, 'complete'); assert.equal(page.maxConcurrent, 1);
});

test('independent readiness: region appearing after cap never grants a ninth eligibility probe', async t => {
  const page = new ReadinessPage({ domAt: now => ({ absent: now < 8100 }), onWheel: p => p.respond() });
  const result = await execute(t, page, { timeoutMs: 10000 });
  noActions(page, result); assert.equal(page.projections.length, 8);
});

for (const kind of ['request', 'status-revoked', 'cancel', 'new-generation']) test(`independent readiness: ${kind} during second eligibility projection prevents movement`, async t => {
  const abort = new AbortController();
  const page = new ReadinessPage({ domAt: now => ({ absent: now < 1200 }), onProjection: (fn, arg, p) => {
    const point = p.project(fn, arg);
    if (p.projections.length === 2) {
      if (kind === 'request') p.beginWorks();
      if (kind === 'status-revoked') p.emit('response', { request: () => p.initial, url: p.initial.url, status: () => 500 });
      if (kind === 'cancel') abort.abort();
      if (kind === 'new-generation') p.navigate();
    }
    return point;
  } });
  const result = await execute(t, page, { signal: abort.signal });
  noActions(page, result); assert.equal(page.projections.length, 2);
});

test('independent readiness: second delayed eligibility projection expires without concurrent retry or late action', async t => {
  let finish;
  const page = new ReadinessPage({ domAt: now => ({ absent: now < 1200 }), onProjection: (fn, arg, p) => p.projections.length === 1
    ? p.project(fn, arg) : new Promise(resolve => { finish = () => resolve(p.project(fn, arg)); }) });
  const result = await execute(t, page);
  noActions(page, result); assert.equal(page.projections.length, 2); assert.equal(page.maxConcurrent, 1);
  assert.equal(result.failureDiagnostics.firstPageActivation.state, 'timeout');
  const frozen = JSON.stringify(result); finish(); await drain();
  assert.equal(page.moves, 0); assert.equal(page.wheels, 0); assert.equal(JSON.stringify(result), frozen);
});

test('independent readiness: genuine verified replacement uses the remaining unspent opportunity', async t => {
  let changed = false;
  const page = new ReadinessPage({ domAt: now => ({ absent: now < 1200 }), onWheel: p => p.respond() });
  const result = await execute(t, page, { atTick: now => { if (now === 1200) { changed = true; page.navigate(); } } });
  assert.equal(changed, true); assert.equal(page.moves, 1); assert.equal(page.wheels, 1);
  assert.equal(page.reads, 1); assert.equal(page.projections.length, 3);
  assert.equal(result.status, 'ok'); assert.equal(result.worksCoverage, 'complete');
  assert.equal(result.posts.length, 1); assert.equal(result.posts[0].statistics.digg_count, 3);
  assert.equal(result.failureDiagnostics.lifecycle.generation, 2);
  assert.equal(result.failureDiagnostics.firstPageActivation.actionCount, 1);
  assert.equal(page.maxConcurrent, 1);
});

test('independent readiness: brief total deadline caps eligibility checks without extending to the full probe budget', async t => {
  const page = new ReadinessPage({ domAt: () => ({ absent: true }) });
  const result = await execute(t, page, { timeoutMs: 2500 });
  noActions(page, result); assert.deepEqual(page.projections, [1000, 2000]);
  assert.ok(result.failureDiagnostics.elapsedMs <= 2500);
});

for (const alter of ['missing-structure', 'unknown-reason', 'wrong-region-count', 'visible-count', 'ancestor-count', 'false-flag-missing']) {
  test(`independent readiness: ${alter} cannot impersonate explicit missing-region evidence for retry`, async t => {
    const page = new ReadinessPage({ domAt: now => ({ absent: now < 1200 }), onProjection: (fn, arg, p) => {
      const point = p.project(fn, arg);
      if (p.projections.length === 1) {
        if (alter === 'missing-structure') delete point.structure;
        if (alter === 'unknown-reason') point.structure.reason = 'upstream-private-string';
        if (alter === 'wrong-region-count') point.structure.regionCount = 1;
        if (alter === 'visible-count') point.structure.visibleRegionCount = 1;
        if (alter === 'ancestor-count') point.structure.ancestorCount = 0;
        if (alter === 'false-flag-missing') delete point.eligible;
      }
      return point;
    } });
    const result = await execute(t, page);
    noActions(page, result); assert.equal(page.projections.length, 1);
  });
}

test('independent readiness: added diagnostic counters are bounded, idempotent, and absent on historical envelopes', () => {
  const old = sanitizeBrowserWorksDiagnostics({ version: 1, firstPageActivation: { state: 'no-container', attemptCount: 1 } });
  assert.equal(Object.hasOwn(old.firstPageActivation, 'probeCount'), false);
  assert.equal(Object.hasOwn(old.firstPageActivation, 'actionCount'), false);
  for (const [probeCount, actionCount, expectedProbe, expectedAction] of [[0, 0, 0, 0], [9, 1, 9, 1], [10, 2, null, null],
    [-1, -1, null, null], [NaN, Infinity, null, null], ['8', '1', null, null], [0.5, true, null, null]]) {
    const output = sanitizeBrowserWorksDiagnostics({ version: 1, firstPageActivation: { state: 'no-container', attemptCount: 1, probeCount, actionCount, extra: 'PRIVATE' } });
    assert.equal(output.firstPageActivation.probeCount, expectedProbe); assert.equal(output.firstPageActivation.actionCount, expectedAction);
    assert.deepEqual(sanitizeBrowserWorksDiagnostics(output), output); assert.ok(!JSON.stringify(output).includes('PRIVATE'));
  }
});
