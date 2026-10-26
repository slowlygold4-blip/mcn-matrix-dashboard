import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {completePostIngestionProductReview} from '../lib/post-ingestion-review.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=x=>createHash('sha256').update(x).digest('hex');
const read=path=>readFile(join(root,path)),json=async path=>JSON.parse(await read(path));
const manifest=await json('docs/phase100-candidate-manifest.json');
for(const x of manifest.files)assert.equal(sha(await read(x.file)),x.candidate,x.file);
for(const x of manifest.preserved)assert.equal(sha(await read(x.file)),x.sha256,x.file);
const full=String(await read('data/maintenance-journal/2026-10-02-phase100-main-full.log'));
assert.match(full,/ℹ tests 4235\b/);assert.match(full,/ℹ pass 4235\b/);
for(const x of ['fail','cancelled','skipped'])assert.match(full,new RegExp('ℹ '+x+' 0\\b'));
const runtime=await json('data/maintenance-journal/phase100-runtime-after-root-handoff.json');assert.equal(runtime.allChecksPassed,true);assert.ok(Object.values(runtime.checks).every(x=>x===true));
const auditPath='data/maintenance-journal/phase100-integrity-terminal-2579-2587.json',audit=await json(auditPath);
assert.equal(sha(await read(auditPath)),'b656328b5dec7dca77a305b08370b3dd07456da460e80d102b5d69aa2e695b79');
assert.deepEqual(audit.fixedRunIds,[2579,2580,2581,2582,2583,2584,2585,2586,2587]);
assert.equal(audit.queryOnly,1);assert.equal(audit.changesBefore+audit.changesAfter,0);assert.equal(audit.originalEventsByteUnchanged,true);
for(const proof of audit.proofs){assert.equal(proof.independentExactEventRebuild,true);assert.equal(proof.originalEventFieldCount,21);assert.equal(sha(await read(`data/ingestion-reviews/run-${proof.runId}.json`)),proof.originalEventSHA256);}
const evidence=[
 'data/maintenance-journal/2026-10-02-phase100.md',
 'docs/phase100-product-review.md','docs/phase100-candidate-review.md','docs/phase100-integrity-signed.md','docs/phase100-runtime-review.md','docs/phase100-integrity-terminal-2579-2587.md',
 auditPath,'data/maintenance-journal/2026-10-02-phase100-main-full.log','data/maintenance-journal/2026-10-02-phase100-exact-archive.log',
 'data/maintenance-journal/2026-10-02-phase100-backup.json','data/maintenance-journal/phase100-runtime-after-root-handoff.json',
 'data/maintenance-journal/2026-10-02-phase100-http-readback.json','data/maintenance-journal/2026-10-02-phase100-public-readback.json',
];
const evidenceSha256={};for(const path of evidence)evidenceSha256[path]=sha(await read(path));
const sourceSha='184f0c655a7fc200a6d2e5979d15e92d73af8ec58883edc4d0f1635193c4d1d5';assert.equal(sha(await read('data/source-poll/manifest.json')),sourceSha);
const site=join(root,'../mcn-public-site');assert.equal(execFileSync('git',['status','--short'],{cwd:site,encoding:'utf8'}).trim(),'');assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:site,encoding:'utf8'}).trim(),'f8589092b3f2a947bede2a48d64ddabc709fb2f6');
const healthResponse=await fetch('http://127.0.0.1:4188/api/health',{signal:AbortSignal.timeout(8000)});assert.equal(healthResponse.status,200);const health=await healthResponse.json();assert.equal(health.status,'ready');assert.equal(health.runtimeAI,false);
const pids=[79596,26001,79274];for(const pid of pids)process.kill(pid,0);
for(const port of [4336,4337]){try{await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(1000)});assert.fail('preview still live');}catch(error){assert.equal(error.cause?.code,'ECONNREFUSED');}}
assert.ok(Date.now()<Date.parse('2026-10-02T05:16:16Z'));
const completions=[];for(const proof of audit.proofs){const completed=await completePostIngestionProductReview({ledgerDir:join(root,'data/ingestion-reviews'),runId:proof.runId,evidence});assert.equal(sha(await read(`data/ingestion-reviews/run-${proof.runId}.json`)),proof.originalEventSHA256);completions.push({runId:proof.runId,status:completed.status,sha256:sha(await readFile(completed.path)),meaning:completed.completion.meaning});}
for(const [path,expected] of Object.entries(evidenceSha256))assert.equal(sha(await read(path)),expected,path);
const finishedAt=new Date().toISOString(),startedAt='2026-10-02T04:46:16Z',backup=await json('data/maintenance-journal/2026-10-02-phase100-backup.json'),http=await json('data/maintenance-journal/2026-10-02-phase100-http-readback.json');
const receipt={phase:100,startedAt,finishedAt,elapsedMinutes:(Date.parse(finishedAt)-Date.parse(startedAt))/60000,fullGoal:'U01-U47 remains active',classification:'progress',installed:{sourceFiles:13,candidateTestFiles:5,additionalIndependentPermanentTests:14,exactInstalledItems:18,preservedFiles:manifest.preserved.length},tests:{main:4235,mainFailed:0,mainSkipped:0,archive:60,archiveFailed:0,archiveSkipped:0},runtime:{pids,health:'ready',runtimeAI:false,slotsBeijing:['02:00','10:00','18:00'],noNewInterruptedAtIndependentReadback:true,mainSignalAt:'2026-10-02T05:02:56.300Z',publisherSignalAt:'2026-10-02T05:00:04.561Z',atomicDrain:false,newTimer:false,manualCollection:false},backup:{path:backup.backupPath,bytes:backup.bytes,sha256:backup.sha256,restoredReadable:backup.restoredCountsMatch,cutoff:backup.cutoff},fixedReviewedRunIds:audit.fixedRunIds,completions,nextUnauditedBoundary:2588,sourceSha256:sourceSha,evidenceSha256,publicReadback:await json('data/maintenance-journal/2026-10-02-phase100-public-readback.json'),httpReadback:http,privatePreviewsClosed:[4336,4337],allOwnedTestSessionsExited:true,remaining:['Real next scheduled profile-first throughput unverified','All works incomplete','Bootstrap observed11092ms needs optimization','No Mac-off new sampling proof','No all-network guarantee','No real-user retention or VoiceOver study']};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase100-final-handoff.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({finishedAt,elapsedMinutes:receipt.elapsedMinutes,reviewedRunIds:receipt.fixedReviewedRunIds,completionStatuses:completions.map(x=>x.status),tests:receipt.tests,runtime:receipt.runtime,classification:receipt.classification,fullGoal:receipt.fullGoal}));
