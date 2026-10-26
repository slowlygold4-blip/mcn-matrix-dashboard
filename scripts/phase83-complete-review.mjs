// Review the actually inspected ordinary run, never rewrite its rule event.
import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {completePostIngestionProductReview} from '../lib/post-ingestion-review.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),ledger=join(root,'data/ingestion-reviews'),sha=b=>createHash('sha256').update(b).digest('hex');
const proof=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase83-natural-runs.json')));
assert.deepEqual(proof.proofs.map(x=>x.runId),[2386]);
const evidence=['data/maintenance-journal/2026-10-02-phase83.md','data/maintenance-journal/2026-10-02-phase83-main-final.txt',
  'data/maintenance-journal/2026-10-02-phase83-related-final.txt','data/maintenance-journal/2026-10-02-phase83-legacy-contract-final.txt',
  'data/maintenance-journal/2026-10-02-phase83-natural-runs.json','data/maintenance-journal/2026-10-02-phase83-callchain-final.json',
  'data/maintenance-journal/2026-10-02-phase83-source-reuse-evidence.json','data/maintenance-journal/2026-10-02-phase83-cloud-publish-contract.json',
  'data/maintenance-journal/2026-10-02-phase83-site-contract.json','docs/phase83-collector-callchain-peer.md',
  'docs/phase83-source-reuse-peer.md','docs/phase83-cloud-publish-contract-peer.md'];
for(const path of evidence)assert.ok((await stat(join(root,path))).isFile());
const tests=await readFile(join(root,evidence[1]),'utf8');assert.match(tests,/ℹ tests 3850/);assert.match(tests,/ℹ pass 3850/);assert.match(tests,/ℹ fail 0/);assert.match(tests,/ℹ skipped 0/);
const results=[];
for(const {runId,originalEventSha256}of proof.proofs){
  const path=join(ledger,`run-${runId}.json`),bytes=await readFile(path),event=JSON.parse(bytes);
  assert.equal(sha(bytes),originalEventSha256);assert.equal(event.runId,runId);assert.equal(event.triggerType,'works-only');
  assert.equal(event.snapshotCount,0);assert.equal(event.worksOnly.accepted,0);
  const result=await completePostIngestionProductReview({ledgerDir:ledger,runId,evidence});
  assert.equal(sha(await readFile(path)),originalEventSha256);
  const receipt=JSON.parse(await readFile(result.path));assert.equal(receipt.runId,runId);assert.equal(receipt.status,'completed');
  results.push({runId,status:result.status,originalEventSha256,originalPreserved:true});
}
const result={checkedAt:new Date().toISOString(),results,evidence,noOriginalEventRewrite:true,notAllIssuesFixed:true,
  noRealUserRetentionTrial:true,laterAndHistoricPendingRunsNotClaimedReviewed:true};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase83-reviewed-events.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({checkedAt:result.checkedAt,results,notAllIssuesFixed:true}));
