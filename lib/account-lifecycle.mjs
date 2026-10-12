import { checksum } from "./utils.mjs";

const SEC_UID_RE = /^MS4wLj[\w-]{12,220}$/;
const PROFILE_ENDPOINT = "https://www.douyin.com/aweme/v1/web/user/profile/other/";
const PROFILE_MODES = new Set([
  "guest-ttwid-unsigned-profile",
  "guest-ttwid-unsigned-profile-with-x-bogus-fallback",
]);
const DELETED_TITLES = new Set(["账号已经注销", "账号已注销", "用户已注销"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedObservedAt(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    return null;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const normalized = date.toISOString();
  return normalized.replace(".000Z", "Z") === value.replace(".000Z", "Z") ? normalized : null;
}

function hasAccessFailure(response) {
  const flags = ["need_login", "login_required", "captcha_required", "verify_required", "not_login_module"];
  if (flags.some((key) => Boolean(response[key]))) return true;
  const message = [response.status_msg, response.message].filter((value) => typeof value === "string").join(" ");
  return /登录|登陆|验证码|访问受限|login|log in|captcha|access denied/i.test(message);
}

function reportedUid(value) {
  // Never turn an already-rounded JSON number into an apparently exact ID.
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === "string" && /^[1-9]\d{0,24}$/.test(value) ? value : null;
}

/**
 * Interpret an explicit lifecycle response, not account identity or metrics.
 *
 * `transport` MUST be constructed by PublicWebProvider after its actual account
 * helper call succeeds. It must never come from a request body, imported file,
 * target metadata, or the collector envelope itself. These context strings are
 * a caller contract, not cryptographic authentication of arbitrary JSON.
 *
 * The collector retains the original official JSON in `profileResponse` before
 * normalizing `profile.user`. A legacy sanitized profile is insufficient.
 * The caller must retain `raw` in its append-only event store: checksums below
 * cover JSON serialization, not original HTTP bytes. No snapshot, zero metric,
 * enable/disable change, or verifiedIdentity is produced by this function.
 */
export function getDouyinLifecycleEvidence(target, raw, transport = null) {
  if (!isRecord(target) || target.type !== "account" || target.provider !== "public-web") return null;
  if ([target.platform, target.metadata?.platform].some((value) => value != null && value !== "douyin")) return null;
  const requestedAccountId = target.locator;
  if (typeof requestedAccountId !== "string" || !SEC_UID_RE.test(requestedAccountId)) return null;
  if (!isRecord(transport) || transport.provider !== "public-web" || transport.operation !== "account") return null;
  if (transport.requestedAccountId !== requestedAccountId) return null;
  const observedAt = normalizedObservedAt(transport.observedAt);
  if (!observedAt || !isRecord(raw) || !isRecord(raw.provenance)) return null;

  const { provenance, profileResponse } = raw;
  if (!PROFILE_MODES.has(provenance.profileMode) || provenance.profileEndpoint !== PROFILE_ENDPOINT) return null;
  if (provenance.accountLocator !== "sec_uid" || provenance.runtimeAI !== false || provenance.paidAPI !== false) return null;
  if (!isRecord(profileResponse) || profileResponse.status_code !== 0 || hasAccessFailure(profileResponse)) return null;

  // Reject ambiguous dual user objects rather than choosing a favorable branch.
  const userFields = ["user", "user_info"].filter((field) => isRecord(profileResponse[field]));
  if (userFields.length !== 1) return null;
  const responseUserField = userFields[0];
  const user = profileResponse[responseUserField];
  const special = user.special_state_info;
  if (user.user_deleted !== true || !isRecord(special) || special.special_state !== 1) return null;
  const title = typeof special.title === "string" ? special.title.trim() : "";
  const content = typeof special.content === "string" ? special.content.trim() : "";
  const explicitContent = /^用户已将自己账号注销(?:[，,。；;]|$)/.test(content);
  if (!DELETED_TITLES.has(title) && !explicitContent) return null;

  // A missing echo only describes the addressed profile. Any conflicting echo
  // anywhere in the original or normalized profile remains a hard rejection.
  const echoedProfiles = [user, raw.profile?.user, raw.profile?.user_info];
  for (const profile of echoedProfiles) {
    if (!isRecord(profile)) continue;
    for (const field of ["sec_uid", "secUid"]) {
      const value = profile[field];
      if (value !== undefined && value !== null && value !== "" && value !== requestedAccountId) return null;
    }
  }
  const reportedSecUid = user.sec_uid || user.secUid || null;
  const uid = reportedUid(user.uid);
  let sourceChecksum;
  let profileResponseChecksum;
  try {
    sourceChecksum = checksum(raw);
    profileResponseChecksum = checksum(profileResponse);
  } catch {
    return null;
  }

  return {
    state: "deleted",
    platform: "douyin",
    requestedAccountId,
    ...(uid ? { reportedUid: uid } : {}),
    observedAt,
    source: "official-public-profile",
    sourceUrl: `https://www.douyin.com/user/${requestedAccountId}`,
    sourceChecksum,
    checksumScope: "collector-envelope-json",
    profileResponseChecksum,
    profileMode: provenance.profileMode,
    profileEndpoint: provenance.profileEndpoint,
    scope: "requested-public-profile",
    identityVerified: false,
    reason: reportedSecUid
      ? "此请求主页明确显示账号已注销，回显 sec_uid 与请求一致；这是生命周期证据，不替代作者身份核验。"
      : "此请求主页明确显示账号已注销，但未回显 sec_uid；仅记录该请求主页的状态，不宣称作者身份核验通过。",
    evidenceFields: {
      statusCode: 0,
      userDeleted: true,
      specialState: 1,
      title,
      content,
      responseUserField,
      reportedSecUid,
      secUidEchoed: Boolean(reportedSecUid),
      secUidMatchesRequest: reportedSecUid ? true : null,
    },
  };
}
