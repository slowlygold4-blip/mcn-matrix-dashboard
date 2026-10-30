// Collection health is deliberately split into two independent dimensions:
// the account profile (identity + cumulative counters) and the public works
// window.  This mirrors the local Jixuan command console: a restricted works
// endpoint must not make an otherwise valid profile disappear from the board.

const LIMITED_WORKS_PATTERN = /最新公开作品窗口|公开投稿列表.*受限|公开作品.*最新.*窗口|latest-public-window/i;
const RETRY_WORKS_PATTERN = /未识别到作品列表|作品列表接口未通过|作品列表.*失败|HTTP\s*(?:403|429)|限流|空内容|超时|unavailable/i;
const WORKS_ARRAY_KEYS = ["aweme_list", "video_list", "videos", "items", "works", "posts", "result_list", "data_list"];

function knownMetric(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** A status label alone cannot prove that all three profile counters exist.
 * Missing counters remain saved partial evidence, never manufactured zeros. */
export function profileMetricsUsable({accountStatus,qualityStatus,snapshot}={}) {
  return ['available','partial'].includes(accountStatus)
    && ['validated','warning'].includes(qualityStatus)
    && [snapshot?.followers,snapshot?.totalLikes,snapshot?.totalPosts].every(knownMetric);
}

function warningText(warnings = []) {
  return (Array.isArray(warnings) ? warnings : [warnings])
    .map((item) => {
      if (item && typeof item === "object") return [item.reason, item.error, item.message, item.warning].find((value) => String(value ?? "").trim()) ?? "";
      return String(item ?? "");
    })
    .join("；");
}

// A returned array proves an observed sample, not exhausted pagination. Scan
// beyond empty containers so a second nonempty array cannot become zero works.
function worksArrayState(source, depth = 0, seen = new Set()) {
  if (!source || typeof source !== "object" || depth > 6 || seen.has(source)) return null;
  seen.add(source);
  let empty = false;
  for (const key of WORKS_ARRAY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key) && Array.isArray(source[key])) {
      if (source[key].length) return "nonempty";
      empty = true;
    }
  }
  for (const value of Object.values(source)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const state = worksArrayState(value, depth + 1, seen);
    if (state === "nonempty") return state;
    if (state === "empty") empty = true;
  }
  return empty ? "empty" : null;
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
      ? hasCoreMetric ? "partial" : "unavailable"
      : rawAccountStatus === "failed" || rawAccountStatus === "identity_mismatch"
        ? "unavailable"
        : hasCoreMetric
          ? (metricCount >= 2 ? "available" : "partial")
          : "unavailable";

  let worksCoverage = ["complete", "limited", "retry", "unavailable", "latest-public-window", "unknown"].includes(rawWorksCoverage)
    ? rawWorksCoverage
    : null;
  if (worksCoverage === "latest-public-window") worksCoverage = "limited";
  if (!worksCoverage) {
    if (LIMITED_WORKS_PATTERN.test(text)) worksCoverage = "limited";
    else if (RETRY_WORKS_PATTERN.test(text)) worksCoverage = "retry";
    else {
      const list = worksArrayState(raw);
      // The narrow legacy zero-inventory case needs both observations.
      // Nonempty samples never prove all works, even when their sizes match.
      worksCoverage = list === "empty" && snapshot.totalPosts === 0 ? "complete"
        : list !== null ? "limited" : "unknown";
    }
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
    if (worksCoverage === "complete") return { key: "complete", label: "主页与作品已更新" };
    return { key: "pending", label: "主页已更新 · 作品覆盖待判定" };
  }
  return null;
}
