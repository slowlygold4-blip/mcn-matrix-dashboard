// Read-only final status, schedule, original receipt and code boundary evidence.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),hash=b=>createHash('sha256').update(b).digest('hex');
const read=async path=>{const r=await fetch('http://127.0.0.1:4188'+path,{signal:AbortSignal.timeout(20000)});assert.equal(r.status,200);return r.json();};
const [health,status,queue]=await Promise.all(['/api/health','/api/monitoring-status','/api/ingestion-reviews'].map(read));
assert.equal(health.status,'ready');assert.equal(health.runtimeAI,false);
assert.deepEqual(status.scheduler.slotTimes,['02:00','10:00','18:00']);assert.equal(status.scheduler.scheduleIntervalHours,8);
const sourceSha256=hash(await readFile(join(root,'data/source-poll/manifest.json')));
assert.equal(sourceSha256,'184f0c655a7fc200a6d2e5979d15e92d73af8ec58883edc4d0f1635193c4d1d5');
assert.equal(hash(await readFile(join(root,'data/ingestion-reviews/run-2384.json'))),'85d098b3d9e6829b8d20d6324e16653c3aff9516887c89f58b94ccc499087f67');
const processes=execFileSync('/bin/ps',['-ax','-o','pid=,ppid=,command='],{encoding:'utf8'}).split('\n');
const services=['server.mjs','scripts/source-poller.mjs --loop','scripts/public-replica-publisher.mjs'].map(suffix=>{
 const ending=join(root,suffix),matches=processes.filter(line=>line.trim().endsWith(ending));assert.equal(matches.length,1);
 const match=/^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(matches[0]);assert.equal(Number(match[2]),1);return{file:suffix,pid:Number(match[1]),ppid:1};});
assert.notEqual(services[0].pid,48392);assert.equal(services[1].pid,26001);assert.equal(services[2].pid,72426);
const publisher=JSON.parse(await readFile(join(root,'data/public-replica-publisher/lock.json')));
assert.equal(publisher.pid,72426);assert.equal(publisher.startedAt,'2026-10-01T21:25:10.054Z');
const pubState=JSON.parse(await readFile(join(root,'data/public-replica-publisher/state.json')));
const db=new DatabaseSync(join(root,'data/douyin-monitor.sqlite'),{readOnly:true});let counts;
try{db.exec('PRAGMA query_only=ON');counts=Object.fromEntries(['targets','snapshots','posts','post_metrics','works_observations'].map(table=>[table,db.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
 counts.maxRun=db.prepare('SELECT max(id) n FROM runs').get().n;}finally{db.close();}
const result={checkedAt:new Date().toISOString(),health,services,publisher:{pid:publisher.pid,startedAt:publisher.startedAt,instance:publisher.instance,
 status:pubState.status,activeAsOf:pubState.active?.asOf??null,publishedAsOf:pubState.publishedAsOf,syncStatus:pubState.sync?.status},
 businessDate:status.updateSla.businessDate,profile:status.updateSla.coreAccounts,works:status.updateSla.works,topics:status.updateSla.topics,
 scheduler:status.scheduler,source:{sha256:sourceSha256,status:status.sourcePoller.status,total:status.sourcePoller.sourceCount,
 checkedToday:status.sourcePoller.checkedTodayCount,successfulToday:status.sourcePoller.successfulTodayCount,blocked:status.sourcePoller.blockedCount,
 failed:status.sourcePoller.failedCount,stale:status.sourcePoller.staleCount},counts,
 reviewQueue:{pending:queue.totalPending,completed:queue.totalCompleted,missing:queue.queue.pendingCount,failed:queue.queue.failedCount},
 code:{helperSha256:hash(await readFile(join(root,'lib/browser-first-page-activation.mjs'))),ownerSha256:hash(await readFile(join(root,'scripts/douyin_browser_collector.mjs')))},
 original2384Unchanged:true,actualUIChanged:false,noManualCollection:true,noNewTimer:true,notAllRequirementsComplete:true};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase82-final-runtime.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({checkedAt:result.checkedAt,health,services,publisher:result.publisher,profile:result.profile.daily,works:result.works.daily.counts,
 topics:result.topics.daily,source:result.source,counts,queue:result.reviewQueue,nextWorksRetryAt:result.scheduler.worksOnlyRetry.nextEligibleAt}));
