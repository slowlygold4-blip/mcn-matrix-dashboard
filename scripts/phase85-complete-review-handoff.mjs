// Append reviews only after this turn's actual source, code and evidence checks.
import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {completePostIngestionProductReview} from '../lib/post-ingestion-review.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),dir=join(root,'data/maintenance-journal');
const sha=b=>createHash('sha256').update(b).digest('hex');
const proof=JSON.parse(await readFile(join(dir,'2026-10-02-phase85-natural-provenance-peer-handoff.json')));
const evidence=['data/maintenance-journal/2026-10-02-phase85.md','data/maintenance-journal/2026-10-02-phase85-main-final.txt',
 'data/maintenance-journal/2026-10-02-phase85-stage-safety-final.txt','data/maintenance-journal/2026-10-02-phase85-actual-request-final-handle.json',
 'data/maintenance-journal/2026-10-02-phase85-late-safety-final.json','data/maintenance-journal/2026-10-02-phase85-natural-provenance-peer-handoff.json',
 'data/maintenance-journal/2026-10-02-phase85-backup-readback.json','data/maintenance-journal/2026-10-02-phase85-public-readback.json',
 'docs/phase85-actual-request-peer.md','docs/phase85-late-safety-peer.md','docs/phase85-public-source-peer.md','docs/phase85-cloud-contract-peer.md'];
for(const f of evidence)assert.ok((await stat(join(root,f))).isFile());
const test=await readFile(join(root,evidence[1]),'utf8');
const count=Number(/ℹ tests (\d+)\b/.exec(test)?.[1]),pass=Number(/ℹ pass (\d+)\b/.exec(test)?.[1]);
assert.ok(count>=3900);assert.equal(count,pass);
for(const field of ['fail','skipped','cancelled'])assert.match(test,new RegExp('ℹ '+field+' 0\\b'));
assert.equal(sha(await readFile(join(root,'scripts/douyin_browser_collector.mjs'))),'ee1d40508a43a098cc28e5b522e0af60b563666c6f7f6ddd46258b6d069f2444');
assert.equal(sha(await readFile(join(root,'lib/browser-first-works-request.mjs'))),'ccd295c0776c6b4af38c990e909358f36f72c44ae5b774d250fba993cec8926c');
assert.ok(proof.proofs.length>0&&proof.proofs.length<=20);
const results=[];
for(const p of proof.proofs){
 assert.ok(p.runId>2388);assert.equal(p.fourSourceHashesEqual,true);assert.equal(p.actualReaderAccepted,true);assert.equal(p.exactEventRebuild,true);
 const path=join(root,'data/ingestion-reviews/run-'+p.runId+'.json'),bytes=await readFile(path);assert.equal(sha(bytes),p.originalEventSha256);
 const result=await completePostIngestionProductReview({ledgerDir:join(root,'data/ingestion-reviews'),runId:p.runId,evidence});
 assert.equal(sha(await readFile(path)),p.originalEventSha256);
 const receipt=JSON.parse(await readFile(result.path));assert.equal(receipt.status,'completed');
 results.push({runId:p.runId,status:result.status,originalEventSha256:p.originalEventSha256,originalPreserved:true});
}
const result={checkedAt:new Date().toISOString(),results,evidence,fullTests:count,noOriginalEventRewrite:true,
 notAllIssuesFixed:true,noRealUserRetentionTrial:true,olderPendingNotClaimedReviewed:true};
await writeFile(join(dir,'2026-10-02-phase85-reviewed-events-handoff.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({checkedAt:result.checkedAt,results,fullTests:count,notAllIssuesFixed:true}));


