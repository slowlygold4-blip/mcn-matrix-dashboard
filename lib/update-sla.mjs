import { businessDateKey, isCalendarDate } from "./utils.mjs";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { loadVerifiedWorksOnlyRows, isVerifiedWorksOnlyRow } from "./works-observation.mjs";
import { validateTopicSnapshot } from "./topic-snapshot-integrity.mjs";
import { isVerifiedDeferredWorksSnapshot, MAX_DEFERRED_SOURCE_BYTES } from "./works-deferred-snapshot.mjs";

export const UPDATE_SLA_TARGET_PERCENT = 80;
export const UPDATE_SLA_FRESHNESS_MS = 8 * 60 * 60 * 1000;
const TIME_ZONE = "Asia/Shanghai";
const acceptedQuality = (row) => ["validated", "warning"].includes(row?.quality_status);
const counter = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const profileComplete = (row) => acceptedQuality(row) && ["available", "partial"].includes(row.account_status)
  && [row.followers, row.total_likes, row.total_posts].every(counter);
const topicComplete = (row) => acceptedQuality(row) && [row.hashtag_participants, row.hashtag_views].every(counter);

function automaticObservation(row, nowMs) {
  const evidence = row?.collectionEvidence;
  if (evidence?.provider !== "public-web" || !Number.isSafeInteger(evidence.auditId) || evidence.auditId <= 0
    || !Number.isSafeInteger(evidence.runId) || evidence.runId <= 0 || !["validated", "warning"].includes(evidence.status)
    || Number(evidence.targetId) !== Number(row.target_id)
    || typeof row.source_checksum !== "string" || !row.source_checksum.trim() || evidence.sourceChecksum !== row.source_checksum) return false;
  const start = instant(evidence.runStartedAt), captured = instant(row.captured_at), audited = instant(evidence.auditAt);
  if (![start, captured, audited].every(Number.isFinite) || start > captured || captured > audited || audited > nowMs) return false;
  if (evidence.runFinishedAt !== null) {
    const finished = instant(evidence.runFinishedAt);
    if (!Number.isFinite(finished) || audited > finished || finished > nowMs) return false;
  }
  return true;
}

function instant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !isCalendarDate(value.slice(0, 10))) return NaN;
  return Date.parse(value);
}
const iso = (value) => Number.isFinite(value) ? new Date(value).toISOString() : null;
function observationMap(rows, nowMs, predicate = () => true, timeField = "captured_at") {
  const result = new Map();
  for (const row of rows) {
    const time = instant(typeof timeField === "function" ? timeField(row) : row?.[timeField]);
    if (!Number.isFinite(time) || time > nowMs || !predicate(row)) continue;
    const key = Number(row.target_id), previous = result.get(key);
    if (!previous || time > previous.time || (time === previous.time && Number(row.id) > Number(previous.row.id))) result.set(key, { row, time });
  }
  return result;
}
function coverage(total, complete, targetPercent = null) {
  return { total, complete, missing: total - complete, ratioPercent: total ? 100 * complete / total : null,
    requiredPercent: targetPercent, requiredCount: total && targetPercent !== null ? Math.ceil(total * targetPercent / 100) : null,
    status: !total ? "unknown" : targetPercent === null ? (complete === total ? "complete" : "incomplete") : (100 * complete >= targetPercent * total ? "met" : "below-target") };
}
function targetCoverage(total, complete) {
  return { requiredPercent: UPDATE_SLA_TARGET_PERCENT, requiredCount: total ? Math.ceil(total * UPDATE_SLA_TARGET_PERCENT / 100) : null,
    targetStatus: !total ? "unknown" : 100 * complete >= UPDATE_SLA_TARGET_PERCENT * total ? "met" : "below-target" };
}
function inWindow(observation, startMs) { return Boolean(observation && observation.time >= startMs); }
function latestAttempt(row) {
  if (!row) return null;
  const status = ["validated", "warning", "rejected", "error", "failed"].includes(row.row.status) ? row.row.status : "unknown";
  return { auditId: Number(row.row.id), status, createdAt: iso(row.time), provider: String(row.row.provider ?? "unknown") };
}
function worksAttemptFailureReason(row) {
  if (!isVerifiedWorksOnlyRow(row) || !row.raw?.errorCode) return null;
  const { errorCode, failureDiagnostics } = row.raw;
  if (errorCode === "blocked" && failureDiagnostics?.httpStatuses?.includes?.(403)) return "http403";
  if (errorCode === "login_required") return "loginRequired";
  if (errorCode === "rate_limited") return "rateLimited";
  if (errorCode === "collector_error") return row.status === "accepted" ? "collectorPartial" : "collectorUnavailable";
  if (errorCode === "network_error") return "networkError";
  if (errorCode === "upstream_changed") return "upstreamChanged";
  return "other";
}
function worksWindow(accounts, snapshots, startMs, nowMs, worksObservations = [], deferredSnapshots = new Set()) {
  const worksTime = (row) => row?.works_observed_at ?? row?.captured_at;
  const latest = observationMap(snapshots, nowMs, (row) => {
    const observed = instant(worksTime(row));
    return !deferredSnapshots.has(row) && automaticObservation(row, nowMs) && acceptedQuality(row) && observed >= startMs
      && observed >= instant(row.captured_at) && observed <= instant(row.collectionEvidence.auditAt);
  }, worksTime);
  const ledgerLatest = observationMap(worksObservations, nowMs,
    row => isVerifiedWorksOnlyRow(row) && instant(row.run_finished_at) <= nowMs, 'attempt_at');
  const deferredLatest = observationMap([...deferredSnapshots], nowMs);
  const counts = { complete: 0, limited: 0, unavailable: 0, unknown: 0, missing: 0 };
  const attemptReasons = { http403: 0, loginRequired: 0, rateLimited: 0, collectorPartial: 0,
    collectorUnavailable: 0, networkError: 0, upstreamChanged: 0, other: 0 };
  let attemptedTargets = 0, failedLatestAttempts = 0, deferredTargets = 0;
  const targets = [];
  for (const account of accounts) {
    let found = latest.get(Number(account.id));
    const ledger = ledgerLatest.get(Number(account.id));
    if (ledger && ledger.time >= startMs) {
      attemptedTargets++;
      const reason = worksAttemptFailureReason(ledger.row);
      if (reason) { attemptReasons[reason]++; failedLatestAttempts++; }
    }
    if (ledger && ledger.time >= startMs && (!found || ledger.time >= found.time)) found = ledger;
    const deferred = deferredLatest.get(Number(account.id));
    const deferredAfterAttempt = deferred && deferred.time >= startMs && (!found || deferred.time > found.time);
    if (deferredAfterAttempt) deferredTargets++;
    let state = "missing";
    if (found) {
      const stored = found.row.works_coverage;
      state = stored === "complete" ? "complete" : ["limited", "latest-public-window"].includes(stored) ? "limited"
        : ["retry", "unavailable"].includes(stored) ? "unavailable" : "unknown";
      if (isVerifiedWorksOnlyRow(found.row) && found.row.status === 'accepted' && instant(found.row.captured_at) < startMs) state = 'missing';
    }
    counts[state]++;
    targets.push({ targetId: Number(account.id), state,
      snapshotId: found && !isVerifiedWorksOnlyRow(found.row) ? Number(found.row.id) : null,
      capturedAt: found ? iso(isVerifiedWorksOnlyRow(found.row) ? instant(found.row.captured_at) : found.time) : null,
      ...(deferredAfterAttempt ? { lastDeferredAt: iso(deferred.time) } : {}),
      ...(found && isVerifiedWorksOnlyRow(found.row) ? { observationId: found.row.observation_id,
        observedAt: found.row.observed_at, lastAttemptAt: found.row.attempt_at } : {}) });
  }
  return { ...coverage(accounts.length, counts.complete), missing: counts.missing,
    incomplete: accounts.length - counts.complete, ...targetCoverage(accounts.length, counts.complete), counts, targets,
    latestAttemptDiagnostics: { attemptedTargets, failureCount: failedLatestAttempts, reasons: attemptReasons },
    deferrals: { targets: deferredTargets, meaning: 'source-verified-zero-request-profile-updates-not-works-attempts' },
    selection: worksObservations.some(isVerifiedWorksOnlyRow) ? "latest-verified-works-attempt-in-window-not-ever-complete"
      : "latest-accepted-snapshot-in-window-not-ever-complete", metric: "works-detail-coverage-not-profile-total-posts" };
}

/** Deterministic observation SLA. It never schedules, mutates, estimates plays or calls a model. */
export function buildUpdateSla({ targets, snapshots, attempts = [], worksObservations = [], now = new Date() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : instant(now);
  if (!Number.isFinite(nowMs)) throw new TypeError("SLA requires a valid reference time");
  if (!Array.isArray(targets) || !Array.isArray(snapshots) || !Array.isArray(attempts) || !Array.isArray(worksObservations)) {
    return { version: 1, checkedAt: iso(nowMs), timeZone: TIME_ZONE, status: "unknown", coreAccounts: null, works: null, topics: null, reason: "observation-input-unavailable" };
  }
  const businessDate = businessDateKey(new Date(nowMs), TIME_ZONE);
  const dayStartMs = Date.parse(`${businessDate}T00:00:00+08:00`), freshStartMs = nowMs - UPDATE_SLA_FRESHNESS_MS;
  const enabled = [...new Map(targets.filter((target) => target.enabled === true || target.enabled === 1).map((target) => [Number(target.id), target])).values()];
  const accounts = enabled.filter((target) => target.type === "account"), topics = enabled.filter((target) => target.type === "hashtag");
  const accountsById = new Map(accounts.map(target => [Number(target.id), target]));
  const deferredSnapshots = new Set(snapshots.filter(row => isVerifiedDeferredWorksSnapshot(row, accountsById.get(Number(row.target_id)), { nowMs })));
  const profiles = observationMap(snapshots, nowMs, (row) => automaticObservation(row, nowMs) && profileComplete(row));
  const topicMetrics = observationMap(snapshots, nowMs, (row) => automaticObservation(row, nowMs) && topicComplete(row));
  const auditMap = observationMap(attempts, nowMs, () => true, "created_at");
  const accountRows = accounts.map((target) => {
    const found = profiles.get(Number(target.id)), attempt = auditMap.get(Number(target.id));
    return { targetId: Number(target.id), provider: String(target.provider ?? "unknown"), snapshotId: found ? Number(found.row.id) : null,
      capturedAt: found ? iso(found.time) : null, dailyComplete: inWindow(found, dayStartMs), fresh8hComplete: inWindow(found, freshStartMs),
      latestAttempt: latestAttempt(attempt), latestAttemptAfterUsableSnapshot: Boolean(attempt && (!found || attempt.time > found.time)) };
  });
  const topicRows = topics.map((target) => {
    const found = topicMetrics.get(Number(target.id));
    return { targetId: Number(target.id), snapshotId: found ? Number(found.row.id) : null, capturedAt: found ? iso(found.time) : null,
      dailyComplete: inWindow(found, dayStartMs), fresh8hComplete: inWindow(found, freshStartMs), latestAttempt: latestAttempt(auditMap.get(Number(target.id))) };
  });
  const coreAccounts = { selection: "latest-valid-complete-snapshot-per-account-within-window", metrics: ["followers", "total_likes", "total_posts"],
    daily: coverage(accounts.length, accountRows.filter((row) => row.dailyComplete).length, UPDATE_SLA_TARGET_PERCENT),
    fresh8h: coverage(accounts.length, accountRows.filter((row) => row.fresh8hComplete).length, UPDATE_SLA_TARGET_PERCENT), targets: accountRows };
  const works = { daily: worksWindow(accounts, snapshots, dayStartMs, nowMs, worksObservations, deferredSnapshots),
    fresh8h: worksWindow(accounts, snapshots, freshStartMs, nowMs, worksObservations, deferredSnapshots) };
  const topicSummary = { selection: "latest-valid-two-actual-counters-snapshot-per-topic-within-window", metrics: ["hashtag_participants", "hashtag_views"],
    daily: { ...coverage(topics.length, topicRows.filter((row) => row.dailyComplete).length), ...targetCoverage(topics.length, topicRows.filter((row) => row.dailyComplete).length) },
    fresh8h: { ...coverage(topics.length, topicRows.filter((row) => row.fresh8hComplete).length), ...targetCoverage(topics.length, topicRows.filter((row) => row.fresh8hComplete).length) }, targets: topicRows };
  const targetStates = [coreAccounts.daily.status, coreAccounts.fresh8h.status, works.daily.targetStatus, works.fresh8h.targetStatus, topicSummary.daily.targetStatus, topicSummary.fresh8h.targetStatus];
  return { version: 1, checkedAt: iso(nowMs), timeZone: TIME_ZONE, businessDate,
    windows: { daily: { startsAt: iso(dayStartMs), endsAt: iso(nowMs) }, fresh8h: { startsAt: iso(freshStartMs), endsAt: iso(nowMs), hours: 8 }, bounds: "inclusive-both-ends-future-excluded" },
    denominatorScope: "all-enabled-targets-including-manual-failed-and-deleted-not-disabled", disabledTargetCount: targets.filter((target) => target.enabled !== true && target.enabled !== 1).length,
    observationBasis: "public-web-snapshot-checksum-bound-to-same-target-run-audit-with-strict-time-bounds-not-import-time",
    enabledManualAccountCount: accounts.filter((target) => target.provider === "manual").length,
    enabledAccountCount: accounts.length, enabledTopicCount: topics.length, otherEnabledTargetCount: enabled.length - accounts.length - topics.length,
    targetStatus: targetStates.includes("below-target") ? "below-target" : targetStates.includes("unknown") ? "unknown" : "met",
    status: !accounts.length ? "unknown" : coreAccounts.daily.complete === accounts.length && coreAccounts.fresh8h.complete === accounts.length
      && works.daily.status === "complete" && works.fresh8h.status === "complete" && topics.length > 0
      && topicSummary.daily.status === "complete" && topicSummary.fresh8h.status === "complete" ? "complete" : "incomplete",
    coreAccounts, works, topics: topicSummary,
    notes: ["账号三项、作品明细、话题双指标分别核对80%目标；账号达标不代表整体达标。", "作品存量不是新增发布量；此接口不推算任何实际播放量。", "最新有效快照保留可用数据，后续失败通过 latestAttempt 单列，不改写成功证据。"] };
}

export function compactUpdateSla(result, { missingLimit = 20 } = {}) {
  if (!result.coreAccounts) return result;
  const limit = Math.max(0, Math.min(50, Number.isSafeInteger(missingLimit) ? missingLimit : 20));
  const { targets: accounts, ...core } = result.coreAccounts;
  const missingAccounts = accounts.filter((row) => !row.dailyComplete || !row.fresh8hComplete);
  const compactWorks = ({ targets, ...summary }) => {
    const incomplete = targets.filter((row) => row.state !== "complete");
    const missing = targets.filter((row) => row.state === "missing");
    return { ...summary,
      incompleteTargetIds: incomplete.slice(0, limit).map((row) => row.targetId),
      incompleteListTruncated: incomplete.length > limit,
      missingTargetIds: missing.slice(0, limit).map((row) => row.targetId),
      missingListTruncated: missing.length > limit };
  };
  const { targets: topics, ...topicSummary } = result.topics;
  const missingTopics = topics.filter((row) => !row.dailyComplete || !row.fresh8hComplete);
  return { ...result, coreAccounts: { ...core, missingTargets: missingAccounts.slice(0, limit), missingListTruncated: missingAccounts.length > limit,
    latestAttemptStates: Object.fromEntries(["validated", "warning", "rejected", "error", "failed", "unknown", "missing"].map((key) => [key, accounts.filter((row) => (row.latestAttempt?.status || "missing") === key).length])) },
    works: { daily: compactWorks(result.works.daily), fresh8h: compactWorks(result.works.fresh8h) },
    topics: { ...topicSummary, missingTargets: missingTopics.slice(0, limit), missingListTruncated: missingTopics.length > limit } };
}

// All reads share one SQLite snapshot. Existing writer connections and readonly
// DatabaseSync handles are both supported; no table writes or migrations occur.
export function inspectUpdateSla(db, { now = new Date(), includeTargets = false } = {}) {
  const reference = now instanceof Date ? now : new Date(now), asOf = reference.toISOString();
  const dayStart = Date.parse(`${businessDateKey(reference, TIME_ZONE)}T00:00:00+08:00`);
  const earliest = new Date(Math.min(dayStart, reference.getTime() - UPDATE_SLA_FRESHNESS_MS)).toISOString();
  db.exec("SAVEPOINT update_sla_read");
  try {
    // Read-only callers may inspect an old schema before the writer migrates it.
    const snapshotColumns = new Set(db.prepare("PRAGMA table_info(snapshots)").all().map(column => column.name));
    const targetColumns = new Set(db.prepare("PRAGMA table_info(targets)").all().map(column => column.name));
    const runColumns = new Set(db.prepare("PRAGMA table_info(runs)").all().map(column => column.name));
    const hasWorksTime = snapshotColumns.has("works_observed_at");
    const worksTimeSql = hasWorksTime ? "COALESCE(s.works_observed_at,s.captured_at)" : "s.captured_at";
    const platformSql = targetColumns.has('metadata_json')
      ? "CASE WHEN json_valid(metadata_json) THEN CASE WHEN json_type(metadata_json)='object' THEN COALESCE(json_extract(metadata_json,'$.platform'),'douyin') ELSE NULL END ELSE NULL END"
      : "'douyin'";
    const targets = db.prepare(`SELECT id,type,provider,enabled,${targetColumns.has("locator") ? "locator" : "NULL AS locator"},${platformSql} AS platform FROM targets`).all();
    const targetsById = new Map(targets.map(target => [target.id, target]));
    const snapshots = db.prepare(`WITH evidence_audits AS MATERIALIZED (
      SELECT a.id,a.target_id,a.run_id,a.provider,a.status,a.source_checksum,a.created_at
      FROM audits a JOIN runs r ON r.id=a.run_id WHERE a.provider='public-web' AND a.status IN ('validated','warning')
        AND julianday(a.created_at)<=julianday(?)
        AND (r.finished_at IS NULL OR (julianday(a.created_at)<=julianday(r.finished_at) AND julianday(r.finished_at)<=julianday(?)))
    ), candidate_ids AS (
      SELECT s.id FROM snapshots s JOIN targets t ON t.id=s.target_id WHERE t.enabled=1
        AND julianday(s.captured_at)>=julianday(?) AND julianday(s.captured_at)<=julianday(?)
      UNION SELECT s.id FROM snapshots s JOIN targets t ON t.id=s.target_id WHERE t.enabled=1 AND t.type='account'
        AND julianday(${worksTimeSql})>=julianday(?) AND julianday(${worksTimeSql})<=julianday(?)
      UNION SELECT (SELECT s.id FROM snapshots s WHERE s.target_id=t.id AND julianday(s.captured_at)<=julianday(?)
        AND s.quality_status IN ('validated','warning')
        AND ((t.type='account' AND s.account_status IN ('available','partial')
            AND s.followers BETWEEN 0 AND 9007199254740991 AND s.followers=CAST(s.followers AS INTEGER)
            AND s.total_likes BETWEEN 0 AND 9007199254740991 AND s.total_likes=CAST(s.total_likes AS INTEGER)
            AND s.total_posts BETWEEN 0 AND 9007199254740991 AND s.total_posts=CAST(s.total_posts AS INTEGER))
          OR (t.type='hashtag' AND s.hashtag_participants BETWEEN 0 AND 9007199254740991 AND s.hashtag_participants=CAST(s.hashtag_participants AS INTEGER)
            AND s.hashtag_views BETWEEN 0 AND 9007199254740991 AND s.hashtag_views=CAST(s.hashtag_views AS INTEGER)))
        AND EXISTS (SELECT 1 FROM evidence_audits ea JOIN runs er ON er.id=ea.run_id
          WHERE ea.target_id=s.target_id AND s.source_checksum<>'' AND ea.source_checksum=s.source_checksum
            AND julianday(s.captured_at)>=julianday(er.started_at) AND julianday(s.captured_at)<=julianday(ea.created_at))
        ORDER BY julianday(s.captured_at) DESC,s.id DESC LIMIT 1) FROM targets t WHERE t.enabled=1
    ), ranked AS (
      SELECT s.id,s.target_id,s.captured_at,${hasWorksTime ? "s.works_observed_at" : "NULL"} AS works_observed_at,
        s.followers,s.total_likes,s.total_posts,s.hashtag_participants,s.hashtag_views,
        s.quality_status,s.account_status,s.works_coverage,s.source_checksum,
        ${snapshotColumns.has("raw_json") ? `CASE WHEN t.type='hashtag' THEN s.raw_json
          WHEN t.type='account' AND s.works_coverage='unavailable' AND length(s.raw_json)<=${MAX_DEFERRED_SOURCE_BYTES}
            AND json_valid(s.raw_json) THEN CASE
              WHEN json_extract(s.raw_json,'$.worksErrorCode')='deferred'
                AND json_extract(s.raw_json,'$.works.pagination.requestCount')=0 THEN s.raw_json ELSE NULL END
          ELSE NULL END` : "NULL"} AS raw_json,
        a.id evidence_audit_id,a.run_id evidence_run_id,a.provider evidence_provider,a.status evidence_status,
        a.target_id evidence_target_id,${runColumns.has("target_id") ? "r.target_id" : "NULL"} evidence_run_target_id,
        ${runColumns.has("status") ? "r.status" : "NULL"} evidence_run_status,
        a.source_checksum evidence_checksum,a.created_at evidence_audit_at,r.started_at evidence_run_started_at,r.finished_at evidence_run_finished_at,
        ROW_NUMBER() OVER (PARTITION BY s.target_id ORDER BY julianday(s.captured_at) DESC,s.id DESC) latest_rank,
        ROW_NUMBER() OVER (PARTITION BY s.target_id ORDER BY CASE WHEN s.quality_status IN ('validated','warning')
          AND ((t.type='account' AND s.account_status IN ('available','partial')
              AND s.followers BETWEEN 0 AND 9007199254740991 AND s.followers=CAST(s.followers AS INTEGER)
              AND s.total_likes BETWEEN 0 AND 9007199254740991 AND s.total_likes=CAST(s.total_likes AS INTEGER)
              AND s.total_posts BETWEEN 0 AND 9007199254740991 AND s.total_posts=CAST(s.total_posts AS INTEGER))
            OR (t.type='hashtag' AND s.hashtag_participants BETWEEN 0 AND 9007199254740991 AND s.hashtag_participants=CAST(s.hashtag_participants AS INTEGER)
              AND s.hashtag_views BETWEEN 0 AND 9007199254740991 AND s.hashtag_views=CAST(s.hashtag_views AS INTEGER))) THEN 0 ELSE 1 END,
          julianday(s.captured_at) DESC,s.id DESC) usable_rank
      FROM candidate_ids candidates JOIN snapshots s ON s.id=candidates.id JOIN targets t ON t.id=s.target_id
      JOIN evidence_audits a ON a.target_id=s.target_id AND s.source_checksum<>'' AND a.source_checksum=s.source_checksum
      JOIN runs r ON r.id=a.run_id
      WHERE t.enabled=1 AND julianday(s.captured_at)<=julianday(?)
        AND julianday(s.captured_at)>=julianday(r.started_at) AND julianday(s.captured_at)<=julianday(a.created_at)
    ) SELECT * FROM ranked WHERE latest_rank=1 OR usable_rank=1 OR julianday(captured_at)>=julianday(?)
      OR (julianday(COALESCE(works_observed_at,captured_at))>=julianday(?)
        AND julianday(COALESCE(works_observed_at,captured_at))<=julianday(?))`).all(asOf, asOf, earliest, asOf, earliest, asOf, asOf, asOf, earliest, earliest, asOf)
      .filter(row => {
        const target = targetsById.get(row.target_id);
        if (target?.type !== "hashtag") return true;
        // The status badge must use the same source contract as topic history.
        // Matching DB checksum strings alone do not verify the original payload.
        // Older schemas without source fields fail closed for topics only.
        return validateTopicSnapshot({ ...row,
          audit_id: row.evidence_audit_id, audit_target_id: row.evidence_target_id,
          audit_provider: row.evidence_provider, audit_status: row.evidence_status,
          audit_checksum: row.evidence_checksum, audit_created_at: row.evidence_audit_at,
          run_id: row.evidence_run_id, run_target_id: row.evidence_run_target_id,
          run_status: row.evidence_run_status, started_at: row.evidence_run_started_at,
          finished_at: row.evidence_run_finished_at,
        }, target, { asOf: reference.getTime() }).valid;
      })
      .map((row) => ({ ...row, collectionEvidence: { auditId: Number(row.evidence_audit_id), runId: Number(row.evidence_run_id),
        targetId: Number(row.target_id), provider: row.evidence_provider, status: row.evidence_status, sourceChecksum: row.evidence_checksum,
        auditAt: row.evidence_audit_at, runStartedAt: row.evidence_run_started_at, runFinishedAt: row.evidence_run_finished_at } }));
    const attempts = db.prepare(`WITH ranked AS (SELECT a.id,a.target_id,a.created_at,a.status,a.provider,
      ROW_NUMBER() OVER (PARTITION BY a.target_id ORDER BY julianday(a.created_at) DESC,a.id DESC) latest_rank
      FROM audits a JOIN targets t ON t.id=a.target_id WHERE t.enabled=1 AND julianday(a.created_at)<=julianday(?))
      SELECT * FROM ranked WHERE latest_rank=1`).all(asOf);
    // This projection only needs each target's newest accepted attempt (plus
    // its newest overall attempt). Older accepted rows cannot change the
    // latest in-window SLA state and needlessly expand the verified JSON set.
    const worksObservations = loadVerifiedWorksOnlyRows(db, asOf, null, { acceptedPerTarget: 1 });
    const result = buildUpdateSla({ targets, snapshots, attempts, worksObservations, now: reference });
    return includeTargets ? result : compactUpdateSla(result);
  } finally { db.exec("RELEASE update_sla_read"); }
}

const activeReads = new Map();
/** One bounded readonly worker per database; overlapping status reads share it. */
export function readUpdateSla(databasePath, { now = new Date() } = {}) {
  if (activeReads.has(databasePath)) return activeReads.get(databasePath);
  const reference = new Date(now);
  const pending = new Promise((resolve) => {
    let settled = false, result = null;
    const unknown = () => buildUpdateSla({ now: reference });
    const worker = new Worker(new URL(import.meta.url), { execArgv: [], workerData: { task: "update-sla-read", databasePath, now: reference.toISOString() } });
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timeout); resolve(result); };
    const timeout = setTimeout(() => { finish({ ...unknown(), reason: "observation-read-timeout" }); void worker.terminate(); }, 5_000);
    worker.once("message", (message) => { result = message; });
    worker.once("error", () => { result = { ...unknown(), reason: "observation-read-failed" }; });
    worker.once("exit", () => {
      if (activeReads.get(databasePath) === pending) activeReads.delete(databasePath);
      finish(result || { ...unknown(), reason: "observation-read-incomplete" });
    });
  });
  activeReads.set(databasePath, pending);
  return pending;
}

if (!isMainThread && workerData?.task === "update-sla-read") {
  const db = new DatabaseSync(workerData.databasePath, { readOnly: true });
  try { parentPort.postMessage(inspectUpdateSla(db, { now: new Date(workerData.now) })); }
  finally { db.close(); }
}
