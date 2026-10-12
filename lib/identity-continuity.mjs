import { createHash } from "node:crypto";
import { isOfficialDeferredProfileEnvelope, isOfficialMixedProfileEnvelope, OFFICIAL_DOUYIN_PROFILE_ENDPOINT } from "./official-profile-evidence.mjs";

const SEC_UID_RE = /^MS4wLj[\w-]{12,220}$/;
const PUBLIC_PROFILE_MODES = new Set([
  "guest-ttwid-x-bogus-profile-a-bogus-posts",
  "guest-ttwid-unsigned-profile-a-bogus-posts",
  "guest-ttwid-unsigned-profile-with-x-bogus-fallback-a-bogus-posts",
]);

const hashText = (value) => createHash("sha256").update(value).digest("hex");
const hashObject = (value) => hashText(JSON.stringify(value));

function metadata(target) {
  try {
    const result = target?.metadata_json === undefined ? target?.metadata : JSON.parse(target.metadata_json);
    return result && typeof result === "object" && !Array.isArray(result) ? result : null;
  } catch { return null; }
}

function displayId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9_.-]{1,100}$/.test(normalized) && normalized !== "0" ? normalized : null;
}

// Stable numeric IDs stay strings: no rounding, exponent parsing or stripping
// leading zeroes may turn one submitted ID into another observed identity.
function numericId(value) {
  return typeof value === "string" && /^[1-9]\d{1,24}$/.test(value) ? value : null;
}

function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return NaN;
  const parsed = Date.parse(value);
  const expected = value.includes(".") ? value : value.replace(/Z$/, ".000Z");
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === expected ? parsed : NaN;
}

function officialProfile(raw) {
  const provenance = raw?.provenance;
  // Old normal envelopes may omit these two fields. An explicit conflicting
  // field is not legacy evidence; a deferred envelope requires both fields.
  const normalProfile = PUBLIC_PROFILE_MODES.has(provenance?.mode)
    && (provenance.profileEndpoint === undefined || provenance.profileEndpoint === OFFICIAL_DOUYIN_PROFILE_ENDPOINT)
    && (provenance.profileMode === undefined || provenance.mode === `${provenance.profileMode}-a-bogus-posts`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || (!normalProfile && !isOfficialDeferredProfileEnvelope(raw) && !isOfficialMixedProfileEnvelope(raw)) || provenance.accountLocator !== "sec_uid"
    || provenance.cookiePersisted !== false || provenance.runtimeAI !== false || provenance.paidAPI !== false
    || (provenance.platform !== undefined && provenance.platform !== "douyin")
    || raw.source !== undefined || raw.roster !== undefined || raw.snapshot !== undefined
    || (raw.status_code !== undefined && raw.status_code !== 0)
    || (raw.accountStatus !== undefined && !["validated", "available"].includes(raw.accountStatus))) return null;
  const user = raw.profile?.user;
  if (!user || typeof user !== "object" || Array.isArray(user) || user.user_deleted === true
    || !SEC_UID_RE.test(user.sec_uid) || !numericId(user.uid)) return null;
  return user;
}

function matchingOriginalField(user, submitted) {
  if (displayId(user.unique_id) === submitted) return "unique_id";
  if (numericId(user.short_id) === submitted) return "short_id";
  if (numericId(user.uid) === submitted) return "uid";
  return null;
}

function eligibleTarget(target, submitted, locator) {
  const values = metadata(target);
  return target?.type === "account" && target.provider === "public-web"
    && (target.enabled === true || target.enabled === 1)
    && target.locator === locator && SEC_UID_RE.test(locator)
    && values && (values.platform === undefined || values.platform === "douyin")
    && values.douyinId === submitted && displayId(values.douyinId);
}

/**
 * Read-only proof of a public display-ID change for the same platform account.
 * raw is the current official collector envelope, not an import/resolver row.
 * The caller must persist this event together with raw and the new snapshot,
 * recheck pause/identity state before committing, and retain the submitted ID.
 * No metadata primary-mode flag, nickname or prior resolved status is evidence.
 */
export function verifyDouyinAliasContinuity(database, target, raw, { reference = new Date() } = {}) {
  try {
    const referenceAt = new Date(reference).getTime();
    const observedAt = timestamp(raw?.capturedAt);
    const submittedAccountId = metadata(target)?.douyinId;
    const originalId = displayId(submittedAccountId);
    const locator = target?.locator;
    if (!database?.db || !Number.isSafeInteger(target?.id) || target.id <= 0 || !originalId
      || !Number.isFinite(referenceAt) || !Number.isFinite(observedAt) || observedAt > referenceAt
      || !eligibleTarget(target, submittedAccountId, locator)) return null;
    const current = officialProfile(raw);
    const newId = displayId(current?.unique_id);
    if (!current || current.sec_uid !== locator || !newId || newId === originalId
      || matchingOriginalField(current, originalId)) return null;

    const readTarget = database.db.prepare("SELECT * FROM targets WHERE id=?");
    if (!eligibleTarget(readTarget.get(target.id), submittedAccountId, locator)) return null;
    const rows = database.db.prepare(`
      SELECT id,target_id,captured_at,quality_status,account_status,source_checksum,raw_json
      FROM snapshots WHERE target_id=? ORDER BY julianday(captured_at),id
    `).all(target.id);
    if (!rows.length) return null;

    const history = [];
    let prior = null;
    for (const row of rows) {
      const capturedAt = timestamp(row.captured_at);
      if (!Number.isSafeInteger(row.id) || row.id <= 0 || row.target_id !== target.id
        || !["validated", "warning"].includes(row.quality_status) || row.account_status !== "available"
        || !Number.isFinite(capturedAt) || capturedAt >= observedAt || capturedAt > referenceAt
        || typeof row.raw_json !== "string" || !/^[a-f0-9]{64}$/.test(row.source_checksum)
        || hashText(row.raw_json) !== row.source_checksum) return null;
      const previousRaw = JSON.parse(row.raw_json);
      if (hashObject(previousRaw) !== row.source_checksum
        || timestamp(previousRaw.capturedAt) !== capturedAt) return null;
      const previous = officialProfile(previousRaw);
      if (!previous || previous.sec_uid !== locator || previous.uid !== current.uid) return null;
      const matchField = matchingOriginalField(previous, originalId);
      if (matchField) prior = { row, user: previous, matchField };
      history.push({ snapshotId: row.id, capturedAt: row.captured_at, sourceChecksum: row.source_checksum });
    }
    if (!prior || !eligibleTarget(readTarget.get(target.id), submittedAccountId, locator)) return null;
    return {
      type: "douyin-account-alias-change",
      version: 1,
      mode: "verified-snapshot-dual-id-continuity",
      targetId: target.id,
      platform: "douyin",
      submittedAccountId,
      previousPublicAccountId: prior.user[prior.matchField],
      currentPublicAccountId: current.unique_id,
      canonicalAccountId: locator,
      uid: current.uid,
      priorSnapshotId: prior.row.id,
      priorSnapshotCapturedAt: prior.row.captured_at,
      priorSourceChecksum: prior.row.source_checksum,
      priorMatchField: prior.matchField,
      currentRawSha256: hashObject(raw),
      observedAt: raw.capturedAt,
      verifiedAt: new Date(referenceAt).toISOString(),
      historicalSnapshotCount: history.length,
      historyEvidenceSha256: hashObject(history),
      reason: "旧官方快照原文回显提交号，校验和一致；全部历史与当前 sec_uid、uid 连续一致，仅公开展示号变化",
    };
  } catch {
    // Missing/corrupt evidence or an unavailable database must fail closed.
    return null;
  }
}
