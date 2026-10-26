import test from "node:test";
import assert from "node:assert/strict";
import { buildReport, detectViralPosts, median, periodBounds, reviewState } from "../lib/analytics.mjs";

test("median handles even and odd samples", () => {
  assert.equal(median([1, 3, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), 0);
});

test("viral detection uses the stricter fixed or relative threshold", () => {
  const result = detectViralPosts([{ likes: 100 }, { likes: 200 }, { likes: 12_000 }], { fixedLikeThreshold: 10_000, relativeMultiplier: 3 });
  assert.equal(result.threshold, 10_000);
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].likes, 12_000);
});

test("small samples use the fixed threshold instead of multiplying themselves", () => {
  const result = detectViralPosts([{ likes: 12_500 }], { fixedLikeThreshold: 10_000, relativeMultiplier: 3 });
  assert.equal(result.threshold, 10_000);
  assert.equal(result.posts.length, 1);
});

test("viral relative threshold counts only posts with observed likes", () => {
  const result = detectViralPosts([
    { likes: 12_500 }, { likes: null }, { likes: null }, { likes: null }, { likes: null },
  ], { fixedLikeThreshold: 10_000, relativeMultiplier: 3 });
  assert.equal(result.threshold, 10_000);
  assert.equal(result.posts.length, 1);
});

test("period bounds starts weeks on Monday in local time", () => {
  const bounds = periodBounds("week", new Date("2026-08-31T12:00:00-07:00"));
  const start = new Date(bounds.start);
  assert.equal(start.getDay(), 1);
  assert.equal(start.getHours(), 0);
});

test("report counts unique authors and metric deltas", () => {
  const report = buildReport({
    period: "day",
    bounds: { start: "2026-08-31T07:00:00.000Z", end: "2026-09-01T06:59:59.000Z" },
    posts: [
      { target_id: 1, external_id: "a", author_id: "u1", likes: 11_000 },
      { target_id: 1, external_id: "b", author_id: "u1", likes: 500 },
      { target_id: 2, external_id: "c", author_id: "u2", likes: 700 },
    ],
    metrics: [{ likes_delta: 20 }, { likes_delta: 30 }],
    snapshots: [{ target_id: 1, quality_status: "validated" }, { target_id: 2, quality_status: "warning" }],
    snapshotComparisons: [
      { target_id: 1, current_followers: 125, baseline_followers: 100, current_total_likes: 1400, baseline_total_likes: 1000 },
      { target_id: 2, current_followers: 210, baseline_followers: 200, current_total_likes: 880, baseline_total_likes: null },
    ],
    targets: [
      { id: 1, accountStatus: "available", worksCoverage: "complete" },
      { id: 2, accountStatus: "available", worksCoverage: "retry" },
    ],
    options: { fixedLikeThreshold: 10_000, relativeMultiplier: 3 },
  });
  assert.equal(report.summary.postCount, 3);
  assert.equal(report.summary.authorCount, 2);
  assert.equal(report.summary.likesDelta, 50);
  assert.equal(report.summary.followersDelta, 35);
  assert.equal(report.summary.accountLikesDelta, 400);
  assert.equal(report.summary.estimatedPlaysDelta, 40_000);
  assert.equal(report.summary.followersComparableTargetCount, 2);
  assert.equal(report.summary.likesComparableTargetCount, 1);
  assert.equal(report.summary.validatedTargetCount, 1);
  assert.equal(report.contributors.length, 2);
  assert.equal(report.contributors.reduce((sum, item) => sum + (item.followersDelta ?? 0), 0), report.summary.followersDelta, "author contribution rows must tie out to the report total");
  assert.equal(report.contributors.reduce((sum, item) => sum + (item.accountLikesDelta ?? 0), 0), report.summary.accountLikesDelta, "like contribution rows must tie out to the report total");
});

test("report separates complete, range-limited, automatic-retry, and profile coverage", () => {
  const targets = [
    { id: 1, label: "完整", last_status: "validated", accountStatus: "available", worksCoverage: "complete" },
    { id: 2, label: "范围", last_status: "warning", accountStatus: "available", worksCoverage: "limited", latestWarnings: ["匿名公开接口仅返回账号最新公开作品窗口"] },
    { id: 3, label: "重试", last_status: "warning", accountStatus: "available", worksCoverage: "retry", latestWarnings: ["本次响应未识别到作品列表；未用 0 覆盖历史数据"] },
  ];
  const report = buildReport({
    period: "day",
    bounds: { start: "2026-09-03T07:00:00Z", end: "2026-09-04T06:59:59Z" },
    posts: [], metrics: [], snapshots: [], targets,
    coverageSnapshots: targets.map((target) => ({ target_id: target.id, followers: 100, total_likes: 200, quality_status: target.last_status, captured_at: "2026-09-02T17:00:00Z" })),
  });
  assert.equal(report.summary.profileObservedTargetCount, 3);
  assert.equal(report.summary.profileSuccessRate, 100);
  assert.equal(report.summary.validatedTargetCount, 1);
  assert.equal(report.summary.limitedTargetCount, 1);
  assert.equal(report.summary.retryTargetCount, 1);
  assert.equal(report.summary.worksUsableTargetCount, 2);
  assert.equal(report.summary.worksCompleteRate, 33.3);
  assert.equal(report.summary.worksUsableRate, 66.7);
  assert.equal(report.summary.worksSuccessRate, 66.7);
  assert.equal(report.summary.successRateGate, "attention");
});

test("verified complete works cannot also count as limited coverage", () => {
  const report = buildReport({
    period: "day",
    bounds: { start: "2026-09-28T00:00:00Z", end: "2026-09-28T23:59:59Z" },
    posts: [], metrics: [], snapshots: [],
    targets: [{ id: 1, label: "作者", last_status: "warning", accountStatus: "available", worksCoverage: "complete", latestWarnings: ["仅返回最新公开作品窗口"] }],
  });
  assert.equal(report.summary.validatedTargetCount, 1);
  assert.equal(report.summary.limitedTargetCount, 0);
  assert.equal(report.summary.worksUsableRate, 100);
});

test("missing Douyin account totals require retry while known public-window limits remain completed", () => {
  assert.equal(reviewState("warning", ["抖音公开主页响应未包含粉丝总数"]), "retry");
  assert.equal(reviewState("warning", ["抖音公开主页响应未包含账号获赞总数"]), "retry");
  assert.equal(reviewState("warning", ["匿名公开接口仅返回账号最新公开作品窗口"]), "limited");
});

test("unknown works coverage remains pending and is excluded from usable coverage", () => {
  const report = buildReport({
    period: "day",
    bounds: { start: "2026-09-03T07:00:00Z", end: "2026-09-04T06:59:59Z" },
    posts: [],
    metrics: [],
    snapshots: [],
    targets: [{ id: 1, label: "未知作品", last_status: "warning", accountStatus: "available", worksCoverage: "unknown" }],
    coverageSnapshots: [{ target_id: 1, followers: 100, total_likes: 200, quality_status: "warning", account_status: "available", works_coverage: "unknown", captured_at: "2026-08-30T17:00:00Z" }],
  });
  assert.equal(report.summary.validatedTargetCount, 0);
  assert.equal(report.summary.limitedTargetCount, 0);
  assert.equal(report.summary.retryTargetCount, 0);
  assert.equal(report.summary.unknownTargetCount, 1);
  assert.equal(report.summary.worksUsableTargetCount, 0);
  assert.equal(report.summary.worksCompleteRate, 0);
  assert.equal(report.summary.worksUsableRate, 0);
  assert.equal(report.summary.worksSuccessRate, 0);
});

test("missing, null, and unrecognized works coverage never becomes verified complete", () => {
  const targets = [
    { id: 1, label: "缺字段", last_status: "validated", accountStatus: "available" },
    { id: 2, label: "空值", last_status: "validated", accountStatus: "available", worksCoverage: null },
    { id: 3, label: "未来字段", last_status: "validated", accountStatus: "available", worksCoverage: "nonsense" },
    { id: 4, label: "未知账号状态", last_status: "validated", accountStatus: "nonsense", worksCoverage: "complete" },
  ];
  const report = buildReport({
    period: "day",
    bounds: { start: "2026-09-03T07:00:00Z", end: "2026-09-04T06:59:59Z" },
    posts: [], metrics: [], snapshots: [], targets,
  });
  assert.equal(report.summary.validatedTargetCount, 0);
  assert.equal(report.summary.unknownTargetCount, targets.length);
  assert.equal(report.summary.worksCompleteRate, 0);
  assert.equal(report.summary.worksUsableRate, 0);
  assert.equal(reviewState("validated", [], { accountStatus: "available", worksCoverage: null }), "pending");
  assert.equal(reviewState("validated", [], { accountStatus: "available", worksCoverage: "nonsense" }), "pending");
});

test("stale homepage errors keep a previously verified complete works snapshot usable", () => {
  const report = buildReport({
    period: "day",
    bounds: { start: "2026-09-03T07:00:00Z", end: "2026-09-04T06:59:59Z" },
    posts: [],
    metrics: [],
    snapshots: [],
    targets: [{ id: 1, label: "沿用历史", last_status: "error", accountStatus: "available", worksCoverage: "complete" }],
    coverageSnapshots: [{ target_id: 1, followers: 100, total_likes: 200, quality_status: "warning", account_status: "available", works_coverage: "complete", captured_at: "2026-08-30T17:00:00Z" }],
  });
  assert.equal(report.summary.validatedTargetCount, 1);
  assert.equal(report.summary.failedTargetCount, 1);
  assert.equal(report.summary.worksUsableTargetCount, 1);
});

test("report retains every post for complete CSV export", () => {
  const posts = Array.from({ length: 135 }, (_, index) => ({
    target_id: 1,
    external_id: `p-${index}`,
    author_id: "u1",
    likes: index,
  }));
  const report = buildReport({
    period: "month",
    bounds: { start: "2026-08-01T00:00:00Z", end: "2026-08-31T23:59:59Z" },
    posts,
    metrics: [],
    snapshots: [],
    targets: [{ id: 1 }],
  });
  assert.equal(report.summary.postCount, 135);
  assert.equal(report.posts.length, 135);
  assert.equal(report.summary.followersDelta, null);
  assert.equal(report.summary.estimatedPlaysDelta, null);
});

test("作品点赞缺失不得伪造为零，部分有值时仅汇总已知样本", () => {
  const base = {
    period: "day",
    bounds: { start: "2026-09-08T00:00:00Z", end: "2026-09-08T23:59:59Z" },
    metrics: [], snapshots: [], targets: [],
  };
  const allMissing = buildReport({
    ...base,
    posts: [
      { target_id: 1, external_id: "missing-a", author_id: "u1", likes: null },
      { target_id: 2, external_id: "missing-b", author_id: "u2" },
    ],
  });
  assert.equal(allMissing.summary.likesCurrent, null);
  assert.equal(allMissing.summary.medianLikes, null);
  assert.equal(allMissing.summary.likesObservedPostCount, 0);
  assert.equal(allMissing.summary.likesMissingPostCount, 2);
  assert.equal(allMissing.summary.viralCount, null);

  const partial = buildReport({
    ...base,
    posts: [
      { target_id: 1, external_id: "known", author_id: "u1", likes: 120 },
      { target_id: 2, external_id: "missing", author_id: "u2", likes: null },
    ],
  });
  assert.equal(partial.summary.likesCurrent, 120);
  assert.equal(partial.summary.medianLikes, 120);
  assert.equal(partial.summary.likesObservedPostCount, 1);
  assert.equal(partial.summary.likesMissingPostCount, 1);
});
