import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { MonitorDatabase, normalizeBoardKey, normalizeBoardName } from "./lib/database.mjs";
import { MonitorScheduler } from "./lib/scheduler.mjs";
import { RefreshCollection } from "./lib/refresh-collection.mjs";
import { SQLiteBackupManager } from "./lib/backup-manager.mjs";
import { createScheduledBackupThrottle } from "./lib/scheduled-backup-throttle.mjs";
import { inspectLatestBackup } from "./lib/backup-audit.mjs";
import { recordPostIngestionReview, inspectPostIngestionReviews, summarizePostIngestionReviewQueue } from "./lib/post-ingestion-review.mjs";
import { nextPostIngestionRecoveryCursor, recoverPostIngestionReviewWindow } from "./lib/post-ingestion-recovery.mjs";
import { normalizeManualCollection } from "./lib/providers/normalize.mjs";
import { PublicWebProvider } from "./lib/providers/public-web.mjs";
import { ownedCollectorExecutor } from "./lib/collector-ownership.mjs";
import { AUTHOR_UPLOAD_LIMITS, authorPreviewContentSha256, canonicalAccountLocator, markExistingAuthors, normalizeAccountLocator, normalizePlatform, parseAuthorSpreadsheet, projectAuthorPreviewRows, validateSubmittedAccountId } from "./lib/author-spreadsheet.mjs";
import { applyAuthorEvidence, buildAuthorEvidenceRequests, summarizeAuthorAccountIdentities, summarizeQueuedAuthorEvidence, verifyQueuedAuthorEvidence } from "./lib/author-resolution.mjs";
import { authorQueuePlatform, queuedAuthorAccountLocator, queuedBilibiliId } from "./lib/author-queue-identity.mjs";
import { exportLarkSheetWorkbook, normalizeLarkSheetUrl } from "./lib/lark-sheet-source.mjs";
import { normalizeBitableAuthorSource } from "./lib/author-source-provenance.mjs";
import { prepareAuthorBoardImport } from "./lib/author-board-import.mjs";
import { projectImportReview } from "./lib/import-review.mjs";
import { enrichImportReviewCurrent } from "./lib/import-review-current.mjs";
import { readImportMonitoringStatus } from "./lib/import-monitoring-status.mjs";
import { recordImportAuthorisedAttempt } from './lib/import-authorised-attempts.mjs';
import { runAuthorisedQueueCycle, deferAuthorisedQueueClaim, isCurrentAuthorQueueClaim } from './lib/authorised-queue-cycle.mjs';
import { AccessControl, HttpError, clientIp } from "./lib/access-control.mjs";
import { startupApiGate } from "./lib/startup-readiness.mjs";
import { schedulerReadiness, schedulerScheduleHealthy } from "./lib/runtime-audit.mjs";
import { SystemAuditReader } from "./lib/system-audit-reader.mjs";
import {
  businessDateKey,
  csvEscape,
  csvTextEscape,
  isCalendarDate,
  localDateKey,
  normalizeTag,
  parseTimeOfDay,
  shiftCalendarDate,
} from "./lib/utils.mjs";
import { getProductInsights, getAccountInsight } from "./lib/product-insights.mjs";
import { ConsoleReader } from "./lib/console-reader.mjs";
import { accountHistoryOptions } from "./lib/account-history-options.mjs";
import { getProductContinuity, getAuthorSources } from "./lib/product-continuity.mjs";
import { inspectSourcePollManifest } from "./lib/source-poller-status.mjs";
import { createSourceJobStateReader } from "./lib/source-job-state-read.mjs";
import { readUpdateSla } from "./lib/update-sla.mjs";
import { runFirstCollectionTick } from "./lib/first-collection.mjs";
import { readPublicEntry } from "./lib/public-entry.mjs";
import { reportCsv } from "./lib/report-export.mjs";
import { readMasterRoster } from "./lib/master-roster.mjs";
import { prepareMasterRosterSupplement, assertMasterRosterSupplementJob, buildMasterRosterSupplementReceipt, validatedSuccessProof } from "./lib/master-roster-supplement.mjs";
import { prepareImportAuthorisedDetail } from './lib/import-authorised-detail.mjs';
import { commitAuthorisedImportDetail } from './lib/authorised-import-service.mjs';
import { drainPostIngestionReviewForShutdown, drainSchedulerForShutdown } from "./lib/shutdown-drain.mjs";
import { SOURCE_POLLER_CAPABILITY_HEADER, capabilityMatches, ensureSourcePollerCapability, isLoopbackAddress } from "./lib/internal-source-capability.mjs";

export function productInsightOptions(searchParams) {
  const period = searchParams.get("period") || "week";
  if (!["day", "week", "month", "30d", "custom"].includes(period)) throw new HttpError(400, "不支持的统计周期");
  const options = { period, timeZone: "Asia/Shanghai" };
  if (searchParams.has("comparisonProjection")) {
    const projection = searchParams.get("comparisonProjection");
    if (projection !== "summary") throw new HttpError(400, "不支持的对比数据投影");
    options.comparisonProjection = projection;
  }
  const classification = String(searchParams.get("classification") || "all").trim().slice(0, 80);
  if (classification) options.classification = classification;
  const theme = String(searchParams.get("theme") || "all").trim().slice(0, 80);
  if (theme) options.theme = theme;
  const dateKeys = ["startDate", "endDate", "comparisonStartDate", "comparisonEndDate"];
  for (const key of dateKeys) {
    if (!searchParams.has(key)) continue;
    const value = searchParams.get(key);
    const date = new Date(`${value}T12:00:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}` !== value) throw new HttpError(400, "日期必须为有效的 YYYY-MM-DD");
    options[key] = value;
  }
  if (period === "custom" || options.startDate || options.endDate) {
    if (!options.startDate || !options.endDate) throw new HttpError(400, "请同时填写开始与结束日期");
    // An explicit single day freezes the requested Beijing day across a
    // client/server midnight boundary without weakening daily comparability.
    options.period = period === "day" && options.startDate === options.endDate ? "day" : "custom";
  }
  const now = new Date();
  const today = businessDateKey(now, "Asia/Shanghai");
  for (const [start, end] of [[options.startDate, options.endDate], [options.comparisonStartDate, options.comparisonEndDate]]) {
    if (!start && !end) continue;
    if (!start || !end) throw new HttpError(400, "每个对比时段都需要完整的起止日期");
    if (start > end || end > today || (Date.parse(end) - Date.parse(start)) / 86400000 >= 366) throw new HttpError(400, "日期不能倒序或晚于今天，每段最多 366 天");
  }
  return options;
}

export function topicHistoryOptions(searchParams, reference = new Date()) {
  const today = businessDateKey(reference);
  const endDate = String(searchParams.get("endDate") || today).trim();
  let startDate = String(searchParams.get("startDate") || "").trim();
  if (!startDate) {
    const days = Math.max(1, Math.min(366, Math.trunc(Number(searchParams.get("days")) || 7)));
    if (!isCalendarDate(endDate)) {
      throw new HttpError(400, "话题历史结束日期必须为有效的 YYYY-MM-DD");
    }
    startDate = shiftCalendarDate(endDate, -days + 1);
  }
  for (const [label, value] of [["开始日期", startDate], ["结束日期", endDate]]) {
    if (!isCalendarDate(value)) {
      throw new HttpError(400, `话题历史${label}必须为有效的 YYYY-MM-DD`);
    }
  }
  if (startDate > endDate || endDate > today) throw new HttpError(400, "话题历史日期不能倒序或晚于今天");
  const days = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000) + 1;
  if (days > 366) throw new HttpError(400, "话题历史最多支持 366 天");
  return { startDate, endDate, days, timeZone: "Asia/Shanghai" };
}

function reportReference(searchParams) {
  const raw = searchParams.get("date");
  if (!raw) return new Date();
  if (isCalendarDate(raw)) return new Date(`${raw}T23:59:59.999+08:00`);
  return new Date(raw);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
const projectDir = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(projectDir, "public");
const dataDir = resolve(projectDir, process.env.DATA_DIR || "data");
const ingestionReviewDir = join(dataDir, "ingestion-reviews");
// The Bitable poller submits already-normalized rows rather than file bytes.
// A local, private capability proves that this exceptional path originated
// from our source-poller process instead of an editor-controlled HTTP body.
const sourcePollerCapability = await ensureSourcePollerCapability(dataDir);
const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 4188);
const database = new MonitorDatabase(join(dataDir, "douyin-monitor.sqlite"));
// Persist the rollout boundary once. Subsequent restarts must repair every
// missing receipt since activation, not just the newest completed batch.
database.db.prepare(`INSERT OR IGNORE INTO settings(key,value,updated_at)
  VALUES('postIngestionReviewStartRunId',?,?)`).run(
  String(Math.min(
    database.db.prepare("SELECT id FROM runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1").get()?.id || 1,
    database.db.prepare("SELECT MIN(id) AS id FROM runs WHERE finished_at IS NULL").get()?.id || Number.MAX_SAFE_INTEGER,
  )),
  new Date().toISOString(),
);
const ingestionReviewStartRunId = Number(database.getSettings().postIngestionReviewStartRunId);
let ingestionReviewQueueStatus = { status: "starting", pendingCount: null, checkedAt: null };
let ingestionReviewChain = Promise.resolve();
function reviewPersistedBatches() {
  ingestionReviewChain = ingestionReviewChain.catch(() => {}).then(async () => {
    try {
      const storedCursor = Number(database.getSettings().postIngestionReviewRecoveryCursor);
      const fromRunId = Number.isSafeInteger(storedCursor) && storedCursor >= ingestionReviewStartRunId
        ? storedCursor : ingestionReviewStartRunId;
      const result = await recoverPostIngestionReviewWindow({ database, ledgerDir: ingestionReviewDir,
        fromRunId, creationLimit: 50, scanLimit: 1000, maxPages: 8,
        shouldStop: () => shuttingDown });
      const recoveryCursor = nextPostIngestionRecoveryCursor({ activationRunId: ingestionReviewStartRunId,
        currentRunId: fromRunId, result });
      // Only advance across durably verified immutable receipts. Failed/open
      // runs keep their exact cursor; future startups do not rescan every old
      // receipt or become stuck forever at the same 8,000-row budget.
      database.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('postIngestionReviewRecoveryCursor',?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
        .run(String(recoveryCursor), new Date().toISOString());
      ingestionReviewQueueStatus = { ...result,
        activationRunId: ingestionReviewStartRunId, recoveryCursor,
        pendingCount: result.recoveryIncomplete && !result.pendingRunIds.length ? null : result.pendingRunIds.length,
        failedCount: result.failedRunIds.length, checkedAt: new Date().toISOString() };
      return result;
    } catch (error) {
      ingestionReviewQueueStatus = { status: "error", pendingCount: null, checkedAt: new Date().toISOString(), error: "入库后审查记录待恢复" };
      console.error("入库后审查队列失败：", error.message);
      return ingestionReviewQueueStatus;
    }
  });
  return ingestionReviewChain;
}
function reviewCommittedBatch(runId) {
  ingestionReviewChain = ingestionReviewChain.catch(() => {}).then(async () => {
    try {
      // The normal hot path is per-run and idempotent. History reconciliation
      // belongs to startup/recovery, not every account's completion callback.
      const result = await recordPostIngestionReview({ database, ledgerDir: ingestionReviewDir, runId });
      ingestionReviewQueueStatus = { ...ingestionReviewQueueStatus,
        lastRecordedRunId: Number(runId), lastRecordStatus: result.status,
        lastRecordMode: "single-committed-run", lastRecordedAt: new Date().toISOString() };
      return result;
    } catch (error) {
      // Do not hide earlier recovery failures or turn persisted data into a
      // failed collection merely because its separate receipt needs repair.
      const failedRunId = Number(runId);
      if (Number.isSafeInteger(failedRunId) && failedRunId >= ingestionReviewStartRunId) {
        try {
          const saved = Number(database.getSettings().postIngestionReviewRecoveryCursor);
          const cursor = Number.isSafeInteger(saved) && saved >= ingestionReviewStartRunId
            ? saved : ingestionReviewStartRunId;
          database.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('postIngestionReviewRecoveryCursor',?,?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
            .run(String(Math.min(cursor, failedRunId)), new Date().toISOString());
        } catch {
          console.error("缺失回执的恢复游标暂未保存；需要从激活边界核查。");
        }
      }
      ingestionReviewQueueStatus = { ...ingestionReviewQueueStatus, status: "error",
        lastFailedRunId: Number(runId), lastRecordMode: "single-committed-run",
        checkedAt: new Date().toISOString(), error: "入库后审查记录待恢复" };
      console.error("本批入库后审查记录失败：", error.message);
      return ingestionReviewQueueStatus;
    }
  });
  return ingestionReviewChain;
}
// The rebuilt console reads its analytics in an isolated read-only worker. The
// collector and legacy APIs keep using the write connection; a slow 765-account
// aggregation therefore cannot freeze the HTTP event loop or daily scheduler.
const consoleReader = new ConsoleReader({ databasePath: database.filePath });
const shutdownController = new AbortController();
const worksOnlyShutdownController = new AbortController();
const backupManager = new SQLiteBackupManager({
  databasePath: database.filePath,
  backupDir: join(dataDir, "backups", "automatic"),
  retention: 14,
});
// First-sample micro-batches can finish every 30 seconds. They still commit
// immediately; only redundant full-database automatic copies are coalesced.
const scheduledBackup = createScheduledBackupThrottle(backupManager, { minIntervalMs: 600_000 });
const systemAuditReader = new SystemAuditReader({ databasePath: database.filePath, backupDir: backupManager.backupDir });
const scheduler = new MonitorScheduler(database, {
  asyncPlanning: true,
  scheduleIntervalHours: 8,
  worksOnlyEnabled: true,
  scheduleTimeZone: "Asia/Shanghai",
  providerOptions: { signal: shutdownController.signal },
  worksOnlySignal: worksOnlyShutdownController.signal,
  scheduledSourceProbe: true,
  onRunComplete: async (result) => {
    consoleReader.invalidate();
    // The run has already committed. A review failure cannot undo observations
    // or suppress the independent backup; it remains visible in service logs.
    await reviewCommittedBatch(result.runId);
    if (result.triggerType !== "scheduled") return;
    const resultBackup = await scheduledBackup(`scheduled-${result.status}`);
    if (resultBackup.status === "succeeded") console.log(`自动备份已完成：${resultBackup.backup.path}`);
    else if (resultBackup.status === "throttled") console.log(`自动备份已合并：10 分钟内已有成功备份；下次可备份 ${resultBackup.nextEligibleAt}`);
    else console.log("自动备份本次未创建：已有备份进程运行或未满足备份条件");
  },
});
const requestReadScopes = new WeakMap();
const refreshCollection = new RefreshCollection({ database, scheduler });
function createRequestReadScope(request, response) {
  const controller = new AbortController();
  const abort = () => { if (!response.writableEnded) controller.abort(); };
  request.once('aborted', abort);
  response.once('close', abort);
  if (request.aborted || response.destroyed) abort();
  return {
    signal: AbortSignal.any([controller.signal, shutdownController.signal]),
    dispose() { request.off('aborted', abort); response.off('close', abort); },
  };
}
async function requestScopedRead(request, response, operation) {
  const existing = requestReadScopes.get(request);
  const scope = existing || createRequestReadScope(request, response);
  const { signal } = scope;
  let onAbort;
  try {
    if (signal.aborted) throw Object.assign(new Error('读取已取消'), { code: 'CONSOLE_READER_ABORTED', status: 499 });
    const aborted = new Promise((resolve, reject) => {
      onAbort = () => reject(Object.assign(new Error('读取已取消'), { code: 'CONSOLE_READER_ABORTED', status: 499 }));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([operation(signal), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!existing) scope.dispose();
  }
}
function readSchedulerStatus(request, response, now = new Date()) {
  return requestScopedRead(request, response, signal => scheduler.getStatusAsync(now, { signal }));
}
const access = new AccessControl(database, { port });
const authorQueueWorkerId = `server-${randomUUID()}`;
const authorJobWorkerId = `author-job-${randomUUID()}`;
let authorQueueTimer = null;
let authorQueueRunning = false;
let authorDetailProbeRunning = false;
let authorDetailProbeNotBefore = 0;
const activeAuthorDetailProbes = new Set();
let authorJobTimer = null;
let authorJobRunning = false;
let shuttingDown = false;
function assertCollectionServerReady() {
  if (shuttingDown) throw new HttpError(503, "服务正在关闭，本次采集请求未执行；请稍后重试", "SERVER_SHUTTING_DOWN");
}
let startupReadiness = {
  status: isMainModule ? "starting" : "ready",
  message: isMainModule ? "正在完成启动备份与严格身份迁移" : "",
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

const RESPONSE_COMPRESSION_THRESHOLD = 1024;

function maybeCompressResponse(response, payload, contentType, extraHeaders = {}) {
  const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const acceptsGzip = /(?:^|,|\s)gzip(?:\s*;|\s|,|$)/i.test(String(response.req?.headers?.["accept-encoding"] || ""));
  // Do not compress downloads.  They already have an explicit content
  // disposition and callers expect the exported bytes to remain stable.
  const isDownload = Object.keys(extraHeaders).some((key) => key.toLowerCase() === "content-disposition");
  if (!acceptsGzip || isDownload || raw.length < RESPONSE_COMPRESSION_THRESHOLD || !/^\s*(?:application\/json|text\/)/i.test(String(contentType))) {
    return { body: raw, encoding: null };
  }
  const compressed = gzipSync(raw, { level: 6 });
  return compressed.length < raw.length ? { body: compressed, encoding: "gzip" } : { body: raw, encoding: null };
}

function json(response, status, body) {
  const payload = JSON.stringify(body);
  const compressed = maybeCompressResponse(response, payload, "application/json; charset=utf-8");
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": compressed.body.length,
    "Cache-Control": "no-store",
    "Vary": "Accept-Encoding",
    ...SECURITY_HEADERS,
  };
  if (compressed.encoding) headers["Content-Encoding"] = compressed.encoding;
  response.writeHead(status, headers);
  response.end(compressed.body);
}

function text(response, status, body, contentType = "text/plain; charset=utf-8", extraHeaders = {}) {
  const compressed = maybeCompressResponse(response, body, contentType, extraHeaders);
  const headers = { "Content-Type": contentType, "Content-Length": compressed.body.length, "Vary": "Accept-Encoding", ...SECURITY_HEADERS, ...extraHeaders };
  if (compressed.encoding) headers["Content-Encoding"] = compressed.encoding;
  response.writeHead(status, headers);
  response.end(compressed.body);
}

async function readJson(request, maxBytes = 2_000_000) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`请求内容超过 ${Math.ceil(maxBytes / 1_000_000)}MB 限制`);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("请求不是合法 JSON"); }
}

function decodeSpreadsheetUpload(body) {
  const fileName = basename(String(body.fileName ?? "").trim()).slice(0, 240);
  if (!fileName) throw new Error("缺少文件名");
  const encoded = String(body.contentBase64 ?? "").replace(/\s/g, "");
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("上传内容不是合法 Base64");
  const buffer = Buffer.from(encoded, "base64");
  if (!buffer.length) throw new Error("上传文件为空");
  if (buffer.length > AUTHOR_UPLOAD_LIMITS.maxFileBytes) throw new Error("文件超过 8MB 限制");
  return { fileName, buffer };
}

function sourceBoards(source) {
  const values = [source?.board, ...(Array.isArray(source?.boards) ? source.boards : [])];
  const boards = new Map();
  const fields = [["organization", 200], ["tier", 120], ["category", 120], ["owner", 120], ["filledDate", 40], ["note", 500]];
  const clean = (value, maxLength) => String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, maxLength);
  for (const value of values) {
    const name = normalizeBoardName(value && typeof value === "object" ? value.name : value);
    const key = normalizeBoardKey(name);
    if (!key) continue;
    const candidate = {
      name,
      sourceRow: Math.max(1, Math.trunc(Number(value?.sourceRow ?? value?.source?.sourceRow ?? source?.sourceRow) || 1)),
      source: value?.source && typeof value.source === "object" ? { ...value.source } : null,
      conflicts: [],
    };
    for (const [field, maxLength] of fields) {
      const aliases = field === "filledDate"
        ? value?.filledDate ?? value?.filled_date ?? source?.filledDate ?? source?.filled_date
        : field === "note"
          ? value?.note ?? value?.notes ?? value?.remark ?? value?.remarks ?? source?.note ?? source?.notes ?? source?.remark ?? source?.remarks
          : value?.[field] ?? source?.[field];
      candidate[field] = clean(aliases, maxLength);
    }
    for (const conflict of Array.isArray(value?.conflicts) ? value.conflicts : []) candidate.conflicts.push(conflict);
    const existing = boards.get(key);
    if (!existing) {
      boards.set(key, candidate);
      continue;
    }
    for (const [field] of fields) {
      if (!existing[field] && candidate[field]) existing[field] = candidate[field];
      else if (existing[field] && candidate[field] && existing[field].toLowerCase() !== candidate[field].toLowerCase()) {
        existing.conflicts.push({ field, storedValue: existing[field], incomingValue: candidate[field], incomingSource: { sourceRow: candidate.sourceRow } });
      }
    }
    existing.conflicts.push(...candidate.conflicts);
    if (!existing.source && candidate.source) existing.source = candidate.source;
  }
  return [...boards.values()];
}

function rowHasOwnershipEvidence(row) {
  return Boolean(String(row?.videoId ?? "").trim() || String(row?.shareUrl ?? "").trim());
}

function blockedAuthorRow(row) {
  return ["identity_conflict", "unresolved", "needs_locator", "resolvable", "duplicate"].includes(String(row?.status ?? ""));
}

function directAuthorLocatorKey(row) {
  if (blockedAuthorRow(row) || rowHasOwnershipEvidence(row)) return null;
  if (row?.status === "existing" && !sourceBoards(row).length) return null;
  return canonicalAccountLocator(row?.locator, row?.platform);
}

function identityConflictKey(row) {
  const canonical = canonicalAccountLocator(row?.locator, row?.platform);
  if (canonical) return canonical;
  const submitted = row?.secUid ?? row?.bilibiliId ?? row?.xiaohongshuId ?? row?.douyinId ?? row?.name;
  return `${normalizePlatform(row?.platform) || "unknown"}:${String(submitted ?? "").normalize("NFKC").trim().toLowerCase() || `row-${Math.max(1, Math.trunc(Number(row?.sourceRow) || 1))}`}`;
}

function identityConflictCount(rows) {
  return new Set(rows.filter((row) => row?.status === "identity_conflict").map(identityConflictKey)).size;
}

function needsLocatorReviewCount(rows) {
  const reviewable = rows.filter((row) => row?.status === "needs_locator" && [
    row?.name, row?.locator, row?.douyinId, row?.bilibiliId, row?.xiaohongshuId,
    row?.contentId, row?.videoId, row?.videoLink, row?.shareUrl,
  ].some((value) => String(value ?? "").trim()));
  return new Set(reviewable.map(identityConflictKey)).size;
}

function rowsEligibleForAuthorResolution(rows) {
  return rows.filter((row) => row?.status !== "needs_locator");
}

function requestedAuthorSheetName(body, source) {
  const explicit = String(body?.sheetName ?? "").normalize("NFKC").trim().slice(0, 120);
  if (explicit) return explicit;
  const requested = String(source?.requestedSheetTitle ?? "").normalize("NFKC").trim().slice(0, 120);
  if (!requested) return undefined;
  if (/说明/.test(requested) || /^(?:板块|项目|矩阵)?配置$/.test(requested)) return undefined;
  return requested;
}

const AUTHOR_PUBLIC_EVIDENCE_HOSTS = new Set([
  "douyin.com", "www.douyin.com", "v.douyin.com",
  "bilibili.com", "www.bilibili.com", "space.bilibili.com", "b23.tv",
  "xiaohongshu.com", "www.xiaohongshu.com", "xhslink.com", "www.xhslink.com",
]);
const AUTHOR_ROW_STATUSES = new Set(["ready", "resolvable", "unresolved", "identity_conflict", "existing", "duplicate", "needs_locator", "skipped"]);

function compactAuthorText(value, maxLength = 500) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/https?:\/\/[^\s，。；;,<>"']+/gi, (candidate) => {
      try {
        const parsed = new URL(candidate);
        return parsed.username || parsed.password ? "[含凭据链接已移除]" : candidate;
      } catch {
        return "[无效链接已移除]";
      }
    })
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function safeAuthorPublicUrl(value) {
  const raw = String(value ?? "").normalize("NFKC").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return "";
    if (!AUTHOR_PUBLIC_EVIDENCE_HOSTS.has(parsed.hostname.toLowerCase())) return "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function sanitizeBoardConflict(conflict) {
  return {
    field: compactAuthorText(conflict?.field, 40),
    storedValue: compactAuthorText(conflict?.storedValue, 500),
    incomingValue: compactAuthorText(conflict?.incomingValue, 500),
    incomingSource: { sourceRow: Math.max(1, Math.trunc(Number(conflict?.incomingSource?.sourceRow) || 1)) },
  };
}

function sanitizeAuthorJobRow(source) {
  const platform = normalizePlatform(source?.platform) || "douyin";
  const originalEvidence = [source?.locator, source?.videoLink, source?.videoHyperlink, source?.shareUrl].map((value) => String(value ?? "").trim()).filter(Boolean);
  const locator = normalizeAccountLocator(source?.locator, platform) || "";
  const videoLink = safeAuthorPublicUrl(source?.videoLink);
  const videoHyperlink = safeAuthorPublicUrl(source?.videoHyperlink);
  const shareUrl = safeAuthorPublicUrl(source?.shareUrl);
  const rejectedLink = compactAuthorText(source?.rejectedLink, 160) || (originalEvidence.some((value) => /^https?:\/\//i.test(value) && !safeAuthorPublicUrl(value))
    ? "非官方、非 HTTPS、含凭据或自定义端口的链接已移除"
    : "");
  const clean = compactAuthorText;
  const boards = sourceBoards(source).map((board) => ({
    name: clean(board.name, 120),
    organization: clean(board.organization, 200),
    tier: clean(board.tier, 120),
    category: clean(board.category, 120),
    owner: clean(board.owner, 120),
    filledDate: clean(board.filledDate, 40),
    note: clean(board.note, 500),
    sourceRow: Math.max(1, Math.trunc(Number(board.sourceRow ?? source?.sourceRow) || 1)),
    conflicts: (Array.isArray(board.conflicts) ? board.conflicts : []).map(sanitizeBoardConflict),
  }));
  const rawSubmittedId = compactAuthorText(source?.submittedIdRaw
    || (platform === "bilibili" ? source?.bilibiliId : platform === "xiaohongshu" ? source?.xiaohongshuId : source?.douyinId), 120);
  const submittedId = validateSubmittedAccountId(rawSubmittedId, platform);
  const status = submittedId.issue ? "needs_locator"
    : AUTHOR_ROW_STATUSES.has(String(source?.status ?? "")) ? String(source.status) : "needs_locator";
  const douyinId = platform === "douyin" ? submittedId.value : clean(source?.douyinId, 120);
  const bilibiliId = platform === "bilibili" ? submittedId.value : clean(source?.bilibiliId, 120);
  const xiaohongshuId = platform === "xiaohongshu" ? submittedId.value : clean(source?.xiaohongshuId, 120);
  return {
    sourceRow: Math.max(1, Math.trunc(Number(source?.sourceRow) || 1)),
    ...(typeof source?.sourceRecordId === "string" && /^rec[A-Za-z0-9_-]{6,120}$/.test(source.sourceRecordId) ? { sourceRecordId: source.sourceRecordId } : {}),
    board: boards[0]?.name || clean(source?.board, 120),
    boards,
    platform,
    name: clean(source?.name, 120),
    locator,
    douyinId,
    bilibiliId,
    xiaohongshuId,
    submittedIdRaw: submittedId.issue ? submittedId.raw : "",
    submittedIdIssue: submittedId.issue || "",
    contentId: clean(source?.contentId, 80),
    videoId: clean(source?.videoId, 80),
    videoLink,
    videoHyperlink,
    shareUrl,
    organization: clean(source?.organization, 200),
    tier: clean(source?.tier, 120),
    category: clean(source?.category, 120),
    owner: clean(source?.owner, 120),
    filledDate: clean(source?.filledDate, 40),
    notes: clean(source?.notes ?? source?.note, 500),
    status,
    reason: clean(submittedId.issue || source?.reason, 760),
    identityConflict: clean(source?.identityConflict, 760),
    rejectedLink,
  };
}

function safeBlockedAuthorEvidence(source, boards) {
  if (!blockedAuthorRow(source)) return {};
  const text = compactAuthorText;
  return {
    status: text(source?.status, 40),
    ...(typeof source?.sourceRecordId === "string" && /^rec[A-Za-z0-9_-]{6,120}$/.test(source.sourceRecordId) ? { sourceRecordId: source.sourceRecordId } : {}),
    // Derived from the original sanitized row before its fallback display
    // label is generated. Reconstructing from that label can change a
    // name-constrained evidence key and falsely leave reused proof pending.
    ...(source?.status === "unresolved" ? { evidenceRequestKeys: buildAuthorEvidenceRequests([source]).map((item) => item.key) } : {}),
    platform: normalizePlatform(source?.platform) || text(source?.platform, 40),
    locator: normalizeAccountLocator(source?.locator, source?.platform) || "",
    douyinId: text(source?.douyinId, 120),
    bilibiliId: text(source?.bilibiliId, 120),
    xiaohongshuId: text(source?.xiaohongshuId, 120),
    contentId: text(source?.contentId, 80),
    videoId: text(source?.videoId, 80),
    videoLink: safeAuthorPublicUrl(source?.videoLink),
    shareUrl: safeAuthorPublicUrl(source?.shareUrl),
    board: text(source?.board, 120),
    boards,
    organization: text(source?.organization, 200),
    tier: text(source?.tier, 120),
    category: text(source?.category, 120),
    owner: text(source?.owner, 120),
    filledDate: text(source?.filledDate, 40),
    note: text(source?.notes ?? source?.note, 500),
    identityConflict: text(source?.identityConflict, 760),
    rejectedLink: text(source?.rejectedLink, 160),
  };
}

function importableAuthorTargets(body, existingTargets) {
  if (!Array.isArray(body.rows)) throw new Error("缺少已审查作者行");
  if (body.rows.length > AUTHOR_UPLOAD_LIMITS.maxRows) throw new Error(`单次最多审查 ${AUTHOR_UPLOAD_LIMITS.maxRows} 行`);
  const fileName = basename(String(body.fileName ?? "未命名表格")).slice(0, 240);
  const sheetName = String(body.sheetName ?? "").trim().slice(0, 120);
  const bitableSource = normalizeBitableAuthorSource(body);
  const sourceType = bitableSource.sourceType || (body.sourceType === "lark-sheet" ? "lark-sheet" : "author-spreadsheet");
  let sourceUrl = bitableSource.sourceUrl || null;
  if (sourceType === "lark-sheet" && body.sourceUrl) {
    try { sourceUrl = normalizeLarkSheetUrl(body.sourceUrl); } catch {}
  }
  const sourceTitle = String(body.sourceTitle ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const sourceRevision = Math.max(0, Math.trunc(Number(body.sourceRevision) || 0));
  const sourceSheetId = String(body.sourceSheetId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  const sourceRange = String(body.sourceRange ?? "").replace(/[^A-Za-z0-9:$]/g, "").slice(0, 80);
  const sourceSha256 = /^[a-f0-9]{64}$/i.test(String(body.sourceSha256 ?? "")) ? String(body.sourceSha256).toLowerCase() : "";
  const sourceExportSha256 = /^[a-f0-9]{64}$/i.test(String(body.sourceExportSha256 ?? "")) ? String(body.sourceExportSha256).toLowerCase() : "";
  const sourceReadAt = Number.isNaN(new Date(body.sourceReadAt).getTime()) ? "" : new Date(body.sourceReadAt).toISOString();
  const existing = new Map();
  for (const target of existingTargets.filter((item) => item.type === "account" && item.provider === "public-web")) {
    const locatorKey = canonicalAccountLocator(target.locator, target.metadata?.platform);
    const authorKey = canonicalAccountLocator(target.known_author_id, target.metadata?.platform);
    if (locatorKey) existing.set(locatorKey, target);
    if (authorKey) existing.set(authorKey, target);
  }
  const seen = new Map();
  const inputs = [];
  const skipped = [];
  for (const source of body.rows) {
    const sourceRow = Math.max(1, Math.trunc(Number(source?.sourceRow) || 1));
    const platform = normalizePlatform(source?.platform) || "douyin";
    const locator = normalizeAccountLocator(source?.locator, platform);
    const key = canonicalAccountLocator(locator, platform);
    const submittedAccountId = platform === "bilibili" ? source?.bilibiliId : platform === "xiaohongshu" ? source?.xiaohongshuId : source?.douyinId;
    const platformName = platform === "bilibili" ? "B站" : platform === "xiaohongshu" ? "小红书" : "抖音";
    const locatorHint = String(locator ?? "").replace(/^https?:\/\//, "").slice(-12);
    const submittedName = String(source?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    const boards = sourceBoards(source);
    const label = (submittedName
      || String(submittedAccountId ?? "").replace(/\s+/g, " ").trim()
      || `${platformName}作者 · ${locatorHint || sourceRow}`).slice(0, 120);
    let reason = null;
    if (blockedAuthorRow(source)) reason = String(source?.reason || "该行未通过严格核验，未写入监控").slice(0, 760);
    else if (!locator || !key) reason = `缺少可验证的${platform === "bilibili" ? "B站 UID/主页" : platform === "xiaohongshu" ? "小红书用户 ID/主页" : "完整抖音主页、分享链接或 sec_uid"}`;
    const alreadyKnown = !reason && existing.has(key) && !boards.length;
    if (alreadyKnown) reason = "该账号已在监控列表中";
    const memberships = boards.length ? boards.map((board) => ({
      key: `${key}\u0000${normalizeBoardKey(board.name)}`,
      signature: JSON.stringify([board.organization, board.tier, board.category, board.owner, board.filledDate, board.note]),
    })) : [{ key, signature: "" }];
    if (!reason && memberships.every((membership) => seen.get(membership.key)?.has(membership.signature))) reason = "表格内同一板块重复账号且板块资料完全相同";
    if (reason) {
      skipped.push({ sourceRow, name: label, reason,
        ...(alreadyKnown ? { status: "existing", platform, locator, boards } : {}),
        ...safeBlockedAuthorEvidence(source, boards) });
      continue;
    }
    for (const membership of memberships) {
      if (!seen.has(membership.key)) seen.set(membership.key, new Set());
      seen.get(membership.key).add(membership.signature);
    }
    const metadata = {
      platform,
      importSource: {
        type: sourceType, fileName, sheetName, sourceRow, importedAt: new Date().toISOString(),
        ...(sourceType === "lark-bitable" && /^rec[A-Za-z0-9_-]{6,120}$/.test(source?.sourceRecordId || "") ? { sourceRecordId: source.sourceRecordId } : {}),
        ...(sourceUrl ? { sourceUrl } : {}), ...(sourceTitle ? { sourceTitle } : {}),
        ...(sourceType === "lark-bitable" || sourceRevision ? { sourceRevision } : {}), ...(sourceSheetId ? { sourceSheetId } : {}),
        ...(sourceRange ? { sourceRange } : {}), ...(sourceSha256 ? { sourceSha256 } : {}),
        ...(sourceExportSha256 ? { sourceExportSha256 } : {}),
        ...(sourceReadAt ? { sourceReadAt } : {}),
      },
      ...(submittedName ? { submittedName } : { autoLabelPending: true }),
      ...(source?.douyinId ? { douyinId: String(source.douyinId).trim().slice(0, 120) } : {}),
      ...(source?.bilibiliId ? { bilibiliId: String(source.bilibiliId).trim().slice(0, 120) } : {}),
      ...(source?.xiaohongshuId ? { xiaohongshuId: String(source.xiaohongshuId).trim().slice(0, 120) } : {}),
      ...(source?.videoId ? { evidenceVideoId: String(source.videoId).trim().slice(0, 40) } : {}),
      ...(source?.resolution && typeof source.resolution === "object" ? { resolution: {
        mode: String(source.resolution.mode ?? "").slice(0, 80),
        platform: String(source.resolution.platform ?? platform).slice(0, 40),
        matchedBy: String(source.resolution.matchedBy ?? "").slice(0, 40),
        evidenceVideoId: String(source.resolution.evidenceVideoId ?? "").slice(0, 40),
        publicNickname: String(source.resolution.publicNickname ?? "").slice(0, 120),
        publicDouyinId: String(source.resolution.publicDouyinId ?? "").slice(0, 120),
        canonicalAccountId: String(source.resolution.canonicalAccountId ?? "").slice(0, 240),
        canonicalAccountUrl: String(source.resolution.canonicalAccountUrl ?? "").slice(0, 500),
        evidenceUrl: String(source.resolution.evidenceUrl ?? "").slice(0, 500),
        sourceEvidenceUrl: String(source.resolution.sourceEvidenceUrl ?? "").slice(0, 500),
        endpoint: String(source.resolution.endpoint ?? "").slice(0, 500),
        provenance: String(source.resolution.provenance ?? "").slice(0, 80),
        resolvedAt: String(source.resolution.resolvedAt ?? "").slice(0, 40),
        verificationPolicy: String(source.resolution.verificationPolicy ?? "").slice(0, 80),
        verifiedEvidenceCount: Math.max(0, Math.trunc(Number(source.resolution.verifiedEvidenceCount) || 0)),
        verifiedEvidenceSha256: /^[a-f0-9]{64}$/i.test(String(source.resolution.verifiedEvidenceSha256 ?? ""))
          ? String(source.resolution.verifiedEvidenceSha256).toLowerCase()
          : "",
        verifiedEvidence: (Array.isArray(source.resolution.verifiedEvidence) ? source.resolution.verifiedEvidence : []).slice(0, 100).map((item) => ({
          sourceRow: Math.max(1, Math.trunc(Number(item?.sourceRow) || 1)),
          videoId: compactAuthorText(item?.videoId, 80),
          shareUrl: safeAuthorPublicUrl(item?.shareUrl),
          canonicalAccountId: compactAuthorText(item?.canonicalAccountId, 240),
          publicNickname: compactAuthorText(item?.publicNickname, 120),
          sourceEvidenceUrl: safeAuthorPublicUrl(item?.sourceEvidenceUrl),
          provenance: compactAuthorText(item?.provenance, 80),
        })),
        verifiedEvidenceTruncated: Boolean(source.resolution.verifiedEvidenceTruncated),
      } } : {}),
      ...(source?.organization ? { organization: String(source.organization).trim().slice(0, 200) } : {}),
      ...(source?.tier ? { tier: String(source.tier).trim().slice(0, 120) } : {}),
      ...(source?.category ? { category: String(source.category).trim().slice(0, 120) } : {}),
      ...(source?.owner ? { owner: String(source.owner).trim().slice(0, 120) } : {}),
      ...(source?.filledDate ? { filledDate: String(source.filledDate).trim().slice(0, 40) } : {}),
      ...(source?.note ?? source?.notes ? { note: String(source.note ?? source.notes).trim().slice(0, 500) } : {}),
    };
    inputs.push({ label, locator, metadata, boards });
  }
  return { fileName, sheetName, sourceType, sourceUrl, sourceTitle, inputs, skipped };
}

function hydratePreviouslyVerifiedAuthors(rows, existingTargets, receipts = []) {
  const verifiedByDouyinId = new Map();
  const targets = new Map(existingTargets.map(target => [target.id, target]));
  const accountId = value => String(value ?? "").normalize("NFKC").replace(/^@/, "").trim().toLowerCase();
  // Editable submitted IDs and legacy mutable metadata cannot prove ownership.
  for (const saved of receipts) {
    const proof = validatedSuccessProof(saved), target = targets.get(proof?.targetId);
    let metadata = target?.metadata;
    if (Object.hasOwn(saved, "current_metadata_json")) {
      try { metadata = typeof saved.current_metadata_json === "string" ? JSON.parse(saved.current_metadata_json) : null; } catch { metadata = null; }
    }
    if (!proof || proof.platform !== "douyin" || !target || target.type !== "account" || target.provider !== "public-web"
      || target.locator !== proof.canonicalAccountId || !metadata || typeof metadata !== "object" || Array.isArray(metadata)
      || (metadata.platform ?? "douyin") !== "douyin") continue;
    const id = accountId(proof.resolution.publicDouyinId);
    if (!id) continue;
    const prior = verifiedByDouyinId.get(id);
    if (verifiedByDouyinId.has(id) && prior?.target.id !== target.id) verifiedByDouyinId.set(id, null);
    else verifiedByDouyinId.set(id, { target, resolution: proof.resolution });
  }
  return rows.map((row) => {
    if (row?.locator || !row?.douyinId || row?.platform !== "douyin" || row.identityConflict
      || !["needs_locator", "resolvable", "unresolved", "ready", "existing"].includes(row.status)) return row;
    const match = verifiedByDouyinId.get(accountId(row.douyinId));
    if (!match) return row;
    const { target, resolution } = match;
    return {
      ...row,
      name: String(row.name ?? "").trim() || target.label,
      locator: target.locator,
      status: "existing",
      reason: "该抖音号已由同一公开证据链严格核验并在监控列表中",
      resolution,
    };
  });
}

function publicAuthorResolveJob(job, { skippedOffset = 0, skippedLimit = 20, includeSkipped = true } = {}) {
  const rawResult = job.result && typeof job.result === "object" ? job.result : null;
  let result = rawResult;
  if (rawResult) {
    const allSkipped = Array.isArray(rawResult.skipped) ? rawResult.skipped : [];
    const total = Math.max(allSkipped.length, Math.trunc(Number(rawResult.skippedTotal ?? rawResult.skippedCount) || 0));
    result = { ...rawResult, skippedTotal: total };
    if (includeSkipped) result.skipped = allSkipped.slice(Math.max(0, skippedOffset), Math.max(0, skippedOffset) + Math.max(0, skippedLimit));
    else delete result.skipped;
  }
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    fileName: job.fileName,
    sheetName: job.sheetName,
    createdAt: job.createdAt,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    totalAuthors: job.totalAuthors,
    totalWorkItemCount: job.totalAuthors,
    totalAuthorsDeprecated: true,
    totalWorkItemCountMeaning: "legacy-mixed-evidence-and-direct-or-review-work-items-not-distinct-authors",
    inputAccountIdentitySummary: Array.isArray(job.request?.rows) ? summarizeAuthorAccountIdentities(job.request.rows) : null,
    result,
    error: job.error ?? null,
  };
}

async function executeAuthorResolveJob(job) {
  const body = {
    ...job.request,
    rows: Array.isArray(job.request?.rows) ? job.request.rows.map(sanitizeAuthorJobRow) : [],
  };
  const claim = { owner: authorJobWorkerId, version: job.version };
  try {
    if (job.request?.masterRosterSupplement) assertMasterRosterSupplementJob(database.db, job);
    const existingTargets = database.listTargets();
    const successProofs = database.db.prepare(`SELECT proof.*,target.metadata_json AS current_metadata_json FROM author_resolution_success_receipts proof
      JOIN targets target ON target.id=proof.target_id WHERE proof.platform='douyin' ORDER BY proof.id DESC LIMIT 10001`).all();
    // An explicit ID correction must obtain fresh evidence for this exact job.
    // A past successful proof may aid ordinary imports, but cannot approve a
    // new correction or silently skip its natural-detail verification queue.
    const hydratedRows = job.request?.masterRosterSupplement?.version === 2
      ? body.rows : hydratePreviouslyVerifiedAuthors(body.rows, existingTargets, successProofs.length <= 10000 ? successProofs : []);
    const resolutionRows = rowsEligibleForAuthorResolution(hydratedRows);
    const requests = buildAuthorEvidenceRequests(resolutionRows);
    const totalAuthors = requests.length
      + new Set(hydratedRows.map(directAuthorLocatorKey).filter(Boolean)).size
      + identityConflictCount(hydratedRows)
      + needsLocatorReviewCount(hydratedRows);
    if (!database.updateAuthorResolutionJob(job.id, { phase: "resolving", totalAuthors, ...claim })) return;
    // Only an accepted, leased job may register its catalog. A rejected retry
    // must never create boards; a restart can safely repeat this idempotent step.
    for (const board of body.boardCatalog || []) database.createBoard(board.name, {
      sourceType: body.sourceType === "lark-bitable" ? "lark-bitable" : body.sourceType === "lark-sheet" ? "lark-sheet" : "author-spreadsheet",
    });
    const provider = new PublicWebProvider(database.getSettings(), { database, signal: shutdownController.signal });
    // Complete the immutable import first so the owned authorised worker can
    // bind each Douyin work to its exact source. No AI/manual batch is needed.
    const resolveImmediately = requests.length > 0 && requests.length <= 36
      && requests.every(item => item.platform !== 'douyin');
    const resolutionData = resolveImmediately
      ? await provider.resolveAuthors(requests)
      : { items: requests.map((item) => ({ key: item.key, status: "deferred", networkAttempted: false, candidates: [], errors: [] })) };
    const resolutionResult = applyAuthorEvidence(resolutionRows, resolutionData);
    let resolvedIndex = 0;
    const resolved = {
      ...resolutionResult,
      rows: hydratedRows.map((row) => row?.status === "needs_locator" ? row : resolutionResult.rows[resolvedIndex++]),
    };
    const queueRequests = buildAuthorEvidenceRequests(resolved.rows.filter((row) => row?.status === "unresolved" && /稍后自动重试/.test(String(row?.reason ?? ""))));
    // Another correction may have completed while public evidence was pending.
    // Validate synchronously before enqueuing or importing identity changes.
    if (job.request?.masterRosterSupplement) assertMasterRosterSupplementJob(database.db, job);
    if (!database.updateAuthorResolutionJob(job.id, { phase: "importing", totalAuthors, ...claim })) return;
    const queueSummary = database.enqueueAuthorResolutions(queueRequests, {
      fileName: basename(String(body.fileName ?? "未命名表格")),
      sheetName: String(body.sheetName ?? "").slice(0, 120),
      sourceMetadata: {
        sourceType: body.sourceType === "lark-bitable" ? "lark-bitable" : body.sourceType === "lark-sheet" ? "lark-sheet" : "author-spreadsheet",
        ...(body.sourceUrl ? { sourceUrl: String(body.sourceUrl).slice(0, 1_000) } : {}),
        ...(body.sourceTitle ? { sourceTitle: String(body.sourceTitle).slice(0, 200) } : {}),
        ...(body.sourceType === "lark-bitable" || Number(body.sourceRevision) > 0 ? { sourceRevision: Math.trunc(Number(body.sourceRevision)) } : {}),
        ...(body.sourceSheetId ? { sourceSheetId: String(body.sourceSheetId).slice(0, 80) } : {}),
        ...(body.sourceRange ? { sourceRange: String(body.sourceRange).slice(0, 80) } : {}),
        ...(/^[a-f0-9]{64}$/i.test(String(body.sourceSha256 ?? "")) ? { sourceSha256: String(body.sourceSha256).toLowerCase() } : {}),
        ...(/^[a-f0-9]{64}$/i.test(String(body.sourceExportSha256 ?? "")) ? { sourceExportSha256: String(body.sourceExportSha256).toLowerCase() } : {}),
        ...(body.sourceReadAt ? { sourceReadAt: String(body.sourceReadAt).slice(0, 40) } : {}),
      },
    });
    const queueOutcomes = summarizeQueuedAuthorEvidence(queueRequests, queueSummary);
    if (queueOutcomes.queuedEvidenceRequestCount > 0) scheduleAuthorResolutionQueue(1_000, true);
    const reviewed = importableAuthorTargets({ ...body, rows: resolved.rows }, existingTargets);
    const imported = database.importAuthorTargets(reviewed.inputs, {
      fileName: reviewed.fileName,
      sheetName: reviewed.sheetName,
      reviewedRows: body.rows.length,
      skippedCount: reviewed.skipped.length,
    });
    const importedInputsByLocator = new Map();
    for (const input of reviewed.inputs) {
      if (!importedInputsByLocator.has(input.locator)) importedInputsByLocator.set(input.locator, []);
      importedInputsByLocator.get(input.locator).push(input);
    }
    const reusedExisting = imported.skipped.map((item) => {
      const input = importedInputsByLocator.get(item.locator)?.shift() ?? {};
      const metadata = input.metadata ?? {};
      return {
        status: "existing",
        sourceRow: metadata.importSource?.sourceRow ?? null,
        name: input.label ?? "",
        platform: metadata.platform ?? "douyin",
        locator: normalizeAccountLocator(item.locator, metadata.platform) || "",
        boards: sourceBoards({ ...metadata, boards: input.boards }),
        organization: compactAuthorText(metadata.organization, 200),
        tier: compactAuthorText(metadata.tier, 120),
        category: compactAuthorText(metadata.category, 120),
        owner: compactAuthorText(metadata.owner, 120),
        filledDate: compactAuthorText(metadata.filledDate, 40),
        note: compactAuthorText(metadata.note, 500),
        reason: compactAuthorText(item.reason, 760),
      };
    });
    const submittedQueueKeys = new Set(queueRequests.map((item) => item.key));
    const strictReusedKeys = new Set((Array.isArray(queueSummary.evidenceReusedKeys) ? queueSummary.evidenceReusedKeys : [])
      .filter((key) => submittedQueueKeys.has(key)));
    const strictExistingKeys = new Set((Array.isArray(queueSummary.verifiedExistingEvidenceRequestKeys) ? queueSummary.verifiedExistingEvidenceRequestKeys : [])
      .filter((key) => submittedQueueKeys.has(key)));
    let evidenceReusedRowCount = 0;
    let evidenceVerifiedExistingRowCount = 0;
    const reviewedSkipped = reviewed.skipped.map((item) => {
      if (item.status !== "unresolved") return item;
      const evidenceKeys = Array.isArray(item.evidenceRequestKeys) ? item.evidenceRequestKeys : [];
      if (!evidenceKeys.length || !evidenceKeys.every((key) => strictReusedKeys.has(key) || strictExistingKeys.has(key))) return item;
      const newlyReused = evidenceKeys.some((key) => strictReusedKeys.has(key));
      if (newlyReused) evidenceReusedRowCount += 1;
      else evidenceVerifiedExistingRowCount += 1;
      // Keep source evidence in the receipt; historical proof reuse does not
      // create a ready import row, alter user boards or imply a new sample.
      return { ...item, status: "evidence_reused", historicalEvidenceOutcome: newlyReused ? "newly-reused" : "verified-existing",
        reason: newlyReused ? "已严格复用同一账号及作品的历史核验证据；未新采集、未新增作者，也未更改现有账号或板块"
          : "本次重新核对既有严格凭证通过；原核验时间保留，未新采集、未新增作者，不重复转入待审" };
    });
    const allSkipped = [...reviewedSkipped, ...reusedExisting];
    const alreadyKnownCount = reviewedSkipped.filter(item => item.status === "existing").length;
    const result = {
      ok: true,
      countSchemaVersion: 2,
      createdCount: imported.created.length,
      skippedCount: allSkipped.length,
      skippedTotal: allSkipped.length,
      reviewRequiredCount: reviewedSkipped.length - alreadyKnownCount - evidenceReusedRowCount - evidenceVerifiedExistingRowCount + imported.boardFieldConflicts.length,
      reusedExistingCount: reusedExisting.length + alreadyKnownCount,
      identityConflictCount: identityConflictCount(resolved.rows),
      needsLocatorReviewCount: needsLocatorReviewCount(resolved.rows),
      monitoringEnabled: imported.created.length,
      boardMembershipsAdded: imported.boardMembershipsAdded,
      boardMembershipsUpdated: imported.boardMembershipsUpdated,
      boardFieldConflicts: imported.boardFieldConflicts.map(sanitizeBoardConflict),
      queuedAuthors: queueOutcomes.queuedEvidenceRequestCount,
      queuedAuthorsDeprecated: true,
      queuedAuthorsMeaning: "deprecated-alias-of-queuedEvidenceRequestCount-not-distinct-authors",
      submittedEvidenceRequestCount: queueOutcomes.submittedEvidenceRequestCount,
      queuedEvidenceRequestCount: queueOutcomes.queuedEvidenceRequestCount,
      queuedEvidenceRequestCountMeaning: "evidence-requests-not-distinct-authors-or-new-queue-items",
      queuedAccountIdentitySummary: queueOutcomes.queuedAccountIdentitySummary,
      evidenceReusedEvidenceRequestCount: queueOutcomes.evidenceReusedEvidenceRequestCount,
      evidenceReusedRowCount,
      verifiedExistingEvidenceRequestCount: queueOutcomes.verifiedExistingEvidenceRequestCount,
      evidenceVerifiedExistingRowCount,
      alreadyResolvedEvidenceRequestCount: queueOutcomes.alreadyResolvedEvidenceRequestCount,
      resultScope: "job-completion-history-not-live-resolution-queue",
      queue: queueSummary,
      resolution: resolved.summary,
      created: imported.created.map(publicTarget),
      skipped: allSkipped,
    };
    if (job.request?.masterRosterSupplement) {
      const receipt = buildMasterRosterSupplementReceipt(database.db, job, resolved.rows, result);
      if (receipt) result.masterRosterSupplementReceipt = receipt;
    }
    if (!database.completeAuthorResolutionJob(job.id, result, claim)) return;
    database.recordActivity({
      userId: job.userId,
      actorName: job.actorName,
      action: "authors.auto-monitor.complete",
      resourceType: "target",
      clientIp: job.clientIp,
      details: { fileName: reviewed.fileName, createdCount: result.createdCount, skippedCount: result.skippedCount, resolution: result.resolution },
    });
  } catch (error) {
    database.failAuthorResolutionJob(job.id, error, claim);
  }
}

async function processAuthorResolutionJobs() {
  if (shuttingDown || authorJobRunning) return;
  const job = database.claimNextAuthorResolutionJob({ owner: authorJobWorkerId });
  if (!job) return;
  authorJobRunning = true;
  try { await executeAuthorResolveJob(job); }
  finally { authorJobRunning = false; }
}

async function tickAuthorResolutionJobs() {
  authorJobTimer = null;
  if (shuttingDown) return;
  try { await processAuthorResolutionJobs(); }
  catch (error) { console.error(`[${new Date().toISOString()}]`, error); }
  if (shuttingDown) return;
  const hasQueued = database.hasQueuedAuthorResolutionJobs();
  if (!hasQueued) {
    runFirstCollectionTick(database, scheduler, {
      signal: shutdownController.signal,
      canRun: () => !shuttingDown && !authorJobRunning && !authorQueueRunning,
    }).catch((error) => console.error(`[${new Date().toISOString()}] 首次采集：`, error.message));
  }
  scheduleAuthorResolutionJobs(hasQueued ? 250 : 30_000);
}

function scheduleAuthorResolutionJobs(delayMs = 250, replace = false) {
  if (shuttingDown) return;
  if (authorJobTimer && !replace) return;
  if (authorJobTimer) clearTimeout(authorJobTimer);
  authorJobTimer = setTimeout(tickAuthorResolutionJobs, Math.max(100, Number(delayMs) || 250));
}

function startAuthorResolutionJobs() { scheduleAuthorResolutionJobs(250); }

function stopAuthorResolutionJobs() {
  if (authorJobTimer) clearTimeout(authorJobTimer);
  authorJobTimer = null;
}

function queueRetryAt(attempts) {
  const minutes = [30, 60, 120, 360, 720, 1_440][Math.min(Math.max(0, Number(attempts) || 0), 5)];
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function isTerminalAuthorEvidenceError(value) {
  return /status_deleted|author_secret|status_self_see|story_25_filter|已删除|私密|仅自己可见|不可见|账号不存在/i.test(String(value ?? ""));
}

async function processAuthorResolutionQueue() {
  if (shuttingDown || authorQueueRunning || authorJobRunning || authorDetailProbeRunning || scheduler.currentPromise) return;
  const due = database.claimDueAuthorResolutions(2, { owner: authorQueueWorkerId, leaseMs: 30 * 60_000 });
  if (!due.length) return;
  authorQueueRunning = true;
  try {
    const provider = new PublicWebProvider(database.getSettings(), { database, signal: shutdownController.signal, authorisedDetailEnabled: true });
    const cycle = await runAuthorisedQueueCycle(database, due, {
      owner:authorQueueWorkerId, provider, signal:shutdownController.signal, retryAt:queueRetryAt,
      createInput:(job,row)=>importableAuthorTargets({fileName:job.fileName,sheetName:job.sheetName,
        ...(job.request ?? {}),rows:[row]},[]).inputs[0],
    });
    const legacy = cycle.legacy.filter(item => isCurrentAuthorQueueClaim(database,item,authorQueueWorkerId));
    if (!legacy.length || shuttingDown) return;
    const requests = legacy.map((item) => {
      const platform = authorQueuePlatform(item);
      return {
        key: item.identity_key,
        platform,
        name: item.name,
        accountLocator: queuedAuthorAccountLocator(item),
        douyinId: platform === "douyin" ? item.douyin_id : "",
        bilibiliId: platform === "bilibili" ? queuedBilibiliId(item) : "",
        organization: item.organization,
        tier: item.tier,
        category: item.category,
        boards: item.boards,
        videoIds: item.videoIds,
        shareUrls: item.shareUrls,
        sourceRows: item.sourceRows,
      };
    });
    const resolutionData = await provider.resolveAuthors(requests);
    const resultByKey = new Map((resolutionData.items ?? []).map((item) => [String(item?.key ?? ""), item]));
    const requestByKey = new Map(requests.map((item) => [String(item?.key ?? ""), item]));
    for (const item of legacy) {
      const evidence = resultByKey.get(item.identity_key) ?? { key: item.identity_key, candidates: [], errors: [{ error: "公开核验未返回结果" }] };
      const verification = verifyQueuedAuthorEvidence({
        ...(requestByKey.get(item.identity_key) ?? {}),
        sourceRows: item.sourceRows,
        boards: item.boards,
      }, evidence);
      const resolvedRow = verification.row;
      if (verification.status === "ready" && resolvedRow?.locator) {
        const reviewed = importableAuthorTargets({
          fileName: item.file_name,
          sheetName: item.sheet_name,
          ...(item.sourceMetadata ?? {}),
          rows: [resolvedRow],
        }, []);
        const committed = reviewed.inputs[0] ? database.commitAuthorResolutionTarget(item.id, reviewed.inputs[0], {
          fileName: item.file_name,
          sheetName: item.sheet_name,
        }, { owner: authorQueueWorkerId, evidenceVersion: item.evidence_version }) : null;
        if (!reviewed.inputs[0]) database.markAuthorResolutionRetry(item.id, reviewed.skipped[0]?.reason ?? "严格核验通过但目标写入未完成", queueRetryAt(item.attempts), { owner: authorQueueWorkerId, evidenceVersion: item.evidence_version });
        if (!committed) continue;
      } else if (["rejected", "invalid"].includes(verification.status)) {
        database.markAuthorResolutionRejected(item.id, verification.reason, { owner: authorQueueWorkerId, evidenceVersion: item.evidence_version });
      } else {
        const detail = evidence.errors?.map((entry) => entry?.error).filter(Boolean).join("；") || verification.reason;
        if (isTerminalAuthorEvidenceError(detail)) database.markAuthorResolutionRejected(item.id, `无法公开核验：${detail}`, { owner: authorQueueWorkerId, evidenceVersion: item.evidence_version });
        else database.markAuthorResolutionRetry(item.id, detail, queueRetryAt(item.attempts), { owner: authorQueueWorkerId, evidenceVersion: item.evidence_version });
      }
    }
  } catch (error) {
    // A local exception does not prove that any still-leased item reached the
    // platform. Keep its budget and never expose arbitrary provider messages.
    for (const item of due) deferAuthorisedQueueClaim(database, item, { owner: authorQueueWorkerId,
      nextAttemptAt: queueRetryAt(item.attempts), reason: '后台核验流程未完成，已安全延期；未作为平台失败消耗重试次数' });
  } finally {
    authorQueueRunning = false;
  }
}

async function tickAuthorResolutionQueue() {
  authorQueueTimer = null;
  if (shuttingDown) return;
  try {
    await processAuthorResolutionQueue();
  } catch (error) {
    console.error(`[${new Date().toISOString()}]`, error);
  }
  if (shuttingDown) return;
  const hasMoreDue = database.listDueAuthorResolutions(1).length > 0;
  scheduleAuthorResolutionQueue(hasMoreDue ? 60_000 : 30 * 60_000);
}

function scheduleAuthorResolutionQueue(delayMs = 2_000, replace = false) {
  if (shuttingDown) return;
  if (authorQueueTimer && !replace) return;
  if (authorQueueTimer) clearTimeout(authorQueueTimer);
  authorQueueTimer = setTimeout(tickAuthorResolutionQueue, Math.max(250, Number(delayMs) || 2_000));
}

function startAuthorResolutionQueue() {
  scheduleAuthorResolutionQueue(2_000);
}

function stopAuthorResolutionQueue() {
  if (authorQueueTimer) clearTimeout(authorQueueTimer);
  authorQueueTimer = null;
}

function publicTarget(target) {
  return { ...target, metadata_json: undefined, known_author_id: undefined };
}

function validateTarget(body, partial = false) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "账号资料格式无效");
  if (body.metadata !== undefined && (!body.metadata || typeof body.metadata !== "object" || Array.isArray(body.metadata))) throw new HttpError(400, "账号补充资料格式无效");
  if (Object.hasOwn(body.metadata ?? {}, "resolution")) throw new HttpError(400, "身份核验凭据由系统生成，不能通过账号编辑接口填写或覆盖");
  const type = body.type;
  const provider = body.provider;
  if (!partial && !["account", "hashtag"].includes(type)) throw new Error("目标类型必须是账号或话题");
  if (!partial && !["public-web", "manual"].includes(provider)) throw new Error("请选择有效的数据源");
  if (!partial && !String(body.locator ?? "").trim()) throw new Error("请输入平台账号主页、账号 ID 或话题名");
  if (!partial && !String(body.label ?? "").trim()) throw new Error("请输入显示名称");
  const platform = normalizePlatform(body.metadata?.platform) || "douyin";
  const rawLocator = String(body.locator ?? "").trim();
  const locator = type === "hashtag" ? normalizeTag(body.locator)
    : (!partial && provider === "public-web" ? normalizeAccountLocator(rawLocator, platform) : rawLocator);
  if (!partial && type === "account" && provider === "public-web" && !locator) {
    throw new Error(platform === "bilibili" ? "请输入 B站数字 UID 或 space.bilibili.com 官方主页"
      : platform === "xiaohongshu" ? "请输入 www.xiaohongshu.com/user/profile/<用户ID> 官方主页"
        : "请输入完整抖音主页、分享链接或 sec_uid");
  }
  return {
    ...(type ? { type } : {}),
    ...(provider ? { provider } : {}),
    ...(body.label !== undefined ? { label: String(body.label).trim().slice(0, 120) } : {}),
    ...(body.locator !== undefined ? { locator } : {}),
    ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
    ...(body.metadata || (!partial && type === "account") ? { metadata: { ...(body.metadata ?? {}),
      ...(!partial || type === "hashtag" || Object.hasOwn(body.metadata ?? {}, "platform") ? { platform: type === "hashtag" ? "douyin" : platform } : {}) } } : {}),
  };
}

function reportMarkdown(report) {
  const summary = report.summary;
  const scopeName = report.selectedBoard?.name || "全部板块";
  const observedLikes = Number(summary.likesObservedPostCount || 0);
  const missingLikes = Number(summary.likesMissingPostCount || 0);
  const viralSummary = Number(summary.postCount || 0) === 0
    ? "- 爆款作品：—（本期没有已采集发布作品，因此没有判断样本）"
    : observedLikes === 0
      ? "- 爆款作品：—（本期作品均缺少点赞证据，暂时无法判断）"
    : `- 爆款作品：${summary.viralCount ?? "—"}（仅按 ${observedLikes}/${summary.postCount} 条有点赞证据的作品判断；阈值 ${summary.viralThreshold} 赞${missingLikes ? `；另有 ${missingLikes} 条无法判断` : ""}）`;
  const viralRows = Number(summary.postCount || 0) === 0
    ? ["本期没有已采集发布作品，无法进行爆款判断。"]
    : observedLikes === 0
      ? ["本期作品均缺少点赞证据，无法判断是否达到爆款阈值。"]
    : report.viral.length
      ? report.viral.map((post, index) => `${index + 1}. ${post.author_name || "未知作者"}｜${post.likes ?? "—"} 赞｜${post.caption || "无标题"}${post.url ? `｜${post.url}` : ""}`)
      : [`${observedLikes} 条有点赞证据的作品均未达到阈值${missingLikes ? `；另有 ${missingLikes} 条缺少点赞，无法判断` : ""}。`];
  const lines = [
    `# 内容平台监控${report.period === "day" ? "日报" : report.period === "week" ? "周报" : "月报"}`,
    "",
    `统计区间：${report.start} — ${report.end}`,
    `板块：${scopeName}`,
    ...(report.scopeBasis?.description ? [`统计口径：${report.scopeBasis.description}`] : []),
    "",
    `- 发布作品：${summary.postCount}`,
    `- 活跃作者：${summary.authorCount}`,
    `- 当前累计点赞：${summary.likesCurrent ?? "—"}（${summary.likesObservedPostCount}/${summary.postCount} 条作品有值）`,
    `- 账号粉丝净增：${summary.followersDelta ?? "—"}（${summary.followersComparableTargetCount}/${summary.growthCurrentTargetCount} 个账号可比）`,
    `- 账号主页累计获赞净增：${summary.accountLikesDelta ?? "—"}（${summary.likesComparableTargetCount}/${summary.growthCurrentTargetCount} 个账号可比）`,
    `- 估算新增播放量：${summary.estimatedPlaysDelta ?? "—"}（新增点赞 × 100）`,
    `- 作品采样点赞增量：${summary.likesDelta ?? "—"}（${summary.sampledDeltaPostCount ?? 0} 条作品具备至少两次有效点赞采样）`,
    viralSummary,
    `- 主页总量已观测：${summary.profileObservedTargetCount}/${summary.targetCount}`,
    `- 作品采集状态：${summary.validatedTargetCount} 完整 / ${summary.limitedTargetCount} 范围说明 / ${summary.retryTargetCount} 自动重试`,
    `- 数据截至：${summary.latestSnapshotAt ?? "—"}`,
    "",
    "## 作者增长贡献",
    "",
    ...(report.contributors?.filter((item) => item.followersDelta !== null || item.accountLikesDelta !== null).sort((left, right) => Number(right.followersDelta ?? -Infinity) - Number(left.followersDelta ?? -Infinity)).slice(0, 20).map((item, index) => `${index + 1}. ${item.label}｜涨粉 ${item.followersDelta ?? "—"}｜新增点赞 ${item.accountLikesDelta ?? "—"}｜估算播放 ${item.estimatedPlaysDelta ?? "—"}｜${item.followersBaselineMode === "first-in-period" ? "从本期首条快照起算" : "期初前快照"}`) ?? ["本期暂无可比账号。"]),
    "",
    "## 爆款作品",
    "",
    ...viralRows,
    "",
    `生成时间：${report.generatedAt}`,
  ];
  return lines.join("\n");
}

function growthCsv(report) {
  const scopeName = report.selectedBoard?.name || "全部板块";
  const header = [
    "报告周期", "区间开始", "区间结束", `报告筛选范围（${scopeName}）`, "全部归属", "作者", "平台",
    "粉丝基线", "当前粉丝", "涨粉数", "粉丝基线时间", "粉丝当前时间", "粉丝基线指纹", "粉丝当前指纹", "粉丝基线方式",
    "获赞基线", "当前累计获赞", "新增点赞", "估算新增播放", "获赞基线时间", "获赞当前时间", "获赞基线指纹", "获赞当前指纹", "获赞基线方式",
    "审查状态", "数据提示",
  ];
  const baselineLabel = (mode) => mode === "first-in-period" ? "从本期首条快照起算" : mode === "period-start" ? "期初前最近快照" : "不可比";
  const rows = (report.contributors || []).map((item) => [
    report.period, report.start, report.end, report.selectedBoard?.name || "全部板块", (item.boards || []).map((board) => board.name).join("、") || "未分板块", item.label, item.platform,
    item.followersBaseline, item.followersCurrent, item.followersDelta, item.followersBaselineAt, item.followersCurrentAt, item.followersBaselineChecksum, item.followersCurrentChecksum, baselineLabel(item.followersBaselineMode),
    item.accountLikesBaseline, item.accountLikesCurrent, item.accountLikesDelta, item.estimatedPlaysDelta, item.accountLikesBaselineAt, item.accountLikesCurrentAt, item.accountLikesBaselineChecksum, item.accountLikesCurrentChecksum, baselineLabel(item.accountLikesBaselineMode),
    item.reviewState, (item.warnings || []).join("；"),
  ]);
  return [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
}

function readableFilenameSegment(value, fallback = "board") {
  const cleaned = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|;]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\s-]+|[.\s-]+$/g, "");
  return Array.from(cleaned).slice(0, 32).join("") || fallback;
}

function rfc5987(value) {
  return encodeURIComponent(value).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function attachmentDisposition(asciiFilename, readableFilename = asciiFilename) {
  return `attachment; filename="${asciiFilename}"; filename*=UTF-8''${rfc5987(readableFilename)}`;
}

async function serveStatic(pathname, response) {
  // The previous multi-screen shell is retained only in the pre-rebuild
  // archive. The root route deliberately serves the smaller daily console.
  const requested = pathname === "/" || pathname === "/index.html" ? "rebuild.html" : decodeURIComponent(pathname.slice(1));
  const filePath = resolve(publicDir, requested);
  if (!(filePath === publicDir || filePath.startsWith(`${publicDir}${sep}`)) || !existsSync(filePath)) return false;
  const rawBody = await readFile(filePath);
  const contentType = MIME[extname(filePath)] || "application/octet-stream";
  const compressed = maybeCompressResponse(response, rawBody, contentType);
  const headers = {
    "Content-Type": contentType,
    "Content-Length": compressed.body.length,
    "Cache-Control": "no-cache",
    "Vary": "Accept-Encoding",
    ...SECURITY_HEADERS,
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  };
  if (compressed.encoding) headers["Content-Encoding"] = compressed.encoding;
  response.writeHead(200, headers);
  response.end(compressed.body);
  return true;
}

function recordAction(request, action, resourceType, resourceId = null, details = {}) {
  consoleReader.invalidate();
  database.recordActivity({
    userId: request.auth.user.id,
    actorName: request.auth.user.displayName,
    action,
    resourceType,
    resourceId,
    clientIp: clientIp(request),
    details,
  });
}

function authorJobReplayPayload(request) {
  // Keep the original fingerprint compatible with already persisted receipts.
  // Compare the submitted semantics as well: a claimed file hash is not proof
  // that a direct API caller resubmitted the same rows or board catalog.
  const rows = (request.rows || []).map(source => {
    const { reason, ...row } = sanitizeAuthorJobRow(source);
    return { ...row, status: row.status === "existing" ? "ready" : row.status };
  });
  const boardCatalog = [...new Set((request.boardCatalog || []).map(board => String(board.name)))].sort();
  const source = Object.fromEntries([
    "sourceType", "sourceUrl", "sourceTitle", "sourceRevision", "sourceSheetId", "sourceRange", "sourceSha256",
  ].map(key => [key, request[key] ?? null]));
  // Reading time and XLSX container hashes may change on an otherwise identical
  // cloud read. They remain in original receipts, but are not replay identity.
  return JSON.stringify({ rows, boardCatalog, defaultBoard: request.defaultBoard || "", source,
    masterRosterSupplement: request.masterRosterSupplement ?? null });
}

function enqueueAuthorResolutionJob(body, request, idempotencyKey = "", trustedMasterRosterSupplement = null) {
  if (!Array.isArray(body.rows)) throw new HttpError(400, "缺少已审查作者行");
  if (!body.rows.length) throw new HttpError(400, "作者表格没有可处理的数据行");
  if (body.rows.length > AUTHOR_UPLOAD_LIMITS.maxRows) throw new HttpError(400, `单次最多审查 ${AUTHOR_UPLOAD_LIMITS.maxRows} 行`);
  const bitableSource = normalizeBitableAuthorSource(body);
  body = { ...body, ...prepareAuthorBoardImport(body.rows, body) };
  body = { ...body, rows: body.rows.map(sanitizeAuthorJobRow) };
  const requests = buildAuthorEvidenceRequests(rowsEligibleForAuthorResolution(body.rows));
  const directLocators = new Set(body.rows.map(directAuthorLocatorKey).filter(Boolean));
  const conflicts = identityConflictCount(body.rows);
  const needsLocatorReviews = needsLocatorReviewCount(body.rows);
  const existingAuthors = body.rows.some(row => row.status === "existing" && normalizeAccountLocator(row.locator, row.platform));
  if (!requests.length && !directLocators.size && !conflicts && !needsLocatorReviews && !existingAuthors) throw new HttpError(400, "没有可自动核验或保存审查的作者；请提供作者名称、平台账号 ID、公开作品或完整作者主页");
  const safeJobFileName = basename(compactAuthorText(body.fileName || "未命名表格", 240));
  const safeJobSheetName = compactAuthorText(body.sheetName, 120);
  if (idempotencyKey && !/^[0-9a-f-]{36}$/i.test(idempotencyKey)) throw new HttpError(400, "导入幂等键格式无效");
  const uploadSha256 = String(body.uploadSha256 ?? "").toLowerCase();
  if (idempotencyKey && !/^[a-f0-9]{64}$/.test(uploadSha256)) throw new HttpError(400, "导入文件校验凭证缺失，请重新预览表格");
  const jobInput = {
    id: randomUUID(),
    totalAuthors: requests.length + directLocators.size + conflicts + needsLocatorReviews,
    userId: request.auth.user.id,
    actorName: request.auth.user.displayName,
    clientIp: clientIp(request),
    fileName: safeJobFileName,
    sheetName: safeJobSheetName,
    request: {
      fileName: safeJobFileName,
      sheetName: safeJobSheetName,
      rows: body.rows,
      defaultBoard: body.defaultBoard,
      boardCatalog: body.boardCatalog,
      // Retain local-upload provenance for the read-only latest-source roster.
      // The batch route checks this against the re-read original file bytes.
      ...(/^[a-f0-9]{64}$/.test(uploadSha256) ? { uploadSha256 } : {}),
      // Only the dedicated roster route can provide this server-built context.
      // General import bodies cannot claim a relationship to a preserved entry.
      ...(trustedMasterRosterSupplement ? { masterRosterSupplement: trustedMasterRosterSupplement } : {}),
      ...bitableSource,
      ...(body.sourceType === "lark-sheet" ? {
        sourceType: "lark-sheet",
        sourceUrl: normalizeLarkSheetUrl(body.sourceUrl),
        sourceTitle: compactAuthorText(body.sourceTitle, 200),
        sourceRevision: Math.max(0, Math.trunc(Number(body.sourceRevision) || 0)),
        sourceSheetId: String(body.sourceSheetId ?? "").slice(0, 80),
        sourceRange: String(body.sourceRange ?? "").slice(0, 80),
        sourceSha256: String(body.sourceSha256 ?? "").slice(0, 64),
        sourceExportSha256: String(body.sourceExportSha256 ?? "").slice(0, 64),
        sourceReadAt: String(body.sourceReadAt ?? "").slice(0, 40),
      } : {}),
    },
  };
  let job, idempotencyReplay = false;
  if (idempotencyKey) {
    const fingerprint = createHash("sha256").update(JSON.stringify([
      uploadSha256,
      safeJobFileName,
      safeJobSheetName,
      String(body.defaultBoard ?? ""),
    ])).digest("hex");
    const result = database.createIdempotentAuthorResolutionJob({ ...jobInput, idempotencyKey, fingerprint });
    if (result.conflict) throw new HttpError(409, "该上传标识已对应不同的文件、工作表或板块设置；请重新预览后作为新任务提交");
    if (result.replayed && authorJobReplayPayload(result.job.request) !== authorJobReplayPayload(jobInput.request)) {
      throw new HttpError(409, "该上传标识的作者资料或板块目录已变化；请重新预览后作为新任务提交");
    }
    job = result.job; idempotencyReplay = result.replayed;
  } else job = database.createAuthorResolutionJob(jobInput);
  if (!idempotencyReplay) {
    recordAction(request, "authors.auto-monitor.start", "target", null, { fileName: safeJobFileName, sheetName: safeJobSheetName, totalAuthors: job.totalAuthors,
      ...(trustedMasterRosterSupplement?.version === 2 ? { identityCorrection: {
        ...trustedMasterRosterSupplement.correction, explicitlyConfirmed: true,
        entryKey: trustedMasterRosterSupplement.entryKey, jobId: job.id,
      } } : {}),
    });
    scheduleAuthorResolutionJobs(100, true);
  }
  return { job, idempotencyReplay };
}

async function handleApi(request, response, url) {
  const pathname = url.pathname;
  const startupGate = startupApiGate(startupReadiness, pathname, request.method);
  if (startupGate) return json(response, startupGate.statusCode, startupGate.body);
  if (request.method === "GET" && pathname === "/api/auth/session") {
    try { return json(response, 200, access.sessionInfo(request, response)); }
    catch (error) {
      if (error?.status === 401) return json(response, 200, { authenticated: false });
      throw error;
    }
  }
  if (request.method === "POST" && pathname === "/api/auth/join") {
    return json(response, 200, access.join(request, response, await readJson(request, 32_000)));
  }

  access.authenticate(request, response);
  if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method)) access.verifyMutation(request);

  if (request.method === "POST" && pathname === "/api/auth/logout") {
    recordAction(request, "session.logout", "session");
    access.logout(request, response);
    return json(response, 200, { ok: true });
  }
  if (request.method === "GET" && pathname === "/api/access") {
    access.requireRole(request, "admin");
    const publicEntry = readPublicEntry(dataDir);
    return json(response, 200, {
      ...access.accessOverview(),
      // A configured reverse-proxy/tunnel origin is the only address that
      // should be copied to remote teammates. Keep it separate from the
      // machine-local LAN list so a local admin never mistakes 10.x/192.168.x
      // for a universally reachable entry point.
      publicBaseUrl: publicEntry?.url || null,
      // Configuration and tunnel heartbeats are not external reachability tests.
      publicEntry,
    });
  }
  if (request.method === "POST" && pathname === "/api/access/invites") {
    access.requireRole(request, "admin");
    const invite = access.createInvite(request, await readJson(request, 32_000));
    recordAction(request, "invite.create", "invite", invite.id, { role: invite.role, maxUses: invite.maxUses, hours: invite.hours });
    return json(response, 201, invite);
  }
  const inviteMatch = /^\/api\/access\/invites\/(\d+)$/.exec(pathname);
  if (inviteMatch && request.method === "DELETE") {
    access.requireRole(request, "admin");
    const revoked = database.revokeInvite(inviteMatch[1]);
    if (revoked) recordAction(request, "invite.revoke", "invite", inviteMatch[1]);
    return revoked ? json(response, 200, { ok: true }) : json(response, 404, { error: "邀请码不存在或已失效" });
  }
  const memberMatch = /^\/api\/access\/members\/(\d+)$/.exec(pathname);
  if (memberMatch && request.method === "PATCH") {
    access.requireRole(request, "admin");
    const body = await readJson(request, 32_000);
    if (body.role !== undefined && !["viewer", "editor"].includes(body.role)) throw new HttpError(400, "成员权限必须是查看者或编辑者");
    const before = database.listAccess().members.find((member) => member.id === Number(memberMatch[1]));
    if (!before) return json(response, 404, { error: "成员不存在" });
    if (before.authSource === "local-owner") throw new HttpError(400, "不能修改本机管理员");
    const member = database.updateMember(memberMatch[1], { role: body.role, enabled: body.enabled });
    recordAction(request, "member.update", "member", member.id, { role: member.role, enabled: member.enabled });
    return json(response, 200, member);
  }
  if (request.method === "GET" && pathname === "/api/continuity") {
    access.requireRole(request, "viewer");
    const checkedAt = new Date();
    return json(response, 200, getProductContinuity(database, await readSchedulerStatus(request, response, checkedAt), {
      now: checkedAt,
      userId: request.auth.user.id, backup: inspectLatestBackup(backupManager.backupDir), timeZone: "Asia/Shanghai",
    }));
  }
  if (request.method === "GET" && pathname === "/api/ingestion-reviews") {
    access.requireRole(request, "admin");
    return json(response, 200, { ...await inspectPostIngestionReviews({ ledgerDir: ingestionReviewDir, limit: 20 }), queue: summarizePostIngestionReviewQueue(ingestionReviewQueueStatus) });
  }
  if (request.method === "GET" && pathname === "/api/monitoring-status") {
    access.requireRole(request, "viewer");
    const checkedAt = new Date();
    const [updateSla, schedulerStatus] = await Promise.all([
      readUpdateSla(database.filePath, { now: checkedAt }),
      readSchedulerStatus(request, response, checkedAt),
    ]);
    const lane = ownedCollectorExecutor.diagnostics();
    return json(response, 200, {
      checkedAt: checkedAt.toISOString(),
      updateSla,
      scheduler: schedulerStatus,
      browserLane: {
        busy: lane.busy, locked: lane.locked, reason: lane.reason,
        lockedAt: lane.locked ? lane.lastLock?.lockedAt ?? null : null,
        recoveryEligible: lane.locked && lane.lastLock?.recoveryEligible === true,
        lastRecoveredAt: lane.lastRecovery?.recoveredAt ?? null,
      },
      sourcePoller: inspectSourcePollManifest(join(dataDir, "source-poll", "manifest.json"), { now: checkedAt, registryPath: join(dataDir, "source-poll", "registry.json"), lookupCompletedJob: (id) => database.getAuthorResolutionJob(id), lookupJobState: createSourceJobStateReader(database.db) }),
      ingestionReview: summarizePostIngestionReviewQueue(ingestionReviewQueueStatus),
    });
  }
  if (request.method === "GET" && pathname === "/api/rebuild/insights") {
    access.requireRole(request, "viewer");
    const options = { ...productInsightOptions(url.searchParams), board: normalizeBoardName(url.searchParams.get("board")) };
    return json(response, 200, await requestScopedRead(request, response, signal => consoleReader.overview(options, { signal })));
  }
  const rebuildAccountMatch = /^\/api\/rebuild\/accounts\/(\d+)\/insights$/.exec(pathname);
  if (request.method === "GET" && rebuildAccountMatch) {
    access.requireRole(request, "viewer");
    const result = await requestScopedRead(request, response, signal => consoleReader.account(Number(rebuildAccountMatch[1]), productInsightOptions(url.searchParams), { signal }));
    return result?.account ? json(response, 200, result) : json(response, 404, { error: "账号不存在" });
  }
  const rebuildHistoryMatch = /^\/api\/rebuild\/accounts\/(\d+)\/history$/.exec(pathname);
  if (request.method === "GET" && rebuildHistoryMatch) {
    access.requireRole(request, "viewer");
    const result = await requestScopedRead(request, response, signal => consoleReader.history(Number(rebuildHistoryMatch[1]), accountHistoryOptions(url.searchParams), { signal }));
    return result ? json(response, 200, result) : json(response, 404, { error: "账号或作品记录不存在" });
  }
  if (request.method === "GET" && pathname === "/api/insights") {
    access.requireRole(request, "viewer");
    return json(response, 200, await requestScopedRead(request, response, signal => consoleReader.overview({
      ...productInsightOptions(url.searchParams), board: normalizeBoardName(url.searchParams.get("board")),
    }, { signal })));
  }
  if (request.method === "GET" && pathname === "/api/topics/history") {
    access.requireRole(request, "viewer");
    return json(response, 200, database.listTopicHistory(topicHistoryOptions(url.searchParams)));
  }
  const accountInsightMatch = /^\/api\/accounts\/(\d+)\/insights$/.exec(pathname);
  if (request.method === "GET" && accountInsightMatch) {
    access.requireRole(request, "viewer");
    const result = await requestScopedRead(request, response, signal => consoleReader.account(Number(accountInsightMatch[1]), productInsightOptions(url.searchParams), { signal }));
    return result?.account ? json(response, 200, result) : json(response, 404, { error: "账号不存在" });
  }
  if (request.method === "GET" && pathname === "/api/bootstrap") {
    access.requireRole(request, "viewer");
    const checkedAt = new Date();
    const runtimeAudit = await requestScopedRead(request, response, () => systemAuditReader.read());
    const board = normalizeBoardName(url.searchParams.get("board"));
    const overview = await requestScopedRead(request, response, signal => consoleReader.bootstrapOverview({ board, timeZone: "Asia/Shanghai" }, { signal }));
    const bootstrapSourceProbe = database.getLatestSourceProbe();
    const bootstrapSourceDegraded = Boolean(bootstrapSourceProbe && (bootstrapSourceProbe.ok !== true || bootstrapSourceProbe.result?.postsEndpoint === false));
    overview.targets = overview.targets.map(publicTarget);
    const teamAccess = request.auth.user.role === "admin" ? access.accessOverview() : null;
    const authorResolutionJobs = database.listAuthorResolutionJobs(
      8,
      request.auth.user.role === "admin" ? {} : { userId: request.auth.user.id },
    ).map((job) => publicAuthorResolveJob(job, { skippedLimit: 20 }));
    return json(response, 200, {
      ...overview,
      authorResolutionJobs,
      authorSources: getAuthorSources(database, { userId: request.auth.user.id }),
      sourcePoller: inspectSourcePollManifest(join(dataDir, "source-poll", "manifest.json"), { now: checkedAt, registryPath: join(dataDir, "source-poll", "registry.json"), lookupCompletedJob: (id) => database.getAuthorResolutionJob(id), lookupJobState: createSourceJobStateReader(database.db) }),
      settings: database.getSettings(),
      publicProbe: bootstrapSourceProbe,
      publicProbes: database.getLatestSourceProbes(),
      sourceProbeHistory: database.getRecentSourceProbes(24),
      runtimeAudit: {
        ...runtimeAudit,
        checkedAt: runtimeAudit.checkFinishedAt,
        sourceStatus: bootstrapSourceDegraded ? "degraded" : bootstrapSourceProbe ? "ok" : "unknown",
        sourceDegraded: bootstrapSourceDegraded,
      },
      scheduler: await readSchedulerStatus(request, response),
      runtimeAI: false,
      topicResolverMode: ["browser", "browser-first"].includes(process.env.DOUYIN_TOPIC_RESOLVER_MODE)
        ? "authenticated-topic-dedicated-profile"
        : "anonymous-only",
      auth: access.sessionPayload(request.auth),
      teamSummary: teamAccess ? {
        enabledMemberCount: teamAccess.members.filter((member) => member.authSource !== "local-owner" && member.enabled).length,
        activeInviteCount: teamAccess.invites.filter((invite) => !invite.revoked && !invite.expired && invite.useCount < invite.maxUses).length,
        onlineCount: teamAccess.onlineCount,
        lanUrls: teamAccess.lanUrls,
      } : null,
    });
  }
  if (request.method === "GET" && pathname === "/api/system-audit") {
    access.requireRole(request, "viewer");
    const audit = await systemAuditReader.read({ deep: true });
    const databaseAudit = audit.database;
    const backupAudit = audit.backup;
    const schedulerState = await readSchedulerStatus(request, response);
    const sourceProbe = database.getLatestSourceProbe();
    const sourceDegraded = Boolean(sourceProbe && (sourceProbe.ok !== true || sourceProbe.result?.postsEndpoint === false));
    const schedulerReady = schedulerReadiness(schedulerState);
    const schedulerHealthy = schedulerScheduleHealthy(schedulerState);
    return json(response, 200, {
      // `running=false` is the healthy idle state between automatic runs;
      // readiness is proven by a live tick and a valid next-run timestamp.
      // The plan outcome is checked separately so a failed/partial/missed
      // automatic batch cannot be reported as a clean system audit.
      // Structural integrity and source availability are separate dimensions:
      // a database can be healthy while Douyin's works endpoint is degraded.
      // Keep `ok` strict so external audits cannot report a green system when
      // the current public source cannot provide the requested coverage.
      ok: databaseAudit.status === "ok" && backupAudit.status === "ok" && schedulerReady && schedulerHealthy && !sourceDegraded,
      checkedAt: audit.checkFinishedAt,
      checkStartedAt: audit.checkStartedAt,
      checkFinishedAt: audit.checkFinishedAt,
      database: databaseAudit,
      backup: backupAudit,
      scheduler: schedulerState,
      schedulerReady,
      schedulerHealthy,
      sourceProbe,
      sourceStatus: sourceDegraded ? "degraded" : sourceProbe ? "ok" : "unknown",
      sourceDegraded,
      sourceProbes: database.getLatestSourceProbes(),
      runtimeAI: false,
      paidAPI: false,
      // Account monitoring starts with anonymous HTTP and can explicitly fall
      // back to one user-authorized browser probe when the works endpoint is
      // blocked. Topics use their separate authenticated browser adapter. Keep
      // both flags visible so audits never describe a mixed run as anonymous.
      browserCollection: ["1", "true", "browser", "browser-fallback"].includes(String(process.env.DOUYIN_ACCOUNT_BROWSER_FALLBACK ?? "").toLowerCase()),
      topicBrowserCollection: ["browser", "browser-first"].includes(process.env.DOUYIN_TOPIC_RESOLVER_MODE),
      browserSessionMode: ["1", "true", "browser", "browser-fallback"].includes(String(process.env.DOUYIN_ACCOUNT_BROWSER_FALLBACK ?? "").toLowerCase())
        ? "authenticated-account-fallback"
        : ["browser", "browser-first"].includes(process.env.DOUYIN_TOPIC_RESOLVER_MODE)
          ? "authenticated-topic-dedicated-profile"
          : "anonymous-only",
      authenticatedAccountCollection: ["1", "true", "browser", "browser-fallback"].includes(String(process.env.DOUYIN_ACCOUNT_BROWSER_FALLBACK ?? "").toLowerCase()),
      authenticatedTopicCollection: ["browser", "browser-first"].includes(process.env.DOUYIN_TOPIC_RESOLVER_MODE),
    });
  }
  if (request.method === "GET" && pathname === "/api/author-resolution-queue") {
    access.requireRole(request, "viewer");
    const status = url.searchParams.get("status") || "all";
    const limit = Math.max(1, Math.min(500, Math.trunc(Number(url.searchParams.get("limit")) || 200)));
    const board = url.searchParams.get("board") || "";
    return json(response, 200, {
      summary: database.getAuthorResolutionQueueSummary(board),
      status: ["pending", "retry", "resolved", "rejected"].includes(status) ? status : "all",
      items: database.listAuthorResolutionQueue(limit, status, board),
    });
  }
  if (request.method === "POST" && pathname === "/api/boards") {
    access.requireRole(request, "editor");
    const body = await readJson(request, 4_000);
    const board = database.createBoard(body.name, { sourceType: "user-created" });
    recordAction(request, "board.create", "board", board.key, { name: board.name });
    return json(response, 200, { board, boards: database.listBoards() });
  }
  if (request.method === "POST" && pathname === "/api/boards/assign") {
    access.requireRole(request, "editor");
    const body = await readJson(request, 80_000);
    if (!Array.isArray(body.targetIds) || body.targetIds.length > 5_000) throw new HttpError(400, "单次最多归类 5000 个账号");
    const result = database.assignTargetsToBoard(body.targetIds, body.name, {
      sourceType: "user-assignment", note: compactAuthorText(body.note, 500),
    });
    recordAction(request, "board.assign", "board", result.board.key, result);
    return json(response, 200, { ...result, boards: database.listBoards() });
  }
  if (request.method === "GET" && pathname.startsWith("/api/reports/")) {
    access.requireRole(request, "viewer");
    const period = pathname.split("/").at(-1);
    if (!["day", "week", "month"].includes(period)) return json(response, 400, { error: "不支持的周期" });
    const reference = reportReference(url.searchParams);
    if (Number.isNaN(reference.getTime())) return json(response, 400, { error: "报告日期无效" });
    const board = normalizeBoardName(url.searchParams.get("board"));
    return json(response, 200, database.getReport(period, reference, { board, timeZone: "Asia/Shanghai" }));
  }
  if (request.method === "GET" && pathname === "/api/targets") {
    access.requireRole(request, "viewer");
    const board = normalizeBoardName(url.searchParams.get("board"));
    const boards = database.listBoards();
    return json(response, 200, {
      boards,
      selectedBoard: board ? boards.find((item) => item.key === normalizeBoardKey(board)) ?? { key: normalizeBoardKey(board), name: board, targetCount: 0 } : null,
      targets: database.listTargets({ board }).map(publicTarget),
    });
  }
  if (request.method === "GET" && pathname === "/api/master-roster") {
    access.requireRole(request, "viewer");
    const roster = readMasterRoster(database.db);
    if (!roster) return json(response, 404, { error: "尚未导入总表名册" });
    return json(response, 200, roster);
  }
  if (request.method === "POST" && ["/api/master-roster/supplement/preview", "/api/master-roster/supplement"].includes(pathname)) {
    access.requireRole(request, "editor");
    if (shuttingDown) throw new HttpError(503, "服务正在安全退出，请稍后重试");
    const body = await readJson(request, 8_000);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "补充资料格式无效，请重新填写");
    const prepared = await prepareMasterRosterSupplement(database.db, {
      workbookSha256: body.workbookSha256, entryKey: body.entryKey, evidence: body.evidence,
      correctedAccountId: body.correctedAccountId,
    });
    if (pathname.endsWith("/preview")) return json(response, 200, prepared.preview);
    if (shuttingDown) throw new HttpError(503, "服务正在安全退出，请稍后重试");
    if (body.previewSha256 !== prepared.preview.previewSha256) throw new HttpError(409, "补充资料与预览不一致，请重新预览后确认");
    if (prepared.masterRosterSupplement.version === 2 && body.correctionConfirmed !== true) {
      throw new HttpError(400, "请核对原账号 ID 与更正后的 ID，明确确认后再提交核验");
    }
    if (!prepared.preview.review.canSubmit) throw new HttpError(400, prepared.preview.review.reason || "该资料暂不能提交核验");
    const idempotencyKey = String(request.headers["idempotency-key"] ?? "");
    if (!idempotencyKey) throw new HttpError(400, "缺少提交标识，请重新预览后确认");
    const { job, idempotencyReplay } = enqueueAuthorResolutionJob(prepared, request, idempotencyKey, prepared.masterRosterSupplement);
    return json(response, idempotencyReplay ? 200 : 202, { job: publicAuthorResolveJob(job), idempotencyReplay });
  }
  if (request.method === "GET" && pathname === "/api/export") {
    access.requireRole(request, "viewer");
    const period = url.searchParams.get("period") || "day";
    const format = url.searchParams.get("format") || "csv";
    if (!["day", "week", "month"].includes(period)) return json(response, 400, { error: "不支持的周期" });
    const reference = reportReference(url.searchParams);
    if (Number.isNaN(reference.getTime())) return json(response, 400, { error: "报告日期无效" });
    const board = normalizeBoardName(url.searchParams.get("board"));
    const report = database.getReport(period, reference, { board, timeZone: "Asia/Shanghai" });
    const scopeHash = report.selectedBoard && report.selectedBoard.name !== "未分板块"
      ? createHash("sha256").update(report.selectedBoard.key || report.selectedBoard.name).digest("hex").slice(0, 8)
      : "";
    const scopeSlug = report.selectedBoard
      ? report.selectedBoard.name === "未分板块" ? "unassigned" : `board-${scopeHash}`
      : "all";
    const readableScopeSlug = report.selectedBoard && report.selectedBoard.name !== "未分板块"
      ? `${readableFilenameSegment(report.selectedBoard.name)}-${scopeHash}`
      : scopeSlug;
    const exportFilename = (suffix) => ({
      ascii: `content-platform-${period}-${scopeSlug}-${suffix}`,
      readable: `content-platform-${period}-${readableScopeSlug}-${suffix}`,
    });
    if (format === "md") {
      const filename = exportFilename("report.md");
      return text(response, 200, reportMarkdown(report), "text/markdown; charset=utf-8", { "Content-Disposition": attachmentDisposition(filename.ascii, filename.readable) });
    }
    if (url.searchParams.get("scope") === "growth") {
      const filename = exportFilename("growth.csv");
      return text(response, 200, `\uFEFF${growthCsv(report)}`, "text/csv; charset=utf-8", { "Content-Disposition": attachmentDisposition(filename.ascii, filename.readable) });
    }
    const filename = exportFilename("report.csv");
    return text(response, 200, `\uFEFF${reportCsv(report)}`, "text/csv; charset=utf-8", { "Content-Disposition": attachmentDisposition(filename.ascii, filename.readable) });
  }
  if (request.method === "POST" && pathname === "/api/author-spreadsheet/lark-preview") {
    access.requireRole(request, "editor");
    const body = await readJson(request, 20_000);
    const exported = await exportLarkSheetWorkbook(body.url);
    const preview = await parseAuthorSpreadsheet({
      buffer: exported.buffer,
      fileName: exported.fileName,
      sheetName: requestedAuthorSheetName(body, exported.source),
    });
    const selectedSheet = exported.source.sheets.find((sheet) => sheet.title === preview.selectedSheet) ?? null;
    const contentSha256 = authorPreviewContentSha256(preview);
    const reviewed = markExistingAuthors(preview, database.listTargets());
    return json(response, 200, {
      ...reviewed,
      ...projectAuthorPreviewRows(reviewed.rows),
      source: {
        ...exported.source,
        contentSha256,
        selectedSheetId: selectedSheet?.id || "",
        selectedSheet: preview.selectedSheet,
        dataRange: preview.dataRange,
        dataRowCount: preview.summary.totalRows,
      },
    });
  }
  if (request.method === "POST" && pathname === "/api/author-spreadsheet/preview") {
    access.requireRole(request, "editor");
    const body = await readJson(request, 12_000_000);
    const upload = decodeSpreadsheetUpload(body);
    const preview = await parseAuthorSpreadsheet({ ...upload, sheetName: body.sheetName ? String(body.sheetName) : undefined });
    const reviewed = markExistingAuthors(preview, database.listTargets());
    return json(response, 200, {
      ...reviewed,
      ...projectAuthorPreviewRows(reviewed.rows),
      uploadSha256: createHash("sha256").update(upload.buffer).digest("hex"),
    });
  }
  if (request.method === "POST" && pathname === "/api/author-spreadsheet/batch-preview") {
    access.requireRole(request, "editor");
    const body = await readJson(request, 12_000_000);
    const upload = decodeSpreadsheetUpload(body);
    const preview = await parseAuthorSpreadsheet({ ...upload, includeAllSheets: true });
    const existingTargets = database.listTargets();
    const sheets = preview.sheetPreviews.map((sheet) => {
      if (!sheet.importable) return {
        name: sheet.name, rowCount: 0, worksheetRows: sheet.rowCount, headerScore: sheet.headerScore,
        importable: false, issue: sheet.issue || "工作表无法识别", summary: sheet.summary || null,
        validationWarnings: sheet.validationWarnings || [], sampleRows: [], problemRowCount: 0, problemRows: [], problemRowsTruncated: 0,
      };
      const reviewed = markExistingAuthors(sheet, existingTargets);
      const previewRows = projectAuthorPreviewRows(reviewed.rows);
      return {
        name: sheet.name, rowCount: reviewed.rows.length, worksheetRows: sheet.rowCount, headerScore: sheet.headerScore,
        importable: reviewed.rows.length > 0, issue: sheet.issue,
        dataRange: sheet.dataRange, headerRow: sheet.headerRow, mapping: sheet.mapping,
        summary: reviewed.summary, validationWarnings: sheet.validationWarnings || [], ...previewRows,
      };
    });
    return json(response, 200, {
      fileName: upload.fileName,
      uploadSha256: createHash("sha256").update(upload.buffer).digest("hex"),
      boardCatalog: preview.boardCatalog,
      totalAuthorRows: sheets.reduce((total, sheet) => total + (sheet.importable ? sheet.rowCount : 0), 0),
      maxBatchRows: AUTHOR_UPLOAD_LIMITS.maxBatchRows,
      sheets,
    });
  }
  if (request.method === "POST" && pathname === "/api/author-spreadsheet/auto-monitor") {
    access.requireRole(request, "editor");
    let body = await readJson(request, 12_000_000);
    if (body.sourceType === "lark-sheet") {
      const sourceUrl = normalizeLarkSheetUrl(body.sourceUrl);
      const exported = await exportLarkSheetWorkbook(sourceUrl);
      const preview = await parseAuthorSpreadsheet({
        buffer: exported.buffer,
        fileName: exported.fileName,
        sheetName: requestedAuthorSheetName(body, exported.source),
      });
      const contentSha256 = authorPreviewContentSha256(preview);
      const submittedContentSha256 = String(body.sourceSha256 ?? "").toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(submittedContentSha256)) {
        throw new HttpError(400, "飞书预览凭证缺失，请重新读取并审查表格");
      }
      if (submittedContentSha256 !== contentSha256
        || (Number(body.sourceRevision) > 0 && Number(exported.source.revision) > 0 && Number(body.sourceRevision) !== Number(exported.source.revision))) {
        throw new HttpError(409, "飞书表格在预览后发生变化，请重新读取并审查最新版本");
      }
      const selectedSheet = exported.source.sheets.find((sheet) => sheet.title === preview.selectedSheet) ?? null;
      const reviewedPreview = markExistingAuthors(preview, database.listTargets());
      body = {
        ...body,
        fileName: exported.fileName,
        sheetName: preview.selectedSheet,
        rows: reviewedPreview.rows,
        boardCatalog: preview.boardCatalog || [],
        sourceUrl,
        sourceTitle: exported.source.title,
        sourceRevision: exported.source.revision,
        sourceSheetId: selectedSheet?.id || "",
        sourceRange: preview.dataRange,
        sourceSha256: contentSha256,
        sourceExportSha256: exported.source.exportSha256,
        sourceReadAt: exported.source.readAt,
      };
    } else if (body.sourceType === "lark-bitable") {
      const submittedCapability = request.headers[SOURCE_POLLER_CAPABILITY_HEADER];
      if (!isLoopbackAddress(request.socket?.remoteAddress)
        || Array.isArray(submittedCapability)
        || !capabilityMatches(sourcePollerCapability, submittedCapability)) {
        throw new HttpError(403, "多维表格数据只能由本机已授权的来源检查器提交");
      }
    } else {
      // A browser preview is not an authority boundary. Re-read the exact
      // submitted bytes here so edited/stale preview rows cannot change an
      // author identity, source relationship or board membership.
      const upload = decodeSpreadsheetUpload(body);
      const actualSha256 = createHash("sha256").update(upload.buffer).digest("hex");
      const submittedSha256 = String(body.uploadSha256 ?? "").toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(submittedSha256)) {
        throw new HttpError(400, "导入文件校验凭证缺失，请重新预览表格");
      }
      if (submittedSha256 !== actualSha256) {
        throw new HttpError(409, "文件内容与预览时不同，请重新预览后再提交");
      }
      const preview = await parseAuthorSpreadsheet({
        ...upload,
        sheetName: body.sheetName ? String(body.sheetName) : undefined,
      });
      const reviewedPreview = markExistingAuthors(preview, database.listTargets());
      body = {
        ...body,
        fileName: upload.fileName,
        sheetName: preview.selectedSheet,
        rows: reviewedPreview.rows,
        boardCatalog: preview.boardCatalog || [],
        uploadSha256: actualSha256,
      };
    }
    const idempotencyKey = String(request.headers["idempotency-key"] ?? "").trim();
    const result = enqueueAuthorResolutionJob(body, request, idempotencyKey);
    return json(response, result.idempotencyReplay ? 200 : 202, {
      ...publicAuthorResolveJob(result.job, { skippedLimit: 20 }),
      ...(result.idempotencyReplay ? { idempotencyReplay: true } : {}),
    });
  }
  if (request.method === "POST" && pathname === "/api/author-spreadsheet/auto-monitor-batch") {
    access.requireRole(request, "editor");
    const body = await readJson(request, 12_000_000);
    const upload = decodeSpreadsheetUpload(body);
    const actualSha256 = createHash("sha256").update(upload.buffer).digest("hex");
    if (String(body.uploadSha256 ?? "").toLowerCase() !== actualSha256) throw new HttpError(409, "文件内容与预览时不同，请重新预览后再提交");
    if (!Array.isArray(body.assignments) || !body.assignments.length || body.assignments.length > AUTHOR_UPLOAD_LIMITS.maxSheets) {
      throw new HttpError(400, `请选择 1–${AUTHOR_UPLOAD_LIMITS.maxSheets} 个可导入工作表`);
    }
    const seenSheets = new Set();
    const assignments = body.assignments.map((assignment) => {
      const sheetName = compactAuthorText(assignment?.sheetName, 120);
      const defaultBoard = compactAuthorText(assignment?.defaultBoard, 120);
      const idempotencyKey = String(assignment?.idempotencyKey ?? "").trim();
      if (!sheetName || seenSheets.has(sheetName)) throw new HttpError(400, "批量导入包含空白或重复工作表名称");
      if (!/^[0-9a-f-]{36}$/i.test(idempotencyKey)) throw new HttpError(400, `“${sheetName}”缺少有效的幂等凭证，请重新预览`);
      seenSheets.add(sheetName);
      return { sheetName, defaultBoard, idempotencyKey };
    });
    const workbook = await parseAuthorSpreadsheet({ buffer: upload.buffer, fileName: upload.fileName, includeAllSheets: true });
    const sheetMap = new Map(workbook.sheetPreviews.map((sheet) => [sheet.name, sheet]));
    for (const assignment of assignments) {
      const sheet = sheetMap.get(assignment.sheetName);
      if (!sheet?.importable || !sheet.rows?.length) throw new HttpError(409, `工作表“${assignment.sheetName}”已不可导入，请重新预览`);
    }
    const existingTargets = database.listTargets();
    const results = [];
    for (const assignment of assignments) {
      const sheet = sheetMap.get(assignment.sheetName);
      try {
        const reviewed = markExistingAuthors(sheet, existingTargets);
        const { job, idempotencyReplay } = enqueueAuthorResolutionJob({
          fileName: upload.fileName,
          sheetName: assignment.sheetName,
          rows: reviewed.rows,
          boardCatalog: workbook.boardCatalog,
          defaultBoard: assignment.defaultBoard,
          uploadSha256: actualSha256,
        }, request, assignment.idempotencyKey);
        results.push({
          sheetName: assignment.sheetName,
          status: idempotencyReplay ? "replayed" : "accepted",
          job: publicAuthorResolveJob(job, { skippedLimit: 20 }),
          idempotencyReplay,
        });
      } catch (error) {
        results.push({ sheetName: assignment.sheetName, status: "rejected", error: String(error?.message ?? error).slice(0, 400), code: Number(error?.status) || 400 });
      }
    }
    const acceptedCount = results.filter((result) => result.status === "accepted").length;
    const replayedCount = results.filter((result) => result.status === "replayed").length;
    return json(response, 200, { fileName: upload.fileName, uploadSha256: actualSha256, results, acceptedCount, replayedCount, rejectedCount: results.length - acceptedCount - replayedCount });
  }
  if (request.method === "GET" && pathname === "/api/author-spreadsheet/jobs/recent") {
    access.requireRole(request, "editor");
    const limit = Math.max(1, Math.min(20, Math.trunc(Number(url.searchParams.get("limit")) || 8)));
    const mine = url.searchParams.get("scope") === "mine" || request.auth.user.role !== "admin";
    const jobs = database.listAuthorResolutionJobs(
      limit,
      mine ? { userId: request.auth.user.id } : {},
    ).map((job) => ({
      id: job.id,
      status: job.status,
      phase: job.phase,
      fileName: job.fileName,
      sheetName: job.sheetName,
      createdAt: job.createdAt,
      startedAt: job.startedAt ?? null,
      finishedAt: job.finishedAt ?? null,
    }));
    return json(response, 200, { jobs, scope: mine ? "mine" : "all" });
  }
  const authorDetailMatch = /^\/api\/author-spreadsheet\/jobs\/([0-9a-f-]{36})\/(authorised-detail|authorised-monitor)$/.exec(pathname);
  if (request.method === 'POST' && authorDetailMatch) {
    access.requireRole(request, 'editor');
    if (shuttingDown) throw new HttpError(503, '服务正在安全退出，请稍后重试');
    const job = database.getAuthorResolutionJob(authorDetailMatch[1]);
    if (!job) throw new HttpError(404, '自动核验任务不存在');
    if (job.userId !== request.auth.user.id && request.auth.user.role !== 'admin') throw new HttpError(403, '不能核验其他成员的自动核验任务');
    const body = await readJson(request, 1024);
    let input;
    try { input = prepareImportAuthorisedDetail(job, body); }
    catch { throw new HttpError(400, '请选择本任务中有明确抖音号和唯一作品 ID 的登记行'); }
    if (shuttingDown) throw new HttpError(503, '服务正在安全退出，请稍后重试');
    if (authorDetailProbeRunning || Date.now() < authorDetailProbeNotBefore) throw new HttpError(429, '单项核验正在运行或冷却中，请稍后再试');
    const disconnected = new AbortController();
    const abortIfDisconnected = () => { if (!response.writableEnded) disconnected.abort(); };
    response.once('close', abortIfDisconnected);
    const provider = new PublicWebProvider(database.getSettings(), {
      database, signal: AbortSignal.any([shutdownController.signal, disconnected.signal]), authorisedDetailEnabled: true,
    });
    let result;
    const startedAt = new Date().toISOString();
    authorDetailProbeRunning = true;
    const probe = provider.resolveAuthorisedDetail({ items: [input] });
    activeAuthorDetailProbes.add(probe);
    try { result = await probe; }
    catch (error) {
      if (disconnected.signal.aborted || response.destroyed) return;
      if (['BROWSER_LANE_BUSY', 'BROWSER_LANE_LOCKED'].includes(error.code)) throw new HttpError(409, '采集通道正在使用或等待安全清理，请稍后再试');
      throw new HttpError(503, '本次授权作品核验未完成；没有更改监控账号或历史记录');
    }
    finally {
      activeAuthorDetailProbes.delete(probe);
      response.off('close', abortIfDisconnected);
      authorDetailProbeRunning = false;
      authorDetailProbeNotBefore = Date.now() + (authorDetailMatch[2] === 'authorised-monitor' ? 5_000 : 60_000);
    }
    if (disconnected.signal.aborted || response.destroyed) return;
    if (result.status === 'unavailable') recordImportAuthorisedAttempt(database.db, job, {
      sourceRow:body.sourceRow,result,startedAt,finishedAt:new Date().toISOString(),
    });
    if (authorDetailMatch[2] === 'authorised-monitor' && result.status === 'ok') {
      if (shuttingDown) throw new HttpError(503, '服务正在安全退出，本次未更改监控');
      let admission;
      try {
        admission = commitAuthorisedImportDetail(database, job, body, result, {
          startedAt, finishedAt: new Date().toISOString(),
          createInput: row => importableAuthorTargets({fileName:job.fileName,sheetName:job.sheetName,
            ...(job.request ?? {}), rows:[row]}, []).inputs[0],
        });
      } catch (error) {
        return json(response, 409, {jobId:job.id,sourceRow:body.sourceRow,result,monitoringChanged:false,
          error:'本行暂未通过安全入库检查；没有启用新账号，请查看核验记录',
          code:['AUTHORISED_ADMISSION_BUSY','AUTHORISED_ADMISSION_STALE','AUTHORISED_ADMISSION_NOT_ELIGIBLE'].includes(error.code)
            ? error.code : 'AUTHORISED_ADMISSION_INVALID'});
      }
      return json(response, 200, {jobId:job.id,sourceRow:body.sourceRow,result,admission,monitoringChanged:admission.monitoringChanged});
    }
    // A single work observation is not full author onboarding. The strict
    // multi-evidence queue/CAS admission remains a separate, unchanged step.
    return json(response, 200, { jobId: job.id, sourceRow: body.sourceRow, result, monitoringChanged: false });
  }
  const authorMonitoringMatch = /^\/api\/author-spreadsheet\/jobs\/([0-9a-f-]{36})\/monitoring$/.exec(pathname);
  if (request.method === "GET" && authorMonitoringMatch) {
    access.requireRole(request, "editor");
    const job = database.getAuthorResolutionJob(authorMonitoringMatch[1]);
    if (!job) return json(response, 404, { error: "自动核验任务不存在" });
    if (job.userId !== request.auth.user.id && request.auth.user.role !== "admin") throw new HttpError(403, "不能查看其他成员的自动核验任务");
    try {
      return json(response, 200, readImportMonitoringStatus(database.db, job, {
        offset: url.searchParams.get("offset") ?? 0, limit: url.searchParams.get("limit") ?? 20,
        status: url.searchParams.get("status") ?? "all",
      }));
    } catch (error) {
      if (error instanceof TypeError) throw new HttpError(400, error.message);
      throw error;
    }
  }
  const authorResolveSkippedMatch = /^\/api\/author-spreadsheet\/jobs\/([0-9a-f-]{36})\/skipped$/.exec(pathname);
  if (request.method === "GET" && authorResolveSkippedMatch) {
    access.requireRole(request, "editor");
    const job = database.getAuthorResolutionJob(authorResolveSkippedMatch[1]);
    if (!job) return json(response, 404, { error: "自动核验任务不存在" });
    if (job.userId !== request.auth.user.id && request.auth.user.role !== "admin") throw new HttpError(403, "不能查看其他成员的自动核验任务");
    const skipped = Array.isArray(job.result?.skipped) ? job.result.skipped : [];
    if (url.searchParams.get("format") === "csv") {
      const header = ["源行", "状态", "作者", "平台", "板块", "所属机构 / 团队", "作者分层", "内容赛道", "负责人", "填写日期", "备注", "作者主页 / 强身份", "抖音号", "B站UID", "小红书用户ID", "作品ID", "作品 / 分享链接", "未写入原因", "身份冲突", "链接安全处理"];
      const rows = skipped.map((item) => {
        const boards = [item.board, ...(Array.isArray(item.boards) ? item.boards : [])];
        const boardNames = [...new Set(boards.map((board) => typeof board === "object" ? board?.name : board).filter(Boolean))];
        const boardField = (field) => compactAuthorText(item[field] || boards.find((board) => typeof board === "object" && board?.[field])?.[field], field === "note" ? 500 : 200);
        return [
          item.sourceRow, item.status, item.name, item.platform, boardNames.join("、"), boardField("organization"), boardField("tier"), boardField("category"), boardField("owner"), boardField("filledDate"), boardField("note"),
          item.locator, item.douyinId, item.bilibiliId, item.xiaohongshuId, item.contentId || item.videoId, item.videoLink || item.shareUrl,
          item.reason, item.identityConflict, item.rejectedLink,
        ];
      });
      const headerLine = header.map(csvEscape).join(",");
      const dataLines = rows.map((row) => row.map((value, index) => index === 0 ? csvEscape(value) : csvTextEscape(value)).join(","));
      const body = `\uFEFF${[headerLine, ...dataLines].join("\n")}`;
      return text(response, 200, body, "text/csv; charset=utf-8", { "Content-Disposition": `attachment; filename=author-review-${job.id}.csv` });
    }
    const reviewPage = projectImportReview(job, { offset: url.searchParams.get("offset"), limit: url.searchParams.get("limit"),
      query: url.searchParams.get("q"), status: url.searchParams.get("status") });
    return json(response, 200, enrichImportReviewCurrent(database.db, job, reviewPage));
  }
  const authorResolveJobMatch = /^\/api\/author-spreadsheet\/jobs\/([0-9a-f-]{36})$/.exec(pathname);
  if (request.method === "GET" && authorResolveJobMatch) {
    access.requireRole(request, "editor");
    const job = database.getAuthorResolutionJob(authorResolveJobMatch[1]);
    if (!job) return json(response, 404, { error: "自动核验任务不存在" });
    if (job.userId !== request.auth.user.id && request.auth.user.role !== "admin") throw new HttpError(403, "不能查看其他成员的自动核验任务");
    return json(response, 200, publicAuthorResolveJob(job, { skippedLimit: 200 }));
  }
  if (request.method === "POST" && pathname === "/api/author-spreadsheet/commit") {
    access.requireRole(request, "editor");
    throw new HttpError(410, "旧版直接写入接口已停用；请重新读取表格并使用自动核验加入监控");
  }
  if (request.method === "POST" && pathname === "/api/targets") {
    access.requireRole(request, "editor");
    const body = validateTarget(await readJson(request));
    try {
      const target = database.createTarget(body);
      recordAction(request, "target.create", "target", target.id, { label: target.label, type: target.type, enabled: target.enabled });
      return json(response, 201, publicTarget(target));
    }
    catch (error) { if (String(error.message).includes("UNIQUE")) return json(response, 409, { error: "该监控目标已存在" }); throw error; }
  }
  const targetAuditsMatch = /^\/api\/targets\/(\d+)\/audits$/.exec(pathname);
  if (targetAuditsMatch && request.method === "GET") {
    access.requireRole(request, "viewer");
    const target = database.getTarget(targetAuditsMatch[1]);
    if (!target) return json(response, 404, { error: "目标不存在" });
    return json(response, 200, { target: publicTarget(target), audits: database.listTargetAudits(target.id, 20) });
  }
  const targetMatch = /^\/api\/targets\/(\d+)$/.exec(pathname);
  if (targetMatch && request.method === "PATCH") {
    access.requireRole(request, "editor");
    const body = validateTarget(await readJson(request), true);
    const current = database.getTarget(targetMatch[1]);
    if (!current) return json(response, 404, { error: "目标不存在" });
    if (body.metadata) body.metadata = { ...(current.metadata ?? {}), ...body.metadata };
    const changedIdentity = body.locator !== undefined && body.locator !== current.locator
      || body.metadata?.platform !== undefined && body.metadata.platform !== (current.metadata?.platform ?? "douyin");
    if (changedIdentity) {
      body.metadata = { ...(body.metadata ?? current.metadata ?? {}) };
      delete body.metadata.resolution;
    }
    if (body.enabled === true && database.isTargetAwaitingStrictAuthorVerification(targetMatch[1])) {
      throw new HttpError(409, "该作者尚未通过历史多作品逐项复核；请按审查详情补证据，全部一致后才会恢复监控");
    }
    const updated = database.updateTarget(targetMatch[1], body);
    if (updated) recordAction(request, "target.update", "target", updated.id, { enabled: updated.enabled });
    return updated ? json(response, 200, publicTarget(updated)) : json(response, 404, { error: "目标不存在" });
  }
  if (targetMatch && request.method === "DELETE") {
    access.requireRole(request, "admin");
    const target = database.getTarget(targetMatch[1]);
    const deleted = target && database.deleteTarget(targetMatch[1]);
    if (deleted) recordAction(request, "target.delete", "target", targetMatch[1], { label: target.label });
    return deleted ? json(response, 200, { ok: true }) : json(response, 404, { error: "目标不存在" });
  }
  if (request.method === "GET" && pathname === "/api/refresh-collection") {
    access.requireRole(request, "editor");
    const jobId = url.searchParams.get("jobId");
    if (jobId !== null && !/^[0-9a-f-]{36}$/i.test(jobId)) throw new HttpError(400, "刷新任务编号无效");
    const job = refreshCollection.get(jobId);
    return jobId && !job ? json(response, 404, { error: "刷新任务不存在" }) : json(response, 200, { job });
  }
  if (request.method === "POST" && pathname === "/api/refresh-collection") {
    assertCollectionServerReady();
    access.requireRole(request, "editor");
    const body = await readJson(request, 8_000);
    assertCollectionServerReady();
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) {
      throw new HttpError(400, "刷新采集不接受账号、板块或日期筛选参数", "INVALID_COLLECTION_SCOPE");
    }
    const result = refreshCollection.request();
    if (!result.reused) recordAction(request, "refresh.collection.start", "collection", result.job.id, { scope: "all-enabled" });
    return json(response, 202, result);
  }
  if (request.method === "POST" && pathname === "/api/sync") {
    assertCollectionServerReady();
    access.requireRole(request, "editor");
    const body = await readJson(request);
    assertCollectionServerReady();
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "targetId")) {
      return json(response, 400, { error: "这里只支持指定单个目标重试；不支持其他采集范围参数", code: "INVALID_COLLECTION_SCOPE" });
    }
    const targetId = typeof body.targetId === "number" || (typeof body.targetId === "string" && /^\d+$/.test(body.targetId)) ? Number(body.targetId) : NaN;
    if (!Number.isSafeInteger(targetId) || targetId <= 0) return json(response, 400, { error: "这里只允许重试单个异常对象，请提供有效的目标 ID", code: "INVALID_COLLECTION_SCOPE" });
    const requestedTarget = database.getTarget(targetId);
    if (!requestedTarget) return json(response, 404, { error: "监控账号不存在" });
    if (!requestedTarget.enabled) return json(response, 409, { error: "此账号已暂停，请先明确恢复监控" });
    const result = await scheduler.runAll({ triggerType: "manual", targetId });
    recordAction(request, "sync.run", "target", targetId, { runId: result.runId, successCount: result.successCount, errorCount: result.errorCount });
    return json(response, 200, result);
  }
  if (request.method === "POST" && pathname === "/api/topics/sync") {
    assertCollectionServerReady();
    access.requireRole(request, "editor");
    const body = await readJson(request);
    assertCollectionServerReady();
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) return json(response, 400, { error: "话题采集不接受账号或矩阵筛选参数", code: "INVALID_COLLECTION_SCOPE" });
    const result = await scheduler.runAll({ triggerType: "manual-topics", onlyType: "hashtag" });
    recordAction(request, "topics.sync", "target", null, { runId: result.runId, successCount: result.successCount, errorCount: result.errorCount, targetCount: result.targetCount });
    return json(response, 200, result);
  }
  if (request.method === "POST" && pathname === "/api/ingest") {
    assertCollectionServerReady();
    access.requireRole(request, "editor");
    const body = await readJson(request);
    assertCollectionServerReady();
    const target = database.getTarget(body.targetId);
    if (!target) return json(response, 404, { error: "目标不存在" });
    const runId = database.beginRun("ingest", target.id, 1);
    try {
      const collection = normalizeManualCollection(target, body.data ?? body);
      database.saveCollection(target, runId, collection);
      database.finishRun(runId, { status: "success", successCount: 1, details: [{ targetId: target.id, postCount: collection.posts.length }] });
      consoleReader.invalidate();
      await reviewCommittedBatch(runId);
      recordAction(request, "data.ingest", "target", target.id, { runId, postCount: collection.posts.length });
      return json(response, 200, { ok: true, runId, qualityStatus: collection.qualityStatus, warnings: collection.warnings, postCount: collection.posts.length });
    } catch (error) {
      database.recordFailure(target, runId, error);
      database.finishRun(runId, { status: "error", errorCount: 1, details: [{ message: error.message }] });
      throw error;
    }
  }
  if (request.method === "GET" && pathname === "/api/settings") {
    access.requireRole(request, "admin");
    const settings = database.getSettings();
    return json(response, 200, Object.fromEntries([
      "publicPostsPerAccount", "publicWorksPageMode", "publicWorksPageHardLimit", "publicWorksRequestThreshold",
    ].map(key => [key, settings[key]])));
  }
  if (request.method === "POST" && pathname === "/api/settings") {
    access.requireRole(request, "admin");
    const body = await readJson(request);
    if (body.scheduleTime !== undefined) {
      const scheduleTime = parseTimeOfDay(body.scheduleTime, "");
      if (!scheduleTime) throw new Error("每日采集时间必须是 00:00–23:59");
      body.scheduleTime = scheduleTime;
    }
    if (body.viralLikeThreshold !== undefined && Number(body.viralLikeThreshold) < 0) throw new Error("爆款点赞阈值不能小于 0");
    if (body.viralRelativeMultiplier !== undefined && Number(body.viralRelativeMultiplier) < 1) throw new Error("相对爆款倍数不能小于 1");
    if (body.publicPostsPerAccount !== undefined && (Number(body.publicPostsPerAccount) < 1 || Number(body.publicPostsPerAccount) > 100)) throw new Error("单账号作品数必须在 1–100 之间");
    const settings = database.setSettings(body);
    recordAction(request, "settings.update", "settings", null, { keys: Object.keys(body) });
    return json(response, 200, settings);
  }
  if (request.method === "POST" && pathname === "/api/providers/public-web/test") {
    access.requireRole(request, "admin");
    const settings = database.getSettings();
    const probeStartedAt = Date.now();
    try {
      const result = await new PublicWebProvider(settings, { database, signal: shutdownController.signal }).testConnection();
      const probe = database.recordSourceProbe("douyin-public", {
        ok: true,
        result,
        trigger: "manual",
        durationMs: Date.now() - probeStartedAt,
      });
      return json(response, 200, { ok: true, result, probe });
    } catch (error) {
      const probe = database.recordSourceProbe("douyin-public", {
        ok: false,
        error: error?.message ?? error,
        trigger: "manual",
        durationMs: Date.now() - probeStartedAt,
      });
      return json(response, 502, { ok: false, error: String(error?.message ?? error), probe });
    }
  }
  return json(response, 404, { error: "API 不存在" });
}

export const server = createServer(async (request, response) => {
  const scope = createRequestReadScope(request, response);
  requestReadScopes.set(request, scope);
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && url.pathname === "/healthz") return json(response, 200, { ok: true, service: "douyin-monitor-workbench", console: "rebuild" });
    if (url.pathname.startsWith("/api/")) return await handleApi(request, response, url);
    if (await serveStatic(url.pathname, response)) return;
    if (!url.pathname.includes(".")) return await serveStatic("/", response);
    return json(response, 404, { error: "文件不存在" });
  } catch (error) {
    if (response.destroyed || response.writableEnded) return;
    console.error(`[${new Date().toISOString()}]`, error);
    const status = Number(error?.status) || 400;
    return json(response, status, { error: String(error?.message ?? error), ...(error?.code ? { code: error.code } : {}) });
  } finally { scope.dispose(); requestReadScopes.delete(request); }
});

// Node's fetch keeps a short-lived idle keep-alive socket after a response is
// consumed.  Close idle sockets as part of the normal close operation so
// embedded/test servers and graceful restarts do not wait indefinitely for a
// client that has already received its response. Active requests are still
// allowed to finish through the original implementation.
const closeServer = server.close.bind(server);
const openSockets = new Set();
server.on("connection", (socket) => {
  openSockets.add(socket);
  socket.once("close", () => openSockets.delete(socket));
});
server.close = (callback) => {
  // Import endpoints also schedule workers when this module is embedded.
  // Closing HTTP must close admission and timers, not leave an idle importer
  // alive forever after its request has already completed.
  shuttingDown = true;
  refreshCollection.stop();
  stopAuthorResolutionJobs();
  stopAuthorResolutionQueue();
  shutdownController.abort(new Error('服务正在关闭'));
  // Closing HTTP sockets does not mean their owned browser children have
  // exited. Embedded close and SIGTERM must both await bounded confirmation.
  const detailDrain = drainPostIngestionReviewForShutdown({
    reviewPromise: Promise.allSettled([...activeAuthorDetailProbes]), timeoutMs: 10_000,
  }).then(outcome => {
    if (!outcome.drained) console.error('授权作品核验退出清理未确认；采集通道需在下次启动时核对');
  });
  server.closeIdleConnections?.();
  // A fetch client may keep a socket in a half-open state even after its
  // response body is consumed. Give active requests a short grace period,
  // then tear down only the sockets belonging to this server so a test,
  // reload, or shutdown cannot remain stuck forever.
  const forceClose = setTimeout(() => {
    for (const socket of openSockets) socket.destroy();
  }, 2_000);
  forceClose.unref?.();
  // The reader is owned by the server module even when the module is
  // embedded by a test or another local process (where SIGTERM is not sent).
  // Close it here as well; ConsoleReader.close is idempotent, so the normal
  // signal handler can safely call it again.
  void consoleReader.close();
  const auditClosed = Promise.all([systemAuditReader.close(), scheduler.stop(), detailDrain]);
  return closeServer((...args) => {
    clearTimeout(forceClose);
    void auditClosed.then(() => callback?.(...args));
  });
};

if (isMainModule) {
  server.listen(port, host, async () => {
    try {
      database.recoverInterruptedRuns();
      database.requeueInterruptedAuthorJobs();
      let startupBackupReady = false;
      try {
        const backup = await backupManager.createBackup("startup");
        if (backup.status === "created") {
          startupBackupReady = true;
          console.log(`启动备份已完成：${backup.path}`);
        }
        else console.log("启动备份已跳过：已有备份进程正在运行");
      } catch (error) {
        console.error(`[${new Date().toISOString()}] 启动备份失败：`, error);
      }
      if (shuttingDown) return;
      const legacyStrictCount = database.countLegacyPartialEvidenceVerifications();
      if (!startupBackupReady && legacyStrictCount) {
        throw new Error(`${legacyStrictCount} 个历史多作品账号必须先完成可验证备份，不能以旧核验口径继续采集或出报表`);
      }
      if (startupBackupReady) {
        const strictReplay = database.requeueLegacyPartialEvidenceVerifications();
        if (strictReplay.requeued || strictReplay.legacyUnverifiable) {
          console.log(`严格身份迁移：逐项复核 ${strictReplay.requeued} 个历史多作品账号；拒绝 ${strictReplay.legacyUnverifiable} 条不可恢复短链`);
        }
      }
      await reviewPersistedBatches();
      // SIGTERM can arrive while startup's review queue is being reconciled.
      // Do not reopen scheduler admission after the shutdown drain has begun.
      if (shuttingDown) return;
      startupReadiness = { status: "ready", message: "" };
      scheduler.start();
      startAuthorResolutionQueue();
      startAuthorResolutionJobs();
      console.log(`内容平台监控工作台已启动：http://127.0.0.1:${port}`);
      console.log(`局域网访问：使用本机局域网 IP + 端口 ${port}`);
      console.log("运行时 AI：关闭（不会调用任何 AI 模型）");
    } catch (error) {
      if (shuttingDown) return;
      const message = String(error?.message ?? error).slice(0, 300);
      startupReadiness = { status: "failed", message: `启动已中止：${message}` };
      console.error(`[${new Date().toISOString()}] ${startupReadiness.message}`);
      return server.close(() => {
        void consoleReader.close();
        database.close();
        process.exitCode = 1;
      });
    }
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    refreshCollection.stop();
    const activeTrigger = scheduler.currentProgress?.triggerType ?? null;
    const schedulerDrain = scheduler.drain();
    // Keep an independent bounded fallback for the exact activities already
    // admitted when shutdown closed the scheduler gate. If the coordinator
    // drain reports an unexpected error, do not close SQLite ahead of these
    // collection promises.
    const activeCollectionDrain = Promise.allSettled([
      ...scheduler.activeTicks,
      ...(scheduler.currentPromise ? [scheduler.currentPromise] : []),
      ...(refreshCollection.currentPromise ? [refreshCollection.currentPromise] : []),
      ...activeAuthorDetailProbes,
    ]);
    // Other request/author jobs stop immediately. The active works-only
    // collector has its own signal so one 45-second public request can finish
    // and persist without keeping unrelated background work alive.
    shutdownController.abort(new Error("服务正在关闭"));
    if (activeTrigger !== "works-only") worksOnlyShutdownController.abort(new Error("服务正在关闭"));
    stopAuthorResolutionQueue();
    stopAuthorResolutionJobs();
    try { database.releaseAuthorResolutionQueue(authorQueueWorkerId); }
    catch (error) { console.error(`[${new Date().toISOString()}] 作者核验队列交接失败：`, error); }
    try { database.releaseAuthorResolutionJobs(authorJobWorkerId); }
    catch (error) { console.error(`[${new Date().toISOString()}] 作者核验任务交接失败：`, error); }
    // Close admission before choosing the signal policy. A works-only browser
    // request has a 45-second provider deadline; give it one bounded window to
    // finish and persist before cancelling its child. Scheduled/profile batches
    // still use the short cancellation path, so maintenance must avoid their
    // window. Startup recovery remains the fallback after a genuine timeout.
    const collectionSettled = (async () => {
      return await drainSchedulerForShutdown({
        schedulerDrain,
        activeCollectionDrain,
        controller: worksOnlyShutdownController,
        activeTrigger,
        worksOnlyGraceMs: 60_000,
        abortGraceMs: 10_000,
        onDrainError: (error) => console.error(`[${new Date().toISOString()}] 采集排空异常：`, error),
        onWorksGraceTimeout: () => console.error(`[${new Date().toISOString()}] 作品请求排空超过60秒；将中止并继续等待有限收尾时间。`),
        onAbortTimeout: () => console.error(`[${new Date().toISOString()}] 采集取消后仍未在10秒内排空；将由启动恢复流程核验未完成运行。`),
      });
    })();
    server.close(async () => {
      const shutdownOutcome = await collectionSettled;
      if (shutdownOutcome.timedOut || !shutdownOutcome.drained) {
        console.error(`[${new Date().toISOString()}] 服务停机前采集器未能确认收尾；未完成运行将在下次启动时按恢复流程核验。`);
      } else if (shutdownOutcome.forced) {
        console.error(`[${new Date().toISOString()}] 服务采用了有界取消停机；采集器已在数据库关闭前完成收尾。`);
      }
      const reviewOutcome = await drainPostIngestionReviewForShutdown({ reviewPromise: ingestionReviewChain });
      if (!reviewOutcome.drained) {
        console.error(`[${new Date().toISOString()}] 入库回执未在停机宽限内确认完成；持久化数据保留，下一次启动将有界恢复缺失回执。`);
      }
      void consoleReader.close();
      database.close();
      process.exit(0);
    });
  });
}
