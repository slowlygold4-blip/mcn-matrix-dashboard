import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { MonitorDatabase, normalizeBoardKey, normalizeBoardName } from "./database.mjs";
import { MonitorScheduler } from './scheduler.mjs';
import { planWorksOnly, worksOnlyRetryGate } from './works-only-scheduler.mjs';
import { getProductInsights, getAccountInsight } from "./product-insights.mjs";
import { getAccountHistory } from "./account-history.mjs";
import {readCreatorOperatingView} from './creator-source-operating-view.mjs';

const database = new DatabaseSync(workerData.databasePath, { readOnly: true });
database.function("normalize_board_key", { deterministic: true }, (value) => normalizeBoardKey(value));
database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");

const asNumber = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
function listBoards() {
  const catalog = database.prepare("SELECT board_key,board_name,enabled,source_type,created_at,updated_at FROM board_catalog WHERE enabled=1 ORDER BY board_name COLLATE NOCASE").all();
  const count = database.prepare("SELECT COUNT(*) AS count FROM targets WHERE type='account' AND enabled=1 AND EXISTS (SELECT 1 FROM target_boards x WHERE x.target_id=targets.id AND x.board_key=?)");
  return catalog.map((row) => ({
    key: row.board_key, name: row.board_name, label: row.board_name,
    enabled: Boolean(row.enabled), sourceType: row.source_type,
    createdAt: row.created_at, updatedAt: row.updated_at,
    targetCount: asNumber(count.get(row.board_key)?.count), queuedCount: 0, pendingCount: 0, rejectedCount: 0,
  }));
}

const slimMetric = (metric) => metric ? {
  value: metric.value, currentAt: metric.currentAt, baselineAt: metric.baselineAt,
  comparisonCurrentAt: metric.comparisonCurrentAt,
  observedInPeriod: metric.observedInPeriod, delta: metric.delta, percent: metric.percent,
  observedOnEndDate: metric.observedOnEndDate, knownValue: metric.knownValue,
  fullPeriodComparable: metric.fullPeriodComparable, observedWindow: metric.observedWindow,
  comparable: metric.comparable, reliable: metric.reliable, deltaReliable: metric.deltaReliable,
  dailyComparable: metric.dailyComparable, reason: metric.reason, proxy: metric.proxy,
} : {};

function compactAccount(account, detail = false) {
  if (!account) return null;
  const classification = account.classification ? {
    primaryKey: account.classification.primaryKey,
    primaryLabel: account.classification.primaryLabel,
    theme: account.classification.theme,
    labels: Array.isArray(account.classification.labels) ? account.classification.labels.map(({ key, label, color, confidence, sourceConfirmed }) => ({ key, label, color, confidence, ...(sourceConfirmed ? { sourceConfirmed: true } : {}) })) : [],
    mode: account.classification.mode,
    confidence: account.classification.confidence,
    needsReview: account.classification.needsReview,
  } : null;
  const metrics = Object.fromEntries(Object.entries(account.metrics || {}).map(([key, metric]) => [key, slimMetric(metric)]));
  return {
    id: account.id, label: account.label, platform: account.platform, publicId: account.publicId,
    profileUrl: account.profileUrl, enabled: account.enabled, boards: account.boards,
    submittedName: account.submittedName, submittedAccountId: account.submittedAccountId,
    sourceOnly: account.sourceOnly, sourceSummary: account.sourceSummary,
    rosterKey: account.rosterKey, rosterKeys: account.rosterKeys, sourceProvenance: account.sourceProvenance, linkedTargetId: account.linkedTargetId,
    classification,
    collection: account.collection,
    metrics,
    status: detail ? account.status : {
      key: account.status?.key, label: account.status?.label, stale: account.status?.stale,
      lastAttemptAt: account.status?.lastAttemptAt, lastSuccessAt: account.status?.lastSuccessAt,
      error: account.status?.error, provenanceWarning: account.status?.provenanceWarning,
      sourceExcludedCount: account.status?.sourceExcludedCount,
    },
    // Account lists do not need 30 daily points; the detail endpoint owns the
    // trend drawer. Keeping this out of the list prevents a multi-megabyte
    // payload for a matrix with hundreds of accounts.
    ...(detail ? { trend: account.trend || [] } : {}),
    ...(detail ? { recentWorks: account.recentWorks || [], publishedSamples: account.publishedSamples } : {}),
  };
}

function slimOverview(result) {
  const summary = result.summary ? (() => {
    const { worksObservation, ...base } = result.summary;
    return { ...base, trend: (result.summary.trend || []).map((point) => ({
      date: point.date, followers: point.followers, followersDelta: point.followersDelta,
      likes: point.likes, likesDelta: point.likesDelta, posts: point.posts, postsDelta: point.postsDelta,
      estimatedPlays: point.estimatedPlays, estimatedPlaysDelta: point.estimatedPlaysDelta,
      followersObservedCount: point.followersObservedCount, likesObservedCount: point.likesObservedCount,
      postsObservedCount: point.postsObservedCount, followersComparableCount: point.followersComparableCount,
      likesComparableCount: point.likesComparableCount, postsComparableCount: point.postsComparableCount,
      ...Object.fromEntries(["followers", "likes", "posts", "estimatedPlays"].flatMap((metric) =>
        ["Quality", "QualityReason", "Complete", "Reliable", "CoveragePercent", "CohortKey", "DeltaCohortKey",
          "DeltaQuality", "DeltaQualityReason", "DeltaComplete", "DeltaReliable", "DeltaCoveragePercent"].map((suffix) =>
          [`${metric}${suffix}`, point[`${metric}${suffix}`]]))),
      missing: point.missing, partial: point.partial, reason: point.reason,
    })) };
  })() : null;
  if (result.projection === "comparison-summary") {
    // Only the explicit B-period projection takes this path. The full default
    // contract and A's account list remain unchanged.
    return {
      projection: result.projection,
      range: result.range, period: result.period, start: result.start, end: result.end,
      referenceAt: result.referenceAt, timeZone: result.timeZone, methodology: result.methodology,
      summary, comparison: null,
    };
  }
  const accounts = (result.accounts || []).map((account) => compactAccount(account));
  return {
    range: result.range, period: result.period, start: result.start, end: result.end,
    referenceAt: result.referenceAt, timeZone: result.timeZone, methodology: result.methodology,
    scopeBasis: result.scopeBasis,
    rosterSummary: result.rosterSummary,
    selectedBoard: result.selectedBoard ? { ...result.selectedBoard, trend: undefined, worksObservation: undefined } : null,
    theme: result.theme, themeSummary: result.themeSummary,
    classification: result.classification, classificationRuleVersion: result.classificationRuleVersion,
    classificationCatalog: result.classificationCatalog,
    classificationSummary: result.classificationSummary,
    classificationSources: result.classificationSources,
    summary,
    recordedWindow: result.recordedWindow ? { ...result.recordedWindow,
      accounts: result.recordedWindow.accounts.map(account => ({ id: account.id,
        metrics: Object.fromEntries(Object.entries(account.metrics).map(([key, metric]) => [key, slimMetric(metric)])) })) } : null,
    boards: (result.boards || []).map((board) => ({
      key: board.key, name: board.name, label: board.label, targetCount: board.targetCount,
      memberCount: board.memberCount, accountCount: board.accountCount, enabledCount: board.enabledCount,
      pausedCount: board.pausedCount, metrics: board.metrics,
    })),
    accounts,
    comparison: result.comparison ? slimOverview(result.comparison) : null,
  };
}

parentPort.on("message", (job) => {
  try {
    // All metric, membership and lifecycle reads in one response share the
    // same SQLite snapshot even while the collector is committing updates.
    database.exec("BEGIN");
    const readonlyAdapter = Object.assign(Object.create(MonitorDatabase.prototype), { db: database, filePath: workerData.databasePath });
    if (job.kind === 'creator-operating') {
      const result=readCreatorOperatingView(database,job.options);
      database.exec('COMMIT');
      parentPort.postMessage({id:job.id,ok:true,result});
      return;
    }
    if (job.kind === 'bootstrap-overview') {
      const result = readonlyAdapter.getOverview(job.options);
      database.exec('COMMIT');
      parentPort.postMessage({ id: job.id, ok: true, result });
      return;
    }
    if (job.kind === 'planning') {
      const now = new Date(job.options.asOf);
      if (!Number.isFinite(now.getTime()) || now.toISOString() !== job.options.asOf) throw new Error('Invalid planning cutoff');
      const adapter = readonlyAdapter;
      // Membership/settings are current within this one readonly snapshot;
      // future-created targets/runs cannot masquerade as observations at asOf.
      const eligible = new Set(database.prepare('SELECT id FROM targets WHERE julianday(created_at)<=julianday(?)').all(job.options.asOf).map(row => row.id));
      adapter.listTargets = () => MonitorDatabase.prototype.listTargets.call(adapter).filter(target => eligible.has(target.id));
      adapter.lastScheduledRun = () => {
        const row = database.prepare("SELECT id,started_at,finished_at,status,target_count,processed_count FROM runs WHERE trigger_type='scheduled' AND julianday(started_at)<=julianday(?) ORDER BY started_at DESC,id DESC LIMIT 1").get(job.options.asOf);
        if (row?.finished_at && Date.parse(row.finished_at) > now.getTime()) return { ...row, finished_at: null, status: 'running' };
        return row ?? null;
      };
      const scheduler = new MonitorScheduler(adapter, { ...job.options.scheduler, asyncPlanning: false });
      let result;
      if (job.options.mode === 'tick') {
        const slot = scheduler.collectionSlot(now), dateKey = scheduler.scheduledDateKey(now);
        const dueIds = slot ? scheduler.scheduledDueTargetIds(dateKey, now, slot) : [];
        const works = slot && !dueIds.length && scheduler.worksOnlyEnabled
          ? planWorksOnly(adapter, scheduler.scheduledTargetAttemptStates(dateKey, slot), { now, slot }) : null;
        // Profile refresh must not wait indefinitely for a failing works lane.
        // Only profile/topic retry work settles this pass; works keeps its own
        // durable cursor, failures and transport cooldown across passes.
        const profilePassSettled = scheduler.continuous && slot && !dueIds.length
          && adapter.listTargets().some(target=>target.enabled && target.provider!=='manual')
          && scheduler.scheduledPlanSummary(dateKey,slot).pendingCount===0;
        const roundSettled = profilePassSettled && !works?.due.length && !works?.deferred;
        result = { asOf: job.options.asOf, slotKey: slot?.key ?? null, dueIds, worksTargetId: works?.due[0]?.target.id ?? null, roundSettled: Boolean(roundSettled), profilePassSettled: Boolean(profilePassSettled) };
      } else if (job.options.mode === 'guard') {
        const targetId = job.options.targetId;
        if (!Number.isSafeInteger(targetId) || targetId <= 0) throw new Error('Invalid planning target');
        const slot = scheduler.collectionSlot(now);
        const allowed = slot && !worksOnlyRetryGate(adapter, { now, slot }).deferred
          && planWorksOnly(adapter, scheduler.scheduledTargetAttemptStates(scheduler.scheduledDateKey(now), slot), { now, slot, targetId }).due.some(item => item.target.id === targetId);
        result = { asOf: job.options.asOf, slotKey: slot?.key ?? null, targetId, allowed: Boolean(allowed) };
      } else if (job.options.mode === 'status') result = scheduler.getStatus(now);
      else throw new Error('Invalid planning operation');
      database.exec('COMMIT');
      parentPort.postMessage({ id: job.id, ok: true, result });
      return;
    }
    const databaseAdapter = { db: database, listBoards };
    const result = job.kind === "history" ? getAccountHistory(databaseAdapter, Number(job.targetId), job.options)
      : job.kind === "account"
      ? getAccountInsight(databaseAdapter, Number(job.targetId), job.options)
      : getProductInsights(databaseAdapter, job.options);
    database.exec("COMMIT");
    parentPort.postMessage({ id: job.id, ok: true, result: job.kind === "history" ? result
      : job.kind === "account" ? { ...result, account: compactAccount(result?.account, true) } : slimOverview(result) });
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    parentPort.postMessage({ id: job.id, ok: false, error: String(error?.message ?? error), code: error?.code || "CONSOLE_READER_ERROR" });
  }
});

process.on("exit", () => { try { database.close(); } catch {} });
