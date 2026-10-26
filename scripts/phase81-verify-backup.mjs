// Create one new consistent online backup. Its isolated destination contains no
// old backups to prune. Verify in a fresh, read-only temporary copy, never live.
import assert from 'node:assert/strict';
import {mkdtemp,copyFile,chmod,writeFile,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SQLiteBackupManager,validateSQLiteSnapshot,validationCountsMatch} from '../lib/backup-manager.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),startedAt=new Date().toISOString();
const manager=new SQLiteBackupManager({databasePath:join(root,'data/douyin-monitor.sqlite'),backupDir:join(root,'data/backups/phase81-20261002')});
const backup=await manager.createBackup('phase81-before-runtime-release');assert.equal(backup.status,'created');
const verified=await manager.verifySnapshot(backup.path);
const temporary=await mkdtemp(join(tmpdir(),'mcn-phase81-restore-'));await chmod(temporary,0o700);
const restored=join(temporary,'restored.sqlite');await copyFile(backup.path,restored);await chmod(restored,0o400);
const hashFile=async path=>{const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');};
const restoredSha256=await hashFile(restored);assert.equal(restoredSha256,verified.manifest.sha256);
const validation=validateSQLiteSnapshot(restored);assert.ok(validationCountsMatch(verified.validation.counts,validation.counts));
assert.equal(await hashFile(backup.path),restoredSha256);assert.equal((await stat(restored)).size,verified.manifest.bytes);
const evidence={startedAt,finishedAt:new Date().toISOString(),backupPath:backup.path,restoredPath:restored,bytes:verified.manifest.bytes,sha256:restoredSha256,
 originalBackupPreserved:true,liveDatabaseNotOverwritten:true,originalHistoryByteExactInRestoredCopy:true,source:verified.manifest.source,createdAt:verified.manifest.createdAt,
 validation,restoredCountsMatch:true,manualCollection:false,newTimers:false};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase81-backup.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(evidence));
