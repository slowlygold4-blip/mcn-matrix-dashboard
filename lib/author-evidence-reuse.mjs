import { createHash } from "node:crypto";
import { authorQueuePlatform, explicitAccountLocatorFromIdentityKey, queuedAuthorAccountLocator } from "./author-queue-identity.mjs";

const SEC_UID_RE = /^MS4wLj[\w-]{12,220}$/;
const VIDEO_ID_RE = /^\d{15,25}$/;
const DOUYIN_HOSTS = new Set(["douyin.com", "www.douyin.com", "v.douyin.com"]);

function accountId(value) {
  return String(value ?? "").normalize("NFKC").replace(/^@/, "").trim().toLowerCase();
}

function metadata(target) {
  try {
    const value = target?.metadata_json === undefined ? target?.metadata : JSON.parse(target.metadata_json);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function evidenceValues(queue, field, validate) {
  try {
    const values = JSON.parse(queue?.[field]);
    if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) return null;
    const normalized = values.map(validate);
    if (normalized.some((value) => !value) || new Set(normalized).size !== normalized.length) return null;
    return normalized;
  } catch { return null; }
}

function publicEvidenceUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || !DOUYIN_HOSTS.has(url.hostname.toLowerCase()) || url.pathname === "/") return null;
    // Only browser-local fragments are removed. Path/query case stays exact.
    url.hash = "";
    return url.toString();
  } catch { return null; }
}

function evidence(queue) {
  const videos = evidenceValues(queue, "video_ids_json", (value) => VIDEO_ID_RE.test(value) ? value : null);
  const shares = evidenceValues(queue, "share_urls_json", publicEvidenceUrl);
  return videos && shares && videos.length + shares.length > 0 ? { videos, shares } : null;
}

function locatorConstraintsMatch(queue, expected, required) {
  const stored = String(queue?.account_locator ?? "").trim();
  if (stored && (!SEC_UID_RE.test(stored) || stored !== expected)) return false;
  const inKey = explicitAccountLocatorFromIdentityKey(queue);
  if (inKey && (inKey.platform !== "douyin" || inKey.locator !== expected)) return false;
  return !required || queuedAuthorAccountLocator(queue) === expected;
}

function verifiedPublicIdentity(target, expectedId, expectedSecUid) {
  if (!target || target.type !== "account" || target.provider !== "public-web" || target.locator !== expectedSecUid) return null;
  const values = metadata(target);
  const resolution = values?.resolution;
  if ((values?.platform ?? resolution?.platform) !== "douyin"
    || resolution?.platform !== "douyin" || resolution?.mode !== "public-video-detail"
    || resolution?.canonicalAccountId !== expectedSecUid
    || !accountId(resolution?.publicDouyinId) || accountId(resolution.publicDouyinId) !== expectedId) return null;
  // Submitted IDs, source URLs and source metadata are not public observations.
  return { publicDouyinId: resolution.publicDouyinId, canonicalAccountId: resolution.canonicalAccountId };
}

/**
 * Reuse a trusted local successful queue receipt, not a reconstructed network
 * candidate. Accepts raw SQLite rows and never mutates them or performs I/O.
 * The caller must additionally restrict incoming IDs to this import, verify the
 * source fingerprint and apply a no-lease/evidence-version CAS transaction.
 */
export function reusableStoredAuthorEvidence(incoming, priorQueue, priorTarget, currentTarget) {
  if (!incoming || !priorQueue || !priorTarget || !currentTarget) return null;
  if (!Number.isSafeInteger(incoming.id) || incoming.id <= 0
    || !Number.isSafeInteger(priorQueue.id) || priorQueue.id <= 0 || incoming.id === priorQueue.id) return null;
  if (!["pending", "retry"].includes(incoming.status) || incoming.resolved_target_id != null
    || incoming.suspended_target_enabled != null || incoming.lease_owner || incoming.lease_until) return null;
  if (priorQueue.status !== "resolved" || Number(priorQueue.verification_policy_version) < 2
    || !Number.isInteger(Number(priorQueue.verification_policy_version))
    || priorQueue.suspended_target_enabled != null || priorQueue.lease_owner || priorQueue.lease_until) return null;
  if (!Number.isSafeInteger(priorQueue.resolved_target_id) || priorQueue.resolved_target_id <= 0
    || priorTarget.id !== priorQueue.resolved_target_id || currentTarget.id !== priorQueue.resolved_target_id) return null;
  if (authorQueuePlatform(incoming) !== "douyin" || authorQueuePlatform(priorQueue) !== "douyin") return null;
  const expectedId = accountId(incoming.douyin_id);
  if (!expectedId || accountId(priorQueue.douyin_id) !== expectedId) return null;
  const expectedSecUid = String(priorTarget.locator ?? "");
  if (!SEC_UID_RE.test(expectedSecUid)
    || !locatorConstraintsMatch(incoming, expectedSecUid, true)
    || !locatorConstraintsMatch(priorQueue, expectedSecUid, false)) return null;
  const priorIdentity = verifiedPublicIdentity(priorTarget, expectedId, expectedSecUid);
  const currentIdentity = verifiedPublicIdentity(currentTarget, expectedId, expectedSecUid);
  if (!priorIdentity || !currentIdentity) return null;
  const requested = evidence(incoming);
  const verified = evidence(priorQueue);
  if (!requested || !verified
    || !requested.videos.every((id) => verified.videos.includes(id))
    || !requested.shares.every((url) => verified.shares.includes(url))) return null;
  if (!priorQueue.updated_at || !Number.isFinite(Date.parse(priorQueue.updated_at))) return null;
  const receipt = {
    mode: "stored-strict-queue-receipt",
    sourceQueueId: priorQueue.id,
    sourceIdentityKey: priorQueue.identity_key,
    sourceEvidenceVersion: priorQueue.evidence_version,
    verificationPolicyVersion: Number(priorQueue.verification_policy_version),
    sourceStatus: priorQueue.status,
    targetId: priorQueue.resolved_target_id,
    submittedAccountId: expectedId,
    canonicalAccountId: expectedSecUid,
    publicIdentity: priorIdentity,
    videoIds: verified.videos,
    shareUrls: verified.shares,
    sourceReceiptUpdatedAt: priorQueue.updated_at,
  };
  return {
    targetId: priorQueue.resolved_target_id,
    sourceQueueId: priorQueue.id,
    sourceEvidenceSha256: createHash("sha256").update(JSON.stringify(receipt)).digest("hex"),
    verifiedAt: priorQueue.updated_at,
    sourceReceiptUpdatedAt: priorQueue.updated_at,
    mode: "stored-strict-queue-receipt",
    verificationPolicyVersion: Number(priorQueue.verification_policy_version),
    requestedEvidenceCount: requested.videos.length + requested.shares.length,
    canonicalAccountId: expectedSecUid,
    publicDouyinId: currentIdentity.publicDouyinId,
    reason: "复用已有严格核验凭证：账号与公开身份一致，完整作品和分享链接约束均被旧成功凭证覆盖；本次未重新请求平台",
  };
}

/** Complete source provenance is a prerequisite for unattended import reuse. */
export function authorEvidenceSourceFingerprint(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  try {
    const url = new URL(source.sourceUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || !/(^|\.)(feishu\.cn|larkoffice\.com|larksuite\.com)$/.test(url.hostname)
      || !/^\/(sheets|base)\/[A-Za-z0-9]+\/?$/.test(url.pathname)
      || !Number.isSafeInteger(source.sourceRevision) || source.sourceRevision <= 0
      || typeof source.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(source.sourceSha256)) return null;
    return createHash("sha256").update(JSON.stringify(source)).digest("hex");
  } catch { return null; }
}

/**
 * Routine reuse has no historical target backup. Therefore the original queue
 * itself must bind the canonical ID. Reused receipts are deliberately NOT
 * roots: the original immutable successful row must still exist and validate.
 * This keeps verifiedAt anchored to the original verification, never reusedAt.
 */
export function uniqueRoutineAuthorEvidence(incoming, priorQueues, targets, reference = new Date()) {
  const referenceMs = reference instanceof Date ? reference.getTime() : Date.parse(reference);
  if (!Number.isFinite(referenceMs)) return null;
  const matches = [];
  for (const prior of priorQueues) {
    let source;
    try { source = JSON.parse(prior.source_metadata_json ?? "{}"); } catch { continue; }
    if (!source || typeof source !== "object" || Array.isArray(source) || source.evidenceReuse) continue;
    const target = targets.get(prior.resolved_target_id);
    if (!target || !locatorConstraintsMatch(prior, target.locator, true)) continue;
    const verifiedMs = Date.parse(prior.updated_at);
    if (!Number.isFinite(verifiedMs) || verifiedMs > referenceMs
      || new Date(verifiedMs).toISOString() !== prior.updated_at) continue;
    const proof = reusableStoredAuthorEvidence(incoming, prior, target, target);
    if (proof) matches.push(proof);
  }
  if (!matches.length || new Set(matches.map((proof) => proof.targetId)).size !== 1) return null;
  // Stable oldest root; duplicates cannot make a newer verification date.
  return matches.sort((a, b) => a.verifiedAt.localeCompare(b.verifiedAt) || a.sourceQueueId - b.sourceQueueId)[0];
}

/** A repeated job may acknowledge an existing strict receipt without claiming
 * a new reuse or public observation. Reused rows must still bind their root. */
export function verifiedExistingRoutineAuthorEvidence(queue, priorQueues, targets, reference = new Date()) {
  const target = targets.get(queue?.resolved_target_id);
  const referenceMs = reference instanceof Date ? reference.getTime() : Date.parse(reference);
  if (!queue || queue.status !== "resolved" || !Number.isSafeInteger(queue.id) || queue.id <= 0
    || !target || target.id !== queue.resolved_target_id || queue.lease_owner || queue.lease_until
    || queue.suspended_target_enabled != null || !Number.isSafeInteger(Number(queue.verification_policy_version))
    || Number(queue.verification_policy_version) < 2 || !locatorConstraintsMatch(queue, target.locator, true)
    || authorQueuePlatform(queue) !== "douyin" || !evidence(queue)
    || !verifiedPublicIdentity(target, accountId(queue.douyin_id), target.locator)
    || !Number.isFinite(referenceMs)) return null;
  let source;
  try { source = JSON.parse(queue.source_metadata_json ?? "{}"); } catch { return null; }
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  if (source.evidenceReuse) {
    const rootId = source.evidenceReuse.sourceQueueId;
    const proof = uniqueRoutineAuthorEvidence({ ...queue, status: "pending", resolved_target_id: null },
      priorQueues.filter((row) => row.id === rootId), targets, reference);
    if (!proof || proof.sourceEvidenceSha256 !== source.evidenceReuse.sourceEvidenceSha256
      || proof.verifiedAt !== source.evidenceReuse.verifiedAt || proof.targetId !== queue.resolved_target_id
      || source.evidenceReuse.newPublicCollection !== false) return null;
    return { sourceQueueId: rootId, verifiedAt: proof.verifiedAt, newPublicCollection: false };
  }
  const verifiedMs = Date.parse(queue.updated_at);
  if (!Number.isFinite(verifiedMs) || verifiedMs > referenceMs || new Date(verifiedMs).toISOString() !== queue.updated_at) return null;
  return { sourceQueueId: queue.id, verifiedAt: queue.updated_at, newPublicCollection: false };
}
