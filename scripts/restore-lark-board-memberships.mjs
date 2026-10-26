import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import { mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { MonitorDatabase } from "../lib/database.mjs";
import { exportLarkSheetWorkbook } from "../lib/lark-sheet-source.mjs";
import { parseAuthorSpreadsheet, authorPreviewContentSha256 } from "../lib/author-spreadsheet.mjs";

// A bounded recovery for this reviewed source. Never creates authors, restarts
// collection, changes identity decisions, or rewrites original import receipts.
const SOURCE_URL = "https://my.feishu.cn/sheets/Hhzlstc6WhcIs3tYsoVcoWZenKd?sheet=6fa497";
const filePath = resolve("data/douyin-monitor.sqlite");
const apply = process.argv.includes("--apply");
const exported = await exportLarkSheetWorkbook(SOURCE_URL);
const preview = await parseAuthorSpreadsheet({ buffer: exported.buffer, fileName: exported.fileName, sheetName: "作者名单" });
assert.equal(preview.summary.totalRows, 25, "Source row count changed; review before recovery");
assert.equal(exported.source.revision, 158, "Source revision changed; review before recovery");
assert.equal(preview.boardCatalog.length, 9);
assert.equal(preview.rows.filter((row) => row.board === "老飞宇切片矩阵").length, 19);
assert.equal(preview.rows.filter((row) => row.board === "安澜切片矩阵").length, 6);

const outputDir = await mkdtemp(resolve("data/board-recovery-"));
await writeFile(join(outputDir, "source.xlsx"), exported.buffer);
await writeFile(join(outputDir, "source-preview.json"), JSON.stringify(preview, null, 2));
const read = new DatabaseSync(filePath, { readOnly: true });
await backup(read, join(outputDir, "before.sqlite"));
await backup(read, join(outputDir, "startup-dry-run.sqlite"));
read.close();

function fingerprint(db, tables) {
  return Object.fromEntries(tables.map((table) => {
    const hash = createHash("sha256");
    let count = 0;
    for (const row of db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).iterate()) {
      hash.update(JSON.stringify(row));
      count += 1;
    }
    return [table, { count, sha256: hash.digest("hex") }];
  }));
}
const clonePath = join(outputDir, "startup-dry-run.sqlite");
let clone = new DatabaseSync(clonePath);
const tables = clone.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((item) => item.name);
const beforeStartup = fingerprint(clone, tables);
clone.close();
const migrated = new MonitorDatabase(clonePath);
const afterStartup = fingerprint(migrated.db, tables);
const migrationChanges = tables.filter((table) => beforeStartup[table].sha256 !== afterStartup[table].sha256);
const legacyIdentityMigrations = migrated.countLegacyPartialEvidenceVerifications();
migrated.close();
await writeFile(join(outputDir, "startup-audit.json"), JSON.stringify({ beforeStartup, afterStartup, migrationChanges, legacyIdentityMigrations }, null, 2));
assert.deepEqual(migrationChanges, [], "Startup would change unrelated data; do not deploy without review");
assert.equal(legacyIdentityMigrations, 0, "Startup would replay identity checks; review before deployment");

const db = new DatabaseSync(filePath, { readOnly: !apply });
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
const targets = db.prepare("SELECT * FROM targets WHERE type='account'").all();
const queue = db.prepare("SELECT * FROM author_resolution_queue WHERE source_metadata_json LIKE ?").all("%Hhzlstc6WhcIs3tYsoVcoWZenKd%");
const clean = (value) => String(value ?? "").normalize("NFKC").trim();
const plan = preview.rows.map((row) => {
  const expectedId = row.platform === "bilibili" ? row.bilibiliId : row.douyinId;
  assert.ok(expectedId);
  const matchedTargets = targets.filter((target) => {
    const metadata = JSON.parse(target.metadata_json);
    if (metadata.platform !== row.platform) return false;
    if (row.platform === "bilibili") return target.locator === expectedId;
    const verification = metadata.authorResolution;
    return verification?.verified === true && [verification?.douyinId, metadata.douyinId].includes(expectedId);
  });
  assert.ok(matchedTargets.length <= 1, `Ambiguous target identity at row ${row.sourceRow}`);
  const matchedQueue = queue.filter((item) => {
    const metadata = JSON.parse(item.source_metadata_json);
    if (metadata.sourceSheetId !== "6fa497" || Number(metadata.sourceRevision) !== 158) return false;
    if (!JSON.parse(item.source_rows_json).includes(row.sourceRow)) return false;
    if (clean(item.name) !== clean(row.name)) return false;
    return row.platform === "bilibili" ? item.account_locator === expectedId : item.douyin_id === expectedId;
  });
  assert.ok(matchedTargets.length || matchedQueue.length, `Source row ${row.sourceRow} has no exact existing identity or queue match`);
  return { sourceRow: row.sourceRow, name: row.name, platform: row.platform, submittedId: expectedId, board: row.board, targetIds: matchedTargets.map((item) => item.id), queueIds: matchedQueue.map((item) => item.id) };
});
assert.equal(plan.flatMap((row) => row.targetIds).length, 14);
assert.equal(plan.flatMap((row) => row.queueIds).length, 11);
const protectedTables = ["targets", "snapshots", "posts", "post_metrics", "runs", "author_resolution_jobs"];
const protectedQueueFields = () => db.prepare("SELECT id,identity_key,status,attempts,resolved_target_id,verification_policy_version,suspended_target_enabled FROM author_resolution_queue ORDER BY id").all();
let changes = { catalogAdded: 0, membershipsAdded: 0, queuesUpdated: 0 };
let invariants;
if (apply) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const before = fingerprint(db, protectedTables);
    const queueBefore = protectedQueueFields();
    const now = new Date().toISOString();
    const addBoard = db.prepare("INSERT OR IGNORE INTO board_catalog(board_key,board_name,enabled,source_type,created_at,updated_at) VALUES(?,?,1,'lark-sheet',?,?)");
    for (const { name } of preview.boardCatalog) changes.catalogAdded += Number(addBoard.run(name.toLowerCase(), name, now, now).changes);
    const addMember = db.prepare(`INSERT OR IGNORE INTO target_boards(target_id,board_key,board_name,source_type,source_file_name,source_sheet_name,source_row,note,created_at,updated_at)
      VALUES(?,?,?,'lark-sheet',?,'作者名单',?,'恢复原表 A 列漏读的板块归属；未改动账号与监控数据',?,?)`);
    const updateQueue = db.prepare("UPDATE author_resolution_queue SET boards_json=?,source_metadata_json=?,updated_at=? WHERE id=?");
    for (const row of plan) {
      for (const id of row.targetIds) changes.membershipsAdded += Number(addMember.run(id, row.board.toLowerCase(), row.board, exported.fileName, row.sourceRow, now, now).changes);
      for (const id of row.queueIds) {
        const item = db.prepare("SELECT boards_json,source_metadata_json FROM author_resolution_queue WHERE id=?").get(id);
        const boards = JSON.parse(item.boards_json);
        if (boards.some((entry) => clean(typeof entry === "string" ? entry : entry.name) === row.board)) continue;
        boards.push({ name: row.board, sourceRow: row.sourceRow });
        const metadata = JSON.parse(item.source_metadata_json);
        metadata.boardRecovery = { sourceUrl: SOURCE_URL, sourceRevision: 158, sourceRow: row.sourceRow, restoredAt: now, contentSha256: authorPreviewContentSha256(preview) };
        updateQueue.run(JSON.stringify(boards), JSON.stringify(metadata), now, id);
        changes.queuesUpdated += 1;
      }
    }
    const after = fingerprint(db, protectedTables);
    assert.deepEqual(after, before, "Recovery changed protected data");
    assert.deepEqual(protectedQueueFields(), queueBefore, "Recovery changed identity or monitoring decisions");
    invariants = { protectedDataUnchanged: true, protectedQueueDecisionsUnchanged: true, before, after };
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
const report = { applied: apply, sourceUrl: SOURCE_URL, sourceRevision: 158, outputDir, rows: plan.length, boardCatalog: preview.boardCatalog, migrationChanges, legacyIdentityMigrations, changes, invariants, plan };
await writeFile(join(outputDir, "receipt.json"), JSON.stringify(report, null, 2));
db.close();
console.log(JSON.stringify({ ...report, plan: undefined, invariants: invariants ? { protectedDataUnchanged: true, protectedQueueDecisionsUnchanged: true } : undefined }, null, 2));
