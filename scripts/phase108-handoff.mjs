import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex'),read=async p=>JSON.parse(await readFile(join(root,p),'utf8'));
assert.ok(Date.now()<Date.parse('2026-10-02T08:22:06Z'));
const completion=await read('data/maintenance-journal/2026-10-02-phase108-product-completion.json');assert.equal(completion.count,29);assert.deepEqual(completion.fixedRunIds,Array.from({length:29},(_,i)=>2731+i));
for(const row of completion.evidenceChecks)assert.equal(sha(await readFile(join(root,row.reference))),row.sha256,row.reference);
for(const row of completion.originals)assert.equal(sha(await readFile(join(root,`data/ingestion-reviews/run-${row.runId}.json`))),row.sha256);
for(const row of completion.completions){const receipt=await read(`data/ingestion-reviews/reviewed-${row.runId}.json`);assert.equal(receipt.runId,row.runId);}
const prior=await read('data/maintenance-journal/2026-10-02-phase107-product-completion.json');for(const row of prior.evidenceChecks)assert.equal(sha(await readFile(join(root,row.reference))),row.sha256,row.reference);
const healthResponse=await fetch('http://127.0.0.1:4188/api/health',{signal:AbortSignal.timeout(10000)});assert.equal(healthResponse.status,200);const health=await healthResponse.json();assert.equal(health.status,'ready');assert.equal(health.runtimeAI,false);
const queueResponse=await fetch('http://127.0.0.1:4188/api/ingestion-reviews',{signal:AbortSignal.timeout(10000)});assert.equal(queueResponse.status,200);const queue=await queueResponse.json();assert.equal(queue.queue.failedCount,0);assert.equal(queue.queue.pendingCount,0);
const finishedAt=new Date().toISOString(),receipt={phase:108,startedAt:'2026-10-02T07:52:06Z',finishedAt,actualElapsedMinutes:(Date.parse(finishedAt)-Date.parse('2026-10-02T07:52:06Z'))/60000,health,completedReviewCount:29,nextFixedReviewRunId:2760,queue:{totalPending:queue.totalPending,totalCompleted:queue.totalCompleted,rulePending:queue.queue.pendingCount,ruleFailed:queue.queue.failedCount},publicVersion:42,publicURL:'https://mcn-matrix-observatory.slowlygold4.chatgpt.site',mainTests:4290,siteTests:48,evidenceBindingsUnchanged:true,previousPhase107BindingsUnchanged:true,noManualCollection:true,noServiceRestart:true,noNewTimer:true,status:'verified progress, not complete full goal',macOffNewSamplingImplemented:false,fullWorksCoverageAchieved:false,allNetworksGuaranteed:false};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase108-handoff.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o400});console.log(JSON.stringify(receipt));
