import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, mkdtemp, copyFile, constants } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteBackupManager, validateSQLiteSnapshot, validationCountsMatch } from '../lib/backup-manager.mjs';
import { validateImportMonitoring } from '../public/import-monitoring.js';
const root = new URL('../', import.meta.url).pathname;
const out = root + 'data/maintenance-journal/20261009-import-pipeline/';
const backupDir = root + 'data/backups/20261009-import-pipeline/';
const mode = process.argv[2]; assert.ok(['backup', 'load'].includes(mode));
const testReport = JSON.parse(await readFile(out + 'verification.json', 'utf8'));
assert.equal(testReport.databaseWrites, 0); assert.equal(testReport.monitoring.counts.submittedIdentities, 394);
if (mode === 'backup') {
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const manager = new SQLiteBackupManager({ databasePath: root + 'data/douyin-monitor.sqlite', backupDir, retention: 60 });
  const backup = await manager.createBackup('before-import-pipeline');
  assert.equal(backup.status, 'created');
  const temp = await mkdtemp(join(tmpdir(), 'mcn-import-pipeline-backup-'));
  const clone = join(temp, 'readback.sqlite');
  await copyFile(backup.path, clone, constants.COPYFILE_FICLONE);
  const validation = validateSQLiteSnapshot(clone);
  assert.ok(validationCountsMatch(backup.manifest.validation.counts, validation.counts));
  const report = { checkedAt: new Date().toISOString(), backup, clone, validation, readableCloneVerified: true, existingBackupsDeleted: false };
  await writeFile(out + 'backup.json', JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ backup: backup.path, sha256: backup.manifest.sha256, validation, readableCloneVerified: true }));
} else {
  const backup = JSON.parse(await readFile(out + 'backup.json', 'utf8')); assert.equal(backup.readableCloneVerified, true);
  const oldPid = Number(process.argv[3]); assert.equal(oldPid, 70732);
  const expectedCommand = '/Users/tyke/.local/node-v24.16.0-darwin-arm64/bin/node ' + root + 'server.mjs';
  const idle = () => {
    assert.equal(execFileSync('/bin/ps', ['-p', String(oldPid), '-o', 'command='], { encoding: 'utf8' }).trim(), expectedCommand);
    assert.equal(execFileSync('/bin/ps', ['-p', String(oldPid), '-o', 'ppid='], { encoding: 'utf8' }).trim(), '1');
    const db = new DatabaseSync(root + 'data/douyin-monitor.sqlite', { readOnly: true });
    try { return {
      runs: db.prepare("SELECT count(*) n FROM runs WHERE status IN ('running','queued')").get().n,
      jobs: db.prepare("SELECT count(*) n FROM author_resolution_jobs WHERE status IN ('queued','running')").get().n,
      leases: db.prepare('SELECT count(*) n FROM author_resolution_queue WHERE lease_owner IS NOT NULL').get().n,
    }; } finally { db.close(); }
  };
  let found = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    if (!Object.values(idle()).some(Boolean)) {
      await new Promise(r => setTimeout(r, 500));
      if (!Object.values(idle()).some(Boolean)) { found = true; break; }
    }
    await new Promise(r => setTimeout(r, 2500));
  }
  assert.ok(found, 'No idle window; no service signal sent');
  process.kill(oldPid, 'SIGTERM');
  const report = { signalledAt: new Date().toISOString(), oldPid, idleVerified: true, existingKeepAlive: true,
    forcedExit: false, sourceAndPublisherUntouched: true };
  await writeFile(out + 'runtime-signal.json', JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const origin = 'http://127.0.0.1:4188', job = 'c9895a58-14ef-4f1f-8c88-428fb3ce8d6f';
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const auth = await fetch(origin + '/api/auth/session', { signal: AbortSignal.timeout(1500) });
      const cookie = (auth.headers.get('set-cookie') || '').split(';')[0];
      const role = (await auth.json())?.user?.role;
      const response = await fetch(`${origin}/api/author-spreadsheet/jobs/${job}/monitoring`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const monitoring = await response.json(); validateImportMonitoring(monitoring, job);
        report.verifiedAt = new Date().toISOString(); report.monitoring = monitoring; report.role = role;
        report.health = (await fetch(origin + '/healthz')).status;
        report.newPid = Number(execFileSync('/usr/sbin/lsof', ['-t', '-iTCP:4188', '-sTCP:LISTEN'], { encoding: 'utf8' }).trim());
        assert.notEqual(report.newPid, oldPid);
        await writeFile(out + 'runtime-load.json', JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        console.log(JSON.stringify({ ...report, monitoring: { counts: monitoring.counts, checkedAt: monitoring.checkedAt } }));
        break;
      }
    } catch (error) { if (attempt === 99) throw error; }
    await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(report.verifiedAt, 'Service signal sent but online route not verified');
}
