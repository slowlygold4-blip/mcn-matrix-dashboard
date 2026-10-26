import assert from 'node:assert/strict';
import {readFile,writeFile,chmod,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {completePostIngestionProductReview} from '../lib/post-ingestion-review.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex'),deadline=Date.parse('2026-10-02T11:14:14Z');assert.ok(Date.now()<deadline);
const tests=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase115-main-tests-result.json')));
assert.equal(tests.outcome.code,0);assert.equal(tests.pass,tests.tests);assert.equal(tests.tests,4307);for(const k of ['fail','cancelled','skipped'])assert.equal(tests[k],0);assert.equal(sha(await readFile(tests.logPath)),tests.sha256);
const boundary=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase115-boundary-finish.json')));assert.ok(Date.parse(boundary.checkedAt)>Date.parse(tests.finishedAt));assert.equal(boundary.mainProductChanges.length,0);assert.equal(boundary.health.status,'ready');
const evidence=[
  'data/maintenance-journal/2026-10-02-phase115.md',
  'docs/phase115-product-review.md',
  'data/maintenance-journal/2026-10-02-phase115-boundary-finish.json',
  'data/maintenance-journal/2026-10-02-phase115-main-tests-result.json',
  'data/maintenance-journal/2026-10-02-phase115-main-full-tests.log',
  'data/maintenance-journal/2026-10-02-phase115-root-natural-proof.json',
  'data/maintenance-journal/2026-10-02-phase115-settings-promoted.json',
  'docs/phase115-evidence/integrity/independent-closeout.md',
  'docs/phase115-evidence/integrity/independent-closeout.json',
  'docs/phase115-evidence/integrity/signed-receipt.json',
  'docs/phase115-evidence/settings/settings-review.md',
  'docs/phase115-evidence/settings/settings-signed-receipt.json',
  'docs/phase115-evidence/collector/collector-review.md',
  'docs/phase115-evidence/assets/review.md',
  'docs/phase115-evidence/runtime/review.md',
  'docs/phase114-native-acceptance.md',
  'data/maintenance-journal/2026-10-02-phase114-site-published.json',
  'data/maintenance-journal/2026-10-02-phase114-root-integrity.json',
  'docs/phase114-evidence/integrity/data-review.md',
  'docs/phase114-evidence/runtime/independent-review.md'
].map(file=>join(root,file));
assert.equal(evidence.length,20);const refs=[];
for(const file of evidence){assert.ok((await stat(file)).size>0);assert.ok(file.length<=500);await chmod(file,0o400);refs.push({file,sha256:sha(await readFile(file))});}
const signed=JSON.parse(await readFile(join(root,'docs/phase114-evidence/integrity/signed-receipt.json')));assert.deepEqual(signed.fixedRunIds,Array.from({length:20},(_,i)=>2827+i));
for(const original of signed.originals)assert.equal(sha(await readFile(join(root,`data/ingestion-reviews/run-${original.runId}.json`))),original.sha256);
const completions=[];
for(const original of signed.originals){
  assert.ok(Date.now()<deadline);
  const completion=await completePostIngestionProductReview({ledgerDir:join(root,'data/ingestion-reviews'),runId:original.runId,evidence,now:new Date()});
  assert.equal(completion.status,'created');assert.deepEqual(completion.completion.evidence,evidence);
  assert.equal(sha(await readFile(join(root,`data/ingestion-reviews/run-${original.runId}.json`))),original.sha256);
  completions.push({runId:original.runId,file:completion.path,sha256:sha(await readFile(completion.path)),originalSHA256:original.sha256});
}
for(const ref of refs)assert.equal(sha(await readFile(ref.file)),ref.sha256);
const result={completedAt:new Date().toISOString(),fixedRunIds:signed.fixedRunIds,evidence:refs,completions,originalsUnchanged:true,phase114ExpiredScriptsExecuted:false,meaning:'Fresh Phase115 independent verification and Root bounded data/product review; not all collection repaired or real-user retention measured; next fixed audit2847'};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase115-reviewed-bindings.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o400});console.log(JSON.stringify({completedAt:result.completedAt,reviewed:completions.length,next:2847,originalsUnchanged:true}));
