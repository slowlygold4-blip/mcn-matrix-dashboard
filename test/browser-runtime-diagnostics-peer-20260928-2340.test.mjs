import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { collectOne } from '../scripts/douyin_browser_collector.mjs';
import { sanitizeBrowserWorksDiagnostics, unknownBrowserWorksDiagnostics } from '../lib/douyin-browser-diagnostics.mjs';

// Real collector logic, no browser process, file-based session or network.
const SEC = 'MS4wLjABAAAAruntimeIndependentFixture123456';
const OTHER = 'MS4wLjABAAAAruntimeDifferentFixture654321';
const profile = sec => `https://www.douyin.com/user/${sec}`;
const works = sec => `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${sec}&max_cursor=0&a_bogus=PRIVATE_SIGNATURE`;
const item = { key: 'runtime-peer', secUid: SEC, limit: 30 };
const options = { timeoutMs: 60, bodyTimeoutMs: 25, failureGraceMs: 1 };
const payload = () => ({ status_code: 0, aweme_list: [{ aweme_id: '7111111111111111111', author: { sec_uid: SEC }, statistics: { digg_count: 0 } }], has_more: 0, max_cursor: 0 });
class Page extends EventEmitter {
  constructor(run = () => {}) { super(); this.run = run; this.current = 'about:blank'; this.frame = { url: () => this.current }; this.bodyReads = 0; }
  mainFrame() { return this.frame; }
  url() { return this.current; }
  request(sec = SEC, patch = {}) { return { url: () => works(sec), frame: () => this.frame, method: () => 'GET', isNavigationRequest: () => false, ...patch }; }
  start(value) { this.emit('request', this.request(SEC, { url: () => value, isNavigationRequest: () => true })); }
  commit(value) { this.current = value; this.emit('framenavigated', this.frame); }
  navigate(value) { this.start(value); this.commit(value); }
  respond({ request = this.request(), status = 200, body = payload(), bind = true } = {}) {
    if (bind) this.emit('request', request);
    this.emit('response', { request: () => request, url: request.url, status: () => status,
      json: async () => { this.bodyReads++; return body; } });
  }
  async goto(value) { this.navigate(value); return this.run(this); }
}
function hostileError(name = 'TypeError') {
  const reads = { name: 0, message: 0, stack: 0 };
  const error = Object.create(null);
  for (const key of Object.keys(reads)) Object.defineProperty(error, key, { get() {
    reads[key]++;
    if (key !== 'name') throw new Error(`PRIVATE_${key}_URL_TOKEN`);
    return name;
  } });
  return { error, reads };
}
function resultRuntime(result) {
  const diag = result.failureDiagnostics;
  assert.deepEqual(diag, sanitizeBrowserWorksDiagnostics(diag));
  assert.doesNotMatch(JSON.stringify(diag), /PRIVATE|https?:|a_bogus|sec_user_id|cookie|headers|stack|message|errorText|authenticated/);
  return diag.runtime;
}
function cleaned(page) {
  for (const type of ['request', 'response', 'framenavigated', 'requestfailed', 'pageerror']) assert.equal(page.listenerCount(type), 0, type);
}

test('runtime peer: legacy absence means unknown counts and sanitizer ignores arbitrary runtime fields', () => {
  const old = sanitizeBrowserWorksDiagnostics({ version: 1 });
  assert.equal(old.runtime.pageErrorCount, null); assert.equal(old.runtime.boundRequestFailedCount, null);
  assert.equal(old.runtime.navigationErrorKind, 'unknown'); assert.deepEqual(old.runtime.pageErrorKinds, []);
  assert.deepEqual(unknownBrowserWorksDiagnostics().runtime, old.runtime);
  const d = sanitizeBrowserWorksDiagnostics({ version: 1, runtime: { pageErrorCount: 0, boundRequestFailedCount: '2',
    pageErrorKinds: ['type-error', 'type-error', 'PRIVATE_TOKEN', 'syntax-error'], navigationErrorKind: 'PRIVATE_URL',
    message: 'PRIVATE_MESSAGE', stack: 'PRIVATE_STACK', errorText: 'PRIVATE_FAILURE' } });
  assert.equal(d.runtime.pageErrorCount, 0); assert.equal(d.runtime.boundRequestFailedCount, null);
  assert.deepEqual(d.runtime.pageErrorKinds, ['type-error', 'syntax-error']); assert.equal(d.runtime.navigationErrorKind, 'unknown');
  assert.doesNotMatch(JSON.stringify(d), /PRIVATE|message|stack|errorText/);
});

test('runtime peer: malicious page exceptions expose name only and cannot downgrade valid observed works', async () => {
  const hostile = hostileError();
  const page = new Page(p => { p.emit('pageerror', hostile.error); p.respond(); });
  const result = await collectOne(page, item, options);
  assert.equal(result.status, 'ok'); assert.equal(result.worksCoverage, 'complete');
  assert.equal(result.posts[0].statistics.digg_count, 0); assert.equal(result.errorCode, undefined);
  assert.equal(hostile.reads.message, 0); assert.equal(hostile.reads.stack, 0);
  const runtime = resultRuntime(result); assert.equal(runtime.pageErrorCount, 1); assert.deepEqual(runtime.pageErrorKinds, ['type-error']);
  assert.equal(runtime.boundRequestFailedCount, 0); cleaned(page);
});

test('runtime peer: bound transport failures are deduplicated and never call failure or inspect raw errorText', async () => {
  let failureReads = 0;
  const page = new Page(p => {
    const req = p.request(); Object.defineProperty(req, 'failure', { get() { failureReads++; throw Error('PRIVATE_FAILURE_URL'); } });
    p.emit('request', req); p.emit('requestfailed', req); p.emit('requestfailed', req);
  });
  const result = await collectOne(page, item, options);
  assert.equal(result.status, 'unavailable'); assert.equal(result.worksCoverage, 'unavailable'); assert.equal(result.errorCode, 'network_error');
  assert.doesNotMatch(result.error, /登录|失效|授权/); assert.equal(failureReads, 0);
  assert.equal(resultRuntime(result).boundRequestFailedCount, 1); assert.equal(result.failureDiagnostics.responses.matched, 0); cleaned(page);
});

test('runtime peer: same URL is not request identity; foreign, before-commit and unbound failures do not count', async () => {
  const page = new Page(p => {
    const bound = p.request(); p.emit('request', bound);
    p.emit('requestfailed', p.request());
    const wrong = p.request(OTHER); p.emit('request', wrong); p.emit('requestfailed', wrong);
    p.start(profile(SEC)); const early = p.request(); p.emit('request', early); p.emit('requestfailed', early);
    p.commit(profile(SEC)); p.respond();
  });
  const result = await collectOne(page, item, options);
  assert.equal(result.status, 'ok'); assert.equal(resultRuntime(result).boundRequestFailedCount, 0); cleaned(page);
});

test('runtime peer: navigation resets bound failures and page errors with no generation provenance remain unknown', async () => {
  const page = new Page(p => {
    const old = p.request(); p.emit('request', old); p.emit('requestfailed', old); p.emit('pageerror', new TypeError('PRIVATE_OLD'));
    p.navigate(profile(OTHER)); p.emit('pageerror', new SyntaxError('PRIVATE_FOREIGN'));
    p.navigate(profile(SEC)); p.emit('requestfailed', old); p.emit('pageerror', new ReferenceError('PRIVATE_CURRENT')); p.respond();
  });
  const result = await collectOne(page, item, options); assert.equal(result.status, 'ok');
  const runtime = resultRuntime(result); assert.equal(runtime.boundRequestFailedCount, 0);
  // Unlike Request objects, Page error events do not identify the producing
  // document. Even the apparent current error cannot safely be attributed.
  assert.equal(runtime.pageErrorCount, null); assert.deepEqual(runtime.pageErrorKinds, []); cleaned(page);
});

test('runtime peer: HTTP rejection remains HTTP evidence and does not invent a requestfailed event', async () => {
  const page = new Page(p => p.respond({ status: 403 }));
  const result = await collectOne(page, item, options); assert.equal(result.errorCode, 'blocked');
  assert.equal(resultRuntime(result).boundRequestFailedCount, 0); assert.deepEqual(result.failureDiagnostics.httpStatuses, [403]);
  assert.equal(page.bodyReads, 0); cleaned(page);
});

test('runtime peer: navigation errors never read message or stack, including throwing or nonstring names', async () => {
  for (const name of ['TimeoutError', 'RangeError', 'PRIVATE_NAME', 403]) {
    const hostile = hostileError(name); const page = new Page(); page.goto = async () => { throw hostile.error; };
    const result = await collectOne(page, item, options);
    assert.equal(result.status, 'unavailable'); assert.equal(result.errorCode, 'network_error');
    assert.equal(hostile.reads.message, 0); assert.equal(hostile.reads.stack, 0);
    assert.equal(resultRuntime(result).navigationErrorKind, name === 'TimeoutError' ? 'timeout' : name === 'RangeError' ? 'range-error' : 'unknown'); cleaned(page);
  }
  const page = new Page(); const error = Object.create(null); Object.defineProperty(error, 'name', { get() { throw Error('PRIVATE_GETTER'); } });
  page.goto = async () => { throw error; };
  const result = await collectOne(page, item, options); assert.equal(result.status, 'unavailable');
  assert.equal(resultRuntime(result).navigationErrorKind, 'unknown'); cleaned(page);
});

test('runtime peer: closed listeners and retained callback references cannot mutate returned diagnostics', async () => {
  let oldErrorHandler, oldFailureHandler, request;
  const page = new Page(p => { oldErrorHandler = p.listeners('pageerror')[0]; oldFailureHandler = p.listeners('requestfailed')[0];
    request = p.request(); p.emit('request', request); p.respond(); });
  const result = await collectOne(page, item, options); const before = JSON.stringify(result); cleaned(page);
  assert.equal(typeof oldErrorHandler, 'function'); assert.equal(typeof oldFailureHandler, 'function');
  page.emit('pageerror', new Error('PRIVATE_LATE')); page.emit('requestfailed', request);
  oldErrorHandler?.(new TypeError('PRIVATE_DIRECT_LATE')); oldFailureHandler?.(request);
  assert.equal(JSON.stringify(result), before); assert.equal(result.status, 'ok');
});

test('runtime peer: page runtime error before expected profile commit is not attributed to the account', async () => {
  const page = new Page(); page.goto = async value => {
    page.emit('pageerror', new Error('PRIVATE_BLANK'));
    page.start(value); page.emit('pageerror', new Error('PRIVATE_NOT_COMMITTED'));
    page.commit(value); page.respond();
  };
  const result = await collectOne(page, item, options); assert.equal(result.status, 'ok');
  assert.equal(resultRuntime(result).pageErrorCount, 0); cleaned(page);
});
