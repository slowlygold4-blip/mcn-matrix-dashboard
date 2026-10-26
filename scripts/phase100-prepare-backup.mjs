import assert from 'node:assert/strict';
import { mkdtemp, copyFile, chmod, mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteBackupManager, validateSQLiteSnapshot, validationCountsMatch } from '../lib/backup-manager.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const startedAt = new Date().toISOString();
assert.ok(Date.now() < Date.parse('2026-10-02T05:04:16Z'));
const checksum = async path => { const h = createHash('sha256'); for await (const chunk of createReadStream(path)) h.update(chunk); return h.digest('hex'); };
const manifest = JSON.parse(await readFile(join(root, 'docs/phase95-profile-first-manifest.json'), 'utf8'));
const codeDir = join(root, 'data/code-candidates/phase100/preimage');
await mkdir(codeDir, { recursive: true, mode: 0o700 });
const code = [];
for (const item of manifest) {
  assert.match(item.file, /^(lib\/[a-z0-9\/-]+\.mjs|scripts\/[a-z0-9_-]+\.mjs|server\.mjs)$/);
  const source = join(root, item.file);
  assert.equal(await checksum(source), item.main, item.file);
  const destination = join(codeDir, item.file);
  await mkdir(join(destination, '..'), { recursive: true, mode: 0o700 });
  await copyFile(source, destination, 1);
  await chmod(destination, 0o400);
  assert.equal(await checksum(destination), item.main);
  code.push({ path: item.file, beforeSha256: item.main, destination });
}
const boundedExec = (file, args, options, callback) => execFile(file, args, { ...options, timeout: 60_000 }, callback);
const manager = new SQLiteBackupManager({ databasePath: join(root, 'data/douyin-monitor.sqlite'), backupDir: join(root, 'data/backups/phase100-20261002'), execFileImpl: boundedExec });
const backup = await manager.createBackup('phase100-before-profile-first');
assert.equal(backup.status, 'created');
const verified = await manager.verifySnapshot(backup.path);
const temporary = await mkdtemp(join(tmpdir(), 'mcn-phase100-restore-'));
await chmod(temporary, 0o700);
const restored = join(temporary, 'restored.sqlite');
await copyFile(backup.path, restored, 1);
await chmod(restored, 0o400);
const restoredSha256 = await checksum(restored);
assert.equal(restoredSha256, verified.manifest.sha256);
const validation = validateSQLiteSnapshot(restored);
assert.ok(validationCountsMatch(verified.validation.counts, validation.counts));
assert.equal(await checksum(backup.path), restoredSha256);
assert.equal((await stat(restored)).size, verified.manifest.bytes);
const db = new DatabaseSync(restored, { readOnly: true });
let cutoff;
try {
  db.exec('PRAGMA query_only=ON;BEGIN');
  cutoff = db.prepare("SELECT MAX(id) maxRunId,MAX(CASE WHEN finished_at IS NOT NULL AND status<>'running' THEN id END) maxTerminalRunId FROM runs").get();
  assert.equal(db.prepare('SELECT total_changes() changes').get().changes, 0);
  db.exec('ROLLBACK');
} finally { db.close(); }
const result = { startedAt, finishedAt: new Date().toISOString(), codeDir, code, backupPath: backup.path, restoredPath: restored,
  bytes: verified.manifest.bytes, sha256: restoredSha256, validation, restoredCountsMatch: true, cutoff,
  originalBackupsPreserved: true, liveDatabaseNotOverwritten: true, noNewTimer: true, noCollection: true };
await writeFile(join(root, 'data/maintenance-journal/2026-10-02-phase100-backup.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ finishedAt: result.finishedAt, bytes: result.bytes, cutoff, sha256: result.sha256, restoredPath: restored }));
