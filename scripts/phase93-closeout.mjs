import assert from 'node:assert/strict';
import {readFile,stat,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
const root=fileURLToPath(new URL('../',import.meta.url)),site=join(root,'../mcn-public-site');
const startedAt=new Date().toISOString(),prefix='data/maintenance-journal/2026-10-02-phase93-';
const sha=b=>createHash('sha256').update(b).digest('hex');
async function fileSha(path){const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');}
const backup=JSON.parse(await readFile(join(root,prefix+'backup.json')));
const code=[];for(const original of backup.code){const current=await fileSha(join(root,original.path));assert.equal(current,original.sha256);code.push({path:original.path,sha256:current,unchanged:true});}
assert.equal(await fileSha(backup.backupPath),backup.sha256);
assert.equal(await fileSha(backup.restoredPath),backup.sha256);
assert.equal((await stat(backup.restoredPath)).size,backup.bytes);
const restored=new DatabaseSync(backup.restoredPath,{readOnly:true});let restoreCheck;
try{restored.exec('PRAGMA query_only=ON;BEGIN');restoreCheck={quickCheck:restored.prepare('PRAGMA quick_check').get().quick_check,foreignKeyViolations:restored.prepare('PRAGMA foreign_key_check').all().length,changes:restored.prepare('SELECT total_changes() n').get().n};assert.equal(restoreCheck.quickCheck,'ok');assert.equal(restoreCheck.foreignKeyViolations,0);assert.equal(restoreCheck.changes,0);restored.exec('ROLLBACK');}finally{restored.close();}
const results={};for(const [name,n] of [['main',4032],['site',47]]){
 const path=join(root,prefix+name+'-full.log'),text=await readFile(path,'utf8');
 const summary=Object.fromEntries(['tests','pass','fail','cancelled','skipped'].map(key=>[key,Number(text.match(new RegExp('ℹ '+key+' (\\d+)'))?.[1])]));
 assert.equal(summary.tests,n);assert.equal(summary.pass,n);assert.equal(summary.fail+summary.cancelled+summary.skipped,0);results[name]={...summary,logSha256:sha(text)};
}
const sourceBytes=await readFile(join(root,'data/source-poll/manifest.json')),source=JSON.parse(sourceBytes);
const readback=JSON.parse(await readFile(join(root,prefix+'data-readback.json')));
assert.equal(sha(sourceBytes),readback.source.sha256);
const jobs=Object.entries(source.sources).map(([key,v])=>({key,jobId:v.lastJobId??null})).sort((a,b)=>a.key.localeCompare(b.key));
assert.equal(sha(JSON.stringify(jobs)),readback.source.jobIdProjectionSha256);
const publicAcceptance=JSON.parse(await readFile(join(root,prefix+'public-acceptance.json')));
assert.equal(publicAcceptance.status,'succeeded');assert.equal(publicAcceptance.version,39);
assert.equal(execFileSync('git',['status','--porcelain'],{cwd:site,encoding:'utf8'}).trim(),'');
assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:site,encoding:'utf8'}).trim(),publicAcceptance.commitSha);
const review=JSON.parse(await readFile(join(root,prefix+'reviewed-events-handoff.json')));
assert.equal(review.results.length,25);
const peerBytes=await readFile(join(root,prefix+'final-integrity-peer.json'));assert.equal(sha(peerBytes),'86bb820d25013a571de977b106b6b51861b0b2892fe3799e1560a792dd082b8d');
const peer=JSON.parse(peerBytes);assert.equal(peer.result,'pass');
const health=await (await fetch('http://127.0.0.1:4188/api/health',{signal:AbortSignal.timeout(8000)})).json();assert.equal(health.runtimeAI,false);assert.equal(health.status,'ready');
const status=await(await fetch('http://127.0.0.1:4188/api/monitoring-status',{signal:AbortSignal.timeout(8000)})).json();
assert.equal(status.scheduler.scheduleIntervalHours,8);assert.deepEqual(status.scheduler.slotTimes,['02:00','10:00','18:00']);
const services=[22870,26001,92296].map(pid=>execFileSync('ps',['-p',String(pid),'-o','pid=,ppid=,comm='],{encoding:'utf8'}).trim());
const db=new DatabaseSync(join(root,'data/douyin-monitor.sqlite'),{readOnly:true});let database;
try{db.exec('PRAGMA query_only=ON;BEGIN');database={counts:Object.fromEntries(['snapshots','posts','post_metrics','works_observations'].map(table=>[table,db.prepare('SELECT COUNT(*) n FROM '+table).get().n])),latestRun:db.prepare('SELECT id,trigger_type,status,started_at,finished_at FROM runs ORDER BY id DESC LIMIT 1').get(),activeRunCount:db.prepare("SELECT COUNT(*) n FROM runs WHERE status='running'").get().n,settings:db.prepare("SELECT key,value,updated_at FROM settings WHERE key='publicPostsPerAccount' OR key LIKE 'publicWorks%' ORDER BY key").all(),totalChanges:db.prepare('SELECT total_changes() n').get().n};assert.equal(database.totalChanges,0);assert.ok(database.activeRunCount<=1);db.exec('ROLLBACK');}finally{db.close();}
const finishedAt=new Date().toISOString();
const outcome={phase:93,startedAt,finishedAt,elapsedSincePhaseStartMinutes:(Date.parse(finishedAt)-Date.parse('2026-10-02T01:41:03Z'))/60000,health,services,scheduler:status.scheduler,coverage:status.updateSla,source:{sha256:sha(sourceBytes),jobIdProjectionSha256:sha(JSON.stringify(jobs)),lastFinishedAt:source.lastFinishedAt,sourceCount:Object.keys(source.sources).length,checkedTodayCount:status.sourcePoller.checkedTodayCount,blockedCount:status.sourcePoller.blockedCount,staleCount:status.sourcePoller.staleCount,businessPendingCount:status.sourcePoller.businessPendingCount},database,backup:{sha256:backup.sha256,bytes:backup.bytes,cutoff:backup.cutoff,restoreCheck,containsFixedAuditedBatch:true,doesNotContainLaterRuns:true},tests:results,productionCode:code,worksCandidatePromoted:false,candidateRemainingBlocker:'701-account strict graph reader still blocks synchronously for 1862.218ms at max depth13; no full depth24 pass',publicAcceptance,reviewedRunIds:review.results.map(x=>x.runId),nextStrictAuditFromRunId:2556,finalIntegrityPeerSha256:sha(peerBytes),publicKeyboardEvidenceCorrection:'Enter idempotency tested on page1; page2 repeat tested by mouse. Local candidate separately tested page2 Enter/Space. Public390 Space has screenshot only, not separate post-key DOM assertion.',temporaryBrowserClosed:true,noNewAiSchedules:true,noManualCollection:true,fullGoalComplete:false};
await writeFile(join(root,prefix+'closeout.json'),JSON.stringify(outcome,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({finishedAt,elapsedMinutes:outcome.elapsedSincePhaseStartMinutes,mainPass:results.main.pass,sitePass:results.site.pass,version:39,worksCandidatePromoted:false,nextStrictAuditFromRunId:2556,activeRunCount:database.activeRunCount,fullGoalComplete:false}));
