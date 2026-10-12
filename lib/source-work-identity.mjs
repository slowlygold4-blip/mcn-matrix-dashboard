import { checksum } from "./utils.mjs";
import { isOfficialDeferredProfileEnvelope, isOfficialMixedProfileEnvelope } from "./official-profile-evidence.mjs";
import { getDouyinLifecycleEvidence } from "./account-lifecycle.mjs";

const DETAIL_ENDPOINT = "https://www.douyin.com/aweme/v1/web/aweme/detail/";
const PROFILE_ENDPOINT = "https://www.douyin.com/aweme/v1/web/user/profile/other/";
const SEC_UID_RE = /^MS4wLj[\w-]{12,220}$/;
const VIDEO_ID_RE = /^\d{15,25}$/;
const PROFILE_MODES = new Set(["guest-ttwid-unsigned-profile", "guest-ttwid-unsigned-profile-with-x-bogus-fallback"]);
const DETAIL_MODES = new Set(["guest-ttwid-a-bogus-video-detail", "guest-ttwid-unsigned-video-detail-fallback"]);

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const stableUid = (value) => typeof value === "string" && /^[1-9]\d{1,24}$/.test(value) ? value : null;

function publicId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9_.-]{1,100}$/.test(normalized) && normalized !== "0" ? normalized : null;
}

function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return NaN;
  const parsed = Date.parse(value);
  const expected = value.includes(".") ? value : value.replace(/Z$/, ".000Z");
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === expected ? parsed : NaN;
}

function metadata(target) {
  try {
    const value = target?.metadata_json === undefined ? target?.metadata : JSON.parse(target.metadata_json);
    return record(value) ? value : null;
  } catch { return null; }
}

function sourceBinding(target) {
  const data = metadata(target);
  const source = data?.importSource;
  const videoId = data?.evidenceVideoId;
  if (target?.type !== "account" || target.provider !== "public-web"
    || (target.platform !== undefined && target.platform !== "douyin")
    || ![true, 1].includes(target.enabled) || !SEC_UID_RE.test(target.locator)
    || !data || (data.platform !== undefined && data.platform !== "douyin")
    || !publicId(data.douyinId) || typeof videoId !== "string" || !VIDEO_ID_RE.test(videoId)
    || (Object.hasOwn(data.resolution ?? {}, "evidenceVideoId") && data.resolution.evidenceVideoId !== videoId)
    || !record(source) || !["author-spreadsheet", "lark-sheet", "lark-bitable"].includes(source.type)
    || typeof source.fileName !== "string" || !source.fileName.trim()
    || typeof source.sheetName !== "string" || !source.sheetName.trim()
    || !Number.isSafeInteger(source.sourceRow) || source.sourceRow < 1) return null;
  return { targetId: target.id, canonicalAccountId: target.locator,
    submittedAccountId: data.douyinId, sourceVideoId: videoId, importSource: source };
}

function currentProfile(raw) {
  const provenance = raw?.provenance;
  const user = raw?.profile?.user;
  if (!record(raw) || !record(provenance) || !record(user)
    || provenance.profileEndpoint !== PROFILE_ENDPOINT || !PROFILE_MODES.has(provenance.profileMode)
    || (provenance.mode !== `${provenance.profileMode}-a-bogus-posts`
      && !isOfficialDeferredProfileEnvelope(raw) && !isOfficialMixedProfileEnvelope(raw))
    || provenance.accountLocator !== "sec_uid" || provenance.cookiePersisted !== false
    || provenance.runtimeAI !== false || provenance.paidAPI !== false
    || raw.source !== undefined || raw.roster !== undefined || user.user_deleted === true
    || !SEC_UID_RE.test(user.sec_uid) || !stableUid(user.uid)
    || !Number.isFinite(timestamp(raw.capturedAt))) return null;
  if (raw.profileResponse !== undefined) {
    const response = raw.profileResponse;
    if (!record(response) || response.status_code !== 0) return null;
    const profiles = [response.user, response.user_info].filter(record);
    if (profiles.length !== 1 || profiles[0].sec_uid !== user.sec_uid || profiles[0].uid !== user.uid
      || profiles[0].user_deleted === true) return null;
  }
  return user;
}

function matchingField(author, submittedId) {
  if (publicId(author.unique_id) === submittedId) return "unique_id";
  if (stableUid(author.short_id) === submittedId) return "short_id";
  if (stableUid(author.uid) === submittedId) return "uid";
  return null;
}

function readRequest(database, target, raw, allowEvidence = false) {
  if (!database?.db || !Number.isSafeInteger(target?.id) || target.id <= 0
    || (!allowEvidence && raw?.sourceIdentityEvidence !== undefined)) return null;
  const requested = sourceBinding(target);
  const profile = currentProfile(raw);
  if (!requested || !profile || profile.sec_uid !== requested.canonicalAccountId
    || matchingField(profile, publicId(requested.submittedAccountId))) return null;
  const stored = database.db.prepare(`SELECT t.*, EXISTS(
    SELECT 1 FROM author_resolution_queue q WHERE q.resolved_target_id=t.id
      AND q.suspended_target_enabled IS NOT NULL AND q.status IN ('pending','retry','rejected')
  ) AS identity_blocked FROM targets t WHERE t.id=?`).get(target.id);
  const binding = sourceBinding(stored);
  if (!binding || stored.identity_blocked || checksum(binding) !== checksum(requested)) return null;
  return { ...binding, uid: profile.uid, sourceBindingChecksum: checksum(binding) };
}

/** Select only the current stored original work, never an arbitrary response URL. */
export function getSourceWorkIdentityRequest(database, target, raw) {
  try { return readRequest(database, target, raw); } catch { return null; }
}

/**
 * Cross-endpoint identity proof, not historical alias continuity. transport is
 * constructed by the provider after its actual identity-work helper call;
 * caller/request metadata and a self-described raw envelope are not transport.
 * Returns an event only. It does not mutate inputs, targets, snapshots or events.
 */
export function verifySourceWorkIdentity(database, target, raw, transport = null) {
  try {
    const request = readRequest(database, target, raw, true);
    const evidence = raw?.sourceIdentityEvidence;
    const profile = currentProfile(raw);
    if (!request || !record(transport) || transport.provider !== "public-web" || transport.operation !== "identity-work"
      || transport.requestedVideoId !== request.sourceVideoId || transport.requestedAccountId !== request.canonicalAccountId
      || transport.sourceBindingChecksum !== request.sourceBindingChecksum
      || !record(evidence) || evidence.requestedVideoId !== request.sourceVideoId
      || !record(evidence.provenance) || evidence.provenance.endpoint !== DETAIL_ENDPOINT
      || !DETAIL_MODES.has(evidence.provenance.mode) || evidence.provenance.cookiePersisted !== false
      || evidence.provenance.runtimeAI !== false || evidence.provenance.paidAPI !== false) return null;
    const profileAt = timestamp(raw.capturedAt);
    const evidenceAt = timestamp(evidence.capturedAt);
    const verifiedAt = timestamp(transport.observedAt);
    if (![profileAt, evidenceAt, verifiedAt].every(Number.isFinite)
      || profileAt > evidenceAt || evidenceAt > verifiedAt) return null;
    const response = evidence.response;
    const detail = response?.aweme_detail;
    const author = detail?.author;
    if (!record(response) || response.status_code !== 0 || !record(detail)
      || detail.aweme_id !== request.sourceVideoId || !record(author)
      || author.sec_uid !== request.canonicalAccountId || !stableUid(author.uid)
      || author.uid !== profile.uid || author.user_deleted === true) return null;
    if ([response.need_login, response.login_required, response.captcha_required, response.verify_required].some(Boolean)) return null;
    const sourceMatchField = matchingField(author, publicId(request.submittedAccountId));
    if (!sourceMatchField) return null;
    return {
      type: "source-id-verification", version: 1,
      mode: "official-source-work-profile-cross-check",
      targetId: target.id, platform: "douyin",
      submittedAccountId: request.submittedAccountId,
      currentPublicAccountId: publicId(profile.unique_id) ? profile.unique_id : null,
      canonicalAccountId: request.canonicalAccountId, uid: profile.uid,
      sourceVideoId: request.sourceVideoId, sourceMatchField, sourceAccountId: author[sourceMatchField],
      sourceBindingChecksum: request.sourceBindingChecksum, endpoint: DETAIL_ENDPOINT,
      detailResponseChecksum: checksum(response), currentRawSha256: checksum(raw),
      observedAt: evidence.capturedAt, verifiedAt: transport.observedAt,
      reason: "原表作品回显提交账号号，作品与当前主页的 sec_uid、uid 均严格一致；这是跨端点身份核验，不是历史改号证明",
    };
  } catch { return null; }
}

const HISTORY_FRESH_REQUEST_MAX_MS = 10 * 60_000;
const HASH_RE = /^[a-f0-9]{64}$/;
const usableQuality = value => ["validated", "warning"].includes(value);

function historicalFreshProfile(raw) {
  const profile = currentProfile(raw);
  if (!profile || raw.sourceIdentityEvidence !== undefined || raw.historicalSourceIdentityEvidence !== undefined
    || raw.snapshot !== undefined || (raw.status_code !== undefined && raw.status_code !== 0)
    || (raw.accountStatus !== undefined && !["available", "validated"].includes(raw.accountStatus))
    || (raw.accountError !== undefined && raw.accountError !== null)
    || (raw.provenance.platform !== undefined && raw.provenance.platform !== "douyin")) return null;
  for (const response of [raw, raw.profileResponse].filter(record)) {
    if ([response.need_login, response.login_required, response.captcha_required,
      response.verify_required, response.not_login_module].some(Boolean)) return null;
  }
  return profile;
}

/**
 * Reuse only the identity established by an immutable original-work proof.
 * requestStartedAt belongs to the provider's actual fresh profile request;
 * callers must not derive it from raw or historical evidence. No counters,
 * works payload, or historical observation time becomes a current sample.
 * This reads existing rows only and never chains through a previous reuse.
 */
export function verifyHistoricalSourceWorkIdentity(database, target, freshRaw,
  { requestStartedAt, reference = new Date() } = {}) {
  try {
    const checkedAt = reference instanceof Date ? reference.toISOString() : reference;
    const now = timestamp(checkedAt), requestAt = timestamp(requestStartedAt), freshAt = timestamp(freshRaw?.capturedAt);
    if (![now, requestAt, freshAt].every(Number.isFinite) || requestAt > freshAt || freshAt > now
      || now - requestAt > HISTORY_FRESH_REQUEST_MAX_MS) return null;
    const fresh = historicalFreshProfile(freshRaw);
    const binding = readRequest(database, target, freshRaw);
    if (!fresh || !binding) return null;
    const db = database.db;
    const events = db.prepare(`SELECT id,target_id,run_id,event_type,event_key,observed_at,
      source_checksum,event_json,raw_json,created_at FROM account_events WHERE target_id=?
      ORDER BY julianday(observed_at) DESC,id DESC`).all(target.id);
    const parsed = events.map(row => ({ row, proof: JSON.parse(row.event_json) }));
    // A future/invalid lifecycle or identity entry cannot silently disappear
    // from the revocation scan. Historical proofs for another binding also
    // cannot be borrowed merely because the current display name matches.
    for (const { row, proof } of parsed) {
      if (!["identity", "alias", "lifecycle"].includes(row.event_type)) continue;
      if (!record(proof) || !Number.isFinite(timestamp(row.observed_at)) || timestamp(row.observed_at) > now) return null;
      if (row.event_type === "lifecycle") {
        const lifecycleRaw = JSON.parse(row.raw_json);
        if (!HASH_RE.test(row.source_checksum) || checksum(lifecycleRaw) !== row.source_checksum
          || proof.sourceChecksum !== row.source_checksum || proof.requestedAccountId !== target.locator
          || timestamp(proof.observedAt) !== timestamp(row.observed_at)
          || proof.source !== "official-public-profile") return null;
        if (proof.state === "deleted") {
          const lifecycle = getDouyinLifecycleEvidence(target, lifecycleRaw, { provider: "public-web", operation: "account",
            requestedAccountId: target.locator, observedAt: row.observed_at });
          if (!lifecycle || checksum(lifecycle) !== checksum(proof)) return null;
        } else if (proof.state === "active") {
          const activeProfile = currentProfile(lifecycleRaw);
          if (proof.identityVerified !== true || !activeProfile || activeProfile.sec_uid !== target.locator
            || activeProfile.uid !== fresh.uid || timestamp(lifecycleRaw.capturedAt) !== timestamp(row.observed_at)) return null;
        } else return null;
      }
      if (["identity", "alias"].includes(row.event_type)
        && ((proof.canonicalAccountId !== undefined && proof.canonicalAccountId !== binding.canonicalAccountId)
          || (proof.uid !== undefined && proof.uid !== fresh.uid)
          || (proof.submittedAccountId !== undefined && proof.submittedAccountId !== binding.submittedAccountId)
          || (proof.sourceBindingChecksum !== undefined && proof.sourceBindingChecksum !== binding.sourceBindingChecksum))) return null;
    }
    const candidates = parsed.filter(({ row, proof }) => row.event_type === "identity"
      && proof.type === "source-id-verification" && proof.version === 1
      && proof.mode === "official-source-work-profile-cross-check");
    for (const { row, proof } of candidates) {
      if (!Number.isSafeInteger(row.id) || row.id <= 0 || row.target_id !== target.id
        || !Number.isSafeInteger(row.run_id) || row.run_id <= 0
        || proof.targetId !== target.id || proof.platform !== "douyin"
        || proof.sourceBindingChecksum !== binding.sourceBindingChecksum
        || proof.sourceVideoId !== binding.sourceVideoId || proof.submittedAccountId !== binding.submittedAccountId
        || proof.canonicalAccountId !== fresh.sec_uid || proof.uid !== fresh.uid
        || !HASH_RE.test(row.source_checksum) || typeof row.raw_json !== "string") return null;
      const historicalRaw = JSON.parse(row.raw_json);
      if (checksum(historicalRaw) !== row.source_checksum || JSON.stringify(historicalRaw) !== row.raw_json
        || proof.currentRawSha256 !== row.source_checksum) return null;
      const oldProfileAt = timestamp(historicalRaw.capturedAt), oldObservedAt = timestamp(proof.observedAt);
      const oldVerifiedAt = timestamp(proof.verifiedAt), createdAt = timestamp(row.created_at);
      if (![oldProfileAt, oldObservedAt, oldVerifiedAt, createdAt].every(Number.isFinite)
        || timestamp(row.observed_at) !== oldObservedAt || oldProfileAt > oldObservedAt
        || oldObservedAt > oldVerifiedAt || oldVerifiedAt > createdAt || createdAt > requestAt
        || oldProfileAt >= requestAt) return null;
      // A deleted profile invalidates older source-work credentials even if a
      // later active event exists; a new original-work proof is then required.
      if (parsed.some(item => item.row.event_type === "lifecycle" && item.proof.state === "deleted"
        && timestamp(item.row.observed_at) >= oldObservedAt)) return null;
      const rebuilt = verifySourceWorkIdentity(database, target, historicalRaw, {
        provider: "public-web", operation: "identity-work", requestedVideoId: binding.sourceVideoId,
        requestedAccountId: binding.canonicalAccountId, sourceBindingChecksum: binding.sourceBindingChecksum,
        observedAt: proof.verifiedAt,
      });
      if (!rebuilt || checksum(rebuilt) !== checksum(proof)) return null;
      const expectedKey = checksum([target.id, proof.submittedAccountId, proof.sourceVideoId,
        proof.canonicalAccountId, proof.uid, proof.sourceMatchField]);
      if (row.event_key !== expectedKey) return null;
      const run = db.prepare("SELECT id,started_at,finished_at,status FROM runs WHERE id=?").get(row.run_id);
      const start = timestamp(run?.started_at), finish = timestamp(run?.finished_at);
      if (!run || !["success", "partial"].includes(run.status) || !Number.isFinite(start) || !Number.isFinite(finish)
        || start > oldProfileAt || createdAt > finish || finish > requestAt) return null;
      const snapshots = db.prepare(`SELECT id,target_id,captured_at,quality_status,account_status,source_checksum,raw_json
        FROM snapshots WHERE target_id=? AND source_checksum=?`).all(target.id, row.source_checksum)
        .filter(snapshot => timestamp(snapshot.captured_at) === oldProfileAt);
      if (snapshots.length !== 1) return null;
      const snapshot = snapshots[0];
      if (!Number.isSafeInteger(snapshot.id) || snapshot.id <= 0 || !usableQuality(snapshot.quality_status)
        || snapshot.account_status !== "available" || snapshot.raw_json !== row.raw_json
        || checksum(JSON.parse(snapshot.raw_json)) !== snapshot.source_checksum) return null;
      const audits = db.prepare(`SELECT id,target_id,run_id,created_at,provider,status,source_checksum FROM audits
        WHERE target_id=? AND run_id=? AND source_checksum=? ORDER BY id`).all(target.id, row.run_id, row.source_checksum);
      if (audits.length !== 1) return null;
      const audit = audits[0], auditedAt = timestamp(audit.created_at);
      if (!Number.isSafeInteger(audit.id) || audit.id <= 0 || audit.provider !== "public-web" || !usableQuality(audit.status)
        || !Number.isFinite(auditedAt) || auditedAt < createdAt || auditedAt > finish) return null;
      // Re-read pause/conflict/metadata binding after all historical queries.
      const finalBinding = readRequest(database, target, freshRaw);
      if (!finalBinding || checksum(finalBinding) !== checksum(binding)) return null;
      return {
        type: "historical-source-id-verification", version: 1, mode: "verified-historical-source-work-identity",
        targetId: target.id, platform: "douyin", submittedAccountId: binding.submittedAccountId,
        currentPublicAccountId: publicId(fresh.unique_id) ? fresh.unique_id : null,
        canonicalAccountId: binding.canonicalAccountId, uid: fresh.uid,
        sourceVideoId: binding.sourceVideoId, sourceMatchField: proof.sourceMatchField,
        sourceAccountId: proof.sourceAccountId, sourceBindingChecksum: binding.sourceBindingChecksum,
        currentRawSha256: checksum(freshRaw), observedAt: freshRaw.capturedAt,
        freshProfileObservedAt: freshRaw.capturedAt, profileRequestStartedAt: requestStartedAt,
        verifiedAt: checkedAt, identityOnly: true,
        historicalEvidence: {
          eventId: row.id, runId: row.run_id, auditId: audit.id, snapshotId: snapshot.id,
          observedAt: proof.observedAt, profileCapturedAt: historicalRaw.capturedAt, verifiedAt: proof.verifiedAt,
          sourceChecksum: row.source_checksum, detailResponseChecksum: proof.detailResponseChecksum,
          eventChecksum: checksum(proof),
        },
        reason: "历史原表作品已回显提交号，原始证据与同轮快照、审计、任务相符；当前真实主页双ID一致。仅复用身份，指标和时间来自当前主页。",
      };
    }
    return null;
  } catch { return null; }
}
