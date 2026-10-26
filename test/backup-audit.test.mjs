import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MonitorDatabase } from "../lib/database.mjs";
import { SQLiteBackupManager } from "../lib/backup-manager.mjs";
import { inspectLatestBackup } from "../lib/backup-audit.mjs";

test("backup audit distinguishes missing, manifest, and deep verification", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "douyin-monitor-backup-audit-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const databasePath = join(tempDir, "source.sqlite");
  const backupDir = join(tempDir, "backups");
  const database = new MonitorDatabase(databasePath);
  t.after(() => database.close());

  assert.equal(inspectLatestBackup(backupDir).status, "missing");
  database.createTarget({ type: "account", label: "备份审查账号", locator: "BACKUP-AUDIT", provider: "manual", metadata: {}, boards: ["审查板块"] });
  database.recordSourceProbe("douyin-public", { ok: true, trigger: "scheduled", result: { profileEndpoint: true } });
  const manager = new SQLiteBackupManager({ databasePath, backupDir });
  const backup = await manager.createBackup("audit-test");
  assert.equal(inspectLatestBackup(backupDir).status, "ok");
  const deep = inspectLatestBackup(backupDir, { verifyHash: true, verifySQLite: true });
  assert.equal(deep.status, "ok");
  assert.equal(deep.verification, "sha256+sqlite");
  assert.equal(deep.sha256Matched, true);
  assert.equal(deep.validation.integrityCheck, "ok");

  await writeFile(join(backupDir, ".last-backup-error.json"), JSON.stringify({
    failedAt: "2026-09-20T00:00:00.000Z", reason: "scheduled-success", error: "模拟磁盘暂不可用",
  }));
  const failedLatest = inspectLatestBackup(backupDir, { verifyHash: true, verifySQLite: true });
  assert.equal(failedLatest.status, "error");
  assert.match(failedLatest.error, /模拟磁盘暂不可用/);
  const recovery = await manager.createBackup("recovery");
  assert.equal(inspectLatestBackup(backupDir).status, "ok", "成功备份应清除旧失败告警");

  const manifestPath = `${recovery.path}.manifest.json`;
  const countTamperedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  countTamperedManifest.validation.counts.target_boards += 1;
  await writeFile(manifestPath, `${JSON.stringify(countTamperedManifest)}\n`);
  const countTampered = inspectLatestBackup(backupDir, { verifyHash: true, verifySQLite: true });
  assert.equal(countTampered.status, "error");
  assert.match(countTampered.error, /行数与清单不一致/);

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.sha256 = "0".repeat(64);
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  const tampered = inspectLatestBackup(backupDir, { verifyHash: true, verifySQLite: true });
  assert.equal(tampered.status, "error");
  assert.match(tampered.error, /SHA-256/);
});
