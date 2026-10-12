import { createHash } from 'node:crypto';
import { checksum } from './utils.mjs';
import { OFFICIAL_DOUYIN_PROFILE_ENDPOINT, isOfficialDeferredProfileEnvelope,
  isOfficialMixedProfileEnvelope, isOfficialScheduledProfileEnvelope } from './official-profile-evidence.mjs';

const LIMIT = 10_000;
const SEC = /^MS4wLj[\w-]{12,220}$/;
const HASH = /^[a-f0-9]{64}$/;
const MODES = new Set(['guest-ttwid-x-bogus-profile-a-bogus-posts', 'guest-ttwid-unsigned-profile-a-bogus-posts',
  'guest-ttwid-unsigned-profile-with-x-bogus-fallback-a-bogus-posts']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const hashText = value => createHash('sha256').update(value).digest('hex');
const identifier = value => {
  if (typeof value !== 'string') return null;
  const result = value.normalize('NFKC').trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_.-]{1,100}$/.test(result) && result !== '0' ? result : null;
};
const numeric = value => typeof value === 'string' && /^[1-9]\d{1,24}$/.test(value) ? value : null;
const time = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === (value.includes('.') ? value : value.replace(/Z$/, '.000Z')) ? parsed : NaN;
};
const challenge = value => object(value) && ['need_login', 'login_required', 'captcha_required', 'verify_required', 'not_login_module'].some(key => Boolean(value[key]));
function decode(rawText, expectedHash) {
  if (typeof rawText !== 'string' || !HASH.test(expectedHash) || hashText(rawText) !== expectedHash) return null;
  const raw = JSON.parse(rawText);
  return checksum(raw) === expectedHash ? raw : null;
}
function userFrom(raw) {
  const p = raw?.provenance, user = raw?.profile?.user;
  const normal = MODES.has(p?.mode)
    && (p.profileEndpoint === undefined || p.profileEndpoint === OFFICIAL_DOUYIN_PROFILE_ENDPOINT)
    && (p.profileMode === undefined || p.mode === `${p.profileMode}-a-bogus-posts`);
  if (!object(raw) || !object(p) || !object(user)
    || (!normal && !isOfficialDeferredProfileEnvelope(raw) && !isOfficialMixedProfileEnvelope(raw) && !isOfficialScheduledProfileEnvelope(raw))
    || p.accountLocator !== 'sec_uid' || p.cookiePersisted !== false || p.runtimeAI !== false || p.paidAPI !== false
    || (p.platform !== undefined && p.platform !== 'douyin') || raw.source !== undefined || raw.roster !== undefined || raw.snapshot !== undefined
    || (raw.status_code !== undefined && raw.status_code !== 0) || challenge(raw) || challenge(raw.profile)
    || !['validated', 'available'].includes(raw.accountStatus) || (raw.accountError !== undefined && raw.accountError !== null)
    || user.user_deleted === true || !SEC.test(user.sec_uid) || !numeric(user.uid) || raw.profile.user_info !== undefined) return null;
  if (raw.profileResponse !== undefined) {
    const response = raw.profileResponse, profiles = [response?.user, response?.user_info].filter(object);
    if (!object(response) || response.status_code !== 0 || challenge(response) || profiles.length !== 1
      || profiles[0].user_deleted === true || ['sec_uid', 'uid', 'unique_id', 'short_id'].some(key => profiles[0][key] !== user[key])) return null;
  }
  return user;
}
function snapshotUser(row, target, now) {
  if (!row || !positive(row.id) || row.target_id !== target.id || row.account_status !== 'available'
    || !['validated', 'warning'].includes(row.quality_status) || !Number.isFinite(time(row.captured_at)) || time(row.captured_at) > now) return null;
  const raw = decode(row.raw_json, row.source_checksum), user = userFrom(raw);
  return user && time(raw.capturedAt) === time(row.captured_at) && user.sec_uid === target.locator ? user : null;
}
function auditRun(db, snapshot, expectedRunId, now, { allowRunning = false } = {}) {
  const audits = db.prepare("SELECT * FROM audits WHERE target_id=? AND source_checksum=? AND provider='public-web' ORDER BY id").all(snapshot.target_id, snapshot.source_checksum);
  if (audits.length !== 1) return null;
  const audit = audits[0], run = db.prepare('SELECT * FROM runs WHERE id=?').get(audit.run_id);
  const sampleAt = time(snapshot.captured_at), auditAt = time(audit.created_at), start = time(run?.started_at), finish = time(run?.finished_at);
  if (!positive(audit.id) || !positive(audit.run_id) || (expectedRunId != null && audit.run_id !== expectedRunId)
    || audit.status !== snapshot.quality_status || !run
    || (run.target_id != null && run.target_id !== snapshot.target_id) || ![sampleAt, auditAt, start].every(Number.isFinite)
    || start > sampleAt || sampleAt > auditAt || auditAt > now) return null;
  const completed = ['success', 'partial'].includes(run.status) && Number.isFinite(finish) && auditAt <= finish && finish <= now;
  // An already-persisted latest profile/audit can confirm UID continuity while
  // other accounts in the batch are still collecting. This does not certify
  // the whole run, invent a finish time, or relax the original alias proof.
  const collecting = allowRunning === true && run.status === 'running' && run.finished_at === null;
  if (!completed && !collecting) return null;
  return { audit, run };
}

/** Historical identity only. No source entry mutation, counters, enable action,
 * synthetic current sample, or 24-hour expiry. The caller must preserve and
 * check the original source entry identity before using this relationship.
 */
export function readStoredDouyinAliasMatches(database, submittedIds, { reference = new Date() } = {}) {
  const requested = [...new Set((Array.isArray(submittedIds) ? submittedIds : []).map(identifier).filter(Boolean))];
  const empty = status => ({ status, matches: [], ambiguousIds: [], unmatchedIds: requested });
  const now = reference instanceof Date ? reference.getTime() : time(reference), db = database?.db ?? database;
  if (!Array.isArray(submittedIds) || submittedIds.length > LIMIT || !requested.length || !Number.isFinite(now)) return empty('invalid-input');
  try {
    const targets = db.prepare("SELECT * FROM targets WHERE type='account' AND provider='public-web' LIMIT ?").all(LIMIT + 1);
    const events = db.prepare("SELECT * FROM account_events WHERE event_type='alias' ORDER BY id LIMIT ?").all(LIMIT + 1);
    if (targets.length > LIMIT || events.length > LIMIT) return empty('unavailable');
    const wanted = new Set(requested), claims = new Map(), matches = new Map(), targetMap = new Map(targets.map(t => [t.id, t])), latest = new Map();
    const claim = (id, targetId) => { if (!wanted.has(id)) return; if (!claims.has(id)) claims.set(id, new Set()); claims.get(id).add(targetId); };
    const readLatest = db.prepare('SELECT * FROM snapshots WHERE target_id=? ORDER BY julianday(captured_at) DESC,id DESC LIMIT 1');
    for (const target of targets) {
      const snapshot = readLatest.get(target.id); latest.set(target.id, snapshot);
      try { const user = JSON.parse(snapshot?.raw_json || '{}')?.profile?.user; for (const value of [identifier(user?.unique_id), numeric(user?.short_id)]) claim(value, target.id); } catch {}
    }
    for (const event of events) {
      let proof; try { proof = JSON.parse(event.event_json); } catch { continue; }
      const submitted = identifier(proof?.currentPublicAccountId);
      if (!wanted.has(submitted)) continue;
      claim(submitted, event.target_id);
      const target = targetMap.get(event.target_id);
      if (!target || !positive(target.id) || !SEC.test(target.locator) || ![0, 1, false, true].includes(target.enabled)) continue;
      let metadata; try { metadata = JSON.parse(target.metadata_json || '{}'); } catch { continue; }
      if (!object(metadata) || (metadata.platform !== undefined && metadata.platform !== 'douyin')
        || !object(proof) || proof.type !== 'douyin-account-alias-change' || proof.version !== 1 || proof.mode !== 'verified-snapshot-dual-id-continuity'
        || proof.platform !== 'douyin' || proof.targetId !== target.id || proof.canonicalAccountId !== target.locator
        || proof.submittedAccountId !== metadata.douyinId || !identifier(proof.submittedAccountId) || !numeric(proof.uid)
        || !positive(event.id) || !positive(event.run_id) || !positive(proof.priorSnapshotId)
        || !Number.isSafeInteger(proof.historicalSnapshotCount) || proof.historicalSnapshotCount < 1 || proof.historicalSnapshotCount > LIMIT
        || !['unique_id', 'short_id', 'uid'].includes(proof.priorMatchField)) continue;
      const observed = time(proof.observedAt), verified = time(proof.verifiedAt), created = time(event.created_at);
      if (![observed, verified, created].every(Number.isFinite) || time(event.observed_at) !== observed
        || observed > verified || verified > created || created > now
        || event.event_key !== checksum([target.id, proof.submittedAccountId, proof.previousPublicAccountId, proof.currentPublicAccountId, proof.canonicalAccountId, proof.uid])) continue;
      const eventRaw = decode(event.raw_json, event.source_checksum), eventUser = userFrom(eventRaw);
      if (!eventUser || proof.currentRawSha256 !== event.source_checksum || time(eventRaw.capturedAt) !== observed
        || eventUser.sec_uid !== target.locator || eventUser.uid !== proof.uid || eventUser.unique_id !== proof.currentPublicAccountId) continue;
      const current = latest.get(target.id), currentUser = snapshotUser(current, target, now);
      if (!currentUser || currentUser.uid !== proof.uid || time(current.captured_at) < observed
        || !auditRun(db, current, null, now, { allowRunning: true })) continue;
      const holds = db.prepare("SELECT last_error FROM author_resolution_queue WHERE resolved_target_id=? AND suspended_target_enabled IS NOT NULL AND status IN ('pending','retry','rejected')").all(target.id);
      if (holds.some(row => /(?:作者|身份|账号|发布者).*(?:不一致|冲突|不同作者)|多项作品.*不同作者|同一线索对应多个不同作者/.test(String(row.last_error ?? '')))) continue;
      const related = db.prepare("SELECT event_json FROM account_events WHERE target_id=? AND event_type IN ('alias','identity') LIMIT ?").all(target.id, LIMIT + 1);
      if (related.length > LIMIT) continue;
      if (related.some(row => { let value; try { value = JSON.parse(row.event_json); } catch { return true; }
        return !object(value) || value.canonicalAccountId !== target.locator || value.uid !== proof.uid; })) continue;
      const history = db.prepare('SELECT * FROM snapshots WHERE target_id=? AND julianday(captured_at)<julianday(?) ORDER BY julianday(captured_at),id LIMIT ?').all(target.id, proof.observedAt, LIMIT + 1);
      if (history.length !== proof.historicalSnapshotCount || history.some(row => snapshotUser(row, target, now)?.uid !== proof.uid)) continue;
      const prior = history.find(row => row.id === proof.priorSnapshotId), priorUser = prior && snapshotUser(prior, target, now);
      if (!prior || prior.captured_at !== proof.priorSnapshotCapturedAt || prior.source_checksum !== proof.priorSourceChecksum
        || priorUser[proof.priorMatchField] !== proof.previousPublicAccountId || identifier(proof.previousPublicAccountId) !== identifier(proof.submittedAccountId)
        || checksum(history.map(row => ({ snapshotId: row.id, capturedAt: row.captured_at, sourceChecksum: row.source_checksum }))) !== proof.historyEvidenceSha256) continue;
      const observedSnapshots = db.prepare('SELECT * FROM snapshots WHERE target_id=? AND source_checksum=?').all(target.id, event.source_checksum)
        .filter(row => time(row.captured_at) === observed);
      if (observedSnapshots.length !== 1 || observedSnapshots[0].raw_json !== event.raw_json || !snapshotUser(observedSnapshots[0], target, now)) continue;
      const receipt = auditRun(db, observedSnapshots[0], event.run_id, now);
      if (!receipt || time(receipt.audit.created_at) < created) continue;
      const match = { submittedAccountId: submitted, targetId: target.id, targetEnabled: target.enabled === true || target.enabled === 1,
        canonicalAccountId: target.locator, platform: 'douyin', proofType: 'historical-alias', eventId: event.id,
        observedAt: proof.observedAt, checkedAt: new Date(now).toISOString(), identityOnly: true, newPublicCollection: false,
        submittedWorksVerified: false, uid: proof.uid, snapshotId: observedSnapshots[0].id, auditId: receipt.audit.id, runId: event.run_id };
      if (!matches.has(submitted)) matches.set(submitted, new Map());
      matches.get(submitted).set(target.id, match);
    }
    const ambiguousIds = requested.filter(value => claims.get(value)?.size > 1);
    const accepted = requested.filter(value => claims.get(value)?.size === 1 && matches.get(value)?.size === 1).map(value => [...matches.get(value).values()][0]);
    return { status: 'ok', matches: accepted, ambiguousIds, unmatchedIds: requested.filter(value => !accepted.some(match => match.submittedAccountId === value)) };
  } catch { return empty('unavailable'); }
}
