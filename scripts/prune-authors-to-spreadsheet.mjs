import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseAuthorSpreadsheet } from "../lib/author-spreadsheet.mjs";

function parseArgs(argv) {
  const options = { execute: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--execute") options.execute = true;
    else if (value === "--db") options.db = argv[++index];
    else if (value === "--source") options.source = argv[++index];
    else throw new Error(`未知参数：${value}`);
  }
  if (!options.db || !options.source) {
    throw new Error("用法：node scripts/prune-authors-to-spreadsheet.mjs --db <sqlite> --source <xlsx> [--execute]");
  }
  return { ...options, db: resolve(options.db), source: resolve(options.source) };
}

function normalizedIdentity(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function identityKey({ douyinId, name }) {
  const normalizedId = normalizedIdentity(douyinId);
  if (normalizedId) return `douyin:${normalizedId}`;
  const normalizedName = normalizedIdentity(name);
  return normalizedName ? `name:${normalizedName}` : null;
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function detailCounts(details) {
  const errorCount = details.filter((item) => item?.status === "error").length;
  const successCount = details.filter((item) => !["error", "skipped"].includes(item?.status)).length;
  return {
    errorCount,
    successCount,
    status: errorCount === 0 ? "success" : successCount > 0 ? "partial" : "error",
  };
}

function difference(left, right) {
  return [...left].filter((value) => !right.has(value));
}

const options = parseArgs(process.argv.slice(2));
const sourceBuffer = readFileSync(options.source);
const sourceChecksum = createHash("sha256").update(sourceBuffer).digest("hex");
const preview = await parseAuthorSpreadsheet({
  buffer: sourceBuffer,
  fileName: basename(options.source),
});

const sourceIdentities = new Set();
const sourceIds = new Set();
const sourceNames = new Set();
for (const row of preview.rows) {
  const key = identityKey(row);
  if (key) sourceIdentities.add(key);
  const douyinId = normalizedIdentity(row.douyinId);
  const name = normalizedIdentity(row.name);
  if (douyinId) sourceIds.add(douyinId);
  if (name) sourceNames.add(name);
}
if (!sourceIdentities.size) throw new Error("源表格中没有可识别的作者身份，已停止清理");

const database = new DatabaseSync(options.db);
database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");

const targets = database.prepare(`
  SELECT id,type,label,locator,provider,metadata_json FROM targets ORDER BY id
`).all();
const queue = database.prepare(`
  SELECT id,identity_key,name,douyin_id,status,resolved_target_id FROM author_resolution_queue ORDER BY id
`).all();

const keptTargets = [];
const removedTargets = [];
for (const target of targets) {
  const metadata = safeJson(target.metadata_json, {});
  const douyinId = normalizedIdentity(metadata?.douyinId ?? metadata?.resolution?.publicDouyinId);
  const name = normalizedIdentity(target.label);
  const belongsToSource = target.type === "account"
    && ((douyinId && sourceIds.has(douyinId)) || (name && sourceNames.has(name)));
  (belongsToSource ? keptTargets : removedTargets).push({ ...target, metadata, douyinId, name });
}

const keptQueue = [];
const removedQueue = [];
for (const item of queue) {
  const key = identityKey({ douyinId: item.douyin_id, name: item.name });
  (key && sourceIdentities.has(key) ? keptQueue : removedQueue).push({ ...item, key });
}

const plannedIdentities = new Set([
  ...keptTargets.map((target) => identityKey({ douyinId: target.douyinId, name: target.label })).filter(Boolean),
  ...keptQueue.map((item) => item.key).filter(Boolean),
]);
const missingIdentities = difference(sourceIdentities, plannedIdentities);
const extraIdentities = difference(plannedIdentities, sourceIdentities);
if (missingIdentities.length || extraIdentities.length) {
  throw new Error(`保留范围校验失败：缺少 ${missingIdentities.length} 个、额外 ${extraIdentities.length} 个作者身份`);
}

const removedTargetIds = new Set(removedTargets.map((target) => Number(target.id)));
const preDeleteCounts = {
  targets: removedTargets.length,
  accountTargets: removedTargets.filter((target) => target.type === "account").length,
  nonAuthorTargets: removedTargets.filter((target) => target.type !== "account").length,
  posts: 0,
  postMetrics: 0,
  snapshots: 0,
  audits: 0,
};
const countPosts = database.prepare("SELECT COUNT(*) AS count FROM posts WHERE target_id=?");
const countPostMetrics = database.prepare(`
  SELECT COUNT(*) AS count FROM post_metrics pm JOIN posts p ON p.id=pm.post_id WHERE p.target_id=?
`);
const countSnapshots = database.prepare("SELECT COUNT(*) AS count FROM snapshots WHERE target_id=?");
const countAudits = database.prepare("SELECT COUNT(*) AS count FROM audits WHERE target_id=?");
for (const targetId of removedTargetIds) {
  preDeleteCounts.posts += Number(countPosts.get(targetId).count);
  preDeleteCounts.postMetrics += Number(countPostMetrics.get(targetId).count);
  preDeleteCounts.snapshots += Number(countSnapshots.get(targetId).count);
  preDeleteCounts.audits += Number(countAudits.get(targetId).count);
}

const plan = {
  mode: options.execute ? "execute" : "dry-run",
  source: {
    fileName: basename(options.source),
    selectedSheet: preview.selectedSheet,
    checksumSha256: sourceChecksum,
    rows: preview.rows.length,
    authorIdentities: sourceIdentities.size,
  },
  preserve: {
    verifiedTargets: keptTargets.length,
    queuedAuthors: keptQueue.length,
    coveredAuthorIdentities: plannedIdentities.size,
  },
  remove: {
    ...preDeleteCounts,
    queuedAuthors: removedQueue.length,
  },
};

if (!options.execute) {
  console.log(JSON.stringify(plan, null, 2));
  database.close();
  process.exit(0);
}

database.exec("BEGIN IMMEDIATE;");
try {
  const deleteAudit = database.prepare("DELETE FROM audits WHERE target_id=?");
  const deleteActivity = database.prepare(`
    DELETE FROM activity_log WHERE resource_type='target' AND resource_id=?
  `);
  const deleteTarget = database.prepare("DELETE FROM targets WHERE id=?");
  const deleteQueue = database.prepare("DELETE FROM author_resolution_queue WHERE id=?");
  const deleteRun = database.prepare("DELETE FROM runs WHERE id=?");
  const updateRun = database.prepare(`
    UPDATE runs SET target_id=?, target_count=?, success_count=?, error_count=?, status=?, details_json=? WHERE id=?
  `);

  for (const targetId of removedTargetIds) {
    deleteAudit.run(targetId);
    deleteActivity.run(String(targetId));
  }

  let deletedRuns = 0;
  let updatedRuns = 0;
  const runs = database.prepare(`
    SELECT id,target_id,status,details_json FROM runs ORDER BY id
  `).all();
  for (const run of runs) {
    const details = safeJson(run.details_json, []);
    const filtered = Array.isArray(details)
      ? details.filter((item) => !removedTargetIds.has(Number(item?.targetId)))
      : [];
    const targetWasRemoved = run.target_id !== null && removedTargetIds.has(Number(run.target_id));
    const isLegacyHistoryRun = details.some((item) => item?.source === "jixuan-history");
    if (isLegacyHistoryRun || (details.length > 0 && filtered.length === 0) || (targetWasRemoved && details.length === 0)) {
      deleteRun.run(run.id);
      deletedRuns += 1;
      continue;
    }
    if (filtered.length !== details.length || targetWasRemoved) {
      const counts = detailCounts(filtered);
      updateRun.run(
        targetWasRemoved ? null : run.target_id,
        filtered.length,
        counts.successCount,
        counts.errorCount,
        counts.status,
        JSON.stringify(filtered),
        run.id,
      );
      updatedRuns += 1;
    }
  }

  for (const item of removedQueue) deleteQueue.run(item.id);
  for (const target of removedTargets) deleteTarget.run(target.id);

  database.prepare("DELETE FROM activity_log WHERE action='sync.run'").run();
  database.prepare(`
    INSERT INTO activity_log(user_id,actor_name,action,resource_type,resource_id,created_at,client_ip,details_json)
    VALUES(NULL,'系统清理','authors.scope.prune','target',NULL,?,NULL,?)
  `).run(new Date().toISOString(), JSON.stringify({
    sourceFile: basename(options.source),
    sourceChecksum,
    preservedVerifiedTargets: keptTargets.length,
    preservedQueuedAuthors: keptQueue.length,
    removedTargets: removedTargets.length,
  }));

  const remainingTargets = database.prepare("SELECT COUNT(*) AS count FROM targets").get().count;
  const remainingAccounts = database.prepare("SELECT COUNT(*) AS count FROM targets WHERE type='account'").get().count;
  const remainingNonAccounts = database.prepare("SELECT COUNT(*) AS count FROM targets WHERE type<>'account'").get().count;
  const remainingQueue = database.prepare("SELECT COUNT(*) AS count FROM author_resolution_queue").get().count;
  if (Number(remainingTargets) !== keptTargets.length
      || Number(remainingAccounts) !== keptTargets.length
      || Number(remainingNonAccounts) !== 0
      || Number(remainingQueue) !== keptQueue.length) {
    throw new Error("事务后数量校验失败，已回滚");
  }

  database.exec("COMMIT;");
  database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  console.log(JSON.stringify({
    ...plan,
    runs: { deleted: deletedRuns, updated: updatedRuns },
    result: {
      targets: Number(remainingTargets),
      accountTargets: Number(remainingAccounts),
      nonAuthorTargets: Number(remainingNonAccounts),
      queuedAuthors: Number(remainingQueue),
    },
  }, null, 2));
} catch (error) {
  database.exec("ROLLBACK;");
  throw error;
} finally {
  database.close();
}
