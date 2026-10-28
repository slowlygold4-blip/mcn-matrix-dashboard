import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { normalizeAuthorisedDetailInput, isExpectedAuthorisedDetailResponseUrl, validateAuthorisedDetailResponse,
  validateAuthorisedDetailResult, collectAuthorisedDetail, AUTHORISED_DETAIL_HASH_SCOPE } from '../lib/douyin-authorised-detail.mjs';

const SEC = 'MS4wLjABAAAAuthorisedDetailFixture12345';
const VIDEO = '7690702905876096104', UID = '1234567890123456789';
const item = { key: 'douyin:Exact_User|video:7690702905876096104', videoId: VIDEO, submittedId: 'Exact_User' };
const payload = () => ({ items: [{ ...item }] });
const input = normalizeAuthorisedDetailInput(payload());
const url = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${VIDEO}&a_bogus=PRIVATE_TEST_SIGNATURE`;
const body = () => ({ status_code: 0, aweme_detail: { aweme_id: VIDEO,
  author: { sec_uid: SEC, uid: UID, unique_id: 'Exact_User', short_id: '0001234567890123456789', nickname: 'PRIVATE_UNUSED_NAME' },
  video: { play_addr: { url_list: ['https://example.com/private-signature'] } } }, headers: { cookie: 'PRIVATE_RESPONSE_COOKIE' } });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const SHARE = 'https://v.douyin.com/7W6k5-kdoq8/';
const sharePayload = () => ({ items: [{ key: item.key, shareUrl: SHARE, submittedId: item.submittedId }] });
const shareInput = normalizeAuthorisedDetailInput(sharePayload());
const collectShare = (f, options = {}) => collectAuthorisedDetail(sharePayload(), { enabled: true, runtime: f.rt, ...options });

class Page extends EventEmitter {
  constructor(scenario) { super(); this.scenario = scenario; this.current = 'about:blank'; this.reads = 0; this.navigations = 0; this.closes = 0; this.frame = { url: () => this.current }; }
  mainFrame() { return this.frame; }
  url() { return this.current; }
  move(value) { this.current = value; this.emit('framenavigated', this.frame); }
  request({ value = url, frame = this.frame, method = 'GET', navigation = false, redirect = null } = {}) {
    return { url: () => value, frame: () => frame, method: () => method, isNavigationRequest: () => navigation, redirectedFrom: () => redirect };
  }
  respond({ value = url, request = this.request({ value }), requestEvent = true, status = 200, data = body(), text } = {}) {
    if (requestEvent) this.emit('request', request);
    this.emit('response', { request: () => request, url: () => value, status: () => status,
      text: async () => { this.reads++; return text ? text() : JSON.stringify(data); } });
  }
  async goto(value) { this.navigations++; this.move(value); return this.scenario(this); }
  async close() { this.closes++; }
}
function runtime(scenario = page => page.respond(), changes = {}) {
  const page = new Page(scenario), calls = [], process = { pid: 12345, exitCode: null, signalCode: null };
  const state = { cookies: [{ name: 'test-session', value: 'PRIVATE_AUTHORISATION_STATE', domain: '.douyin.com' }], origins: [] };
  const context = { newPage: async () => { calls.push('page'); return page; }, close: async () => { calls.push('context.close'); } };
  const browser = { newContext: async options => { assert.equal(options.storageState, state); calls.push('context'); return context; }, close: async () => { calls.push('browser.close'); } };
  const server = { process: () => process, wsEndpoint: () => 'ws://127.0.0.1:12345/PRIVATE_ENDPOINT',
    close: async () => { calls.push('server.close'); process.exitCode = 0; }, kill: async () => { calls.push('server.kill'); process.signalCode = 'SIGKILL'; } };
  const rt = { readState: async () => { calls.push('state.read'); return state; }, access: async () => {},
    ownership: { remainingExecutionMs: () => 45_000, send: async (kind, pid) => { calls.push(kind); if (kind === 'register' || kind === 'released') assert.equal(pid, process.pid); } },
    chromium: { launchServer: async options => { assert.equal(options.headless, true); assert.equal(options.host, '127.0.0.1'); assert.equal(options.port, 0); assert.equal(options.args, undefined); calls.push('launchServer'); return server; },
      connect: async () => { calls.push('connect'); return browser; } }, ...changes };
  return { page, calls, state, context, browser, server, process, rt, collect: options => collectAuthorisedDetail(payload(), { enabled: true, runtime: rt, ...options }) };
}
function listenersClosed(page) { for (const event of ['request', 'response', 'framenavigated']) assert.equal(page.listenerCount(event), 0, event); }

test('adapter is default-off, rejects no ownership, and validates single explicit identity before state read', async () => {
  const f = runtime();
  await assert.rejects(() => collectAuthorisedDetail(payload(), { runtime: f.rt }), { code: 'disabled' });
  await assert.rejects(() => collectAuthorisedDetail(payload(), { enabled: true }), { code: 'ownership_required' });
  for (const bad of [{}, { items: [] }, { items: [item, item] }, { items: [{ ...item, videoId: Number(VIDEO) }] },
    { items: [{ ...item, submittedId: '' }] }, { items: [{ ...item, submittedId: { toString: 'Exact_User' } }] },
    { items: [{ ...item, key: 'x\nsecret' }] }, { items: [{ ...item, expectedSecUid: 'wrong' }] }]) {
    await assert.rejects(() => collectAuthorisedDetail(bad, { enabled: true, runtime: f.rt }), { code: 'invalid_input' });
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(normalizeAuthorisedDetailInput({ items: [{ ...item, token: 'PRIVATE', enabled: true }] }), input);
});

test('response URL identity rejects origin, credentials, wrong/duplicate work, fragment and encoded parameter duplicates', () => {
  assert.equal(isExpectedAuthorisedDetailResponseUrl(url, VIDEO), true);
  for (const bad of [url.replace('www.douyin.com', 'evil.example'), url.replace('https:', 'http:'),
    url.replace('https://', 'https://user:pass@'), url.replace('.com/', '.com:444/'), url.replace('.com/', '.com:443/'),
    url.replace('www.douyin.com', '%77ww.douyin.com'), `${url}#x`, `${url}\n`,
    `${url}&aweme_id=${VIDEO}`, `${url}&%61weme_id=${VIDEO}`, url.replace(VIDEO, '7690702905876096105'),
    url.replace('detail/', 'other/'), url.replace('www.douyin.com', 'www.douyin.com.evil.example')]) {
    assert.equal(isExpectedAuthorisedDetailResponseUrl(bad, VIDEO), false);
  }
});

test('response projection matches actual unique/short text only and retains exact long IDs', () => {
  const raw = body(), before = structuredClone(raw);
  const projection = validateAuthorisedDetailResponse(raw, input);
  assert.deepEqual(raw, before); assert.equal(projection.aweme_detail.author.short_id, '0001234567890123456789');
  assert.equal(projection.aweme_detail.author.uid, UID); assert.equal(projection.aweme_detail.video, undefined);
  const byShort = { ...input, submittedId: '0001234567890123456789' };
  assert.equal(validateAuthorisedDetailResponse(raw, byShort).aweme_detail.aweme_id, VIDEO);
  assert.throws(() => validateAuthorisedDetailResponse(raw, { ...input, submittedId: UID }), { code: 'identity_mismatch' });
  assert.throws(() => validateAuthorisedDetailResponse(raw, { ...input, submittedId: 'private_unused_name' }), { code: 'identity_mismatch' });
  for (const mutate of [x => { x.status_code = false; }, x => { x.status_code = '0'; }, x => { x.status_code = 8; },
    x => { x.aweme_detail.aweme_id = Number(VIDEO); }, x => { x.aweme_detail.aweme_id = '7690702905876096105'; },
    x => { x.aweme_detail.author.uid = Number(UID); }, x => { x.aweme_detail.author.user_deleted = true; },
    x => { x.aweme_detail.author.unique_id = 'Exact_User\n'; }, x => { x.aweme_detail.author.unique_id = { value: 'Exact_User' }; }]) {
    const changed = body(); mutate(changed); assert.throws(() => validateAuthorisedDetailResponse(changed, input));
  }
});

test('natural exact main-frame detail produces a bounded safe proof only after registered cleanup', async () => {
  const f = runtime(), start = new Date().toISOString(), saved = structuredClone(f.state);
  const result = await f.collect(), end = new Date().toISOString();
  assert.equal(result.status, 'ok'); assert.equal(f.page.navigations, 1); assert.equal(f.page.reads, 1);
  assert.deepEqual(f.state, saved); assert.ok(f.calls.indexOf('register') < f.calls.indexOf('connect'));
  assert.ok(f.calls.indexOf('server.close') < f.calls.indexOf('released'));
  assert.equal(result.candidate.responseSha256Scope, AUTHORISED_DETAIL_HASH_SCOPE);
  assert.deepEqual(validateAuthorisedDetailResult(input, result, { startedAt: start, finishedAt: end }), result);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|cookie|storageState|play_addr|signature|ws:\/\//);
  listenersClosed(f.page);
});

for (const [status, code] of [[401, 'login_required'], [403, 'blocked'], [429, 'rate_limited'], [500, 'business_error']]) {
  test(`HTTP ${status} stops without body read, request-form retry or second navigation`, async () => {
    const f = runtime(page => page.respond({ status })); const result = await f.collect();
    assert.equal(result.status, 'unavailable'); assert.equal(result.errorCode, code);
    assert.equal(f.page.reads, 0); assert.equal(f.page.navigations, 1); assert.equal(result.candidate, undefined); listenersClosed(f.page);
  });
}

test('login/challenge natural navigation and JSON barriers never trigger automatic handling', async () => {
  for (const [value, code] of [['https://www.douyin.com/passport/login', 'login_required'], ['https://www.douyin.com/challenge/x', 'challenge_required']]) {
    const f = runtime(page => { page.move(value); page.respond(); });
    assert.equal((await f.collect()).errorCode, code); assert.equal(f.page.reads, 0); assert.equal(f.page.navigations, 1);
  }
  for (const [field, code] of [['need_login', 'login_required'], ['captcha_required', 'challenge_required'], ['verify_required', 'challenge_required']]) {
    const f = runtime(page => page.respond({ data: { ...body(), [field]: {} } }));
    assert.equal((await f.collect()).errorCode, code); assert.equal(f.page.reads, 1);
  }
});

test('wrong frame, unobserved request, redirected request, foreign work and non-GET are not evidence', async () => {
  for (const options of [{ requestEvent: false }, { request: { frame: {} } }, { request: { redirect: {} } },
    { request: { method: 'POST' } }, { value: url.replace(VIDEO, '7690702905876096105') }]) {
    const f = runtime(page => page.respond({ ...options, ...(options.request ? { request: page.request(options.request) } : {}) }));
    assert.equal((await f.collect({ timeoutMs: 60 })).errorCode, 'no_bound_response');
    assert.equal(f.page.reads, 0); listenersClosed(f.page);
  }
});

test('a refusal wins over a previously pending body and late JSON never changes the result', async () => {
  const late = deferred(), f = runtime(page => { page.respond({ text: () => late.promise }); page.respond({ status: 403 }); });
  const result = await f.collect(), before = JSON.stringify(result);
  assert.equal(result.errorCode, 'blocked'); late.resolve(JSON.stringify(body())); await sleep(1);
  assert.equal(JSON.stringify(result), before); listenersClosed(f.page);
});

test('body from a previous document generation cannot bind to the replacement document', async () => {
  const late = deferred(), f = runtime(page => { page.respond({ text: () => late.promise }); page.move(`https://www.douyin.com/video/${VIDEO}`); late.resolve(JSON.stringify(body())); });
  assert.equal((await f.collect({ timeoutMs: 60 })).errorCode, 'no_bound_response'); listenersClosed(f.page);
});

test('an already-observed slower JSON refusal or contradictory identity prevents a fast success', async () => {
  for (const [data, code] of [[{ ...body(), need_login: true }, 'login_required'],
    [{ ...body(), aweme_detail: { ...body().aweme_detail, author: { ...body().aweme_detail.author, sec_uid: `${SEC}Different` } } }, 'identity_mismatch']]) {
    const late = deferred(), f = runtime(page => { page.respond(); page.respond({ text: () => late.promise }); });
    let settled = false;
    const pending = f.collect().then(result => { settled = true; return result; });
    while (f.page.reads < 2) await sleep(1);
    assert.equal(settled, false);
    late.resolve(JSON.stringify(data));
    assert.equal((await pending).errorCode, code); listenersClosed(f.page);
  }
});

test('challenge iframe detail is not promoted to main-frame identity evidence', async () => {
  const f = runtime(page => {
    const frame = { url: () => 'https://www.douyin.com/challenge/test' };
    page.emit('framenavigated', frame);
    page.respond({ request: page.request({ frame }) });
  });
  assert.equal((await f.collect({ timeoutMs: 60 })).errorCode, 'no_bound_response');
  assert.equal(f.page.reads, 0); listenersClosed(f.page);
});

test('late launch and connect resources are closed without accepting identity or releasing unknown ownership', async () => {
  for (const phase of ['launchServer', 'connect']) {
    const opening = deferred(), f = runtime();
    f.rt.chromium[phase] = async () => { f.calls.push(`${phase}.pending`); return opening.promise; };
    const result = await f.collect({ timeoutMs: 60 });
    assert.equal(result.status, 'unavailable'); assert.equal(result.candidate, undefined);
    if (phase === 'launchServer') {
      assert.equal(f.calls.includes('register'), false); assert.equal(f.calls.includes('released'), false);
      opening.resolve(f.server);
    } else opening.resolve(f.browser);
    await sleep(5);
    assert.ok(f.calls.includes(phase === 'launchServer' ? 'server.close' : 'browser.close'));
    assert.equal(f.page.navigations, 0);
  }
});

test('body exceptions, invalid JSON and mismatched author emit fixed codes without upstream text', async () => {
  for (const options of [{ text: () => { throw new Error('PRIVATE_SECRET_URL'); } }, { text: () => '<html>PRIVATE_CAPTCHA</html>' },
    { data: { ...body(), aweme_detail: { ...body().aweme_detail, author: { ...body().aweme_detail.author, unique_id: 'other' } } } }]) {
    const f = runtime(page => page.respond(options)); const result = await f.collect();
    assert.equal(result.status, 'unavailable'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|other/);
  }
});

test('parent validator rechecks identity, hashes, timing and provenance and strips extra fields', async () => {
  const start = new Date().toISOString(), f = runtime(), result = await f.collect(), finish = new Date().toISOString();
  const options = { startedAt: start, finishedAt: finish };
  for (const mutate of [x => { x.key = 'other'; }, x => { x.videoId = '7690702905876096105'; }, x => { x.submittedId = 'other'; },
    x => { x.candidate.secUid += 'Other'; }, x => { x.candidate.responseSha256 = '0'.repeat(64); },
    x => { x.evidence.httpStatus = 403; }, x => { x.evidence.method = 'POST'; }, x => { x.evidence.kind = 'rendered-page'; },
    x => { x.evidence.response.aweme_detail.author.unique_id = 'other'; }, x => { x.provenance.noChallengeBypass = false; },
    x => { x.evidence.observedAt = '2000-01-01T00:00:00.000Z'; }, x => { x.requestFinishedAt = '2099-01-01T00:00:00.000Z'; }]) {
    const changed = structuredClone(result); mutate(changed);
    assert.throws(() => validateAuthorisedDetailResult(input, changed, options));
  }
  const extra = structuredClone(result); extra.cookie = 'PRIVATE'; extra.candidate.rawError = 'PRIVATE'; extra.evidence.response.headers = { cookie: 'PRIVATE' };
  assert.doesNotMatch(JSON.stringify(validateAuthorisedDetailResult(input, extra, options)), /PRIVATE|rawError|headers/);
});

test('state errors never launch, and uncertain cleanup erases otherwise successful identity', async () => {
  const f = runtime(undefined, { readState: async () => { throw Object.assign(new Error('PRIVATE_PATH'), { code: 'session_required' }); } });
  assert.equal((await f.collect()).errorCode, 'session_required'); assert.deepEqual(f.calls, []);
  const badCleanup = runtime(); badCleanup.server.close = async () => { throw new Error('PRIVATE_CLEANUP'); };
  badCleanup.server.kill = async () => { throw new Error('PRIVATE_KILL'); };
  const result = await badCleanup.collect();
  assert.equal(result.errorCode, 'cleanup_uncertain'); assert.equal(result.candidate, undefined); assert.ok(!badCleanup.calls.includes('released'));
});

test('aborted collection does not read state or launch, and no-response deadline cleans resources', async () => {
  const controller = new AbortController(); controller.abort(); const f = runtime();
  assert.equal((await f.collect({ signal: controller.signal })).errorCode, 'cancelled'); assert.ok(!f.calls.includes('launchServer'));
  const idle = runtime(() => {}), start = performance.now(), result = await idle.collect({ timeoutMs: 60 });
  assert.equal(result.errorCode, 'no_bound_response'); assert.ok(performance.now() - start < 500); assert.ok(idle.calls.includes('released')); listenersClosed(idle.page);
});

test('CLI cannot launch standalone even with uploaded enable flags or environment enabled', () => {
  const script = fileURLToPath(new URL('../scripts/douyin_authorised_detail.mjs', import.meta.url));
  for (const enabled of ['0', '1']) {
    const env = { ...process.env, DOUYIN_AUTHORISED_DETAIL_ENABLED: enabled }; delete env.MCN_BROWSER_OWNERSHIP_NONCE;
    const result = spawnSync(process.execPath, [script], { env, input: JSON.stringify({ ...payload(), enabled: true }), encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1); assert.deepEqual(JSON.parse(result.stdout), { ok: false, errorCode: enabled === '1' ? 'ownership_required' : 'disabled' });
    assert.equal(result.stderr, '');
  }
});

test('share input is exactly one literal official HTTPS token, mutually exclusive with direct video', () => {
  assert.deepEqual(shareInput, { key: item.key, shareUrl: SHARE, submittedId: 'exact_user' });
  for (const shareUrl of [SHARE.replace('https:', 'http:'), `${SHARE}?aweme_id=${VIDEO}`, `${SHARE}#x`,
    SHARE.replace('.com/', '.com:443/'), SHARE.replace('v.douyin.com', '%76.douyin.com'),
    SHARE.replace('v.douyin.com', 'v.douyin.com.evil.test'), SHARE.replace('https://', 'https://user@'),
    SHARE.replace('7W6k5-kdoq8', '%37W6k5-kdoq8'), `${SHARE}extra`, `${SHARE}\n`, {}, '']) {
    assert.throws(() => normalizeAuthorisedDetailInput({ items: [{ ...shareInput, shareUrl }] }), { code: 'invalid_input' });
  }
  assert.throws(() => normalizeAuthorisedDetailInput({ items: [{ ...shareInput, videoId: VIDEO }] }), { code: 'invalid_input' });
});

test('a single share navigation binds observed official final work, strips tracking, and retains original input', async () => {
  for (const finalUrl of [`https://www.douyin.com/video/${VIDEO}?tracking=PRIVATE_TRACKING&aweme_id=${VIDEO}`,
    `https://www.iesdouyin.com/share/video/${VIDEO}/?tracking=PRIVATE_TRACKING`]) {
    const f = runtime(page => { assert.equal(page.url(), SHARE); page.move(finalUrl); page.respond(); });
    const start = new Date().toISOString(), result = await collectShare(f), end = new Date().toISOString();
    assert.equal(result.status, 'ok'); assert.equal(result.shareUrl, SHARE); assert.equal(result.key, item.key);
    assert.equal(result.videoId, VIDEO); assert.equal(result.evidence.requestedShareUrl, SHARE);
    assert.equal(result.evidence.finalUrl, finalUrl.split('?')[0]); assert.equal(result.evidence.finalVideoId, VIDEO);
    assert.equal(result.evidence.finalUrlSha256, createHash('sha256').update(finalUrl).digest('hex'));
    assert.equal(result.evidence.finalUrlScope, 'observed-origin-path');
    assert.deepEqual(validateAuthorisedDetailResult(shareInput, result, { startedAt: start, finishedAt: end }), result);
    assert.equal(f.page.navigations, 1); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|tracking=/); listenersClosed(f.page);
  }
});

test('unresolved shares cannot use unrelated details or guess a work from the share token', async () => {
  const f = runtime(page => page.respond());
  const result = await collectShare(f, { timeoutMs: 60 });
  assert.equal(result.errorCode, 'no_bound_response'); assert.equal(result.videoId, undefined);
  assert.equal(result.candidate, undefined); assert.equal(f.page.reads, 0); assert.equal(f.page.navigations, 1);
});

test('share refuses cross-domain intermediates, wrong tokens, work changes, conflicting queries and barriers', async () => {
  for (const [intermediate, errorCode] of [
    ['https://evil.example/redirect', 'navigation_error'], ['https://v.douyin.com/AnotherToken/', 'navigation_error'],
    [`https://www.douyin.com:443/video/${VIDEO}`, 'navigation_error'], [`https://%77ww.douyin.com/video/${VIDEO}`, 'navigation_error'],
    [`https://www.douyin.com/video/${VIDEO}?modal_id=7690702905876096105`, 'navigation_error'],
    [`https://www.douyin.com/video/${VIDEO}?aweme_id=${VIDEO}&aweme_id=7690702905876096105`, 'navigation_error'],
    ['https://www.douyin.com/challenge/test', 'challenge_required'], ['https://login.douyin.com/login', 'login_required'],
  ]) {
    const f = runtime(page => { page.move(intermediate); page.move(`https://www.douyin.com/video/${VIDEO}`); page.respond(); });
    const result = await collectShare(f);
    assert.equal(result.errorCode, errorCode, intermediate); assert.equal(result.candidate, undefined);
    assert.equal(f.page.navigations, 1); assert.equal(f.page.reads, 0);
  }
  const changed = runtime(page => { page.move('https://www.douyin.com/video/7690702905876096105'); page.move(`https://www.douyin.com/video/${VIDEO}`); page.respond(); });
  assert.equal((await collectShare(changed)).errorCode, 'navigation_error');
});

test('share repeated same-work document commits only accept the current generation', async () => {
  const old = deferred(), f = runtime(page => {
    page.move(`https://www.iesdouyin.com/share/video/${VIDEO}/`);
    page.respond({ text: () => old.promise });
    page.move(`https://www.douyin.com/video/${VIDEO}`); page.respond();
    old.resolve(JSON.stringify({ ...body(), need_login: true }));
  });
  const result = await collectShare(f); assert.equal(result.status, 'ok');
  assert.equal(result.evidence.finalUrl, `https://www.douyin.com/video/${VIDEO}`); assert.equal(f.page.navigations, 1);
});

test('share HTTP redirects which never commit a document cannot conceal foreign or conflicting work hops', async () => {
  for (const intermediate of ['https://evil.example/redirect', 'https://v.douyin.com/OtherToken/',
    'https://www.douyin.com/video/7690702905876096105']) {
    const f = runtime(page => {
      const redirect = page.request({ value: intermediate, navigation: true });
      page.respond({ value: intermediate, request: redirect, status: 302 });
      page.move(`https://www.douyin.com/video/${VIDEO}`); page.respond();
    });
    const result = await collectShare(f);
    assert.equal(result.errorCode, 'navigation_error'); assert.equal(f.page.reads, 0); assert.equal(f.page.navigations, 1);
  }
  const allowed = runtime(page => {
    const value = `https://www.iesdouyin.com/share/video/${VIDEO}/`;
    page.respond({ value, request: page.request({ value, navigation: true }), status: 302 });
    page.move(`https://www.douyin.com/video/${VIDEO}`); page.respond();
  });
  assert.equal((await collectShare(allowed)).status, 'ok');
});

test('share inspects the navigation redirect chain even when an intermediate event was not observed', async () => {
  for (const badHop of ['https://evil.example/redirect', 'https://www.douyin.com/challenge/private',
    'https://www.douyin.com/video/7690702905876096105']) {
    const f = runtime(page => {
      const original = page.request({ value: SHARE, navigation: true });
      const hidden = page.request({ value: badHop, navigation: true, redirect: original });
      const finalUrl = `https://www.douyin.com/video/${VIDEO}`;
      const final = page.request({ value: finalUrl, navigation: true, redirect: hidden });
      page.respond({ value: finalUrl, request: final });
      page.move(finalUrl); page.respond();
    });
    const result = await collectShare(f);
    assert.equal(result.status, 'unavailable'); assert.equal(result.candidate, undefined); assert.equal(f.page.reads, 0);
  }
});

test('share parent validation rejects altered source/final/work binding and unsanitized final URL', async () => {
  const f = runtime(page => { page.move(`https://www.douyin.com/video/${VIDEO}`); page.respond(); });
  const start = new Date().toISOString(), result = await collectShare(f), end = new Date().toISOString();
  for (const mutate of [x => { x.shareUrl = 'https://v.douyin.com/OtherToken/'; },
    x => { x.evidence.requestedShareUrl += 'other'; }, x => { x.evidence.finalVideoId = '7690702905876096105'; },
    x => { x.evidence.finalUrl += '?tracking=PRIVATE'; }, x => { x.evidence.finalUrlSha256 = 'not-hash'; },
    x => { x.evidence.finalUrlScope = 'platform-signature'; }, x => { x.videoId = '7690702905876096105'; },
    x => { x.evidence.finalUrl = x.evidence.finalUrl.replace('www.douyin.com', 'evil.test'); }]) {
    const changed = structuredClone(result); mutate(changed);
    assert.throws(() => validateAuthorisedDetailResult(shareInput, changed, { startedAt: start, finishedAt: end }));
  }
});
