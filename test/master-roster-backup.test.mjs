import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MonitorDatabase } from '../lib/database.mjs';
import { buildMasterRosterSnapshot, installMasterRoster, readMasterRoster } from '../lib/master-roster.mjs';
import { SQLiteBackupManager, validationCountsMatch } from '../lib/backup-manager.mjs';

test('master roster is counted in consistent backups and survives independent restore', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mcn-master-roster-backup-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'source.sqlite'), db = new MonitorDatabase(path);
  installMasterRoster(db.db, buildMasterRosterSnapshot({ exportedAt: '2026-10-02T19:01:23Z', entities: [
    { key: 'submitted:douyin:id:001', platform: 'douyin', names: ['作者'], ids: ['001'], sources: [], locators: [] },
  ] }, { fileName: 'master.xlsx', sha256: 'a'.repeat(64) }));
  db.close();
  const manager = new SQLiteBackupManager({ databasePath: path, backupDir: join(dir, 'backups') });
  const backup = await manager.createBackup('roster');
  assert.equal(backup.manifest.validation.counts.master_roster_imports, 1);
  assert.equal(backup.manifest.validation.counts.master_roster_entries, 1);
  const restored = await manager.restoreSnapshot(backup.path, join(dir, 'restore.sqlite'));
  assert.ok(validationCountsMatch(backup.manifest.validation.counts, restored.validation.counts));
  const reader = new DatabaseSync(join(dir, 'restore.sqlite'), { readOnly: true });
  try { assert.equal(readMasterRoster(reader).items[0].accountIds[0], '001'); } finally { reader.close(); }
  const missing = { ...restored.validation.counts }; delete missing.master_roster_entries;
  assert.equal(validationCountsMatch(backup.manifest.validation.counts, missing), false);
});
