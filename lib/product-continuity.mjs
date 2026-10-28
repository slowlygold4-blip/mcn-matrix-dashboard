import { basename } from "node:path";
import { reviewState } from "./analytics.mjs";
import { schedulerReadiness } from "./runtime-audit.mjs";
import { businessDateKey, localDateKey, safeJson } from "./utils.mjs";

const HOUR_MS = 3_600_000;
const METRICS = { followers: "followers", likes: "total_likes", posts: "total_posts" };
const SOURCE_DOMAINS = ["feishu.cn", "larkoffice.com", "larksuite.com"];
const IDENTITY_ERROR = /身份|账号.{0,12}(?:不一致|未回显|缺失)|公开主页.{0,18}(?:不一致|未回显)|搜索结果页|合法(?: URL|链接|BV|账号)|无效重定向|非.{0,12}域名|提交目标不一致|证据|短链.{0,12}大小写|无法唯一/;

function clean(value, limit = 200) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

function iso(value) {
  if (!value || !["string", "number"].includes(typeof value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function boundedLimit(value, fallback, maximum) {
  return Number.isFinite(Number(value)) ? Math.max(1, Math.min(maximum, Math.trunc(Number(value)))) : fallback;
}

// Source cards must not forward imported auth parameters, credentials, arbitrary
// ports, non-Lark hosts or arbitrary paths to a browser or a subsequent refresh.
export function safeAuthorSourceUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    if (!SOURCE_DOMAINS.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return null;
    const match = /^\/(?:sheets|spreadsheets)\/([A-Za-z0-9_-]{10,})\/?$/.exec(url.pathname);
    if (!match) return null;
    const safe = new URL(`${url.origin}/sheets/${match[1]}`);
    const sheet = url.searchParams.get("sheet");
    if (sheet && /^[A-Za-z0-9_-]{1,120}$/.test(sheet)) safe.searchParams.set("sheet", sheet);
    return safe.toString();
  } catch { return null; }
}

/** A missing identity is not permission to enumerate the team's uploads. */
export function getAuthorSources(database, { userId, limit = 20 } = {}) {
  if (!["number", "string"].includes(typeof userId) || !Number.isSafeInteger(Number(userId)) || Number(userId) <= 0) return [];
  const count = boundedLimit(limit, 20, 100);
  const expression = "CASE WHEN json_valid(request_json) THEN request_json ELSE '{}' END";
  const fields = ["sourceType", "sourceUrl", "sourceTitle", "sourceSheetId", "sourceReadAt", "sourceRevision", "sourceSha256", "sourceExportSha256", "defaultBoard"];
  const statement = database.db.prepare(`
    WITH page AS MATERIALIZED (
      SELECT id,created_at FROM author_resolution_jobs WHERE user_id=?
      ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?
    )
    SELECT job.id,job.created_at,job.file_name,job.sheet_name,
      ${fields.map((field) => `json_extract(${expression},'$.${field}') AS ${field}`).join(",")}
    FROM page JOIN author_resolution_jobs job ON job.id=page.id
    ORDER BY page.created_at DESC,page.id DESC
  `);
  const sources = [];
  const seen = new Set();
  // Page lightweight metadata, never transfer the potentially huge request.rows
  // or another user's requests. Bound work even when uploads are all duplicates.
  for (let offset = 0; offset < 5_000 && sources.length < count; offset += 100) {
    const rows = statement.all(Number(userId), 100, offset);
    for (const row of rows) {
      if (row.sourceType !== "lark-sheet") continue;
      const sourceUrl = safeAuthorSourceUrl(row.sourceUrl);
      if (!sourceUrl) continue;
      const url = new URL(sourceUrl);
      const sheetId = /^[A-Za-z0-9_-]{1,120}$/.test(String(row.sourceSheetId ?? ""))
        ? String(row.sourceSheetId) : url.searchParams.get("sheet") || "";
      const defaultBoard = clean(row.defaultBoard, 120);
      // Different destination boards remain independently refreshable.
      const key = `${url.origin}${url.pathname}\u0000${sheetId || clean(row.sheet_name, 120)}\u0000${defaultBoard}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (sheetId) url.searchParams.set("sheet", sheetId);
      sources.push({
        sourceUrl: url.toString(),
        title: clean(row.sourceTitle, 200) || clean(basename(String(row.file_name).replace(/\\/g, "/")), 240),
        fileName: clean(basename(String(row.file_name).replace(/\\/g, "/")), 240),
        sheetName: clean(row.sheet_name, 120),
        sheetId,
        readAt: iso(row.sourceReadAt) || iso(row.created_at),
        defaultBoard,
        revision: Number.isSafeInteger(Number(row.sourceRevision)) && Number(row.sourceRevision) >= 0 ? Number(row.sourceRevision) : 0,
        contentSha256: /^[a-f0-9]{64}$/i.test(String(row.sourceSha256 ?? "")) ? String(row.sourceSha256).toLowerCase() : "",
        exportSha256: /^[a-f0-9]{64}$/i.test(String(row.sourceExportSha256 ?? "")) ? String(row.sourceExportSha256).toLowerCase() : "",
      });
      if (sources.length >= count) break;
    }
    if (rows.length < 100) break;
  }
  return sources;
}

function hasAccountEvents(database) {
  return Boolean(database.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_events'").get());
}

// Only the protected, provider-written event table is a lifecycle authority.
// Target metadata and imported status labels are intentionally not consulted.
function getLatestLifecycle(database, now) {
  if (!hasAccountEvents(database)) return new Map();
  const rows = database.db.prepare(`
    WITH valid_events AS (
      SELECT id,target_id,observed_at,
        json_extract(CASE WHEN json_valid(event_json) THEN event_json ELSE '{}' END,'$.state') AS state
      FROM account_events WHERE event_type='lifecycle' AND julianday(observed_at)<=julianday(?)
    ), ranked AS (
      SELECT *,ROW_NUMBER() OVER (PARTITION BY target_id ORDER BY julianday(observed_at) DESC,id DESC) AS rank
      FROM valid_events WHERE state IN ('deleted','active')
    ) SELECT target_id,observed_at,state FROM ranked WHERE rank=1
  `).all(now.toISOString());
  return new Map(rows.map((row) => [Number(row.target_id), row]));
}

function getRunLifecycles(database, firstStartedAt, now) {
  const byRun = new Map();
  if (!hasAccountEvents(database)) return byRun;
  const rows = database.db.prepare(`
    SELECT e.id,e.target_id,e.run_id,e.observed_at,
      json_extract(CASE WHEN json_valid(e.event_json) THEN e.event_json ELSE '{}' END,'$.state') AS state
    FROM account_events e JOIN runs r ON r.id=e.run_id
    WHERE e.event_type='lifecycle' AND r.trigger_type='scheduled'
      AND (r.target_id IS NULL OR r.target_id=e.target_id)
      AND julianday(r.started_at)>=julianday(?) AND julianday(r.started_at)<=julianday(?)
      AND julianday(e.observed_at)>=julianday(r.started_at) AND julianday(e.observed_at)<=julianday(?)
    ORDER BY julianday(e.observed_at) ASC,e.id ASC
  `).all(firstStartedAt, now.toISOString(), now.toISOString());
  for (const row of rows) {
    if (!["deleted", "active"].includes(row.state)) continue;
    if (!byRun.has(row.run_id)) byRun.set(row.run_id, new Map());
    byRun.get(row.run_id).set(Number(row.target_id), row);
  }
  return byRun;
}

function observationState(detail = {}, audit = null, lifecycle = null, targetType = null) {
  if (lifecycle?.state === "deleted") return { state: "inactive", profileUsable: false };
  const status = detail.status || audit?.status || "pending";
  if (status === "inactive" || detail.reviewState === "inactive") return { state: "retry", profileUsable: false };
  const message = String(detail.message || audit?.message || "");
  if (status === "skipped") return { state: "skipped", profileUsable: false };
  const rawWarnings = Array.isArray(detail.warnings) ? detail.warnings : safeJson(audit?.warnings_json, []);
  const warnings = Array.isArray(rawWarnings) ? rawWarnings.filter((item) => typeof item === "string") : [];
  let state;
  if (["rejected", "error"].includes(status)) return { state: IDENTITY_ERROR.test(message) ? "manual" : "retry", profileUsable: false };
  if ((audit?.target_type || targetType) === "hashtag") {
    // Topics have no account/work status contract. Only the exact audit-bound
    // snapshot can prove that both real counters (including zero) were saved.
    const topicEvidence = auditSnapshotDetail(audit);
    state = topicEvidence.reviewState === "complete" || topicEvidence.reviewState === "limited"
      ? topicEvidence.reviewState : "retry";
    return { state, profileUsable: topicEvidence.profileUsable === true };
  }
  // Old run JSON can contain a stale "complete" label from before work
  // coverage was fail-closed. Derive the state from the saved account and
  // works evidence instead; never let the cached label override missing data.
  state = reviewState(status, warnings, detail);
  const savedState = detail.reviewState;
  // Preserve conservative decisions made by the collector, but never let an
  // old positive label upgrade a state that the saved evidence cannot prove.
  if (["manual", "retry", "pending"].includes(savedState)) state = savedState;
  else if (savedState === "limited" && state === "complete") state = "limited";
  if (!["complete", "limited", "retry", "manual", "pending"].includes(state)) state = "retry";
  return {
    state,
    profileUsable: detail.profileUsable !== false && (detail.profileUsable === true || ["available", "partial"].includes(detail.accountStatus) || ["complete", "limited"].includes(state)),
  };
}

function auditSnapshotDetail(audit) {
  if (audit?.target_type === "hashtag" && !audit.snapshot_id) return { reviewState: "retry", profileUsable: false };
  if (!audit?.snapshot_id || !["validated", "warning"].includes(audit.status)) return {};
  const usable = ["validated", "warning"].includes(audit.snapshot_quality);
  const valid = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (audit.target_type === "hashtag") {
    const complete = usable && [audit.hashtag_participants, audit.hashtag_views].every(valid);
    return { reviewState: complete ? (audit.status === "validated" ? "complete" : "limited") : "retry", profileUsable: complete };
  }
  if (audit.target_type !== "account") return {};
  const profileUsable = usable && ["available", "partial"].includes(audit.snapshot_account_status)
    && [audit.followers, audit.total_likes, audit.total_posts].every(valid);
  return { accountStatus: audit.snapshot_account_status, worksCoverage: audit.works_coverage, profileUsable,
    ...(!usable ? { reviewState: "retry" } : {}) };
}

function getDailyPlans(database, now, limit, timeZone = null) {
  const planDateExpression = timeZone === "Asia/Shanghai" ? "date(started_at,'+8 hours')" : "date(started_at,'localtime')";
  const runs = database.db.prepare(`
    SELECT id,target_id,started_at,finished_at,status,target_count,processed_count,details_json,
      ${planDateExpression} AS plan_date
    FROM runs WHERE trigger_type='scheduled' AND julianday(started_at)<=julianday(?)
      AND ${planDateExpression} IN (
        SELECT DISTINCT ${planDateExpression} FROM runs
        WHERE trigger_type='scheduled' AND julianday(started_at)<=julianday(?)
        ORDER BY 1 DESC LIMIT ?
      ) ORDER BY started_at ASC,id ASC
  `).all(now.toISOString(), now.toISOString(), boundedLimit(limit, 14, 60));
  if (!runs.length) return [];
  const lifecyclesByRun = getRunLifecycles(database, runs[0].started_at, now);
  const targetTypes = new Map(database.db.prepare("SELECT id,type FROM targets").all()
    .map((row) => [Number(row.id), row.type]));
  const sameSnapshotDay = timeZone === "Asia/Shanghai"
    ? "date(x.captured_at,'+8 hours')=date(r.started_at,'+8 hours')"
    : "date(x.captured_at,'localtime')=date(r.started_at,'localtime')";
  const audits = database.db.prepare(`
    SELECT a.target_id,a.run_id,a.status,a.message,a.warnings_json,a.source_checksum,a.created_at,a.id,
      t.type AS target_type,s.id AS snapshot_id,s.account_status AS snapshot_account_status,
      s.quality_status AS snapshot_quality,s.works_coverage,s.followers,s.total_likes,s.total_posts,
      s.hashtag_participants,s.hashtag_views
    FROM audits a JOIN runs r ON r.id=a.run_id
    LEFT JOIN targets t ON t.id=a.target_id
    LEFT JOIN snapshots s ON s.id=(SELECT x.id FROM snapshots x
      WHERE a.status IN ('validated','warning')
        AND a.source_checksum IS NOT NULL AND a.source_checksum<>''
        AND x.source_checksum IS NOT NULL AND x.source_checksum<>''
        AND x.target_id=a.target_id AND x.source_checksum=a.source_checksum
        AND julianday(x.captured_at)>=julianday(r.started_at)
        AND julianday(x.captured_at)<=julianday(a.created_at)
        AND (r.finished_at IS NULL OR julianday(x.captured_at)<=julianday(r.finished_at))
        AND ${sameSnapshotDay}
      ORDER BY julianday(x.captured_at) DESC,x.id DESC LIMIT 1)
    WHERE r.trigger_type='scheduled' AND julianday(r.started_at)>=julianday(?)
      AND julianday(r.started_at)<=julianday(?)
      AND julianday(a.created_at)<=julianday(?)
      AND (r.target_id IS NULL OR r.target_id=a.target_id)
    ORDER BY a.created_at ASC,a.id ASC
  `).all(runs[0].started_at, now.toISOString(), now.toISOString());
  const auditsByRun = new Map();
  for (const audit of audits) {
    if (!auditsByRun.has(audit.run_id)) auditsByRun.set(audit.run_id, new Map());
    auditsByRun.get(audit.run_id).set(Number(audit.target_id), audit);
  }
  const days = new Map();
  for (const run of runs) {
    if (!days.has(run.plan_date)) days.set(run.plan_date, {
      date: run.plan_date, firstStartedAt: iso(run.started_at), lastFinishedAt: null,
      runCount: 0, attemptCount: 0, processedAttemptCount: 0, latestRunId: null,
      latestRunTargetCount: 0, latestRunScope: "unknown", running: false,
      denominatorComplete: true, targetCountLowerBound: 0, observations: new Map(),
    });
    const day = days.get(run.plan_date);
    const records = new Map();
    const lifecycles = lifecyclesByRun.get(run.id) || new Map();
    for (const [id, lifecycle] of lifecycles) {
      if (Number.isSafeInteger(id) && id > 0) records.set(id, observationState({}, null, lifecycle, targetTypes.get(id)));
    }
    for (const [id, audit] of auditsByRun.get(run.id) || []) {
      if (Number.isSafeInteger(id) && id > 0) records.set(id, observationState(auditSnapshotDetail(audit), audit, lifecycles.get(id), targetTypes.get(id)));
    }
    const parsedDetails = safeJson(run.details_json, []);
    for (const detail of Array.isArray(parsedDetails) ? parsedDetails : []) {
      const id = Number(detail?.targetId);
      if (!Number.isSafeInteger(id) || id <= 0) continue;
      const audit = auditsByRun.get(run.id)?.get(id);
      // Completed run details remain authoritative. Only omitted fields can
      // be recovered from the exact audit's snapshot, never an older success.
      const merged = { ...auditSnapshotDetail(audit), ...detail };
      if (detail.accountStatus != null && detail.profileUsable == null) merged.profileUsable = ["available", "partial"].includes(detail.accountStatus);
      // A run-bound snapshot is stronger evidence than a cached positive
      // detail flag. Keep conservative collector decisions, but do not let an
      // old profileUsable=true or reviewState=complete mask missing metrics in
      // the snapshot that this exact audit references.
      if (audit?.target_type === "account" && audit.snapshot_id) {
        const boundEvidence = auditSnapshotDetail(audit);
        if (boundEvidence.profileUsable !== true) {
          merged.profileUsable = false;
          if (!["manual", "retry", "pending"].includes(detail.reviewState)) merged.reviewState = "retry";
        }
      }
      // Topic details have legacy account fields set to unknown/false. Their
      // two real counters are the authoritative completion contract instead.
      if (audit?.target_type === "hashtag") Object.assign(merged, auditSnapshotDetail(audit));
      records.set(id, observationState(merged, audit, lifecycles.get(id), targetTypes.get(id)));
    }
    if (Number(run.target_id) > 0 && !records.has(Number(run.target_id))) {
      records.set(Number(run.target_id), { state: "pending", profileUsable: false });
    }
    for (const [id, observation] of records) day.observations.set(id, observation);
    const planned = Math.max(0, Number(run.target_count) || 0);
    day.denominatorComplete &&= records.size >= planned;
    day.targetCountLowerBound = Math.max(day.targetCountLowerBound, planned);
    day.runCount += 1;
    day.attemptCount += planned;
    day.processedAttemptCount += Math.max(0, Number(run.processed_count) || 0);
    day.latestRunId = Number(run.id);
    day.latestRunTargetCount = planned;
    day.latestRunScope = Number(run.target_id) > 0 ? "single-account" : "batch-attempt";
    day.lastFinishedAt = iso(run.finished_at) || day.lastFinishedAt;
    day.running ||= run.status === "running" && !run.finished_at;
  }
  return [...days.values()].reverse().map((day) => {
    const observations = [...day.observations.values()];
    const recordedTargetCount = day.observations.size;
    const targetCount = Math.max(recordedTargetCount, day.targetCountLowerBound);
    const completedTargetCount = observations.filter((item) => ["complete", "limited"].includes(item.state)).length;
    const profileSuccessfulTargetCount = observations.filter((item) => item.profileUsable).length;
    const retryTargetCount = observations.filter((item) => ["retry", "pending"].includes(item.state)).length;
    const manualTargetCount = observations.filter((item) => item.state === "manual").length;
    const skippedTargetCount = observations.filter((item) => item.state === "skipped").length;
    const inactiveTargetCount = observations.filter((item) => item.state === "inactive").length;
    const settledTargetCount = completedTargetCount + inactiveTargetCount;
    const complete = day.denominatorComplete && completedTargetCount === targetCount && targetCount > 0;
    const settled = day.denominatorComplete && settledTargetCount === targetCount && targetCount > 0;
    const { observations: _observations, targetCountLowerBound: _lowerBound, ...publicDay } = day;
    return {
      ...publicDay, targetCount, recordedTargetCount, completedTargetCount, profileSuccessfulTargetCount,
      retryTargetCount, manualTargetCount, skippedTargetCount, inactiveTargetCount, settledTargetCount,
      unknownTargetCount: Math.max(0, targetCount - recordedTargetCount),
      status: day.running ? "running" : complete ? "completed" : settled ? "settled" : "partial",
      coveragePercent: targetCount && day.denominatorComplete ? completedTargetCount / targetCount * 100 : null,
      profileCoveragePercent: targetCount && day.denominatorComplete ? profileSuccessfulTargetCount / targetCount * 100 : null,
      settledCoveragePercent: targetCount && day.denominatorComplete ? settledTargetCount / targetCount * 100 : null,
      denominatorReason: day.running
        ? "当前批次仍在运行中；分母会随任务完成更新，不代表历史缺失"
        : day.denominatorComplete
        ? "按当日自动任务中实际目标 ID 去重；不使用今天名单倒推历史分母"
        : "历史任务缺少部分目标 ID，分母仅为已知下界，不宣称整日完整覆盖",
    };
  });
}

function getFreshness(database, now) {
  const lifecycles = getLatestLifecycle(database, now);
  const columns = Object.entries(METRICS).map(([metric, column]) => `
    MAX(CASE WHEN s.${column} IS NOT NULL AND s.${column}>=0
      AND s.account_status IN ('available','partial') AND s.quality_status<>'rejected'
      AND julianday(s.captured_at)<=julianday(?) THEN julianday(s.captured_at) END) AS ${metric}
  `).join(",");
  const rows = database.db.prepare(`
    SELECT t.id,${columns} FROM targets t LEFT JOIN snapshots s ON s.target_id=t.id
    WHERE t.enabled=1 AND t.type='account' GROUP BY t.id
  `).all(...Object.keys(METRICS).map(() => now.toISOString()));
  const inactiveTargetIds = rows.filter((row) => lifecycles.get(Number(row.id))?.state === "deleted")
    .map((row) => Number(row.id));
  const inactiveIds = new Set(inactiveTargetIds);
  const metrics = {};
  for (const key of Object.keys(METRICS)) {
    const result = {
      total: rows.length, observedCount: 0, freshCount: 0, agingCount: 0, staleCount: 0, missingCount: 0,
      inactiveCount: inactiveIds.size, inactiveObservedCount: 0, inactiveMissingCount: 0, activeObservedCount: 0,
      over24HoursCount: 0, oldestAt: null, latestAt: null,
      staleTargetIds: [], agingTargetIds: [], missingTargetIds: [],
      inactiveTargetIds: [...inactiveTargetIds], inactiveLastObservedAtByTarget: {},
    };
    for (const row of rows) {
      const id = Number(row.id);
      const inactive = inactiveIds.has(id);
      if (row[key] === null) {
        if (inactive) {
          result.inactiveMissingCount += 1;
          result.inactiveLastObservedAtByTarget[id] = null;
        } else {
          result.missingCount += 1;
          result.missingTargetIds.push(id);
        }
        continue;
      }
      // SQLite Julian timestamps avoid mixed ISO `T` / SQL-space comparisons.
      const captured = Math.round((Number(row[key]) - 2440587.5) * 86_400_000);
      const capturedAt = new Date(captured).toISOString();
      const ageHours = Math.max(0, now.getTime() - captured) / HOUR_MS;
      result.observedCount += 1;
      if (!result.oldestAt || capturedAt < result.oldestAt) result.oldestAt = capturedAt;
      if (!result.latestAt || capturedAt > result.latestAt) result.latestAt = capturedAt;
      if (inactive) {
        result.inactiveObservedCount += 1;
        result.inactiveLastObservedAtByTarget[id] = capturedAt;
        continue;
      }
      result.activeObservedCount += 1;
      if (ageHours <= 24) result.freshCount += 1;
      else if (ageHours <= 72) {
        result.agingCount += 1;
        result.agingTargetIds.push(Number(row.id));
      } else {
        result.staleCount += 1;
        result.staleTargetIds.push(Number(row.id));
      }
    }
    result.over24HoursCount = result.agingCount + result.staleCount;
    metrics[key] = result;
  }
  metrics.estimatedPlays = { ...metrics.likes, proxy: true, sourceMetric: "likes", multiplier: 100 };
  return {
    total: rows.length, inactiveCount: inactiveIds.size, inactiveTargetIds,
    activeCount: rows.length - inactiveIds.size, freshHours: 24, staleHours: 72, metrics,
    reason: "仅统计当前启用账号；每项指标独立取最后有效非空样本，超过24/72小时分别提示；可信注销事件独立列项，保留原历史指标时间，缺失不填零",
  };
}

function publicBackup(backup) {
  if (!backup || typeof backup !== "object") return { status: "unknown", reason: "尚未提供自动备份检查结果" };
  const status = ["ok", "missing", "error"].includes(backup.status) ? backup.status : "unknown";
  return {
    status, checkedAt: iso(backup.checkedAt), createdAt: iso(backup.createdAt),
    fileName: clean(basename(String(backup.fileName || "").replace(/\\/g, "/")), 240),
    ageMs: Number.isFinite(backup.ageMs) && backup.ageMs >= 0 ? backup.ageMs : null,
    verification: ["manifest", "sha256", "sha256+sqlite"].includes(backup.verification) ? backup.verification : "not-checked",
    reason: status === "ok" ? "自动备份检查通过；检查等级见 verification，不等于已实际恢复演练" : "自动备份缺失或检查未通过，请查看管理员审查记录",
    validation: backup.validation ? {
      quickCheck: backup.validation.quickCheck === "ok" ? "ok" : "not-confirmed",
      integrityCheck: backup.validation.integrityCheck === "ok" ? "ok" : "not-confirmed",
      foreignKeyViolations: Number.isSafeInteger(backup.validation.foreignKeyViolations) ? backup.validation.foreignKeyViolations : null,
    } : null,
  };
}

function zonedTime(value, timeZone) {
  const timestamp = iso(value);
  return timestamp ? new Intl.DateTimeFormat("zh-CN", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(new Date(timestamp)) : null;
}

/** Read-only product projection: no migration, collection, schedule or backup writes. */
export function getProductContinuity(database, scheduler, { now = new Date(), userId, limit = 14, backup, timeZone = null } = {}) {
  const reference = new Date(now);
  if (!Number.isFinite(reference.getTime())) throw new Error("更新状态参考时间无效");
  const state = typeof scheduler?.getStatus === "function" ? scheduler.getStatus() : scheduler || {};
  const displayTimeZone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dailyPlans = getDailyPlans(database, reference, limit, displayTimeZone);
  const nextRunAt = iso(state.nextRunAt);
  return {
    referenceAt: reference.toISOString(), timeZone: displayTimeZone, beijingTimeZone: "Asia/Shanghai",
    scheduleTime: /^\d{2}:\d{2}$/.test(state.scheduleTime || "") ? state.scheduleTime : null,
    scheduleIntervalHours: state.scheduleIntervalHours === 8 ? 8 : 24,
    slotTimes: Array.isArray(state.slotTimes) ? state.slotTimes.filter((time) => /^\d{2}:\d{2}$/.test(time)) : [],
    currentSlotKey: typeof state.currentSlotKey === "string" ? state.currentSlotKey : null,
    currentSlotStartedAt: iso(state.currentSlotStartedAt), currentSlotEndsAt: iso(state.currentSlotEndsAt),
    nextRunAt, nextRunKind: state.scheduleIntervalHours === 8 ? "eight-hour" : "daily", nextRunLocal: zonedTime(nextRunAt, displayTimeZone), nextRunBeijing: zonedTime(nextRunAt, "Asia/Shanghai"),
    hostTime: zonedTime(reference.toISOString(), displayTimeZone), beijingTime: zonedTime(reference.toISOString(), "Asia/Shanghai"),
    lastTickAt: iso(state.lastTickAt), schedulerReady: schedulerReadiness(state, { now: reference }),
    scheduleState: ["waiting", "running", "completed", "partial", "failed", "interrupted", "due"].includes(state.scheduleState) ? state.scheduleState : "unknown",
    running: state.running === true,
    latestPlan: dailyPlans[0] || null,
    todayPlan: dailyPlans.find((plan) => plan.date === (displayTimeZone === "Asia/Shanghai" ? businessDateKey(reference, displayTimeZone) : localDateKey(reference))) || null,
    dailyPlans, freshness: getFreshness(database, reference), backup: publicBackup(backup),
    authorSources: getAuthorSources(database, { userId }),
    methodology: {
      schedule: "按服务端明确显示的统计时区执行，日报和日期曲线使用同一切日；原始 UTC 时间不改；电脑休眠或关机不能准点，唤醒只补当日真实数据",
      plans: "整日计划合并自动首批和补采，目标 ID 去重；单人或局部补采不是整批，重试次数不是作者人数；注销仅凭同次任务可信生命周期事件单列，已处理不等于已采到新指标",
      freshness: "fresh+aging+stale+missing+inactive=total；注销单列不混入过期或缺失，observedCount及最早/最新时间仍包含注销账号的历史有效样本",
      history: "保留实际采样时间；未采集的日期不生成虚构历史点",
      posts: "作品总量是当前存量；范围差值为净变化，非完整新增发布数",
      estimatedPlays: "累计估算播放=累计获赞×100；变化=获赞变化×100，非平台真实播放，缺获赞时缺失",
      sourceRefresh: "只列当前用户来源；重新读取、预览差异后再追加更新，不删除本次未出现作者、不恢复暂停作者",
    },
  };
}
