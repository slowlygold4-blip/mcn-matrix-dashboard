import assert from 'node:assert/strict';
import {mkdtemp,copyFile,chmod,mkdir,writeFile,stat,constants} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {SQLiteBackupManager,validateSQLiteSnapshot,validationCountsMatch} from '../lib/backup-manager.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),startedAt=new Date().toISOString();
assert.ok(Date.now()<Date.parse('2026-10-02T08:46:59Z'));
const sha=async p=>{const h=createHash('sha256');for await(const b of createReadStream(p))h.update(b);return h.digest('hex');};
const codeDir=join(root,'data/code-candidates/phase109/preimage'),code=[];
for(const file of ['public/rebuild.css','public/rebuild.js','public/rebuild.html','public/console-model.js','server.mjs','lib/console-reader.mjs','lib/analytics.mjs','lib/database.mjs','lib/post-ingestion-review.mjs','scripts/douyin_browser_collector.mjs']){
 const destination=join(codeDir,file);await mkdir(join(destination,'..'),{recursive:true,mode:0o700});const beforeSha256=await sha(join(root,file));await copyFile(join(root,file),destination,constants.COPYFILE_EXCL);await chmod(destination,0o400);assert.equal(await sha(destination),beforeSha256);code.push({file,beforeSha256,destination});
}
const site=join(root,'../mcn-public-site');
for(const file of ['app/page.tsx','app/replica.css','components/scrollable-table.tsx','lib/replica-navigation.mjs','lib/replica-model.mjs','lib/replica-export.mjs']){
 const destination=join(codeDir,'site',file);await mkdir(join(destination,'..'),{recursive:true,mode:0o700});const beforeSha256=await sha(join(site,file));await copyFile(join(site,file),destination,constants.COPYFILE_EXCL);await chmod(destination,0o400);assert.equal(await sha(destination),beforeSha256);code.push({site:true,file,beforeSha256,destination});
}
const manager=new SQLiteBackupManager({databasePath:join(root,'data/douyin-monitor.sqlite'),backupDir:join(root,'data/backups/phase109-20261002'),execFileImpl:(f,a,o,c)=>execFile(f,a,{...o,timeout:60000},c)});
const backup=await manager.createBackup('phase109-before-comparable-ranking');assert.equal(backup.status,'created');const verified=await manager.verifySnapshot(backup.path);
const temp=await mkdtemp(join(tmpdir(),'mcn-phase109-restore-'));await chmod(temp,0o700);const restoredPath=join(temp,'restored.sqlite');await copyFile(backup.path,restoredPath,constants.COPYFILE_EXCL);await chmod(restoredPath,0o400);
assert.equal(await sha(restoredPath),verified.manifest.sha256);assert.equal((await stat(restoredPath)).size,verified.manifest.bytes);const validation=validateSQLiteSnapshot(restoredPath);assert.ok(validationCountsMatch(verified.validation.counts,validation.counts));
const db=new DatabaseSync(restoredPath,{readOnly:true});let cutoff;
try{db.exec('PRAGMA query_only=ON;BEGIN');cutoff=db.prepare("SELECT max(id) maxRunId,max(CASE WHEN finished_at IS NOT NULL AND status<>'running' THEN id END) maxTerminalRunId FROM runs").get();assert.equal(db.prepare('SELECT total_changes() n').get().n,0);db.exec('ROLLBACK');}finally{db.close();}
for(const p of code)assert.equal(await sha(join(p.site?site:root,p.file)),p.beforeSha256);
const result={startedAt,finishedAt:new Date().toISOString(),codeDir,code,backupPath:backup.path,restoredPath,bytes:verified.manifest.bytes,sha256:verified.manifest.sha256,validation,cutoff,restoredCountsMatch:true,originalBackupsPreserved:true,liveDatabaseNotOverwritten:true,noCollection:true,noNewTimer:true};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase109-backup.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o400});
console.log(JSON.stringify({finishedAt:result.finishedAt,backupPath:result.backupPath,restoredPath,bytes:result.bytes,sha256:result.sha256,cutoff,codePreimages:code.length}));
