// Collection health is deliberately split into two independent dimensions:
// the account profile (identity + cumulative counters) and the public works
// window.  This mirrors the local Jixuan command console: a restricted works
// endpoint must not make an otherwise valid profile disappear from the board.

const LIMITED_WORKS_PATTERN = /最新公开作品窗口|公开投稿列表.*受限|公开作品.*最新.*窗口|latest-public-window/i;
const RETRY_WORKS_PATTERN = /未识别到作品列表|作品列表接口未通过|作品列表.*失败|HTTP\s*(?:403|429)|限流|空内容|超时|unavailable/i;
const WORKS_ARRAY_KEYS = ["aweme_list", "video_list", "videos", "items", "works", "posts", "result_list", "data_list"];

function knownMetric(value) {
  if (value === null || value === undefined || value === "") return false;
  return Number.isFinite(Number(value));
}

function warningText(warnings = []) {
  return (Array.isArray(warnings) ? warnings : [warnings])
    .map((item) => {
      if (item && typeof item === "object") return [item.reason, item.error, item.message, item.warning].find((value) => String(value ?? "").trim()) ?? "";
      return String(item ?? "");
    })
    .join("；");
}

function hasExplicitWorksContainer(source, depth = 0, seen = new Set()) {
  if (!source || typeof source !== "object" || depth > 6 || seen.has(source)) return false;
  seen.add(source);
  for (const key of WORKS_ARRAY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key) && Array.isArray(source[key])) return true;
  }
  for (const value of Object.values(source)) {
    if (value && typeof value === "object" && hasExplicitWorksContainer(value, depth + 1, seen)) return true;
  }
  return false;
}

export function deriveCollectionHealth(target, snapshot = {}, warnings = [], raw = {}) {
  const account = target?.type === "account";
  if (!account) {
    return {
      accountStatus: "not-applicable",
      worksCoverage: "not-applicable",
      accountError: null,
      worksError: null,
    };
  }

  const rawAccountStatus = String(raw?.accountStatus ?? "").trim();
  const rawWorksCoverage = String(raw?.worksCoverage ?? raw?.provenance?.worksCoverage ?? "").trim();
  const text = warningText(warnings);
  const metricCount = [snapshot.followers, snapshot.totalLikes, snapshot.totalPosts].filter(knownMetric).length;
  const hasCoreMetric = metricCount > 0;
  const profileStatus = ["validated", "available"].includes(rawAccountStatus)
    ? metricCount >= 2 ? "available" : hasCoreMetric ? "partial" : "unavailable"
    : rawAccountStatus === "partial"
      ? "partial"
      : rawAccountStatus === "failed" || rawAccountStatus === "identity_mismatch"
        ? "unavailable"
        : hasCoreMetric
          ? (metricCount >= 2 ? "available" : "partial")
          : "unavailable";

  let worksCoverage = ["complete", "limited", "retry", "unavailable", "latest-public-window"].includes(rawWorksCoverage)
    ? rawWorksCoverage
    : null;
  if (worksCoverage === "latest-public-window") worksCoverage = "limited";
  if (!worksCoverage) {
    if (LIMITED_WORKS_PATTERN.test(text)) worksCoverage = "limited";
    else if (RETRY_WORKS_PATTERN.test(text)) worksCoverage = "retry";
    // Do not manufacture a complete works snapshot from a profile-only
    // response. An explicitly returned works array (including an empty
    // array for an account whose totalPosts is zero) is required evidence.
    else if (hasExplicitWorksContainer(raw) || (snapshot.totalPosts !== null && snapshot.totalPosts !== undefined && Number(snapshot.totalPosts) === 0)) worksCoverage = "complete";
    else worksCoverage = "unknown";
  }

  return {
    accountStatus: profileStatus,
    worksCoverage,
    accountError: raw?.accountError ?? (profileStatus === "unavailable" ? "主页未返回可用累计指标" : null),
    worksError: raw?.worksError ?? null,
  };
}

export function profileUsable(status) {
  return ["available", "partial"].includes(String(status ?? ""));
}

export function collectionHealthLabel({ accountStatus, worksCoverage, stale = false } = {}) {
  if (profileUsable(accountStatus)) {
    if (stale) return { key: "stale", label: "沿用上次有效主页" };
    if (worksCoverage === "retry" || worksCoverage === "unavailable") return { key: "profile", label: "主页已更新 · 作品待补采" };
    if (worksCoverage === "limited" || worksCoverage === "latest-public-window") return { key: "profile", label: "主页已核验 · 最新作品窗口" };
    if (worksCoverage === "unknown") return { key: "pending", label: "主页已更新 · 作品覆盖待判定" };
    return { key: "complete", label: "主页与作品已更新" };
  }
  return null;
}
