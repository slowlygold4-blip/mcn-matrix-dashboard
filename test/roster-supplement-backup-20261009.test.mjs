import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MonitorDatabase } from '../lib/database.mjs';
import { SQLiteBackupManager, validateSQLiteSnapshot, validationCountsMatch } from '../lib/backup-manager.mjs';

test('supplement proof table survives independent backup and manifest cannot omit it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mcn-supplement-backup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'source.sqlite'), db = new MonitorDatabase(source);
  db.close();
  const manager = new SQLiteBackupManager({ databasePath: source, backupDir: join(dir, 'backups') });
  const backup = await manager.createBackup('supplement-isolated-fixture');
  const expected = backup.manifest.validation.counts;
  assert.equal(expected.author_resolution_success_receipts, 0);
  const restoredPath = join(dir, 'restored.sqlite');
  const restored = await manager.restoreSnapshot(backup.path, restoredPath);
  assert.equal(restored.validation.counts.author_resolution_success_receipts, 0);
  assert.equal(validationCountsMatch(expected, restored.validation.counts), true);
  const missing = { ...restored.validation.counts }; delete missing.author_resolution_success_receipts;
  assert.equal(validationCountsMatch(expected, missing), false);
  assert.equal(validationCountsMatch(expected, { ...expected, author_resolution_success_receipts: null }), false);
  // An older snapshot without the new table remains readable; it must not be
  // silently accepted as equivalent to a new manifest that includes it.
  const old = new DatabaseSync(restoredPath);
  old.exec('DROP TABLE author_resolution_success_receipts'); old.close();
  const legacy = validateSQLiteSnapshot(restoredPath);
  assert.equal(Object.hasOwn(legacy.counts, 'author_resolution_success_receipts'), false);
  assert.equal(validationCountsMatch(legacy.counts, legacy.counts), true);
  assert.equal(validationCountsMatch(expected, legacy.counts), false);
});
