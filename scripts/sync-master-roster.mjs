import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, copyFile, chmod, mkdtemp, constants } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import ExcelJS from 'exceljs';
import { SQLiteBackupManager, validateSQLiteSnapshot, validationCountsMatch } from '../lib/backup-manager.mjs';
import { buildMasterRosterSnapshot, installMasterRoster, readMasterRoster } from '../lib/master-roster.mjs';

// Explicit one-off maintenance. This script schedules neither AI nor a
// collector, and never writes the operating targets/queue/history tables.
const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[2] || '--dry-run';
const requestedBackupPath = process.argv[3];
assert.ok(['--prepare', '--dry-run', '--apply'].includes(mode), '请选择 --prepare、--dry-run 或 --apply');
if (mode === '--apply') assert.ok(requestedBackupPath, '--apply 必须显式提供最近已验证的 SQLite 备份路径');
const evidenceDir = join(root, 'data/maintenance-journal/master-roster-sync-20261004');
await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
const sha = async path => { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); };
const startedAt = new Date().toISOString();
const databasePath = join(root, 'data/douyin-monitor.sqlite');
const workbookPath = resolve(root, '../../out/MCN全部来源账号合并表-20261002.xlsx');
const jsonPath = resolve(root, '../../out/account-roster-audit-20261002/merged-roster.json');
const expectedSha = '08bb71c68bd0118d61284f4f87323a245d0efb238174ccce58b7ddf3e99bee37';
assert.equal(await sha(workbookPath), expectedSha, '原总表已变更，需重新核对而不能使用旧JSON');

if (mode === '--prepare') {
  const preimages = [];
  for (const relative of ['server.mjs', 'public/rebuild.html', 'public/rebuild.js', 'public/rebuild.css']) {
    const source = join(root, relative), destination = join(evidenceDir, 'preimage', relative);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const sha256 = await sha(source);
    await copyFile(source, destination, constants.COPYFILE_EXCL); await chmod(destination, 0o400);
    assert.equal(await sha(destination), sha256); preimages.push({ relative, sha256, destination });
  }
  const manager = new SQLiteBackupManager({ databasePath, backupDir: join(root, 'data/backups/master-roster-sync-20261004') });
  const backup = await manager.createBackup('before-master-roster-sync'); assert.equal(backup.status, 'created');
  const verified = await manager.verifySnapshot(backup.path);
  const temp = await mkdtemp(join(tmpdir(), 'master-roster-restore-'));
  await chmod(temp, 0o700);
  const restoredPath = join(temp, 'restored.sqlite');
  await copyFile(backup.path, restoredPath, constants.COPYFILE_EXCL); await chmod(restoredPath, 0o400);
  assert.equal(await sha(restoredPath), verified.manifest.sha256);
  const restoredValidation = validateSQLiteSnapshot(restoredPath);
  assert.ok(validationCountsMatch(verified.validation.counts, restoredValidation.counts));
  const report = { startedAt, finishedAt: new Date().toISOString(), preimages, backupPath: backup.path,
    backupSha256: verified.manifest.sha256, restoredPath, restoredValidation, originalBackupsPreserved: true };
  await writeFile(join(evidenceDir, 'prepare.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
  console.log(JSON.stringify({ backupPath: report.backupPath, restoredPath, validation: 'pass', codePreimages: preimages.length }));
} else {
  const data = JSON.parse(await readFile(jsonPath, 'utf8'));
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(workbookPath);
  const sheet = workbook.getWorksheet('账号合并总表');
  assert.equal(sheet.rowCount, data.entities.length + 1);
  const entities = new Map(data.entities.map(entity => [entity.key, entity])), seen = new Set();
  const cell = (row, column) => String(row.getCell(column).value?.text ?? row.getCell(column).value ?? '');
  const joined = values => [...new Set(values.map(value => String(value ?? '')).filter(value => value.trim()))].join('\n');
  for (let index = 2; index <= sheet.rowCount; index++) {
    const row = sheet.getRow(index), key = cell(row, 19), entity = entities.get(key);
    assert.ok(entity && !seen.has(key)); seen.add(key);
    for (const [column, expected] of [[2, entity.classification.theme.label], [4, entity.currentName || entity.names[0] || '名称缺失'],
      [5, joined(entity.ids)], [6, joined(entity.classification.labels.map(label => label.label)) || '待分类'], [10, joined(entity.locators)],
      [11, joined(entity.names)], [12, joined(entity.boards.map(board => board.name))], [13, joined(entity.boards.map(board => board.organization))],
      [14, String(entity.sources.length)], [15, joined(entity.sources.map(source => source.url))]]) assert.equal(cell(row, column), expected, `${key} column ${column}`);
    assert.equal(cell(row, 7), entity.enabled === true ? '监控已启用' : entity.enabled === false ? '暂停监控' : '原始名单，尚未加入监控');
  }
  assert.equal(seen.size, data.entities.length);
  const snapshot = buildMasterRosterSnapshot(data, { fileName: basename(workbookPath), sha256: expectedSha });
  const db = new DatabaseSync(databasePath, { readOnly: mode !== '--apply' });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    if (mode === '--apply') db.exec('PRAGMA foreign_keys=ON');
    const targets = new Map(db.prepare("SELECT id,locator,metadata_json,enabled,label FROM targets WHERE type='account'").all().map(target => [target.id, target]));
    for (const item of snapshot.items.filter(item => item.targetId)) {
      const target = targets.get(item.targetId);
      assert.ok(target && item.locators.includes(target.locator), `${item.targetId} canonical anchor`);
      assert.equal(JSON.parse(target.metadata_json).platform ?? 'douyin', item.platform);
    }
    const summary = { total: snapshot.items.length, registered: snapshot.items.filter(item => item.targetId).length,
      enabled: [...targets.values()].filter(target => target.enabled).length, paused: [...targets.values()].filter(target => !target.enabled).length,
      pending: snapshot.items.filter(item => !item.targetId).length };
    assert.deepEqual(summary, { total: 1406, registered: 761, enabled: 701, paused: 60, pending: 645 });
    const report = { startedAt, mode, workbookSha256: expectedSha, sourceJsonSha256: await sha(jsonPath), summary,
      rowsCompared: seen.size, metricWrites: 0, targetWrites: 0, queueWrites: 0, boardWrites: 0, collectorTriggered: false };
    if (mode === '--apply') {
      const activeRun = db.prepare('SELECT id FROM runs WHERE finished_at IS NULL ORDER BY id LIMIT 1').get();
      assert.equal(activeRun, undefined, `采集任务 ${activeRun?.id} 尚未结束，拒绝写入名册`);
      const backupPath = resolve(root, requestedBackupPath);
      const backup = await new SQLiteBackupManager({ databasePath, backupDir: join(root, 'data/backups/automatic') }).verifySnapshot(backupPath);
      assert.equal(backup.manifest.source, databasePath, '备份来源不是当前生产数据库');
      const backupAgeMs = Date.now() - Date.parse(backup.manifest.createdAt);
      assert.ok(Number.isFinite(backupAgeMs) && backupAgeMs >= 0 && backupAgeMs <= 90 * 60_000, '必须使用最近 90 分钟内生成的已验证备份');
      report.preImportBackup = { path: backupPath, sha256: backup.manifest.sha256, createdAt: backup.manifest.createdAt,
        quickCheck: backup.validation.quickCheck, integrityCheck: backup.validation.integrityCheck, foreignKeyViolations: backup.validation.foreignKeyViolations };
      assert.equal(backup.validation.quickCheck, 'ok'); assert.equal(backup.validation.integrityCheck, 'ok'); assert.equal(backup.validation.foreignKeyViolations, 0);
      const beforeTargets = JSON.stringify(db.prepare('SELECT * FROM targets ORDER BY id').all());
      const beforeQueue = JSON.stringify(db.prepare('SELECT * FROM author_resolution_queue ORDER BY id').all());
      const beforeBoards = JSON.stringify(db.prepare('SELECT * FROM target_boards ORDER BY target_id,board_key').all());
      report.result = installMasterRoster(db, snapshot);
      report.reapply = installMasterRoster(db, snapshot); assert.equal(report.reapply.imported, false);
      assert.equal(JSON.stringify(db.prepare('SELECT * FROM targets ORDER BY id').all()), beforeTargets);
      assert.equal(JSON.stringify(db.prepare('SELECT * FROM author_resolution_queue ORDER BY id').all()), beforeQueue);
      assert.equal(JSON.stringify(db.prepare('SELECT * FROM target_boards ORDER BY target_id,board_key').all()), beforeBoards);
      report.readback = readMasterRoster(db).summary; assert.deepEqual(report.readback, summary);
      report.originalTargetsQueueBoardsUnchanged = true;
      report.sqliteQuickCheck = db.prepare('PRAGMA quick_check').get().quick_check; assert.equal(report.sqliteQuickCheck, 'ok');
      assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    }
    report.finishedAt = new Date().toISOString();
    await writeFile(join(evidenceDir, `${mode.slice(2)}-${startedAt.replace(/[:.]/g, '-')}.json`), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
    console.log(JSON.stringify(report));
  } finally { db.close(); }
}
