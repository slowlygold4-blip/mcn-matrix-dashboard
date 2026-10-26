// Fixed-projection read-only runtime check; never initiates sampling or deployment.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const label=process.argv[2];assert.ok(['initial','final'].includes(label));
const root=fileURLToPath(new URL('../',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const read=async path=>{const r=await fetch('http://127.0.0.1:4188'+path,{signal:AbortSignal.timeout(20000)});assert.equal(r.status,200);return r.json();};
const [health,status,queue]=await Promise.all(['/api/health','/api/monitoring-status','/api/ingestion-reviews'].map(read));
assert.equal(health.status,'ready');assert.equal(health.runtimeAI,false);
assert.deepEqual(status.scheduler.slotTimes,['02:00','10:00','18:00']);assert.equal(status.scheduler.scheduleIntervalHours,8);
const sourceBytes=await readFile(join(root,'data/source-poll/manifest.json')),source=JSON.parse(sourceBytes);
const ps=execFileSync('/bin/ps',['-ax','-o','pid=,ppid=,command='],{encoding:'utf8'}).split('\n');
const services=['server.mjs','scripts/source-poller.mjs --loop','scripts/public-replica-publisher.mjs'].map(suffix=>{
  const lines=ps.filter(line=>line.trim().endsWith(join(root,suffix)));assert.equal(lines.length,1);
  const m=/^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(lines[0]);assert.equal(Number(m[2]),1);return{file:suffix,pid:Number(m[1]),ppid:1};
});
const publisherLock=JSON.parse(await readFile(join(root,'data/public-replica-publisher/lock.json')));
const publisherState=JSON.parse(await readFile(join(root,'data/public-replica-publisher/state.json')));
const db=new DatabaseSync(join(root,'data/douyin-monitor.sqlite'),{readOnly:true});let counts,runs;
try{
  db.exec('PRAGMA query_only=ON; BEGIN');
  counts=Object.fromEntries(['targets','snapshots','posts','post_metrics','works_observations'].map(t=>[t,db.prepare(`SELECT count(*) n FROM ${t}`).get().n]));
  counts.maxRun=db.prepare('SELECT max(id) n FROM runs').get().n;
  counts.activeRuns=db.prepare("SELECT count(*) n FROM runs WHERE finished_at IS NULL").get().n;
  runs=db.prepare('SELECT id,trigger_type,status,started_at,finished_at FROM runs WHERE id>=2385 ORDER BY id').all();
  assert.equal(db.prepare('SELECT total_changes() n').get().n,0);db.exec('COMMIT');
}finally{db.close();}
const result={checkedAt:new Date().toISOString(),health,services,publisher:{pid:publisherLock.pid,startedAt:publisherLock.startedAt,instance:publisherLock.instance,
  status:publisherState.status,activeAsOf:publisherState.active?.asOf??null,publishedAsOf:publisherState.publishedAsOf,syncStatus:publisherState.sync?.status},
  profile:status.updateSla.coreAccounts.daily,works:status.updateSla.works.daily.counts,topics:status.updateSla.topics.daily,
  scheduler:status.scheduler,source:{sha256:sha(sourceBytes),lastFinishedAt:source.lastFinishedAt,
    status:status.sourcePoller.status,total:status.sourcePoller.sourceCount,checkedToday:status.sourcePoller.checkedTodayCount,
    successfulToday:status.sourcePoller.successfulTodayCount,blocked:status.sourcePoller.blockedCount,failed:status.sourcePoller.failedCount,stale:status.sourcePoller.staleCount},
  counts,runs,reviewQueue:{pending:queue.totalPending,completed:queue.totalCompleted,missing:queue.queue.pendingCount,failed:queue.queue.failedCount},
  code:{ownerSha256:sha(await readFile(join(root,'scripts/douyin_browser_collector.mjs'))),helperSha256:sha(await readFile(join(root,'lib/browser-first-page-activation.mjs')))},
  noManualCollection:true,noNewTimer:true,noDeployment:true,notAllRequirementsComplete:true};
await writeFile(join(root,`data/maintenance-journal/2026-10-02-phase83-runtime-${label}.json`),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({checkedAt:result.checkedAt,health,services,publisher:result.publisher,profile:result.profile,works:result.works,
  topics:result.topics,source:result.source,counts,queue:result.reviewQueue,runs,nextWorksRetryAt:status.scheduler.worksOnlyRetry.nextEligibleAt}));
