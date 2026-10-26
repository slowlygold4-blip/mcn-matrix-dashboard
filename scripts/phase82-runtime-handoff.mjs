// Only the already installed idle Main/Publisher may reload their module cache.
// No start command, timer, collection, source check or credentials are created.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { withPublisherRecoveryLock } from './public-replica-publisher.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)), home=join(root,'data/public-replica-publisher');
const ledger=join(root,'data/maintenance-journal'), sha=b=>createHash('sha256').update(b).digest('hex');
const firstPath=join(ledger,'2026-10-02-phase82-runtime-first-idle.json');
async function observe(){
 const response=await fetch('http://127.0.0.1:4188/api/monitoring-status',{signal:AbortSignal.timeout(10000)});
 assert.equal(response.status,200);const status=await response.json();
 assert.equal(status.scheduler.running,false);assert.equal(status.scheduler.currentRun,null);
 assert.equal(status.scheduler.scheduleIntervalHours,8);assert.deepEqual(status.scheduler.slotTimes,['02:00','10:00','18:00']);
 const db=new DatabaseSync(join(root,'data/douyin-monitor.sqlite'),{readOnly:true});let busy,maxRun;
 try{db.exec('PRAGMA query_only=ON');busy={runs:db.prepare("SELECT count(*) n FROM runs WHERE status='running'").get().n,
  jobs:db.prepare("SELECT count(*) n FROM author_resolution_jobs WHERE status IN ('running','queued')").get().n,
  leases:db.prepare('SELECT count(*) n FROM author_resolution_queue WHERE lease_owner IS NOT NULL').get().n};
  maxRun=db.prepare('SELECT max(id) n FROM runs').get().n;assert.deepEqual(busy,{runs:0,jobs:0,leases:0});}finally{db.close();}
 const lockBytes=await readFile(join(home,'lock.json')), stateBytes=await readFile(join(home,'state.json'));
 const lock=JSON.parse(lockBytes),state=JSON.parse(stateBytes);
 assert.equal(lock.pid,61526);assert.equal(lock.instance,'8cb39303-8780-4292-a42c-e120c61d884b');
 assert.equal(state.active,null);assert.equal(state.status,'success');assert.equal(state.sync.status,'success');
 const commands=[{pid:48392,command:'/Users/tyke/.local/node-v24.16.0-darwin-arm64/bin/node '+join(root,'server.mjs')},
  {pid:61526,command:'/Users/tyke/.local/node-v24.16.0-darwin-arm64/bin/node --use-env-proxy '+join(root,'scripts/public-replica-publisher.mjs')}];
 for(const {pid,command}of commands){assert.equal(execFileSync('/bin/ps',['-p',String(pid),'-o','command='],{encoding:'utf8'}).trim(),command);
  let children=[];try{children=execFileSync('/usr/bin/pgrep',['-P',String(pid)],{encoding:'utf8'}).trim().split('\n').filter(Boolean);}catch(e){if(e.status!==1)throw e;}assert.deepEqual(children,[]);}
 return {checkedAt:new Date().toISOString(),busy,maxRun,mainPid:48392,publisherPid:lock.pid,publisherInstance:lock.instance,
  lockSha256:sha(lockBytes),stateSha256:sha(stateBytes),sourceSha256:sha(await readFile(join(root,'data/source-poll/manifest.json'))),
  helperSha256:sha(await readFile(join(root,'lib/browser-first-page-activation.mjs'))),ownerSha256:sha(await readFile(join(root,'scripts/douyin_browser_collector.mjs'))),
  slotKey:status.scheduler.currentSlotKey,nextRunAt:status.scheduler.nextRunAt,nextWorksRetryAt:status.scheduler.worksOnlyRetry.nextEligibleAt};
}
if(process.argv.includes('--first')){
 const first=await observe();await writeFile(firstPath,JSON.stringify(first,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(first));
}else if(process.argv.includes('--handoff')){
 const test=await readFile(join(ledger,'2026-10-02-phase82-main-final-verified.txt'),'utf8');
 assert.match(test,/tests 3809\b/);assert.match(test,/pass 3809\b/);assert.match(test,/fail 0\b/);assert.match(test,/cancelled 0\b/);assert.match(test,/skipped 0\b/);
 const first=JSON.parse(await readFile(firstPath));assert.ok(Date.now()-Date.parse(first.checkedAt)>=30000);assert.ok(Date.now()-Date.parse(first.checkedAt)<120000);
 await withPublisherRecoveryLock(join(home,'lock.json'),async()=>{
  const second=await observe();for(const key of Object.keys(first).filter(k=>k!=='checkedAt'))assert.deepEqual(second[key],first[key]);
  process.kill(second.publisherPid,'SIGTERM');process.kill(second.mainPid,'SIGTERM');
  const result={first,second,onlyExistingIdleServicesSignalled:true,existingKeepAliveOwnsResume:true,sourceServiceUntouched:true,
   noNewTimer:true,noCollectionTriggered:true,allTestsVerified:true};
  await writeFile(join(ledger,'2026-10-02-phase82-runtime-handoff.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(result));
 });
}else throw Error('Select --first or --handoff');
