import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { businessDateKey } from "./utils.mjs";

function clean(value, limit = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/([?&](?:token|access_token|authorization|cookie|secret|key)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/(["'](?:access_token|refresh_token|authorization|cookie|password|secret|client_secret|api_key)["']\s*:\s*["'])[^"']*/gi, "$1[REDACTED]")
    .replace(/\b(?:access_token|refresh_token|authorization|password|secret|client_secret|api_key)\s*[=:]\s*[^\s,;&]+/gi, "[REDACTED]")
    .replace(/\b(?:Bearer\s+|token\s*[=:]\s*)[^\s,;]+/gi, "[REDACTED]")
    .replace(/\s+/g, " ").trim().slice(0, limit);
}

export function sourcePollKey(source) {
  const url = clean(source?.sourceUrl, 1_000);
  const sheet = clean(source?.sheetId || source?.sheetName, 120);
  const board = clean(source?.defaultBoard, 120);
  const object = clean(source?.sourceType || source?.type, 80);
  const table = clean(source?.tableId || source?.baseToken, 120);
  return createHash("sha256").update(`${object}\u0000${url}\u0000${sheet}\u0000${table}\u0000${board}`).digest("hex").slice(0, 32);
}

export function sourceReadContract(source) {
  return createHash("sha256").update(JSON.stringify({ key: sourcePollKey(source),
    monitorOnly: source?.monitorOnly === true, readPolicy: clean(source?.readPolicy, 80),
    ...(source?.sourceType === 'lark-work-source' ? { workFactsContract: 'mcn-work-source-edition-v1',
      ...(source.resolveWorkLinks===true?{workLinkContract:'anonymous-official-short-link-v1',
        workLinkBatchLimit:source.workLinkBatchLimit??50,workLinkDelayMs:source.workLinkDelayMs??700}:{}) } : {}) })).digest("hex");
}

export function hasRecoverableSourceJob(receipt) {
  return receipt?.lastStatus === "pending" && typeof receipt.lastJobId === "string" && Boolean(clean(receipt.lastJobId));
}

export function projectWorkLinkResolution(value){
  const states=['completed','stopped-upstream','deferred','cancelled','failed'];
  const iso=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    &&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
  if(value?.version!==1||value.runtimeAI!==false||!states.includes(value.status)
    ||!iso(value.checkedAt)||['planned','processed','resolved','failures','remaining','unresolved','coolingDown','batchLimit']
      .some(k=>!Number.isSafeInteger(value[k])||value[k]<0)||value.batchLimit<1||value.batchLimit>500
    ||value.processed>value.planned||value.planned>value.batchLimit||value.resolved+value.failures!==value.processed
    ||value.coolingDown>value.unresolved||value.remaining>value.unresolved||value.retryAt!==null&&!iso(value.retryAt))return null;
  return {version:1,status:value.status,checkedAt:new Date(value.checkedAt).toISOString(),
    ...Object.fromEntries(['planned','processed','resolved','failures','remaining','unresolved','coolingDown','batchLimit'].map(k=>[k,value[k]])),
    retryAt:value.retryAt===null?null:new Date(value.retryAt).toISOString(),
    code:/^[a-z][a-z0-9-]{1,100}$/.test(value.code||'')?value.code:null,runtimeAI:false};
}

const summaryCounter = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const summaryTimestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

/** Allowlist only numeric business outcomes; never project result.skipped or credentials. */
export function projectSourceJobSummary(value) {
  if (value?.version !== 1 || value.jobStatus !== "completed" || !summaryTimestamp(value.observedAt)) return null;
  const counts = Object.fromEntries(["createdAccountCount", "reusedExistingRowCount", "reviewRequiredItemCount", "queuedEvidenceRequestCount"]
    .map((key) => [key, summaryCounter(key === "queuedEvidenceRequestCount" && value.queuedEvidenceRequestCountContract !== "explicit-result-evidence-request-count-v1" ? null : value[key])]));
  if (Object.values(counts).every((count) => count === null)) return null;
  const pending = counts.reviewRequiredItemCount > 0 || counts.queuedEvidenceRequestCount > 0;
  return { version: 1, jobStatus: "completed", jobId: clean(value.jobId, 100) || null,
    observedAt: summaryTimestamp(value.observedAt), finishedAt: summaryTimestamp(value.finishedAt), ...counts,
    queuedEvidenceRequestCountContract: value.queuedEvidenceRequestCountContract === "explicit-result-evidence-request-count-v1" ? "explicit-result-evidence-request-count-v1" : null,
    businessStatus: pending ? "pending" : counts.reviewRequiredItemCount === null || counts.queuedEvidenceRequestCount === null ? "unknown" : "no-pending-reported",
    scope: "observed-job-completion-result-not-live-resolution-queue",
    units: { createdAccountCount: "new-account-targets", reusedExistingRowCount: "source-rows-not-distinct-accounts",
      reviewRequiredItemCount: "review-items-including-duplicates-or-conflicts-not-distinct-authors", queuedEvidenceRequestCount: "evidence-requests-not-distinct-authors-or-new-queue-items" },
    note: "任务处理完成不等于全部作者已接入监控，也不证明已取得首次采样。" };
}

export function completedSourceJobSummary(job, jobId, observedAt = new Date().toISOString()) {
  if (job?.status !== "completed" || !job.result || typeof job.result !== "object"
    || (job.id && String(job.id) !== String(jobId))) return null;
  return projectSourceJobSummary({ version: 1, jobStatus: "completed", jobId, observedAt, finishedAt: job.finishedAt,
    createdAccountCount: job.result.createdCount, reusedExistingRowCount: job.result.reusedExistingCount,
    reviewRequiredItemCount: job.result.reviewRequiredCount, queuedEvidenceRequestCount: job.result.queuedEvidenceRequestCount,
    queuedEvidenceRequestCountContract: "explicit-result-evidence-request-count-v1" });
}

export const MAX_SOURCE_JOB_READTHROUGH = 50;

function sourceJobBindingMatches(source, request) {
  const normalizeUrl = (value) => {
    if (typeof value !== "string" || !value.trim()) return null;
    try { const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password) return null; url.hash = ""; url.searchParams.sort(); return url.href; }
    catch { return null; }
  };
  const sourceUrl = normalizeUrl(source.sourceUrl);
  if (!sourceUrl || sourceUrl !== normalizeUrl(request?.sourceUrl)) return false;
  if (!source.sourceSheetId && !source.sheetName) return false;
  if ((source.defaultBoard ?? "") !== (request?.defaultBoard ?? "")) return false;
  return ["sourceSheetId", "sheetName"].every((field) => !source[field]
    || (typeof request?.[field] === "string" && request[field] === source[field]));
}

// Read-through is a numeric historical projection only. Never repair a stored
// receipt, enqueue work, or expose the underlying job request/result rows.
function historicalSummaryReader(lookupCompletedJob, observedAt) {
  const cache = new Map();
  return (source) => {
    if (source?.sourceJobSummary != null) return source.lastJobId && source.sourceJobSummary.jobId !== source.lastJobId
      ? null : projectSourceJobSummary(source.sourceJobSummary);
    const id = source?.lastJobId;
    if (typeof lookupCompletedJob !== "function" || typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id)) return null;
    if (cache.has(id)) {
      const cached = cache.get(id);
      return cached && sourceJobBindingMatches(source, cached.binding) ? cached.summary : null;
    }
    if (cache.size >= MAX_SOURCE_JOB_READTHROUGH) return null;
    cache.set(id, null);
    try {
      const job = lookupCompletedJob(id);
      if (job && typeof job.then === "function") { Promise.resolve(job).catch(() => {}); return null; }
      if (!job || job.id !== id || job.status !== "completed" || !summaryTimestamp(job.finishedAt)
        || Date.parse(job.finishedAt) > Date.parse(observedAt)) return null;
      const summary = completedSourceJobSummary(job, id, observedAt);
      const binding = Object.fromEntries(["sourceUrl", "sourceSheetId", "sheetName", "defaultBoard"].map((key) => [key, job.request?.[key]]));
      cache.set(id, { summary, binding });
      return sourceJobBindingMatches(source, binding) ? summary : null;
    } catch { return null; }
  };
}

function currentSourceJobReader(lookupJobState, observedAt) {
  const cache = new Map(), active = new Set(), unknown = new Set(), failed = new Set();
  const time = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return NaN;
    const ms = Date.parse(value);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19) ? ms : NaN;
  };
  const now = Date.parse(observedAt);
  const valid = (job, id) => {
    if (!job || job.id !== id || !['queued','running','completed','failed'].includes(job.status)) return false;
    if (!job.request || typeof job.request !== 'object' || Array.isArray(job.request)
      || ![['sourceUrl',2000],['sourceSheetId',120],['sheetName',120],['defaultBoard',120]]
        .every(([key, limit]) => job.request[key] == null || typeof job.request[key] === 'string' && job.request[key].length <= limit)) return false;
    const created = time(job.createdAt), updated = time(job.updatedAt), started = job.startedAt == null ? null : time(job.startedAt), finished = job.finishedAt == null ? null : time(job.finishedAt);
    if (!Number.isFinite(created) || !Number.isFinite(updated) || created > updated || updated > now
      || started !== null && (!Number.isFinite(started) || started < created || started > updated)) return false;
    if (['queued','running'].includes(job.status)) return finished === null && (job.status !== 'running' || started !== null);
    return Number.isFinite(finished) && finished >= (started ?? created) && finished <= updated;
  };
  return {
    read(source, index) {
      const id = source?.lastJobId;
      if ((id === undefined || id === null || id === '') && source?.lastStatus !== 'pending') return 'none';
      const safeId = typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id);
      const reference = safeId ? `job:${id}` : `source:${index}`;
      const unverified = () => { unknown.add(reference); return 'unknown'; };
      if (!safeId || typeof lookupJobState !== 'function') return unverified();
      if (!cache.has(id)) {
        if (cache.size >= MAX_SOURCE_JOB_READTHROUGH) return unverified();
        cache.set(id, null);
        try {
          const job = lookupJobState(id);
          if (job && typeof job.then === 'function') Promise.resolve(job).catch(() => {});
          else if (valid(job, id)) cache.set(id, job);
        } catch { /* An unreadable durable state remains unknown. */ }
      }
      const job = cache.get(id);
      if (!job || !sourceJobBindingMatches(source, job.request)) return unverified();
      if (['queued','running'].includes(job.status)) active.add(id);
      if (job.status === 'failed') failed.add(id);
      return job.status;
    },
    summary: () => ({ activeJobCount: unknown.size ? null : active.size, activeJobUnknownCount: unknown.size,
      currentFailedJobCount: failed.size, activeJobCountUnit: 'distinct-latest-source-import-jobs-not-authors',
      activeJobUnknownCountUnit: 'distinct-unverified-latest-job-references-not-authors',
      currentJobScope: 'registered-source-latest-import-jobs-not-author-identity-queue' }),
  };
}

export function sourceNeedsInitialCheck(source, receipt) {
  if (!receipt) return true;
  // An accepted import remains owned by its original durable job. Finish
  // observing it before considering a changed read policy for a new import.
  if (receipt.lastStatus === "pending") return false;
  if (receipt.readContract) return receipt.readContract !== sourceReadContract(source);
  // Existing author receipts predate policy fingerprints. Do not reread the
  // entire historical inventory merely to migrate that optional field.
  return (source?.monitorOnly === true) !== (receipt.monitorOnly === true)
    || clean(source?.readPolicy, 80) !== clean(receipt.readPolicy, 80);
}

/** Read the durable source-poller receipt without opening or mutating SQLite. */
export function inspectSourcePollManifest(filePath, { now = new Date(), registryPath = null, lookupCompletedJob = null, lookupJobState = null } = {}) {
  const checkedAt = now instanceof Date && Number.isFinite(now.getTime()) ? now.toISOString() : new Date().toISOString();
  let manifest;
  let manifestMissing = false;
  try { manifest = JSON.parse(readFileSync(filePath, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") { manifestMissing = true; manifest = { sources: {}, updatedAt: null }; }
    else return { status: "error", checkedAt, sourceCount: 0, failedCount: 0, updatedAt: null, sources: [], error: "来源轮询清单无法读取" };
  }
  if (!manifest || typeof manifest !== "object" || !manifest.sources || typeof manifest.sources !== "object") {
    return { status: "error", checkedAt, sourceCount: 0, failedCount: 0, updatedAt: null, sources: [], error: "来源轮询清单格式无效" };
  }
  const inventory = { ...manifest.sources };
  let registryError = null;
  const registryKeys = new Set();
  if (registryPath) {
    try {
      const registry = JSON.parse(readFileSync(registryPath, "utf8"));
      if (!Array.isArray(registry.sources)) throw new Error("invalid registry");
      for (const source of registry.sources) {
        if (!source || typeof source !== "object" || !source.sourceUrl) continue;
        const key = sourcePollKey(source);
        registryKeys.add(key);
        if (!inventory[key]) inventory[key] = { ...source, key, sourceTitle: source.sourceTitle || source.title,
          readMode: source.readPolicy === "unresolved-alias" ? "unresolved-alias" : source.monitorOnly === true ? "workbook-metadata" : "author-table",
          lastStatus: "unchecked", lastCheckedAt: null, lastError: null };
        else inventory[key] = { ...inventory[key],
          ...(sourceNeedsInitialCheck(source, inventory[key]) ? {
            previousStatus: inventory[key].lastStatus, lastStatus: "unchecked", lastCheckedAt: null, lastSuccessfulAt: null,
          } : {}),
          // Catalog policy describes how this source may be read, even when
          // its first attempt failed. Never replace the historical result.
          monitorOnly: source.monitorOnly === true, kind: clean(source.kind, 80),
          resolveWorkLinks:source.resolveWorkLinks===true,
          readPolicy: clean(source.readPolicy, 80),
          readMode: source.readPolicy === "unresolved-alias" ? "unresolved-alias" : source.monitorOnly === true ? "workbook-metadata" : "author-table",
        };
      }
    } catch { registryError = "来源目录无法读取；不能确认完整检查分母"; }
  }
  const readSummary = historicalSummaryReader(lookupCompletedJob, checkedAt);
  const readCurrent = currentSourceJobReader(lookupJobState, checkedAt);
  const sources = Object.values(inventory).map((source, index) => ({
    key: clean(source?.key, 80),
    title: clean(source?.sourceTitle, 200),
    board: clean(source?.defaultBoard, 120),
    revision: Number.isSafeInteger(Number(source?.sourceRevision)) ? Number(source.sourceRevision) : 0,
    lastStatus: ["unchanged", "submitted", "changed", "failed", "blocked", "pending", "unchecked"].includes(String(source?.lastStatus)) ? String(source.lastStatus) : "unknown",
    readMode: clean(source?.readMode, 80) || "author-table",
    monitorOnly: source?.monitorOnly === true,
    kind: clean(source?.kind, 80),
    readPolicy: clean(source?.readPolicy, 80),
    sourceJobSummary: readSummary(source),
    ...(source.resolveWorkLinks!==false&&projectWorkLinkResolution(source.workLinkResolution)
      ?{workLinkResolution:projectWorkLinkResolution(source.workLinkResolution)}:{}),
    currentJobState: readCurrent.read(source, index),
    hasImportJob: Boolean(source?.lastJobId),
    lastCheckedAt: clean(source?.lastCheckedAt, 40),
    lastSuccessfulAt: clean(source?.lastSuccessfulAt, 40) || null,
    lastError: source?.lastStatus === "pending" && !hasRecoverableSourceJob(source)
      ? "导入回执缺少可恢复的任务编号；自动恢复已暂停，未重新提交重复任务"
      : ["failed", "blocked", "pending"].includes(source?.lastStatus) ? clean(source?.lastError, 500) : null,
  }));
  const failed = sources.filter((source) => source.lastStatus === "failed");
  const blocked = sources.filter((source) => source.lastStatus === "blocked");
  const pending = sources.filter((source) => source.lastStatus === "pending");
  const unchecked = sources.filter((source) => source.lastStatus === "unchecked");
  const businessPendingCount = sources.filter((source) => source.sourceJobSummary?.businessStatus === "pending").length;
  const workLinkIncompleteCount=sources.filter(s=>s.workLinkResolution?.unresolved>0
    ||s.workLinkResolution&&s.workLinkResolution.status!=='completed').length;
  const currentJobs = readCurrent.summary();
  const businessDate = businessDateKey(checkedAt);
  const current = (source) => businessDateKey(source.lastCheckedAt) === businessDate && Date.parse(source.lastCheckedAt) <= Date.parse(checkedAt);
  const successful = (source) => ["submitted", "unchanged", "changed"].includes(source.lastStatus);
  const staleCount = sources.filter((source) => !current(source)).length;
  return {
    status: registryError ? "error" : manifestMissing ? "not-installed"
      : failed.length || blocked.length || pending.length || currentJobs.activeJobCount || currentJobs.activeJobUnknownCount || currentJobs.currentFailedJobCount
        || workLinkIncompleteCount || unchecked.length || staleCount || !sources.length || sources.some((source) => source.lastStatus === "unknown") ? "warning" : "ok",
    checkedAt,
    businessDate,
    updatedAt: clean(manifest.updatedAt, 40) || null,
    sourceCount: sources.length,
    inventoryDefinition: "durable-manifest-plus-current-registry; manifest-only entries are not implicitly retired",
    registrySourceCount: registryKeys.size,
    manifestOnlyCount: Object.keys(manifest.sources).filter((key) => !registryKeys.has(key)).length,
    failedCount: failed.length,
    blockedCount: blocked.length,
    pendingCount: pending.length,
    businessPendingCount,
    businessPendingCountUnit: "sources-with-pending-business-outcome-not-authors",
    workLinkIncompleteCount,workLinkIncompleteCountUnit:'sources-with-unresolved-work-references-not-sampling-coverage',
    historicalReviewSourceCount: businessPendingCount,
    historicalReviewSourceCountUnit: 'sources-with-historical-pending-completion-receipts-not-authors',
    ...currentJobs,
    ...(registryError ? { activeJobCount: null } : {}),
    businessSummaryMissingCount: sources.filter((source) => source.hasImportJob && !source.sourceJobSummary).length,
    pendingResumeBlockedCount: Object.values(inventory).filter((source) => source.lastStatus === "pending" && !hasRecoverableSourceJob(source)).length,
    uncheckedCount: unchecked.length,
    ...(registryError ? { error: registryError } : {}),
    staleCount,
    checkedTodayCount: sources.filter(current).length,
    successfulTodayCount: sources.filter((source) => current(source) && successful(source)).length,
    intervalMs: Number.isSafeInteger(manifest.intervalMs) && manifest.intervalMs > 0 ? manifest.intervalMs : null,
    sources,
  };
}
