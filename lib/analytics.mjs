import { businessDateKey, businessDateStartUtc, shiftCalendarDate } from "./utils.mjs";
import { describeWorkPlays } from "./work-play-semantics.mjs";

const DAY_MS = 86_400_000;
const ACCOUNT_STATUSES = new Set(["available", "partial", "unavailable", "identity_mismatch", "unknown"]);
const WORKS_COVERAGES = new Set(["complete", "limited", "latest-public-window", "retry", "unavailable", "unknown"]);

function zonedDateKey(value, timeZone) {
  return timeZone ? businessDateKey(value, timeZone) : null;
}

export function median(values) {
  const numbers = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!numbers.length) return 0;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

export function percentile(values, quantile) {
  const numbers = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!numbers.length) return 0;
  const position = (numbers.length - 1) * Math.max(0, Math.min(1, quantile));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return numbers[lower];
  return numbers[lower] + (numbers[upper] - numbers[lower]) * (position - lower);
}

export function periodBounds(period = "day", reference = new Date(), timeZone = null) {
  if (timeZone) {
    const end = new Date(reference);
    if (Number.isNaN(end.getTime())) throw new Error("统计时间无效");
    const endDate = zonedDateKey(end, timeZone);
    const startDate = period === "day"
      ? endDate
      : period === "week"
        ? (() => {
            const day = new Date(`${endDate}T00:00:00Z`);
            const mondayOffset = (day.getUTCDay() + 6) % 7;
            return shiftCalendarDate(endDate, -mondayOffset);
          })()
        : period === "month"
          ? `${endDate.slice(0, 8)}01`
          : null;
    if (period === "30d") return { start: new Date(end.getTime() - 30 * DAY_MS).toISOString(), end: end.toISOString() };
    if (!startDate) throw new Error(`不支持的统计周期：${period}`);
    return { start: businessDateStartUtc(startDate, timeZone).toISOString(), end: end.toISOString() };
  }
  const end = new Date(reference);
  const start = new Date(reference);
  if (period === "day") {
    start.setHours(0, 0, 0, 0);
  } else if (period === "week") {
    start.setHours(0, 0, 0, 0);
    const mondayOffset = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - mondayOffset);
  } else if (period === "month") {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
  } else if (period === "30d") {
    start.setTime(end.getTime() - 30 * DAY_MS);
  } else {
    throw new Error(`不支持的统计周期：${period}`);
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

export function detectViralPosts(posts, options = {}) {
  const fixedLikeThreshold = Number(options.fixedLikeThreshold ?? 10_000);
  const relativeMultiplier = Number(options.relativeMultiplier ?? 3);
  const likes = posts.map((post) => numberOrNull(post.likes)).filter((value) => value !== null);
  const baseline = Math.max(median(likes), percentile(likes, 0.6));
  const relativeThreshold = likes.length >= 5 ? Math.round(baseline * relativeMultiplier) : 0;
  const threshold = Math.max(fixedLikeThreshold, relativeThreshold);
  return {
    threshold,
    baseline: Math.round(baseline),
    posts: posts
      .filter((post) => {
        const likesValue = numberOrNull(post.likes);
        return likesValue !== null && likesValue >= threshold;
      })
      .sort((a, b) => Number(b.likes ?? 0) - Number(a.likes ?? 0)),
  };
}

function snapshotDelta(rows, currentKey, baselineKey) {
  const comparable = rows.flatMap((row) => {
    const current = row[currentKey] === null || row[currentKey] === undefined ? null : Number(row[currentKey]);
    const baseline = row[baselineKey] === null || row[baselineKey] === undefined ? null : Number(row[baselineKey]);
    return Number.isFinite(current) && Number.isFinite(baseline) ? [current - baseline] : [];
  });
  return {
    value: comparable.length ? comparable.reduce((sum, value) => sum + value, 0) : null,
    comparableTargetCount: comparable.length,
  };
}

function warningList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function reviewState(status, warnings = [], context = {}) {
  const rawAccountStatus = context?.accountStatus;
  const accountStatus = ACCOUNT_STATUSES.has(rawAccountStatus) ? rawAccountStatus : "unknown";
  const rawWorksCoverage = context?.worksCoverage;
  // Missing or future coverage values must fail closed: profile validation is
  // not evidence that the author's full works list was verified.
  const worksCoverage = WORKS_COVERAGES.has(rawWorksCoverage) ? rawWorksCoverage : "unknown";
  if (accountStatus === "identity_mismatch") return "manual";
  if (accountStatus === "unavailable" && status !== "rejected") return "retry";
  if (["available", "partial"].includes(accountStatus)) {
    if (worksCoverage === "unknown") return "pending";
    if (["limited", "latest-public-window"].includes(worksCoverage)) return "limited";
    if (["retry", "unavailable"].includes(worksCoverage)) return "retry";
    if (worksCoverage === "complete" && status === "validated") return "complete";
  }
  const warningText = warnings.join("；");
  if (status === "validated") return accountStatus === "unknown" ? "pending" : "complete";
  if (status === "warning" && /未识别到作品列表|作品列表接口未通过|抖音公开主页响应未包含(?:粉丝|账号获赞)总数|HTTP\s*403|限流|空内容|失败|受限|超时|连续/.test(warningText)) return "retry";
  if (status === "warning") return "limited";
  if (status === "rejected") return "manual";
  if (status === "error") return "failed";
  return "pending";
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function deltaOrNull(current, baseline) {
  const currentNumber = numberOrNull(current);
  const baselineNumber = numberOrNull(baseline);
  return currentNumber === null || baselineNumber === null ? null : currentNumber - baselineNumber;
}

export function buildReport({ period, bounds, posts, metrics, snapshots, coverageSnapshots = snapshots, snapshotComparisons = [], collectionActivity = {}, targets, options = {} }) {
  const viral = detectViralPosts(posts, options);
  const authorIds = new Set(posts.map((post) => post.author_id || post.author_name).filter(Boolean));
  const targetIds = new Set(posts.map((post) => post.target_id));
  const likes = posts.map((post) => numberOrNull(post.likes)).filter((value) => value !== null);
  const metricDelta = metrics.length
    ? metrics.reduce((sum, row) => sum + Number(row.likes_delta ?? 0), 0)
    : null;
  const latestSnapshots = new Map();
  for (const snapshot of coverageSnapshots) {
    if (!latestSnapshots.has(snapshot.target_id)) latestSnapshots.set(snapshot.target_id, snapshot);
  }
  const targetById = new Map(targets.map((target) => [Number(target.id), target]));
  const contributors = snapshotComparisons.map((row) => {
    const target = targetById.get(Number(row.target_id)) ?? {};
    const latestSnapshot = latestSnapshots.get(row.target_id) ?? latestSnapshots.get(Number(row.target_id)) ?? {};
    const warnings = warningList(row.current_warnings_json ?? target.latestWarnings ?? latestSnapshot.warnings_json);
    const qualityStatus = row.current_quality_status ?? target.last_status ?? latestSnapshot.quality_status ?? "pending";
    const accountStatus = row.current_account_status ?? target.accountStatus ?? latestSnapshot.account_status ?? "unknown";
    const worksCoverage = row.current_works_coverage ?? target.worksCoverage ?? latestSnapshot.works_coverage ?? "unknown";
    const followersDelta = deltaOrNull(row.current_followers, row.baseline_followers);
    const accountLikesDelta = deltaOrNull(row.current_total_likes, row.baseline_total_likes);
    return {
      targetId: Number(row.target_id),
      label: target.label ?? `目标 ${row.target_id}`,
      platform: target.metadata?.platform ?? "douyin",
      boards: Array.isArray(target.boards) ? target.boards : [],
      followersBaseline: numberOrNull(row.baseline_followers),
      followersCurrent: numberOrNull(row.current_followers),
      followersDelta,
      followersBaselineAt: row.followers_baseline_captured_at ?? row.baseline_captured_at ?? null,
      followersCurrentAt: row.followers_current_captured_at ?? row.current_captured_at ?? null,
      followersBaselineChecksum: row.followers_baseline_checksum ?? null,
      followersCurrentChecksum: row.followers_current_checksum ?? null,
      followersBaselineMode: row.followers_baseline_mode ?? null,
      accountLikesBaseline: numberOrNull(row.baseline_total_likes),
      accountLikesCurrent: numberOrNull(row.current_total_likes),
      accountLikesDelta,
      accountLikesBaselineAt: row.likes_baseline_captured_at ?? row.baseline_captured_at ?? null,
      accountLikesCurrentAt: row.likes_current_captured_at ?? row.current_captured_at ?? null,
      accountLikesBaselineChecksum: row.likes_baseline_checksum ?? null,
      accountLikesCurrentChecksum: row.likes_current_checksum ?? null,
      accountLikesBaselineMode: row.likes_baseline_mode ?? null,
      estimatedPlaysDelta: accountLikesDelta === null ? null : accountLikesDelta * 100,
      qualityStatus,
      accountStatus,
      worksCoverage,
      accountError: row.current_account_error ?? target.accountError ?? latestSnapshot.account_error ?? null,
      worksError: row.current_works_error ?? target.worksError ?? latestSnapshot.works_error ?? null,
      reviewState: reviewState(qualityStatus, warnings, { accountStatus, worksCoverage }),
      warnings,
    };
  });
  const followerGrowth = snapshotDelta(contributors, "followersCurrent", "followersBaseline");
  const likesGrowth = snapshotDelta(contributors, "accountLikesCurrent", "accountLikesBaseline");
  const coverageRows = targets.map((target) => {
    const snapshot = latestSnapshots.get(target.id) ?? latestSnapshots.get(Number(target.id)) ?? {};
    const warnings = warningList(target.latestWarnings ?? snapshot.warnings_json);
    const status = target.last_status ?? snapshot.quality_status ?? "pending";
    const accountStatus = snapshot.account_status ?? target.accountStatus ?? "unknown";
    const worksCoverage = snapshot.works_coverage ?? target.worksCoverage ?? "unknown";
    return { target, snapshot, status, warnings, accountStatus, worksCoverage, state: reviewState(status, warnings, { accountStatus, worksCoverage }) };
  });
  const profileObservedTargetCount = coverageRows.filter(({ snapshot }) => [snapshot.followers, snapshot.total_likes, snapshot.total_posts].some((value) => numberOrNull(value) !== null)).length;
  // Keep works coverage separate from the latest homepage attempt. A stale
  // homepage error must not erase a previously verified complete works
  // snapshot; failedTargetCount below still exposes that homepage problem.
  const hasCompleteWorks = (item) =>
    item.state === "complete"
    || (item.worksCoverage === "complete" && ["available", "partial"].includes(item.accountStatus));
  const validatedTargetCount = coverageRows.filter(hasCompleteWorks).length;
  // A verified complete list and a limited latest window are exclusive
  // works-coverage states, even when homepage warnings are also present.
  const limitedTargetCount = coverageRows.filter((item) => !hasCompleteWorks(item) && item.state === "limited").length;
  const retryTargetCount = coverageRows.filter((item) => !hasCompleteWorks(item) && item.state === "retry").length;
  const targetCount = targets.length;
  const profileSuccessRate = targetCount ? Math.round((profileObservedTargetCount / targetCount) * 1000) / 10 : null;
  // Keep the two questions separate: "complete" means a verified works list;
  // "usable" also includes the latest public window, which is valid for
  // daily growth reporting but is not the author's full history.
  const worksCompleteRate = targetCount ? Math.round((validatedTargetCount / targetCount) * 1000) / 10 : null;
  const worksUsableRate = targetCount ? Math.round(((validatedTargetCount + limitedTargetCount) / targetCount) * 1000) / 10 : null;
  // Compatibility alias retained for older exports and the success gate.
  const worksSuccessRate = worksUsableRate;
  const successRateFloor = 94;
  const successRateGate = profileSuccessRate === null || worksSuccessRate === null
    ? "unknown"
    : profileSuccessRate >= successRateFloor && worksSuccessRate >= successRateFloor ? "pass" : "attention";
  const latestSnapshotAt = [...latestSnapshots.values()].map((item) => item.captured_at).filter(Boolean).sort().at(-1) ?? null;
  const withPlayEvidence = (post) => ({ ...post,
    playsEvidence: describeWorkPlays(post.plays, targetById.get(Number(post.target_id))?.metadata?.platform),
  });
  return {
    period,
    start: bounds.start,
    end: bounds.end,
    generatedAt: new Date().toISOString(),
    summary: {
      targetCount,
      activeTargetCount: targetIds.size,
      postCount: posts.length,
      authorCount: authorIds.size,
      likesCurrent: likes.length ? likes.reduce((sum, value) => sum + value, 0) : null,
      likesObservedPostCount: likes.length,
      likesMissingPostCount: posts.length - likes.length,
      likesDelta: metricDelta,
      sampledDeltaPostCount: metrics.length,
      followersDelta: followerGrowth.value,
      accountLikesDelta: likesGrowth.value,
      estimatedPlaysDelta: likesGrowth.value === null ? null : likesGrowth.value * 100,
      growthCurrentTargetCount: snapshotComparisons.length,
      followersComparableTargetCount: followerGrowth.comparableTargetCount,
      likesComparableTargetCount: likesGrowth.comparableTargetCount,
      followersFallbackBaselineTargetCount: contributors.filter((item) => item.followersDelta !== null && item.followersBaselineMode === "first-in-period").length,
      likesFallbackBaselineTargetCount: contributors.filter((item) => item.accountLikesDelta !== null && item.accountLikesBaselineMode === "first-in-period").length,
      medianLikes: likes.length ? Math.round(median(likes)) : null,
      viralCount: likes.length ? viral.posts.length : null,
      viralThreshold: viral.threshold,
      snapshotCount: snapshots.length,
      profileSnapshotTargetCount: new Set(snapshots.map((item) => Number(item.target_id))).size,
      sampledPostCount: Number(collectionActivity.sampled_post_count || 0),
      newlyObservedPostCount: Number(collectionActivity.newly_observed_post_count || 0),
      latestSnapshotAt,
      profileObservedTargetCount,
      profileSuccessRate,
      validatedTargetCount,
      limitedTargetCount,
      retryTargetCount,
      // Pending is the fail-closed bucket for missing/invalid account or works
      // evidence; count it unless an independently verified complete list won.
      unknownTargetCount: coverageRows.filter((item) => !hasCompleteWorks(item) && item.state === "pending").length,
      worksUsableTargetCount: validatedTargetCount + limitedTargetCount,
      worksCompleteRate,
      worksUsableRate,
      worksSuccessRate,
      successRateFloor,
      successRateGate,
      manualActionTargetCount: coverageRows.filter((item) => item.state === "manual").length,
      failedTargetCount: coverageRows.filter((item) => item.state === "failed").length,
    },
    viral: viral.posts.slice(0, 20).map(withPlayEvidence),
    contributors,
    posts: posts.map(withPlayEvidence),
  };
}
