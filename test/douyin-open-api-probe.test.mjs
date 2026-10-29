import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { officialProbeReadiness, probeOfficialVideos } from '../lib/douyin-open-api-probe.mjs';

const input = { accessToken: 'act.test-only-never-real', openId: 'test-author', scopes: ['video.list'], accountKey: 'test:author' };
const time = '2026-10-29T18:00:00.000Z';
const response = data => new Response(JSON.stringify({ data: { error_code: 0, ...data }, extra: { error_code: 0 } }));
const item = (id, stats = {}) => ({ item_id: id, title: '#测试作品', create_time: 1793289600, statistics: stats });
const run = (data, opts = {}) => probeOfficialVideos(input, { fetchImpl: async () => response(data), clock: () => time, ...opts });

test('missing permission fails before the first network request; readiness never returns secrets', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw Error('unexpected'); };
  await assert.rejects(probeOfficialVideos({ ...input, accessToken: undefined }, { fetchImpl }), { code: 'authorization_required' });
  await assert.rejects(probeOfficialVideos({ ...input, scopes: [] }, { fetchImpl }), { code: 'scope_required' });
  await assert.rejects(probeOfficialVideos({ ...input, openId: 'invalid\nheader' }, { fetchImpl }), { code: 'authorization_required' });
  assert.equal(calls, 0);
  const readiness = officialProbeReadiness(input);
  assert.equal(readiness.platformPermissionVerified, false);
  assert.ok(!JSON.stringify(readiness).includes(input.accessToken));
});

test('readiness CLI makes no requests, database writes or model calls', () => {
  const env = { ...process.env };
  for (const key of ['DOUYIN_OPEN_ACCESS_TOKEN', 'DOUYIN_OPEN_ID', 'DOUYIN_OPEN_SCOPES']) delete env[key];
  const child = spawnSync(process.execPath, ['scripts/probe-douyin-open-api.mjs'], { cwd: new URL('../', import.meta.url), env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.networkRequests, 0);
  assert.equal(result.databaseWrites, 0);
  assert.equal(result.modelCalls, 0);
  assert.equal(result.accessTokenPresent, false);
});

test('real zero differs from missing plays; no like multiplier; opaque IDs stay distinct from public IDs', async () => {
  const result = await run({ has_more: false, list: [item('@opaque+/=', { play_count: 0, digg_count: 500 }), item('@missing', { digg_count: 200 })] });
  assert.equal(result.videos[0].plays, 0);
  assert.equal(result.videos[0].plays_source, 'api');
  assert.equal(result.videos[1].plays, null);
  assert.equal(result.videos[1].plays_source, 'unavailable');
  assert.equal(result.videos[1].comments, null);
  assert.equal(result.videos[0].officialItemId, '@opaque+/=');
  assert.equal(result.videos[0].publicContentId, null);
  assert.equal(result.videos[0].observedAt, time);
  assert.notEqual(result.videos[0].publishedAt, time);
  assert.equal(result.productionAdmitted, false);
  assert.equal(result.identityBindingVerified, false);
  assert.equal(result.allAuthorWorksCollected, false);
});

test('pagination follows exact returned cursors with safe official-host requests and deduplicates items', async () => {
  const requests = [];
  const result = await probeOfficialVideos({ ...input, maxPages: 4 }, { clock: () => time, fetchImpl: async (url, opts) => {
    requests.push({ url, opts });
    assert.equal(url.origin, 'https://open.douyin.com');
    assert.equal(url.pathname, '/video/list/');
    assert.equal(url.searchParams.has('access_token'), false);
    assert.equal(opts.redirect, 'error');
    assert.equal(opts.headers['access-token'], input.accessToken);
    return requests.length === 1
      ? response({ has_more: true, cursor: '9007199254740993', list: [item('@one')] })
      : response({ has_more: false, list: [item('@one'), item('@two', { play_count: 300 })] });
  } });
  assert.equal(requests[1].url.searchParams.get('cursor'), '9007199254740993');
  assert.equal(result.pages.length, 2);
  assert.equal(result.videos.length, 2);
  assert.equal(result.visibleListExhausted, true);
  assert.equal(result.allAuthorWorksCollected, false);
});

test('one-page cap is limited coverage, not full inventory success', async () => {
  const result = await run({ has_more: true, cursor: 20, list: [item('@one')] });
  assert.equal(result.stopReason, 'page_limit');
  assert.equal(result.visibleListExhausted, false);
});

test('repeated and lossy int64 cursors cannot silently truncate or loop', async () => {
  for (const cursor of [0, Number.MAX_SAFE_INTEGER + 1, 'bad']) {
    await assert.rejects(run({ has_more: true, cursor, list: [] }), { code: 'invalid_cursor' });
  }
});

test('page budget is validated before transport', async () => {
  for (const maxPages of [0, 5, 1.5]) {
    await assert.rejects(probeOfficialVideos({ ...input, maxPages }, { fetchImpl: () => assert.fail('unexpected request') }), { code: 'invalid_input' });
  }
});

test('zero publication placeholders and invalid statistics remain missing', async () => {
  const result = await run({ has_more: false, list: [{ ...item('@one'), create_time: 0, statistics: { play_count: -1, digg_count: '500', share_count: NaN } }] });
  assert.equal(result.videos[0].publishedAt, null);
  assert.equal(result.videos[0].plays, null);
  assert.equal(result.videos[0].likes, null);
  assert.equal(result.videos[0].shares, null);
});

test('authentication, rate limits and HTTP refusals retain fixed safe codes', async () => {
  for (const [status, code] of [[401, 'authorization_required'], [403, 'permission_denied'], [429, 'rate_limited'], [500, 'upstream_http_error']]) {
    await assert.rejects(probeOfficialVideos(input, { fetchImpl: async () => new Response('do-not-log-' + input.accessToken, { status }) }), { code, message: code });
  }
  await assert.rejects(run({ error_code: 2190008, description: input.accessToken, list: [], has_more: false }), { code: 'platform_error', message: 'platform_error' });
});

test('HTML, malformed shapes, failed extra codes and oversized bodies fail closed', async () => {
  for (const text of ['<html>verification</html>', JSON.stringify({ data: { error_code: 0, has_more: false, list: 'bad' } }),
    JSON.stringify({ data: { error_code: 0, has_more: false, list: [] }, extra: { error_code: 1 } })]) {
    await assert.rejects(probeOfficialVideos(input, { fetchImpl: async () => new Response(text) }), /invalid_response|platform_error/);
  }
  await assert.rejects(probeOfficialVideos(input, { fetchImpl: async () => new Response(' '.repeat(2 * 1024 * 1024 + 1)) }), { code: 'response_too_large' });
});

test('a failed later page never returns the earlier pages as successful full data', async () => {
  let requests = 0;
  await assert.rejects(probeOfficialVideos({ ...input, maxPages: 2 }, { fetchImpl: async () => ++requests === 1
    ? response({ list: [item('@one')], has_more: true, cursor: 10 }) : new Response('denied', { status: 403 }) }), { code: 'permission_denied' });
  assert.equal(requests, 2);
});

test('transport errors and cancellation never expose upstream credential-bearing messages', async () => {
  await assert.rejects(probeOfficialVideos(input, { fetchImpl: async () => { throw Error('secret:' + input.accessToken); } }), { code: 'network_error', message: 'network_error' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(probeOfficialVideos(input, { signal: controller.signal, fetchImpl: async () => { throw Error('secret'); } }), { code: 'cancelled' });
});
