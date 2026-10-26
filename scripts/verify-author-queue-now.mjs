import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MonitorDatabase } from "../lib/database.mjs";
import { verifyQueuedAuthorEvidence } from "../lib/author-resolution.mjs";
import { authorQueuePlatform, queuedAuthorAccountLocator, queuedBilibiliId } from "../lib/author-queue-identity.mjs";
import { PublicWebProvider } from "../lib/providers/public-web.mjs";
import { normalizeLarkSheetUrl } from "../lib/lark-sheet-source.mjs";

export function parseArgs(argv) {
  const options = { batchSize: 36, resolver: "signed-only" };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--db") options.db = argv[++index];
    else if (value === "--batch-size") options.batchSize = Number(argv[++index]);
    else if (value === "--resolver") options.resolver = String(argv[++index] ?? "");
    else if (value === "--file-name") {
      options.fileName = argv[++index];
      if (options.fileName === undefined) throw new Error("--file-name 必须提供非空精确文件名");
    }
    else if (value === "--retry-now") options.retryNow = true;
    else throw new Error(`未知参数：${value}`);
  }
  if (!options.db) throw new Error("用法：node scripts/verify-author-queue-now.mjs --db <sqlite> [--batch-size 36] [--file-name <精确文件名> [--retry-now]]");
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 36) {
    throw new Error("批次大小必须是 1–36 的整数");
  }
  if (!["browser-first", "signed-only"].includes(options.resolver)) {
    throw new Error("核验器必须是 browser-first 或 signed-only");
  }
  validateFileScope(options);
  return { ...options, db: resolve(options.db) };
}

function validateFileScope(options) {
  if (options.fileName !== undefined && (typeof options.fileName !== "string" || !options.fileName.trim()
    || options.fileName.length > 240 || options.fileName.startsWith("--"))) throw new Error("--file-name 必须提供非空精确文件名（最多 240 字）");
  if (options.retryNow && !options.fileName) throw new Error("--retry-now 必须同时指定 --file-name，禁止全局提前重试");
}

function retryAt(attempts) {
  const minutes = [30, 60, 120, 360, 720, 1_440][Math.min(Math.max(0, Number(attempts) || 0), 5)];
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export function queuedAuthorEvidenceRequest(item) {
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
    boards: Array.isArray(item.boards) ? item.boards : [],
    videoIds: Array.isArray(item.videoIds) ? item.videoIds : [],
    shareUrls: Array.isArray(item.shareUrls) ? item.shareUrls : [],
    sourceRows: Array.isArray(item.sourceRows) ? item.sourceRows : [],
  };
}

function targetInput(item, row) {
  const platform = authorQueuePlatform(item);
  const source = item.sourceMetadata && typeof item.sourceMetadata === "object" ? item.sourceMetadata : {};
  const sourceType = source.sourceType === "lark-sheet" ? "lark-sheet" : "author-spreadsheet";
  let sourceUrl;
  if (sourceType === "lark-sheet" && source.sourceUrl) {
    try { sourceUrl = normalizeLarkSheetUrl(source.sourceUrl); } catch {}
  }
  const sourceTitle = String(source.sourceTitle ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const sourceRevision = Math.max(0, Math.trunc(Number(source.sourceRevision) || 0));
  const sourceSheetId = String(source.sourceSheetId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  const sourceRange = String(source.sourceRange ?? "").replace(/[^A-Za-z0-9:$]/g, "").slice(0, 80);
  const sourceSha256 = /^[a-f0-9]{64}$/i.test(String(source.sourceSha256 ?? "")) ? String(source.sourceSha256).toLowerCase() : "";
  const sourceExportSha256 = /^[a-f0-9]{64}$/i.test(String(source.sourceExportSha256 ?? "")) ? String(source.sourceExportSha256).toLowerCase() : "";
  const sourceReadAt = Number.isNaN(new Date(source.sourceReadAt).getTime()) ? "" : new Date(source.sourceReadAt).toISOString();
  const submittedName = String(item.name ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const submittedId = platform === "bilibili" ? queuedBilibiliId(item) : String(item.douyin_id ?? "").trim();
  return {
    label: String(row.name ?? item.name).replace(/\s+/g, " ").trim().slice(0, 120),
    locator: row.locator,
    metadata: {
      platform,
      importSource: {
        type: sourceType,
        fileName: basename(String(item.file_name ?? "")).slice(0, 240),
        sheetName: String(item.sheet_name ?? "").slice(0, 120),
        sourceRow: Math.max(1, Math.trunc(Number(item.sourceRows?.[0]) || 1)),
        importedAt: new Date().toISOString(),
        ...(sourceUrl ? { sourceUrl } : {}), ...(sourceTitle ? { sourceTitle } : {}),
        ...(sourceRevision ? { sourceRevision } : {}), ...(sourceSheetId ? { sourceSheetId } : {}),
        ...(sourceRange ? { sourceRange } : {}), ...(sourceSha256 ? { sourceSha256 } : {}),
        ...(sourceExportSha256 ? { sourceExportSha256 } : {}), ...(sourceReadAt ? { sourceReadAt } : {}),
      },
      ...(submittedName ? { submittedName } : { autoLabelPending: true }),
      ...(submittedId ? { [platform === "bilibili" ? "bilibiliId" : platform === "xiaohongshu" ? "xiaohongshuId" : "douyinId"]: submittedId.slice(0, 120) } : {}),
      ...(item.videoIds?.[0] ? { evidenceVideoId: String(item.videoIds[0]).slice(0, 40) } : {}),
      ...(item.organization ? { organization: String(item.organization).trim().slice(0, 200) } : {}),
      ...(item.tier ? { tier: String(item.tier).trim().slice(0, 120) } : {}),
      ...(item.category ? { category: String(item.category).trim().slice(0, 120) } : {}),
      ...(row.resolution ? { resolution: row.resolution } : {}),
    },
    boards: Array.isArray(item.boards) ? item.boards : [],
  };
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export async function processClaimedAuthorResolutionBatch({ database, provider, batch, workerId }) {
  const batchStats = { resolved: 0, retry: 0, rejected: 0 };
  let resolutionData;
  try {
    resolutionData = await provider.resolveAuthors(batch.map(queuedAuthorEvidenceRequest));
  } catch (error) {
    for (const item of batch) {
      database.markAuthorResolutionRetry(item.id, error?.message, retryAt(item.attempts), {
        owner: workerId,
        evidenceVersion: item.evidence_version,
      });
    }
    return { ...batchStats, retry: batch.length, error: String(error?.message ?? error).slice(0, 300) };
  }

  const resultByKey = new Map((resolutionData.items ?? []).map((item) => [String(item?.key ?? ""), item]));
  for (const item of batch) {
    const request = queuedAuthorEvidenceRequest(item);
    const evidence = resultByKey.get(item.identity_key) ?? {
      key: item.identity_key,
      candidates: [],
      errors: [{ error: "公开核验未返回结果" }],
    };
    const verification = verifyQueuedAuthorEvidence(request, evidence);
    if (verification.status === "ready" && verification.row?.locator) {
      const committed = database.commitAuthorResolutionTarget(item.id, targetInput(item, verification.row), {
        fileName: item.file_name,
        sheetName: item.sheet_name,
      }, { owner: workerId, evidenceVersion: item.evidence_version });
      if (committed) batchStats.resolved += 1;
      continue;
    }
    if (["rejected", "invalid"].includes(verification.status)) {
      database.markAuthorResolutionRejected(item.id, verification.reason, {
        owner: workerId,
        evidenceVersion: item.evidence_version,
      });
      batchStats.rejected += 1;
      continue;
    }
    const detail = evidence.errors?.map((entry) => entry?.error).filter(Boolean).join("；") || verification.reason;
    database.markAuthorResolutionRetry(item.id, detail, retryAt(item.attempts), {
      owner: workerId,
      evidenceVersion: item.evidence_version,
    });
    batchStats.retry += 1;
  }
  return batchStats;
}

export async function runAuthorQueueVerification(options, {
  emitEvent = emit,
  databaseFactory = (filePath) => new MonitorDatabase(filePath),
  providerFactory = (database) => new PublicWebProvider(database.getSettings(), { database, authorResolverMode: options.resolver }),
} = {}) {
  validateFileScope(options);
  const database = databaseFactory(options.db);
  const workerId = `manual-${process.pid}-${randomUUID()}`;
  const totals = { requested: 0, resolved: 0, retry: 0, rejected: 0, batches: 0 };
  const attemptedIds = new Set();

  emitEvent({ event: "start", batchSize: options.batchSize, mode: options.resolver,
    fileName: options.fileName ?? null, retryNow: options.retryNow === true, paidApi: false, apiKey: false });

  try {
    const provider = providerFactory(database);
    while (true) {
      const batch = database.claimDueAuthorResolutions(options.batchSize, {
        owner: workerId, leaseMs: 30 * 60_000,
        ...(options.fileName !== undefined ? { fileName: options.fileName } : {}),
        ...(options.retryNow ? { includeNotDueRetries: true, excludeIds: [...attemptedIds] } : {}),
      });
      if (!batch.length) break;
      for (const item of batch) attemptedIds.add(item.id);
      totals.requested += batch.length;
      const batchNumber = totals.batches + 1;
      emitEvent({ event: "batch-start", batch: batchNumber, size: batch.length, processed: totals.requested - batch.length });

      const batchStats = await processClaimedAuthorResolutionBatch({ database, provider, batch, workerId });
      totals.resolved += batchStats.resolved;
      totals.retry += batchStats.retry;
      totals.rejected += batchStats.rejected;
      totals.batches += 1;
      emitEvent({
        event: "batch-complete",
        batch: batchNumber,
        resolved: batchStats.resolved,
        retry: batchStats.retry,
        rejected: batchStats.rejected,
        ...(batchStats.error ? { error: batchStats.error } : {}),
        processed: totals.requested,
        targets: database.listTargets().length,
        queue: database.getAuthorResolutionQueueSummary(),
      });
    }

    emitEvent({
      event: "complete",
      ...totals,
      targets: database.listTargets().length,
      queue: database.getAuthorResolutionQueueSummary(),
    });
    return totals;
  } finally {
    database.releaseAuthorResolutionQueue(workerId);
    database.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runAuthorQueueVerification(parseArgs(process.argv.slice(2)));
}
