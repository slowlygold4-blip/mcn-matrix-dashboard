import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { authorListReadiness, probeOfficialAuthorList } from '../lib/douyin-open-api-probe.mjs';
const input = { clientToken: 'clt.fixture-only', authorHandle: 'fixture_author',
  scopes: ['ma.self_mount_video.item_list'], accountKey: 'fixture:author' };
const now = '2026-10-30T01:00:00.000Z', millis = Date.parse(now), cid = '7660369906369629476';
const work = (id = cid, extra = {}) => ({ item_id: 7660369906369629476,
  video_link: `https://www.douyin.com/video/${id}`, create_time: '2026-10-29 10:30:00', ...extra });
const page = (list = [work()], extra = {}) => ({ err_no: 0,
  data: { user_publish_item_list: list, has_more: false, max_cursor: 0, ...extra } });
const run = (body, options = {}, params = {}) => probeOfficialAuthorList({ ...input, ...params }, {
  clock: () => now, fetchImpl: async () => new Response(JSON.stringify(body)), ...options });

test('author-list scope/client token/handle differ from user open_id and validate before transport', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; throw Error('no request expected'); };
  for (const clientToken of ['', 'act.user-token', 'clt.bad\nvalue'])
    await assert.rejects(run(page(), { fetchImpl }, { clientToken }), { code: 'authorization_required' });
  await assert.rejects(run(page(), { fetchImpl }, { scopes: ['video.list', 'ma.video.bind'] }), { code: 'scope_required' });
  for (const authorHandle of ['', 'https://evil.test', 'a\nb', 'a'.repeat(65)])
    await assert.rejects(run(page(), { fetchImpl }, { authorHandle }), { code: 'invalid_input' });
  for (const maxPages of [0, 4, 1.5])
    await assert.rejects(run(page(), { fetchImpl }, { maxPages }), { code: 'invalid_input' });
  await assert.rejects(run(page(), { fetchImpl, clock: () => 'invalid' }), { code: 'invalid_clock' });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(run(page(), { fetchImpl, signal: abort.signal }), { code: 'cancelled' });
  assert.equal(calls, 0); assert.equal(authorListReadiness(input).authorBindingVerified, false);
});

test('only fixed official POST uses author handle in JSON, never open_id or cookie', async () => {
  const result = await run(page(), { fetchImpl: async (url, options) => {
    assert.equal(url.href, 'https://open.douyin.com/aweme/v1/video/self/get_user_video_list/');
    assert.equal(options.headers['access-token'], input.clientToken);
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit'); assert.equal(options.headers.Cookie, undefined);
    assert.deepEqual(JSON.parse(options.body), { aweme_id: input.authorHandle, count: 10, cursor: 0 });
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(JSON.stringify(page()));
  } });
  assert.equal(result.videos[0].publicContentId, cid);
  assert.equal(result.videos[0].officialItemId, null); // unsafe numeric int64 is never rounded into an ID
  assert.equal(result.videos[0].publishedAt, '2026-10-29T02:30:00.000Z');
  assert.equal(result.videos[0].observedAt, now);
  for (const key of ['likes', 'comments', 'shares', 'collects', 'plays']) assert.equal(result.videos[0][key], null);
  assert.equal(result.videos[0].plays_source, 'unavailable');
  assert.equal(result.recentWindowPaginationExhausted, true);
  assert.equal(result.allAuthorWorksCollected, false); assert.equal(result.identityBindingVerified, false);
  assert.equal(result.productionAdmitted, false); assert.equal(result.modelCalls, 0); assert.equal(result.databaseWrites, 0);
  assert.equal(JSON.stringify(result).includes(input.clientToken), false);
});

test('bounded pagination deduplicates overlapping IDs and declares the budget cutoff', async () => {
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls++;
    assert.equal(JSON.parse(options.body).cursor, calls === 1 ? 0 : millis - 86400000);
    return new Response(JSON.stringify(calls === 1
      ? page([work()], { has_more: true, max_cursor: millis - 86400000 })
      : page([work(), work('7660369906369629477')], { has_more: true, max_cursor: millis - 2 * 86400000 })));
  };
  const result = await run(null, { fetchImpl }, { maxPages: 2 });
  assert.equal(calls, 2); assert.equal(result.videos.length, 2);
  assert.equal(result.recentWindowPaginationExhausted, false);
  assert.equal(result.nextCursor, millis - 2 * 86400000); assert.equal(result.allAuthorWorksCollected, false);
});

test('missing list, fake empty, nonboolean more, repeated/future/out-of-window cursors fail closed', async () => {
  for (const data of [{}, { user_publish_item_list: [], max_cursor: 0, has_more: 0 },
    { user_publish_item_list: [], max_cursor: 0, has_more: true }])
    await assert.rejects(run({ err_no: 0, data }), { code: 'has_more' in data && data.has_more === true ? 'invalid_pagination' : 'invalid_response' });
  for (const next of [0, millis + 1, millis - 31 * 86400000])
    await assert.rejects(run(page([work()], { has_more: true, max_cursor: next })), { code: 'invalid_pagination' });
  let calls = 0;
  await assert.rejects(run(null, { fetchImpl: async () => { calls++; return new Response(JSON.stringify(
    page([work()], { has_more: true, max_cursor: millis - 86400000 }))); } }, { maxPages: 3 }), { code: 'invalid_pagination' });
  assert.equal(calls, 2);
});

test('bad public links, metadata conflict and invalid dates never create false identity/date evidence', async () => {
  for (const video_link of ['http://www.douyin.com/video/' + cid, 'https://evil.test/video/' + cid,
    'https://www.douyin.com/video/' + cid + '?secret=x', 'https://www.douyin.com/user/' + cid])
    await assert.rejects(run(page([work(cid, { video_link })])), { code: 'item_identity_mismatch' });
  await assert.rejects(run(page([work(), work(cid, { create_time: '2026-10-28 10:30:00' })])), { code: 'conflicting_content' });
  for (const create_time of ['2026-02-30 12:00:00', '2027-01-01 00:00:00', '', 0])
    assert.equal((await run(page([work(cid, { create_time })]))).videos[0].publishedAt, null);
  assert.equal((await run(page([work(cid, { item_id: '7660369906369629476' })]))).videos[0].officialItemId, cid);
});

test('HTTP/API rejection has fixed error codes, no retry, raw error or redirect leakage', async () => {
  for (const [status, code] of [[401, 'authorization_required'], [403, 'permission_denied'],
    [429, 'rate_limited'], [302, 'upstream_http_error'], [500, 'upstream_http_error']]) {
    let calls = 0;
    await assert.rejects(run(null, { fetchImpl: async () => {
      calls++; return new Response('private', { status, headers: { location: 'https://evil.test' } });
    } }), { code, message: code }); assert.equal(calls, 1);
  }
  await assert.rejects(run({ err_no: 29003029, err_msg: input.clientToken }), error =>
    error.code === 'platform_error' && error.officialErrorCode === 29003029 && !error.message.includes(input.clientToken));
  await assert.rejects(run({ data: {} }), { code: 'invalid_response' });
  await assert.rejects(run(null, { fetchImpl: async () => { throw Error('secret'); } }), { code: 'network_error', message: 'network_error' });
  await assert.rejects(run(null, { fetchImpl: async () => new Response('x'.repeat(128 * 1024 + 1)) }), { code: 'response_too_large' });
});

test('CLI readiness needs no browser, open_id, network or secret output', () => {
  const result = spawnSync(process.execPath, ['scripts/probe-douyin-open-api.mjs', '--author-list'], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', env: { ...process.env,
      DOUYIN_CLIENT_TOKEN: input.clientToken, DOUYIN_AUTHOR_HANDLE: input.authorHandle,
      DOUYIN_CLIENT_SCOPES: input.scopes[0] },
  });
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout); assert.equal(body.api, 'bound-author-list');
  assert.equal(body.clientTokenPresent, true); assert.equal(body.authorHandleValid, true);
  assert.equal(body.networkRequests, 0); assert.equal(body.modelCalls, 0); assert.equal(body.databaseWrites, 0);
  assert.equal(result.stdout.includes(input.clientToken), false);
});
