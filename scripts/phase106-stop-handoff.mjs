import {readFile,writeFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url)),startedAt='2026-10-02T07:01:11.000Z';
const sha=b=>createHash('sha256').update(b).digest('hex');
assert.ok(Date.now()<Date.parse('2026-10-02T07:31:11Z'));
const readJSON=async file=>JSON.parse(await readFile(join(root,file),'utf8'));
const final=await readJSON('data/maintenance-journal/2026-10-02-phase106-final-audit.json');
assert.equal(final.unchangedStaticFiles,667);assert.equal(final.sourceChanges.length,2);assert.equal(final.restore.integrity,'ok');
const completion=await readJSON('data/maintenance-journal/2026-10-02-phase106-product-completion.json');
assert.equal(completion.count,35);assert.equal(completion.originalEventsByteUnchanged,true);
const audit=await readJSON('docs/phase106-evidence/integrity/data-audit.json');
for(const proof of audit.proofs){
 assert.equal(sha(await readFile(join(root,'data/ingestion-reviews/run-'+proof.runId+'.json'))),proof.event.sha256);
 const done=await readJSON('data/ingestion-reviews/reviewed-'+proof.runId+'.json');assert.equal(done.runId,proof.runId);assert.equal(done.status,'completed');
 for(const evidence of done.evidence) assert.ok((await readFile(join(root,evidence))).length>0);
}
const tests=await readFile(join(root,'data/maintenance-journal/2026-10-02-phase106-main-full-tests.log'),'utf8');
for(const [key,value] of [['tests',4283],['pass',4283],['fail',0],['cancelled',0],['skipped',0]]) assert.match(tests,new RegExp('(?:#|ℹ) '+key+' '+value+'\\b'));
const sourceManifestSHA256=sha(await readFile(join(root,'data/source-poll/manifest.json')));
assert.equal(sourceManifestSHA256,'184f0c655a7fc200a6d2e5979d15e92d73af8ec58883edc4d0f1635193c4d1d5');
assert.equal(sha(await readFile(join(root,'scripts/douyin_browser_collector.mjs'))),'a97d4645c2102fa3f5d9dd1b5585745fb6d394f9a33fec37f8de00cfba8446b1');
const served=[];
for(const [url,file] of [['/','public/rebuild.html'],['/rebuild.js','public/rebuild.js'],['/rebuild.css','public/rebuild.css']]){
 const response=await fetch('http://127.0.0.1:4188'+url,{signal:AbortSignal.timeout(10000)});assert.equal(response.status,200);
 const bytes=Buffer.from(await response.arrayBuffer()),hash=sha(bytes);assert.equal(hash,sha(await readFile(join(root,file))));served.push({url,file,sha256:hash,status:200});
}
const get=async url=>{const at=new Date().toISOString(),response=await fetch('http://127.0.0.1:4188'+url,{signal:AbortSignal.timeout(20000)});assert.equal(response.status,200);return{at,status:response.status,value:await response.json()};};
const health=await get('/api/health');assert.equal(health.value.status,'ready');assert.equal(health.value.runtimeAI,false);
const monitoring=await get('/api/monitoring-status');
const scheduler=monitoring.value.scheduler;assert.equal(scheduler.scheduleIntervalHours,8);assert.deepEqual(scheduler.slotTimes,['02:00','10:00','18:00']);assert.equal(scheduler.timeZone,'Asia/Shanghai');
const reviewQueue=await get('/api/ingestion-reviews');
const insights=await get('/api/rebuild/insights?period=custom&theme=tuantuan&classification=slice&startDate=2026-09-26&endDate=2026-10-02');
const overviewReceipt={at:insights.at,status:insights.status,keys:Object.keys(insights.value),range:insights.value.range??null,summary:insights.value.summary??null,
  limitation:'One real read-only HTTP result; not visual interaction or all-account arithmetic acceptance'};
const pids=[90988,26001,79274],ps=execFileSync('/bin/ps',['-p',pids.join(','),'-o','pid=,ppid=,command='],{encoding:'utf8'});
for(const pid of pids)assert.match(ps,new RegExp('(?:^|\\n)\\s*'+pid+'\\s+1\\s+'));
const scopedProcesses=execFileSync('/bin/ps',['-axo','pid=,ppid=,command='],{encoding:'utf8'}).split('\n').filter(line=>['/tmp/phase106-works-unRUWr/','/tmp/phase106-integrity-WrHr5b/','/tmp/phase106-runtime-lPm8lo/'].some(path=>line.includes(path)));
assert.equal(scopedProcesses.length,0,'owned isolated phase runners must have exited');
const siteStatus=execFileSync('git',['status','--short'],{cwd:join(root,'../mcn-public-site'),encoding:'utf8'});assert.equal(siteStatus.trim(),'');
const archives=[];
for(const file of ['candidate-archive.json','integrity-archive.json','runtime-archive.json','addendum-archive.json','design-archive.json']){
 const bytes=await readFile(join(root,'docs/phase106-evidence',file));archives.push({file,sha256:sha(bytes)});
}
const installed=await readJSON('data/maintenance-journal/2026-10-02-phase106-install.json');
const independent=await readJSON('docs/phase106-evidence/runtime/post-install-independent-0713.json');
const finishedAt=new Date().toISOString();assert.ok(Date.parse(finishedAt)<Date.parse('2026-10-02T07:31:11Z'));
const receipt={startedAt,finishedAt,elapsedMinutes:(Date.parse(finishedAt)-Date.parse(startedAt))/60000,frozenNewProductDevelopment:true,
 installedAt:installed.installedAt,sourceManifestSHA256,served,health,scheduler:{running:scheduler.running,timeZone:scheduler.timeZone,slotTimes:scheduler.slotTimes,nextRunAt:scheduler.nextRunAt,lastTickAt:scheduler.lastTickAt},
 queue:{at:reviewQueue.at,status:reviewQueue.status,summary:reviewQueue.value.summary??null,keys:Object.keys(reviewQueue.value)},overviewReceipt,ps,ownedPrivateRunnersExited:true,archives,
 productReviewsAppended:35,originalEventsByteUnchanged:true,mainFullTests:{tests:4283,pass:4283,fail:0,cancelled:0,skipped:0},siteSourceClean:true,siteUIChangedThisRound:false,
 noManualCollection:true,noNewTimer:true,noRestart:true,completeGoal:false,macOffNewSamplingImplemented:false,
 newCollectorNaturalExecutionProven:independent.collectorChildren.some(row=>row.startedStrictlyAfterInstall),nextFixedReviewRunId:2711,
 nextProductIssue:'precise stock value and original reason must both be accessible in accountTable; retain keyboard/touch, zero/null, scope and export contracts'};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase106-stop.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o400});
console.log(JSON.stringify({finishedAt,elapsedMinutes:receipt.elapsedMinutes,reviews:35,tests:receipt.mainFullTests,ready:health.value.status,runtimeAI:health.value.runtimeAI,noRestart:true,ownedPrivateRunnersExited:true,newCollectorNaturalExecutionProven:receipt.newCollectorNaturalExecutionProven,completeGoal:false}));
