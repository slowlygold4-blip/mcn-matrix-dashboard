// One-page discovery trial, never an author-completeness or topic-total source.
// No browser, signature, database, token refresh, retry or language model.
import { boundedOfficialJson } from './douyin-official-http.mjs';
const ENDPOINT = 'https://open.douyin.com/dy_open_api/v1/search/video/';
const SCOPE = 'aweme.dy.video_search';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => Object.assign(new Error(code), { code });
const metric = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const int64 = value => typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value)
  && BigInt(value) <= 9223372036854775807n;
const cursorText = value => Number.isSafeInteger(value) && value >= 0 ? String(value)
  : typeof value === 'string' && /^(0|[1-9]\d{0,18})$/.test(value)
    && BigInt(value) <= 9223372036854775807n ? value : null;

export function officialSearchReadiness({ clientToken, deviceId, keyword, scopes } = {}) {
  return {
    clientTokenPresent: typeof clientToken === 'string' && /^clt\.[^\s\x00-\x1f\x7f]{1,4092}$/.test(clientToken),
    deviceIdValid: int64(deviceId),
    keywordValid: typeof keyword === 'string' && keyword.trim().length > 0 && keyword.length <= 128
      && !/[\x00-\x1f\x7f]/.test(keyword),
    searchScopeDeclared: Array.isArray(scopes) && scopes.includes(SCOPE),
    platformPermissionVerified: false,
  };
}

function checkCode(code) {
  const number = typeof code === 'string' && /^-?\d{1,10}$/.test(code) ? Number(code) : code;
  if (!Number.isSafeInteger(number)) throw fail('invalid_response');
  if (number !== 0) throw Object.assign(fail('platform_error'), { officialErrorCode: number });
}

export async function probeOfficialSearch({ clientToken, deviceId, keyword, scopes,
  publishDays = 1, sortType = 2 } = {}, {
  fetchImpl = globalThis.fetch, clock = () => new Date().toISOString(), signal,
} = {}) {
  const ready = officialSearchReadiness({ clientToken, deviceId, keyword, scopes });
  if (!ready.clientTokenPresent) throw fail('authorization_required');
  if (!ready.searchScopeDeclared) throw fail('scope_required');
  if (!ready.deviceIdValid || !ready.keywordValid || ![0, 1, 7, 180].includes(publishDays)
    || ![0, 1, 2].includes(sortType)) throw fail('invalid_input');
  const observedAt = clock(), now = Date.parse(observedAt);
  if (typeof observedAt !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(observedAt)
    || !Number.isFinite(now)) throw fail('invalid_clock');
  if (signal?.aborted) throw fail('cancelled');
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({ device_id: deviceId, keyword, publish_time: String(publishDays),
    sort_type: String(sortType), cursor: '0', count: '10' });
  let response;
  try {
    response = await fetchImpl(url, { method: 'GET', redirect: 'error', credentials: 'omit',
      headers: { 'access-token': clientToken, 'content-type': 'application/json' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
  } catch { throw fail(signal?.aborted ? 'cancelled' : 'network_error'); }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    throw fail(response.status === 401 ? 'authorization_required' : response.status === 403 ? 'permission_denied'
      : response.status === 429 ? 'rate_limited' : 'upstream_http_error');
  }
  const body = await boundedOfficialJson(response, 256 * 1024);
  if (!object(body)) throw fail('invalid_response');
  checkCode(body.err_no);
  if (!object(body.data)) throw fail('invalid_response');
  if (body.data.extra !== undefined) {
    if (!object(body.data.extra)) throw fail('invalid_response');
    checkCode(body.data.extra.error_code);
    if (body.data.extra.sub_error_code !== undefined) checkCode(body.data.extra.sub_error_code);
  }
  const page = body.data.data;
  if (!object(page) || !Array.isArray(page.video_list) || page.video_list.length > 10
    || typeof page.has_more !== 'boolean' || cursorText(page.cursor) === null) throw fail('invalid_response');
  const nextCursor = cursorText(page.cursor);
  const searchId = typeof page.search_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(page.search_id)
    ? page.search_id : null;
  if (page.has_more && (!page.video_list.length || nextCursor === '0' || !searchId)) throw fail('invalid_pagination');
  const works = new Map();
  for (const item of page.video_list) {
    // The numeric search ID and link must agree. Neither proves author ownership
    // nor an encrypted official item_id mapping for other API permissions.
    if (!object(item) || typeof item.item_id !== 'string' || !/^\d{15,25}$/.test(item.item_id)
      || item.link !== `https://www.douyin.com/video/${item.item_id}`) throw fail('item_identity_mismatch');
    const work = { publicContentId: item.item_id, officialItemId: null,
      title: typeof item.title === 'string' ? item.title.slice(0, 2000) : '',
      nickname: typeof item.nickname === 'string' ? item.nickname.slice(0, 256) : '',
      publishedAt: Number.isSafeInteger(item.create_time) && item.create_time > 0
        && item.create_time * 1000 <= now ? new Date(item.create_time * 1000).toISOString() : null,
      observedAt, likes: metric(item.statistics?.digg_count), comments: null, shares: null,
      collects: null, plays: null, plays_source: 'unavailable' };
    if (works.has(work.publicContentId) && JSON.stringify(works.get(work.publicContentId)) !== JSON.stringify(work))
      throw fail('conflicting_content');
    works.set(work.publicContentId, work);
  }
  return { version: 1, source: 'douyin-official-video-search', endpoint: new URL(ENDPOINT).pathname,
    retrievedAt: observedAt, query: { keyword, publishDays, sortType }, videos: [...works.values()],
    receipt: { requestedCursor: '0', returnedCursor: nextCursor, returnedCount: page.video_list.length },
    nextSearchPage: page.has_more ? { cursor: nextCursor, searchId } : null,
    searchPageExhausted: !page.has_more, allAuthorWorksCollected: false, topicTotalsAvailable: false,
    identityBindingVerified: false, productionAdmitted: false,
    networkRequests: 1, databaseWrites: 0, modelCalls: 0, runtimeAI: false };
}
