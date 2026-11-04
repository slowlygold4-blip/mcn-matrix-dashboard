import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchRemoteAuthorPosts} from '../lib/providers/remote-author-posts-http.mjs';
import {normalizeRemoteWorkPage} from '../lib/remote-work-observation.mjs';

const ORIGIN = 'https://demo.douyin.wtf';
const SEC = 'MS4wLjABAAAARemoteTransportFixture123';
const NOW = Date.parse('2026-11-04T11:00:00.000Z');
const PASSWORD = 'PRIVATE-DEMO-PASSWORD';
const SESSION = 'PRIVATE-SESSION-VALUE';
const TOKEN = 'PRIVATE-BEARER-TOKEN';
const iso = value => new Date(value).toISOString();
const options = {sourceOrigin: ORIGIN, secUid: SEC, authMode: 'demo', now: () => NOW};
const json = (body, {status = 200, headers = {}} = {}) => new Response(JSON.stringify(body), {
  status, headers: {'Content-Type': 'application/json', ...headers},
});
const bootstrap = () => json({success: true, data: {enabled: true, username: 'demo', password: PASSWORD, api_key: TOKEN}});
const login = () => json({success: true}, {headers: {'Set-Cookie': `dtk_session=${SESSION}; Path=/; Secure; HttpOnly`}});
const logout = () => json({success: true}, {headers: {'Set-Cookie': 'dtk_session=; Path=/; Max-Age=0'}});
function page() {
  return {success: true, meta: {endpoint: 'douyin.author_posts', cached: false, request_id: 'test-request', guest_fallback: true},
    data: {has_more: false, cursor: null, items: [{platform: 'douyin', content_id: '7300000000000000001',
      title: 'Fixture', created_at: '2026-11-03T01:00:00Z', fetched_at: iso(NOW), is_deleted: false, is_private: false,
      author: {uid: SEC, sec_uid: SEC, nickname: 'Fixture'}, stats: {digg_count: 0, comment_count: null, share_count: 2, collect_count: 3}}]}};
}
function sequence(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({url, init});
    const next = responses[calls.length - 1];
    assert.notEqual(next, undefined, 'No retry or unexpected extra request');
    return typeof next === 'function' ? next(url, init) : next;
  };
  return {calls, fetchImpl};
}
function noSecrets(value) {
  const text = JSON.stringify(value);
  for (const secret of [PASSWORD, SESSION, TOKEN, 'SECRET-IN-ERROR']) assert.equal(text.includes(secret), false);
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await Promise.resolve(); }
  assert.fail('Expected mocked request did not start');
}

test('demo uses only in-memory login, exactly one page, logout, and admission-compatible evidence', async () => {
  const raw = page();
  raw.secret = TOKEN; raw.meta.cookie = SESSION; raw.data.items[0].media = {token: TOKEN};
  raw.data.items[0].author.cookies = SESSION; raw.data.items[0].stats.play_count = 12345;
  const mock = sequence([bootstrap(), login(), json(raw), logout()]);
  const result = await fetchRemoteAuthorPosts({...options, fetchImpl: mock.fetchImpl});
  assert.deepEqual(mock.calls.map(c => new URL(c.url).pathname), [
    '/api/v1/auth/demo', '/api/v1/auth/login', '/api/v1/douyin/user/posts', '/api/v1/auth/logout',
  ]);
  for (const {init} of mock.calls) {
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
  }
  assert.equal(mock.calls[0].init.headers.Cookie, undefined);
  assert.deepEqual(JSON.parse(mock.calls[1].init.body), {username: 'demo', password: PASSWORD});
  assert.equal(mock.calls[2].init.headers.Cookie, `dtk_session=${SESSION}`);
  assert.equal(mock.calls[3].init.headers.Cookie, `dtk_session=${SESSION}`);
  assert.deepEqual(Object.fromEntries(new URL(mock.calls[2].url).searchParams), {
    sec_user_id: SEC, count: '20', wait: '25', refresh: 'false',
  });
  assert.deepEqual(result.transport, {totalRequests: 4, authRequests: 3, businessRequests: 1,
    logoutAttempted: true, logoutStatus: 200, credentialsCleared: true});
  assert.deepEqual(result.receipt.meta, {endpoint: 'douyin.author_posts', cached: false,
    request_id: 'test-request', guest_fallback: true});
  assert.equal(result.receipt.data.cursor, null);
  const normalized = normalizeRemoteWorkPage(result.receipt, {secUid: SEC, uid: '123456789'}, {now: NOW});
  assert.equal(normalized.posts[0].likes, 0);
  assert.equal(normalized.posts[0].comments, null);
  assert.equal(normalized.posts[0].plays, null);
  assert.equal(normalized.evidence.listEvidence.guestFallback, true);
  assert.equal(normalized.evidence.dailyPublicationCountConfirmed, false);
  noSecrets(result);
});

test('generic approved HTTPS origin uses caller bearer only; business clock excludes authentication', async () => {
  const raw = page(), origin = 'https://operator.example';
  delete raw.meta.guest_fallback; delete raw.data.cursor;
  const mock = sequence([json(raw)]);
  const result = await fetchRemoteAuthorPosts({...options, sourceOrigin: origin, authMode: 'bearer', bearerToken: TOKEN,
    fetchImpl: mock.fetchImpl});
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(mock.calls[0].init.headers.Cookie, undefined);
  assert.equal(result.transport.authRequests, 0);
  assert.equal(Object.hasOwn(result.receipt.meta, 'guest_fallback'), false);
  assert.equal(Object.hasOwn(result.receipt.data, 'cursor'), false);
  normalizeRemoteWorkPage(result.receipt, {secUid: SEC, uid: '123456789'}, {now: NOW, sourceOrigin: origin});
  noSecrets(result);

  let clock = NOW;
  const timed = sequence([
    () => { clock += 10_000; return bootstrap(); },
    () => { clock += 10_000; return login(); },
    () => { clock += 1000; const value = page(); value.data.items[0].fetched_at = iso(clock); return json(value); },
    () => { clock += 1000; return logout(); },
  ]);
  const timedResult = await fetchRemoteAuthorPosts({...options, now: () => clock, fetchImpl: timed.fetchImpl});
  assert.equal(timedResult.receipt.requestStartedAt, iso(NOW + 20_000));
  assert.equal(timedResult.receipt.requestFinishedAt, iso(NOW + 21_000));
  normalizeRemoteWorkPage(timedResult.receipt, {secUid: SEC, uid: '123456789'}, {now: clock});
});

test('configuration never implicitly authorizes demo, other origins, redirects or malformed credentials', async t => {
  const cases = [
    {sourceOrigin: undefined}, {sourceOrigin: 'http://demo.douyin.wtf'}, {sourceOrigin: ORIGIN + '/'},
    {sourceOrigin: 'https://demo.douyin.wtf.evil.example'}, {sourceOrigin: 'https://user:pass@demo.douyin.wtf'},
    {sourceOrigin: ORIGIN + ':444'}, {sourceOrigin: ORIGIN + '/path'}, {sourceOrigin: ORIGIN + '?secret=hidden'},
    {authMode: undefined}, {secUid: 'not-an-id'}, {authMode: 'bearer', bearerToken: 'bad\nvalue'},
    {authMode: 'bearer'}, {bearerToken: TOKEN}, {now: () => NaN},
  ];
  for (let i = 0; i < cases.length; i++) await t.test(String(i), async () => {
    let called = 0;
    await assert.rejects(fetchRemoteAuthorPosts({...options, ...cases[i], fetchImpl: async () => { called++; }}), error => {
      assert.equal(error.code, 'invalid_configuration'); assert.equal(error.transport.totalRequests, 0);
      assert.equal(error.transport.credentialsCleared, true); noSecrets(error); return true;
    });
    assert.equal(called, 0);
  });
});

test('HTTP failures are classified, no retry, Retry-After preserved, upstream code strictly allowlisted', async t => {
  const cases = [[401, 'login_required'], [403, 'forbidden'], [429, 'rate_limited'],
    [500, 'upstream_unavailable'], [503, 'upstream_unavailable'], [302, 'redirect_refused'], [202, 'pending']];
  for (const [status, expected] of cases) await t.test(String(status), async () => {
    const mock = sequence([json({success: false, error: {code: 'SECRET-IN-ERROR', message: TOKEN}},
      {status, headers: {'Retry-After': '37'}})]);
    await assert.rejects(fetchRemoteAuthorPosts({...options, authMode: 'bearer', bearerToken: TOKEN, fetchImpl: mock.fetchImpl}), error => {
      assert.equal(error.code, expected); assert.equal(error.httpStatus, status);
      assert.equal(error.upstreamCode, null); assert.equal(error.retryAfterSeconds, 37);
      assert.equal(error.transport.businessRequests, 1); assert.equal(error.transport.totalRequests, 1);
      assert.equal(Object.hasOwn(error, 'cause'), false); noSecrets(error); return true;
    });
  });
  const mock = sequence([bootstrap(), login(), json({success: false, error: {code: 'ENDPOINT_CIRCUIT_OPEN', message: TOKEN}},
    {status: 503, headers: {'Retry-After': new Date(NOW + 90_000).toUTCString()}}), logout()]);
  await assert.rejects(fetchRemoteAuthorPosts({...options, fetchImpl: mock.fetchImpl}), error => {
    assert.equal(error.code, 'circuit_open'); assert.equal(error.upstreamCode, 'ENDPOINT_CIRCUIT_OPEN');
    assert.equal(error.retryAfterSeconds, 90); assert.equal(error.transport.totalRequests, 4);
    assert.equal(error.transport.logoutStatus, 200); noSecrets(error); return true;
  });
});

test('business error inside 200 is not success; login failures never issue business request', async () => {
  const mock = sequence([json({success: false, error: {code: 'IDENTITY_LOGIN_REQUIRED', message: TOKEN}})]);
  await assert.rejects(fetchRemoteAuthorPosts({...options, authMode: 'bearer', bearerToken: TOKEN, fetchImpl: mock.fetchImpl}),
    {code: 'login_required', upstreamCode: 'IDENTITY_LOGIN_REQUIRED'});
  for (const responses of [
    [json({data: {enabled: false}})], [bootstrap(), json({success: false}, {status: 401})],
    [bootstrap(), json({success: true}), logout()],
  ]) {
    const failed = sequence(responses);
    await assert.rejects(fetchRemoteAuthorPosts({...options, fetchImpl: failed.fetchImpl}), error => {
      assert.equal(error.code, 'login_required'); assert.equal(error.transport.businessRequests, 0);
      noSecrets(error); return true;
    });
  }
});

test('response is capped at 1MB by declared length and actual streamed bytes', async t => {
  for (const declared of [true, false]) await t.test(String(declared), async () => {
    let cancelled = false;
    const body = new ReadableStream({start(controller) {
      controller.enqueue(new Uint8Array(700_000)); controller.enqueue(new Uint8Array(400_000));
    }, cancel() { cancelled = true; }});
    const response = new Response(body, {headers: declared ? {'Content-Length': '1048577'} : {}});
    const mock = sequence([response]);
    await assert.rejects(fetchRemoteAuthorPosts({...options, authMode: 'bearer', bearerToken: TOKEN, fetchImpl: mock.fetchImpl}),
      {code: 'response_too_large'});
    assert.equal(cancelled, true); assert.equal(mock.calls.length, 1);
  });
});

test('abort before start makes zero requests; abort during page still clears and logs out once', async () => {
  const before = new AbortController(); before.abort(TOKEN);
  const unused = sequence([]);
  await assert.rejects(fetchRemoteAuthorPosts({...options, signal: before.signal, fetchImpl: unused.fetchImpl}), error => {
    assert.equal(error.code, 'cancelled'); assert.equal(error.transport.totalRequests, 0); noSecrets(error); return true;
  });
  const during = new AbortController();
  const mock = sequence([bootstrap(), login(), () => { during.abort(TOKEN); return new Promise(() => {}); }, logout()]);
  await assert.rejects(fetchRemoteAuthorPosts({...options, signal: during.signal, fetchImpl: mock.fetchImpl}), error => {
    assert.equal(error.code, 'cancelled'); assert.equal(error.transport.totalRequests, 4);
    assert.equal(error.transport.logoutStatus, 200); assert.equal(error.transport.credentialsCleared, true);
    noSecrets(error); return true;
  });
});

test('50-second total deadline also bounds a fetch implementation which ignores AbortSignal', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const mock = sequence([() => new Promise(() => {})]);
  const promise = fetchRemoteAuthorPosts({...options, authMode: 'bearer', bearerToken: TOKEN, fetchImpl: mock.fetchImpl});
  const checked = assert.rejects(promise, error => {
    assert.equal(error.code, 'timeout'); assert.equal(error.transport.totalRequests, 1);
    assert.equal(error.transport.credentialsCleared, true); return true;
  });
  await until(() => mock.calls.length === 1);
  t.mock.timers.tick(50_000);
  await checked;
});

test('50-second deadline also bounds stalled response bodies', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let cancelled = false;
  const body = new ReadableStream({cancel() { cancelled = true; }});
  const mock = sequence([new Response(body)]);
  const promise = fetchRemoteAuthorPosts({...options, authMode: 'bearer', bearerToken: TOKEN, fetchImpl: mock.fetchImpl});
  const checked = assert.rejects(promise, {code: 'timeout'});
  await until(() => body.locked);
  t.mock.timers.tick(50_000);
  await checked; assert.equal(cancelled, true);
});

test('logout is bounded by 5 seconds and cannot discard successful data', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const mock = sequence([bootstrap(), login(), json(page()), () => new Promise(() => {})]);
  const promise = fetchRemoteAuthorPosts({...options, fetchImpl: mock.fetchImpl});
  await until(() => mock.calls.length === 4);
  t.mock.timers.tick(5000);
  const result = await promise;
  assert.equal(result.receipt.data.items.length, 1);
  assert.equal(result.transport.logoutAttempted, true); assert.equal(result.transport.logoutStatus, null);
  assert.equal(result.transport.credentialsCleared, true); noSecrets(result);
});

test('cleanup shares the original 50-second ceiling rather than adding 5 more seconds', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let finishPage;
  const mock = sequence([bootstrap(), login(), () => new Promise(resolve => { finishPage = resolve; }),
    () => new Promise(() => {})]);
  const promise = fetchRemoteAuthorPosts({...options, fetchImpl: mock.fetchImpl});
  await until(() => typeof finishPage === 'function');
  t.mock.timers.tick(48_000);
  finishPage(json(page()));
  await until(() => mock.calls.length === 4);
  t.mock.timers.tick(2000);
  const result = await promise;
  assert.equal(result.transport.totalRequests, 4);
  assert.equal(result.transport.logoutStatus, null);
  assert.equal(result.receipt.data.items.length, 1);
});

test('network and invalid payload failures expose no raw text, while session cleanup survives malformed login JSON', async () => {
  const mock = sequence([() => { throw new Error(`https://private.invalid/?token=${TOKEN} Cookie=${SESSION}`); }]);
  await assert.rejects(fetchRemoteAuthorPosts({...options, authMode: 'bearer', bearerToken: TOKEN, fetchImpl: mock.fetchImpl}), error => {
    assert.equal(error.code, 'network_error'); noSecrets(error); return true;
  });
  const malformed = sequence([bootstrap(), new Response('SECRET-IN-ERROR', {
    headers: {'Set-Cookie': `dtk_session=${SESSION}; Path=/; Secure`},
  }), logout()]);
  await assert.rejects(fetchRemoteAuthorPosts({...options, fetchImpl: malformed.fetchImpl}), error => {
    assert.equal(error.code, 'invalid_response'); assert.equal(error.transport.logoutStatus, 200);
    assert.equal(error.transport.businessRequests, 0); noSecrets(error); return true;
  });
  const raw = page(); raw.meta.request_id = {cookie: SESSION};
  const nested = sequence([json(raw)]);
  await assert.rejects(fetchRemoteAuthorPosts({...options, authMode: 'bearer', bearerToken: TOKEN, fetchImpl: nested.fetchImpl}),
    {code: 'invalid_response'});
});

test('foreign-domain cookies are never forwarded, and missing likes are never manufactured', async () => {
  const foreign = sequence([bootstrap(), json({success: true}, {
    headers: {'Set-Cookie': `dtk_session=${SESSION}; Domain=douyin.wtf; Path=/`},
  }), logout()]);
  await assert.rejects(fetchRemoteAuthorPosts({...options, fetchImpl: foreign.fetchImpl}), {code: 'login_required'});
  for (const call of foreign.calls) assert.equal(call.init.headers.Cookie, undefined);
  const raw = page(); raw.data.items[0].stats.digg_count = null;
  const mock = sequence([json(raw)]);
  const result = await fetchRemoteAuthorPosts({...options, authMode: 'bearer', bearerToken: TOKEN, fetchImpl: mock.fetchImpl});
  assert.equal(result.receipt.data.items[0].stats.digg_count, null);
  assert.throws(() => normalizeRemoteWorkPage(result.receipt, {secUid: SEC, uid: '123456789'}, {now: NOW}),
    {code: 'REMOTE_WORK_OBSERVATION_INVALID'});
});
