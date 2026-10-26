import assert from 'node:assert/strict';
import { mkdtemp, copyFile, chmod, mkdir, writeFile, stat, constants } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteBackupManager, validateSQLiteSnapshot, validationCountsMatch } from '../lib/backup-manager.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),startedAt=new Date().toISOString();
assert.ok(Date.now()<Date.parse('2026-10-02T06:19:04Z'));
const sha=async path=>{const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');};
const codeDir=join(root,'data/code-candidates/phase103/preimage'),code=[];
for(const file of ['public/rebuild.css','public/rebuild.js','public/rebuild.html','public/console-model.js','server.mjs','lib/console-reader.mjs','lib/analytics.mjs','lib/database.mjs','lib/post-ingestion-review.mjs']){
 const destination=join(codeDir,file);await mkdir(join(destination,'..'),{recursive:true,mode:0o700});const beforeSha256=await sha(join(root,file));await copyFile(join(root,file),destination,constants.COPYFILE_EXCL);await chmod(destination,0o400);assert.equal(await sha(destination),beforeSha256);code.push({file,beforeSha256,destination});
}
const boundedExec=(file,args,options,callback)=>execFile(file,args,{...options,timeout:60000},callback);
const manager=new SQLiteBackupManager({databasePath:join(root,'data/douyin-monitor.sqlite'),backupDir:join(root,'data/backups/phase103-20261002'),execFileImpl:boundedExec});
const backup=await manager.createBackup('phase103-before-numeric-contrast');assert.equal(backup.status,'created');
const verified=await manager.verifySnapshot(backup.path),temp=await mkdtemp(join(tmpdir(),'mcn-phase103-restore-'));await chmod(temp,0o700);
const restoredPath=join(temp,'restored.sqlite');await copyFile(backup.path,restoredPath,constants.COPYFILE_EXCL);await chmod(restoredPath,0o400);
assert.equal(await sha(restoredPath),verified.manifest.sha256);assert.equal((await stat(restoredPath)).size,verified.manifest.bytes);
const validation=validateSQLiteSnapshot(restoredPath);assert.ok(validationCountsMatch(verified.validation.counts,validation.counts));
const db=new DatabaseSync(restoredPath,{readOnly:true});let cutoff;
try{db.exec('PRAGMA query_only=ON;BEGIN');cutoff=db.prepare("SELECT MAX(id) maxRunId,MAX(CASE WHEN finished_at IS NOT NULL AND status<>'running' THEN id END) maxTerminalRunId FROM runs").get();assert.equal(db.prepare('SELECT total_changes() n').get().n,0);db.exec('ROLLBACK');}finally{db.close();}
for(const c of code)assert.equal(await sha(join(root,c.file)),c.beforeSha256);
const result={startedAt,finishedAt:new Date().toISOString(),codeDir,code,backupPath:backup.path,restoredPath,bytes:verified.manifest.bytes,sha256:verified.manifest.sha256,validation,cutoff,restoredCountsMatch:true,originalBackupsPreserved:true,liveDatabaseNotOverwritten:true,noCollection:true,noNewTimer:true};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase103-backup.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(result));
