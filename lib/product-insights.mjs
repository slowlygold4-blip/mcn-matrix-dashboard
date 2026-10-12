import { periodBounds, reviewState } from "./analytics.mjs";
import { createHash } from "node:crypto";
import { normalizeBoardKey, normalizeBoardName, targetEnabledAtSql } from "./database.mjs";
import { businessDateKey, businessDateStartUtc, checksum, localDateKey, safeJson, shiftCalendarDate } from "./utils.mjs";
import { aggregateWorksObservations, describeWorksObservation, loadVerifiedWorksOnlyRows, withWorksObservationRead } from "./works-observation.mjs";
import { normalizeCollection, normalizePost } from "./providers/normalize.mjs";
import { browserWorksObservation } from "./official-profile-evidence.mjs";
import { classifyAuthor, summarizeClassifications, summarizeThemes, classificationCatalog, AUTHOR_CLASSIFICATION_RULE_VERSION } from "./author-classification.mjs";
import { readMasterRoster } from './master-roster.mjs';
import { mergeRosterClassification } from './roster-classification.mjs';
import { accountCollectionCoverage, summarizeCollectionCoverage } from "./collection-coverage.mjs";
import { describeWorkPlays } from "./work-play-semantics.mjs";
import { canonicalAccountLocator } from "./author-spreadsheet.mjs";
import { validateAccountSnapshot } from "./account-snapshot-integrity.mjs";

const DAY_MS = 86_400_000;
const STALE_HOURS = 36;
const METRICS = { followers: "followers", likes: "total_likes", posts: "total_posts" };
const UNASSIGNED = "__unassigned__";
const INTERNAL_COMPARISON_SUMMARY = Symbol("internal-comparison-summary");
// A daily total is only safe to read as a matrix total when most enabled
// accounts contributed the same day.  Keep the observed value (and its exact
// count) for audit/export, but expose an explicit quality flag so the UI can
// avoid presenting a partial cohort as a real matrix-wide change.
const DAILY_COHORT_MIN_RATIO = 0.9;

function cohortQuality(observedCount, enabledCount, label = "观测") {
  const observed = Number(observedCount) || 0;
  const enabled = Number(enabledCount) || 0;
  const required = enabled ? Math.max(1, Math.ceil(enabled * DAILY_COHORT_MIN_RATIO)) : 0;
  const reliable = enabled > 0 && observed >= required;
  const coveragePercent = enabled ? observed / enabled * 100 : null;
  return {
    reliable,
    status: !observed ? "missing" : reliable ? "complete" : "partial",
    observedCount: observed,
    enabledCount: enabled,
    requiredCount: required,
    coveragePercent,
    reason: !observed ? `当日没有${label}数据`
      : reliable ? null : `仅 ${observed}/${enabled} 个启用账号有${label}数据，低于 ${Math.round(DAILY_COHORT_MIN_RATIO * 100)}% 完整覆盖`,
  };
}

function finiteCount(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function percent(delta, baseline) {
  return delta === null || baseline === null || baseline === 0 ? null : delta / baseline * 100;
}

function sumKnown(values) {
  const known = values.filter((value) => value !== null && Number.isFinite(value));
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
}

function cohortKey(ids) {
  if (!ids.length) return null;
  const sorted = [...new Set(ids)].sort((left, right) => left - right);
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

export function publicUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    if (!["douyin.com", "bilibili.com", "xiaohongshu.com", "xhslink.com", "feishu.cn", "larkoffice.com"]
      .some((domain) => host === domain || host.endsWith(`.${domain}`))) return null;
    // Never forward arbitrary imported query strings (tokens, auth codes, etc.).
    const allowed = new Set(["sheet", "modal_id", "aweme_id", "item_id"]);
    for (const key of [...url.searchParams.keys()]) if (!allowed.has(key)) url.searchParams.delete(key);
    url.hash = "";
    return url.toString();
  } catch { return null; }
}

function profileUrl(target, metadata, platform) {
  const locator = String(target.locator ?? "");
  if (platform === "douyin" && /^MS4wLj[\w-]{12,220}$/.test(locator)) return `https://www.douyin.com/user/${locator}`;
  if (platform === "bilibili" && /^\d{1,20}$/.test(locator)) return `https://space.bilibili.com/${locator}`;
  if (platform === "xiaohongshu" && /^[a-f\d]{24}$/i.test(locator)) return `https://www.xiaohongshu.com/user/profile/${locator}`;
  return publicUrl(metadata.resolution?.canonicalAccountUrl ?? metadata.profileUrl ?? locator);
}

function dates(reference, range = null, timeZone = null) {
  if (timeZone) {
    const endDate = businessDateKey(reference, timeZone);
    const firstDate = range?.startDate ?? shiftCalendarDate(endDate, -29);
    const days = Array.from({ length: range?.days ?? 30 }, (_, index) => shiftCalendarDate(firstDate, index));
    return { days, previousDay: shiftCalendarDate(firstDate, -1), historyStart: businessDateStartUtc(shiftCalendarDate(firstDate, -1), timeZone).toISOString() };
  }
  const days = [];
  const start = new Date(reference);
  start.setHours(0, 0, 0, 0);
  if (range) start.setTime(Date.parse(`${range.startDate}T00:00:00`));
  else start.setDate(start.getDate() - 29);
  for (let index = 0; index < (range?.days ?? 30); index += 1) {
    const day = new Date(start);
    day.setDate(day.getDate() + index);
    days.push(localDateKey(day));
  }
  const previous = new Date(start);
  previous.setDate(previous.getDate() - 1);
  return { days, previousDay: localDateKey(previous), historyStart: previous.toISOString() };
}

function previousDate(date, timeZone = null) {
  if (timeZone) return shiftCalendarDate(date, -1);
  const day = new Date(`${date}T12:00:00`);
  day.setDate(day.getDate() - 1);
  return localDateKey(day);
}

function metricInsight(samples, field, bounds, period, reference, timeZone = null) {
  const dayKey = (value) => timeZone ? businessDateKey(value, timeZone) : localDateKey(new Date(value));
  const valid = samples.filter((sample) => sample.quality_status !== "rejected" && finiteCount(sample[field]) !== null);
  const latest = valid.at(-1);
  const inPeriod = valid.filter((sample) => sample.captured_at >= bounds.start);
  const current = inPeriod.at(-1);
  const before = valid.filter((sample) => sample.captured_at < bounds.start).at(-1);
  const first = inPeriod[0];
  const baseline = before ?? (first && current && first.captured_at < current.captured_at ? first : null);
  const endpointsPresent = Boolean(before && current
    && dayKey(before.captured_at) === previousDate(dayKey(bounds.start), timeZone)
    && dayKey(current.captured_at) === dayKey(bounds.end));
  // Every advertised period uses the same endpoint contract. Earlier or
  // first-in-period samples can explain an observed window, never fill a
  // missing calendar boundary for day/week/month growth.
  const comparable = endpointsPresent;
  const windowComparable = Boolean(current && baseline && baseline.captured_at < current.captured_at);
  const value = finiteCount(latest?.[field]);
  const staleHours = latest ? Math.max(0, (reference.getTime() - Date.parse(latest.captured_at)) / 3_600_000) : null;
  const baselineValue = finiteCount(baseline?.[field]);
  const delta = comparable ? finiteCount(current[field]) - baselineValue : null;
  const baselineMode = baseline ? before ? "period-start" : "first-in-period" : null;
  const dailyComparable = comparable && period === "day" && baselineMode === "period-start"
    && dayKey(baseline.captured_at) === previousDate(dayKey(current.captured_at), timeZone);
  const reason = !latest ? "尚无该指标的有效采样"
    : !current ? "所选周期内没有该指标的新采样；当前值沿用此前有效记录"
      : !endpointsPresent ? "缺少开始日前一日基准或结束日观测；跨缺采日期或区间内首次采样不能替代完整区间端点" : null;
  const observedWindow = !comparable && windowComparable ? {
    delta: finiteCount(current[field]) - baselineValue,
    percent: percent(finiteCount(current[field]) - baselineValue, baselineValue),
    baseline: baselineValue, value: finiteCount(current[field]),
    startAt: baseline.captured_at, endAt: current.captured_at,
    baselineMode, comparisonLabel: "已观察时段变化",
    fullPeriodComparable: false,
    reason: "仅表示这两个实际采样时刻间的净变化，不代表所选完整区间或逐日增长",
  } : null;
  return {
    value, currentAt: latest?.captured_at ?? null,
    // `value` intentionally retains the last trusted metric for account
    // detail continuity. Matrix totals must not count that carried value as
    // an observation for a date/range with no sample.
    observedInPeriod: Boolean(current),
    observedOnEndDate: Boolean(latest && dayKey(latest.captured_at) === dayKey(bounds.end)),
    knownValue: value,
    stale: staleHours !== null && staleHours > STALE_HOURS, staleHours,
    currentChecksum: latest?.source_checksum ?? null,
    comparisonCurrentAt: current?.captured_at ?? null,
    baseline: baselineValue, baselineAt: baseline?.captured_at ?? null,
    baselineChecksum: baseline?.source_checksum ?? null,
    delta, percent: percent(delta, baselineValue), comparable, baselineMode, dailyComparable,
    fullPeriodComparable: comparable, observedWindow,
    comparisonLabel: !comparable ? "暂无完整区间可比数据" : dailyComparable ? "较前一日采样变化" : "完整区间净变化",
    reason, percentReason: delta === null ? "缺少可比数据" : baselineValue === 0 ? "基准为 0，百分比无定义" : null,
  };
}

function accountTrend(samples, timeline, timeZone = null) {
  const byDay = new Map();
  for (const sample of samples) {
    if (sample.quality_status === "rejected") continue;
    const key = timeZone ? businessDateKey(sample.captured_at, timeZone) : localDateKey(new Date(sample.captured_at));
    if (key < timeline.previousDay) continue;
    if (!byDay.has(key)) byDay.set(key, { sampleCount: 0 });
    const point = byDay.get(key);
    point.sampleCount += 1;
    for (const [metric, field] of Object.entries(METRICS)) {
      if (finiteCount(sample[field]) === null) continue;
      point[metric] = Number(sample[field]);
      point[`${metric}At`] = sample.captured_at;
    }
  }
  return timeline.days.map((date) => {
    const current = byDay.get(date) ?? {};
    const baseline = byDay.get(previousDate(date, timeZone)) ?? {};
    const point = { date, sampleCount: current.sampleCount ?? 0 };
    for (const metric of Object.keys(METRICS)) {
      point[metric] = current[metric] ?? null;
      point[`${metric}At`] = current[`${metric}At`] ?? null;
      point[`${metric}Delta`] = current[metric] === undefined || baseline[metric] === undefined
        ? null : current[metric] - baseline[metric];
    }
    point.estimatedPlaysDelta = point.likesDelta === null ? null : point.likesDelta * 100;
    point.estimatedPlays = point.likes === null ? null : point.likes * 100;
    point.estimatedPlaysAt = point.likesAt;
    point.estimatedPlaysProxy = true;
    point.missing = Object.keys(METRICS).every((metric) => point[metric] === null);
    point.reason = point.missing ? "当日没有有效观测，未补零或沿用前值" : null;
    return point;
  });
}

function statusInsight(target, samples, latestAudit, strictIdentity, reference, lifecycle, validSamples = samples) {
  const latest = samples.at(-1);
  const validIds = new Set(validSamples.map(sample => Number(sample.id)));
  const success = validSamples.filter((sample) => sample.quality_status !== "rejected"
    && Object.values(METRICS).some((field) => finiteCount(sample[field]) !== null)).at(-1);
  const sourceExcludedCount = samples.filter(sample => sample.quality_status !== "rejected"
    && Object.values(METRICS).some(field => finiteCount(sample[field]) !== null)
    && !validIds.has(Number(sample.id))).length;
  const provenanceWarning = latest && latest.quality_status !== "rejected"
    && Object.values(METRICS).some(field => finiteCount(latest[field]) !== null)
    && !validIds.has(Number(latest.id))
    ? "存在来源或指标未通过校验的已保存快照；未纳入平台趋势、增长与覆盖统计" : null;
  const lastSuccessAt = success?.captured_at ?? null;
  const staleHours = lastSuccessAt ? Math.max(0, (reference.getTime() - Date.parse(lastSuccessAt)) / 3_600_000) : null;
  const stale = staleHours !== null && staleHours > STALE_HOURS;
  const attempt = target.last_checked_at && Date.parse(target.last_checked_at) <= reference.getTime()
    ? target.last_checked_at : latestAudit?.created_at ?? latest?.captured_at ?? null;
  const error = strictIdentity?.last_error || (latestAudit?.status === "error" ? latestAudit.message : null)
    || (attempt === target.last_checked_at ? target.last_error : null) || latest?.account_error || latest?.works_error || provenanceWarning || null;
  const warnings = safeJson(latest?.warnings_json, []);
  const accountStatus = latest?.account_status ?? "unknown";
  const worksCoverage = latest?.works_coverage ?? "unknown";
  const review = reviewState(latest?.quality_status ?? "pending", Array.isArray(warnings) ? warnings : [], { accountStatus, worksCoverage });
  const key = lifecycle?.state === "deleted" ? "deleted" : strictIdentity ? "identity-review" : !target.enabled ? "paused"
    : !success ? error ? "retry" : "pending" : error ? "retry" : stale ? "stale" : "updated";
  const labels = { deleted: "官方主页显示已注销", "identity-review": "身份仍需核对", paused: "已暂停监控", retry: "更新待重试", pending: "待首次采样", stale: "数据已过期", updated: "资料已更新" };
  return {
    key, label: labels[key], enabled: Boolean(target.enabled),
    lastAttemptAt: attempt, lastSuccessAt, stale, staleHours, staleAfterHours: STALE_HOURS,
    accountStatus, worksCoverage, reviewState: review, error,
    provenanceWarning, sourceExcludedCount,
    warnings: [...(Array.isArray(warnings) ? warnings.filter((item) => typeof item === "string") : []),
      ...(provenanceWarning ? [provenanceWarning] : [])],
  };
}

function sourcesFor(metadata, memberships) {
  const sources = [metadata.importSource, metadata.sourceMetadata, ...memberships.map((member) => ({
    type: member.source_type, fileName: member.source_file_name,
    sheetName: member.source_sheet_name, sourceRow: member.source_row,
  }))].filter((source) => source && typeof source === "object");
  const seen = new Set();
  return sources.map((source) => ({
    type: String(source.type ?? ""), fileName: String(source.fileName ?? ""),
    sheetName: String(source.sheetName ?? ""), row: finiteCount(source.sourceRow),
    url: publicUrl(source.sourceUrl ?? source.url),
  })).filter((source) => {
    const key = JSON.stringify(source);
    if (seen.has(key) || !source.fileName && !source.url && !source.type) return false;
    seen.add(key);
    return true;
  });
}

function summarizeClassificationSources(accounts = []) {
  const counts = new Map();
  const ensure = (source = {}) => {
    const type = String(source.type ?? "").trim();
    const fileName = String(source.fileName ?? "").trim();
    const sheetName = String(source.sheetName ?? "").trim();
    const key = `${fileName}\u0000${sheetName}`;
    if (!fileName && !sheetName && !type) return null;
    if (!counts.has(key)) counts.set(key, {
      type, fileName, sheetName, accounts: new Set(), rows: 0, explicitCategories: 0, urls: new Set(),
    });
    const item = counts.get(key);
    if (!item.type && type) item.type = type;
    return item;
  };
  for (const account of accounts) {
    for (const board of account.boards ?? []) {
      const source = board.source ?? {};
      const item = ensure(source);
      if (!item) continue;
      item.accounts.add(account.id);
      if (board.source?.sourceRow != null) item.rows += 1;
      if (String(board.category ?? "").trim() || String(board.tier ?? "").trim()) item.explicitCategories += 1;
    }
    for (const source of account.sources ?? []) {
      const item = ensure(source);
      if (!item) continue;
      item.accounts.add(account.id);
      const url = String(source?.url ?? "").trim();
      if (url) item.urls.add(url);
    }
  }
  return [...counts.values()]
    .map((item) => ({ ...item, accounts: item.accounts.size, urls: [...item.urls].slice(0, 3) }))
    .sort((left, right) => right.accounts - left.accounts || left.fileName.localeCompare(right.fileName, "zh-CN"));
}

function proxyMetric(likes) {
  const scale = (value) => value === null || value === undefined ? null : value * 100;
  return {
    ...likes, value: likes.value === null ? null : likes.value * 100,
    baseline: likes.baseline === null ? null : likes.baseline * 100,
    delta: likes.delta === null ? null : likes.delta * 100,
    knownValue: scale(likes.knownValue),
    endObservedValue: scale(likes.endObservedValue),
    terminalRetainedValue: scale(likes.terminalRetainedValue),
    observedWindow: likes.observedWindow ? { ...likes.observedWindow,
      delta: scale(likes.observedWindow.delta), baseline: scale(likes.observedWindow.baseline),
      value: scale(likes.observedWindow.value), proxy: true } : null,
    proxy: true, formula: "累计点赞 × 100；变化 = 点赞净变化 × 100",
    valueMeaning: "累计点赞换算出的代理值，不是区间新增播放，也不是平台真实播放量",
    deltaMeaning: "仅对同一批可比账号的点赞净变化换算；可比覆盖不足时不得外推至整个矩阵",
    sourceMetric: "likes", multiplier: 100,
    reason: [likes.reason, "估算播放并非平台真实播放量"].filter(Boolean).join("；"),
  };
}

function aggregateMetric(accounts, name) {
  const observations = accounts.map((account) => account.metrics[name]);
  const comparable = observations.filter((metric) => metric.comparable);
  // A verified deletion is a real terminal observation: retain its last
  // trusted metric in the enabled matrix total even when the selected period
  // has no new sample. Active accounts, by contrast, must not carry a stale
  // value into a missing historical day.
  const periodObserved = accounts
    .filter((account) => account.metrics[name].observedOnEndDate || account.status?.key === "deleted")
    .map((account) => account.metrics[name])
    .filter((metric) => metric.value !== null);
  const observedCount = periodObserved.length;
  const value = sumKnown(periodObserved.map((metric) => metric.value));
  const known = observations.filter((metric) => metric.value !== null);
  const endObserved = observations.filter((metric) => metric.observedOnEndDate && metric.value !== null);
  const terminalRetained = accounts.filter((account) => account.status?.key === "deleted"
    && !account.metrics[name].observedOnEndDate && account.metrics[name].value !== null);
  const delta = sumKnown(comparable.map((metric) => metric.delta));
  const baseline = sumKnown(comparable.map((metric) => metric.baseline));
  const observedTimes = observations.map((metric) => metric.currentAt).filter(Boolean).sort();
  const quality = cohortQuality(observedCount, accounts.length, name === "posts" ? "作品数" : name === "likes" ? "累计点赞" : "粉丝数");
  const comparableQuality = cohortQuality(comparable.length, accounts.length, `${name === "posts" ? "作品数" : name === "likes" ? "累计点赞" : "粉丝数"}变化`);
  return {
    value, delta, baseline, percent: percent(delta, baseline), observedCount,
    knownValue: sumKnown(known.map((metric) => metric.value)), knownCount: known.length,
    knownCohortKey: cohortKey(accounts.filter((account) => account.metrics[name].value !== null).map((account) => account.id)),
    valueCohortKey: cohortKey(accounts.filter((account) => account.metrics[name].value !== null
      && (account.metrics[name].observedOnEndDate || account.status?.key === "deleted")).map((account) => account.id)),
    deltaCohortKey: cohortKey(accounts.filter((account) => account.metrics[name].comparable).map((account) => account.id)),
    carriedCount: known.length - endObserved.length,
    endObservedValue: sumKnown(endObserved.map((metric) => metric.value)), endObservedCount: endObserved.length,
    terminalRetainedValue: sumKnown(terminalRetained.map((account) => account.metrics[name].value)),
    terminalRetainedCount: terminalRetained.length,
    valueMeaning: "结束日有效观测与已注销账号最后可信历史值；非该日新采的存续账号仅计入 knownValue",
    knownValueMeaning: "截至区间结束的最后已知合计，包含历史沿用值，不代表全部账号在同一时刻的真实总量",
    observedWindowCount: observations.filter((metric) => metric.observedWindow).length,
    oldestObservedAt: observedTimes[0] ?? null, latestObservedAt: observedTimes.at(-1) ?? null,
    staleCount: observations.filter((metric) => metric.stale).length,
    missingCount: accounts.length - observedCount, comparableCount: comparable.length,
    comparisonMissingCount: accounts.length - comparable.length,
    coveragePercent: accounts.length ? comparable.length / accounts.length * 100 : null,
    valueQuality: quality,
    deltaQuality: comparableQuality,
    // `value` is still returned for backward-compatible exports. Consumers
    // must use valueQuality.reliable before describing it as a matrix total.
    reliable: quality.reliable,
    deltaReliable: comparableQuality.reliable,
    gainedCount: comparable.filter((metric) => metric.delta > 0).length,
    lostCount: comparable.filter((metric) => metric.delta < 0).length,
    flatCount: comparable.filter((metric) => metric.delta === 0).length,
    dailyComparableCount: comparable.filter((metric) => metric.dailyComparable).length,
    fullPeriodComparableCount: comparable.filter((metric) => metric.fullPeriodComparable).length,
    firstInPeriodCount: observations.filter((metric) => metric.observedWindow?.baselineMode === "first-in-period").length,
    reason: !accounts.length ? "当前没有启用的监控账号" : !observedCount ? "暂无有效观测"
      : observedCount < accounts.length ? "合计仅包含已有有效数据的启用账号" : null,
    comparisonReason: !comparable.length ? "暂无可比账号，增长不记为 0"
      : comparable.length < accounts.length ? "增长仅统计可比账号，不代表全部成员增长" : null,
    percentReason: delta === null ? "缺少可比数据" : baseline === 0 ? "可比账号基准合计为 0，百分比无定义" : null,
  };
}

// A separate, common pair of observed calendar dates. Never aggregate the
// per-account observedWindow values: their endpoints can differ. The strict
// requested-period metrics above remain untouched, including missing values.
function recordedWindow(accounts, snapshots, header, reference, timeZone) {
  const enabled = accounts.filter(account => account.enabled);
  if (!enabled.length || header.range.startDate === header.range.endDate) return null;
  const strict = Object.keys(METRICS).map(name => aggregateMetric(enabled, name));
  if (strict.every(metric => metric.deltaReliable)) return null;
  const floor = previousDate(header.range.startDate, timeZone);
  const dayKey = value => timeZone ? businessDateKey(value, timeZone) : localDateKey(new Date(value));
  const ids = new Set(enabled.map(account => account.id));
  const byDay = new Map();
  for (const sample of snapshots) {
    if (!ids.has(sample.target_id) || sample.quality_status === "rejected") continue;
    const date = dayKey(sample.captured_at);
    if (date < floor || date > header.range.endDate) continue;
    if (!byDay.has(date)) byDay.set(date, new Map());
    const day = byDay.get(date);
    if (!day.has(sample.target_id)) day.set(sample.target_id, {});
    const entry = day.get(sample.target_id);
    for (const [name, field] of Object.entries(METRICS)) {
      if (finiteCount(sample[field]) !== null) entry[name] = sample;
    }
  }
  const complete = entry => entry && Object.keys(METRICS).every(name => entry[name]);
  const days = [...byDay.keys()].sort();
  const required = Math.ceil(enabled.length * DAILY_COHORT_MIN_RATIO);
  let pair = null;
  // Latest usable end, then earliest baseline with a sufficiently covered
  // shared cohort. Low-coverage dates remain in the daily chart as gaps.
  for (const endDate of [...days].reverse()) {
    if (endDate < header.range.startDate) continue;
    const end = byDay.get(endDate);
    for (const baselineDate of days) {
      if (baselineDate >= endDate) break;
      const baseline = byDay.get(baselineDate);
      const pairedIds = enabled.filter(account => complete(baseline.get(account.id)) && complete(end.get(account.id))).map(account => account.id);
      if (pairedIds.length >= required) { pair = { baselineDate, endDate, pairedIds }; break; }
    }
    if (pair) break;
  }
  if (!pair) return null;
  const range = customRange(shiftCalendarDate(pair.baselineDate, 1), pair.endDate, reference, timeZone);
  const pairedIds = new Set(pair.pairedIds);
  const members = accounts.map(account => {
    const metrics = Object.fromEntries(Object.entries(METRICS).map(([name, field]) => {
      const samples = pairedIds.has(account.id)
        ? [byDay.get(pair.baselineDate).get(account.id)[name], byDay.get(pair.endDate).get(account.id)[name]]
        : [];
      return [name, metricInsight(samples, field, range, "custom", reference, timeZone)];
    }));
    metrics.estimatedPlays = proxyMetric(metrics.likes);
    return { ...account, metrics };
  });
  const windowEnabled = members.filter(account => account.enabled);
  const aggregate = subset => {
    const metrics = Object.fromEntries(Object.keys(METRICS).map(name => [name, aggregateMetric(subset, name)]));
    metrics.estimatedPlays = proxyMetric(metrics.likes);
    return metrics;
  };
  const keys = [...new Set(members.flatMap(account => account.boards.map(board => board.key)))];
  return {
    baselineDate: pair.baselineDate, endDate: pair.endDate, range,
    enabledCount: enabled.length, comparableCount: pairedIds.size,
    metrics: aggregate(windowEnabled),
    accounts: members.map(account => ({ id: account.id, metrics: account.metrics })),
    boards: [...keys, UNASSIGNED].map(key => ({ key, metrics: aggregate(windowEnabled.filter(account =>
      key === UNASSIGNED ? !account.boards.length : account.boards.some(board => board.key === key))) })),
    reason: "同一批账号在这两个日期末次有效采样间的净变化；不是所选完整区间增长，不补造月初基准或缺采日数据",
  };
}

function publishedSamplesInsight(value, bounds, includesVerifiedLateObservation = false) {
  return {
    value, scope: "observed-public-posts", basis: "published_at",
    asOf: bounds.end, asOfBasis: includesVerifiedLateObservation ? "first_seen_at_or_verified_observation_at" : "first_seen_at",
    reason: includesVerifiedLateObservation
      ? "按发布时间统计；包含较晚入库但原来源、身份、指标向量与区间内实际观察时刻完全绑定的作品；未改写入库时间，不代表全部发布量，缺采不等于没有发布"
      : "截至区间结束已收录，按发布时间统计；区间结束后才发现的旧作品不计入，不代表全部发布量；缺采不等于没有发布",
  };
}

function aggregateAccounts(members, timeline, bounds) {
  const enabled = members.filter((account) => account.enabled);
  const metrics = Object.fromEntries(Object.keys(METRICS).map((name) => [name, aggregateMetric(enabled, name)]));
  metrics.estimatedPlays = proxyMetric(metrics.likes);
  const trend = timeline.days.map((date, index) => {
    const points = enabled.map((account) => account.trend[index]);
    const point = { date, memberCount: enabled.length };
    for (const metric of Object.keys(METRICS)) {
      point[metric] = sumKnown(points.map((item) => item[metric]));
      point[`${metric}Delta`] = sumKnown(points.map((item) => item[`${metric}Delta`]));
      const observedCount = points.filter((item) => item[metric] !== null).length;
      const comparableCount = points.filter((item) => item[`${metric}Delta`] !== null).length;
      point[`${metric}ObservedCount`] = observedCount;
      point[`${metric}ComparableCount`] = comparableCount;
      const valueQuality = cohortQuality(observedCount, enabled.length, metric === "posts" ? "作品数" : metric === "likes" ? "累计点赞" : "粉丝数");
      const deltaQuality = cohortQuality(comparableCount, enabled.length, `${metric === "posts" ? "作品数" : metric === "likes" ? "累计点赞" : "粉丝数"}变化`);
      point[`${metric}Quality`] = valueQuality.status;
      point[`${metric}QualityReason`] = valueQuality.reason;
      point[`${metric}Reliable`] = valueQuality.reliable;
      point[`${metric}CoveragePercent`] = valueQuality.coveragePercent;
      point[`${metric}DeltaQuality`] = deltaQuality.status;
      point[`${metric}DeltaQualityReason`] = deltaQuality.reason;
      point[`${metric}DeltaReliable`] = deltaQuality.reliable;
      point[`${metric}DeltaCoveragePercent`] = deltaQuality.coveragePercent;
      point[`${metric}CohortKey`] = cohortKey(enabled.filter((account) => account.trend[index][metric] !== null).map((account) => account.id));
      point[`${metric}DeltaCohortKey`] = cohortKey(enabled.filter((account) => account.trend[index][`${metric}Delta`] !== null).map((account) => account.id));
    }
    point.estimatedPlaysDelta = point.likesDelta === null ? null : point.likesDelta * 100;
    point.estimatedPlays = point.likes === null ? null : point.likes * 100;
    point.estimatedPlaysObservedCount = point.likesObservedCount;
    point.estimatedPlaysComparableCount = point.likesComparableCount;
    point.estimatedPlaysQuality = point.likesQuality;
    point.estimatedPlaysQualityReason = point.likesQualityReason;
    point.estimatedPlaysReliable = point.likesReliable;
    point.estimatedPlaysCoveragePercent = point.likesCoveragePercent;
    point.estimatedPlaysDeltaQuality = point.likesDeltaQuality;
    point.estimatedPlaysDeltaQualityReason = point.likesDeltaQualityReason;
    point.estimatedPlaysDeltaReliable = point.likesDeltaReliable;
    point.estimatedPlaysDeltaCoveragePercent = point.likesDeltaCoveragePercent;
    point.estimatedPlaysCohortKey = point.likesCohortKey;
    point.estimatedPlaysDeltaCohortKey = point.likesDeltaCohortKey;
    point.estimatedPlaysProxy = true;
    point.publishedSamples = points.reduce((sum, item) => sum + item.publishedSamples, 0);
    point.observedCount = points.filter((item) => !item.missing).length;
    point.missing = Object.keys(METRICS).every((metric) => point[metric] === null);
    point.partial = Object.keys(METRICS).some((metric) => point[`${metric}ObservedCount`] < enabled.length);
    point.reason = point.missing ? "当日没有有效观测" : point.partial
      ? "当日合计仅含已观测账号；成员覆盖可变，合计折线之差不是每日增长" : null;
    return point;
  });
  return {
    memberCount: members.length, accountCount: members.length, enabledCount: enabled.length, pausedCount: members.length - enabled.length,
    metrics, trend,
    publishedSamples: publishedSamplesInsight(enabled.reduce((sum, account) => sum + account.publishedSamples.value, 0), bounds,
      enabled.some(account => account.publishedSamples.asOfBasis === "first_seen_at_or_verified_observation_at")),
    worksObservation: aggregateWorksObservations(members, bounds.end),
    collectionCoverage: summarizeCollectionCoverage(members, timeline.days.at(-1)),
    updatedCount: enabled.filter((account) => account.status.key === "updated").length,
    staleCount: enabled.filter((account) => account.status.stale && account.lifecycle?.state !== "deleted").length,
    inactiveCount: enabled.filter((account) => account.lifecycle?.state === "deleted").length,
    pendingCount: enabled.filter((account) => account.status.lastSuccessAt === null).length,
    waitingForFirstSnapshotCount: enabled.filter((account) => account.status.lastSuccessAt === null).length,
  };
}

// posts contains the latest metadata, while post_metrics retains dated values.
// Recover changed metadata only from a stored source bound to the selected
// metric observation. Without that evidence the historical fields are unknown.
function historyObservationTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
    || shiftCalendarDate(value.slice(0, 10), 0) !== value.slice(0, 10)) return NaN;
  return Date.parse(value);
}

export function postsAsOf(database, rows, asOf, targets, { forceRecovery = false, snapshotMaxId = null } = {}) {
  return postsAsOfInRead(database, rows, asOf, targets, { forceRecovery, snapshotMaxId },
    (targetId, options) => loadVerifiedWorksOnlyRows(database.db, asOf, targetId, options));
}

function postsAsOfInRead(database, rows, asOf, targets, { forceRecovery = false, snapshotMaxId = null } = {}, loadVerified) {
  const cutoff = Date.parse(asOf);
  const lateKnown = row => Date.parse(row.first_seen_at) > cutoff;
  const changed = rows.filter(row => forceRecovery || lateKnown(row) || Date.parse(row.last_seen_at) > cutoff);
  if (!changed.length) return rows;
  const db = database.db, recovered = new Map();
  const targetsById = new Map(targets.map(target => [Number(target.id), target]));
  const wanted = new Map(changed.map(row => [`${row.target_id}:${row.external_id}:${Date.parse(row.metric_at)}`, row]));
  const times = new Map();
  for (const row of changed) {
    if (!Number.isFinite(Date.parse(row.metric_at))) continue;
    const metricAt = new Date(row.metric_at).toISOString();
    times.set(`${row.target_id}:${metricAt}`, { targetId: Number(row.target_id), metricAt });
  }
  const wantedTimes = JSON.stringify([...times.values()]);
  const metrics = ['likes', 'comments', 'shares', 'collects', 'plays'];
  const identityCache = new Map();
  const canonicalIdentity = (value, platform) => {
    const key = `${platform}:${String(value ?? '')}`;
    if (!identityCache.has(key)) identityCache.set(key, canonicalAccountLocator(value, platform));
    return identityCache.get(key);
  };
  const accept = (targetId, posts, timeFor, profile) => {
    const target = targetsById.get(Number(targetId));
    if (!target) return;
    const platform = safeJson(target.metadata_json, {})?.platform ?? 'douyin';
    if (!['douyin', 'bilibili', 'xiaohongshu'].includes(platform)) return;
    const identity = canonicalIdentity(target.locator, platform);
    const profileId = platform === 'douyin' ? profile?.sec_uid : profile?.uid ?? profile?.mid ?? profile?.user_id;
    if (!identity || canonicalIdentity(profileId, platform) !== identity
      || (platform === 'douyin' && !/^[1-9]\d{1,24}$/.test(String(profile.uid ?? '')))) return;
    for (const post of posts) {
      const observedAt = Date.parse(timeFor(post));
      const row = wanted.get(`${targetId}:${post.externalId}:${observedAt}`);
      if (!row || recovered.has(row.id) || !Number.isFinite(observedAt)
        || observedAt !== Date.parse(row.metric_at) || observedAt > Date.parse(asOf)
        || canonicalIdentity(row.author_id, platform) !== identity
        || canonicalIdentity(post.authorId, platform) !== identity
        || (platform === 'douyin' && String(post.raw?.author?.uid ?? '') !== String(profile.uid))
        || metrics.some(field => (row[field] ?? null) !== (post[field] ?? null))
        || (post.publishedAt && Date.parse(post.publishedAt) > observedAt)) continue;
      recovered.set(row.id, { caption: post.caption || null, url: post.url || null,
        published_at: post.publishedAt || null });
    }
  };
  // Project only snapshots capable of binding the requested metric instants.
  // Browser pages can occur after their profile capture, so their stored final
  // page time bounds candidates; browserWorksObservation binds each exact page.
  const hasWorksTime = db.prepare('PRAGMA table_info(snapshots)').all().some(column => column.name === 'works_observed_at');
  const browserTime = hasWorksTime ? `OR (s.works_observed_at IS NOT NULL
      AND julianday(s.captured_at)<=julianday(w.metric_at) AND julianday(s.works_observed_at)>=julianday(w.metric_at))` : '';
  const snapshots = db.prepare(`WITH wanted AS (
    SELECT json_extract(value,'$.targetId') target_id,json_extract(value,'$.metricAt') metric_at FROM json_each(?)
  ) SELECT DISTINCT s.id,s.target_id,s.captured_at,s.source_checksum,s.raw_json FROM wanted w
    JOIN snapshots s ON s.target_id=w.target_id
      AND (julianday(s.captured_at)=julianday(w.metric_at) ${browserTime})
    WHERE s.quality_status IN ('validated','warning') AND julianday(s.captured_at)<=julianday(?)
      ${snapshotMaxId === null ? '' : 'AND s.id<=?'}
    ORDER BY julianday(s.captured_at) DESC,s.id DESC`).all(wantedTimes, asOf, ...(snapshotMaxId === null ? [] : [snapshotMaxId]));
  for (const row of snapshots) {
    try {
      const raw = JSON.parse(row.raw_json), target = targetsById.get(Number(row.target_id));
      if (!target || checksum(raw) !== row.source_checksum || !Number.isFinite(historyObservationTime(raw.capturedAt))
        || historyObservationTime(raw.capturedAt) !== historyObservationTime(row.captured_at)) continue;
      const observation = browserWorksObservation(raw, { reference: Date.parse(asOf) });
      if (raw.works?.pagination?.version === 1 && !observation) continue;
      accept(row.target_id, normalizeCollection(target, raw, { capturedAt: row.captured_at }).posts,
        post => observation?.postTimes.get(post.externalId) ?? row.captured_at, raw.profile?.user);
    } catch { /* Missing or malformed historical evidence stays unknown. */ }
  }
  // Freshness reads deliberately select two accepted windows. Metadata needs
  // the actual historical run for each remaining metric instant instead.
  const unresolved = new Set(changed.filter(row => !recovered.has(row.id) && Number.isFinite(Date.parse(row.metric_at)))
    .map(row => `${row.target_id}:${new Date(row.metric_at).toISOString()}`));
  const unresolvedTimes = JSON.stringify([...times.entries()].filter(([key]) => unresolved.has(key)).map(([, time]) => time));
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='works_observations'").get()
    && db.prepare('PRAGMA table_info(works_observations)').all().some(column => column.name === 'run_id')) {
    const runIds = db.prepare(`WITH wanted AS (
      SELECT json_extract(value,'$.targetId') target_id,json_extract(value,'$.metricAt') metric_at FROM json_each(?)
    ) SELECT DISTINCT w.run_id FROM wanted m JOIN works_observations w ON w.target_id=m.target_id
      AND julianday(w.request_started_at)<=julianday(m.metric_at) AND julianday(w.observed_at)>=julianday(m.metric_at)
      WHERE w.status='accepted' AND julianday(w.request_finished_at)<=julianday(?) AND w.run_id IS NOT NULL
        ${snapshotMaxId === null ? '' : 'AND w.anchor_snapshot_id<=?'}`)
      .all(unresolvedTimes, asOf, ...(snapshotMaxId === null ? [] : [snapshotMaxId])).map(row => Number(row.run_id));
    for (const row of loadVerified(null, { runIds })) {
      if (row.status !== 'accepted') continue;
      let offset = 0;
      for (const page of row.raw.pagination.pages) {
        accept(row.target_id, row.raw.posts.slice(offset, offset + page.acceptedCount).map(post => normalizePost(post)),
          () => page.observedAt, { sec_uid: row.raw.identity.secUid, uid: row.raw.identity.uid });
        offset += page.acceptedCount;
      }
    }
  }
  // A dated metric alone is not evidence that a work was observed before its
  // later insertion. Only exact source/identity/time/vector recovery admits it;
  // missing metadata on already-known legacy works retains the old semantics.
  return rows.flatMap(row => {
    if (lateKnown(row) && !recovered.has(row.id)) return [];
    return [forceRecovery || lateKnown(row) || Date.parse(row.last_seen_at) > cutoff
      ? { ...row, ...(recovered.get(row.id) ?? { caption: null, url: null, published_at: null }) }
      : row];
  });
}

function loadData(database, bounds, timeline, targetId = null) {
  return withWorksObservationRead(database, bounds.end, read =>
    loadDataInRead(database, bounds, timeline, targetId, read));
}

function loadDataInRead(database, bounds, timeline, targetId, read) {
  const db = database.db;
  // Historical metrics must not pull accounts into an earlier cohort merely
  // because the target exists now. The target's creation timestamp is the
  // strongest persisted evidence available for when it entered the system.
  const targetClause = targetId === null
    ? "t.type='account' AND julianday(t.created_at)<=julianday(?)"
    : "t.type='account' AND t.id=? AND julianday(t.created_at)<=julianday(?)";
  const targetArgs = targetId === null ? [bounds.end] : [targetId, bounds.end];
  const targetRows = db.prepare(`SELECT t.*,${targetEnabledAtSql("t", bounds.end)} AS enabled_asof
    FROM targets t WHERE ${targetClause} ORDER BY t.id`).all(...targetArgs);
  const targets = targetRows.map(({ enabled_asof, ...target }) => ({
    ...target,
    enabled: Number(enabled_asof) === 1 ? 1 : 0,
  }));
  const memberships = db.prepare(`SELECT tb.* FROM target_boards tb JOIN targets t ON t.id=tb.target_id
    WHERE ${targetClause} AND julianday(tb.created_at)<=julianday(?) ORDER BY tb.board_name COLLATE NOCASE`)
    .all(...targetArgs, bounds.end);
  const floor = bounds.start < timeline.historyStart ? bounds.start : timeline.historyStart;
  // Rank a narrow metric-only candidate set first. The old baselines still
  // include the latest row and each metric's latest valid row, but large raw
  // source JSON is fetched only after those exact candidate IDs are known.
  const snapshotQuery = db.prepare(`
    WITH candidates AS (
      SELECT s.id,s.target_id,strftime('%Y-%m-%dT%H:%M:%fZ',s.captured_at) AS captured_at,s.followers,s.total_likes,s.total_posts,
        s.quality_status
      FROM snapshots s JOIN targets t ON t.id=s.target_id
      WHERE ${targetClause} AND julianday(s.captured_at)<=julianday(?)
    ), older AS (
      SELECT id,target_id,captured_at,followers,total_likes,total_posts,quality_status,
        ROW_NUMBER() OVER (PARTITION BY target_id ORDER BY captured_at DESC,id DESC) AS latest_rank,
        ROW_NUMBER() OVER (PARTITION BY target_id ORDER BY CASE WHEN quality_status!='rejected' AND typeof(followers) IN ('integer','real') AND followers>=0 THEN 0 ELSE 1 END,captured_at DESC,id DESC) AS followers_rank,
        ROW_NUMBER() OVER (PARTITION BY target_id ORDER BY CASE WHEN quality_status!='rejected' AND typeof(total_likes) IN ('integer','real') AND total_likes>=0 THEN 0 ELSE 1 END,captured_at DESC,id DESC) AS likes_rank,
        ROW_NUMBER() OVER (PARTITION BY target_id ORDER BY CASE WHEN quality_status!='rejected' AND typeof(total_posts) IN ('integer','real') AND total_posts>=0 THEN 0 ELSE 1 END,captured_at DESC,id DESC) AS posts_rank
      FROM candidates WHERE captured_at<?
    ), selected AS (
      SELECT id FROM candidates WHERE captured_at>=?
      UNION
      SELECT id FROM older WHERE latest_rank=1 OR followers_rank=1 OR likes_rank=1 OR posts_rank=1
    )
    SELECT s.id,s.target_id,strftime('%Y-%m-%dT%H:%M:%fZ',s.captured_at) AS captured_at,
      s.followers,s.total_likes,s.total_posts,s.quality_status,s.account_status,s.works_coverage,
      s.account_error,s.works_error,s.warnings_json,s.source_checksum,s.raw_json,
      CASE WHEN json_valid(s.raw_json) THEN json_extract(s.raw_json,'$.profile.user.unique_id') END AS observed_public_id
    FROM selected pick JOIN snapshots s ON s.id=pick.id
    ORDER BY captured_at,s.id
  `);
  const targetById = new Map(targets.map(target => [Number(target.id), target]));
  const snapshots = [], metricSnapshots = [];
  // The bounded SQL candidate set includes only the selected reporting window
  // plus each account's latest pre-window baselines. Validate its source while
  // iterating so raw responses are never accumulated with the light read model.
  for (const row of snapshotQuery.iterate(...targetArgs, bounds.end, floor, floor)) {
    const { raw_json: rawJson, ...snapshot } = row;
    snapshots.push(snapshot);
    const target = targetById.get(Number(row.target_id));
    if (!target) continue;
    const platform = safeJson(target.metadata_json, {})?.platform ?? "douyin";
    if (validateAccountSnapshot({ ...row, raw_json: rawJson }, target, platform, { metricsOnly: true }).valid) {
      metricSnapshots.push(snapshot);
    }
  }
  const audits = db.prepare(`WITH ranked AS (
    SELECT a.target_id,strftime('%Y-%m-%dT%H:%M:%fZ',a.created_at) AS created_at,a.status,a.message,
      ROW_NUMBER() OVER (PARTITION BY a.target_id ORDER BY julianday(a.created_at) DESC,a.id DESC) AS rank
    FROM audits a JOIN targets t ON t.id=a.target_id WHERE ${targetClause} AND julianday(a.created_at)<=julianday(?)
  ) SELECT * FROM ranked WHERE rank=1`).all(...targetArgs, bounds.end);
  const strictRows = db.prepare(`SELECT q.resolved_target_id AS target_id,q.last_error
    FROM author_resolution_queue q JOIN targets t ON t.id=q.resolved_target_id
    WHERE ${targetClause} AND q.suspended_target_enabled IS NOT NULL
      AND q.status IN ('pending','retry','rejected') ORDER BY q.updated_at,q.id`).all(...targetArgs);
  const postRows = db.prepare(`SELECT p.id,p.external_id,p.author_id,p.caption,p.url,p.target_id,p.published_at,p.first_seen_at,p.last_seen_at,
    pm.captured_at AS metric_at,pm.likes,pm.comments,pm.shares,pm.collects,pm.plays FROM posts p
    LEFT JOIN post_metrics pm ON pm.id=(SELECT m.id FROM post_metrics m WHERE m.post_id=p.id AND julianday(m.captured_at)<=julianday(?)
      ORDER BY julianday(m.captured_at) DESC,m.id DESC LIMIT 1)
    JOIN targets t ON t.id=p.target_id WHERE ${targetClause}
    AND (julianday(p.first_seen_at)<=julianday(?) OR (julianday(p.first_seen_at)>julianday(?) AND pm.id IS NOT NULL))
    AND (julianday(p.last_seen_at)>julianday(?)
      OR (julianday(p.published_at)>=julianday(?) AND julianday(p.published_at)<=julianday(?)))
    ORDER BY p.published_at,p.id`).all(bounds.end, ...targetArgs, bounds.end, bounds.end, bounds.end, floor, bounds.end);
  const posts = postsAsOfInRead(database, postRows, bounds.end, targets, {}, read.loadVerified).filter(post =>
    post.published_at && Date.parse(post.published_at) >= Date.parse(floor) && Date.parse(post.published_at) <= Date.parse(bounds.end))
    .map(post => ({ ...post, published_at: new Date(post.published_at).toISOString() }));
  const events = db.prepare(`SELECT e.target_id,e.event_type,e.event_json FROM account_events e
    JOIN targets t ON t.id=e.target_id WHERE ${targetClause} AND julianday(e.observed_at)<=julianday(?)
    ORDER BY julianday(e.observed_at),e.id`).all(...targetArgs, bounds.end);
  const worksObservations = read.loadObservations(targetId);
  return { targets, memberships, snapshots, metricSnapshots, audits, strictRows, posts, events, worksObservations };
}

function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const id = Number(row[key]);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  return groups;
}

function operatingMemberships(memberships, classification) {
  const rows = Array.isArray(memberships) ? memberships : [];
  const hasTuanTuanSliceMatrix = classification?.theme?.key === "tuantuan"
    && rows.some(row => normalizeBoardName(row.board_name) === "一条小团团切片矩阵");
  if (!hasTuanTuanSliceMatrix) return rows;
  // “抖音主播板块” was the historical generic intake bucket. Once the same
  // account has an explicit Tuantuan slice-matrix membership, keep the old
  // row as provenance in SQLite but do not expose or count it as a competing
  // current business matrix.
  return rows.filter(row => normalizeBoardName(row.board_name) !== "抖音主播板块");
}

function buildAccounts(data, bounds, timeline, period, reference, timeZone = null) {
  const membershipsById = groupBy(data.memberships, "target_id");
  const samplesById = groupBy(data.metricSnapshots ?? data.snapshots, "target_id");
  const allSamplesById = groupBy(data.snapshots, "target_id");
  const auditById = new Map(data.audits.map((row) => [Number(row.target_id), row]));
  const strictById = new Map(data.strictRows.map((row) => [Number(row.target_id), row]));
  const postsById = groupBy(data.posts, "target_id");
  const eventsById = groupBy(data.events, "target_id");
  const businessZone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const collectionDate = businessDateKey(bounds.end, businessZone);
  return data.targets.map((target) => {
    const metadata = safeJson(target.metadata_json, {}) ?? {};
    const platform = metadata.platform ?? "douyin";
    const samples = samplesById.get(target.id) ?? [];
    const savedSamples = allSamplesById.get(target.id) ?? [];
    const memberships = membershipsById.get(target.id) ?? [];
    const classification = classifyAuthor({ target, metadata, memberships });
    const visibleMemberships = operatingMemberships(memberships, classification);
    const events = eventsById.get(target.id) ?? [];
    const lifecycle = safeJson(events.filter((event) => event.event_type === "lifecycle").at(-1)?.event_json, null);
    const identityAliases = events.filter((event) => event.event_type === "alias").map((event) => safeJson(event.event_json, null)).filter(Boolean);
    const identityEvidence = events.filter((event) => event.event_type === "identity").map((event) => safeJson(event.event_json, null)).filter(Boolean);
    const observedPublicId = platform === "douyin" ? samples.filter((sample) => sample.quality_status !== "rejected"
      && typeof sample.observed_public_id === "string" && sample.observed_public_id.trim()).at(-1)?.observed_public_id : null;
    const metrics = Object.fromEntries(Object.entries(METRICS).map(([name, field]) => [name, metricInsight(samples, field, bounds, period, reference, timeZone)]));
    metrics.posts.label = "作品存量净变化";
    metrics.posts.definition = "账号作品总量的净变化，可受删除或隐藏影响，不等于新增发布量";
    metrics.estimatedPlays = proxyMetric(metrics.likes);
    const posts = postsById.get(target.id) ?? [];
    const publishedByDay = new Map();
    for (const post of posts) {
      const day = timeZone ? businessDateKey(post.published_at, timeZone) : localDateKey(new Date(post.published_at));
      publishedByDay.set(day, (publishedByDay.get(day) ?? 0) + 1);
    }
    const account = {
      id: Number(target.id), label: target.label, platform,
      publicId: String(platform === "douyin" ? observedPublicId ?? metadata.douyinId ?? ""
        : metadata.resolution?.publicAccountId ?? metadata.bilibiliId ?? metadata.xiaohongshuId ?? "") || null,
      publicNickname: metadata.resolution?.publicNickname ?? null,
      submittedName: metadata.submittedName || metadata.importSource?.authorName || null,
      // Keep the submitted identifier platform-specific. A B站 UID or小红书
      // user ID must never be rendered as a抖音号 in exports or detail views.
      submittedAccountId: platform === "bilibili" ? metadata.bilibiliId || null
        : platform === "xiaohongshu" ? metadata.xiaohongshuId || null
          : metadata.douyinId || null,
      lifecycle, identityAliases, identityEvidence,
      classification,
      worksObservation: data.worksObservations.get(target.id) ?? describeWorksObservation([], bounds.end),
      profileUrl: profileUrl(target, metadata, platform), enabled: Boolean(target.enabled),
      boards: visibleMemberships.map((row) => ({ key: row.board_key, name: row.board_name,
        organization: row.organization, tier: row.tier, category: row.category, owner: row.owner,
        source: { type: row.source_type || "", fileName: row.source_file_name || "",
          sheetName: row.source_sheet_name || "", sourceRow: row.source_row == null ? null : Number(row.source_row) } })),
      metrics, trend: accountTrend(samples, timeline, timeZone).map((point) => ({ ...point, publishedSamples: publishedByDay.get(point.date) ?? 0 })),
      publishedSamples: publishedSamplesInsight(posts.filter((post) => post.published_at >= bounds.start).length, bounds,
        posts.some(post => Date.parse(post.first_seen_at) > Date.parse(bounds.end) && post.published_at >= bounds.start)),
      status: statusInsight(target, savedSamples, auditById.get(target.id), strictById.get(target.id), reference, lifecycle, samples),
    sources: sourcesFor(metadata, memberships),
    };
    account.collection = accountCollectionCoverage(account, collectionDate, businessZone);
    return account;
  });
}

function applyMasterRosterClassifications(database, accounts) {
  const db = database?.db;
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') return accounts;
  const roster = readMasterRoster(db);
  if (!roster) return accounts;
  const byTargetId = new Map(roster.items.filter(item => Number.isSafeInteger(item.targetId) && item.targetId > 0)
    .map(item => [item.targetId, item]));
  for (const account of accounts) {
    const entry = byTargetId.get(account.id);
    if (entry) account.classification = mergeRosterClassification(account.classification, entry);
  }
  return accounts;
}

function compactAccount(account) {
  return {
    id: account.id, label: account.label, platform: account.platform,
    publicId: account.publicId, profileUrl: account.profileUrl, enabled: account.enabled, boards: account.boards,
    submittedName: account.submittedName, submittedAccountId: account.submittedAccountId,
    lifecycle: account.lifecycle, identityAliases: account.identityAliases, identityEvidence: account.identityEvidence,
    classification: account.classification,
    collection: account.collection,
    // Full dates, per-metric provenance and all four daily series are available
    // from the account detail endpoint. Lists need only a bounded sparkline.
    metrics: Object.fromEntries(Object.entries(account.metrics).map(([name, metric]) => [name, {
      value: metric.value, currentAt: metric.currentAt, baselineAt: metric.baselineAt,
      observedInPeriod: metric.observedInPeriod,
      observedOnEndDate: metric.observedOnEndDate, knownValue: metric.knownValue,
      fullPeriodComparable: metric.fullPeriodComparable, observedWindow: metric.observedWindow,
      delta: metric.delta, percent: metric.percent, comparable: metric.comparable,
      observedCount: metric.observedCount, comparableCount: metric.comparableCount,
      valueQuality: metric.valueQuality, deltaQuality: metric.deltaQuality,
      reliable: metric.reliable, deltaReliable: metric.deltaReliable,
      ...(name === "followers" ? { comparisonLabel: metric.comparisonLabel } : {}),
      dailyComparable: metric.dailyComparable,
      reason: name === "estimatedPlays" ? account.metrics.likes.reason : metric.reason,
      ...(metric.proxy ? { proxy: true } : {}),
    }])),
    trend: account.trend.slice(-30).map(({ date, followers }) => ({ date, followers })),
    status: { key: account.status.key, label: account.status.label, stale: account.status.stale,
      lastAttemptAt: account.status.lastAttemptAt, lastSuccessAt: account.status.lastSuccessAt,
      error: account.status.error, provenanceWarning: account.status.provenanceWarning,
      sourceExcludedCount: account.status.sourceExcludedCount },
    publishedSamples: { ...account.publishedSamples },
    worksObservation: account.worksObservation,
    sources: account.sources,
  };
}

function calendarDate(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field} 须为 YYYY-MM-DD 日期`);
  const at = new Date(`${value}T00:00:00`);
  if (!Number.isFinite(at.getTime()) || localDateKey(at) !== value) throw new Error(`${field} 日期无效`);
  return at;
}

function customRange(startDate, endDate, reference, timeZone = null) {
  const start = calendarDate(startDate, "开始日期");
  const end = calendarDate(endDate, "结束日期");
  if (startDate > endDate) throw new Error("开始日期不能晚于结束日期");
  const today = timeZone ? businessDateKey(reference, timeZone) : localDateKey(reference);
  if (endDate > today) throw new Error("不能统计未来日期");
  const days = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / DAY_MS) + 1;
  if (days > 366) throw new Error("日期范围最多支持 366 天");
  const startTime = timeZone ? businessDateStartUtc(startDate, timeZone).getTime() : start.getTime();
  const endOfDay = timeZone
    ? businessDateStartUtc(shiftCalendarDate(endDate, 1), timeZone).getTime() - 1
    : (end.setHours(23, 59, 59, 999), end.getTime());
  const endTime = Math.min(endOfDay, reference.getTime());
  return { startDate, endDate, start: new Date(startTime).toISOString(), end: new Date(endTime).toISOString(),
    days, inclusive: true, partialEndDay: endTime < endOfDay };
}

function context({ period = "week", reference = new Date(), startDate, endDate, timeZone = null } = {}) {
  const at = new Date(reference);
  if (!Number.isFinite(at.getTime())) throw new Error("统计时间无效");
  const custom = period === "custom" || startDate !== undefined || endDate !== undefined;
  const fixedDay = custom && period === "day" && startDate === endDate;
  const selectedPeriod = fixedDay ? "day" : custom ? "custom" : period;
  const today = timeZone ? businessDateKey(at, timeZone) : localDateKey(at);
  const range = custom ? customRange(startDate, endDate, at, timeZone)
    : period === "30d" ? customRange(shiftCalendarDate(today, -29), today, at, timeZone) : null;
  const bounds = range ? { start: range.start, end: range.end } : periodBounds(period, at, timeZone);
  // Keep the daily view's 30-day trend, ending on the explicitly requested
  // day rather than the later server date. Range validation remains above.
  const timeline = fixedDay ? dates(new Date(range.end), null, timeZone) : dates(at, range, timeZone);
  const dateKey = (value) => timeZone ? businessDateKey(value, timeZone) : localDateKey(new Date(value));
  const resultRange = range ?? { startDate: dateKey(bounds.start), endDate: dateKey(at),
    start: bounds.start, end: bounds.end, inclusive: true, partialEndDay: true };
  return { at, bounds, timeline, period: selectedPeriod, header: {
    range: resultRange,
    period: selectedPeriod, start: bounds.start, end: bounds.end, referenceAt: at.toISOString(),
    timeZone: timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    methodology: {
      aggregateScope: "指标按所选期间的真实观测；只纳入区间末前已创建的账号，以及数据库中保留且创建于区间末前的板块关系。关系删除/历史重建没有完整版本记录，无法还原；板块目录/名称、启用状态、作者名称和主表分类按当前记录，不补造未记录的历史状态。全局按账号 ID 去重，暂停账号仍可查看",
      comparison: "所有周期均要求开始日前一日有效基准及结束日有效观测，逐指标、同一批账号计算净变化；缺任一端点时 delta 保持空值，不以首次采样或跨缺测基准替代",
      observedWindow: "observedWindow 仅保留不满足区间端点的两个实际采样间变化；各账号窗口可不同，不可汇总成日、周、月增长",
      knownValue: "knownValue 为截至期末最后已知合计，可包含历史沿用值；endObservedValue 仅结束日新采；value 额外保留已注销账号最后可信值。这些字段均与区间开始日期无关",
      customComparison: "自定义区间须有开始日前一日基准及结束日观测；否则增长保持空值，不把区间内首个采样伪装为开始端点",
      percentage: "百分比 = 净变化 ÷ 同一批可比账号基准 × 100；基准为 0 时不计算百分比",
      trend: `${timeZone || "主机当地"}最近 30 个日历日，逐指标取当日末次有效采样；缺采保持空值；每日变化只比较相邻两日同一账号`,
      cohort: "各指标 CohortKey 对实际参与该日合计的账号集合生成稳定指纹；DeltaCohortKey 对参与日变化的账号集合生成指纹。不同账号集合不能连线解读为同一批人的涨跌",
      proxy: "累计估算播放 = 账号累计点赞 × 100；估算播放变化 = 点赞净变化 × 100，不是平台真实播放量；负值代表点赞净减少的换算",
      proxyDisplay: "播放主读数应使用区间/每日可比账号的点赞净变化 × 100；累计换算值仅作辅助，不可称为矩阵实际播放总量",
      dailyQuality: `日总量和日变化只有在至少 ${Math.round(DAILY_COHORT_MIN_RATIO * 100)}% 启用账号提供对应指标时才标记为可靠；低覆盖日保留原始观测和覆盖人数，但不得与完整日连线或外推矩阵总量`,
      posts: "作品存量变化不等于新增投稿；publishedSamples 仅代表截至区间结束已观察、按发布时间统计的公开作品样本；晚到记录须以独立来源证明此前真实观察，不能只凭回填日期计入，不代表全部发布量",
      freshness: `超过 ${STALE_HOURS} 小时未取得有效资料会标记过期`,
    },
  } };
}

export function getProductInsights(database, options = {}) {
  const { board = "", classification = "all", theme = "all" } = options;
  const { at, bounds, timeline, header, period } = context(options);
  const data = loadData(database, bounds, timeline);
  const allAccounts = applyMasterRosterClassifications(database,
    buildAccounts(data, bounds, timeline, period, at, options.timeZone ?? null));
  const key = normalizeBoardKey(board) === "__all__" ? "" : normalizeBoardKey(board);
  const boardScopedAccounts = !key ? allAccounts : key === UNASSIGNED
    ? allAccounts.filter((account) => !account.boards.length)
    : allAccounts.filter((account) => account.boards.some((item) => item.key === key));
  const themeKey = String(theme || "all");
  const themeScopedAccounts = themeKey === "all"
    ? boardScopedAccounts
    : boardScopedAccounts.filter((account) => account.classification?.theme?.key === themeKey);
  const classificationKey = String(classification || "all");
  const scopedAccounts = classificationKey === "all"
    ? themeScopedAccounts
    : themeScopedAccounts.filter((account) => account.classification?.primaryKey === classificationKey
      || account.classification?.labels?.some((item) => item.key === classificationKey));
  const comparison = comparisonOptions(options);
  // `scopedAccounts` already reflects board, theme, and content classification.
  const accounts = scopedAccounts;

  // The optional comparison projection is applied only to the recursively
  // generated B period. Keep its date/header, cohort membership, lifecycle,
  // classification and aggregate semantics identical, but avoid materializing
  // B's independent catalog, board rollups and per-account transport objects.
  if (options[INTERNAL_COMPARISON_SUMMARY] === true) {
    return { ...header, projection: "comparison-summary",
      summary: aggregateAccounts(accounts, timeline, bounds), comparison: null };
  }

  const dynamicClassificationCatalog = classificationCatalog(themeScopedAccounts.flatMap((account) => account.classification?.labels ?? []));
  const catalog = database.listBoards();
  const boards = catalog.map((entry) => {
    const members = scopedAccounts.filter((account) => account.boards.some((item) => item.key === entry.key));
    return {
      ...entry, ...aggregateAccounts(members, timeline, bounds),
      targetCount: members.filter((account) => account.enabled).length,
      label: entry.name,
    };
  });
  const unassigned = scopedAccounts.filter((account) => !account.boards.length);
  const unassignedQueueCount = Number(catalog.unassignedQueuedCount ?? 0);
  const unassignedPendingCount = Number(catalog.unassignedPendingCount ?? 0);
  const unassignedRejectedCount = Number(catalog.unassignedRejectedCount ?? 0);
  if (unassigned.length || key === UNASSIGNED) boards.push({
    ...aggregateAccounts(unassigned, timeline, bounds), key: UNASSIGNED, name: "未分板块", label: "未分板块",
    targetCount: unassigned.filter((account) => account.enabled).length, queuedCount: unassignedQueueCount,
    pendingCount: unassignedPendingCount, rejectedCount: unassignedRejectedCount,
  });
  const selectedBoard = key ? boards.find((entry) => entry.key === key) ?? {
    ...aggregateAccounts([], timeline, bounds), key, name: normalizeBoardName(board), label: normalizeBoardName(board),
    targetCount: 0, queuedCount: 0, pendingCount: 0, rejectedCount: 0,
  } : null;
  const summary = aggregateAccounts(accounts, timeline, bounds);
  return {
    ...header,
    scopeBasis: {
      metrics: "period-observations",
      targetCreated: "period-end",
      boardMembership: "retained-relationship-created-by-period-end",
      boardMembershipRemoval: "not-historized",
      enabledStatus: "period-end-recorded-state",
      classification: "current-master-roster-and-source-records",
      displayNames: "current",
      boardCatalog: "current-catalog",
      description: "指标按所选区间内真实观测；目标创建、已留痕的启停状态及当前仍保留的板块关系按区间末过滤。未留痕的旧启停变更无法完整还原；关系删除/历史重建没有完整历史版本；板块目录、分类和名称按当前记录，缺少的历史信息不补造。",
    },
    selectedBoard,
    theme: themeKey,
    classification: classificationKey,
    classificationRuleVersion: AUTHOR_CLASSIFICATION_RULE_VERSION,
    classificationCatalog: dynamicClassificationCatalog,
    themeSummary: summarizeThemes(boardScopedAccounts),
    classificationSummary: summarizeClassifications(themeScopedAccounts, dynamicClassificationCatalog),
    classificationSources: summarizeClassificationSources(boardScopedAccounts),
    summary, boards, accounts: accounts.map(compactAccount),
    recordedWindow: comparison || options.includeRecordedWindow === false ? null
      : recordedWindow(accounts, data.metricSnapshots ?? data.snapshots, header, at, options.timeZone ?? null),
    comparison: comparison ? getProductInsights(database, {
      ...comparison,
      ...(options.comparisonProjection === "summary" ? { [INTERNAL_COMPARISON_SUMMARY]: true } : {}),
    }) : null };
}

function comparisonOptions(options) {
  const { comparisonStartDate, comparisonEndDate, ...base } = options;
  if (comparisonStartDate === undefined && comparisonEndDate === undefined) return null;
  return { ...base, period: "custom", startDate: comparisonStartDate, endDate: comparisonEndDate, includeRecordedWindow: false };
}

export function getAccountInsight(database, targetId, options = {}) {
  const id = Number(targetId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const { at, bounds, timeline, header, period } = context(options);
  const data = loadData(database, bounds, timeline, id);
  if (!data.targets.length) return null;
  const account = applyMasterRosterClassifications(database,
    buildAccounts(data, bounds, timeline, period, at, options.timeZone ?? null))[0];
  const workRows = database.db.prepare(`
    WITH observed AS (
      SELECT p.id,p.external_id,p.caption,p.url,p.author_id,p.target_id,p.first_seen_at,p.last_seen_at,strftime('%Y-%m-%dT%H:%M:%fZ',p.published_at) AS published_at,
        strftime('%Y-%m-%dT%H:%M:%fZ',pm.captured_at) AS captured_at,
        pm.likes,pm.comments,pm.shares,pm.collects,pm.plays,
        ROW_NUMBER() OVER (PARTITION BY p.id ORDER BY julianday(pm.captured_at) DESC,pm.id DESC) AS rank
      FROM posts p JOIN post_metrics pm ON pm.post_id=p.id
      WHERE p.target_id=? AND (julianday(p.first_seen_at)<=julianday(?) OR julianday(p.first_seen_at)>julianday(?))
        AND julianday(pm.captured_at)<=julianday(?)
    ) SELECT *,captured_at AS metric_at FROM observed WHERE rank=1
  `).all(id, bounds.end, bounds.end, bounds.end);
  const recentWorks = postsAsOf(database, workRows, bounds.end, data.targets)
    .filter(row => row.published_at === null || Date.parse(row.published_at) <= Date.parse(bounds.end))
    .sort((left, right) => String(right.published_at ?? "").localeCompare(String(left.published_at ?? ""))
      || right.captured_at.localeCompare(left.captured_at) || right.id - left.id).slice(0, 20).map((row) => ({
    id: Number(row.id), externalId: row.external_id, caption: row.caption, url: publicUrl(row.url),
    publishedAt: row.published_at, lastObservedAt: row.captured_at,
    likes: finiteCount(row.likes), comments: finiteCount(row.comments), shares: finiteCount(row.shares),
    collects: finiteCount(row.collects), plays: finiteCount(row.plays),
    playsEvidence: describeWorkPlays(finiteCount(row.plays), account.platform),
  }));
  const comparison = comparisonOptions(options);
  return { ...header, account, recentWorks, comparison: comparison ? getAccountInsight(database, id, comparison) : null };
}
