// This release may signal only the exact existing idle Main; no new service.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const prefix=join(root,'data/maintenance-journal/2026-10-02-phase91-');
const mainPid=81452,sha=b=>createHash('sha256').update(b).digest('hex');
// The ordinary loop wakes every30s; a30s no-change interval cannot fit its idle
// gap. Attempt2 instead proves two exact idle observations1s apart, then uses
// the existing graceful shutdown (which drains/records a raced collector).
// Attempt1 and all refusal output remain immutable; no collector guard changes.
const attempt=process.argv.includes('--attempt=2')?2:1;
const firstPath=prefix+'runtime-first-idle'+(attempt===2?'-attempt2':'')+'.json';
const manifest=JSON.parse(await readFile('/tmp/mcn-phase90-collector-VaHXS7/phase91-candidate-manifest.json'));
async function observe(){
 const r=await fetch('http://127.0.0.1:4188/api/monitoring-status',{signal:AbortSignal.timeout(10000)});assert.equal(r.status,200);const s=await r.json();
 assert.equal(s.scheduler.running,false);assert.equal(s.scheduler.currentRun,null);
 assert.deepEqual(s.scheduler.slotTimes,['02:00','10:00','18:00']);assert.equal(s.scheduler.scheduleIntervalHours,8);
 assert.ok(Date.parse(s.scheduler.nextRunAt)-Date.now()>60000);
 const retry=s.scheduler.worksOnlyRetry.nextEligibleAt;
 assert.ok(retry===null || Date.parse(retry)-Date.now()>60000,'not near a retry');
 const db=new DatabaseSync(join(root,'data/douyin-monitor.sqlite'),{readOnly:true});let busy,maxRun,legacy;
 try{db.exec('PRAGMA query_only=ON');busy={runs:db.prepare("SELECT count(*) n FROM runs WHERE status='running'").get().n,jobs:db.prepare("SELECT count(*) n FROM author_resolution_jobs WHERE status IN ('running','queued')").get().n,leases:db.prepare('SELECT count(*) n FROM author_resolution_queue WHERE lease_owner IS NOT NULL').get().n};
 assert.deepEqual(busy,{runs:0,jobs:0,leases:0});maxRun=db.prepare('SELECT max(id) n FROM runs').get().n;
 legacy={...db.prepare("SELECT key,value,updated_at FROM settings WHERE key='publicPostsPerAccount'").get()};
 assert.equal(legacy.value,'30');assert.equal(db.prepare("SELECT count(*) n FROM settings WHERE key LIKE 'publicWorks%'").get().n,0);
 }finally{db.close();}
 const command='/Users/tyke/.local/node-v24.16.0-darwin-arm64/bin/node '+join(root,'server.mjs');
 assert.equal(execFileSync('/bin/ps',['-p',String(mainPid),'-o','command='],{encoding:'utf8'}).trim(),command);
 assert.equal(execFileSync('/bin/ps',['-p',String(mainPid),'-o','ppid='],{encoding:'utf8'}).trim(),'1');
 let children=[];try{children=execFileSync('/usr/bin/pgrep',['-P',String(mainPid)],{encoding:'utf8'}).trim().split('\n').filter(Boolean);}catch(e){if(e.status!==1)throw e;}assert.deepEqual(children,[]);
 const codeHashes={};for(const f of manifest.files){codeHashes[f.path]=sha(await readFile(join(root,f.path)));assert.equal(codeHashes[f.path],f.candidate);}
 return{checkedAt:new Date().toISOString(),mainPid,command,busy,maxRun,legacy,codeHashes,sourceSha256:sha(await readFile(join(root,'data/source-poll/manifest.json'))),nextWorksRetryAt:retry,nextRunAt:s.scheduler.nextRunAt,slotKey:s.scheduler.currentSlotKey};
}
if(process.argv.includes('--first')){
 const first=await observe();await writeFile(firstPath,JSON.stringify(first,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(first));
}else if(process.argv.includes('--reload')){
 const text=await readFile(prefix+'stage-full-verified.txt','utf8'),tests=Number(/ℹ tests (\d+)\b/.exec(text)?.[1]);
 assert.ok(tests>=4035);assert.equal(Number(/ℹ pass (\d+)\b/.exec(text)?.[1]),tests-1);
 for(const key of ['fail','cancelled'])assert.match(text,new RegExp('ℹ '+key+' 0\\b'));
 assert.match(text,/ℹ skipped 1\b/);assert.match(text,/real existing2211\/2215\/2216.*production archive absent/);
 const first=JSON.parse(await readFile(firstPath));
 assert.ok(Date.now()-Date.parse(first.checkedAt)>=(attempt===2?1000:30000));assert.ok(Date.now()-Date.parse(first.checkedAt)<(attempt===2?10000:120000));
 const second=await observe();for(const key of Object.keys(first).filter(k=>k!=='checkedAt'))assert.deepEqual(second[key],first[key]);
 process.kill(mainPid,'SIGTERM');
 await writeFile(prefix+'runtime-handoff.json',JSON.stringify({first,second,attempt,idleObservationIntervalMs:Date.parse(second.checkedAt)-Date.parse(first.checkedAt),existingGracefulShutdownDrainsRacedWork:true,onlyExistingIdleMainSignalled:true,originalKeepAliveOwnsResume:true,noNewTimer:true,noManualSampling:true,sourceAndPublisherUntouched:true},null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({signalledMainPid:mainPid,existingKeepAliveOwnsResume:true}));
}else throw Error('use --first or --reload');
