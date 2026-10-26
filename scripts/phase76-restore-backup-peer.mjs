import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdtemp, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { validateSQLiteSnapshot, validationCountsMatch } from "../lib/backup-manager.mjs";
import { ConsoleReader } from "../lib/console-reader.mjs";

// This verifier copies only an already completed ordinary online backup.
// It never initializes MonitorDatabase, creates a backup from live SQLite,
// changes a service, writes a source row, or triggers platform collection.
const project = fileURLToPath(new URL("..", import.meta.url));
const expectedSource = join(project, "data", "douyin-monitor.sqlite");
const backupDirectory = join(project, "data", "backups", "automatic");
const expectedSha = "a604f322e9d9f8473b40e4f6ca930eaef0fab33713a81d3bf3b5e6c9e1ca7da1";
const defaultBackup = join(backupDirectory, "douyin-monitor-auto-20261001T184240389Z-scheduled-success-f0724889.sqlite");
const cutoff = 2357;
const shaFile = async path => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
  return hash.digest("hex");
};

export async function auditPhase76Backup(path = defaultBackup, existingRestore = null) {
  const startedAt = new Date().toISOString();
  const source = await realpath(resolve(path));
  assert.equal(dirname(source), await realpath(backupDirectory));
  assert.equal(basename(source), basename(defaultBackup), "verify only the exact ordinary backup selected by Root");
  const manifest = JSON.parse(await readFile(`${source}.manifest.json`, "utf8"));
  assert.equal(manifest.format, "sqlite-online-backup-v1");
  assert.equal(manifest.reason, "scheduled-success");
  assert.equal(manifest.source, expectedSource);
  assert.equal(manifest.fileName, basename(source));
  assert.equal(manifest.sha256, expectedSha);
  const sourceStat = await stat(source);
  assert.ok(sourceStat.isFile()); assert.equal(sourceStat.size, manifest.bytes);
  assert.equal(await shaFile(source), expectedSha);
  let restored;
  if (existingRestore) {
    restored = await realpath(existingRestore);
    assert.equal(dirname(dirname(restored)), await realpath(tmpdir()));
    assert.match(basename(dirname(restored)), /^mcn-phase76-backup-peer-[a-zA-Z0-9]{6}$/);
    assert.equal(basename(restored), "restored.sqlite");
  } else {
    const directory = await mkdtemp(join(tmpdir(), "mcn-phase76-backup-peer-"));
    await chmod(directory, 0o700);
    restored = join(directory, "restored.sqlite");
    await copyFile(source, restored); await chmod(restored, 0o400);
  }
  assert.equal((await stat(restored)).size, manifest.bytes);
  const restoredSha = await shaFile(restored);
  assert.equal(restoredSha, expectedSha, "exact byte identity also preserves every raw source/history row");
  const validation = validateSQLiteSnapshot(restored);
  assert.equal(validationCountsMatch(manifest.validation.counts, validation.counts), true);
  const database = new DatabaseSync(restored, { readOnly: true });
  let storage;
  try {
    database.exec("PRAGMA query_only=ON;BEGIN");
    const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type=? ORDER BY name").all("table").map(row => row.name);
    assert.ok(tables.includes("works_observations"));
    const allTableCounts = Object.fromEntries(tables.map(name => {
      assert.match(name, /^[a-z_][a-z0-9_]*$/);
      return [name, Number(database.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get().count)];
    }));
    const terminal = database.prepare("SELECT id,trigger_type,status,started_at,finished_at,target_count,success_count,error_count FROM runs WHERE id=?").get(cutoff);
    assert.equal(terminal?.id, cutoff); assert.equal(terminal.trigger_type, "scheduled");
    assert.equal(terminal.status, "success"); assert.equal(terminal.finished_at, "2026-10-01T18:42:39.939Z");
    assert.ok(Date.parse(terminal.finished_at) <= Date.parse(manifest.createdAt));
    const latestRun = database.prepare("SELECT MAX(id) AS id FROM runs").get().id;
    assert.equal(latestRun, cutoff, "the selected scheduled backup is exactly the completed2357 cutoff");
    const rawHistory = Object.fromEntries(["snapshots", "works_observations"].map(name => [name,
      database.prepare(`SELECT COUNT(*) AS rows, SUM(LENGTH(raw_json)) AS rawCharacters, SUM(LENGTH(source_checksum)=64) AS checksumRows FROM "${name}"`).get()]));
    rawHistory.audits = database.prepare("SELECT COUNT(*) AS rows,SUM(LENGTH(source_checksum)=64) AS checksumRows FROM audits").get();
    const leases = {
      authorJobs: database.prepare("SELECT status,COUNT(*) AS rows,SUM(lease_owner IS NOT NULL OR lease_until IS NOT NULL) AS held FROM author_resolution_jobs GROUP BY status").all(),
      authorEvidence: database.prepare("SELECT status,COUNT(*) AS rows,SUM(lease_owner IS NOT NULL OR lease_until IS NOT NULL) AS held FROM author_resolution_queue GROUP BY status").all(),
    };
    const totalChanges = Number(database.prepare("SELECT total_changes() AS count").get().count);
    assert.equal(totalChanges, 0);
    storage = { terminal, latestRun, tableCount: tables.length, applicationTableCount: tables.filter(name => name !== "sqlite_sequence").length, allTableCounts, rawHistory, leases,
      schemaSha256: createHash("sha256").update(JSON.stringify(schema)).digest("hex"), queryOnly: true, totalChanges };
  } finally {
    database.exec("ROLLBACK"); database.close();
  }
  // Read the restored copy through the actual ordinary product worker. This
  // does not touch the server's reader or the live production database.
  const reader = new ConsoleReader({ databasePath: restored, timeoutMs: 45000 });
  let product;
  try {
    const result = await reader.overview({ period: "day", reference: manifest.createdAt, timeZone: "Asia/Shanghai", includeRecordedWindow: false });
    product = { range: result.range, enabledCount: result.summary.enabledCount,
      collectionCoverage: result.summary.collectionCoverage, worker: "actual ConsoleReader", restoredCopyOnly: true };
  } finally { await reader.close(); }
  assert.equal(await shaFile(source), expectedSha, "verification must not alter or replace the original backup");
  assert.equal(await shaFile(restored), expectedSha, "read-only integrity/product verification must not alter the restored copy");
  return { startedAt, finishedAt: new Date().toISOString(), backup: source, restored, temporaryCopyRetained: true,
    reason: manifest.reason, createdAt: manifest.createdAt, bytes: manifest.bytes, originalSha256: expectedSha,
    restoredSha256: restoredSha, validation, storage, product,
    originalBackupPreserved: true, byteExactRawHistoryPreserved: true, productionWrites: 0,
    noLiveDatabaseCopy: true, noManualCollection: true, noServiceMutation: true };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { console.log(JSON.stringify(await auditPhase76Backup(process.argv[2], process.argv[3]), null, 2)); }
  catch (error) { console.error(JSON.stringify({ ok: false, name: error.name, message: error.message })); process.exitCode = 1; }
}
