import assert from 'node:assert/strict';
import {readFile,writeFile,chmod,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {completePostIngestionProductReview} from '../lib/post-ingestion-review.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const deadline=Date.parse('2026-10-02T11:36:55Z');assert.ok(Date.now()<deadline);
const boundary=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase116-boundary-finish.json')));
assert.equal(boundary.health.status,'ready');assert.equal(boundary.tests.pass,4307);assert.equal(boundary.siteChecks[0].pass,62);assert.equal(boundary.sitePublicVersion,44);
assert.equal(boundary.publicProbePassed,false);assert.equal(boundary.goalComplete,false);assert.equal(boundary.mainProductChanges.length,0);
const evidence=[
 'data/maintenance-journal/2026-10-02-phase116.md',
 'docs/phase116-product-review.md',
 'docs/phase116-native-acceptance.md',
 'data/maintenance-journal/2026-10-02-phase116-boundary-finish.json',
 'data/maintenance-journal/2026-10-02-phase116-main-tests-result.json',
 'data/maintenance-journal/2026-10-02-phase116-main-full-tests.log',
 'data/maintenance-journal/2026-10-02-phase116-site-checks.json',
 'data/maintenance-journal/2026-10-02-phase116-site-built.json',
 'data/maintenance-journal/2026-10-02-phase116-site-promotion.json',
 'data/maintenance-journal/2026-10-02-phase116-site-published.json',
 'data/maintenance-journal/2026-10-02-phase116-public-proof.json',
 'data/maintenance-journal/2026-10-02-phase116-native-proof.json',
 'data/maintenance-journal/2026-10-02-phase116-evidence-archive.json',
 'docs/phase116-evidence/integrity/review.md',
 'docs/phase116-evidence/integrity/data-audit.json',
 'docs/phase116-evidence/integrity/current-state.json',
 'docs/phase116-evidence/integrity/signed-receipt.json',
 'docs/phase116-evidence/assets/review.md',
 'docs/phase116-evidence/assets/evidence-seal.json',
 'docs/phase116-evidence/runtime/independent-seal.json'
].map(f=>join(root,f));assert.equal(evidence.length,20);
const refs=[];for(const file of evidence){assert.ok((await stat(file)).size>0);assert.ok(file.length<=500);await chmod(file,0o400);refs.push({file,sha256:sha(await readFile(file))});}
const signed=JSON.parse(await readFile(join(root,'docs/phase116-evidence/integrity/signed-receipt.json')));assert.deepEqual(signed.fixedRunIds,Array.from({length:20},(_,i)=>2847+i));
for(const row of signed.originals)assert.equal(sha(await readFile(row.path)),row.sha256);
const completions=[];for(const row of signed.originals){assert.ok(Date.now()<deadline);
 const result=await completePostIngestionProductReview({ledgerDir:join(root,'data/ingestion-reviews'),runId:row.runId,evidence,now:new Date()});
 assert.equal(result.status,'created');assert.deepEqual(result.completion.evidence,evidence);assert.equal(sha(await readFile(row.path)),row.sha256);
 completions.push({runId:row.runId,file:result.path,sha256:sha(await readFile(result.path)),originalSHA256:row.sha256});}
for(const ref of refs)assert.equal(sha(await readFile(ref.file)),ref.sha256);
const result={completedAt:new Date().toISOString(),fixedRunIds:signed.fixedRunIds,evidence:refs,completions,originalsUnchanged:true,nextFixedRunId:2867,publicAnonymousHTTPProbePassed:false,meaning:'Actual bounded code/product review complete. Known403, incomplete works and Mac-off acquisition remain unresolved; not full-goal achievement or real-user retention.'};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase116-reviewed-bindings.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o400});console.log(JSON.stringify({completedAt:result.completedAt,reviewed:20,originalsUnchanged:true,nextFixedRunId:2867,goalComplete:false}));
