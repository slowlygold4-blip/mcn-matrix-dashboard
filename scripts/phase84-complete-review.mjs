// Finish only the independently inspected terminal runs after real proof exists.
import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {completePostIngestionProductReview} from '../lib/post-ingestion-review.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const proof=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase84-natural-provenance-peer-final.json')));
assert.ok(proof.proofs.length>0&&proof.proofs.length<=20);
const evidence=['data/maintenance-journal/2026-10-02-phase84.md','data/maintenance-journal/2026-10-02-phase84-main-final.txt',
 'data/maintenance-journal/2026-10-02-phase84-stage-final-verified.txt','data/maintenance-journal/2026-10-02-phase84-stage-archive-recheck.txt',
 'data/maintenance-journal/2026-10-02-phase84-parent-peer-staged-recheck.txt','data/maintenance-journal/2026-10-02-phase84-parent-deadline-peer-final.json',
 'data/maintenance-journal/2026-10-02-phase84-deadline-independent-final.json','data/maintenance-journal/2026-10-02-phase84-backup-readback.json',
 'data/maintenance-journal/2026-10-02-phase84-public-readback.json','data/maintenance-journal/2026-10-02-phase84-natural-provenance-peer-final.json',
 'data/maintenance-journal/2026-10-02-phase84-runtime-handoff.json','docs/phase84-parent-deadline-peer.md',
 'docs/phase84-deadline-independent-peer.md','docs/phase84-natural-provenance-peer.md'];
for(const f of evidence)assert.ok((await stat(join(root,f))).isFile());
const test=await readFile(join(root,evidence[1]),'utf8');
assert.match(test,/ℹ tests 3883\b/);assert.match(test,/ℹ pass 3883\b/);assert.match(test,/ℹ fail 0\b/);assert.match(test,/ℹ skipped 0\b/);assert.match(test,/ℹ cancelled 0\b/);
const results=[];
for(const p of proof.proofs){
 assert.ok(p.runId>2386);assert.equal(p.fourSourceHashesEqual,true);assert.equal(p.actualReaderAccepted,true);assert.equal(p.exactEventRebuild,true);
 const path=join(root,`data/ingestion-reviews/run-${p.runId}.json`),bytes=await readFile(path);assert.equal(sha(bytes),p.originalEventSha256);
 const result=await completePostIngestionProductReview({ledgerDir:join(root,'data/ingestion-reviews'),runId:p.runId,evidence});
 assert.equal(sha(await readFile(path)),p.originalEventSha256);const receipt=JSON.parse(await readFile(result.path));assert.equal(receipt.status,'completed');
 results.push({runId:p.runId,status:result.status,originalEventSha256:p.originalEventSha256,originalPreserved:true});
}
const result={checkedAt:new Date().toISOString(),results,evidence,noOriginalEventRewrite:true,notAllIssuesFixed:true,noRealUserRetentionTrial:true,olderPendingNotClaimedReviewed:true};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase84-reviewed-events.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({checkedAt:result.checkedAt,results,notAllIssuesFixed:true}));
