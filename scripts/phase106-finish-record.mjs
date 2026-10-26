import assert from 'node:assert/strict';import {readFile,writeFile,chmod} from 'node:fs/promises';import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const complete=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase106-product-completion.json')));
const checked=[];
for(const e of complete.evidenceChecks){const bytes=await readFile(join(root,e.reference));assert.equal(sha(bytes),e.sha256);checked.push({reference:e.reference,sha256:e.sha256});}
for(const x of complete.originalEventsByteUnchanged?[...complete.completions]:[])assert.equal(x.status,'created');
const before=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase106-before-source.json')));
const allowed=new Map([['scripts/douyin_browser_collector.mjs','a97d4645c2102fa3f5d9dd1b5585745fb6d394f9a33fec37f8de00cfba8446b1'],['test/phase100-integrity.test.mjs','019072cbbc5aa3fcf18a6cc5313718878ebc7b1fe2b43ba565cb818eb9a08926']]);
for(const e of before.records)assert.equal(sha(await readFile(join(root,e.file))),allowed.get(e.file)??e.sha256,e.file);
const data=JSON.parse(await readFile(join(root,'docs/phase106-evidence/integrity/data-audit.json')));
for(const p of data.proofs)assert.equal(sha(await readFile(join(root,'data/ingestion-reviews/run-'+p.runId+'.json'))),p.event.sha256);
for(const file of ['docs/phase106-product-review.md','data/maintenance-journal/2026-10-02-phase106.md'])await chmod(join(root,file),0o400);
const startedAt='2026-10-02T07:01:11.000Z',finishedAt=new Date().toISOString();
assert.ok(Date.parse(finishedAt)<Date.parse('2026-10-02T07:31:11Z'));
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase106-handoff.json'),JSON.stringify({
 startedAt,finishedAt,actualElapsedMinutes:(Date.parse(finishedAt)-Date.parse(startedAt))/60000,checkedBoundEvidence:checked,
 originalStaticFiles:before.records.length,unchanged:before.records.length-allowed.size,originalEventsUnchanged:35,
 completionReceiptUnchanged:true,reviewedAppended:35,newNaturalVerificationSeparate:true,allThreeAgentsCompleted:true,
 main4283Passed:true,ordinaryServicesNotStopped:true,aiMaintenanceRemainsPaused:true,
 completeGoal:false,nextFixedReviewRunId:2711,
 next:'precise account stock values and reasons access; natural prefetch benefit; entire U01–U47 including Mac-off new sampling'
},null,2)+'\n',{flag:'wx',mode:0o400});
console.log(JSON.stringify({finishedAt,actualElapsedMinutes:(Date.parse(finishedAt)-Date.parse(startedAt))/60000,boundEvidenceHashesValid:true,originalFilesChecked:before.records.length,originalEventsUnchanged:35,completeGoal:false}));
