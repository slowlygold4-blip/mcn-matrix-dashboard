import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { validateSQLiteSnapshot, validationCountsMatch } from "./backup-manager.mjs";

const BACKUP_RE = /^douyin-monitor-auto-.*\.sqlite$/;

function sha256FileSync(filePath) {
  const hash = createHash("sha256");
  const descriptor = openSync(filePath, "r");
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let bytes;
    while ((bytes = readSync(descriptor, chunk, 0, chunk.length, null)) > 0) {
      hash.update(chunk.subarray(0, bytes));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function validManifestValidation(validation) {
  return validation
    && validation.quickCheck === "ok"
    && validation.integrityCheck === "ok"
    && Number(validation.foreignKeyViolations || 0) === 0
    && validation.counts
    && Object.values(validation.counts).every((value) => Number.isInteger(Number(value)) && Number(value) >= 0);
}

/**
 * Inspect the newest automatic SQLite backup without changing it.
 * Shallow mode checks the atomically-published manifest and file size; deep
 * mode additionally re-hashes and re-runs SQLite integrity checks.
 */
export function inspectLatestBackup(backupDir, { verifyHash = false, verifySQLite = false } = {}) {
  const checkedAt = new Date().toISOString();
  // A failed automatic backup is durable across a service restart. Keep it
  // visible even when an older valid snapshot still exists; otherwise the
  // dashboard could report a healthy historical backup while the latest
  // scheduled protection silently failed.
  try {
    const failurePath = join(backupDir, ".last-backup-error.json");
    const failure = JSON.parse(readFileSync(failurePath, "utf8"));
    return {
      status: "error",
      checkedAt,
      error: `最近一次自动备份失败：${String(failure?.error ?? "未知错误").slice(0, 300)}`,
      lastFailureAt: failure?.failedAt || null,
      failureReason: failure?.reason || null,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") return { status: "error", checkedAt, error: "自动备份失败回执无法读取" };
  }
  let candidates;
  try {
    candidates = readdirSync(backupDir)
      .filter((name) => BACKUP_RE.test(name))
      .map((fileName) => ({ fileName, path: join(backupDir, fileName), mtimeMs: statSync(join(backupDir, fileName)).mtimeMs }))
      .sort((left, right) => right.mtimeMs - left.mtimeMs || right.fileName.localeCompare(left.fileName));
  } catch (error) {
    return { status: "missing", checkedAt, error: `自动备份目录不可读：${String(error?.message ?? error).slice(0, 240)}` };
  }
  if (!candidates.length) return { status: "missing", checkedAt, error: "尚未生成自动备份" };

  const newest = candidates[0];
  try {
    const manifest = JSON.parse(readFileSync(`${newest.path}.manifest.json`, "utf8"));
    const fileBytes = statSync(newest.path).size;
    if (Number(manifest.bytes) !== fileBytes) throw new Error("备份文件大小与清单不一致");
    if (!validManifestValidation(manifest.validation)) throw new Error("备份清单中的 SQLite 完整性结果未通过");
    let sha256Matched = "not-checked";
    if (verifyHash) {
      sha256Matched = sha256FileSync(newest.path) === manifest.sha256;
      if (!sha256Matched) throw new Error("备份文件 SHA-256 与清单不一致");
    }
    const validation = verifySQLite ? validateSQLiteSnapshot(newest.path) : manifest.validation;
    if (!validManifestValidation(validation)) throw new Error("备份文件重新校验未通过");
    if (!validationCountsMatch(manifest.validation?.counts, validation.counts)) {
      throw new Error("备份 SQLite 行数与清单不一致");
    }
    return {
      status: "ok",
      checkedAt,
      fileName: newest.fileName,
      createdAt: manifest.createdAt || null,
      reason: manifest.reason || null,
      bytes: fileBytes,
      ageMs: (() => {
        const createdAt = manifest.createdAt ? new Date(manifest.createdAt).getTime() : newest.mtimeMs;
        return Number.isFinite(createdAt) ? Math.max(0, Date.now() - createdAt) : null;
      })(),
      verification: verifySQLite ? "sha256+sqlite" : verifyHash ? "sha256" : "manifest",
      sha256Matched,
      validation,
    };
  } catch (error) {
    return {
      status: "error",
      checkedAt,
      fileName: newest.fileName,
      error: String(error?.message ?? error).slice(0, 300),
    };
  }
}
