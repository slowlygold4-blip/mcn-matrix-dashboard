import { compressVerifiedBackup, withReadableBackup } from './backup-compression.mjs';
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// These tables form the minimum replayable monitoring evidence. Board
// membership and source probes are included so a restore cannot silently lose
// the user's board scope or provenance trail while keeping the targets.
const REQUIRED_TABLES = [
  "targets",
  "board_catalog",
  "target_boards",
  "posts",
  "post_metrics",
  "snapshots",
  "runs",
  "audits",
  "source_probes",
  "author_resolution_queue",
  "author_resolution_jobs",
];
// Added after v1 backups shipped. Old snapshots remain restorable, but a new
// evidence table may never disappear between its manifest and database.
const OPTIONAL_EVIDENCE_TABLES = ["account_events", "author_resolution_import_sources", "author_resolution_success_receipts", "author_resolution_idempotency", "works_observations", "master_roster_imports", "master_roster_entries", "creator_source_imports", "creator_source_sheets", "creator_source_rows", "creator_source_account_links", "creator_source_work_links", "creator_source_registry_additions", "creator_source_external_deltas"];

export function validationCountsMatch(expected, actual) {
  if (!expected || !actual || typeof expected !== "object" || typeof actual !== "object") return false;
  const optionalTables = OPTIONAL_EVIDENCE_TABLES.filter((table) => Object.hasOwn(expected, table) || Object.hasOwn(actual, table));
  if (optionalTables.some((table) => !Object.hasOwn(expected, table) || !Object.hasOwn(actual, table)
    || !Number.isSafeInteger(expected[table]) || expected[table] < 0
    || !Number.isSafeInteger(actual[table]) || actual[table] < 0)) return false;
  return [...REQUIRED_TABLES, ...optionalTables].every((table) => {
    const expectedCount = Number(expected[table]);
    const actualCount = Number(actual[table]);
    return Number.isInteger(expectedCount) && expectedCount >= 0
      && Number.isInteger(actualCount) && actualCount >= 0
      && expectedCount === actualCount;
  });
}

function runFile(execFileImpl, file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl(file, args, options, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || error.message).trim()));
      resolve(String(stdout ?? ""));
    });
  });
}

async function sha256File(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function checkRowsAreOk(rows) {
  return rows.length > 0 && rows.every((row) => Object.values(row)[0] === "ok");
}

function makeStandaloneSnapshot(filePath) {
  const database = new DatabaseSync(filePath);
  try {
    const row = database.prepare("PRAGMA journal_mode=DELETE").get();
    if (String(Object.values(row)[0]).toLowerCase() !== "delete") throw new Error("无法将备份切换为独立 DELETE 日志模式");
  } finally {
    database.close();
  }
}

export function validateSQLiteSnapshot(filePath) {
  let database;
  try {
    database = new DatabaseSync(filePath, { readOnly: true });
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    const missingTables = REQUIRED_TABLES.filter((name) => !tables.has(name));
    const quickRows = database.prepare("PRAGMA quick_check").all();
    const integrityRows = database.prepare("PRAGMA integrity_check").all();
    const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
    if (missingTables.length || !checkRowsAreOk(quickRows) || !checkRowsAreOk(integrityRows) || foreignKeyViolations.length) {
      throw new Error(`SQLite 快照校验失败：缺少表 ${missingTables.join(",") || "无"}；quick_check=${JSON.stringify(quickRows)}；integrity_check=${JSON.stringify(integrityRows)}；foreign_key_violations=${foreignKeyViolations.length}`);
    }
    const counts = {};
    const countedTables = [...REQUIRED_TABLES, ...OPTIONAL_EVIDENCE_TABLES.filter((table) => tables.has(table))];
    for (const table of countedTables) counts[table] = Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
    return { quickCheck: "ok", integrityCheck: "ok", foreignKeyViolations: 0, counts };
  } catch (error) {
    throw new Error(`无法验证 SQLite 快照：${error.message}`);
  } finally {
    try { database?.close(); } catch {}
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export class SQLiteBackupManager {
  constructor({ databasePath, backupDir, retention = 14, sqlitePath = "/usr/bin/sqlite3", execFileImpl = execFile, lockTtlMs = 30 * 60_000 } = {}) {
    if (!databasePath || !backupDir) throw new Error("SQLite 备份缺少数据库或备份目录");
    this.databasePath = databasePath;
    this.backupDir = backupDir;
    this.retention = Math.max(2, Math.min(60, Number(retention) || 14));
    this.sqlitePath = sqlitePath;
    this.execFileImpl = execFileImpl;
    this.lockTtlMs = Math.max(60_000, Number(lockTtlMs) || 30 * 60_000);
    this.lockPath = join(backupDir, ".automatic-backup.lock");
    this.failurePath = join(backupDir, ".last-backup-error.json");
    this.runningPromise = null;
  }

  createBackup(reason = "manual") {
    if (this.runningPromise) return this.runningPromise;
    this.runningPromise = this.performBackup(reason).finally(() => { this.runningPromise = null; });
    return this.runningPromise;
  }

  async acquireLock() {
    await mkdir(this.backupDir, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = randomUUID();
      try {
        const handle = await open(this.lockPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }));
        await handle.close();
        return token;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        let existing = null;
        let ageMs = 0;
        try {
          existing = JSON.parse(await readFile(this.lockPath, "utf8"));
          ageMs = Date.now() - (await stat(this.lockPath)).mtimeMs;
        } catch {}
        const stale = existing?.pid ? !processIsAlive(Number(existing.pid)) : ageMs > this.lockTtlMs;
        if (!stale) return null;
        try { await unlink(this.lockPath); } catch (unlinkError) { if (unlinkError?.code !== "ENOENT") throw unlinkError; }
      }
    }
    return null;
  }

  async releaseLock(token) {
    try {
      const existing = JSON.parse(await readFile(this.lockPath, "utf8"));
      if (existing.token === token) await unlink(this.lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }

  async performBackup(reason) {
    const lockToken = await this.acquireLock();
    if (!lockToken) return { status: "skipped", reason: "backup-locked" };
    const createdAt = new Date();
    const safeReason = String(reason ?? "manual").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "manual";
    const stamp = createdAt.toISOString().replace(/[-:.]/g, "");
    const fileName = `douyin-monitor-auto-${stamp}-${safeReason}-${randomUUID().slice(0, 8)}.sqlite`;
    const finalPath = join(this.backupDir, fileName);
    const partialPath = `${finalPath}.partial`;
    const manifestPath = `${finalPath}.manifest.json`;
    const partialManifestPath = `${manifestPath}.partial`;
    try {
      await runFile(this.execFileImpl, this.sqlitePath, [this.databasePath, `.backup ${JSON.stringify(partialPath)}`], {
        timeout: 10 * 60_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      makeStandaloneSnapshot(partialPath);
      await chmod(partialPath, 0o600);
      const validation = validateSQLiteSnapshot(partialPath);
      await rename(partialPath, finalPath);
      const fileStat = await stat(finalPath);
      const manifest = {
        format: "sqlite-online-backup-v1",
        createdAt: createdAt.toISOString(),
        reason: safeReason,
        source: this.databasePath,
        fileName,
        bytes: fileStat.size,
        sha256: await sha256File(finalPath),
        validation,
      };
      await writeFile(partialManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(partialManifestPath, manifestPath);
      try { await unlink(this.failurePath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      await this.prune();
      return { status: "created", path: finalPath, manifestPath, manifest };
    } catch (error) {
      try {
        const failure = {
          failedAt: new Date().toISOString(),
          reason: safeReason,
          error: String(error?.message ?? error).slice(0, 500),
        };
        const temporaryFailurePath = `${this.failurePath}.${process.pid}.${randomUUID()}.partial`;
        await writeFile(temporaryFailurePath, `${JSON.stringify(failure, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temporaryFailurePath, this.failurePath);
      } catch (failureWriteError) {
        console.error(`[${new Date().toISOString()}] 自动备份失败回执写入失败：`, failureWriteError);
      }
      for (const path of [partialPath, `${partialPath}-wal`, `${partialPath}-shm`, partialManifestPath]) {
        try { await unlink(path); } catch (unlinkError) { if (unlinkError?.code !== "ENOENT") throw unlinkError; }
      }
      throw error;
    } finally {
      await this.releaseLock(lockToken);
    }
  }

  async prune() {
    const entries = await readdir(this.backupDir, { withFileTypes: true });
    const snapshots = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^douyin-monitor-auto-.*\.sqlite(?:\.gz)?$/.test(entry.name)) continue;
      const path = join(this.backupDir, entry.name);
      snapshots.push({ path, mtimeMs: (await stat(path)).mtimeMs });
    }
    snapshots.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));
    for (const snapshot of snapshots.slice(this.retention)) {
      const originalPath = snapshot.path.replace(/\.gz$/, "");
      for (const path of [snapshot.path, `${originalPath}-wal`, `${originalPath}-shm`, `${originalPath}.manifest.json`]) {
        try { await unlink(path); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      }
    }
    // Keep three immediate restore points; older retained snapshots are losslessly compressed.
    for (const snapshot of snapshots.slice(3, this.retention)) {
      if (!snapshot.path.endsWith('.gz')) await compressVerifiedBackup(snapshot.path);
    }
  }

  async verifySnapshot(backupPath) {
    if (backupPath.endsWith('.sqlite.gz')) return withReadableBackup(backupPath, path => this.verifySnapshot(path));
    const manifestPath = `${backupPath}.manifest.json`;
    let manifest;
    try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); }
    catch (error) { throw new Error(`备份清单无法读取：${error.message}`); }
    const fileStat = await stat(backupPath);
    if (Number(manifest.bytes) !== fileStat.size) throw new Error("备份文件大小与清单不一致");
    const sha256 = await sha256File(backupPath);
    if (manifest.sha256 !== sha256) throw new Error("备份文件 SHA-256 与清单不一致");
    const validation = validateSQLiteSnapshot(backupPath);
    if (!validationCountsMatch(manifest.validation?.counts, validation.counts)) {
      throw new Error("备份 SQLite 行数与清单不一致");
    }
    return { manifest, validation };
  }

  async restoreSnapshot(backupPath, destinationPath) {
    if (backupPath.endsWith(".sqlite.gz")) return withReadableBackup(backupPath, path => this.restoreSnapshot(path, destinationPath));
    const verified = await this.verifySnapshot(backupPath);
    try {
      await access(destinationPath);
      throw new Error("恢复目标已存在，拒绝覆盖");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
    await runFile(this.execFileImpl, this.sqlitePath, [destinationPath, `.restore ${JSON.stringify(backupPath)}`], {
      timeout: 10 * 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    await chmod(destinationPath, 0o600);
    const validation = validateSQLiteSnapshot(destinationPath);
    if (!validationCountsMatch(verified.validation.counts, validation.counts)) {
      throw new Error("恢复 SQLite 行数与已验证备份不一致");
    }
    return { path: destinationPath, validation };
  }
}
