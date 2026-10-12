import { createHash } from 'node:crypto';
import { checksum } from './utils.mjs';
import { isOfficialDeferredProfileEnvelope } from './official-profile-evidence.mjs';

// A narrow, source-verified exclusion, not another works-success marker.
// Oversized/missing/unknown evidence keeps the existing latest-attempt rule.
export const MAX_DEFERRED_SOURCE_BYTES = 128 * 1024;
const counter = value => Number.isSafeInteger(value) && value >= 0;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const errors = new Set(['blocked', 'rate_limited', 'login_required', 'network_error', 'business_error', 'upstream_changed', 'collector_error', 'unknown', 'deferred']);
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === (value.includes('.') ? value : value.replace(/Z$/, '.000Z')) ? parsed : NaN;
}
function isDouyin(target) {
  if (Object.hasOwn(target, 'platform')) return target.platform === 'douyin';
  const metadata = target.metadata_json === undefined ? target.metadata ?? {} : JSON.parse(target.metadata_json);
  return record(metadata) && (metadata.platform === undefined || metadata.platform === 'douyin');
}

/** Only a checksum-bound official profile envelope with explicit no-request
 * evidence for BOTH transports may be excluded from works-attempt selection.
 * Real errors, ambiguous legacy sources and failed integrity checks stay visible.
 * This function reads no database, requests no network, and mutates no input.
 */
export function isVerifiedDeferredWorksSnapshot(row, target, { nowMs } = {}) {
  try {
    const evidence = row?.collectionEvidence;
    if (!target || target.type !== 'account' || target.provider !== 'public-web' || !isDouyin(target)
      || !Number.isSafeInteger(target.id) || target.id < 1 || row.target_id !== target.id
      || typeof target.locator !== 'string' || !/^MS4wLj[\w-]{12,220}$/.test(target.locator)
      || !['validated', 'warning'].includes(row.quality_status) || !['available', 'partial'].includes(row.account_status)
      || row.works_coverage !== 'unavailable' || row.works_observed_at != null
      || typeof row.raw_json !== 'string' || row.raw_json.length > MAX_DEFERRED_SOURCE_BYTES
      || Buffer.byteLength(row.raw_json, 'utf8') > MAX_DEFERRED_SOURCE_BYTES
      || !/^[a-f0-9]{64}$/.test(row.source_checksum)
      || evidence?.provider !== 'public-web' || evidence.targetId !== target.id
      || !Number.isSafeInteger(evidence.auditId) || evidence.auditId < 1
      || !Number.isSafeInteger(evidence.runId) || evidence.runId < 1
      || !['validated', 'warning'].includes(evidence.status) || evidence.sourceChecksum !== row.source_checksum) return false;
    const captured = timestamp(row.captured_at), started = timestamp(evidence.runStartedAt), audited = timestamp(evidence.auditAt);
    if (![captured, started, audited, nowMs].every(Number.isFinite) || started > captured || captured > audited || audited > nowMs) return false;
    if (evidence.runFinishedAt !== null) {
      const finished = timestamp(evidence.runFinishedAt);
      if (!Number.isFinite(finished) || audited > finished || finished > nowMs) return false;
    }
    if (createHash('sha256').update(row.raw_json).digest('hex') !== row.source_checksum) return false;
    const raw = JSON.parse(row.raw_json);
    if (checksum(raw) !== row.source_checksum || timestamp(raw.capturedAt) !== captured
      || !isOfficialDeferredProfileEnvelope(raw) || raw.codexObservation !== undefined
      || [raw.need_login, raw.login_required, raw.captcha_required, raw.verify_required].some(Boolean)
      || raw.profile.user.sec_uid !== target.locator || typeof raw.profile.user.uid !== 'string' || !/^[1-9]\d{1,24}$/.test(raw.profile.user.uid)
      || ![['followers', 'follower_count'], ['total_likes', 'total_favorited'], ['total_posts', 'aweme_count']]
        .every(([field, source]) => counter(row[field]) && raw.profile.user[source] === row[field])) return false;
    const policy = raw.worksRequestPolicy, lanes = [policy?.anonymous, policy?.browser];
    if (!record(policy) || policy.version !== 1 || policy.endpoint !== 'douyin.author_posts' || policy.scope !== 'endpoint-transport'
      || !lanes.every(lane => record(lane) && lane.attempted === false && typeof lane.deferred === 'boolean'
        && (lane.errorCode === null || errors.has(lane.errorCode)))
      || policy.anonymous.transport !== 'anonymous-http' || policy.browser.transport !== 'authorised-browser'
      || !lanes.some(lane => lane.deferred)) return false;
    // Contradictory browser evidence is a real or unknown attempt, never a skip.
    if (['observationVersion', 'observedAt', 'sourceRequestStartedAt', 'sourceRequestFinishedAt'].some(key => raw.works[key] !== undefined)
      || raw.provenance.worksFallback !== undefined || raw.worksFallbackDiagnostics !== undefined
      || raw.worksFallbackLifecycle !== undefined || (raw.worksFallbackErrorCode !== undefined && raw.worksFallbackErrorCode !== 'deferred')) return false;
    if (raw.worksFallbackDeferred !== undefined) {
      const marker = raw.worksFallbackDeferred;
      if (!record(marker) || marker.version !== 1 || marker.reason !== 'scheduled-profile-priority'
        || marker.mode !== 'works-only' || Object.keys(marker).length !== 3) return false;
    }
    return true;
  } catch { return false; }
}
