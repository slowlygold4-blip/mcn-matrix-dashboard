import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { inspectDatabase } from './runtime-audit.mjs';
import { inspectLatestBackup } from './backup-audit.mjs';

const database = new DatabaseSync(workerData.databasePath, { readOnly: true });
database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000;');

parentPort.on('message', ({ id, deep }) => {
  const checkStartedAt = new Date().toISOString();
  try {
    database.exec('BEGIN');
    const databaseAudit = inspectDatabase({ db: database });
    database.exec('COMMIT');
    // Backups have their own checkedAt: they are independent immutable snapshots,
    // not part of the live database read transaction.
    const backup = inspectLatestBackup(workerData.backupDir, { verifyHash: deep === true, verifySQLite: deep === true });
    parentPort.postMessage({ id, ok: true, result: {
      database: databaseAudit, backup, checkStartedAt, checkFinishedAt: new Date().toISOString(),
    } });
  } catch {
    try { database.exec('ROLLBACK'); } catch {}
    parentPort.postMessage({ id, ok: false, error: 'SYSTEM_AUDIT_UNAVAILABLE' });
  }
});

process.on('exit', () => { try { database.close(); } catch {} });
