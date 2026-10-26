import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNextFirstCollectionTarget } from '../lib/first-collection.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const tag=process.argv[2];
assert.match(tag??'',/^[a-z0-9-]+$/);
assert.ok(Date.now()<Date.parse('2026-10-02T05:52:00Z'),'bounded Phase102 only');
const sha=x=>createHash('sha256').update(x).digest('hex');
const prefix=join(root,`data/maintenance-journal/2026-10-02-phase102-main-${tag}`);
const manifest=JSON.parse(readFileSync(join(root,'docs/phase102-installation-manifest.json')));
for(const f of manifest.installationFiles)assert.equal(sha(readFileSync(join(root,f.file))),f.postSha256,f.file);
for(const f of manifest.reports)assert.equal(sha(readFileSync(join(root,f.file))),f.sha256,f.file);
const oldPath=join(root,'docs/phase100-candidate-manifest.json');
assert.equal(sha(readFileSync(oldPath)),manifest.preservation.phase100ManifestSha256);
const old=JSON.parse(readFileSync(oldPath));
for(const f of old.files)if(!manifest.preservation.exclusions.includes(f.file))assert.equal(sha(readFileSync(join(root,f.file))),f.candidate,f.file);
for(const f of old.preserved)assert.equal(sha(readFileSync(join(root,f.file))),f.file==='lib/utils.mjs'?manifest.preservation.phase101UtilsSha256:f.sha256,f.file);
const utility=JSON.parse(readFileSync(join(root,'docs/phase101-performance-manifest.json')));
for(const f of utility.installationFiles)assert.equal(sha(readFileSync(join(root,f.file))),f.postSha256,f.file);
const runtime=readFileSync(join(root,'docs/phase102-runtime-review.md'),'utf8');
assert.match(runtime,/acceptable for Root's separately gated loading decision/);
const full=readFileSync(join(root,manifest.fullRegression.file),'utf8');
assert.equal(sha(full),manifest.fullRegression.sha256);
const fullLines=full.split(String.fromCharCode(10));
assert.ok(fullLines.includes('ℹ tests 4249'));assert.ok(fullLines.includes('ℹ pass 4249'));
for(const key of ['fail','cancelled','skipped'])assert.ok(fullLines.includes('ℹ '+key+' 0'));
const backup=JSON.parse(readFileSync(join(root,'data/maintenance-journal/2026-10-02-phase102-backup.json')));
assert.equal(backup.restoredCountsMatch,true);assert.equal(backup.validation.integrityCheck,'ok');assert.equal(backup.validation.foreignKeyViolations,0);
assert.equal(statSync(backup.backupPath).size,backup.bytes);assert.equal(statSync(backup.restoredPath).size,backup.bytes);
for(const f of backup.code)assert.equal(sha(readFileSync(f.destination)),f.beforeSha256);
const pid=84545;
const command='/Users/tyke/.local/node-v24.16.0-darwin-arm64/bin/node '+join(root,'server.mjs');
function processState(){
 assert.equal(execFileSync('/bin/ps',['-p',String(pid),'-o','command='],{encoding:'utf8'}).trim(),command);
 assert.equal(execFileSync('/bin/ps',['-p',String(pid),'-o','ppid='],{encoding:'utf8'}).trim(),'1');
 const started=execFileSync('/bin/ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8'}).trim();
 let children=[];try{children=execFileSync('/usr/bin/pgrep',['-P',String(pid)],{encoding:'utf8'}).trim().split('\n').filter(Boolean);}catch(e){if(e.status!==1)throw e;}
 assert.deepEqual(children,[]);return{pid,command,started,children};
}
function databaseIdle(){
 const db=new DatabaseSync(join(root,'data/douyin-monitor.sqlite'),{readOnly:true});
 try{db.exec('PRAGMA query_only=ON;BEGIN');const now=new Date().toISOString();
 const idle={runs:db.prepare("SELECT count(*) n FROM runs WHERE status='running'").get().n,jobs:db.prepare("SELECT count(*) n FROM author_resolution_jobs WHERE status IN ('queued','running')").get().n,leases:db.prepare('SELECT count(*) n FROM author_resolution_queue WHERE lease_owner IS NOT NULL').get().n,due:db.prepare("SELECT count(*) n FROM author_resolution_queue WHERE status IN ('pending','retry') AND next_attempt_at<=? AND (lease_until IS NULL OR lease_until<=?)").get(now,now).n,firstCollection:getNextFirstCollectionTarget({db})?.id??null};
 assert.deepEqual(idle,{runs:0,jobs:0,leases:0,due:0,firstCollection:null});
 const maxRun=db.prepare('SELECT max(id) n FROM runs').get().n;
 const settings=db.prepare("SELECT key,value,updated_at FROM settings WHERE key IN ('scheduleTime','publicPostsPerAccount') OR key LIKE 'publicWorks%'").all();
 assert.equal(settings.find(x=>x.key==='publicPostsPerAccount').value,'30');assert.equal(settings.find(x=>x.key==='scheduleTime').value,'10:00');assert.equal(settings.filter(x=>x.key.startsWith('publicWorks')).length,0);
 assert.equal(db.prepare('SELECT total_changes() n').get().n,0);db.exec('ROLLBACK');return{idle,maxRun,settings};
 }finally{db.close();}
}
async function observe(){
 const process=processState();
 const response=await fetch('http://127.0.0.1:4188/api/monitoring-status',{signal:AbortSignal.timeout(6000)});assert.equal(response.status,200);const s=(await response.json()).scheduler;
 assert.equal(s.running,false);assert.equal(s.currentRun,null);assert.equal(s.lastSuccessfulTickAt,s.lastTickAt);assert.equal(s.lastError,null);assert.equal(s.scheduleIntervalHours,8);assert.deepEqual(s.slotTimes,['02:00','10:00','18:00']);assert.ok(Date.parse(s.nextRunAt)-Date.now()>60000);
 assert.ok(s.worksOnlyRetry.nextEligibleAt===null||Date.parse(s.worksOnlyRetry.nextEligibleAt)-Date.now()>60000);
 const database=databaseIdle(),sourceSha=sha(readFileSync(join(root,'data/source-poll/manifest.json')));
 const tickAgeMs=Date.now()-Date.parse(s.lastTickAt);assert.ok(tickAgeMs>=0&&tickAgeMs<10000,'not enough idle tick margin');
 return{checkedAt:new Date().toISOString(),process,database,sourceSha,lastTickAt:s.lastTickAt,lastSuccessfulTickAt:s.lastSuccessfulTickAt,tickAgeMs,nextRunAt:s.nextRunAt};
}
const receipt={startedAt:new Date().toISOString(),pid,atomicDrain:false,noManualSampling:true,originalKeepAliveOwnsRestart:true,sourceAndPublisherUntouched:true,sourceHashes:Object.fromEntries(manifest.installationFiles.filter(x=>['server.mjs','lib/console-reader.mjs'].includes(x.file)).map(x=>[x.file,x.postSha256]))};
try{
 receipt.first=await observe();await new Promise(resolve=>setTimeout(resolve,1000));receipt.second=await observe();
 assert.deepEqual(receipt.second.process,receipt.first.process);assert.deepEqual(receipt.second.database,receipt.first.database);assert.equal(receipt.second.sourceSha,receipt.first.sourceSha);assert.equal(receipt.second.lastTickAt,receipt.first.lastTickAt);
 assert.deepEqual(databaseIdle(),receipt.second.database);assert.ok(Date.now()-Date.parse(receipt.second.lastTickAt)<10000);
 assert.deepEqual(processState(),receipt.second.process);
 writeFileSync(prefix+'-gate.json',JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
 assert.ok(Date.now()-Date.parse(receipt.second.lastTickAt)<10000,'final idle tick margin expired');
 process.kill(pid,'SIGTERM');receipt.signalledAt=new Date().toISOString();
 writeFileSync(prefix+'-signal.json',JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({pid,signalledAt:receipt.signalledAt,atomicDrain:false}));
}catch(error){receipt.refusedAt=new Date().toISOString();receipt.error=error.message;writeFileSync(prefix+'-refused.json',JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});throw error;}
