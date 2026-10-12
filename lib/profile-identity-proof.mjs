import { createHash } from 'node:crypto';
import { checksum } from './utils.mjs';
import { OFFICIAL_DOUYIN_PROFILE_ENDPOINT, isOfficialDeferredProfileEnvelope,
  isOfficialMixedProfileEnvelope, isOfficialScheduledProfileEnvelope } from './official-profile-evidence.mjs';

const SEC_UID = /^MS4wLj[\w-]{12,220}$/;
const PROFILE_MODES = new Set(['guest-ttwid-unsigned-profile', 'guest-ttwid-unsigned-profile-with-x-bogus-fallback']);
const RECORD_LIMIT = 10_000;
const DAY_MS = 24 * 60 * 60_000;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const digest = value => createHash('sha256').update(value).digest('hex');
const id = value => {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_.-]{1,100}$/.test(normalized) && normalized !== '0' ? normalized : null;
};
const numeric = value => typeof value === 'string' && /^[1-9]\d{1,24}$/.test(value) ? value : null;
const time = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === (value.includes('.') ? value : value.replace(/Z$/, '.000Z')) ? parsed : NaN;
};
const blocked = value => record(value) && ['need_login', 'login_required', 'captcha_required', 'verify_required', 'not_login_module'].some(key => Boolean(value[key]));

function officialUser(raw) {
  const p = raw?.provenance, user = raw?.profile?.user;
  if (!record(raw) || !record(p) || !record(user) || !PROFILE_MODES.has(p.profileMode)
    || p.profileEndpoint !== OFFICIAL_DOUYIN_PROFILE_ENDPOINT || p.accountLocator !== 'sec_uid'
    || p.cookiePersisted !== false || p.runtimeAI !== false || p.paidAPI !== false
    || (p.platform !== undefined && p.platform !== 'douyin')
    || raw.source !== undefined || raw.roster !== undefined || raw.snapshot !== undefined
    || (raw.status_code !== undefined && raw.status_code !== 0) || blocked(raw) || blocked(raw.profile)
    || !['validated', 'available'].includes(raw.accountStatus) || raw.accountError !== null
    || user.user_deleted === true || !SEC_UID.test(user.sec_uid) || !numeric(user.uid)
    || raw.profile.user_info !== undefined) return null;
  const normal = p.mode === `${p.profileMode}-a-bogus-posts` && raw.worksFallbackDeferred === undefined;
  if (!normal && !isOfficialDeferredProfileEnvelope(raw) && !isOfficialMixedProfileEnvelope(raw)
    && !isOfficialScheduledProfileEnvelope(raw)) return null;
  if (raw.profileResponse !== undefined) {
    const response = raw.profileResponse;
    if (!record(response) || response.status_code !== 0 || blocked(response)) return null;
    const profiles = [response.user, response.user_info].filter(record);
    if (profiles.length !== 1 || profiles[0].user_deleted === true
      || ['sec_uid', 'uid', 'unique_id', 'short_id'].some(field => profiles[0][field] !== user[field])) return null;
  }
  return user;
}

/** An identity relationship from an existing official profile observation.
 * This is NOT a video-ownership receipt, a new observation, or an enable action.
 * Supply the latest snapshot and its own audit/run, never caller-provided JSON.
 * The database reader below additionally checks newer lifecycle/identity holds.
 */
export function verifyStoredDouyinProfileIdentity({ target, snapshot, audit, run, submittedAccountId,
  reference = new Date(), maxAgeMs = DAY_MS, identityConflict = false, lifecycleBlocked = false } = {}) {
  try {
    const submitted = id(submittedAccountId);
    const now = reference instanceof Date ? reference.getTime() : time(reference);
    const sampled = time(snapshot?.captured_at), audited = time(audit?.created_at), started = time(run?.started_at);
    const values = target?.metadata_json === undefined ? target?.metadata ?? {} : JSON.parse(target.metadata_json);
    if (!submitted || !record(target) || !positive(target.id) || target.type !== 'account' || target.provider !== 'public-web'
      || !SEC_UID.test(target.locator) || (target.platform !== undefined && target.platform !== 'douyin')
      || !record(values) || (values.platform !== undefined && values.platform !== 'douyin')
      || ![0, 1, false, true].includes(target.enabled) || identityConflict || lifecycleBlocked
      || !record(snapshot) || !positive(snapshot.id) || snapshot.target_id !== target.id
      || snapshot.account_status !== 'available' || !['validated', 'warning'].includes(snapshot.quality_status)
      || !Number.isFinite(now) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > DAY_MS
      || !Number.isFinite(sampled) || sampled > now || now - sampled > maxAgeMs
      || typeof snapshot.raw_json !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.source_checksum)
      || digest(snapshot.raw_json) !== snapshot.source_checksum
      || !record(audit) || !positive(audit.id) || audit.target_id !== target.id || audit.provider !== 'public-web'
      || audit.source_checksum !== snapshot.source_checksum || audit.status !== snapshot.quality_status
      || !Number.isFinite(audited) || audited < sampled || audited > now || audited - sampled > 10 * 60_000
      || !record(run) || !positive(run.id) || audit.run_id !== run.id
      || (run.target_id != null && run.target_id !== target.id) || !Number.isFinite(started) || started > sampled
      || (run.finished_at != null && (!Number.isFinite(time(run.finished_at)) || time(run.finished_at) < audited))) return null;
    const raw = JSON.parse(snapshot.raw_json), user = officialUser(raw);
    if (!user || checksum(raw) !== snapshot.source_checksum || time(raw.capturedAt) !== sampled || user.sec_uid !== target.locator) return null;
    const matchedField = id(user.unique_id) === submitted ? 'unique_id' : numeric(user.short_id) === submitted ? 'short_id' : null;
    if (!matchedField) return null;
    return { type: 'stored-public-profile-identity', version: 1, platform: 'douyin', targetId: target.id,
      canonicalAccountId: target.locator, submittedAccountId: submitted, publicAccountId: user[matchedField],
      matchedField, uid: user.uid, targetEnabled: target.enabled === true || target.enabled === 1,
      snapshotId: snapshot.id, sourceChecksum: snapshot.source_checksum, auditId: audit.id, runId: run.id,
      observedAt: snapshot.captured_at, checkedAt: new Date(now).toISOString(), endpoint: OFFICIAL_DOUYIN_PROFILE_ENDPOINT,
      identityOnly: true, newPublicCollection: false, submittedWorksVerified: false };
  } catch { return null; }
}

/** Batch, read-only lookup. Duplicate canonical claims, a newer invalid snapshot,
 * explicit identity conflicts and a newer lifecycle event cannot be hidden by
 * selecting an older favorable row. Metadata names/handles are never proof.
 */
export function readStoredDouyinProfileIdentityMatches(database, submittedIds, { reference = new Date(), maxAgeMs = DAY_MS } = {}) {
  const requested = [...new Set((Array.isArray(submittedIds) ? submittedIds : []).map(id).filter(Boolean))];
  const invalid = (Array.isArray(submittedIds) ? submittedIds : []).filter(value => !id(value));
  const inputSummary = { requestedIdentityCount: requested.length, invalidSubmittedItemCount: invalid.length,
    invalidSubmittedIds: [...new Set(invalid.filter(value => typeof value === 'string'))] };
  const empty = status => ({ status, ...inputSummary, matches: [], ambiguousIds: [], unverifiedIds: [], unmatchedIds: requested });
  if (!Array.isArray(submittedIds) || submittedIds.length > RECORD_LIMIT || !requested.length) return empty('invalid-input');
  const db = database?.db ?? database;
  try {
    const targets = db.prepare("SELECT * FROM targets WHERE type='account' AND provider='public-web' LIMIT ?").all(RECORD_LIMIT + 1);
    if (targets.length > RECORD_LIMIT) return empty('unavailable');
    const readSnapshot = db.prepare('SELECT * FROM snapshots WHERE target_id=? ORDER BY captured_at DESC,id DESC LIMIT 1');
    const readAudit = db.prepare("SELECT * FROM audits WHERE target_id=? AND source_checksum=? AND provider='public-web' ORDER BY created_at DESC,id DESC LIMIT 1");
    const readRun = db.prepare('SELECT * FROM runs WHERE id=?');
    const readLifecycle = db.prepare("SELECT observed_at,event_json FROM account_events WHERE target_id=? AND event_type='lifecycle' ORDER BY observed_at DESC,id DESC LIMIT 1");
    const readConflict = db.prepare("SELECT last_error FROM author_resolution_queue WHERE resolved_target_id=? AND suspended_target_enabled IS NOT NULL AND status IN ('pending','retry','rejected')");
    const requestedSet = new Set(requested), claims = new Map(), proofs = new Map();
    for (const target of targets) {
      const snapshot = readSnapshot.get(target.id);
      if (!snapshot) continue;
      let user;
      try { user = JSON.parse(snapshot.raw_json)?.profile?.user; } catch { continue; }
      const submitted = [...new Set([id(user?.unique_id), numeric(user?.short_id)].filter(value => requestedSet.has(value)))];
      if (!submitted.length) continue;
      for (const value of submitted) {
        if (!claims.has(value)) claims.set(value, new Set());
        claims.get(value).add(`${target.id}:${target.locator}`);
      }
      const audit = readAudit.get(target.id, snapshot.source_checksum), run = audit && readRun.get(audit.run_id);
      const event = readLifecycle.get(target.id);
      // A subsequent lifecycle change requires a fresh successful profile, even
      // when the event calls itself active. Do not reuse a pre-change snapshot.
      const lifecycleBlocked = Boolean(event && (!Number.isFinite(time(event.observed_at))
        || time(event.observed_at) >= time(snapshot.captured_at)));
      const identityConflict = readConflict.all(target.id).some(row => /(?:作者|身份|账号|发布者).*(?:不一致|冲突|不同作者)|多项作品.*不同作者|同一线索对应多个不同作者/.test(String(row.last_error ?? '')));
      for (const value of submitted) {
        const proof = verifyStoredDouyinProfileIdentity({ target, snapshot, audit, run, submittedAccountId: value,
          reference, maxAgeMs, identityConflict, lifecycleBlocked });
        if (proof) { if (!proofs.has(value)) proofs.set(value, []); proofs.get(value).push(proof); }
      }
    }
    const ambiguousIds = requested.filter(value => claims.get(value)?.size > 1);
    const matches = requested.filter(value => claims.get(value)?.size === 1 && proofs.get(value)?.length === 1).map(value => proofs.get(value)[0]);
    const unverifiedIds = requested.filter(value => claims.get(value)?.size === 1 && !proofs.get(value)?.length);
    const unmatchedIds = requested.filter(value => !claims.has(value));
    return { status: 'ok', ...inputSummary, matches, ambiguousIds, unverifiedIds, unmatchedIds };
  } catch { return empty('unavailable'); }
}
