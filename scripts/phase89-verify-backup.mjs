// One immutable online snapshot; verify only a fresh private read-only restore.
import assert from 'node:assert/strict';
import {mkdtemp,copyFile,chmod,writeFile,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {SQLiteBackupManager,validateSQLiteSnapshot,validationCountsMatch} from '../lib/backup-manager.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),startedAt=new Date().toISOString();
const manager=new SQLiteBackupManager({databasePath:join(root,'data/douyin-monitor.sqlite'),backupDir:join(root,'data/backups/phase89-20261002')});
const backup=await manager.createBackup('phase89-before-pagination-release');assert.equal(backup.status,'created');
const verified=await manager.verifySnapshot(backup.path);
const temporary=await mkdtemp(join(tmpdir(),'mcn-phase89-restore-'));await chmod(temporary,0o700);
const restored=join(temporary,'restored.sqlite');await copyFile(backup.path,restored);await chmod(restored,0o400);
const hashFile=async path=>{const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');};
const restoredSha256=await hashFile(restored);assert.equal(restoredSha256,verified.manifest.sha256);
const validation=validateSQLiteSnapshot(restored);assert.ok(validationCountsMatch(verified.validation.counts,validation.counts));
assert.equal(await hashFile(backup.path),restoredSha256);assert.equal((await stat(restored)).size,verified.manifest.bytes);
const db=new DatabaseSync(restored,{readOnly:true});let cutoff;
try {db.exec('PRAGMA query_only=ON');cutoff=db.prepare('SELECT MAX(id) AS maxRunId,MAX(CASE WHEN finished_at IS NOT NULL AND status<>\'running\' THEN id END) AS maxTerminalRunId FROM runs').get();
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM works_observations WHERE run_id BETWEEN 2424 AND 2441').get().count,18);
  assert.equal(db.prepare('SELECT total_changes() AS changes').get().changes,0);
} finally {db.close();}
const evidence={startedAt,finishedAt:new Date().toISOString(),backupPath:backup.path,restoredPath:restored,bytes:verified.manifest.bytes,sha256:restoredSha256,
 originalBackupPreserved:true,liveDatabaseNotOverwritten:true,source:verified.manifest.source,createdAt:verified.manifest.createdAt,
 validation,restoredCountsMatch:true,cutoff,auditedBatch2424To2441Included:true,manualCollection:false,newTimers:false};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase89-backup.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({finishedAt:evidence.finishedAt,bytes:evidence.bytes,sha256:evidence.sha256,cutoff,
  restoredCountsMatch:true,auditedBatch2424To2441Included:true}));
