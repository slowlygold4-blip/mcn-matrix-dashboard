import assert from 'node:assert/strict';
import {readFile,writeFile,chmod,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {completePostIngestionProductReview} from '../lib/post-ingestion-review.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
assert.ok(Date.now()<Date.parse('2026-10-02T09:36:08Z'));
const result=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase111-main-tests-result.json')));assert.equal(result.pass,4299);assert.equal(result.fail,0);assert.equal(result.outcome.code,0);assert.equal(sha(await readFile(result.logPath)),result.sha256);
const archive=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase111-integrity-archive.json')));
const backupHash=createHash('sha256');for await(const bytes of createReadStream(archive.persistentBackup))backupHash.update(bytes);assert.equal(backupHash.digest('hex'),archive.backupSHA256);
const evidence=['data/maintenance-journal/2026-10-02-phase111.md','docs/phase111-product-review.md','data/maintenance-journal/2026-10-02-phase111-main-tests-result.json','data/maintenance-journal/2026-10-02-phase111-boundary-finish.json','docs/phase111-evidence/integrity/data-runtime-review.md','docs/phase111-evidence/runtime/review.md'].map(file=>join(root,file));
const refs=[];for(const file of evidence){assert.ok((await stat(file)).size>0);await chmod(file,0o400);refs.push({file,sha256:sha(await readFile(file))});}
const signed=JSON.parse(await readFile(join(root,'docs/phase111-evidence/integrity/signed-receipt.json'))),completions=[];
assert.deepEqual(signed.fixedRunIds,Array.from({length:20},(_,i)=>2787+i));
for(const original of signed.originals){const file=join(root,`data/ingestion-reviews/run-${original.runId}.json`);assert.equal(sha(await readFile(file)),original.sha256);const completion=await completePostIngestionProductReview({ledgerDir:join(root,'data/ingestion-reviews'),runId:original.runId,evidence,now:new Date()});assert.equal(completion.status,'created');assert.deepEqual(completion.completion.evidence,evidence);assert.equal(sha(await readFile(file)),original.sha256);completions.push({runId:original.runId,status:completion.status,file:completion.path,sha256:sha(await readFile(completion.path)),originalSHA256:original.sha256});}
for(const ref of refs)assert.equal(sha(await readFile(ref.file)),ref.sha256);
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase111-reviewed-bindings.json'),JSON.stringify({completedAt:new Date().toISOString(),fixedRunIds:signed.fixedRunIds,evidence:refs,completions,meaning:'Independent data and product review performed after full-suite and native acceptance; not all collection repaired or real-user retention measured'},null,2)+'\n',{flag:'wx',mode:0o400});
console.log(JSON.stringify({completedAt:new Date().toISOString(),created:completions.length,first:2787,last:2806,originalEventsUnchanged:true,evidenceBindings:refs.length,backupSHA256:archive.backupSHA256}));
