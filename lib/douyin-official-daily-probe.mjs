// Official SDK + endpoint documentation evidence: COLLECTION_METHODS_BROWSERLESS_ROUND3_20261030.md.
// Isolated from the scheduler and production DB until app grants and owner bindings are verified.
import { officialProbeReadiness } from './douyin-open-api-probe.mjs';
import { boundedOfficialJson } from './douyin-official-http.mjs';
const fail = code => Object.assign(new Error(code), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const definitions = {
  fans: { path: '/data/external/user/fans/', fields: ['new_fans', 'total_fans'] },
  likes: { path: '/data/external/user/like/', fields: ['new_like'] },
  works: { path: '/data/external/user/item/', fields: ['new_issue', 'new_play', 'total_issue'] },
};
const videoPlayDefinition = { path: '/data/external/item/play/', fields: ['play'] };
const signedFields = new Set(['new_fans', 'new_like', 'new_issue']);

export function officialDailyReadiness(credentials = {}) {
  const r = officialProbeReadiness(credentials);
  return { accessTokenPresent: r.accessTokenPresent, openIdPresent: r.openIdPresent,
    userDataScopeDeclared: Array.isArray(credentials.scopes) && credentials.scopes.includes('data.external.user'),
    platformPermissionVerified: false, identityBindingVerified: false };
}

function dayNumber(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw fail('invalid_date');
  const time = Date.parse(date + 'T00:00:00Z');
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) throw fail('invalid_date');
  return time / 86400000;
}

function integer(value, signed) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && /^-?(0|[1-9]\d*)$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || (!signed && value < 0)) throw fail('invalid_metric');
  return value;
}

export function parseOfficialDaily(body, { kind, days, retrievedAt }) {
  const def = kind === 'video_plays' ? videoPlayDefinition : definitions[kind];
  if (!def || !(kind === 'video_plays' ? [7, 15] : [7, 15, 30]).includes(days) || !Number.isFinite(Date.parse(retrievedAt))) throw fail('invalid_input');
  if (!object(body?.data) || (body.extra !== undefined && !object(body.extra))) throw fail('invalid_response');
  const codes = [body.data.error_code];
  if (body.extra?.error_code !== undefined) codes.push(body.extra.error_code);
  if (body.extra?.sub_error_code !== undefined) codes.push(body.extra.sub_error_code);
  for (const raw of codes) {
    if ([0, '0'].includes(raw)) continue;
    const number = typeof raw === 'number' || (typeof raw === 'string' && /^-?\d{1,10}$/.test(raw)) ? Number(raw) : null;
    throw Object.assign(fail('platform_error'), { officialErrorCode: Number.isSafeInteger(number) ? number : null });
  }
  const list = body.data.result_list;
  if (!Array.isArray(list) || list.length > days) throw fail('invalid_response');
  const today = Math.floor((Date.parse(retrievedAt) + 8 * 3600000) / 86400000), seen = new Set();
  const rows = list.map(row => {
    if (!object(row)) throw fail('invalid_response');
    const day = dayNumber(row.date);
    if (day >= today || day < today - days || seen.has(row.date)) throw fail('invalid_date');
    seen.add(row.date);
    const values = Object.fromEntries(def.fields.map(field => [field, integer(row[field], signedFields.has(field))]));
    return { date: row.date, values };
  }).sort((a, b) => a.date.localeCompare(b.date));
  return { kind, endpoint: def.path, retrievedAt, timezone: 'Asia/Shanghai', rows,
    requestedDays: days, returnedDays: rows.length, missingDays: days - rows.length,
    // API new_fans is retained verbatim, not asserted to mean net follower change.
    // API new_issue is a count difference affected by deletion, not published IDs.
    dailyPublicationCount: null, productionAdmitted: false };
}

export async function probeOfficialDaily({ accessToken, openId, scopes, accountKey, days = 7 }, {
  fetchImpl = globalThis.fetch, clock = () => new Date().toISOString(), signal,
} = {}) {
  const ready = officialDailyReadiness({ accessToken, openId, scopes });
  if (!ready.accessTokenPresent || !ready.openIdPresent) throw fail('authorization_required');
  if (!ready.userDataScopeDeclared) throw fail('scope_required');
  if (typeof accountKey !== 'string' || !/^[A-Za-z0-9:_.-]{1,256}$/.test(accountKey) || ![7, 15, 30].includes(days)) throw fail('invalid_input');
  let networkRequests = 0;
  const datasets = [];
  for (const [kind, def] of Object.entries(definitions)) {
    if (signal?.aborted) throw fail('cancelled');
    const url = new URL(def.path, 'https://open.douyin.com');
    url.search = new URLSearchParams({ open_id: openId, date_type: String(days) });
    let response;
    try {
      networkRequests++;
      response = await fetchImpl(url, { method: 'GET', redirect: 'error', credentials: 'omit',
        headers: { 'access-token': accessToken, 'content-type': 'application/json' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
    } catch { throw fail(signal?.aborted ? 'cancelled' : 'network_error'); }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw fail(response.status === 401 ? 'authorization_required' : response.status === 403 ? 'permission_denied'
        : response.status === 429 ? 'rate_limited' : 'upstream_http_error');
    }
    datasets.push(parseOfficialDaily(await boundedOfficialJson(response, 64 * 1024), { kind, days, retrievedAt: clock() }));
  }
  return { accountKey, source: 'douyin-official-user-daily', datasets, networkRequests,
    platformPermissionVerified: true, identityBindingVerified: false, productionAdmitted: false,
    runtimeAI: false, modelCalls: 0, databaseWrites: 0 };
}

// Different permission and owner-bound encrypted item_id from user daily data.
// No per-author polling, LLM, browser, automatic token acquisition or DB writes.
export function officialVideoPlayReadiness(credentials = {}) {
  const r = officialProbeReadiness(credentials);
  return { accessTokenPresent: r.accessTokenPresent, openIdPresent: r.openIdPresent,
    itemDataScopeDeclared: Array.isArray(credentials.scopes) && credentials.scopes.includes('data.external.item'),
    officialItemIdPresent: typeof credentials.itemId === 'string' && credentials.itemId.length >= 1
      && credentials.itemId.length <= 1024 && !/[\s\x00-\x1f\x7f]/.test(credentials.itemId),
    platformPermissionVerified: false, identityBindingVerified: false };
}

export async function probeOfficialVideoPlays({ accessToken, openId, scopes, accountKey, itemId, days = 7 } = {}, {
  fetchImpl = globalThis.fetch, clock = () => new Date().toISOString(), signal,
} = {}) {
  const ready = officialVideoPlayReadiness({ accessToken, openId, scopes, itemId });
  if (!ready.accessTokenPresent || !ready.openIdPresent) throw fail('authorization_required');
  if (!ready.itemDataScopeDeclared) throw fail('scope_required');
  if (!ready.officialItemIdPresent || typeof accountKey !== 'string'
    || !/^[A-Za-z0-9:_.-]{1,256}$/.test(accountKey) || ![7, 15].includes(days)) throw fail('invalid_input');
  if (signal?.aborted) throw fail('cancelled');
  const retrievedAt = clock();
  if (typeof retrievedAt !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(retrievedAt)
    || !Number.isFinite(Date.parse(retrievedAt))) throw fail('invalid_clock');
  const url = new URL(videoPlayDefinition.path, 'https://open.douyin.com');
  // URLSearchParams encodes the opaque item_id exactly once. Never substitute
  // a public aweme_id or sec_uid for a verified official item_id mapping.
  url.search = new URLSearchParams({ open_id: openId, item_id: itemId, date_type: String(days) });
  let response;
  try {
    response = await fetchImpl(url, { method: 'GET', redirect: 'error', credentials: 'omit',
      headers: { 'access-token': accessToken, 'content-type': 'application/json' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
  } catch { throw fail(signal?.aborted ? 'cancelled' : 'network_error'); }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    throw fail(response.status === 401 ? 'authorization_required' : response.status === 403 ? 'permission_denied'
      : response.status === 429 ? 'rate_limited' : 'upstream_http_error');
  }
  const dataset = parseOfficialDaily(await boundedOfficialJson(response, 64 * 1024),
    { kind: 'video_plays', days, retrievedAt });
  return { accountKey, source: 'douyin-official-video-dated-plays', dataset, plays_source: 'api',
    // Dated source observations, never sum/difference or invent absent days.
    cumulativePlays: null, authorWorksComplete: false, apiEligibleCreationAgeDays: 30,
    firstAuthorizationDelay: 'next_day', networkRequests: 1,
    platformPermissionVerified: true, identityBindingVerified: false, productionAdmitted: false,
    runtimeAI: false, modelCalls: 0, databaseWrites: 0 };
}
