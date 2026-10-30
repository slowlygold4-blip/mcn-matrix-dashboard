import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLiteBackupManager, validateSQLiteSnapshot, validationCountsMatch } from "../lib/backup-manager.mjs";
import { MonitorDatabase } from "../lib/database.mjs";
import { WORK_SOURCE_TABLES } from '../lib/work-source-tables.mjs';

const LEGACY_EVIDENCE_TABLES = [
  "targets", "board_catalog", "target_boards", "posts", "post_metrics", "snapshots",
  "runs", "audits", "source_probes", "author_resolution_queue", "author_resolution_jobs",
];

async function evidenceFixture(t, { accountEvents = false, eventCount = 0 } = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), "douyin-monitor-backup-events-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const sourcePath = join(tempDir, "source.sqlite");
  const db = new DatabaseSync(sourcePath);
  try {
    for (const table of LEGACY_EVIDENCE_TABLES) db.exec(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY)`);
    if (accountEvents) {
      db.exec(`CREATE TABLE account_events(
        id INTEGER PRIMARY KEY,target_id INTEGER,run_id INTEGER,event_type TEXT,event_key TEXT,
        observed_at TEXT,source_checksum TEXT,event_json TEXT,raw_json TEXT,created_at TEXT
      )`);
      for (let index = 0; index < eventCount; index += 1) {
        db.prepare("INSERT INTO account_events VALUES(?,1,NULL,'alias-change',?,'2026-09-13T12:00:00Z',?,'{}',?,'2026-09-13T12:00:01Z')")
          .run(index + 1, `event-${index}`, "a".repeat(64), JSON.stringify({ publicEvidence: index }));
      }
    }
  } finally { db.close(); }
  const manager = new SQLiteBackupManager({ databasePath: sourcePath, backupDir: join(tempDir, "backups") });
  return { tempDir, sourcePath, manager };
}

test("account event counts are optional only when absent from both validation records", () => {
  const legacy = Object.fromEntries(LEGACY_EVIDENCE_TABLES.map((table) => [table, 0]));
  assert.equal(validationCountsMatch(legacy, legacy), true);
  assert.equal(validationCountsMatch({ ...legacy, account_events: 0 }, { ...legacy, account_events: 0 }), true);
  assert.equal(validationCountsMatch({ ...legacy, account_events: 2 }, { ...legacy, account_events: 2 }), true);
  assert.equal(validationCountsMatch({ ...legacy, account_events: 0 }, legacy), false);
  assert.equal(validationCountsMatch(legacy, { ...legacy, account_events: 0 }), false);
  assert.equal(validationCountsMatch({ ...legacy, account_events: 2 }, { ...legacy, account_events: 1 }), false);
  for (const value of [null, undefined, "0", false, -1, 1.5, NaN, Infinity]) {
    assert.equal(validationCountsMatch({ ...legacy, account_events: value }, { ...legacy, account_events: 0 }), false);
  }
});

test("source registry additions and external deltas cannot vanish from a backup manifest", () => {
  const legacy = Object.fromEntries(LEGACY_EVIDENCE_TABLES.map((table) => [table, 0]));
  const present = { ...legacy, creator_source_registry_additions: 2, creator_source_external_deltas: 5 };
  assert.equal(validationCountsMatch(present, present), true);
  assert.equal(validationCountsMatch(present, { ...present, creator_source_external_deltas: 4 }), false);
  assert.equal(validationCountsMatch(present, { ...present, creator_source_registry_additions: 1 }), false);
  assert.equal(validationCountsMatch(present, legacy), false);
});

test('stored profile identity receipts are retained and counted without breaking older backups',()=>{
 const legacy=Object.fromEntries(LEGACY_EVIDENCE_TABLES.map(table=>[table,0]));
 const current={...legacy,creator_source_profile_identity_receipts:3,supplement_profile_identity_receipts:4};
 assert.equal(validationCountsMatch(legacy,legacy),true);assert.equal(validationCountsMatch(current,current),true);
 assert.equal(validationCountsMatch(current,legacy),false);assert.equal(validationCountsMatch(legacy,current),false);
 assert.equal(validationCountsMatch(current,{...current,creator_source_profile_identity_receipts:2}),false);
 assert.equal(validationCountsMatch(current,{...current,supplement_profile_identity_receipts:3}),false);
 const {supplement_profile_identity_receipts,...missingSupplement}=current;
 assert.equal(validationCountsMatch(current,missingSupplement),false);
});

test('complete source-edition evidence, including raw artifacts and heads, survives backup validation', () => {
  const legacy = Object.fromEntries(LEGACY_EVIDENCE_TABLES.map(table => [table, 0]));
  const current = { ...legacy, ...Object.fromEntries(WORK_SOURCE_TABLES.map(table => [table, 2])) };
  assert.equal(validationCountsMatch(current, current), true);
  for (const table of WORK_SOURCE_TABLES) {
    const missing = { ...current }; delete missing[table];
    assert.equal(validationCountsMatch(current, missing), false);
    assert.equal(validationCountsMatch(current, { ...current, [table]: 1 }), false);
  }
  assert.equal(validationCountsMatch(legacy, legacy), true);
});

test("old eleven-table backups still verify and restore without account_events", async (t) => {
  const { tempDir, manager } = await evidenceFixture(t);
  const backup = await manager.createBackup("legacy");
  assert.equal(Object.keys(backup.manifest.validation.counts).length, 11);
  assert.equal(Object.hasOwn(backup.manifest.validation.counts, "account_events"), false);
  await manager.verifySnapshot(backup.path);
  const restored = await manager.restoreSnapshot(backup.path, join(tempDir, "legacy-restored.sqlite"));
  assert.equal(Object.hasOwn(restored.validation.counts, "account_events"), false);
  const wrong = structuredClone(backup.manifest);
  wrong.validation.counts.account_events = 0;
  await writeFile(backup.manifestPath, JSON.stringify(wrong));
  await assert.rejects(manager.verifySnapshot(backup.path), /行数与清单不一致/);
});

test("new backups retain account event counts and raw evidence through manifest verification and restore", async (t) => {
  const { tempDir, manager } = await evidenceFixture(t, { accountEvents: true, eventCount: 2 });
  const backup = await manager.createBackup("identity-evidence");
  assert.equal(backup.manifest.validation.counts.account_events, 2);
  assert.equal(Object.keys(backup.manifest.validation.counts).length, 12);
  assert.equal((await manager.verifySnapshot(backup.path)).validation.counts.account_events, 2);
  const restoredPath = join(tempDir, "new-restored.sqlite");
  const restored = await manager.restoreSnapshot(backup.path, restoredPath);
  assert.equal(restored.validation.counts.account_events, 2);
  const db = new DatabaseSync(restoredPath, { readOnly: true });
  try {
    assert.deepEqual(db.prepare("SELECT raw_json FROM account_events ORDER BY id").all().map((row) => JSON.parse(row.raw_json)),
      [{ publicEvidence: 0 }, { publicEvidence: 1 }]);
  } finally { db.close(); }
  for (const count of [undefined, 1]) {
    const wrong = structuredClone(backup.manifest);
    if (count === undefined) delete wrong.validation.counts.account_events;
    else wrong.validation.counts.account_events = count;
    await writeFile(backup.manifestPath, JSON.stringify(wrong));
    await assert.rejects(manager.restoreSnapshot(backup.path, join(tempDir, `bad-${count}.sqlite`)), /行数与清单不一致/);
  }
});

test("empty new event tables are counted as zero rather than silently treated as legacy", async (t) => {
  const { manager } = await evidenceFixture(t, { accountEvents: true });
  const backup = await manager.createBackup("empty-events");
  assert.equal(backup.manifest.validation.counts.account_events, 0);
  assert.equal((await manager.verifySnapshot(backup.path)).validation.counts.account_events, 0);
});

test("append-only author import provenance is counted, restored and cannot silently disappear", async (t) => {
  const { tempDir, sourcePath, manager } = await evidenceFixture(t);
  const source = new DatabaseSync(sourcePath);
  try {
    source.exec("CREATE TABLE author_resolution_import_sources(id INTEGER PRIMARY KEY,payload_json TEXT NOT NULL)");
    source.prepare("INSERT INTO author_resolution_import_sources(payload_json) VALUES(?)")
      .run(JSON.stringify({ sourceRows: [2, 3], sourceRevision: 7, fileName: "source.xlsx" }));
  } finally { source.close(); }
  const backup = await manager.createBackup("append-only-import-sources");
  assert.equal(backup.manifest.validation.counts.author_resolution_import_sources, 1);
  const restored = await manager.restoreSnapshot(backup.path, join(tempDir, "restored-import-sources.sqlite"));
  assert.equal(restored.validation.counts.author_resolution_import_sources, 1);
  const copy = new DatabaseSync(restored.path, { readOnly: true });
  try {
    assert.deepEqual(JSON.parse(copy.prepare("SELECT payload_json FROM author_resolution_import_sources").get().payload_json),
      { sourceRows: [2, 3], sourceRevision: 7, fileName: "source.xlsx" });
  } finally { copy.close(); }
  const legacy = Object.fromEntries(LEGACY_EVIDENCE_TABLES.map((table) => [table, 0]));
  assert.equal(validationCountsMatch({ ...legacy, author_resolution_import_sources: 0 }, legacy), false);
  assert.equal(validationCountsMatch(legacy, { ...legacy, author_resolution_import_sources: 0 }), false);
  for (const value of [null, undefined, "1", false, -1, 1.5, NaN, Infinity]) {
    assert.equal(validationCountsMatch({ ...legacy, author_resolution_import_sources: value }, { ...legacy, author_resolution_import_sources: 1 }), false);
  }
  const broken = structuredClone(backup.manifest);
  delete broken.validation.counts.author_resolution_import_sources;
  await writeFile(backup.manifestPath, JSON.stringify(broken));
  await assert.rejects(manager.verifySnapshot(backup.path), /行数与清单不一致/);
});

test("restore rejects a lost event table even when all eleven legacy table counts still match", async (t) => {
  const { tempDir, sourcePath, manager } = await evidenceFixture(t, { accountEvents: true, eventCount: 1 });
  const backup = await manager.createBackup("restore-loss-test");
  const restoreManager = new SQLiteBackupManager({
    databasePath: sourcePath,
    backupDir: join(tempDir, "backups"),
    execFileImpl: (file, args, options, callback) => execFile(file, args, options, (error, stdout, stderr) => {
      if (!error && args[1].startsWith(".restore ")) {
        const restored = new DatabaseSync(args[0]);
        try { restored.exec("DROP TABLE account_events"); } finally { restored.close(); }
      }
      callback(error, stdout, stderr);
    }),
  });
  await assert.rejects(restoreManager.restoreSnapshot(backup.path, join(tempDir, "lost-events.sqlite")), /恢复 SQLite 行数与已验证备份不一致/);
});

test("online backup includes committed WAL data and restores into a valid standalone database", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "douyin-monitor-online-backup-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const sourcePath = join(tempDir, "source.sqlite");
  const database = new MonitorDatabase(sourcePath);
  t.after(() => database.close());
  database.db.exec("PRAGMA wal_autocheckpoint=0");
  database.createTarget({ type: "account", label: "快照内账号", locator: "BACKUP-A", provider: "manual", metadata: {}, boards: ["备份板块"] });
  const owner = database.ensureLocalOwner();
  database.createIdempotentAuthorResolutionJob({
    id: "11111111-2222-4333-8444-555555555555", userId: owner.id, actorName: owner.displayName,
    fileName: "备份校验.xlsx", sheetName: "名单", totalAuthors: 1, request: { rows: [{ name: "备份作者" }] },
    idempotencyKey: "aaaaaaaa-2222-4333-8444-555555555555", fingerprint: "a".repeat(64),
  });
  database.recordSourceProbe("douyin-public", { ok: true, trigger: "scheduled", result: { profileEndpoint: true } });
  assert.ok((await stat(`${sourcePath}-wal`)).size > 0, "fixture must still contain committed WAL pages");

  const manager = new SQLiteBackupManager({ databasePath: sourcePath, backupDir: join(tempDir, "backups"), retention: 3 });
  const backup = await manager.createBackup("startup");
  assert.equal(backup.status, "created");
  assert.equal(backup.manifest.validation.integrityCheck, "ok");
  assert.equal(backup.manifest.validation.foreignKeyViolations, 0);
  assert.equal(backup.manifest.validation.counts.targets, 1);
  assert.equal(backup.manifest.validation.counts.board_catalog, 1);
  assert.equal(backup.manifest.validation.counts.target_boards, 1);
  assert.equal(backup.manifest.validation.counts.source_probes, 1);
  assert.equal(backup.manifest.validation.counts.author_resolution_idempotency, 1);
  assert.match(backup.manifest.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(validateSQLiteSnapshot(backup.path), backup.manifest.validation);

  database.createTarget({ type: "account", label: "快照后账号", locator: "BACKUP-B", provider: "manual", metadata: {} });
  const restoredPath = join(tempDir, "restored", "douyin-monitor.sqlite");
  const restored = await manager.restoreSnapshot(backup.path, restoredPath);
  assert.equal(restored.validation.counts.targets, 1);
  assert.equal(restored.validation.counts.author_resolution_idempotency, 1);
  const restoredDatabase = new DatabaseSync(restoredPath, { readOnly: true });
  assert.deepEqual(restoredDatabase.prepare("SELECT label FROM targets ORDER BY id").all().map((row) => row.label), ["快照内账号"]);
  restoredDatabase.close();

  const manifestPath = `${backup.path}.manifest.json`;
  const originalManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const countTamperedManifest = { ...originalManifest, validation: { ...originalManifest.validation, counts: { ...originalManifest.validation.counts, targets: 2 } } };
  await writeFile(manifestPath, `${JSON.stringify(countTamperedManifest)}\n`);
  await assert.rejects(
    manager.restoreSnapshot(backup.path, join(tempDir, "restored-count-tampered.sqlite")),
    /SHA-256 与清单不一致|行数与清单不一致/,
  );
  await writeFile(manifestPath, `${JSON.stringify(originalManifest)}\n`);

  const tampered = new DatabaseSync(backup.path);
  tampered.prepare("UPDATE targets SET label='被篡改'").run();
  tampered.close();
  await assert.rejects(
    manager.restoreSnapshot(backup.path, join(tempDir, "restored-tampered.sqlite")),
    /SHA-256 与清单不一致/,
  );

  const corruptPath = join(tempDir, "corrupt.sqlite");
  await writeFile(corruptPath, "not a sqlite database");
  assert.throws(() => validateSQLiteSnapshot(corruptPath), /无法验证 SQLite 快照/);
});

test("backup requests coalesce, honor the cross-process lock, and prune old snapshots", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "douyin-monitor-backup-retention-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const sourcePath = join(tempDir, "source.sqlite");
  const backupDir = join(tempDir, "backups");
  const database = new MonitorDatabase(sourcePath);
  t.after(() => database.close());
  database.createTarget({ type: "account", label: "账号", locator: "BACKUP", provider: "manual", metadata: {} });
  const manager = new SQLiteBackupManager({ databasePath: sourcePath, backupDir, retention: 2 });

  const firstRequest = manager.createBackup("startup");
  const concurrentRequest = manager.createBackup("scheduled-success");
  assert.equal(firstRequest, concurrentRequest, "same-process concurrent requests must share one backup");
  await firstRequest;
  await manager.createBackup("scheduled-success");
  await manager.createBackup("startup");
  const entries = await readdir(backupDir);
  const snapshots = entries.filter((name) => /^douyin-monitor-auto-.*\.sqlite$/.test(name));
  const manifests = entries.filter((name) => /^douyin-monitor-auto-.*\.sqlite\.manifest\.json$/.test(name));
  assert.equal(snapshots.length, 2);
  assert.equal(manifests.length, 2);
  assert.equal(entries.some((name) => /(?:\.partial|-(?:wal|shm))$/.test(name)), false);
  for (const manifest of manifests) assert.equal(JSON.parse(await readFile(join(backupDir, manifest), "utf8")).validation.integrityCheck, "ok");

  await writeFile(join(backupDir, ".automatic-backup.lock"), JSON.stringify({ token: "active", pid: process.pid, createdAt: new Date().toISOString() }));
  const locked = await new SQLiteBackupManager({ databasePath: sourcePath, backupDir, retention: 2 }).createBackup("startup");
  assert.deepEqual(locked, { status: "skipped", reason: "backup-locked" });
});

test('compressed automatic backups preserve full verification and restore, with bounded mixed retention', async t=>{
 const {tempDir,manager}=await evidenceFixture(t,{accountEvents:true,eventCount:3});manager.retention=6;
 const first=await manager.createBackup('compression-fixture');
 for(let i=0;i<5;i++)await manager.createBackup('compression-fixture');
 let names=await readdir(manager.backupDir);assert.equal(names.filter(n=>n.endsWith('.sqlite')).length,3);assert.equal(names.filter(n=>n.endsWith('.sqlite.gz')).length,3);
 const verified=await manager.verifySnapshot(first.path+'.gz');assert.equal(verified.validation.counts.account_events,3);
 const dest=join(tempDir,'restored-compressed.sqlite');await manager.restoreSnapshot(first.path+'.gz',dest);assert.equal(validateSQLiteSnapshot(dest).counts.account_events,3);
 await manager.createBackup('compression-fixture');names=await readdir(manager.backupDir);assert.equal(names.filter(n=>/\.sqlite(?:\.gz)?$/.test(n)).length,6);await assert.rejects(stat(first.path+'.gz'),/ENOENT/);
});
