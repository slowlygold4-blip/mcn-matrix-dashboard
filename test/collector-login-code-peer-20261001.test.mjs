import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { collectOne, collectBrowserWorks } from '../scripts/douyin_browser_collector.mjs';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';

const SEC = 'MS4wLjABAAAAloginCodePeerSyntheticOnly';
const OTHER = 'MS4wLjABAAAAloginCodePeerOtherSynthetic';
const ORIGIN = 'https://www.douyin.com';
const SECRET = 'LOGIN_CODE_PEER_BODY_SECRET';
const item = { key: 'login-code-peer', secUid: SEC, limit: 30 };
const options = { timeoutMs: 100, bodyTimeoutMs: 40, failureGraceMs: 1 };
const url = (sec = SEC) => `${ORIGIN}/aweme/v1/web/aweme/post/?sec_user_id=${sec}&max_cursor=0`;
const good = () => ({ status_code: 0, aweme_list: [], has_more: false, max_cursor: 0 });
const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// Event-only fixtures. No browser, file-backed session, subprocess or network.
class Page extends EventEmitter {
  constructor(run = () => {}) { super(); this.run = run; this.current = 'about:blank'; this.reads = 0; this.frame = { url: () => this.current }; }
  mainFrame() { return this.frame; }
  url() { return this.current; }
  request(value = url(), extra = {}) { return { url: () => value, frame: () => this.frame, method: () => 'GET', isNavigationRequest: () => false, ...extra }; }
  navigate() { const value = `${ORIGIN}/user/${SEC}`; this.emit('request', this.request(value, { isNavigationRequest: () => true })); this.current = value; this.emit('framenavigated', this.frame); }
  response({ request = this.request(), body = good(), json } = {}) {
    this.emit('request', request);
    this.emit('response', { request: () => request, url: request.url, status: () => 200,
      json: () => { this.reads++; return json ? json() : Promise.resolve(body); } });
  }
  async goto() { this.navigate(); return this.run(this); }
}
function clean(page, result) {
  for (const event of ['request', 'response', 'framenavigated', 'pageerror', 'requestfailed', 'domcontentloaded']) assert.equal(page.listenerCount(event), 0, event);
  assert.doesNotMatch(JSON.stringify(result), /LOGIN_CODE_PEER_BODY_SECRET|status_msg|sec_user_id|https?:/);
  assert.equal(Object.hasOwn(result, 'authenticated'), false, 'an access code must not invent authenticated=true/false');
}

test('peer login code: strictly bound numeric 2483 is login-required without reading status_msg or retaining the body', async () => {
  let messageReads = 0;
  const body = { status_code: 2483, aweme_list: [], has_more: 0, cookie: SECRET, headers: { authorization: SECRET } };
  Object.defineProperty(body, 'status_msg', { enumerable: true, get() { messageReads++; throw Error(SECRET); } });
  const page = new Page(p => p.response({ body }));
  const result = await collectOne(page, item, options);
  assert.equal(result.errorCode, 'login_required');
  assert.equal(result.status, 'unavailable'); assert.equal(result.worksCoverage, 'unavailable'); assert.deepEqual(result.posts, []);
  assert.deepEqual(result.failureDiagnostics.businessStatusCodes, [2483]);
  assert.equal(result.failureDiagnostics.responses.invalidBodies, 1);
  assert.equal(result.failureDiagnostics.stopReason, 'invalid-body');
  assert.equal(messageReads, 0); clean(page, result);
});

test('peer login code: string, generic 8, booleans, missing and message text do not become login barriers', async () => {
  for (const status_code of ['2483', 8, true, false, undefined, null, 2483.1]) {
    const page = new Page(p => p.response({ body: { status_code, status_msg: `用户未登录 ${SECRET}`, aweme_list: [], has_more: 0 } }));
    const result = await collectOne(page, item, options);
    assert.equal(result.errorCode, 'upstream_changed', String(status_code));
    assert.equal(result.status, 'unavailable'); assert.deepEqual(result.posts, []); clean(page, result);
  }
});

test('peer login code: other-author and wrong-frame 2483 bodies are never read or accepted', async () => {
  const page = new Page(p => {
    p.response({ request: p.request(url(OTHER)), body: { status_code: 2483, secret: SECRET } });
    p.response({ request: p.request(url(), { frame: () => ({ url: () => `${ORIGIN}/user/${SEC}` }) }), body: { status_code: 2483, secret: SECRET } });
    p.response();
  });
  const result = await collectOne(page, item, options);
  assert.equal(result.status, 'ok'); assert.equal(result.errorCode, undefined); assert.equal(page.reads, 1);
  assert.deepEqual(result.failureDiagnostics.businessStatusCodes, [0]);
  assert.equal(result.failureDiagnostics.requests.rejected.accountIdentity, 1);
  assert.equal(result.failureDiagnostics.requests.rejected.nonMainFrame, 1); clean(page, result);
});

test('peer login code: a delayed old-generation 2483 cannot taint the current document success', async () => {
  const old = deferred();
  const page = new Page(async p => {
    p.response({ json: () => old.promise }); await drain();
    p.navigate(); old.resolve({ status_code: 2483, status_msg: SECRET });
    p.response(); await drain();
  });
  const result = await collectOne(page, item, options);
  assert.equal(result.status, 'ok'); assert.equal(result.errorCode, undefined);
  assert.deepEqual(result.failureDiagnostics.businessStatusCodes, [0]); clean(page, result);
});

test('peer login code: a previously pending success cannot erase a bound 2483 refusal', async () => {
  const late = deferred();
  const page = new Page(async p => { p.response({ json: () => late.promise }); await drain(); p.response({ body: { status_code: 2483, secret: SECRET } }); await drain(); });
  const result = await collectOne(page, item, options);
  assert.equal(result.errorCode, 'login_required'); assert.equal(result.status, 'unavailable'); assert.deepEqual(result.posts, []);
  const frozen = JSON.stringify(result); late.resolve(good()); await drain();
  assert.equal(JSON.stringify(result), frozen); clean(page, result);
});

test('peer login code: actual provider projection keeps a 15-minute authorised-browser gate and safe persistence envelope', async () => {
  const page = new Page(p => p.response({ body: { status_code: 2483, status_msg: SECRET, secret: SECRET } }));
  const browserItem = await collectOne(page, { ...item, key: '1' }, options);
  let now = Date.parse('2026-10-01T00:00:00.000Z'); let browserCalls = 0;
  const upstream = { capturedAt: '2026-09-30T00:00:00.000Z', profile: { user: { sec_uid: SEC, nickname: '合成账号' } },
    worksCoverage: 'unavailable', worksErrorCode: 'blocked', works: { aweme_list: [] }, warnings: [] };
  const execFileImpl = (file, _args, _options, callback) => { const browser = file === process.execPath; if (browser) browserCalls++;
    callback(null, JSON.stringify({ ok: true, data: browser ? { items: [browserItem] } : upstream }), ''); };
  const provider = new PublicWebProvider({}, { execFileImpl, accountBrowserFallback: true, worksRequestPolicyOptions: { now: () => now } });
  const result = await provider.collect({ id: 1, type: 'account', label: '合成账号', locator: SEC, metadata: {} });
  assert.equal(browserCalls, 1); assert.equal(provider.accountBrowserGate, false); assert.equal(provider.accountBrowserGateError, 'login_required');
  assert.equal(result.raw.worksFallbackErrorCode, 'login_required');
  assert.equal(result.raw.worksRequestPolicy.browser.nextEligibleAt, '2026-10-01T00:15:00.000Z');
  assert.equal(result.snapshot.followers, null); assert.equal(result.snapshot.totalLikes, null); assert.equal(result.snapshot.totalPosts, null);
  assert.doesNotMatch(JSON.stringify(result), /LOGIN_CODE_PEER_BODY_SECRET|status_msg|authorization/);
  provider.worksRequestPolicy.record('authorised-browser', { targetKey: 'late-success', errorCode: null });
  assert.equal(provider.worksRequestPolicy.decision('authorised-browser').errorCode, 'login_required');
  now += 15 * 60_000 - 1; assert.equal(provider.worksRequestPolicy.decision('authorised-browser').deferred, true);
  now++; assert.equal(provider.worksRequestPolicy.decision('authorised-browser').deferred, false); clean(page, browserItem);
});

test('peer login code: synthetic batch provenance remains authenticated=null and not-verified', async () => {
  const page = new Page(p => p.response({ body: { status_code: 2483, status_msg: SECRET } }));
  let pageClosed = 0, contextClosed = 0, browserClosed = 0;
  page.close = async () => { pageClosed++; };
  const context = { newPage: async () => page, close: async () => { contextClosed++; } };
  const browser = { newContext: async () => context, close: async () => { browserClosed++; } };
  const result = await collectBrowserWorks({ items: [item] }, { collectOptions: options,
    runtime: { readState: async () => ({ cookies: [] }), access: async () => {}, launch: async () => browser } });
  assert.equal(result.provenance.authenticated, null);
  assert.equal(result.provenance.authenticationStatus, 'not-verified');
  assert.equal(result.provenance.noChallengeBypass, true);
  assert.deepEqual([pageClosed, contextClosed, browserClosed], [1, 1, 1]);
  assert.doesNotMatch(JSON.stringify(result), /LOGIN_CODE_PEER_BODY_SECRET|status_msg/);
  clean(page, result.items[0]);
});
