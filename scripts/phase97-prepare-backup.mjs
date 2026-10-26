import assert from 'node:assert/strict';
import {mkdtemp,copyFile,chmod,mkdir,writeFile,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {SQLiteBackupManager,validateSQLiteSnapshot,validationCountsMatch} from '../lib/backup-manager.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),startedAt=new Date().toISOString();
assert.ok(Date.now()<Date.parse('2026-10-02T03:42:32Z'),'phase97 preparation window expired');
const checksum=async path=>{const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');};
const codeDir=join(root,'data/code-candidates/phase97/preimage');
await mkdir(codeDir,{recursive:true,mode:0o700});
const paths=['scripts/public-replica-publisher.mjs','lib/public-replica-export.mjs','lib/public-account-coverage.mjs','lib/account-history.mjs'];
const code=[];
for(const path of paths){const destination=join(codeDir,path);await mkdir(join(destination,'..'),{recursive:true,mode:0o700});
  await copyFile(join(root,path),destination,1);await chmod(destination,0o400);
  const sha256=await checksum(destination);assert.equal(await checksum(join(root,path)),sha256);code.push({path,sha256,destination});}
const boundedExec=(file,args,options,callback)=>execFile(file,args,{...options,timeout:60_000},callback);
const manager=new SQLiteBackupManager({databasePath:join(root,'data/douyin-monitor.sqlite'),backupDir:join(root,'data/backups/phase97-20261002'),execFileImpl:boundedExec});
const backup=await manager.createBackup('phase97-before-publisher-release');assert.equal(backup.status,'created');
const verified=await manager.verifySnapshot(backup.path);
const temporary=await mkdtemp(join(tmpdir(),'mcn-phase97-restore-'));await chmod(temporary,0o700);
const restored=join(temporary,'restored.sqlite');await copyFile(backup.path,restored,1);await chmod(restored,0o400);
const restoredSha256=await checksum(restored);assert.equal(restoredSha256,verified.manifest.sha256);
const validation=validateSQLiteSnapshot(restored);assert.ok(validationCountsMatch(verified.validation.counts,validation.counts));
assert.equal(await checksum(backup.path),restoredSha256);assert.equal((await stat(restored)).size,verified.manifest.bytes);
const db=new DatabaseSync(restored,{readOnly:true});let cutoff;
try{db.exec('PRAGMA query_only=ON');cutoff=db.prepare("SELECT MAX(id) maxRunId,MAX(CASE WHEN finished_at IS NOT NULL AND status<>'running' THEN id END) maxTerminalRunId FROM runs").get();
  assert.equal(db.prepare('SELECT total_changes() changes').get().changes,0);
}finally{db.close();}
const result={startedAt,finishedAt:new Date().toISOString(),codeDir,code,newHelperPreviouslyAbsent:true,
  backupPath:backup.path,restoredPath:restored,bytes:verified.manifest.bytes,sha256:restoredSha256,validation,restoredCountsMatch:true,cutoff,
  originalBackupPreserved:true,liveDatabaseNotOverwritten:true,noNewTimer:true,noCollection:true};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase97-backup.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({finishedAt:result.finishedAt,bytes:result.bytes,cutoff,sha256:result.sha256,restoredPath:restored}));
