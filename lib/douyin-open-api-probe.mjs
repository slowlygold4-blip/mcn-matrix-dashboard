// Read-only, isolated official API trial. This is not wired to the production
// scheduler: open_id/item_id need verified bindings before production admission.
const ORIGIN = 'https://open.douyin.com';
const ENDPOINT = '/video/list/';
const MAX_BODY = 2 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => Object.assign(new Error(code), { code });
const metric = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function officialProbeReadiness({ accessToken, openId, scopes } = {}) {
  return {
    accessTokenPresent: typeof accessToken === 'string' && accessToken.length > 0 && accessToken.length <= 4096 && !/[\s\x00-\x1f\x7f]/.test(accessToken),
    openIdPresent: typeof openId === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(openId),
    videoListScopeDeclared: Array.isArray(scopes) && scopes.includes('video.list'),
    // A declaration is not evidence that the platform approved the permission.
    platformPermissionVerified: false,
  };
}

async function boundedJson(response) {
  if (!response.body?.getReader) throw fail('invalid_response');
  const reader = response.body.getReader();
  let size = 0;
  const parts = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) throw fail('response_too_large');
      parts.push(value);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error?.code === 'response_too_large') throw error;
    throw fail('invalid_response');
  } finally { reader.releaseLock(); }
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
