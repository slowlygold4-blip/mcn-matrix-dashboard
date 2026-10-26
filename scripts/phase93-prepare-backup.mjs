import assert from 'node:assert/strict';
import {mkdtemp,copyFile,chmod,mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {SQLiteBackupManager,validateSQLiteSnapshot,validationCountsMatch} from '../lib/backup-manager.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),startedAt=new Date().toISOString();
const paths=['lib/browser-works-pagination.mjs','lib/official-profile-evidence.mjs','lib/works-only-observation.mjs',
  'lib/works-observation.mjs','lib/works-only-scheduler.mjs','lib/providers/public-web.mjs','scripts/douyin_browser_collector.mjs'];
const checksum=async path=>{const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');};
const frozen=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase92-closeout.json'),'utf8')).candidate.production;
for(const path of paths)assert.equal(await checksum(join(root,path)),frozen.find(row=>row.path===path).productionSha256);
const codeDir=await mkdtemp(join(tmpdir(),'mcn-phase93-preimage-'));await chmod(codeDir,0o700);
const code=[];
for(const path of paths){const destination=join(codeDir,path);await mkdir(join(destination,'..'),{recursive:true,mode:0o700});
  await copyFile(join(root,path),destination);await chmod(destination,0o400);
  const sha256=await checksum(destination);assert.equal(sha256,frozen.find(row=>row.path===path).productionSha256);code.push({path,destination,sha256});}
const manager=new SQLiteBackupManager({databasePath:join(root,'data/douyin-monitor.sqlite'),backupDir:join(root,'data/backups/phase93-20261002')});
const backup=await manager.createBackup('phase93-before-resume-release');assert.equal(backup.status,'created');
const verified=await manager.verifySnapshot(backup.path);
const temporary=await mkdtemp(join(tmpdir(),'mcn-phase93-restore-'));await chmod(temporary,0o700);
const restored=join(temporary,'restored.sqlite');await copyFile(backup.path,restored);await chmod(restored,0o400);
const restoredSha256=await checksum(restored);assert.equal(restoredSha256,verified.manifest.sha256);
const validation=validateSQLiteSnapshot(restored);assert.ok(validationCountsMatch(verified.validation.counts,validation.counts));
assert.equal(await checksum(backup.path),restoredSha256);assert.equal((await stat(restored)).size,verified.manifest.bytes);
const db=new DatabaseSync(restored,{readOnly:true});let cutoff;
try{db.exec('PRAGMA query_only=ON');cutoff=db.prepare("SELECT MAX(id) AS maxRunId,MAX(CASE WHEN finished_at IS NOT NULL AND status<>'running' THEN id END) AS maxTerminalRunId FROM runs").get();
  assert.equal(db.prepare('SELECT total_changes() AS changes').get().changes,0);
}finally{db.close();}
const evidence={startedAt,finishedAt:new Date().toISOString(),codeDir,code,backupPath:backup.path,restoredPath:restored,
  bytes:verified.manifest.bytes,sha256:restoredSha256,validation,restoredCountsMatch:true,cutoff,
  originalBackupPreserved:true,liveDatabaseNotOverwritten:true,noNewTimer:true,noCollection:true};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase93-backup.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({finishedAt:evidence.finishedAt,bytes:evidence.bytes,cutoff,sha256:evidence.sha256,codeDir,restoredPath:restored}));
