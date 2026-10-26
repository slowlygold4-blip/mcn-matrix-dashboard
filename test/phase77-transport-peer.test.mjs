// Independent offline exercise of the explicit opt-in transport experiment.
// Phase78 ordinary collection leaves it disabled; all original security/source
// assertions are retained here, not replaced with a successful mock default.
// No real browser, session, network, production DB or collector process is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { collectOne } from '../scripts/douyin_browser_collector.mjs';
import { validateWorksOnlyEvidence } from '../lib/works-only-observation.mjs';
import { requestBrowserFirstPage } from '../lib/browser-first-works-request.mjs';
import { sanitizeBrowserWorksDiagnostics } from '../lib/douyin-browser-diagnostics.mjs';

const SEC = 'MS4wLjABAAAAphase77TransportOffline12345';
const OTHER = 'MS4wLjABBBBBphase77TransportOther12345';
const UID = '123456789012345';
const PROFILE = `https://www.douyin.com/user/${SEC}`;
const ENDPOINT = 'https://www.douyin.com/aweme/v1/web/aweme/post/';
const NOW = Date.parse('2026-10-01T19:15:00.000Z');
const body = (n = 7, extra = {}) => ({ status_code: 0, has_more: false, max_cursor: 0,
  aweme_list: [{ aweme_id: '7234567890123456001', author: { sec_uid: SEC, uid: UID },
    statistics: { digg_count: n }, create_time: 1700000000, desc: 'offline public work' }], ...extra });
const drain = async () => { for (let i = 0; i < 45; i++) await Promise.resolve(); };

function browserGlobals({ url = PROFILE, ready = 'interactive', gates = [], fetch = async () => ({ status: 200 }), expiresAt = NOW + 3000 } = {}) {
  const location = { href: url, origin: new URL(url).origin, pathname: new URL(url).pathname, search: new URL(url).search, hash: new URL(url).hash };
  return { location, document: { readyState: ready, querySelectorAll: () => gates },
    window: { fetch, innerWidth: 1280, innerHeight: 720 }, fetch,
    getComputedStyle: gate => gate.style ?? { display: 'block', visibility: 'visible', opacity: '1' },
    URL, URLSearchParams, Date, Number, Promise, AbortController, setTimeout, clearTimeout,
    args: { secUid: SEC, limit: 100, expiresAt } };
}
const execute = (fn, globals) => vm.runInNewContext(`(${fn.toString()})(args)`, globals);

class Page extends EventEmitter {
  constructor(options = {}) {
    super(); this.options = options; this.address = 'about:blank'; this.frame = { url: () => this.address };
    this.fetchCalls = []; this.bodyReads = 0; this.pageBodyReads = 0; this.wheels = 0; this.moves = 0;
    this.helperCalls = 0; this.nativeCalls = 0; this.generation = 0;
    this.mouse = { move: async () => { this.moves++; }, wheel: async () => { this.wheels++; this.options.onWheel?.(this); } };
  }
  mainFrame() { return this.frame; }
  url() { return this.address; }
  viewportSize() { return { width: 1280, height: 720 }; }
  request(url, navigation = false, extra = {}) {
    const request = { url: () => url, frame: () => this.frame, method: () => 'GET', isNavigationRequest: () => navigation, ...extra };
    this.emit('request', request); return request;
  }
  respond(request, payload = body(), status = 200, responseUrl = request.url()) {
    this.emit('response', { request: () => request, url: () => responseUrl, status: () => status,
      json: async () => { this.bodyReads++; return this.options.delayedBody ? this.options.delayedBody() : payload; } });
  }
  navigate(url = PROFILE, status = 200) {
    this.generation++; const request = this.request(url, true); this.address = url;
    this.respond(request, null, status); this.emit('framenavigated', this.frame);
  }
  native(cursor = 0, payload = body(), extra = {}) {
    this.nativeCalls++; const url = `${ENDPOINT}?sec_user_id=${SEC}&max_cursor=${cursor}`;
    this.respond(this.request(url, false, extra.request), payload, extra.status ?? 200, extra.responseUrl ?? url);
  }
  async goto() { this.navigate(this.options.profile ?? PROFILE, this.options.documentStatus ?? 200); this.options.afterGoto?.(this); }
  async evaluate(fn, args) {
    if (fn.name === 'observeBrowserFirstScreen') return { observation: 'observed', readyState: this.options.ready ?? 'interactive' };
    if (fn.name === 'observeFirstPageActivation') return this.options.activation ?? { eligible: false, reason: 'no-container',
      structure: { reason: 'region-absent', regionCount: 0, visibleRegionCount: 0, leafRegionCount: 0, ancestorCount: null } };
    if (fn.name === 'observeReservedFirstScreenReadiness') return { readyState: this.options.ready ?? 'interactive' };
    if (fn.name !== 'requestBrowserFirstPage') return { observation: 'unavailable' };
    this.helperCalls++; this.options.beforeExplicit?.(this);
    if (this.options.delayExplicit) await this.options.delayExplicit;
    const fetch = async (path, init = {}) => {
      this.fetchCalls.push({ path, init });
      if (this.options.throwFetch) throw new Error('PRIVATE_FETCH_ERROR');
      const requestUrl = new URL(path, this.address).href;
      const request = this.request(requestUrl, false, this.options.requestExtra?.(this, requestUrl) ?? {});
      const payload = this.options.payload ?? body();
      this.respond(request, payload, this.options.status ?? 200, this.options.responseUrl ?? requestUrl);
      this.options.afterRequest?.(this, request);
      // This object is NOT the trusted transport body. Reading or returning it
      // must never bypass the request/response listeners and author validation.
      return { status: this.options.status ?? 200, ok: (this.options.status ?? 200) === 200,
        json: async () => { this.pageBodyReads++; return body(999); }, text: async () => { this.pageBodyReads++; return 'PRIVATE_BODY'; } };
    };
    return execute(fn, { ...browserGlobals({ url: this.address, ready: this.options.ready ?? 'interactive', gates: this.options.gates, fetch }), args });
  }
}
async function run(t, page, options = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const promise = collectOne(page, { key: 'phase77-offline', secUid: SEC, limit: 30 },
    { timeoutMs: 2500, pageWaitMs: 300, bodyTimeoutMs: 350, failureGraceMs: 1,
      enableUnverifiedFirstPageRequest: true, ...options });
  await drain();
  for (let i = 0; i < 26; i++) { t.mock.timers.tick(100); await drain(); }
  return promise;
}
function clean(page, result) {
  assert.equal(page.pageBodyReads, 0, 'browser helper must not read or return an untrusted JSON/body');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|signature=|a_bogus|cookie|headers/i);
  for (const event of ['request', 'response', 'framenavigated', 'requestfailed', 'requestfinished', 'pageerror', 'domcontentloaded', 'load'])
    assert.equal(page.listenerCount(event), 0, `must detach ${event}`);
}
function assertNoWorks(result) { assert.equal(result.worksCoverage, 'unavailable'); assert.deepEqual(result.posts, []); }

test('phase77 actual owner: a ready current 2xx document without a list container emits one bounded same-origin first GET', async t => {
  const page = new Page(); const result = await run(t, page);
  assert.equal(page.fetchCalls.length, 1, 'old wheel-only owner has no-bound-request here; helper must be genuinely connected');
  const call = page.fetchCalls[0], url = new URL(call.path, PROFILE);
  assert.equal(url.origin, 'https://www.douyin.com'); assert.equal(url.pathname, '/aweme/v1/web/aweme/post/');
  assert.deepEqual(url.searchParams.getAll('sec_user_id'), [SEC]); assert.deepEqual(url.searchParams.getAll('max_cursor'), ['0']);
  const count = Number(url.searchParams.get('count')); assert.ok(Number.isSafeInteger(count) && count > 0 && count <= 35);
  assert.equal(call.init.method ?? 'GET', 'GET'); assert.ok(!call.init.headers && !call.init.body);
  assert.equal(page.bodyReads, 1); assert.equal(result.status, 'ok'); assert.equal(result.posts[0].statistics.digg_count, 7);
  assert.equal(result.pagination.pages[0].requestCursor, 0); assert.equal(page.wheels, 0);
  assert.equal(result.failureDiagnostics.firstPageRequest.kind, 'collector-same-origin-get');
  assert.equal(result.failureDiagnostics.firstPageRequest.attemptCount, 1); clean(page, result);
});
test('phase77 actual owner: natural first response wins and never also sends an explicit request', async t => {
  const page = new Page({ afterGoto: p => p.native() }); const result = await run(t, page);
  assert.equal(page.fetchCalls.length, 0); assert.equal(result.posts[0].statistics.digg_count, 7); clean(page, result);
});
test('phase77 actual owner: an existing bound pending natural request is not duplicated', async t => {
  const page = new Page({ afterGoto: p => p.request(`${ENDPOINT}?sec_user_id=${SEC}&max_cursor=0`) });
  const result = await run(t, page); assert.equal(page.fetchCalls.length, 0); assertNoWorks(result); clean(page, result);
});
test('phase77 actual owner: successful existing lazy wheel transport wins without explicit duplication', async t => {
  const page = new Page({ activation: { eligible: true, x: 600, y: 500, deltaY: 500 }, onWheel: p => p.native() });
  const result = await run(t, page); assert.equal(page.wheels, 1); assert.equal(page.fetchCalls.length, 0);
  assert.equal(result.posts[0].statistics.digg_count, 7); clean(page, result);
});
test('phase77 actual owner: document HTTP refusal stops before any explicit first request', async t => {
  const page = new Page({ documentStatus: 403 }); const result = await run(t, page);
  assert.equal(page.fetchCalls.length, 0); assert.equal(result.errorCode, 'blocked'); assertNoWorks(result); clean(page, result);
});
test('phase77 actual owner: page-visible login/verification gate blocks the actual helper', async t => {
  const gate = { getBoundingClientRect: () => ({ left: 1, top: 1, right: 10, bottom: 10, width: 9, height: 9 }) };
  const page = new Page({ gates: [gate] }); const result = await run(t, page);
  assert.equal(page.fetchCalls.length, 0); assertNoWorks(result); clean(page, result);
});
test('phase77 actual owner: wrong current author inside evaluate cannot emit an explicit GET', async t => {
  const page = new Page({ beforeExplicit: p => { p.address = `https://www.douyin.com/user/${OTHER}`; } });
  const result = await run(t, page); assert.equal(page.fetchCalls.length, 0); assertNoWorks(result); clean(page, result);
});
test('phase77 actual owner: wrong-author payload never becomes a first-page sample', async t => {
  const payload = body(); payload.aweme_list[0].author.sec_uid = OTHER;
  const page = new Page({ payload }); const result = await run(t, page);
  assert.equal(page.fetchCalls.length, 1); assert.deepEqual(result.posts, []); assert.notEqual(result.worksCoverage, 'complete'); clean(page, result);
});
test('phase77 actual owner: child-frame response is not current-page transport proof', async t => {
  const page = new Page({ requestExtra: () => ({ frame: () => ({ url: () => PROFILE }) }) });
  const result = await run(t, page); assert.equal(page.fetchCalls.length, 1); assert.equal(page.bodyReads, 0); assertNoWorks(result); clean(page, result);
});
test('phase77 actual owner: mismatched response cursor is refused before its body', async t => {
  const page = new Page({ responseUrl: `${ENDPOINT}?sec_user_id=${SEC}&max_cursor=10` });
  const result = await run(t, page); assert.equal(page.fetchCalls.length, 1); assert.equal(page.bodyReads, 0); assertNoWorks(result); clean(page, result);
});
test('phase77 actual owner: explicit HTTP403 is not washed by a later same-looking response', async t => {
  const page = new Page({ status: 403, afterRequest: p => p.native() }); const result = await run(t, page);
  assert.equal(page.fetchCalls.length, 1); assert.equal(page.bodyReads, 0); assert.equal(result.errorCode, 'blocked'); assertNoWorks(result); clean(page, result);
});
test('phase77 actual owner: business2483 login response is not promoted or retried', async t => {
  const page = new Page({ payload: { status_code: 2483, has_more: false, max_cursor: 0, aweme_list: [] } });
  const result = await run(t, page); assert.equal(page.fetchCalls.length, 1); assert.equal(result.errorCode, 'login_required'); assertNoWorks(result); clean(page, result);
});
test('phase77 actual owner: rejected fetch promise neither invents works nor creates retry requests', async t => {
  const page = new Page({ throwFetch: true }); const result = await run(t, page);
  assert.equal(page.fetchCalls.length, 1); assert.equal(page.bodyReads, 0); assertNoWorks(result); clean(page, result);
});
test('phase77 actual owner: navigation during delayed body retires its request and cannot bind it to the new document', async t => {
  let release; const delayed = new Promise(resolve => { release = resolve; });
  const page = new Page({ delayedBody: () => delayed, afterRequest: p => p.navigate(`https://www.douyin.com/user/${OTHER}`) });
  const result = await run(t, page); release(body()); await drain();
  assert.equal(page.fetchCalls.length, 1); assertNoWorks(result); assert.equal(result.pagination.pages.length, 0); clean(page, result);
});
test('phase77 actual writer: a terminal explicit response still canonicalizes only a limited independently sampled window', async t => {
  const page = new Page(); const result = await run(t, page); assert.equal(result.status, 'ok');
  const raw = { version: 1, kind: 'works-only-observation', source: 'authorised-browser', targetId: 1, runId: 77,
    anchorSnapshotId: 40, anchorChecksum: 'a'.repeat(64), requestedLimit: 30, identity: { secUid: SEC, uid: UID },
    requestStartedAt: new Date(NOW).toISOString(), requestFinishedAt: new Date(NOW + 2600).toISOString(),
    observedAt: result.pagination.pages.at(-1).observedAt, status: 'accepted', coverage: 'limited', errorCode: null,
    posts: result.posts.map(p => ({ aweme_id: p.aweme_id, author: { sec_uid: p.author.sec_uid, uid: p.author.uid },
      statistics: p.statistics, desc: p.desc, create_time: p.create_time })), pagination: result.pagination };
  assert.equal(validateWorksOnlyEvidence(raw, { now: NOW + 3000 }).coverage, 'limited');
  assert.throws(() => validateWorksOnlyEvidence({ ...raw, coverage: 'complete' }, { now: NOW + 3000 }));
  const foreign = structuredClone(raw); foreign.posts[0].author.uid = '999';
  assert.throws(() => validateWorksOnlyEvidence(foreign, { now: NOW + 3000 })); clean(page, result);
});

test('phase77 actual browser helper: exact profile contract also permits the original trailing-slash profile form', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  let count = 0; const globals = browserGlobals({ url: `${PROFILE}/`, fetch: async () => { count++; return { status: 200 }; } });
  const result = await execute(requestBrowserFirstPage, globals); await drain();
  assert.equal(count, 1, 'the existing expectedProfile permits this exact trailing-slash author URL');
  assert.equal(result.state, 'issued');
});
test('phase77 actual browser helper: expired or enlarged account budget cannot send a GET', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  for (const expiresAt of [NOW - 1, NOW, NOW + 45001, Number.MAX_SAFE_INTEGER, NaN, Infinity, '2026-10-01']) {
    let count = 0; const globals = browserGlobals({ expiresAt, fetch: async () => { count++; } });
    const result = await execute(requestBrowserFirstPage, globals); assert.equal(result.state, 'not-eligible'); assert.equal(count, 0);
  }
});
test('phase77 actual browser helper: foreign origin, credentials, author, non-profile route and unready page cannot send a GET', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  for (const url of ['https://example.com/user/' + SEC, 'https://www.douyin.com.evil.test/user/' + SEC,
    'http://www.douyin.com/user/' + SEC, 'https://private:secret@www.douyin.com/user/' + SEC,
    'https://www.douyin.com/user/' + OTHER, 'https://www.douyin.com/search/' + SEC]) {
    let count = 0; const result = await execute(requestBrowserFirstPage, browserGlobals({ url, fetch: async () => { count++; } }));
    assert.equal(result.state, 'not-eligible'); assert.equal(count, 0);
  }
  let count = 0; const result = await execute(requestBrowserFirstPage, browserGlobals({ ready: 'loading', fetch: async () => { count++; } }));
  assert.equal(result.state, 'not-eligible'); assert.equal(count, 0);
});
test('phase77 actual browser helper: fixed count fallback/clamp and native same-origin credentials never carry caller fields', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  for (const [limit, expected] of [[1, 1], [30, 30], [100, 35], [1000, 35], [0, 18], [-1, 18], [NaN, 18], ['100', 18]]) {
    let call; const globals = browserGlobals({ fetch: async (path, options) => { call = { path, options }; return { status: 200 }; } });
    globals.args = { ...globals.args, limit, initialCursor: 12345, url: 'https://example.com', headers: { authorization: 'PRIVATE_HEADER' } };
    const result = await execute(requestBrowserFirstPage, globals); await drain();
    assert.equal(result.state, 'issued'); const url = new URL(call.path, PROFILE);
    assert.equal(url.searchParams.get('count'), String(expected)); assert.equal(url.searchParams.get('max_cursor'), '0');
    assert.equal(call.options.method, 'GET'); assert.equal(call.options.credentials, 'same-origin'); assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.headers, undefined); assert.equal(call.options.body, undefined);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|https?:|sec_user|cookie|signature/);
  }
});
test('phase77 actual browser helper: gate cap fails closed while hidden non-gates do not spoof a visible access barrier', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const hidden = { style: { display: 'none', visibility: 'visible', opacity: '1' },
    getBoundingClientRect: () => ({ left: 1, top: 1, right: 10, bottom: 10, width: 9, height: 9 }) };
  let calls = 0; const fetch = async () => { calls++; return { status: 200 }; };
  const allowed = await execute(requestBrowserFirstPage, browserGlobals({ gates: [hidden], fetch })); await drain();
  assert.equal(allowed.state, 'issued'); assert.equal(calls, 1);
  const blocked = await execute(requestBrowserFirstPage, browserGlobals({ gates: Array(101).fill(hidden), fetch }));
  assert.equal(blocked.state, 'blocked'); assert.equal(calls, 1);
});
test('phase77 actual diagnostic boundary: optional request metadata cannot export body/headers/URL/IDs or grant unknown capability', () => {
  const firstPageRequest = { kind: 'collector-same-origin-get', state: 'PRIVATE_STATE', attemptCount: 20,
    secUid: SEC, url: 'https://private.test?signature=PRIVATE_SECRET', headers: { cookie: 'PRIVATE_COOKIE' }, payload: body(999) };
  const clean = sanitizeBrowserWorksDiagnostics({ version: 1, firstPageRequest });
  assert.deepEqual(clean.firstPageRequest, { kind: 'collector-same-origin-get', state: 'unavailable', attemptCount: null });
  assert.doesNotMatch(JSON.stringify(clean), /PRIVATE_|signature|cookie|phase77TransportOffline|7234567890123456001/);
  assert.equal(sanitizeBrowserWorksDiagnostics({ version: 1, firstPageRequest: { ...firstPageRequest, kind: 'unverified-bridge' } }).firstPageRequest, undefined);
  assert.equal(sanitizeBrowserWorksDiagnostics({ version: 1 }).firstPageRequest, undefined, 'old optional-free evidence is unchanged');
});
test('phase77 actual owner: pre-qualified cancellation prevents an explicit first request', async t => {
  const controller = new AbortController();
  const page = new Page({ afterGoto: () => controller.abort() }); const result = await run(t, page, { signal: controller.signal });
  assert.equal(page.fetchCalls.length, 0); assertNoWorks(result); clean(page, result);
});
test('phase77 actual owner: evaluate resolving beyond the absolute account deadline cannot emit a late GET or rewrite returned evidence', async t => {
  let release; const delayExplicit = new Promise(resolve => { release = resolve; });
  const page = new Page({ delayExplicit }); const result = await run(t, page);
  assert.equal(page.helperCalls, 1); assert.equal(page.fetchCalls.length, 0); assertNoWorks(result);
  assert.equal(result.failureDiagnostics.firstPageRequest.state, 'timeout');
  const frozen = JSON.stringify(result); release(); await drain();
  assert.equal(page.fetchCalls.length, 0); assert.equal(JSON.stringify(result), frozen); clean(page, result);
});
