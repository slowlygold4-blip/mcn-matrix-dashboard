// One operator-approved author page. No scheduling, discovery, retries, browser,
// local credentials, persistence or models. Admission still validates identity,
// counters and observation clocks; a returned page is never complete inventory.
const DEMO_ORIGIN = 'https://demo.douyin.wtf';
const MAX_BYTES = 1_048_576;
const TOTAL_TIMEOUT_MS = 50_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const UPSTREAM_CODES = new Set([
  'ENDPOINT_CIRCUIT_OPEN', 'IDENTITY_LOGIN_REQUIRED', 'IDENTITY_POOL_EMPTY',
  'IDENTITY_UNAVAILABLE', 'RATE_LIMITED', 'UPSTREAM_RATE_LIMITED',
  'UPSTREAM_BLOCKED', 'UPSTREAM_UNREACHABLE', 'UPSTREAM_CHANGED',
  'UPSTREAM_ERROR', 'NOT_FOUND', 'FORBIDDEN', 'UNAUTHORIZED', 'INVALID_REQUEST',
]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class RemoteAuthorPostsHttpError extends Error {
  constructor(code, {httpStatus = null, upstreamCode = null, retryAfterSeconds = null} = {}) {
    // Never include a fetch exception, response message, URL or credential.
    super(`Remote author page request failed (${code})`);
    this.name = 'RemoteAuthorPostsHttpError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.upstreamCode = upstreamCode;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
const fail = (code, details) => { throw new RemoteAuthorPostsHttpError(code, details); };

function sourceOriginValue(value) {
  let url;
  try { url = new URL(value); } catch { fail('invalid_configuration'); }
  if (typeof value !== 'string' || url.protocol !== 'https:' || url.origin !== value
      || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    fail('invalid_configuration');
  }
  return value;
}

// fetchImpl can be injected for tests. Race even implementations/readers that
// ignore AbortSignal so the caller still has a hard deadline.
async function withinSignal(operation, signal) {
  if (signal.aborted) fail('cancelled');
  let abort;
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(new RemoteAuthorPostsHttpError('cancelled'));
    signal.addEventListener('abort', abort, {once: true});
  });
  try { return await Promise.race([Promise.resolve().then(() => {
    if (signal.aborted) fail('cancelled');
    return operation();
  }), interrupted]); }
  finally { signal.removeEventListener('abort', abort); }
}

async function readBody(response, signal) {
  const declared = response.headers?.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_BYTES) {
    // Cancellation is best effort; it must not extend the total deadline.
    void response.body?.cancel?.().catch(() => {});
    fail('response_too_large');
  }
  if (!response.body?.getReader) fail('invalid_response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0, complete = false;
  try {
    while (true) {
      const {done, value} = await withinSignal(() => reader.read(), signal);
      if (done) { complete = true; break; }
      if (!(value instanceof Uint8Array)) fail('invalid_response');
      size += value.byteLength;
      if (size > MAX_BYTES) fail('response_too_large');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
    catch { return null; }
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function retryAfter(value, nowMs) {
  if (typeof value !== 'string' || value.length > 100) return null;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value.trim())
    : Math.ceil((Date.parse(value) - nowMs) / 1000);
  return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 31_536_000 ? seconds : null;
}

function statusError(status, body, headers, nowMs) {
  const candidate = object(body?.error) ? body.error.code : null;
  const upstreamCode = UPSTREAM_CODES.has(candidate) ? candidate : null;
  const details = {httpStatus: status, upstreamCode,
    retryAfterSeconds: retryAfter(headers?.get('retry-after'), nowMs)};
  let code = 'upstream_error';
  if (status === 401) code = 'login_required';
  else if (status === 403) code = 'forbidden';
  else if (status === 429) code = 'rate_limited';
  else if (status >= 500 && status <= 599) code = 'upstream_unavailable';
  else if (status >= 300 && status <= 399) code = 'redirect_refused';
  else if (status === 202) code = 'pending';
  if (upstreamCode === 'ENDPOINT_CIRCUIT_OPEN') code = 'circuit_open';
  if (upstreamCode === 'IDENTITY_LOGIN_REQUIRED') code = 'login_required';
  if (upstreamCode === 'RATE_LIMITED' || upstreamCode === 'UPSTREAM_RATE_LIMITED') code = 'rate_limited';
  return new RemoteAuthorPostsHttpError(code, details);
}

function readCookies(headers, jar) {
  const values = typeof headers?.getSetCookie === 'function' ? headers.getSetCookie()
    : [headers?.get('set-cookie')].filter(Boolean);
  for (const header of values) {
    if (header.length > 8192) fail('invalid_response');
    const [pair, ...attributes] = header.split(';');
    const separator = pair.indexOf('=');
    if (separator <= 0) fail('invalid_response');
    const name = pair.slice(0, separator).trim(), value = pair.slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~\w-]{1,128}$/.test(name)
        || !/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{0,4096}$/.test(value)) fail('invalid_response');
    const attrs = new Map(attributes.map(part => {
      const split = part.indexOf('=');
      return split < 0 ? [part.trim().toLowerCase(), '']
        : [part.slice(0, split).trim().toLowerCase(), part.slice(split + 1).trim()];
    }));
    // Do not broaden the cookie to a parent/sibling domain or a different path.
    if (attrs.has('domain') && attrs.get('domain').replace(/^\./, '').toLowerCase() !== 'demo.douyin.wtf') continue;
    if (attrs.has('path') && !['/', '/api', '/api/', '/api/v1', '/api/v1/'].includes(attrs.get('path'))) continue;
    if (attrs.get('max-age') === '0' || value === '') jar.delete(name);
    else jar.set(name, value);
    if (jar.size > 32 || [...jar].reduce((n, [k, v]) => n + k.length + v.length + 2, 0) > 16_384) fail('invalid_response');
  }
}

function receiptProjection(body, source, startedAt, finishedAt) {
  if (!object(body?.data) || !object(body?.meta) || !Array.isArray(body.data.items)
      || body.data.items.length < 1 || body.data.items.length > 100) fail('invalid_response');
  const pick = (input, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(input, key)).map(key => {
    if (input[key] !== null && !['string', 'number', 'boolean'].includes(typeof input[key])) fail('invalid_response');
    return [key, input[key]];
  }));
  const items = body.data.items.map(item => {
    if (!object(item) || !object(item.author) || !object(item.stats)) fail('invalid_response');
    return {...pick(item, ['platform', 'content_id', 'title', 'created_at', 'fetched_at', 'is_deleted', 'is_private']),
      author: pick(item.author, ['uid', 'sec_uid', 'nickname']),
      stats: pick(item.stats, ['digg_count', 'comment_count', 'share_count', 'collect_count'])};
  });
  return {source, httpStatus: 200, requestStartedAt: startedAt, requestFinishedAt: finishedAt,
    meta: pick(body.meta, ['endpoint', 'cached', 'request_id', 'guest_fallback']),
    data: {...pick(body.data, ['has_more', 'cursor']), items}};
}

/**
 * authMode must explicitly be 'demo' (exact demo origin) or 'bearer'.
 * bearerToken is supplied by the caller; never loaded from files/env/browser.
 * Returns {receipt, transport}; errors carry the same sanitized transport counts.
 */
export async function fetchRemoteAuthorPosts({sourceOrigin, secUid, signal,
  fetchImpl = globalThis.fetch, now = () => Date.now(), authMode, bearerToken} = {}) {
  const transport = {totalRequests: 0, authRequests: 0, businessRequests: 0,
    logoutAttempted: false, logoutStatus: null, credentialsCleared: false};
  const jar = new Map();
  let token = null, loginBody = null, signed = false, primaryError = null, receipt = null;
  const deadline = new AbortController();
  let timer;
  const clock = () => {
    const value = now();
    if (!Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) fail('invalid_configuration');
    return value;
  };
  try {
    const origin = sourceOriginValue(sourceOrigin);
    if (typeof secUid !== 'string' || !/^MS4wLj[\w-]{12,220}$/.test(secUid)
        || typeof now !== 'function' || typeof fetchImpl !== 'function'
        || (signal != null && !(signal instanceof AbortSignal))) fail('invalid_configuration');
    if (authMode === 'demo') {
      if (origin !== DEMO_ORIGIN || bearerToken != null) fail('invalid_configuration');
    } else if (authMode === 'bearer') {
      if (typeof bearerToken !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(bearerToken)) fail('invalid_configuration');
      token = bearerToken;
    } else fail('invalid_configuration');
    clock();
    timer = setTimeout(() => deadline.abort(), TOTAL_TIMEOUT_MS);
    const active = signal ? AbortSignal.any([deadline.signal, signal]) : deadline.signal;

    const call = async (path, {body = null, business = false, cleanup = false} = {}) => {
      const cleanupController = cleanup ? new AbortController() : null;
      const cleanupTimer = cleanup ? setTimeout(() => cleanupController.abort(), CLEANUP_TIMEOUT_MS) : null;
      const current = cleanup ? AbortSignal.any([deadline.signal, cleanupController.signal]) : active;
      const startedAt = new Date(clock()).toISOString();
      try {
        if (current.aborted) fail('cancelled');
        const headers = {Accept: 'application/json', 'User-Agent': 'MCN-Remote-Observation/1.0'};
        if (token) headers.Authorization = `Bearer ${token}`;
        if (jar.size) headers.Cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
        if (body !== null) { headers['Content-Type'] = 'application/json'; headers.Origin = origin; }
        transport.totalRequests++;
        if (business) transport.businessRequests++;
        else transport.authRequests++;
        const response = await withinSignal(() => fetchImpl(origin + path, {
          method: body === null ? 'GET' : 'POST', headers, body: body === null ? undefined : JSON.stringify(body),
          redirect: 'error', credentials: 'omit', cache: 'no-store', signal: current,
        }), current);
        if (!Number.isInteger(response?.status)) fail('invalid_response');
        if (authMode === 'demo' && response.status === 200) {
          readCookies(response.headers, jar);
          // A server session may exist even if its subsequent JSON body is bad.
          if (path === '/api/v1/auth/login' && jar.size) signed = true;
        }
        const parsed = await readBody(response, current);
        const finishedAt = new Date(clock()).toISOString();
        if (response.status !== 200) throw statusError(response.status, parsed, response.headers, clock());
        if (!object(parsed)) fail('invalid_response', {httpStatus: response.status});
        if (parsed.success === false) throw statusError(response.status, parsed, response.headers, clock());
        return {body: parsed, status: response.status, startedAt, finishedAt};
      } finally { if (cleanupTimer !== null) clearTimeout(cleanupTimer); }
    };

    try {
      if (authMode === 'demo') {
        let bootstrap = (await call('/api/v1/auth/demo')).body;
        if (!object(bootstrap.data) || bootstrap.data.enabled !== true
            || typeof bootstrap.data.username !== 'string' || !bootstrap.data.username
            || typeof bootstrap.data.password !== 'string' || !bootstrap.data.password
            || bootstrap.data.username.length > 256 || bootstrap.data.password.length > 1024) fail('login_required');
        loginBody = {username: bootstrap.data.username, password: bootstrap.data.password};
        bootstrap = null;
        const login = await call('/api/v1/auth/login', {body: loginBody});
        loginBody = null;
        signed = login.status === 200;
        if (!jar.size) fail('login_required');
      }
      const params = new URLSearchParams({sec_user_id: secUid, count: '20', wait: '25', refresh: 'false'});
      const response = await call(`/api/v1/douyin/user/posts?${params}`, {business: true});
      if (response.body.success !== true) fail('invalid_response', {httpStatus: response.status});
      receipt = receiptProjection(response.body, origin, response.startedAt, response.finishedAt);
    } catch (error) {
      primaryError = error instanceof RemoteAuthorPostsHttpError ? error : new RemoteAuthorPostsHttpError('network_error');
      if (deadline.signal.aborted) primaryError = new RemoteAuthorPostsHttpError('timeout');
      else if (signal?.aborted) primaryError = new RemoteAuthorPostsHttpError('cancelled');
    } finally {
      // Cancellation still gets one bounded logout attempt if time remains.
      // Logout failure must never erase a successful page or its original error.
      if (signed && !deadline.signal.aborted) {
        transport.logoutAttempted = true;
        try { transport.logoutStatus = (await call('/api/v1/auth/logout', {body: {}, cleanup: true})).status; }
        catch (error) { transport.logoutStatus = error instanceof RemoteAuthorPostsHttpError ? error.httpStatus : null; }
      }
    }
    if (primaryError) throw primaryError;
  } catch (error) {
    primaryError = error instanceof RemoteAuthorPostsHttpError ? error : new RemoteAuthorPostsHttpError('network_error');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    jar.clear(); token = null; loginBody = null; bearerToken = null;
    transport.credentialsCleared = true;
  }
  if (primaryError) { primaryError.transport = {...transport}; throw primaryError; }
  return {receipt, transport: {...transport}};
}
