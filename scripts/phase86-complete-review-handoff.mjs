// Separate product-review receipts; original ingestion events remain immutable.
import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {completePostIngestionProductReview} from '../lib/post-ingestion-review.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),dir=join(root,'data/maintenance-journal');
const sha=b=>createHash('sha256').update(b).digest('hex');
const proof=JSON.parse(await readFile(join(dir,'2026-10-02-phase86-natural-provenance-peer-handoff.json')));
const evidence=['data/maintenance-journal/2026-10-02-phase86.md','data/maintenance-journal/2026-10-02-phase86-main-frozen.txt',
 'data/maintenance-journal/2026-10-02-phase86-site-tests.txt','data/maintenance-journal/2026-10-02-phase86-site-types.txt',
 'data/maintenance-journal/2026-10-02-phase86-browser-peer-verified.json','data/maintenance-journal/2026-10-02-phase86-natural-provenance-peer-handoff.json',
 'data/maintenance-journal/2026-10-02-phase86-backup.json','data/maintenance-journal/2026-10-02-phase86-public-readback.json',
 'data/maintenance-journal/2026-10-02-phase86-sync-green.txt','data/maintenance-journal/2026-10-02-phase86-ux-contract-audit.json',
 'data/maintenance-journal/2026-10-02-phase86-publisher-reload.json','data/maintenance-journal/2026-10-02-phase86-deployment.json',
 'docs/phase86-natural-provenance-peer.md','docs/phase86-public-replica-sync-peer-review.md','docs/phase86-ux-comparison-continuity.md'];
for(const f of evidence)assert.ok((await stat(join(root,f))).isFile());
const tests=await readFile(join(root,evidence[1]),'utf8');
const count=Number(/ℹ tests (\d+)\b/.exec(tests)?.[1]),pass=Number(/ℹ pass (\d+)\b/.exec(tests)?.[1]);
assert.ok(count>=3937);assert.equal(count,pass);
for(const key of ['fail','cancelled','skipped'])assert.match(tests,new RegExp('ℹ '+key+' 0\\b'));
const deployment=JSON.parse(await readFile(join(dir,'2026-10-02-phase86-deployment.json')));
assert.equal(deployment.deployment.status,'succeeded');assert.equal(deployment.deployment.version_id,deployment.savedVersion.id);
assert.equal(sha(await readFile(join(root,'scripts/douyin_browser_collector.mjs'))),'ee1d40508a43a098cc28e5b522e0af60b563666c6f7f6ddd46258b6d069f2444');
assert.equal(sha(await readFile(join(root,'lib/browser-first-works-request.mjs'))),'ccd295c0776c6b4af38c990e909358f36f72c44ae5b774d250fba993cec8926c');
assert.equal(proof.proofs.length,13);assert.deepEqual(proof.proofs.map(p=>p.runId),Array.from({length:13},(_,i)=>2392+i));
const results=[];
for(const p of proof.proofs){
 assert.equal(p.fourSourceHashesEqual,true);assert.equal(p.actualReaderAccepted,true);assert.equal(p.exactEventRebuild,true);
 const path=join(root,'data/ingestion-reviews/run-'+p.runId+'.json');assert.equal(sha(await readFile(path)),p.originalEventSha256);
 const result=await completePostIngestionProductReview({ledgerDir:join(root,'data/ingestion-reviews'),runId:p.runId,evidence});
 assert.equal(sha(await readFile(path)),p.originalEventSha256);
 const receipt=JSON.parse(await readFile(result.path));assert.equal(receipt.status,'completed');assert.equal(receipt.runId,p.runId);
 results.push({runId:p.runId,status:result.status,originalEventSha256:p.originalEventSha256,originalPreserved:true});
}
const result={checkedAt:new Date().toISOString(),results,evidence,fullTests:count,noOriginalEventRewrite:true,
 notAllIssuesFixed:true,noRealUserRetentionTrial:true,olderPendingNotClaimedReviewed:true};
await writeFile(join(dir,'2026-10-02-phase86-reviewed-events-handoff.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({checkedAt:result.checkedAt,results,fullTests:count,notAllIssuesFixed:true}));
