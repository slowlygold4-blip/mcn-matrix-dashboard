import assert from 'node:assert/strict';
import {readFile,writeFile,chmod,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {completePostIngestionProductReview} from '../lib/post-ingestion-review.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const deadline=Date.parse('2026-10-02T10:14:32Z');
assert.ok(Date.now()<deadline,'Phase113 hard stop reached');
const result=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase113-main-tests-result.json')));
assert.equal(result.tests,4307);assert.equal(result.pass,4307);
for(const key of ['fail','cancelled','skipped'])assert.equal(result[key],0);
assert.equal(result.outcome.code,0);assert.equal(result.outcome.signal,null);
assert.equal(sha(await readFile(result.logPath)),result.sha256);
for(const [file,hash] of Object.entries(result.approvedSources))assert.equal(sha(await readFile(join(root,file))),hash);
const archive=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase113-integrity-archive.json')));
const restoredHash=createHash('sha256');
for await(const bytes of createReadStream(archive.restored))restoredHash.update(bytes);
assert.equal(restoredHash.digest('hex'),archive.backupSHA256);
const evidence=[
  'data/maintenance-journal/2026-10-02-phase113.md',
  'docs/phase113-product-review.md',
  'data/maintenance-journal/2026-10-02-phase113-main-tests-result.json',
  'data/maintenance-journal/2026-10-02-phase113-boundary-finish.json',
  'docs/phase113-evidence/integrity/data-review.md',
  'docs/phase113-evidence/runtime/independent-review.md',
  'docs/phase113-native-acceptance.md',
].map(file=>join(root,file));
const refs=[];
for(const file of evidence){assert.ok((await stat(file)).size>0);await chmod(file,0o400);refs.push({file,sha256:sha(await readFile(file))});}
const signed=JSON.parse(await readFile(join(root,'docs/phase113-evidence/integrity/signed-receipt.json')));
const fixed=Array.from({length:20},(_,i)=>2807+i);
assert.deepEqual(signed.fixedRunIds,fixed);
assert.deepEqual(signed.originals.map(original=>original.runId),fixed);
// Preflight every fixed original before appending any independent completion.
for(const original of signed.originals)assert.equal(sha(await readFile(join(root,`data/ingestion-reviews/run-${original.runId}.json`))),original.sha256);
const completions=[];
for(const original of signed.originals){
  assert.ok(Date.now()<deadline,'Phase113 hard stop reached');
  const file=join(root,`data/ingestion-reviews/run-${original.runId}.json`);
  const completion=await completePostIngestionProductReview({ledgerDir:join(root,'data/ingestion-reviews'),runId:original.runId,evidence,now:new Date()});
  assert.equal(completion.status,'created');assert.deepEqual(completion.completion.evidence,evidence);
  assert.equal(sha(await readFile(file)),original.sha256);
  completions.push({runId:original.runId,status:completion.status,file:completion.path,sha256:sha(await readFile(completion.path)),originalSHA256:original.sha256});
}
for(const ref of refs)assert.equal(sha(await readFile(ref.file)),ref.sha256);
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase113-reviewed-bindings.json'),JSON.stringify({completedAt:new Date().toISOString(),fixedRunIds:fixed,evidence:refs,completions,meaning:'Independent data and product review performed after full-suite and native acceptance; not all collection repaired or real-user retention measured'},null,2)+'\n',{flag:'wx',mode:0o400});
console.log(JSON.stringify({completedAt:new Date().toISOString(),created:completions.length,first:2807,last:2826,originalEventsUnchanged:true,evidenceBindings:refs.length,restoredSnapshotSHA256:archive.backupSHA256}));
