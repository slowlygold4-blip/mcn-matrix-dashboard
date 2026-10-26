import {readFile,writeFile,copyFile,chmod,constants} from 'node:fs/promises';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const from='/tmp/phase106-runtime-lPm8lo/post-install-root-final-0721.json',to=join(root,'docs/phase106-evidence/runtime/post-install-root-final-0721.json');
const bytes=await readFile(from),runtime=JSON.parse(bytes);
assert.equal(runtime.collectorSha256,'a97d4645c2102fa3f5d9dd1b5585745fb6d394f9a33fec37f8de00cfba8446b1');
assert.ok(runtime.collectorChildren.some(x=>x.pid===12606&&x.ppid===90988&&x.startedStrictlyAfterInstall));
assert.equal(runtime.database.changes.n,0);assert.equal(runtime.database.interrupted.n,0);
await copyFile(from,to,constants.COPYFILE_EXCL);await chmod(to,0o400);assert.equal(sha(await readFile(to)),sha(bytes));
const response=await fetch('http://127.0.0.1:4188/api/ingestion-reviews',{signal:AbortSignal.timeout(20000)});assert.equal(response.status,200);const queue=await response.json();
const stop=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase106-stop.json')));
assert.equal(stop.productReviewsAppended,35);assert.equal(stop.completeGoal,false);
const finishedAt=new Date().toISOString();assert.ok(Date.parse(finishedAt)<Date.parse('2026-10-02T07:31:11Z'));
const receipt={startedAt:'2026-10-02T07:01:11.000Z',finishedAt,elapsedMinutes:(Date.parse(finishedAt)-Date.parse('2026-10-02T07:01:11Z'))/60000,
 priorInitialStop:stop.finishedAt,preservedOriginalStop:true,verificationOnlyAfterInitialStop:true,
 runtimeEvidence:{file:to,bytes:bytes.length,sha256:sha(bytes),at:runtime.checkedAt},
 naturalProcessObserved:true,loadingContractInference:runtime.loadingEvidence,notCryptographicProcessAttestation:true,
 observedChild:runtime.collectorChildren[0],naturalTerminalRuns:runtime.database.newRuns.filter(x=>x.finished_at),
 runningRunNotReviewed:2730,noPrefetchCoverageBenefitClaim:true,noManualCollection:true,noRestart:true,noNewTimer:true,
 queue:{checkedAt:new Date().toISOString(),status:queue.status,totalPending:queue.totalPending,totalCompleted:queue.totalCompleted,ruleQueue:queue.queue},
 productReviewsAppended:35,nextFixedReviewRunId:2711,completeGoal:false,macOffNewSamplingImplemented:false};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase106-verification-closeout.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o400});
console.log(JSON.stringify({finishedAt,elapsedMinutes:receipt.elapsedMinutes,naturalProcessObserved:true,naturalTerminalRunIds:receipt.naturalTerminalRuns.map(x=>x.id),queue:receipt.queue,productReviewsAppended:35,noPrefetchCoverageBenefitClaim:true}));
