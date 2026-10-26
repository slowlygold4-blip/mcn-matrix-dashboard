// Reload only the existing exact idle Main. Source/publisher remain untouched.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),journal=join(root,'data/maintenance-journal');
const firstPath=join(journal,'2026-10-02-phase84-runtime-first-idle.json'),sha=b=>createHash('sha256').update(b).digest('hex');
const files=['lib/collector-ownership.mjs','scripts/douyin_browser_collector.mjs','test/collector-process-ownership.test.mjs','test/works-failure-executor.test.mjs'];
async function observe(){
 const r=await fetch('http://127.0.0.1:4188/api/monitoring-status',{signal:AbortSignal.timeout(10000)});assert.equal(r.status,200);const status=await r.json();
 assert.equal(status.scheduler.running,false);assert.equal(status.scheduler.currentRun,null);
 assert.deepEqual(status.scheduler.slotTimes,['02:00','10:00','18:00']);assert.equal(status.scheduler.scheduleIntervalHours,8);
 assert.ok(Date.parse(status.scheduler.worksOnlyRetry.nextEligibleAt)-Date.now()>60000,'do not reload near a normal retry');
 const db=new DatabaseSync(join(root,'data/douyin-monitor.sqlite'),{readOnly:true});let busy,maxRun;
 try{db.exec('PRAGMA query_only=ON');busy={runs:db.prepare("SELECT count(*) n FROM runs WHERE status='running'").get().n,
  jobs:db.prepare("SELECT count(*) n FROM author_resolution_jobs WHERE status IN ('running','queued')").get().n,
  leases:db.prepare('SELECT count(*) n FROM author_resolution_queue WHERE lease_owner IS NOT NULL').get().n};
  assert.deepEqual(busy,{runs:0,jobs:0,leases:0});maxRun=db.prepare('SELECT max(id) n FROM runs').get().n;}finally{db.close();}
 const command='/Users/tyke/.local/node-v24.16.0-darwin-arm64/bin/node '+join(root,'server.mjs');
 assert.equal(execFileSync('/bin/ps',['-p','72427','-o','command='],{encoding:'utf8'}).trim(),command);
 assert.equal(execFileSync('/bin/ps',['-p','72427','-o','ppid='],{encoding:'utf8'}).trim(),'1');
 let children=[];try{children=execFileSync('/usr/bin/pgrep',['-P','72427'],{encoding:'utf8'}).trim().split('\n').filter(Boolean);}catch(e){if(e.status!==1)throw e;}assert.deepEqual(children,[]);
 return{checkedAt:new Date().toISOString(),mainPid:72427,command,busy,maxRun,sourceSha256:sha(await readFile(join(root,'data/source-poll/manifest.json'))),
  codeHashes:Object.fromEntries(await Promise.all(files.map(async f=>[f,sha(await readFile(join(root,f)))]))),nextWorksRetryAt:status.scheduler.worksOnlyRetry.nextEligibleAt,
  slotKey:status.scheduler.currentSlotKey,nextRunAt:status.scheduler.nextRunAt};
}
if(process.argv.includes('--first')){
 const first=await observe();await writeFile(firstPath,JSON.stringify(first,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(first));
}else if(process.argv.includes('--handoff')){
 const t=await readFile(join(journal,'2026-10-02-phase84-stage-final-verified.txt'),'utf8');
 assert.match(t,/ℹ tests 3850\b/);assert.match(t,/ℹ pass 3849\b/);assert.match(t,/ℹ fail 0\b/);assert.match(t,/ℹ skipped 1\b/);assert.match(t,/ℹ cancelled 0\b/);
 assert.match(t,/real existing2211\/2215\/2216.*production archive absent/);
 const archive=await readFile(join(journal,'2026-10-02-phase84-stage-archive-recheck.txt'),'utf8');
 assert.match(archive,/ℹ tests 1\b/);assert.match(archive,/ℹ pass 1\b/);assert.match(archive,/ℹ fail 0\b/);assert.match(archive,/ℹ skipped 0\b/);
 const first=JSON.parse(await readFile(firstPath));assert.ok(Date.now()-Date.parse(first.checkedAt)>=30000);assert.ok(Date.now()-Date.parse(first.checkedAt)<120000);
 const second=await observe();for(const key of Object.keys(first).filter(k=>k!=='checkedAt'))assert.deepEqual(second[key],first[key]);
 for(const file of files){const stage=await readFile(join('/private/tmp/mcn-phase84-stage-KsXDPG',file));assert.equal(sha(stage),second.codeHashes[file]);}
 process.kill(72427,'SIGTERM');
 const result={first,second,onlyExistingIdleMainSignalled:true,originalKeepAliveOwnsResume:true,sourceAndPublisherUntouched:true,noNewTimer:true,noManualSampling:true,stageFullGreen:true};
 await writeFile(join(journal,'2026-10-02-phase84-runtime-handoff.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(result));
}else throw Error('select first or handoff');
