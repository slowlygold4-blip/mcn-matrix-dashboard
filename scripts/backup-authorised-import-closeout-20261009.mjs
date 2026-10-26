// One explicit consistent closeout backup; no timer or collection request.
import assert from 'node:assert/strict';
import { copyFile, constants, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SQLiteBackupManager, validateSQLiteSnapshot, validationCountsMatch } from '../lib/backup-manager.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const journal = join(root, 'data/maintenance-journal/20261009-author-detail-investigation');
const tests = JSON.parse(await readFile(join(journal, 'repair/tests.json'), 'utf8'));
assert.equal(tests.exitCode, 0, 'Related code tests must pass before closeout backup');
const startedAt = new Date().toISOString();
const output = join(journal, 'backup-closeout-' + Date.now());
await mkdir(output, { mode: 0o700 });
const manager = new SQLiteBackupManager({
  databasePath: join(root, 'data/douyin-monitor.sqlite'),
  backupDir: join(root, 'data/backups/20261009-author-detail'),
  retention: 60,
});
const backup = await manager.createBackup('after-authorised-import');
assert.equal(backup.status, 'created');
const temp = await mkdtemp(join(tmpdir(), 'mcn-author-import-closeout-'));
const clone = join(temp, 'readback.sqlite');
await copyFile(backup.path, clone, constants.COPYFILE_FICLONE);
const validation = validateSQLiteSnapshot(clone);
assert.ok(validationCountsMatch(backup.manifest.validation.counts, validation.counts));
const result = { startedAt, finishedAt: new Date().toISOString(), backup, clone, validation,
  readableCloneVerified: true, collectionTriggered: false };
await writeFile(join(output, 'verification.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output, path: backup.path, sha256: backup.manifest.sha256, validation, readableCloneVerified: true }));
