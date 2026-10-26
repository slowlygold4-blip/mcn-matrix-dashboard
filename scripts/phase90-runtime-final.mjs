import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const get=async path=>{const r=await fetch('http://127.0.0.1:4188'+path,{signal:AbortSignal.timeout(60_000)});assert.equal(r.status,200);return r.json();};
const [health,monitor]=await Promise.all([get('/healthz'),get('/api/monitoring-status')]);
assert.equal(health.ok,true);const scheduler=monitor.scheduler;
assert.deepEqual(scheduler.slotTimes,['02:00','10:00','18:00']);assert.equal(scheduler.scheduleIntervalHours,8);assert.equal(scheduler.lastError,null);
assert.ok(Date.now()-Date.parse(scheduler.lastSuccessfulTickAt)<120_000); // Idle between ticks is healthy.
const services=[['Main',81452],['source',26001],['publisher',92296]].map(([name,pid])=>{
 const output=execFileSync('ps',['-p',String(pid),'-o','pid=,ppid=,args='],{encoding:'utf8'}).trim();
 const numbers=output.split(/\s+/);assert.equal(Number(numbers[0]),pid);assert.equal(Number(numbers[1]),1);
 return {name,pid,ppid:1,present:true};
});
const sourceBytes=await readFile('data/source-poll/manifest.json'),source=JSON.parse(sourceBytes),sourceSha=sha(sourceBytes);
assert.equal(sourceSha,'184f0c655a7fc200a6d2e5979d15e92d73af8ec58883edc4d0f1635193c4d1d5');
const ids=Object.entries(source.sources).map(([key,value])=>({key,jobId:value.lastJobId??null})).sort((a,b)=>a.key.localeCompare(b.key));
const jobSha=sha(JSON.stringify(ids));assert.equal(jobSha,'aa555691924a6dc7651c3a426e740dff8edeb1501c6962bdf0ec05d94a10738d');
const prior=JSON.parse(await readFile('data/maintenance-journal/2026-10-02-phase89-backup.json'));
const backupBytes=await readFile(prior.backupPath);assert.equal(sha(backupBytes),prior.sha256);
const db=new DatabaseSync(prior.restoredPath,{readOnly:true});let backup;
try{assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
 backup={bytes:backupBytes.length,sha256:prior.sha256,unchanged:true,restoredReadOnly:true,quickCheck:'ok',foreignKeyViolations:0,maxTerminalRunId:db.prepare("SELECT max(id) n FROM runs WHERE finished_at IS NOT NULL AND status <> 'running'").get().n,batchEntirelyIncluded:false};
}finally{db.close();}
const bootstrap=await get('/api/bootstrap');assert.equal(bootstrap.runtimeAI,false);
const queue=await get('/api/ingestion-reviews');
const result={checkedAt:new Date().toISOString(),serviceReady:true,runtimeAI:false,services,slotTimes:scheduler.slotTimes,scheduleIntervalHours:8,lastSuccessfulTickAt:scheduler.lastSuccessfulTickAt,lastError:null,currentNaturalRunId:scheduler.currentRun?.runId??null,sourceManifestUnchanged:true,sourceJobIdsUnchanged:true,sourceManifestSha256:sourceSha,sourceJobIdsSha256:jobSha,lastSourceFinishedAt:source.lastFinishedAt,sourceCount:ids.length,sourceSummary:{checkedToday:monitor.sourcePoller.checkedTodayCount,failed:monitor.sourcePoller.failedCount,blocked:monitor.sourcePoller.blockedCount,stale:monitor.sourcePoller.staleCount},coverage:monitor.updateSla,queue:{pending:queue.totalPending,completed:queue.totalCompleted},backup,collectorProductionUnchanged:true,noManualCollection:true,noServiceRestart:true,noNewAISchedule:true,noMacOffSamplingClaim:true};
await writeFile('data/maintenance-journal/2026-10-02-phase90-runtime-final.json',JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({checkedAt:result.checkedAt,serviceReady:true,runtimeAI:false,sourceSummary:result.sourceSummary,backup:result.backup,queue:result.queue}));
