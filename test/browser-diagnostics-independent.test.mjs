import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { collectOne } from '../scripts/douyin_browser_collector.mjs';
import { sanitizeBrowserWorksDiagnostics, unknownBrowserWorksDiagnostics } from '../lib/douyin-browser-diagnostics.mjs';

const SEC = 'MS4wLjABAAAAindependentfixture123456789';
const OTHER = 'MS4wLjABAAAAotherfixture123456789';
const origin = 'https://www.douyin.com';
const endpoint = `${origin}/aweme/v1/web/aweme/post/`;
const profile = `${origin}/user/${SEC}`;
const url = (sec = SEC, cursor = '0') => `${endpoint}?sec_user_id=${sec}&max_cursor=${cursor}&a_bogus=[REDACTED]&msToken=[REDACTED]
const item = { key: 'independent-fixture', secUid: SEC, limit: 30 };
const options = { timeoutMs: 65, bodyTimeoutMs: 20, failureGraceMs: 1 };
const payload = () => ({ status_code: 0, aweme_list: [{ aweme_id: '1234567890123456789', author: { sec_uid: SEC }, statistics: { digg_count: 2 } }], has_more: true });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// No browser, network, session read or production data: these events exercise
// the real collector with EventEmitter's non-awaiting listener semantics.
class FixturePage extends EventEmitter {
  constructor(run = () => {}) { super(); this.run = run; this.current = 'about:blank'; this.reads = 0; this.frame = { url: () => this.current }; }
  mainFrame() { return this.frame; }
  url() { return this.current; }
  request(value = url(), extra = {}) { return { url: () => value, frame: () => this.frame, method: () => 'GET', isNavigationRequest: () => false, ...extra }; }
  startNavigation(value) { this.emit('request', this.request(value, { isNavigationRequest: () => true })); }
  commit(value) { this.current = value; this.emit('framenavigated', this.frame); }
  navigate(value) { this.startNavigation(value); this.commit(value); }
  response({ request = this.request(), requestEvent = true, status = 200, value = payload(), json } = {}) {
    if (requestEvent) this.emit('request', request);
    this.emit('response', { request: () => request, url: request.url, status: () => status, json: () => { this.reads += 1; return json ? json() : Promise.resolve(value); } });
  }
  async goto(value) { this.navigate(value); return this.run(this); }
}
function diag(result) {
  const value = result.failureDiagnostics;
  assert.equal(value.version, 1);
  assert.deepEqual(value, sanitizeBrowserWorksDiagnostics(value));
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE|sec_user_id|msToken|a_bogus|status_msg|cookie|headers|https?:|authenticated/);
  return value;
}
function clean(page) { for (const event of ['request', 'response', 'framenavigated']) assert.equal(page.listenerCount(event), 0, event); }
function unavailable(result) { assert.equal(result.status, 'unavailable'); assert.equal(result.worksCoverage, 'unavailable'); assert.deepEqual(result.posts, []); }

test('independent diagnostics: strict whitelist strips raw strings and never infers missing counts as zero', () => {
  const input = { version: 1, cookie: 'PRIVATE_COOKIE', url: profile, raw: { headers: 'PRIVATE_HEADER' },
    navigation: { observed: true, committed: 'true', failed: false, timedOut: 0, url: profile },
    requests: { candidate: 0, matched: '3', rejected: { method: -1, beforeCommit: 2, secret: 'PRIVATE' } },
    responses: { matched: 4, invalidBodies: Infinity, bodyTimeouts: null, body: 'PRIVATE_BODY' },
    httpStatuses: [200, 200, 401, '403', 99, 600], businessStatusCodes: [0, 2483, 2483, -1, '0'],
    finalPageKind: profile, elapsedMs: 900001, stopReason: 'PRIVATE_EXCEPTION' };
  const result = sanitizeBrowserWorksDiagnostics(input);
  assert.deepEqual(Object.keys(result).sort(), ['version', 'navigation', 'requests', 'responses', 'runtime', 'httpStatuses', 'businessStatusCodes', 'finalPageKind', 'elapsedMs', 'stopReason'].sort());
  assert.deepEqual(result.runtime, { pageErrorCount: null, pageErrorKinds: [], boundRequestFailedCount: null, navigationErrorKind: 'unknown' });
  assert.deepEqual(result.navigation, { observed: true, committed: null, failed: false, timedOut: null });
  assert.equal(result.requests.candidate, 0); assert.equal(result.requests.matched, null);
  assert.equal(result.requests.rejected.beforeCommit, 2); assert.equal(result.requests.rejected.method, null);
  assert.equal(result.responses.invalidBodies, null); assert.equal(result.elapsedMs, null);
  assert.deepEqual(result.httpStatuses, [200, 401]); assert.deepEqual(result.businessStatusCodes, [0, 2483]);
  assert.equal(result.finalPageKind, 'unknown'); assert.equal(result.stopReason, 'unknown');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|https:|cookie|headers/);
  assert.equal(sanitizeBrowserWorksDiagnostics({ version: '1' }), null);
  assert.equal(sanitizeBrowserWorksDiagnostics({ version: 2 }), null);
  assert.equal(sanitizeBrowserWorksDiagnostics([]), null);
});

test('independent diagnostics: statuses bounded and unknown resource creation remains unknown, not a failed login', () => {
  const value = sanitizeBrowserWorksDiagnostics({ version: 1, httpStatuses: Array.from({ length: 200 }, (_, i) => 100 + i), businessStatusCodes: Array.from({ length: 200 }, (_, i) => i) });
  assert.equal(value.httpStatuses.length, 10); assert.equal(value.businessStatusCodes.length, 10);
  const unknown = unknownBrowserWorksDiagnostics();
  assert.equal(unknown.navigation.observed, null); assert.equal(unknown.requests.matched, null);
  assert.equal(unknown.responses.matched, null); assert.equal(unknown.finalPageKind, 'unknown');
  assert.equal(unknown.stopReason, 'collector-exception');
});

test('independent diagnostics: no request and a request without response are distinct and not login expiry', async () => {
  const none = new FixturePage();
  const noneResult = await collectOne(none, item, options); unavailable(noneResult);
  assert.equal(noneResult.errorCode, 'collector_error');
  const a = diag(noneResult); assert.equal(a.requests.candidate, 0); assert.equal(a.requests.matched, 0); assert.equal(a.responses.matched, 0); assert.equal(a.stopReason, 'no-bound-request'); clean(none);
  const pending = new FixturePage(p => p.emit('request', p.request()));
  const pendingResult = await collectOne(pending, item, options); unavailable(pendingResult);
  assert.equal(pendingResult.errorCode, 'network_error'); assert.doesNotMatch(pendingResult.error, /登录|失效/);
  const b = diag(pendingResult); assert.equal(b.requests.candidate, 1); assert.equal(b.requests.matched, 1); assert.equal(b.responses.matched, 0); assert.equal(b.stopReason, 'deadline'); clean(pending);
});

test('independent diagnostics: HTTP statuses remain transport evidence and rejected bodies are never read', async () => {
  for (const [status, expected] of [[401, 'login_required'], [403, 'blocked'], [429, 'rate_limited'], [503, 'network_error']]) {
    const page = new FixturePage(p => p.response({ status, json: () => { throw Error('PRIVATE_BODY'); } }));
    const result = await collectOne(page, item, options); unavailable(result); assert.equal(result.errorCode, expected); assert.equal(page.reads, 0);
    const d = diag(result); assert.deepEqual(d.httpStatuses, [status]); assert.equal(d.stopReason, 'http-rejection'); assert.equal(d.responses.matched, 1); assert.deepEqual(d.businessStatusCodes, []); clean(page);
  }
});

test('independent diagnostics: explicit author-posts 2483 requires login; non-JSON stays unknown, never empty works', async () => {
  const page = new FixturePage(p => p.response({ value: { status_code: 2483, aweme_list: [], has_more: 0, status_msg: 'PRIVATE_BODY' } }));
  const result = await collectOne(page, item, options); unavailable(result); assert.equal(result.errorCode, 'login_required');
  const d = diag(result); assert.deepEqual(d.businessStatusCodes, [2483]); assert.equal(d.responses.invalidBodies, 1); assert.equal(d.stopReason, 'invalid-body'); clean(page);
  const nonJSON = new FixturePage(p => p.response({ json: () => Promise.reject(new SyntaxError('PRIVATE_TOKEN in HTML')) }));
  const invalid = await collectOne(nonJSON, item, options); unavailable(invalid); assert.equal(invalid.errorCode, 'upstream_changed');
  const d2 = diag(invalid); assert.equal(d2.responses.invalidBodies, 1); assert.deepEqual(d2.businessStatusCodes, []); assert.equal(d2.stopReason, 'invalid-body'); assert.doesNotMatch(JSON.stringify(invalid), /PRIVATE_TOKEN/); clean(nonJSON);
});

test('independent diagnostics: body timeout is bounded and late JSON cannot mutate returned evidence', async () => {
  const body = deferred(); const page = new FixturePage(p => p.response({ json: () => body.promise }));
  const result = await collectOne(page, item, options); unavailable(result); assert.equal(result.errorCode, 'network_error');
  const d = diag(result); assert.equal(d.responses.bodyTimeouts, 1); assert.equal(d.responses.invalidBodies, 0); assert.equal(d.stopReason, 'body-timeout');
  const frozen = JSON.stringify(result); body.resolve(payload()); await Promise.resolve(); await Promise.resolve();
  assert.equal(JSON.stringify(result), frozen); clean(page);
});

test('independent diagnostics: navigation timeout differs from navigation failure without leaking exceptions', async () => {
  for (const [name, reason, timedOut] of [['TimeoutError', 'navigation-timeout', true], ['Error', 'navigation-failed', false]]) {
    const page = new FixturePage(); page.goto = async () => { const error = Error('PRIVATE_URL with cookie'); error.name = name; throw error; };
    const result = await collectOne(page, item, options); unavailable(result); assert.equal(result.errorCode, 'network_error');
    const d = diag(result); assert.equal(d.navigation.failed, true); assert.equal(d.navigation.timedOut, timedOut); assert.equal(d.navigation.committed, false); assert.equal(d.stopReason, reason); clean(page);
  }
});

test('independent diagnostics: wrong account/cursor/frame/method candidates are rejected before body read', async () => {
  const page = new FixturePage(p => {
    p.response({ request: p.request(url(OTHER)) });
    p.response({ request: p.request(url(SEC, '20')) });
    p.response({ request: p.request(url(), { frame: () => ({ url: () => profile }) }) });
    p.response({ request: p.request(url(), { method: () => 'POST' }) });
    p.response();
  });
  const result = await collectOne(page, item, options); assert.equal(result.status, 'ok'); assert.equal(result.worksCoverage, 'latest-public-window'); assert.equal(page.reads, 1);
  const d = diag(result); assert.equal(d.requests.candidate, 5); assert.equal(d.requests.matched, 1); assert.equal(d.responses.matched, 1);
  for (const key of ['accountIdentity', 'firstCursor', 'nonMainFrame', 'method']) assert.equal(d.requests.rejected[key], 1, key);
  assert.equal(d.stopReason, 'success'); clean(page);
});

test('independent diagnostics: an official candidate without a readable frame is rejected, not misreported as no request', async () => {
  const page = new FixturePage(p => p.response({ request: p.request(url(), { frame: () => { throw Error('PRIVATE service worker frame'); } }) }));
  const result = await collectOne(page, item, options); unavailable(result); assert.equal(page.reads, 0);
  const d = diag(result); assert.equal(d.requests.candidate, 1); assert.equal(d.requests.rejected.frameUnavailable, 1);
  assert.equal(d.requests.matched, 0); assert.equal(d.responses.matched, 0); assert.equal(result.errorCode, 'collector_error'); clean(page);
});

test('independent diagnostics: navigation and late payload cannot erase an already bound HTTP403 refusal', async () => {
  const late = deferred();
  const page = new FixturePage(p => {
    p.response({ status: 403 });
    p.response({ json: () => late.promise });
    p.navigate(profile);
    p.response();
  });
  const result = await collectOne(page, item, options); unavailable(result); assert.equal(result.errorCode, 'blocked');
  const d = diag(result); assert.deepEqual(d.httpStatuses, [403]); assert.deepEqual(d.businessStatusCodes, []); assert.equal(d.requests.matched, 1); assert.equal(d.responses.matched, 1);
  assert.equal(page.reads, 0, 'no body after the bound refusal is eligible for reading');
  const frozen = JSON.stringify(result); late.resolve({ status_code: 2483, aweme_list: [] }); await Promise.resolve(); await Promise.resolve(); assert.equal(JSON.stringify(result), frozen); clean(page);
});

test('independent diagnostics: login after a verified page preserves original partial evidence without claiming authenticated', async () => {
  const page = new FixturePage(async p => {
    p.response(); for (let i = 0; i < 10; i++) await Promise.resolve();
    p.navigate(`${origin}/passport/web/login/?token=[REDACTED] p.response();
  });
  const result = await collectOne(page, item, options); assert.equal(result.status, 'ok'); assert.equal(result.errorCode, 'login_required');
  assert.equal(result.worksCoverage, 'latest-public-window'); assert.equal(result.posts.length, 1); assert.equal(result.posts[0].author.sec_uid, SEC);
  assert.equal(page.reads, 1, 'no new body after navigation is accepted');
  const d = diag(result); assert.equal(d.finalPageKind, 'login'); assert.equal(d.navigation.committed, false); assert.equal(d.responses.matched, 1); assert.deepEqual(d.businessStatusCodes, [0]); clean(page);
});

test('independent diagnostics: requestfailed without response stays transport-unknown and does not expose its raw exception', async () => {
  const page = new FixturePage(p => {
    const request = p.request(url(), { failure: () => ({ errorText: 'PRIVATE_TOKEN net::ERR_FAILED' }) });
    p.emit('request', request); p.emit('requestfailed', request);
  });
  const result = await collectOne(page, item, options); unavailable(result); assert.equal(result.errorCode, 'network_error');
  const d = diag(result); assert.equal(d.requests.matched, 1); assert.equal(d.responses.matched, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOKEN|会话已失效|重新.*登录/); clean(page);
});

test('independent diagnostics: a closed collection page cannot contaminate the next account page', async () => {
  const oldPage = new FixturePage();
  const oldResult = await collectOne(oldPage, item, { ...options, timeoutMs: 10 });
  const oldFrozen = JSON.stringify(oldResult); clean(oldPage);
  const nextPage = new FixturePage();
  const nextResultPromise = collectOne(nextPage, { ...item, key: 'next-fixture', secUid: OTHER }, options);
  await Promise.resolve(); await Promise.resolve();
  oldPage.response({ status: 401 });
  const nextPayload = payload(); nextPayload.aweme_list[0].author.sec_uid = OTHER;
  nextPage.response({ request: nextPage.request(url(OTHER)), value: nextPayload });
  const next = await nextResultPromise; assert.equal(next.status, 'ok'); assert.equal(next.posts[0].author.sec_uid, OTHER);
  const d = diag(next); assert.deepEqual(d.httpStatuses, [200]); assert.equal(d.responses.matched, 1);
  assert.equal(JSON.stringify(oldResult), oldFrozen); clean(nextPage);
});
