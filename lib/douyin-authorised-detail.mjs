import { retiredDouyinBrowserError } from "./retired-douyin-browser-command.mjs";
import { createHash } from 'node:crypto';
import { access, lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const ORIGIN = 'https://www.douyin.com';
const DETAIL = '/aweme/v1/web/aweme/detail/';
const SEC = /^MS4wLj[\w-]{12,220}$/;
const VIDEO = /^[1-9]\d{14,24}$/;
const UID = /^[1-9]\d{1,24}$/;
const HANDLE = /^[A-Za-z0-9_.-]{1,100}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_BODY = 2 * 1024 * 1024;
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEFAULT_DATA = fileURLToPath(new URL('../data/', import.meta.url));
export const AUTHORISED_DETAIL_PROVENANCE = 'authorised-browser-natural-detail';
export const AUTHORISED_DETAIL_HASH_SCOPE = 'public-identity-projection-v1';
export const AUTHORISED_DETAIL_FINAL_URL_SCOPE = 'observed-origin-path';
const ERROR_CODES = new Set(['disabled', 'ownership_required', 'invalid_input', 'session_required', 'session_permissions',
  'session_invalid', 'browser_unavailable', 'timeout', 'login_required', 'blocked', 'rate_limited', 'challenge_required',
  'business_error', 'identity_mismatch', 'invalid_evidence', 'no_bound_response', 'navigation_error', 'collector_error',
  'cleanup_uncertain', 'cancelled']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const DIAGNOSTIC_REASONS = Object.freeze({
  body: Object.freeze({ body_type_invalid: 'invalid_evidence', body_too_large: 'invalid_evidence', body_not_json: 'invalid_evidence' }),
  detail_fields: Object.freeze(Object.fromEntries(['payload_not_object', 'detail_invalid_shape', 'author_invalid_shape',
    'work_id_missing', 'work_id_invalid_type', 'work_id_mismatch', 'sec_uid_missing', 'sec_uid_invalid_type', 'sec_uid_invalid_format',
    'uid_missing', 'uid_invalid_type', 'uid_invalid_format', 'author_deleted'].map(reason => [reason, 'invalid_evidence']))),
  public_identity: Object.freeze(Object.fromEntries(['public_id_absent', 'public_id_invalid', 'submitted_id_mismatch',
    'expected_sec_uid_mismatch', 'expected_uid_mismatch', 'conflicting_responses'].map(reason => [reason, 'identity_mismatch']))),
});
// Diagnostics explain a failed check, never serve as identity proof. The same
// finite projection runs in the child and parent; no payload values, URLs,
// headers, exception text, or arbitrary diagnostic properties are retained.
function diagnosticFields(value, code) {
  if (!object(value) || value.version !== 1 || typeof value.stage !== 'string' || typeof value.reason !== 'string'
    || !Object.hasOwn(DIAGNOSTIC_REASONS, value.stage)
    || !Object.hasOwn(DIAGNOSTIC_REASONS[value.stage], value.reason)
    || DIAGNOSTIC_REASONS[value.stage][value.reason] !== code) return {};
  return { diagnostic: { version: 1, stage: value.stage, reason: value.reason } };
}
const fail = (code, stage, reason) => {
  const safeCode = ERROR_CODES.has(code) ? code : 'collector_error';
  return Object.assign(new Error(safeCode), { code: safeCode,
    ...diagnosticFields({ version: 1, stage, reason }, safeCode) });
};
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifier = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/^@/, '').toLowerCase() : '';
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? Date.parse(value) : NaN;
const provenance = () => ({ mode: AUTHORISED_DETAIL_PROVENANCE, authorisedSessionUsed: true,
  authenticated: null, authenticationStatus: 'not-verified', noChallengeBypass: true, runtimeAI: false, paidAPI: false });

/** Locator-only input is not an assertion about a submitted account. */
export function normalizeAuthorisedWorkInput(payload) {
  if (!object(payload) || !Array.isArray(payload.items) || payload.items.length !== 1) throw fail('invalid_input');
  const item = payload.items[0];
  if (!object(item) || typeof item.key !== 'string' || !item.key || item.key.length > 300 || /[\u0000-\u001f\u007f-\u009f]/.test(item.key)) throw fail('invalid_input');
  const direct = item.videoId !== undefined, share = item.shareUrl !== undefined;
  if (direct === share || (direct && (typeof item.videoId !== 'string' || !VIDEO.test(item.videoId)))
    || (share && !isExactShareUrl(item.shareUrl))) throw fail('invalid_input');
  return { key: item.key, ...(direct ? { videoId: item.videoId } : { shareUrl: item.shareUrl }) };
}

export function normalizeAuthorisedDetailInput(payload) {
  const work = normalizeAuthorisedWorkInput(payload), item = payload.items[0];
  if (typeof item.submittedId !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(item.submittedId)) throw fail('invalid_input');
  const submittedId = identifier(item.submittedId);
  if (!HANDLE.test(submittedId) || submittedId === '0'
    || (item.expectedSecUid !== undefined && (typeof item.expectedSecUid !== 'string' || !SEC.test(item.expectedSecUid)))
    || (item.expectedUid !== undefined && (typeof item.expectedUid !== 'string' || !UID.test(item.expectedUid)))) throw fail('invalid_input');
  return { ...work, submittedId,
    ...(item.expectedSecUid === undefined ? {} : { expectedSecUid: item.expectedSecUid }),
    ...(item.expectedUid === undefined ? {} : { expectedUid: item.expectedUid }) };
}

function isExactShareUrl(value) {
  if (typeof value !== 'string' || value.length > 512 || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  try {
    const url = new URL(value), authority = /^https:\/\/([^/?#]*)/i.exec(value)?.[1];
    return authority?.toLowerCase() === 'v.douyin.com' && url.origin === 'https://v.douyin.com'
      && !url.username && !url.password && !url.port && !url.search && !url.hash
      && /^\/[A-Za-z0-9_-]{4,128}\/?$/.test(url.pathname);
  } catch { return false; }
}

/** Full observed URL is checked before its tracking query is discarded. The
 * digest records that observation; it is not a signature from the platform. */
export function officialWorkLocation(value) {
  if (typeof value !== 'string' || value.length > 16_384 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value), authority = /^https:\/\/([^/?#]*)/i.exec(value)?.[1];
    if (!['www.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com'].includes(url.hostname)
      || authority?.toLowerCase() !== url.hostname || url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const legacy = url.hostname !== 'www.douyin.com';
    const videoId = url.pathname.match(legacy ? /^\/share\/video\/([1-9]\d{14,24})\/?$/ : /^\/video\/([1-9]\d{14,24})\/?$/)?.[1];
    if (!videoId) return null;
    for (const key of ['aweme_id', 'item_id', 'modal_id']) if (url.searchParams.getAll(key).some(id => id !== videoId)) return null;
    return { videoId, finalUrl: `${url.origin}${url.pathname}`,
      finalUrlSha256: createHash('sha256').update(value).digest('hex'), finalUrlScope: AUTHORISED_DETAIL_FINAL_URL_SCOPE };
  } catch { return null; }
}

export function isExpectedAuthorisedDetailResponseUrl(value, videoId) {
  if (typeof value !== 'string' || !VIDEO.test(videoId) || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  try {
    const url = new URL(value), authority = /^https:\/\/([^/?#]*)/i.exec(value)?.[1];
    return Boolean(authority?.toLowerCase() === 'www.douyin.com' && url.origin === ORIGIN && !url.username && !url.password
      && !url.port && !url.hash && url.pathname === DETAIL
      && url.searchParams.getAll('aweme_id').length === 1 && url.searchParams.get('aweme_id') === videoId);
  } catch { return false; }
}

function pageKind(value, videoId) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return 'other';
    if (url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com')) {
      if (/\/(?:captcha|verify|challenge)(?:\/|$)/i.test(url.pathname)) return 'challenge_required';
      if (/^(?:login|passport)\./i.test(url.hostname) || /\/(?:login|passport)(?:\/|$)/i.test(url.pathname)) return 'login_required';
    }
    return officialWorkLocation(value)?.videoId === videoId ? 'expected' : 'other';
  } catch { return 'other'; }
}
function barrier(value) {
  if (!object(value)) return null;
  if (['need_login', 'login_required'].some(key => Boolean(value[key]))) return 'login_required';
  if (['captcha_required', 'verify_required'].some(key => Boolean(value[key]))) return 'challenge_required';
  return null;
}

/** Public work-author structure only; never proves a submitted account ID. */
export function validateAuthorisedWorkResponse(payload, input) {
  if (!object(payload)) throw fail('invalid_evidence', 'detail_fields', 'payload_not_object');
  const detail = payload.aweme_detail, author = detail?.author;
  for (const value of [payload, detail, author]) { const code = barrier(value); if (code) throw fail(code); }
  if (payload.status_code !== 0) throw fail('business_error');
  if (!object(detail)) throw fail('invalid_evidence', 'detail_fields', 'detail_invalid_shape');
  if (!object(author)) throw fail('invalid_evidence', 'detail_fields', 'author_invalid_shape');
  if (detail.aweme_id === undefined || detail.aweme_id === null || detail.aweme_id === '') throw fail('invalid_evidence', 'detail_fields', 'work_id_missing');
  if (typeof detail.aweme_id !== 'string') throw fail('invalid_evidence', 'detail_fields', 'work_id_invalid_type');
  if (detail.aweme_id !== input.videoId) throw fail('invalid_evidence', 'detail_fields', 'work_id_mismatch');
  if (author.sec_uid === undefined || author.sec_uid === null || author.sec_uid === '') throw fail('invalid_evidence', 'detail_fields', 'sec_uid_missing');
  if (typeof author.sec_uid !== 'string') throw fail('invalid_evidence', 'detail_fields', 'sec_uid_invalid_type');
  if (!SEC.test(author.sec_uid)) throw fail('invalid_evidence', 'detail_fields', 'sec_uid_invalid_format');
  if (author.uid === undefined || author.uid === null || author.uid === '') throw fail('invalid_evidence', 'detail_fields', 'uid_missing');
  if (typeof author.uid !== 'string') throw fail('invalid_evidence', 'detail_fields', 'uid_invalid_type');
  if (!UID.test(author.uid)) throw fail('invalid_evidence', 'detail_fields', 'uid_invalid_format');
  if (author.user_deleted === true) throw fail('invalid_evidence', 'detail_fields', 'author_deleted');
  const publicIds = {};
  if (typeof author.unique_id === 'string' && HANDLE.test(author.unique_id)) publicIds.unique_id = author.unique_id;
  if (typeof author.short_id === 'string' && /^[0-9]{1,25}$/.test(author.short_id)) publicIds.short_id = author.short_id;
  if (!Object.keys(publicIds).length) {
    const absent = [author.unique_id, author.short_id].every(value => value === undefined || value === null || value === '');
    throw fail('identity_mismatch', 'public_identity', absent ? 'public_id_absent' : 'public_id_invalid');
  }
  return { status_code: 0, aweme_detail: { aweme_id: detail.aweme_id,
    author: { sec_uid: author.sec_uid, uid: author.uid, ...publicIds } } };
}

/** Strict identity wrapper remains mandatory for every admission path. */
export function validateAuthorisedDetailResponse(payload, input) {
  const response = validateAuthorisedWorkResponse(payload, input), author = response.aweme_detail.author;
  if (![author.unique_id, author.short_id].some(value => value !== undefined && identifier(value) === input.submittedId)) {
    throw fail('identity_mismatch', 'public_identity', 'submitted_id_mismatch');
  }
  if (input.expectedSecUid !== undefined && input.expectedSecUid !== author.sec_uid) throw fail('identity_mismatch', 'public_identity', 'expected_sec_uid_mismatch');
  if (input.expectedUid !== undefined && input.expectedUid !== author.uid) throw fail('identity_mismatch', 'public_identity', 'expected_uid_mismatch');
  return response;
}

function candidateFrom(response, observedAt) {
  const author = response.aweme_detail.author;
  return { videoId: response.aweme_detail.aweme_id, secUid: author.sec_uid, uid: author.uid,
    uniqueId: author.unique_id ?? '', shortId: author.short_id ?? '', provenance: AUTHORISED_DETAIL_PROVENANCE,
    observedAt, responseSha256: hash(response), responseSha256Scope: AUTHORISED_DETAIL_HASH_SCOPE };
}
export { candidateFrom as authorisedWorkCandidateFrom };

/** Parent-side second check. Hash covers the attached public identity projection,
 * not unretained HTTP bytes or a cryptographic signature from the platform. */
export function validateAuthorisedDetailResult(input, result, { startedAt, finishedAt } = {}) {
  const outerStart = instant(startedAt), outerEnd = instant(finishedAt);
  const share = input.shareUrl !== undefined;
  if (!object(result) || ![outerStart, outerEnd].every(Number.isFinite) || outerEnd < outerStart || outerEnd - outerStart > 45_000
    || result.key !== input.key || (share ? result.shareUrl !== input.shareUrl : result.videoId !== input.videoId)
    || result.submittedId !== input.submittedId
    || !['ok', 'unavailable'].includes(result.status)) throw fail('invalid_evidence');
  const start = instant(result.requestStartedAt), finish = instant(result.requestFinishedAt);
  if (![start, finish].every(Number.isFinite) || start < outerStart || finish < start || finish > outerEnd
    || finish - start > 45_000) throw fail('invalid_evidence');
  const base = { status: result.status, key: input.key,
    ...(share ? { shareUrl: input.shareUrl } : { videoId: input.videoId }), submittedId: input.submittedId,
    requestStartedAt: result.requestStartedAt, requestFinishedAt: result.requestFinishedAt };
  if (result.status === 'unavailable') {
    if (!ERROR_CODES.has(result.errorCode) || result.candidate !== undefined || result.evidence !== undefined
      || (share && result.videoId !== undefined)) throw fail('invalid_evidence');
    return { ...base, errorCode: result.errorCode, ...diagnosticFields(result.diagnostic, result.errorCode) };
  }
  const e = result.evidence, c = result.candidate, p = result.provenance;
  let videoId = input.videoId, finalLocation = null;
  if (share) {
    const observed = object(e) && officialWorkLocation(e.finalUrl);
    if (!observed || e.finalUrl !== observed.finalUrl || e.requestedShareUrl !== input.shareUrl
      || e.finalUrlScope !== AUTHORISED_DETAIL_FINAL_URL_SCOPE || !HASH.test(e.finalUrlSha256 ?? '')
      || e.finalVideoId !== observed.videoId || result.videoId !== observed.videoId) throw fail('invalid_evidence');
    videoId = observed.videoId;
    finalLocation = { requestedShareUrl: input.shareUrl, finalUrl: e.finalUrl,
      finalUrlSha256: e.finalUrlSha256, finalUrlScope: AUTHORISED_DETAIL_FINAL_URL_SCOPE, finalVideoId: videoId };
  }
  if (!object(e) || !object(c) || !object(p) || e.version !== 1 || e.kind !== 'natural-main-frame-detail-response'
    || e.origin !== ORIGIN || e.path !== DETAIL || e.method !== 'GET' || e.httpStatus !== 200
    || e.requestedVideoId !== videoId || e.responseSha256Scope !== AUTHORISED_DETAIL_HASH_SCOPE
    || p.mode !== AUTHORISED_DETAIL_PROVENANCE || p.authorisedSessionUsed !== true || p.noChallengeBypass !== true
    || p.runtimeAI !== false || p.paidAPI !== false || p.authenticated !== null || p.authenticationStatus !== 'not-verified') throw fail('invalid_evidence');
  const observed = instant(e.observedAt);
  if (!Number.isFinite(observed) || observed < start || observed > finish) throw fail('invalid_evidence');
  const response = validateAuthorisedDetailResponse(e.response, { ...input, videoId }), candidate = candidateFrom(response, e.observedAt);
  if (!HASH.test(c.responseSha256 ?? '') || Object.entries(candidate).some(([key, value]) => c[key] !== value)
    || e.responseSha256 !== candidate.responseSha256) throw fail('invalid_evidence');
  return { ...base, ...(share ? { videoId } : {}), candidate, evidence: { version: 1, kind: e.kind, origin: ORIGIN, path: DETAIL, method: 'GET', httpStatus: 200,
    ...finalLocation, requestedVideoId: videoId, observedAt: e.observedAt, responseSha256: candidate.responseSha256,
    responseSha256Scope: AUTHORISED_DETAIL_HASH_SCOPE, response }, provenance: provenance() };
}

async function readAuthorisedState() {
  const path = resolve(process.env.DOUYIN_ACCOUNT_BROWSER_STATE || process.env.DOUYIN_TOPIC_BROWSER_STATE
    || resolve(process.env.DATA_DIR || DEFAULT_DATA, 'douyin-topic-browser-state.json'));
  const info = await lstat(path).catch(() => null);
  if (!info) throw fail('session_required');
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw fail('session_permissions');
  if (info.size > MAX_BODY) throw fail('session_invalid');
  let state;
  try { state = JSON.parse(await readFile(path, 'utf8')); } catch { throw fail('session_invalid'); }
  if (!object(state) || !Array.isArray(state.cookies) || !state.cookies.length) throw fail('session_required');
  return state; // Never write/refresh/export the authorised session.
}

async function bounded(promise, milliseconds, signal) {
  let timer, abort;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(fail('timeout')), Math.max(1, milliseconds));
      abort = () => reject(fail('cancelled'));
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    })]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
async function openResource(create, milliseconds, signal) {
  const opening = Promise.resolve().then(create);
  try { return await bounded(opening, milliseconds, signal); }
  catch (error) { void opening.then(resource => bounded(Promise.resolve().then(() => resource?.close()), 1500).catch(() => {}), () => {}); throw error; }
}

/** One navigation; only natural requests are observed. No evaluate/fetch/replay. */
async function observeDetail(page, input, remaining, signal, validateResponse) {
  let settled = false, committed = false, generation = 0, resolveResult, pendingBodies = 0, candidate = null;
  let boundVideoId = input.videoId ?? null, observedNavigationWorkId = input.videoId ?? null;
  const bodyController = new AbortController();
  const bodySignal = signal ? AbortSignal.any([signal, bodyController.signal]) : bodyController.signal;
  const requests = new WeakMap(), consumed = new WeakSet();
  const result = new Promise(resolve => { resolveResult = resolve; });
  const finish = value => { if (!settled) { settled = true; resolveResult(value); } };
  const refusal = (code, diagnostic) => finish({ errorCode: code, ...diagnosticFields(diagnostic, code) });
  const current = () => committed && pageKind(page.url(), boundVideoId) === 'expected';
  const sameShare = value => input.shareUrl && isExactShareUrl(value)
    && new URL(value).pathname.replace(/\/$/, '') === new URL(input.shareUrl).pathname.replace(/\/$/, '');
  const checkNavigation = value => {
    const kind = pageKind(value, boundVideoId);
    if (['login_required', 'challenge_required'].includes(kind)) { refusal(kind); return false; }
    if (observedNavigationWorkId === null && sameShare(value)) return true;
    const location = officialWorkLocation(value);
    if (!location || (observedNavigationWorkId && location.videoId !== observedNavigationWorkId)) {
      refusal('navigation_error'); return false;
    }
    observedNavigationWorkId = location.videoId;
    return true;
  };
  const checkNavigationRequest = request => {
    const chain = [], visited = new Set();
    for (let hop = request; hop; hop = hop.redirectedFrom()) {
      if (visited.has(hop) || chain.length >= 12 || !hop.isNavigationRequest() || hop.frame() !== page.mainFrame()) {
        refusal('navigation_error'); return false;
      }
      visited.add(hop); chain.push(hop);
    }
    let chainWorkId = null;
    for (const hop of chain.reverse()) {
      const value = hop.url(), kind = pageKind(value, boundVideoId);
      if (['login_required', 'challenge_required'].includes(kind)) { refusal(kind); return false; }
      if (chainWorkId === null && sameShare(value)) continue;
      const location = officialWorkLocation(value);
      if (!location || (chainWorkId && location.videoId !== chainWorkId)
        || (observedNavigationWorkId && location.videoId !== observedNavigationWorkId)) {
        refusal('navigation_error'); return false;
      }
      chainWorkId = location.videoId;
    }
    return checkNavigation(request.url());
  };
  const onFrame = frame => {
    try {
      if (frame !== page.mainFrame()) return;
      generation++; pendingBodies = 0; candidate = null;
      const value = frame.url(), location = officialWorkLocation(value);
      if (!checkNavigation(value)) { committed = false; return; }
      const kind = pageKind(value, boundVideoId);
      if (['login_required', 'challenge_required'].includes(kind)) refusal(kind);
      else if (input.shareUrl && boundVideoId === null && isExactShareUrl(value)
        && new URL(value).pathname.replace(/\/$/, '') === new URL(input.shareUrl).pathname.replace(/\/$/, '')) committed = false;
      else if (location && (!boundVideoId || location.videoId === boundVideoId)) {
        boundVideoId = location.videoId; committed = true;
      } else { committed = false; refusal('navigation_error'); }
    } catch { refusal('navigation_error'); }
  };
  const onRequest = request => {
    try {
      if (!settled && request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        checkNavigationRequest(request); return;
      }
      if (!settled && current() && request.frame() === page.mainFrame() && request.method() === 'GET'
        && request.isNavigationRequest() === false && request.redirectedFrom() === null
        && isExpectedAuthorisedDetailResponseUrl(request.url(), boundVideoId)) requests.set(request, generation);
    } catch { /* Unattributed requests are not evidence. */ }
  };
  const onResponse = response => {
    if (settled) return;
    let request;
    try {
      request = response.request();
      const status = response.status();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        if ([401, 403, 429].includes(status)) refusal({ 401: 'login_required', 403: 'blocked', 429: 'rate_limited' }[status]);
        else if (checkNavigationRequest(request)) checkNavigation(response.url());
        return;
      }
      if (!current() || requests.get(request) !== generation || consumed.has(request)
        || !isExpectedAuthorisedDetailResponseUrl(response.url(), boundVideoId)) return;
      consumed.add(request);
      if (status !== 200) { refusal(({ 401: 'login_required', 403: 'blocked', 429: 'rate_limited' })[status] || 'business_error'); return; }
      const observedGeneration = generation, bodyBudget = Math.min(10_000, remaining());
      pendingBodies++;
      void bounded(Promise.resolve().then(() => response.text()), bodyBudget, bodySignal).then(body => {
        if (settled || !current() || observedGeneration !== generation) return;
        if (typeof body !== 'string') throw fail('invalid_evidence', 'body', 'body_type_invalid');
        if (Buffer.byteLength(body, 'utf8') > MAX_BODY) throw fail('invalid_evidence', 'body', 'body_too_large');
        let payload; try { payload = JSON.parse(body); } catch { throw fail('invalid_evidence', 'body', 'body_not_json'); }
        const response = validateResponse(payload, { ...input, videoId: boundVideoId });
        if (candidate && hash(candidate.response) !== hash(response)) throw fail('identity_mismatch', 'public_identity', 'conflicting_responses');
        candidate ??= { response, observedAt: new Date().toISOString(),
          ...(input.shareUrl ? { finalLocation: officialWorkLocation(page.url()) } : {}) };
      }).catch(error => {
        if (!settled && observedGeneration === generation) refusal(ERROR_CODES.has(error.code) ? error.code : 'collector_error', error.diagnostic);
      }).finally(() => {
        if (settled || observedGeneration !== generation) return;
        pendingBodies--;
        // Do not let a fast valid body outrun another already-observed refusal.
        if (pendingBodies === 0 && candidate) finish(candidate);
      });
    } catch { refusal('collector_error'); }
  };
  page.on('framenavigated', onFrame); page.on('request', onRequest); page.on('response', onResponse);
  try {
    const navigation = Promise.resolve().then(() => page.goto(input.shareUrl ?? `${ORIGIN}/video/${input.videoId}`,
      { waitUntil: 'domcontentloaded', timeout: Math.min(25_000, remaining()) }));
    void navigation.catch(() => refusal('navigation_error'));
    // Natural detail success may arrive before goto settles. No second navigation.
    try { return await bounded(result, remaining(), signal); }
    catch (error) { return { errorCode: error.code === 'cancelled' ? 'cancelled' : 'no_bound_response' }; }
  } finally {
    settled = true; generation++;
    bodyController.abort();
    page.off('framenavigated', onFrame); page.off('request', onRequest); page.off('response', onResponse);
  }
}

export async function collectWorkObservation(input, { enabled = false, runtime = {}, timeoutMs = 45_000, signal } = {}, validateResponse, observer = observeDetail) {
  if (enabled !== true) throw fail('disabled');
  const ownership = runtime.ownership;
  if (!ownership || typeof ownership.send !== 'function' || typeof ownership.remainingExecutionMs !== 'function') throw fail('ownership_required');
  // Retain offline response/lifecycle fixtures without a real browser fallback.
  if (!runtime.chromium || typeof runtime.chromium.launchServer !== "function" || typeof runtime.chromium.connect !== "function") throw retiredDouyinBrowserError();
  const totalMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(45_000, timeoutMs) : 45_000;
  const deadline = performance.now() + totalMs, reserve = Math.min(6500, totalMs / 5);
  const remaining = () => {
    const ms = Math.min(deadline - performance.now(), ownership.remainingExecutionMs()) - reserve;
    if (signal?.aborted) throw fail('cancelled');
    if (ms <= 0) throw fail('timeout');
    return ms;
  };
  const startedAt = new Date().toISOString();
  let server, browser, context, page, pid, registered = false, clean = true, outcome;
  try {
    const stateBudget = Math.min(5000, remaining());
    const state = await bounded(Promise.resolve().then(() => (runtime.readState ?? readAuthorisedState)()), stateBudget, signal);
    const executablePath = process.env.DOUYIN_CHROME_PATH || DEFAULT_CHROME;
    const accessBudget = Math.min(5000, remaining());
    await bounded(Promise.resolve().then(() => (runtime.access ?? access)(executablePath)).catch(() => { throw fail('browser_unavailable'); }), accessBudget, signal);
    const chromium = runtime.chromium;
    await ownership.send('launch');
    server = await openResource(() => chromium.launchServer({ executablePath, headless: true, host: '127.0.0.1', port: 0,
      timeout: Math.min(25_000, remaining()) }), remaining(), signal);
    pid = server.process()?.pid;
    if (!Number.isSafeInteger(pid) || pid <= 1) throw fail('cleanup_uncertain');
    await ownership.send('register', pid); registered = true;
    browser = await openResource(() => chromium.connect(server.wsEndpoint(), { timeout: Math.min(5000, remaining()) }), remaining(), signal);
    context = await openResource(() => browser.newContext({ storageState: state, locale: 'zh-CN' }), remaining(), signal);
    page = await openResource(() => context.newPage(), remaining(), signal);
    outcome = await observer(page, input, remaining, signal, validateResponse);
  } catch (error) {
    const code = ERROR_CODES.has(error?.code) ? error.code : 'collector_error';
    outcome = { errorCode: code, ...diagnosticFields(error?.diagnostic, code) };
  }
  finally {
    const cleanup = async (action, budget = 1000) => {
      try { await bounded(Promise.resolve().then(action), Math.max(1, Math.min(budget, deadline - performance.now(), ownership.remainingExecutionMs()))); return true; }
      catch { clean = false; }
    };
    if (page) await cleanup(() => page.close());
    if (context) await cleanup(() => context.close());
    if (browser) await cleanup(() => browser.close());
    if (server) {
      await cleanup(() => server.close());
      const process = server.process();
      if (process?.exitCode === null && process?.signalCode === null) await cleanup(() => server.kill());
      const exited = Number.isInteger(process?.exitCode) || (typeof process?.signalCode === 'string' && process.signalCode.length > 0);
      // Closing a tab/context can race with page navigation. The definitive
      // boundary is the registered browser process AND the parent's independent
      // confirmation that its entire private process group has disappeared.
      // Never skip that release merely because an earlier resource close failed.
      if (registered && exited) clean = await cleanup(() => ownership.send('released', pid), 1800) === true;
      else clean = false;
    }
  }
  const finishedAt = new Date().toISOString();
  if (!clean) outcome = { errorCode: 'cleanup_uncertain' };
  else if (signal?.aborted) outcome = { errorCode: 'cancelled' };
  return { outcome, startedAt, finishedAt };
}

/** Candidate collection shares all ownership/navigation/cleanup guards, but
 * this low-level observation is deliberately not an admission result. */
export async function collectAuthorisedWorkObservation(payload, options = {}) {
  if (options.enabled !== true) throw fail('disabled');
  return collectWorkObservation(normalizeAuthorisedWorkInput(payload), options, validateAuthorisedWorkResponse);
}

export async function collectAuthorisedDetail(payload, options = {}) {
  if (options.enabled !== true) throw fail('disabled');
  const input = normalizeAuthorisedDetailInput(payload);
  const { outcome, startedAt, finishedAt } = await collectWorkObservation(input, options, validateAuthorisedDetailResponse);
  const videoId = outcome?.response?.aweme_detail.aweme_id ?? input.videoId;
  const base = { status: outcome?.response ? 'ok' : 'unavailable', key: input.key,
    ...(input.shareUrl ? { shareUrl: input.shareUrl, ...(outcome?.response ? { videoId } : {}) } : { videoId }), submittedId: input.submittedId,
    requestStartedAt: startedAt, requestFinishedAt: finishedAt };
  if (!outcome?.response) {
    const code = outcome?.errorCode || 'collector_error';
    return { ...base, errorCode: code, ...diagnosticFields(outcome?.diagnostic, code) };
  }
  const candidate = candidateFrom(outcome.response, outcome.observedAt);
  return validateAuthorisedDetailResult(input, { ...base, candidate, evidence: { version: 1, kind: 'natural-main-frame-detail-response',
    ...(input.shareUrl ? { requestedShareUrl: input.shareUrl, ...outcome.finalLocation, finalVideoId: videoId } : {}),
    origin: ORIGIN, path: DETAIL, method: 'GET', httpStatus: 200, requestedVideoId: videoId, observedAt: outcome.observedAt,
    responseSha256: candidate.responseSha256, responseSha256Scope: AUTHORISED_DETAIL_HASH_SCOPE, response: outcome.response }, provenance: provenance() },
  { startedAt, finishedAt });
}
