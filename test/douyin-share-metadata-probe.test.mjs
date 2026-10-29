import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseDouyinShareMetadata, probeDouyinShareMetadata } from '../lib/douyin-share-metadata-probe.mjs';

const contentId = '7300000000000000001', uid = 'MS4wLjABTestFixtureOnly';
const observedAt = '2026-10-29T18:00:00.000Z';
const item = (statistics = {}) => ({ aweme_id: contentId, author: { sec_uid: uid },
  desc: 'nested {braces} \\"text\\" [标题]', create_time: 1792368000, statistics });
const html = (items, extra = '') => `<html><script>window._ROUTER_DATA = ${JSON.stringify({ loaderData: {
  'video_(id)/page': { videoInfoRes: { item_list: items } },
} })};${extra}</script></html>`;
const parse = (text, opts = {}) => parseDouyinShareMetadata(text, { contentId, observedAt, ...opts });
const reply = (text, options = {}) => new Response(text, { headers: { 'content-type': 'text/html; charset=utf-8' }, ...options });

test('readiness CLI does not request, mutate or call a model', () => {
  const result = spawnSync(process.execPath, ['scripts/probe-douyin-share-metadata.mjs'], { cwd: new URL('../', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.networkRequests, 0); assert.equal(body.databaseWrites, 0); assert.equal(body.modelCalls, 0);
  assert.equal(body.requiresBrowser, false); assert.equal(body.requiresCookies, false);
});

test('balanced JSON preserves braces/escaped quotes and executes no trailing JavaScript', () => {
  const body = parse(html([item({ digg_count: 0, share_count: '12', comment_count: 37, collect_count: 8 })], 'throw Error("must not execute");'));
  assert.equal(body.title, item().desc); assert.equal(body.contentId, contentId);
  assert.equal(body.likes, 0); assert.equal(body.shares, 12); assert.equal(body.comments, 37);
  assert.equal(body.observedAt, observedAt); assert.notEqual(body.publishedAt, observedAt);
  assert.equal(body.identityBindingVerified, false); assert.equal(body.productionAdmitted, false);
  assert.equal(body.allAuthorWorksCollected, false);
  assert.equal(body.statisticsAvailable, true);
  assert.equal(parse(html([item()])).statisticsAvailable, false);
});

test('raw public plays never become verified actual plays, including reported zero', () => {
  for (const play_count of [undefined, 0, 12345]) {
    const body = parse(html([item({ play_count, digg_count: 500 })]));
    assert.equal(body.plays, null); assert.equal(body.plays_source, 'unavailable');
    assert.equal(body.evidence.reportedPlayCount, play_count ?? null);
    assert.equal(body.evidence.playCountVerified, false);
    assert.equal(body.comments, null);
  }
});

test('unsafe/negative/fractional/boolean statistics and placeholder dates remain missing', () => {
  const work = { ...item({ digg_count: Number.MAX_SAFE_INTEGER + 1, share_count: -1, collect_count: false, comment_count: '1.2' }), create_time: 0 };
  const body = parse(html([work]));
  for (const key of ['likes', 'shares', 'collects', 'comments', 'publishedAt']) assert.equal(body[key], null);
  assert.equal(parse(html([{ ...item(), create_time: 253402300799 }])).publishedAt, null);
});

test('only exact work ID and optional exact author identity can match', () => {
  assert.throws(() => parse(html([{ ...item(), aweme_id: '7300000000000000002' }])), { code: 'content_not_found' });
  assert.throws(() => parse(html([{ ...item(), aweme_id: Number(contentId) }])), { code: 'content_not_found' });
  assert.throws(() => parse(html([item()]), { expectedSecUid: 'MS4wLjABOtherAuthor' }), { code: 'author_identity_mismatch' });
  assert.equal(parse(html([item()]), { expectedSecUid: uid }).identityBindingVerified, true);
});

test('shell/verification/malformed data fail closed and never count as successful empty collection', () => {
  assert.throws(() => parse('<html>验证后查看</html>'), { code: 'embedded_data_unavailable' });
  assert.throws(() => parse(html([])), { code: 'content_not_found' });
  assert.throws(() => parse('<script>window._ROUTER_DATA = {bad}</script>'), { code: 'invalid_embedded_json' });
  assert.throws(() => parse('<script>window._ROUTER_DATA = {"unclosed":{</script>'), { code: 'invalid_embedded_json' });
  assert.throws(() => parse('<script>window._ROUTER_DATA = ' + '{"x":'.repeat(65) + '0' + '}'.repeat(65) + '</script>'), { code: 'invalid_embedded_json' });
  assert.throws(() => parse(html([item(), item({ digg_count: 1 })])), { code: 'conflicting_content' });
  assert.throws(() => parse('x'.repeat(2 * 1024 * 1024 + 1)), { code: 'response_too_large' });
});

test('empty route diagnostics contain counts only and retain bounded transport evidence', async () => {
  await assert.rejects(probeDouyinShareMetadata({ contentId }, { clock: () => observedAt, fetchImpl: async () => reply(html([])) }), error => {
    assert.equal(error.code, 'content_not_found');
    assert.deepEqual(error.diagnostic, { routerMarkers: 1, supportedRoutes: 1, embeddedRecords: 0, matchedRecords: 0 });
    assert.equal(error.transportEvidence.networkRequests, 1);
    assert.equal(error.transportEvidence.httpStatus, 200);
    assert.equal(JSON.stringify(error.diagnostic).includes(contentId), false);
    return true;
  });
});

test('one bounded HTTP request, no cookie/signature/private redirect/media request', async () => {
  let calls = 0;
  const body = await probeDouyinShareMetadata({ contentId }, { clock: () => observedAt, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, `https://www.iesdouyin.com/share/video/${contentId}/`);
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Cookie, undefined); assert.equal(options.headers['x-tt-argus'], undefined);
    assert.match(options.headers['User-Agent'], /Mobile.*MCN-Metadata-Probe\/1\.0$/);
    assert.ok(options.signal instanceof AbortSignal);
    return reply(html([item()]));
  } });
  assert.equal(calls, 1); assert.equal(body.networkRequests, 1); assert.equal(body.modelCalls, 0);
  assert.equal(body.databaseWrites, 0); assert.ok(body.responseBytes > 0);
});

test('invalid IDs, clock and aborted inputs do not leak errors or request unrelated URLs', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return reply(html([item()])); };
  for (const bad of ['https://evil.test/', '../../etc/passwd', '1', 123])
    await assert.rejects(probeDouyinShareMetadata({ contentId: bad }, { fetchImpl }), { code: 'invalid_input' });
  await assert.rejects(probeDouyinShareMetadata({ contentId, expectedSecUid: 'bad' }, { fetchImpl }), { code: 'invalid_input' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(probeDouyinShareMetadata({ contentId }, { fetchImpl, signal: controller.signal }), { code: 'cancelled' });
  assert.equal(calls, 0);
  assert.throws(() => parse(html([item()]), { observedAt: 'bad' }), { code: 'invalid_clock' });
});

test('refusal/redirect/rate limit never retries or follows Location', async () => {
  for (const [status, code] of [[403, 'access_denied'], [401, 'login_required'], [429, 'rate_limited'], [302, 'redirect_refused'], [500, 'upstream_http_error']]) {
    let calls = 0;
    await assert.rejects(probeDouyinShareMetadata({ contentId }, { fetchImpl: async () => {
      calls++; return reply('private-upstream-message', { status, headers: { Location: 'https://evil.test/secret' } });
    } }), { code, message: code });
    assert.equal(calls, 1);
  }
});

test('invalid MIME and oversized streams fail closed; network exceptions are sanitized', async () => {
  await assert.rejects(probeDouyinShareMetadata({ contentId }, { fetchImpl: async () => new Response('{}') }), { code: 'unexpected_content_type' });
  await assert.rejects(probeDouyinShareMetadata({ contentId }, { fetchImpl: async () => reply('x'.repeat(2 * 1024 * 1024 + 1)) }), { code: 'response_too_large' });
  await assert.rejects(probeDouyinShareMetadata({ contentId }, { fetchImpl: async () => { throw Error('private-cookie'); } }), { code: 'network_error', message: 'network_error' });
});

test('canonical redirects preserve exact ID, host allowlist, no cookies and a global three-request cap', async () => {
  let calls = 0;
  const result = await probeDouyinShareMetadata({ contentId }, { clock: () => observedAt, fetchImpl: async (url, options) => {
    calls++; assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual');
    return calls === 1 ? new Response('', { status: 302, headers: { location: `https://www.douyin.com/video/${contentId}` } }) : reply(html([item()]));
  } });
  assert.equal(result.networkRequests, 2);
  for (const location of ['http://www.iesdouyin.com/share/video/' + contentId, 'https://www.douyin.com/passport/login/',
    'https://www.douyin.com/share/video/7300000000000000002', 'https://www.douyin.com:8080/video/' + contentId,
    'https://private@www.douyin.com/video/' + contentId, 'https://www.douyin.com.evil.test/video/' + contentId]) {
    let requests = 0;
    await assert.rejects(probeDouyinShareMetadata({ contentId }, { fetchImpl: async () => {
      requests++; return new Response('', { status: 302, headers: { location } });
    } }), { code: 'redirect_refused' });
    assert.equal(requests, 1);
  }
  let requests = 0;
  await assert.rejects(probeDouyinShareMetadata({ contentId }, { fetchImpl: async () => {
    requests++; return new Response('', { status: 302, headers: { location: `/share/video/${contentId}/?page=${requests}` } });
  } }), { code: 'redirect_limit' });
  assert.equal(requests, 3);
});
