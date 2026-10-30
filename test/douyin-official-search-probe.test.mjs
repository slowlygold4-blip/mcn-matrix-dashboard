import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { officialSearchReadiness, probeOfficialSearch } from '../lib/douyin-official-search-probe.mjs';

const input = { clientToken: 'clt.fixture-only', deviceId: '8241677744935186821',
  keyword: '#fixture_topic', scopes: ['aweme.dy.video_search'] };
const now = '2026-10-30T02:00:00.000Z';
const id = '7471252140422401337';
const item = (extra = {}) => ({ item_id: id, link: `https://www.douyin.com/video/${id}`,
  title: 'fixture title', nickname: 'fixture nickname', create_time: 1739536450,
  statistics: { digg_count: 0 }, ...extra });
const page = (list = [item()], extra = {}) => ({ err_no: 0,
  data: { data: { cursor: 2, has_more: true, search_id: 'fixture_search', video_list: list, ...extra } } });
const run = (body = page(), options = {}, params = {}) => probeOfficialSearch({ ...input, ...params }, {
  clock: () => now, fetchImpl: async () => new Response(JSON.stringify(body)), ...options });

test('search validates real integration inputs without inventing device IDs or sending requests', async () => {
  let calls = 0; const opts = { fetchImpl: async () => { calls++; throw Error('not reached'); } };
  for (const clientToken of ['', 'act.wrong-type', 'clt.bad\nvalue'])
    await assert.rejects(run(page(), opts, { clientToken }), { code: 'authorization_required' });
  await assert.rejects(run(page(), opts, { scopes: ['video.list'] }), { code: 'scope_required' });
  for (const deviceId of ['', '0', '01', 8241677744935186821, '9223372036854775808', '1\n'])
    await assert.rejects(run(page(), opts, { deviceId }), { code: 'invalid_input' });
  for (const keyword of ['', '  ', '\u0000', 'x'.repeat(129)])
    await assert.rejects(run(page(), opts, { keyword }), { code: 'invalid_input' });
  for (const publishDays of [-1, 30, 1.2, '1'])
    await assert.rejects(run(page(), opts, { publishDays }), { code: 'invalid_input' });
  for (const sortType of [-1, 3, '2'])
    await assert.rejects(run(page(), opts, { sortType }), { code: 'invalid_input' });
  assert.equal(calls, 0);
  assert.equal(officialSearchReadiness(input).platformPermissionVerified, false);
});

test('official one-page GET uses header token and exact int64 text, no cookies or redirects', async () => {
  let calls = 0;
  const result = await run(page(), { fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url.origin + url.pathname, 'https://open.douyin.com/dy_open_api/v1/search/video/');
    assert.deepEqual(Object.fromEntries(url.searchParams), { device_id: input.deviceId,
      keyword: input.keyword, publish_time: '1', sort_type: '2', cursor: '0', count: '10' });
    assert.equal(options.headers['access-token'], input.clientToken);
    assert.equal(options.headers.Cookie, undefined); assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(JSON.stringify(page()));
  } });
  assert.equal(calls, 1); assert.equal(result.networkRequests, 1);
  assert.equal(result.videos[0].publicContentId, id);
  assert.equal(result.videos[0].officialItemId, null);
  assert.equal(result.videos[0].likes, 0); assert.equal(result.videos[0].observedAt, now);
  assert.equal(result.videos[0].publishedAt, '2025-02-14T12:34:10.000Z');
  assert.deepEqual(result.nextSearchPage, { cursor: '2', searchId: 'fixture_search' });
  for (const field of ['allAuthorWorksCollected', 'topicTotalsAvailable', 'identityBindingVerified', 'productionAdmitted', 'runtimeAI'])
    assert.equal(result[field], false, field);
  for (const field of ['modelCalls', 'databaseWrites']) assert.equal(result[field], 0);
  assert.equal(JSON.stringify(result).includes(input.clientToken), false);
  assert.equal(JSON.stringify(result).includes(input.deviceId), false);
});

test('search metrics never become real plays or owner identity; unknown is null and true zero survives', async () => {
  for (const statistics of [undefined, {}, { digg_count: '0' }, { digg_count: false },
    { digg_count: -1 }, { digg_count: 0.5 }, { digg_count: 9007199254740992 }])
    assert.equal((await run(page([item({ statistics })]))).videos[0].likes, null);
  const video = (await run(page([item({ statistics: { digg_count: 5, play_count: 999999 } })]))).videos[0];
  assert.equal(video.likes, 5);
  for (const field of ['comments', 'shares', 'collects', 'plays']) assert.equal(video[field], null, field);
  assert.equal(video.plays_source, 'unavailable');
});

test('missing/malformed pagination cannot become complete; exhausted search is not all-author coverage', async () => {
  for (const changes of [{ video_list: null }, { video_list: Array.from({ length: 11 }, () => item()) },
    { cursor: undefined }, { cursor: -1 }, { cursor: 9007199254740992 }, { has_more: undefined }, { has_more: 0 }])
    await assert.rejects(run(page(undefined, changes)), { code: 'invalid_response' });
  for (const changes of [{ cursor: 0 }, { search_id: undefined }, { search_id: 'bad\n' }, { video_list: [] }])
    await assert.rejects(run(page(undefined, changes)), { code: 'invalid_pagination' });
  const empty = await run(page([], { has_more: false, cursor: 0, search_id: undefined }));
  assert.equal(empty.searchPageExhausted, true); assert.equal(empty.allAuthorWorksCollected, false);
  assert.deepEqual(empty.videos, []); assert.equal(empty.nextSearchPage, null);
  const wide = await run(page(undefined, { cursor: '9223372036854775807' }));
  assert.equal(wide.nextSearchPage.cursor, '9223372036854775807');
});

test('public link/id proof is exact and duplicate conflicts are rejected', async () => {
  for (const changes of [{ item_id: Number(id) }, { item_id: '' }, { item_id: 'encrypted-id' },
    { link: 'http://www.douyin.com/video/' + id }, { link: 'https://evil.test/video/' + id },
    { link: 'https://www.douyin.com/video/' + id + '?token=private' },
    { link: 'https://www.douyin.com/video/7471252140422401338' }])
    await assert.rejects(run(page([item(changes)])), { code: 'item_identity_mismatch' });
  assert.equal((await run(page([item(), item()]))).videos.length, 1);
  await assert.rejects(run(page([item(), item({ title: 'conflict' })])), { code: 'conflicting_content' });
});

test('publication time is optional and never replaced by observation time', async () => {
  for (const create_time of [0, -1, false, '1739536450', 1.2, Date.parse(now) / 1000 + 1])
    assert.equal((await run(page([item({ create_time })]))).videos[0].publishedAt, null);
});

test('HTTP/API/network rejections stop after one request and cannot expose raw upstream secrets', async () => {
  for (const [status, code] of [[401, 'authorization_required'], [403, 'permission_denied'],
    [429, 'rate_limited'], [302, 'upstream_http_error'], [500, 'upstream_http_error']]) {
    let calls = 0;
    await assert.rejects(run(null, { fetchImpl: async () => { calls++;
      return new Response('private', { status, headers: { location: 'https://evil.test' } });
    } }), { code, message: code });
    assert.equal(calls, 1);
  }
  await assert.rejects(run({ err_no: 28001018, err_msg: input.clientToken }), error =>
    error.code === 'platform_error' && error.officialErrorCode === 28001018 && !error.message.includes(input.clientToken));
  await assert.rejects(run({ ...page(), data: { ...page().data,
    extra: { error_code: 0, sub_error_code: 28003017 } } }), { code: 'platform_error', officialErrorCode: 28003017 });
  await assert.rejects(run({ err_no: 0 }), { code: 'invalid_response' });
  await assert.rejects(run({ data: {} }), { code: 'invalid_response' });
  await assert.rejects(run(null, { fetchImpl: async () => { throw Error(input.clientToken); } }),
    { code: 'network_error', message: 'network_error' });
});

test('invalid/cancelled clock and oversized responses are bounded', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; throw Error('not reached'); };
  for (const value of ['invalid', '2026-10-30'])
    await assert.rejects(run(null, { fetchImpl, clock: () => value }), { code: 'invalid_clock' });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(run(null, { fetchImpl, signal: abort.signal }), { code: 'cancelled' });
  assert.equal(calls, 0);
  await assert.rejects(run(null, { fetchImpl: async () => new Response('x'.repeat(256 * 1024 + 1)) }),
    { code: 'response_too_large' });
  await assert.rejects(run(null, { fetchImpl: async () => new Response('not JSON') }), { code: 'invalid_response' });
});

test('CLI readiness is offline, redacts inputs, and does not reuse author-list scope', () => {
  const result = spawnSync(process.execPath, ['scripts/probe-douyin-open-api.mjs', '--search'], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', env: { ...process.env,
      DOUYIN_CLIENT_TOKEN: input.clientToken, DOUYIN_SEARCH_DEVICE_ID: input.deviceId,
      DOUYIN_SEARCH_KEYWORD: input.keyword, DOUYIN_CLIENT_SCOPES: input.scopes[0] },
  });
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout); assert.equal(body.api, 'official-video-search');
  for (const key of ['clientTokenPresent', 'deviceIdValid', 'keywordValid', 'searchScopeDeclared']) assert.equal(body[key], true, key);
  for (const key of ['networkRequests', 'databaseWrites', 'modelCalls']) assert.equal(body[key], 0);
  for (const text of [input.clientToken, input.deviceId, input.keyword]) assert.equal(result.stdout.includes(text), false);
});

test('explicit CLI run without authorization fails locally and rejects accidental account arguments', () => {
  const env = { ...process.env, DOUYIN_CLIENT_TOKEN: '', DOUYIN_SEARCH_DEVICE_ID: '', DOUYIN_SEARCH_KEYWORD: '', DOUYIN_CLIENT_SCOPES: '' };
  const result = spawnSync(process.execPath, ['scripts/probe-douyin-open-api.mjs', '--search', '--run'], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', env,
  });
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).code, 'authorization_required');
  const bad = spawnSync(process.execPath, ['scripts/probe-douyin-open-api.mjs', '--search', '--run', '--account-key', 'fixture'], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', env,
  });
  assert.equal(bad.status, 2);
});
