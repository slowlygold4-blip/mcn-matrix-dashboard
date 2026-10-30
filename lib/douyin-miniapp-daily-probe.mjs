// Official ma.user.data route. Separate from legacy data.external.user grants.
// No scheduler admission or DB write until application and author bindings are verified.
import { officialProbeReadiness } from './douyin-open-api-probe.mjs';
import { parseOfficialDaily } from './douyin-official-daily-probe.mjs';
import { boundedOfficialJson } from './douyin-official-http.mjs';

const fail = code => Object.assign(new Error(code), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const endpoints = {
  fans: '/api/apps/v1/user/get_fans/',
  likes: '/api/apps/v1/user/get_like/',
  works: '/api/apps/v1/user/get_item/',
};

export function miniappDailyReadiness(credentials = {}) {
  const ready = officialProbeReadiness(credentials);
  return {
    accessTokenPresent: ready.accessTokenPresent,
    openIdPresent: ready.openIdPresent,
    miniappUserDataScopeDeclared: Array.isArray(credentials.scopes) && credentials.scopes.includes('ma.user.data'),
    supportedDays: [7, 15], todayIncluded: false,
    eligibility: 'officially-authorized-users-above-1000-followers',
    firstAuthorizationDelay: 'next_day',
    platformPermissionVerified: false, identityBindingVerified: false,
  };
}

function platformError(raw) {
  const code = Number.isSafeInteger(raw) ? raw
    : typeof raw === 'string' && /^-?\d{1,10}$/.test(raw) ? Number(raw) : null;
  const kind = [28001003, 28001008].includes(code) ? 'authorization_required'
    : [28001014, 28001018, 28001019].includes(code) ? 'permission_denied'
    : code === 28001016 ? 'application_unavailable'
    : code === 28003017 ? 'quota_exhausted' : 'platform_error';
  return Object.assign(fail(kind), { officialErrorCode: code });
}

export function parseMiniappDaily(body, { kind, days, retrievedAt } = {}) {
  if (!Object.hasOwn(endpoints, kind) || ![7, 15].includes(days)) throw fail('invalid_input');
  if (!object(body) || !Number.isSafeInteger(body.err_no)) throw fail('invalid_response');
  if (body.err_no !== 0) throw platformError(body.err_no);
  if (!object(body.data) || !object(body.data.data)) throw fail('invalid_response');
  if (body.data.data.error_code !== undefined && ![0, '0'].includes(body.data.data.error_code)) {
    throw platformError(body.data.data.error_code);
  }
  // The current API success example has no error_code in the inner data object.
  // Top-level err_no is mandatory; never interpret legacy envelopes as success.
  const dataset = parseOfficialDaily({
    data: { error_code: 0, result_list: body.data.data.result_list },
    ...(body.data.extra === undefined ? {} : { extra: body.data.extra }),
  }, { kind, days, retrievedAt });
  return { ...dataset, endpoint: endpoints[kind] };
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)
    || !Number.isFinite(Date.parse(value))) throw fail('invalid_clock');
  return value;
}

export async function probeMiniappDaily({ accessToken, openId, scopes, accountKey, days = 7 } = {}, {
  fetchImpl = globalThis.fetch, clock = () => new Date().toISOString(), signal,
} = {}) {
  const ready = miniappDailyReadiness({ accessToken, openId, scopes });
  if (!ready.accessTokenPresent || !ready.openIdPresent) throw fail('authorization_required');
  if (!ready.miniappUserDataScopeDeclared) throw fail('scope_required');
  if (typeof accountKey !== 'string' || !/^[A-Za-z0-9:_.-]{1,256}$/.test(accountKey) || ![7, 15].includes(days)) {
    throw fail('invalid_input');
  }
  const datasets = [];
  for (const [kind, path] of Object.entries(endpoints)) {
    if (signal?.aborted) throw fail('cancelled');
    const startedAt = timestamp(clock());
    const url = new URL(path, 'https://open.douyin.com');
    url.search = new URLSearchParams({ open_id: openId, date_type: String(days) });
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
    const retrievedAt = timestamp(clock());
    datasets.push({ ...parseMiniappDaily(await boundedOfficialJson(response, 64 * 1024), { kind, days, retrievedAt }), startedAt });
  }
  return { accountKey, source: 'douyin-official-miniapp-user-daily', datasets,
    networkRequests: datasets.length, platformPermissionVerified: true,
    identityBindingVerified: false, productionAdmitted: false, authorWorksComplete: false,
    runtimeAI: false, modelCalls: 0, databaseWrites: 0 };
}
