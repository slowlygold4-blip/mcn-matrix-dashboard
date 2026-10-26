import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {getNextFirstCollectionTarget} from '../lib/first-collection.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const lane=process.argv[2],tag=process.argv[3];
assert.ok(['main','publisher'].includes(lane));assert.match(tag??'',/^[a-z0-9-]+$/);
assert.ok(Date.now()<Date.parse('2026-10-02T05:10:00Z'),'handoff bounded to this turn');
const sha=x=>createHash('sha256').update(x).digest('hex');
const prefix=join(root,`data/maintenance-journal/2026-10-02-phase100-${lane}-${tag}`);
const manifest=JSON.parse(readFileSync(join(root,'docs/phase100-candidate-manifest.json')));
for(const f of manifest.files)assert.equal(sha(readFileSync(join(root,f.file))),f.candidate,f.file);
for(const f of manifest.preserved)assert.equal(sha(readFileSync(join(root,f.file))),f.sha256,f.file);
const full=readFileSync(join(root,'data/maintenance-journal/2026-10-02-phase100-main-full.log'),'utf8');
assert.match(full,/ℹ tests 4235\b/);assert.match(full,/ℹ pass 4235\b/);
for(const key of ['fail','cancelled','skipped'])assert.match(full,new RegExp('ℹ '+key+' 0\\b'));
const backup=JSON.parse(readFileSync(join(root,'data/maintenance-journal/2026-10-02-phase100-backup.json')));
assert.equal(backup.restoredCountsMatch,true);assert.equal(backup.validation.integrityCheck,'ok');assert.equal(backup.validation.foreignKeyViolations,0);
assert.equal(statSync(backup.backupPath).size,backup.bytes);assert.equal(statSync(backup.restoredPath).size,backup.bytes);
const pid=lane==='main'?22870:67390;
const command='/Users/tyke/.local/node-v24.16.0-darwin-arm64/bin/node '+(lane==='publisher'?'--use-env-proxy ':'')+join(root,lane==='main'?'server.mjs':'scripts/public-replica-publisher.mjs');
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
 if(lane==='main'){
 const response=await fetch('http://127.0.0.1:4188/api/monitoring-status',{signal:AbortSignal.timeout(6000)});assert.equal(response.status,200);const s=(await response.json()).scheduler;
 assert.equal(s.running,false);assert.equal(s.currentRun,null);assert.equal(s.lastSuccessfulTickAt,s.lastTickAt);assert.equal(s.lastError,null);assert.equal(s.scheduleIntervalHours,8);assert.deepEqual(s.slotTimes,['02:00','10:00','18:00']);assert.ok(Date.parse(s.nextRunAt)-Date.now()>60000);
 assert.ok(s.worksOnlyRetry.nextEligibleAt===null||Date.parse(s.worksOnlyRetry.nextEligibleAt)-Date.now()>60000);
 const database=databaseIdle(),sourceSha=sha(readFileSync(join(root,'data/source-poll/manifest.json')));
 const tickAgeMs=Date.now()-Date.parse(s.lastTickAt);assert.ok(tickAgeMs>=0&&tickAgeMs<10000,'not enough idle tick margin');
 return{checkedAt:new Date().toISOString(),process,database,sourceSha,lastTickAt:s.lastTickAt,lastSuccessfulTickAt:s.lastSuccessfulTickAt,tickAgeMs,nextRunAt:s.nextRunAt};
 }
 const home=join(root,'data/public-replica-publisher'),stateBytes=readFileSync(join(home,'state.json')),lockBytes=readFileSync(join(home,'lock.json')),state=JSON.parse(stateBytes),lock=JSON.parse(lockBytes);
 assert.equal(lock.pid,pid);assert.equal(state.status,'success');assert.equal(state.active,null);assert.equal(state.sync.status,'success');assert.ok(Date.parse(state.publishedAsOf)+1800000-Date.now()>120000,'too near cadence');
 return{checkedAt:new Date().toISOString(),process,stateSha:sha(stateBytes),lockSha:sha(lockBytes),publishedAsOf:state.publishedAsOf,nextCadence:new Date(Date.parse(state.publishedAsOf)+1800000).toISOString(),active:null};
}
const receipt={startedAt:new Date().toISOString(),lane,pid,atomicDrain:false,noManualSampling:true,originalKeepAliveOwnsRestart:true,sourceUntouched:true};
try{
 receipt.first=await observe();await new Promise(resolve=>setTimeout(resolve,1000));receipt.second=await observe();
 assert.deepEqual(receipt.second.process,receipt.first.process);
 if(lane==='main'){
 assert.deepEqual(receipt.second.database,receipt.first.database);assert.equal(receipt.second.sourceSha,receipt.first.sourceSha);assert.equal(receipt.second.lastTickAt,receipt.first.lastTickAt);
 assert.deepEqual(databaseIdle(),receipt.second.database);assert.ok(Date.now()-Date.parse(receipt.second.lastTickAt)<10000);
 }else for(const field of ['stateSha','lockSha','publishedAsOf','nextCadence'])assert.equal(receipt.second[field],receipt.first[field]);
 assert.deepEqual(processState(),receipt.second.process);
 writeFileSync(prefix+'-gate.json',JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
 if(lane==='main')assert.ok(Date.now()-Date.parse(receipt.second.lastTickAt)<10000,'final idle tick margin expired');
 else assert.ok(Date.parse(receipt.second.nextCadence)-Date.now()>120000,'final publisher margin expired');
 process.kill(pid,'SIGTERM');receipt.signalledAt=new Date().toISOString();
 writeFileSync(prefix+'-signal.json',JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({lane,pid,signalledAt:receipt.signalledAt,atomicDrain:false}));
}catch(error){receipt.refusedAt=new Date().toISOString();receipt.error=error.message;writeFileSync(prefix+'-refused.json',JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});throw error;}
