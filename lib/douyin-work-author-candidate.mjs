import { createHash } from 'node:crypto';
import { normalizeAuthorisedWorkInput, collectAuthorisedWorkObservation, validateAuthorisedWorkResponse,
  authorisedWorkCandidateFrom, officialWorkLocation, AUTHORISED_DETAIL_FINAL_URL_SCOPE,
  AUTHORISED_DETAIL_PROVENANCE } from './douyin-authorised-detail.mjs';
import { requireSameWork, sameShareWithEncodedAdornments } from './import-authorised-detail.mjs';

export const WORK_AUTHOR_CANDIDATE_SCOPE = 'source-work-author-candidate';
export const WORK_AUTHOR_CANDIDATE_HASH_SCOPE = 'work-author-candidate-public-projection-v1';
const KIND = 'natural-main-frame-work-author-candidate-response';
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const ERRORS = new Set(['disabled', 'ownership_required', 'invalid_input', 'session_required', 'session_permissions',
  'session_invalid', 'browser_unavailable', 'timeout', 'login_required', 'blocked', 'rate_limited', 'challenge_required',
  'business_error', 'identity_mismatch', 'invalid_evidence', 'no_bound_response', 'navigation_error', 'collector_error',
  'cleanup_uncertain', 'cancelled']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const empty = value => value === undefined || value === null || value === '';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? Date.parse(value) : NaN;
const flags = () => ({ scope: WORK_AUTHOR_CANDIDATE_SCOPE, submittedIdentityVerified: false, metricsSampled: false, monitoringEnabled: false });
const provenance = () => ({ mode: AUTHORISED_DETAIL_PROVENANCE, authorisedSessionUsed: true, authenticated: null,
  authenticationStatus: 'not-verified', noChallengeBypass: true, runtimeAI: false, paidAPI: false });
function publicId(value) {
  if (typeof value !== 'string' || CONTROL.test(value)) return '';
  const id = value.normalize('NFKC').trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_.-]{1,100}$/.test(id) && /[a-z0-9]/.test(id) && id !== '0' ? id : '';
}
function workKey(source, work) {
  return `work-author-candidate:${hash({ source, ...(work.shareUrl ? { shareUrl: work.shareUrl } : { videoId: work.videoId }) })}`;
}

/** The source capability is made by the authenticated server, never by a
 * nickname search. This parser contains no submitted-account assertion. */
export function normalizeWorkAuthorCandidateInput(payload) {
  if (!object(payload) || Object.keys(payload).some(key => key !== 'items') || !Array.isArray(payload.items) || payload.items.length !== 1) throw fail('invalid_input');
  const item = payload.items[0], source = item?.source;
  if (!object(item) || Object.keys(item).some(key => !['key', 'videoId', 'shareUrl', 'source'].includes(key))
    || !object(source) || Object.keys(source).length !== 3 || Object.keys(source).some(key => !['jobId', 'sourceRow', 'sourceRowSha256'].includes(key))
    || typeof source.jobId !== 'string' || !UUID.test(source.jobId) || !Number.isSafeInteger(source.sourceRow) || source.sourceRow < 1
    || typeof source.sourceRowSha256 !== 'string' || !HASH.test(source.sourceRowSha256)) throw fail('invalid_input');
  const work = normalizeAuthorisedWorkInput({ items: [item] });
  const projectedSource = { jobId: source.jobId, sourceRow: source.sourceRow, sourceRowSha256: source.sourceRowSha256 };
  if (work.key !== workKey(projectedSource, work)) throw fail('invalid_input');
  return { ...work, source: projectedSource };
}

/** Only malformed/missing original handles are eligible. Valid-ID conflicts
 * must stay in their strict review path. No DB, target, queue or source writes. */
export function prepareImportWorkAuthorCandidate(job, options = {}) {
  if (!object(options) || Object.keys(options).some(key => key !== 'sourceRow') || !Number.isSafeInteger(options.sourceRow) || options.sourceRow < 1
    || !object(job) || typeof job.id !== 'string' || !UUID.test(job.id) || job.status !== 'completed' || !object(job.request)
    || !Array.isArray(job.request.rows) || job.request.rows.length > 10_000
    || job.request.rows.some(row => !object(row) || !Number.isSafeInteger(row.sourceRow) || row.sourceRow < 1)) throw fail('invalid_input');
  const matching = job.request.rows.filter(row => row.sourceRow === options.sourceRow);
  if (matching.length !== 1) throw fail('invalid_input');
  const row = matching[0];
  if (row.platform !== 'douyin' || !empty(row.bilibiliId) || !empty(row.xiaohongshuId)
    || typeof row.douyinId !== 'string' || CONTROL.test(row.douyinId) || publicId(row.douyinId)
    || ['identity_conflict', 'rejected', 'skipped', 'ready', 'existing'].includes(row.status)
    || ['identityConflict', 'rejectedLink', 'locator', 'accountLocator', 'secUid', 'targetId', 'resolvedTargetId'].some(key => !empty(row[key]))) throw fail('invalid_input');
  for (const key of ['videoIds', 'shareUrls']) if (!empty(row[key]) && (!Array.isArray(row[key]) || row[key].length !== 0)) throw fail('invalid_input');
  let work;
  try {
    work = normalizeAuthorisedWorkInput({ items: [{ key: 'source-work-validation',
      ...(empty(row.videoId) ? { shareUrl: row.shareUrl } : { videoId: row.videoId }) }] });
    if (work.shareUrl) {
      if (!empty(row.contentId)) throw fail('invalid_input');
      for (const key of ['videoLink', 'videoHyperlink']) {
        const value = row[key];
        if (empty(value) || value === work.shareUrl || sameShareWithEncodedAdornments(value, work.shareUrl)) continue;
        if (typeof value !== 'string' || value.length > 4000 || CONTROL.test(value)) throw fail('invalid_input');
        const links = value.match(/https?:\/\/[^\s，。；;,<>"']+/gi) ?? [];
        if (links.length !== 1 || links[0].replace(/[!！)）\]】}>]+$/g, '') !== work.shareUrl) throw fail('invalid_input');
      }
    } else {
      requireSameWork(row.contentId, work.videoId, { allowBareId: true });
      for (const key of ['videoLink', 'videoHyperlink', 'shareUrl']) requireSameWork(row[key], work.videoId);
    }
  } catch { throw fail('invalid_input'); }
  const source = { jobId: job.id, sourceRow: row.sourceRow, sourceRowSha256: hash(row) };
  return normalizeWorkAuthorCandidateInput({ items: [{ ...work, key: workKey(source, work), source }] });
}

function candidateFrom(response, observedAt) {
  return { ...authorisedWorkCandidateFrom(response, observedAt), responseSha256Scope: WORK_AUTHOR_CANDIDATE_HASH_SCOPE };
}

/** Independent parent recheck. Its scope/kind/hash domain cannot be accepted
 * as a strict submitted-ID success receipt, even if status is accidentally relabelled. */
export function validateWorkAuthorCandidateResult(input, result, { startedAt, finishedAt } = {}) {
  const checked = normalizeWorkAuthorCandidateInput({ items: [input] });
  const outerStart = timestamp(startedAt), outerEnd = timestamp(finishedAt), share = checked.shareUrl !== undefined;
  if (!object(result) || ![outerStart, outerEnd].every(Number.isFinite) || outerEnd < outerStart || outerEnd - outerStart > 45_000
    || !['candidate-only', 'unavailable'].includes(result.status) || result.key !== checked.key
    || !object(result.source) || Object.keys(result.source).length !== 3
    || Object.entries(checked.source).some(([key, value]) => result.source[key] !== value)
    || (share ? result.shareUrl !== checked.shareUrl : result.videoId !== checked.videoId)
    || Object.entries(flags()).some(([key, value]) => result[key] !== value)
    || Object.hasOwn(result, 'submittedId') || Object.hasOwn(result, 'admission')) throw fail('invalid_evidence');
  const start = timestamp(result.requestStartedAt), finish = timestamp(result.requestFinishedAt);
  if (![start, finish].every(Number.isFinite) || start < outerStart || finish < start || finish > outerEnd || finish - start > 45_000) throw fail('invalid_evidence');
  const base = { status: result.status, ...flags(), ...checked, requestStartedAt: result.requestStartedAt, requestFinishedAt: result.requestFinishedAt };
  if (result.status === 'unavailable') {
    if (!ERRORS.has(result.errorCode) || result.candidate !== undefined || result.evidence !== undefined || share && result.videoId !== undefined) throw fail('invalid_evidence');
    return { ...base, errorCode: result.errorCode };
  }
  const e = result.evidence, c = result.candidate, p = result.provenance;
  let videoId = checked.videoId, finalLocation = null;
  if (share) {
    const observed = object(e) && officialWorkLocation(e.finalUrl);
    if (!observed || e.finalUrl !== observed.finalUrl || e.requestedShareUrl !== checked.shareUrl
      || e.finalUrlScope !== AUTHORISED_DETAIL_FINAL_URL_SCOPE || !HASH.test(e.finalUrlSha256 || '')
      || e.finalVideoId !== observed.videoId || result.videoId !== observed.videoId) throw fail('invalid_evidence');
    videoId = observed.videoId;
    finalLocation = { requestedShareUrl: checked.shareUrl, finalUrl: e.finalUrl, finalUrlSha256: e.finalUrlSha256,
      finalUrlScope: AUTHORISED_DETAIL_FINAL_URL_SCOPE, finalVideoId: videoId };
  }
  if (!object(e) || !object(c) || !object(p) || e.version !== 1 || e.kind !== KIND
    || e.origin !== 'https://www.douyin.com' || e.path !== '/aweme/v1/web/aweme/detail/' || e.method !== 'GET' || e.httpStatus !== 200
    || e.requestedVideoId !== videoId || e.responseSha256Scope !== WORK_AUTHOR_CANDIDATE_HASH_SCOPE
    || Object.entries(provenance()).some(([key, value]) => p[key] !== value)) throw fail('invalid_evidence');
  const observedAt = timestamp(e.observedAt);
  if (!Number.isFinite(observedAt) || observedAt < start || observedAt > finish) throw fail('invalid_evidence');
  const response = validateAuthorisedWorkResponse(e.response, { videoId }), candidate = candidateFrom(response, e.observedAt);
  // A structurally present ID such as "0" or punctuation is not a usable
  // correction handle. Never substitute uid, sec_uid, or a nickname for it.
  if (!publicId(candidate.uniqueId) && !publicId(candidate.shortId)) throw fail('invalid_evidence');
  if (!HASH.test(c.responseSha256 || '') || Object.entries(candidate).some(([key, value]) => c[key] !== value)
    || e.responseSha256 !== candidate.responseSha256) throw fail('invalid_evidence');
  return { ...base, ...(share ? { videoId } : {}), candidate, evidence: { version: 1, kind: KIND,
    origin: 'https://www.douyin.com', path: '/aweme/v1/web/aweme/detail/', method: 'GET', httpStatus: 200,
    ...finalLocation, requestedVideoId: videoId, observedAt: e.observedAt, responseSha256: candidate.responseSha256,
    responseSha256Scope: WORK_AUTHOR_CANDIDATE_HASH_SCOPE, response }, provenance: provenance() };
}

/** Default-off, exactly one owned natural navigation. No anonymous fallback,
 * author search, correction submission, target enabling, or persistence. */
export async function collectDouyinWorkAuthorCandidate(payload, options = {}) {
  if (options.enabled !== true) throw fail('disabled');
  const input = normalizeWorkAuthorCandidateInput(payload);
  const { source, ...work } = input;
  const { outcome, startedAt, finishedAt } = await collectAuthorisedWorkObservation({ items: [work] }, options);
  const base = { status: outcome?.response ? 'candidate-only' : 'unavailable', ...flags(), ...input,
    requestStartedAt: startedAt, requestFinishedAt: finishedAt };
  if (!outcome?.response) return validateWorkAuthorCandidateResult(input, { ...base,
    errorCode: ERRORS.has(outcome?.errorCode) ? outcome.errorCode : 'collector_error' }, { startedAt, finishedAt });
  const videoId = outcome.response.aweme_detail.aweme_id, candidate = candidateFrom(outcome.response, outcome.observedAt);
  const result = { ...base, ...(input.shareUrl ? { videoId } : {}), candidate,
    evidence: { version: 1, kind: KIND, ...(input.shareUrl ? { requestedShareUrl: input.shareUrl, ...outcome.finalLocation, finalVideoId: videoId } : {}),
      origin: 'https://www.douyin.com', path: '/aweme/v1/web/aweme/detail/', method: 'GET', httpStatus: 200,
      requestedVideoId: videoId, observedAt: outcome.observedAt, responseSha256: candidate.responseSha256,
      responseSha256Scope: WORK_AUTHOR_CANDIDATE_HASH_SCOPE, response: outcome.response }, provenance: provenance() };
  try { return validateWorkAuthorCandidateResult(input, result, { startedAt, finishedAt }); }
  catch { return validateWorkAuthorCandidateResult(input, { ...base, status: 'unavailable', errorCode: 'invalid_evidence' }, { startedAt, finishedAt }); }
}
