import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { collectOne } from '../scripts/douyin_browser_collector.mjs';
import { sanitizeBrowserRenderDiagnostics } from '../lib/browser-render-diagnostics.mjs';
import { sanitizeBrowserWorksDiagnostics } from '../lib/douyin-browser-diagnostics.mjs';

// Actual collector and its browser function, with fully synthetic DOM/events.
const SEC = 'MS4wLjABAAAARenderDiagnosticFixture123';
const OTHER = 'MS4wLjABAAAAOtherSyntheticIdentity123';
const PROFILE = `https://www.douyin.com/user/${SEC}`;
const WORKS = `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${SEC}&max_cursor=0`;
const SECRET = 'UNTRUSTED_PAGE_TEXT_MUST_NOT_ESCAPE';
const post = (id, secUid = SEC) => ({ id, authorInfo: { secUid, uid: '1234567890' }, desc: SECRET });
const legacy = data => ({ 41: { user: { user: { secUid: SEC, uid: '1234567890', nickname: SECRET } }, post: { data } } });
function dom(value, { gate = false, readyState = 'complete' } = {}) {
  const keys = ['document', 'location', 'getComputedStyle'];
  const old = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  let reads = 0;
  const script = { get textContent() { reads++; return typeof value === 'string' ? value : encodeURIComponent(JSON.stringify(value)); } };
  globalThis.location = new URL(PROFILE);
  globalThis.getComputedStyle = () => ({ visibility: 'visible', display: 'block' });
  globalThis.document = {
    readyState, body: { childElementCount: 2 },
    get cookie() { throw new Error('must never read credentials'); },
    querySelector: selector => selector.includes('RENDER_DATA') && value !== null ? script : null,
    querySelectorAll: selector => gate && selector.includes('captcha') ? [{ getClientRects: () => [1] }]
      : selector === 'script' || selector === 'script[type="application/json"]' ? value === null ? [] : [script] : [],
  };
  return { reads: () => reads, restore() { for (const [key, descriptor] of old) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  } } };
}
class Page extends EventEmitter {
  constructor({ status = 200, scenario = () => {} } = {}) { super(); this.status = status; this.scenario = scenario; this.address = 'about:blank'; this.evaluations = 0; this.bodyReads = 0; this.actions = 0;
    this.frame = { url: () => this.address }; this.mouse = { move: async () => this.actions++, wheel: async () => this.actions++ }; }
  mainFrame() { return this.frame; }
  url() { return this.address; }
  request(url = WORKS, navigation = false) { return { url: () => url, isNavigationRequest: () => navigation, method: () => 'GET', frame: () => this.frame }; }
  respond(status) { const request = this.request(); this.emit('request', request);
    this.emit('response', { request: () => request, url: () => WORKS, status: () => status, json: async () => { this.bodyReads++; return {}; } }); }
  async goto() {
    const request = this.request(PROFILE, true); this.documentRequest = request; this.emit('request', request); this.address = PROFILE;
    this.emit('response', { request: () => request, url: () => PROFILE, status: () => this.status });
    this.emit('framenavigated', this.frame); this.scenario(this); this.emit('domcontentloaded');
  }
  async evaluate(fn, arg) { this.evaluations++; return fn(arg); }
}
async function observe(value, { page = new Page(), ...options } = {}) {
  const document = dom(value, options);
  try {
    const result = await collectOne(page, { key: 'synthetic', secUid: SEC, limit: 30 }, { timeoutMs: 40, failureGraceMs: 1 });
    assert.deepEqual(result.posts, []); assert.equal(result.worksCoverage, 'unavailable');
    assert.equal(page.actions, 0); assert.ok(page.evaluations <= 2);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(`${SECRET}|${SEC}|${OTHER}|1234567890|7000000000000000001`));
    return { result, reads: document.reads(), render: result.failureDiagnostics.firstScreen?.render };
  } finally { document.restore(); }
}
test('render diagnostic: legacy target records become only bounded structural counts, never collected works', async () => {
  const { render, reads, result } = await observe(legacy([post('7000000000000000001')]));
  assert.equal(render?.parseState, 'legacy-user-post'); assert.equal(render.profileIdentity, 'sec-uid-match');
  assert.equal(render.postCount, 1); assert.equal(render.workCandidateCount, 1); assert.ok(reads >= 1 && reads <= 2);
  assert.equal(result.failureDiagnostics.stopReason, 'no-bound-request'); assert.equal(result.errorCode, 'collector_error');
});
test('render diagnostic: malformed and unknown app documents never invent target structure', async () => {
  for (const [value, state] of [['not-json', 'invalid-json'], [{ app: { user: { uid: SECRET } } }, 'unknown'], [null, 'absent']]) {
    const { render } = await observe(value); assert.equal(render?.parseState, state); assert.equal(render?.workCandidateCount, null);
  }
});
test('render diagnostic: visible gate prevents embedded JSON reads', async () => {
  const { reads, render } = await observe(legacy([post('7000000000000000001')]), { gate: true });
  assert.equal(reads, 0); assert.equal(render?.parseState, 'gated');
});
test('render diagnostic: bound document and works refusals prevent queued or later JSON observations', async () => {
  for (const [page, errorCode] of [[new Page({ status: 401 }), 'login_required'], [new Page({ status: 403 }), 'blocked'],
    [new Page({ status: 429 }), 'rate_limited'], [new Page({ status: 404 }), 'network_error'],
    [new Page({ status: 500 }), 'network_error'], [new Page({ status: 503 }), 'network_error'],
    [new Page({ scenario: p => p.respond(403) }), 'blocked']]) {
    const { reads, result } = await observe(legacy([post('7000000000000000001')]), { page });
    assert.equal(reads, 0); assert.equal(result.errorCode, errorCode); assert.equal(page.bodyReads, 0);
  }
});
test('render diagnostic: unknown or ordinary redirect document status allows markers only', async () => {
  for (const status of [null, 0, 302]) {
    const { reads, render } = await observe(legacy([post('7000000000000000001')]), { page: new Page({ status }) });
    assert.equal(reads, 0); assert.equal(render.parseState, 'deferred');
  }
});
test('render diagnostic: foreign and ambiguous profile branches expose no works counts', async () => {
  const foreign = legacy([post('7000000000000000001')]); foreign[41].user.user.secUid = OTHER;
  const first = await observe(foreign);
  assert.equal(first.render.profileIdentity, 'mismatch'); assert.equal(first.render.postCount, null);
  const multiple = { ...legacy([]), 42: legacy([])[41] };
  const second = await observe(multiple);
  assert.equal(second.render.parseState, 'ambiguous'); assert.equal(second.render.workCandidateCount, null);
});
test('render diagnostic: invalid IDs, foreign authors and duplicate IDs are diagnostic counts only', async () => {
  const { render } = await observe(legacy([post('7000000000000000001'), post('7000000000000000001'),
    post('invalid'), post('7000000000000000002', OTHER)]));
  assert.equal(render.postCount, 4); assert.equal(render.authorMatchCount, 3); assert.equal(render.authorConflictCount, 1);
  assert.equal(render.validIdCount, 3); assert.equal(render.duplicateIdCount, 1); assert.equal(render.workCandidateCount, 1);
});
test('render diagnostic: decoding has one explicit path and size/depth/key/node limits', async () => {
  let deep = {}; for (let i = 0; i < 16; i++) deep = { child: deep };
  const cases = [
    ['%E0%A4%A', 'invalid-encoding'], [JSON.stringify(legacy([])), 'legacy-user-post'],
    ['x'.repeat(2_000_001), 'over-limit'], [deep, 'over-limit'],
    [Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [String(i), 0])), 'over-limit'],
    [{ list: Array.from({ length: 1001 }, () => 0) }, 'over-limit'],
    [{ list: Array.from({ length: 950 }, () => Array.from({ length: 12 }, () => 0)) }, 'over-limit'],
  ];
  for (const [value, state] of cases) assert.equal((await observe(value)).render.parseState, state);
});
test('render diagnostic: sanitizer removes raw strings, IDs and unknown fields at both boundaries', () => {
  const unsafe = { version: 1, parseState: SECRET, encoding: SECRET, profileIdentity: SECRET,
    identityBasis: 'dual-id-verified', postCount: '9', validIdCount: Infinity, workCandidateCount: -1,
    authorMatchCount: 1001, raw: SECRET, uid: SEC, cookie: SECRET };
  const safe = sanitizeBrowserRenderDiagnostics(unsafe);
  assert.equal(safe.parseState, 'unknown'); assert.equal(safe.identityBasis, 'sec-uid-only');
  for (const key of ['postCount', 'validIdCount', 'workCandidateCount', 'authorMatchCount']) assert.equal(safe[key], null);
  const nested = sanitizeBrowserWorksDiagnostics({ version: 1, firstScreen: { render: unsafe } });
  assert.deepEqual(nested.firstScreen.render, safe);
  assert.doesNotMatch(JSON.stringify(nested), new RegExp(`${SECRET}|${SEC}|dual-id-verified`));
});
test('render diagnostic: pending successful projection is discarded when a bound refusal arrives', async () => {
  const page = new Page({ scenario: p => setTimeout(() => p.respond(403), 3) });
  page.evaluate = async function (fn, arg) {
    this.evaluations++; const value = fn(arg);
    await new Promise(resolve => setTimeout(resolve, 15)); return value;
  };
  const { result } = await observe(legacy([post('7000000000000000001')]), { page });
  assert.equal(result.errorCode, 'blocked'); assert.equal(result.failureDiagnostics.firstScreen, undefined);
  const frozen = JSON.stringify(result); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(JSON.stringify(result), frozen);
});
test('render diagnostic: late old document success does not authorize the next generation JSON', async () => {
  const page = new Page({ scenario: p => {
    const current = p.request(PROFILE, true); p.emit('request', current); p.emit('framenavigated', p.frame);
    p.emit('response', { request: () => p.documentRequest, url: () => PROFILE, status: () => 200 });
  } });
  const { reads, render } = await observe(legacy([post('7000000000000000001')]), { page });
  assert.equal(reads, 0); assert.equal(render.parseState, 'deferred');
});
test('render diagnostic: unrelated frame or account document refusal cannot poison current profile evidence', async () => {
  const page = new Page({ scenario: p => {
    for (const request of [{ ...p.request(PROFILE, true), frame: () => ({}) }, p.request(`https://www.douyin.com/user/${OTHER}`, true)]) {
      p.emit('response', { request: () => request, url: () => request.url(), status: () => 403 });
    }
  } });
  const { render, result } = await observe(legacy([post('7000000000000000001')]), { page });
  assert.equal(render.workCandidateCount, 1); assert.equal(result.errorCode, 'collector_error');
});
test('render diagnostic: navigating to other profile, login or verification stops queued JSON reads', async () => {
  for (const url of [`https://www.douyin.com/user/${OTHER}`, 'https://www.douyin.com/passport/login', 'https://www.douyin.com/verify/']) {
    const page = new Page({ scenario: p => {
      p.emit('request', p.request(url, true)); p.address = url; p.emit('framenavigated', p.frame);
    } });
    assert.equal((await observe(legacy([post('7000000000000000001')]), { page })).reads, 0);
  }
});
