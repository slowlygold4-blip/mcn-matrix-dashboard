// Isolated public HTML experiment. No browser, cookies, signatures, media fetches,
// retries, model calls, database writes or scheduler admission.
const MAX_BYTES = 2 * 1024 * 1024;
// A fixed, identified mobile rendering client selects the share-page HTML.
// This is not a browser fingerprint, identity pool or challenge solver.
const USER_AGENT = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 MCN-Metadata-Probe/1.0';
const fail = code => Object.assign(new Error(code), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^\d{15,25}$/.test(value);
const count = value => {
  const n = typeof value === 'string' && /^(0|[1-9]\d{0,15})$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

function jsonObjectAt(text, offset) {
  let start = offset;
  while (/\s/.test(text[start] ?? '') && start < text.length) start++;
  if (text[start] !== '{') throw fail('invalid_embedded_json');
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') { if (++depth > 64) throw fail('invalid_embedded_json'); }
    else if (char === '}' || char === ']') {
      if (--depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); }
        catch { throw fail('invalid_embedded_json'); }
      }
    }
  }
  throw fail('invalid_embedded_json');
}

export function parseDouyinShareMetadata(html, { contentId, expectedSecUid, observedAt } = {}) {
  if (!id(contentId) || (expectedSecUid !== undefined && (typeof expectedSecUid !== 'string'
    || !/^MS4wLjAB[A-Za-z0-9_-]{1,230}$/.test(expectedSecUid)))) throw fail('invalid_input');
  const observed = Date.parse(observedAt);
  if (typeof observedAt !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(observedAt) || !Number.isFinite(observed)) throw fail('invalid_clock');
  if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_BYTES) throw fail('response_too_large');
  const items = [];
  let markers = 0, supportedRoutes = 0, embeddedRecords = 0;
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    const marker = /(?:\bwindow\s*\.\s*)?_ROUTER_DATA\s*=\s*/g;
    for (const match of script[1].matchAll(marker)) {
      if (++markers > 8) throw fail('invalid_embedded_json');
      const root = jsonObjectAt(script[1], match.index + match[0].length);
      if (!object(root.loaderData)) continue;
      for (const [route, loader] of Object.entries(root.loaderData)) {
        if (!/^(?:video|note|slides)_\(id\)\/page$/.test(route) || !object(loader)) continue;
        supportedRoutes++;
        const info = loader.videoInfoRes;
        if (!object(info)) continue;
        if (info.status_code !== undefined && info.status_code !== 0) throw fail('platform_unavailable');
        if (info.filter_list?.length && !info.item_list?.length) throw fail('content_unavailable');
        if (!Array.isArray(info.item_list)) continue;
        if (info.item_list.length > 50) throw fail('invalid_embedded_json');
        embeddedRecords += info.item_list.length;
        for (const item of info.item_list) if (object(item) && item.aweme_id === contentId) items.push(item);
      }
    }
  }
  if (!items.length) throw Object.assign(fail(markers ? 'content_not_found' : 'embedded_data_unavailable'), {
    diagnostic: { routerMarkers: markers, supportedRoutes, embeddedRecords, matchedRecords: 0 },
  });
  if (items.length > 1 && items.some(item => JSON.stringify(item) !== JSON.stringify(items[0]))) throw fail('conflicting_content');
  const item = items[0], author = object(item.author) ? item.author : {};
  if (expectedSecUid !== undefined && author.sec_uid !== expectedSecUid) throw fail('author_identity_mismatch');
  const stats = object(item.statistics) ? item.statistics : {};
  const published = count(item.create_time);
  return {
    contentId,
    title: typeof item.desc === 'string' ? item.desc.slice(0, 2000) : '',
    authorSecUid: typeof author.sec_uid === 'string' && /^MS4wLjAB[A-Za-z0-9_-]{1,230}$/.test(author.sec_uid) ? author.sec_uid : null,
    publishedAt: published > 0 && published <= 253402300799 && published * 1000 <= observed
      ? new Date(published * 1000).toISOString() : null,
    observedAt: new Date(observed).toISOString(),
    likes: count(stats.digg_count), comments: count(stats.comment_count),
    shares: count(stats.share_count), collects: count(stats.collect_count),
    // Public share pages are not an authenticated creator analytics source.
    plays: null, plays_source: 'unavailable',
    evidence: { transport: 'public_share_html', reportedPlayCount: count(stats.play_count), playCountVerified: false },
    identityBindingVerified: expectedSecUid !== undefined,
    productionAdmitted: false, allAuthorWorksCollected: false,
    statisticsAvailable: ['digg_count', 'comment_count', 'share_count', 'collect_count'].some(key => count(stats[key]) !== null),
    databaseWrites: 0, modelCalls: 0,
  };
}

export async function probeDouyinShareMetadata(input, { fetchImpl = globalThis.fetch, clock = () => new Date().toISOString(), signal } = {}) {
  // Validate all identity inputs before the first request, including optional UID.
  if (!object(input) || !id(input.contentId) || (input.expectedSecUid !== undefined && (typeof input.expectedSecUid !== 'string'
    || !/^MS4wLjAB[A-Za-z0-9_-]{1,230}$/.test(input.expectedSecUid)))) throw fail('invalid_input');
  if (signal?.aborted) throw fail('cancelled');
  const deadline = AbortSignal.timeout(20_000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let response, url = `https://www.iesdouyin.com/share/video/${input.contentId}/`, networkRequests = 0;
  const seen = new Set([url]);
  for (;;) {
    if (requestSignal.aborted) throw fail(signal?.aborted ? 'cancelled' : 'timeout');
    try {
      networkRequests++;
      response = await fetchImpl(url, {
        method: 'GET', redirect: 'manual', credentials: 'omit', signal: requestSignal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html', 'Accept-Language': 'zh-CN' },
      });
    } catch { throw fail(signal?.aborted ? 'cancelled' : deadline.aborted ? 'timeout' : 'network_error'); }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel().catch(() => {});
    let next;
    try { next = new URL(response.headers.get('location') ?? '', url); }
    catch { throw fail('redirect_refused'); }
    // Canonical redirects are navigation, never an invitation to fetch arbitrary
    // hosts/login/CAPTCHA/private APIs or switch identities after a refusal.
    if (next.protocol !== 'https:' || next.username || next.password || next.port
      || !['www.iesdouyin.com', 'iesdouyin.com', 'www.douyin.com', 'douyin.com'].includes(next.hostname)
      || ![`/share/video/${input.contentId}`, `/share/video/${input.contentId}/`, `/video/${input.contentId}`, `/video/${input.contentId}/`].includes(next.pathname)
      || next.href.length > 2048) throw fail('redirect_refused');
    if (networkRequests >= 3 || seen.has(next.href)) throw fail('redirect_limit');
    url = next.href; seen.add(url);
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    throw fail(response.status === 403 ? 'access_denied' : response.status === 429 ? 'rate_limited'
      : response.status === 401 ? 'login_required' : response.status >= 300 && response.status < 400 ? 'redirect_refused' : 'upstream_http_error');
  }
  if (!/^text\/html(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel().catch(() => {}); throw fail('unexpected_content_type');
  }
  if (!response.body?.getReader) throw fail('invalid_response');
  const reader = response.body.getReader(), parts = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw fail('response_too_large');
      parts.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw fail(error?.code === 'response_too_large' ? error.code : signal?.aborted ? 'cancelled' : deadline.aborted ? 'timeout' : 'invalid_response');
  } finally { reader.releaseLock(); }
  try {
    return { ...parseDouyinShareMetadata(Buffer.concat(parts).toString('utf8'), { ...input, observedAt: clock() }), networkRequests, responseBytes: bytes };
  } catch (error) {
    error.transportEvidence = { networkRequests, responseBytes: bytes, httpStatus: response.status };
    throw error;
  }
}
