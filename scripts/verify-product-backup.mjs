// Exercise recovery in a brand-new temporary directory, never on live data.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SQLiteBackupManager, validationCountsMatch } from '../lib/backup-manager.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manager = new SQLiteBackupManager({
  databasePath: join(root, 'data/douyin-monitor.sqlite'),
  backupDir: join(root, 'data/backups/product-release'),
  retention: 14,
});
const backup = await manager.createBackup('product-release');
if (backup.status !== 'created') throw new Error('No new backup was created');
const verified = await manager.verifySnapshot(backup.path);
const restoreDir = mkdtempSync(join(tmpdir(), 'product-recovery-check-'));
const recovered = await manager.restoreSnapshot(backup.path, join(restoreDir, 'restored.sqlite'));
const result = {
  checkedAt: new Date().toISOString(),
  backupPath: backup.path,
  recoveredPath: recovered.path,
  sourceWasNotOverwritten: true,
  sha256: verified.manifest.sha256,
  counts: verified.validation.counts,
  recoveredCounts: recovered.validation.counts,
  ok: validationCountsMatch(verified.validation.counts, recovered.validation.counts),
};
writeFileSync(join(root, 'output/playwright/product-recovery-verification.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (!result.ok) process.exitCode = 1;
