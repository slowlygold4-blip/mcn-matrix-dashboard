// Read-only, isolated official API trial. This is not wired to the production
// scheduler: open_id/item_id need verified bindings before production admission.
import { boundedOfficialJson as boundedJson } from './douyin-official-http.mjs';
const ORIGIN = 'https://open.douyin.com';
const ENDPOINT = '/video/list/';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => Object.assign(new Error(code), { code });
const metric = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

// Bound mini-app authors: aweme_id here means the author's Douyin handle,
// not a video ID, sec_uid or app-scoped open_id. Recent 30-day discovery only.
const AUTHOR_LIST_ENDPOINT = '/aweme/v1/video/self/get_user_video_list/';
const AUTHOR_LIST_SCOPE = 'ma.self_mount_video.item_list';
export function authorListReadiness({ clientToken, authorHandle, scopes } = {}) {
  return { clientTokenPresent: typeof clientToken === 'string' && /^clt\.[^\s\x00-\x1f\x7f]{1,4092}$/.test(clientToken),
    authorHandleValid: typeof authorHandle === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(authorHandle),
    authorListScopeDeclared: Array.isArray(scopes) && scopes.includes(AUTHOR_LIST_SCOPE),
    platformPermissionVerified: false, authorBindingVerified: false };
}

function authorPublicationTime(value, now) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)) return null;
  // Documented local publication time, interpreted explicitly in Beijing time.
  const time = Date.parse(value.replace(' ', 'T') + '+08:00');
  if (!Number.isFinite(time) || time > now
    || new Date(time + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') !== value) return null;
  return new Date(time).toISOString();
}

export async function probeOfficialAuthorList({ clientToken, authorHandle, scopes, accountKey, maxPages = 1 } = {}, {
  fetchImpl = globalThis.fetch, clock = () => new Date().toISOString(), signal,
} = {}) {
  const ready = authorListReadiness({ clientToken, authorHandle, scopes });
  if (!ready.clientTokenPresent) throw fail('authorization_required');
  if (!ready.authorListScopeDeclared) throw fail('scope_required');
  if (!ready.authorHandleValid || typeof accountKey !== 'string' || !/^[A-Za-z0-9:_.-]{1,256}$/.test(accountKey)
    || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 3) throw fail('invalid_input');
  const observedAt = clock(), now = Date.parse(observedAt);
  if (typeof observedAt !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(observedAt)
    || !Number.isFinite(now)) throw fail('invalid_clock');
  const works = new Map(), receipts = [], seenCursors = new Set([0]);
  let cursor = 0, exhausted = false;
  for (let page = 0; page < maxPages; page++) {
    if (signal?.aborted) throw fail('cancelled');
    let response;
    try {
      response = await fetchImpl(new URL(AUTHOR_LIST_ENDPOINT, ORIGIN), {
        method: 'POST', redirect: 'error', credentials: 'omit',
        headers: { 'access-token': clientToken, 'content-type': 'application/json' },
        body: JSON.stringify({ aweme_id: authorHandle, count: 10, cursor }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      });
    } catch { throw fail(signal?.aborted ? 'cancelled' : 'network_error'); }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw fail(response.status === 401 ? 'authorization_required' : response.status === 403 ? 'permission_denied'
        : response.status === 429 ? 'rate_limited' : 'upstream_http_error');
    }
    const body = await boundedJson(response, 128 * 1024);
    const code = typeof body?.err_no === 'string' && /^-?\d{1,10}$/.test(body.err_no) ? Number(body.err_no) : body?.err_no;
    if (!Number.isSafeInteger(code)) throw fail('invalid_response');
    if (code !== 0) throw Object.assign(fail('platform_error'), { officialErrorCode: code });
    const data = body.data;
    if (!object(data) || !Array.isArray(data.user_publish_item_list) || data.user_publish_item_list.length > 10
      || typeof data.has_more !== 'boolean' || !Number.isSafeInteger(data.max_cursor) || data.max_cursor < 0) throw fail('invalid_response');
    for (const item of data.user_publish_item_list) {
      if (!object(item) || typeof item.video_link !== 'string'
        || !/^https:\/\/www\.douyin\.com\/video\/[0-9]{15,25}\/?$/.test(item.video_link)) throw fail('item_identity_mismatch');
      const publicContentId = new URL(item.video_link).pathname.split('/')[2];
      const work = { publicContentId,
        // Numeric int64 item_ids can already be rounded by JSON.parse. Never
        // convert those into IDs; the validated public video URL remains exact.
        officialItemId: typeof item.item_id === 'string' && /^\d{1,25}$/.test(item.item_id) ? item.item_id : null,
        publishedAt: authorPublicationTime(item.create_time, now), observedAt,
        likes: null, comments: null, shares: null, collects: null, plays: null, plays_source: 'unavailable' };
      if (works.has(publicContentId) && JSON.stringify(works.get(publicContentId)) !== JSON.stringify(work)) throw fail('conflicting_content');
      works.set(publicContentId, work);
    }
    receipts.push({ requestedCursor: cursor, returnedCursor: data.max_cursor, returnedCount: data.user_publish_item_list.length });
    if (!data.has_more) { exhausted = true; break; }
    const next = data.max_cursor;
    if (!data.user_publish_item_list.length || seenCursors.has(next) || next > now || next < now - 30 * 86400000
      || (cursor !== 0 && next >= cursor)) throw fail('invalid_pagination');
    cursor = next; seenCursors.add(next);
  }
  return { version: 1, accountKey, source: 'douyin-official-bound-author-list', endpoint: AUTHOR_LIST_ENDPOINT,
    retrievedAt: observedAt, timezone: 'Asia/Shanghai', queryWindowDays: 30, videos: [...works.values()],
    receipts, recentWindowPaginationExhausted: exhausted, nextCursor: exhausted ? null : cursor,
    networkRequests: receipts.length, identityBindingVerified: false, productionAdmitted: false,
    allAuthorWorksCollected: false, databaseWrites: 0, modelCalls: 0, runtimeAI: false };
}

// Current mini-app API, distinct from the legacy /video/list/ permission.
// Five is our local trial budget, not a claim about the platform's quota.
const MINIAPP_ENDPOINT = '/api/apps/v1/video/query/';
function validOfficialItemIds(ids) {
  return Array.isArray(ids) && ids.length >= 1 && ids.length <= 5
    && new Set(ids).size === ids.length && ids.every(id => typeof id === 'string'
      && id.length >= 1 && id.length <= 1024 && !/[\s\x00-\x1f\x7f]/.test(id));
}

export function miniAppVideoReadiness(credentials = {}) {
  const base = officialProbeReadiness(credentials);
  return { accessTokenPresent: base.accessTokenPresent, openIdPresent: base.openIdPresent,
    miniAppVideoScopeDeclared: Array.isArray(credentials.scopes) && credentials.scopes.includes('ma.video.bind'),
    officialItemIdsValid: validOfficialItemIds(credentials.itemIds),
    platformPermissionVerified: false, identityBindingVerified: false };
}

export async function probeOfficialMiniAppVideos({ accessToken, openId, scopes, accountKey, itemIds } = {}, {
  fetchImpl = globalThis.fetch, clock = () => new Date().toISOString(), signal,
} = {}) {
  const ready = miniAppVideoReadiness({ accessToken, openId, scopes, itemIds });
  if (!ready.accessTokenPresent || !ready.openIdPresent) throw fail('authorization_required');
  if (!ready.miniAppVideoScopeDeclared) throw fail('scope_required');
  if (!ready.officialItemIdsValid || typeof accountKey !== 'string'
    || !/^[A-Za-z0-9:_.-]{1,256}$/.test(accountKey)) throw fail('invalid_input');
  if (signal?.aborted) throw fail('cancelled');
  const url = new URL(MINIAPP_ENDPOINT, ORIGIN);
  url.search = new URLSearchParams({ open_id: openId });
  let response;
  try {
    response = await fetchImpl(url, { method: 'POST', redirect: 'error', credentials: 'omit',
      headers: { 'access-token': accessToken, 'content-type': 'application/json' },
      body: JSON.stringify({ item_ids: itemIds }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
  } catch { throw fail(signal?.aborted ? 'cancelled' : 'network_error'); }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    throw fail(response.status === 429 ? 'rate_limited' : response.status === 401 ? 'authorization_required'
      : response.status === 403 ? 'permission_denied' : 'upstream_http_error');
  }
  const body = await boundedJson(response), envelope = body?.data;
  const checkCode = code => {
    const number = typeof code === 'string' && /^-?\d{1,10}$/.test(code) ? Number(code) : code;
    if (!Number.isSafeInteger(number)) throw fail('invalid_response');
    if (number !== 0) throw Object.assign(fail('platform_error'), { officialErrorCode: number });
  };
  if (!object(body)) throw fail('invalid_response');
  // Platform errors may omit data entirely. Retain the numeric official code
  // without retaining err_msg, which may contain caller-supplied credentials.
  checkCode(body.err_no);
  if (!object(envelope) || !object(envelope.extra)) throw fail('invalid_response');
  checkCode(envelope.extra.error_code);
  if (envelope.extra.sub_error_code !== undefined) checkCode(envelope.extra.sub_error_code);
  const list = envelope.data?.list;
  if (!Array.isArray(list) || list.length > itemIds.length) throw fail('invalid_response');
  const retrievedAt = clock();
  if (!Number.isFinite(Date.parse(retrievedAt))) throw fail('invalid_clock');
  const seen = new Set(), requested = new Set(itemIds);
  const videos = list.map(item => {
    if (!object(item) || !requested.has(item.item_id) || seen.has(item.item_id)) throw fail('item_identity_mismatch');
    seen.add(item.item_id);
    // The documented create_time=0 response represents a non-public video.
    // Do not expose accompanying placeholder counts as actual observations.
    const unavailable = item.create_time === 0;
    return { ...videoFrom(unavailable ? { ...item, statistics: {} } : item, retrievedAt),
      availability: unavailable ? 'not_public_or_unavailable' : 'returned' };
  });
  return { version: 1, accountKey, source: 'douyin-official-miniapp-video-query', endpoint: MINIAPP_ENDPOINT,
    retrievedAt, requestedCount: itemIds.length, returnedCount: videos.length,
    missingOfficialItemIds: itemIds.filter(id => !seen.has(id)), videos,
    // Matching requested opaque item IDs proves neither a public aweme ID
    // mapping nor ownership in our existing account database.
    identityBindingVerified: false, productionAdmitted: false, allAuthorWorksCollected: false,
    networkRequests: 1, databaseWrites: 0, modelCalls: 0, runtimeAI: false };
}

export function officialProbeReadiness({ accessToken, openId, scopes } = {}) {
  return {
    accessTokenPresent: typeof accessToken === 'string' && accessToken.length > 0 && accessToken.length <= 4096 && !/[\s\x00-\x1f\x7f]/.test(accessToken),
    openIdPresent: typeof openId === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(openId),
    videoListScopeDeclared: Array.isArray(scopes) && scopes.includes('video.list'),
    // A declaration is not evidence that the platform approved the permission.
    platformPermissionVerified: false,
  };
}

function videoFrom(item, observedAt) {
  if (!object(item) || typeof item.item_id !== 'string' || !item.item_id || item.item_id.length > 1024) throw fail('invalid_response');
  const stats = object(item.statistics) ? item.statistics : {};
  const plays = metric(stats.play_count);
  // Official item_id is opaque, app-scoped; never coerce it to a numeric aweme ID.
  return {
    officialItemId: item.item_id,
    publicContentId: null,
    title: typeof item.title === 'string' ? item.title : '',
    publishedAt: Number.isSafeInteger(item.create_time) && item.create_time > 0 && item.create_time <= 253402300799
      ? new Date(item.create_time * 1000).toISOString() : null,
    observedAt,
    likes: metric(stats.digg_count), comments: metric(stats.comment_count),
    shares: metric(stats.share_count), collects: metric(stats.collect_count),
    plays, plays_source: plays === null ? 'unavailable' : 'api',
  };
}

export async function probeOfficialVideos({ accessToken, openId, scopes, accountKey, maxPages = 1 }, {
  fetchImpl = globalThis.fetch, clock = () => new Date().toISOString(), signal,
} = {}) {
  const readiness = officialProbeReadiness({ accessToken, openId, scopes });
  if (!readiness.accessTokenPresent || !readiness.openIdPresent) throw fail('authorization_required');
  if (!readiness.videoListScopeDeclared) throw fail('scope_required');
  if (typeof accountKey !== 'string' || !/^[A-Za-z0-9:_.-]{1,256}$/.test(accountKey)
    || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 4) throw fail('invalid_input');
  const videos = new Map(), receipts = [], seenCursors = new Set(['0']);
  let cursor = '0', exhausted = false;
  for (let page = 0; page < maxPages; page++) {
    const url = new URL(ENDPOINT, ORIGIN);
    url.search = new URLSearchParams({ open_id: openId, cursor, count: '10' });
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET', redirect: 'error', credentials: 'omit',
        headers: { 'access-token': accessToken, 'content-type': 'application/json' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      });
    } catch { throw fail(signal?.aborted ? 'cancelled' : 'network_error'); }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw fail(response.status === 429 ? 'rate_limited' : response.status === 401 ? 'authorization_required'
        : response.status === 403 ? 'permission_denied' : 'upstream_http_error');
    }
    const body = await boundedJson(response), data = body?.data;
    if (!object(data) || ![0, '0'].includes(data.error_code)) throw fail('platform_error');
    if (body.extra?.error_code !== undefined && ![0, '0'].includes(body.extra.error_code)) throw fail('platform_error');
    if (!Array.isArray(data.list) || data.list.length > 10 || typeof data.has_more !== 'boolean') throw fail('invalid_response');
    const observedAt = clock();
    if (!Number.isFinite(Date.parse(observedAt))) throw fail('invalid_clock');
    for (const item of data.list) {
      const video = videoFrom(item, observedAt);
      if (!videos.has(video.officialItemId)) videos.set(video.officialItemId, video);
    }
    receipts.push({ page: page + 1, count: data.list.length, observedAt });
    if (!data.has_more) { exhausted = true; break; }
    // Int64 cursor must remain exact. Refuse a JSON number above JS safe range.
    const next = typeof data.cursor === 'string' ? data.cursor : Number.isSafeInteger(data.cursor) ? String(data.cursor) : '';
    if (!/^\d{1,20}$/.test(next) || seenCursors.has(next)) throw fail('invalid_cursor');
    seenCursors.add(next); cursor = next;
  }
  return {
    version: 1, accountKey, source: 'douyin-official-open-api', endpoint: ENDPOINT,
    // This trial has no author binding receipt. No writes, aggregate totals or
    // lifetime coverage claims may be derived solely from its returned list.
    identityBindingVerified: false, productionAdmitted: false, runtimeAI: false,
    visibleListExhausted: exhausted, allAuthorWorksCollected: false,
    stopReason: exhausted ? 'visible_list_end' : 'page_limit',
    pages: receipts, videos: [...videos.values()],
  };
}
