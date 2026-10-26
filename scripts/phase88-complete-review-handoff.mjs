// Append independent receipts only after current-source UI/data evidence passes.
import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {completePostIngestionProductReview} from '../lib/post-ingestion-review.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const evidence=['data/maintenance-journal/2026-10-02-phase88.md',
 'data/maintenance-journal/2026-10-02-phase88-main-green.txt',
 'data/maintenance-journal/2026-10-02-phase88-contract-green.txt',
 'data/maintenance-journal/2026-10-02-phase88-related-final-ux-test.txt',
 'data/maintenance-journal/2026-10-02-phase88-browser-peer-focus-final.json',
 'data/maintenance-journal/2026-10-02-phase88-site-tests.txt',
 'data/maintenance-journal/2026-10-02-phase88-site-type-final.txt',
 'data/maintenance-journal/2026-10-02-phase88-site-build.txt',
 'data/maintenance-journal/2026-10-02-phase88-data-audit-verified.json',
 'data/maintenance-journal/2026-10-02-phase88-data-diagnostics.json',
 'docs/phase88-data-audit.md','docs/phase88-coverage-ui-peer.md'];
for(const path of evidence)assert.ok((await stat(join(root,path))).isFile());
const counts={};
for(const [path,minimum] of [[evidence[1],3994],[evidence[2],127],[evidence[3],59]]){
 const text=await readFile(join(root,path),'utf8'),count=Number(/ℹ tests (\d+)\b/.exec(text)?.[1]);
 assert.ok(count>=minimum);assert.equal(count,Number(/ℹ pass (\d+)\b/.exec(text)?.[1]));
 for(const key of ['fail','cancelled','skipped'])assert.match(text,new RegExp('ℹ '+key+' 0\\b'));
 counts[path]=count;
}
const browser=JSON.parse(await readFile(join(root,evidence[4])));
assert.deepEqual(browser.pageErrors,[]);assert.deepEqual(browser.externalRequests,[]);
assert.equal(browser.cloudUIAcceptance,false);assert.equal(browser.liveCollection,false);
assert.ok(Object.values(browser.completed).every(x=>x===true));
assert.ok(Object.values(browser.scopeProof).every(x=>x===true));
assert.equal(sha(await readFile(join(root,'../mcn-public-site/app/page.tsx'))),browser.sourceSha256);
const proofBytes=await readFile(join(root,evidence[8]));
assert.equal(sha(proofBytes),'603c4197285cbec8421bf88083220d882b43231c3fcd899d0affd172e93c0382');
const proof=JSON.parse(proofBytes);
assert.deepEqual(proof.runIds,Array.from({length:7},(_,i)=>2417+i));
assert.equal(proof.queryOnlyConnections,2);assert.equal(proof.totalChanges,0);
assert.equal(proof.auditTotals.exactMetricVectors,94);assert.equal(proof.auditTotals.sourceBoundNewWorkRows,8);
assert.equal(proof.auditTotals.newProfileSnapshotsFromTheseWorksOnlyRuns,0);
assert.equal(proof.originalEventsByteUnchanged,true);assert.equal(proof.sourceManifestByteUnchanged,true);
const results=[];
for(const item of proof.proofs){
 for(const key of ['fourSourceHashesEqual','actualReaderAccepted','runIdentityAnchorTimeVerified','exactEventRebuild'])assert.equal(item[key],true);
 assert.equal(item.originalEventFieldCount,21);
 const path=join(root,'data/ingestion-reviews/run-'+item.runId+'.json');
 assert.equal(sha(await readFile(path)),item.originalEventSha256);
 const receipt=await completePostIngestionProductReview({ledgerDir:join(root,'data/ingestion-reviews'),runId:item.runId,evidence});
 assert.equal(sha(await readFile(path)),item.originalEventSha256);
 results.push({runId:item.runId,status:receipt.status,originalEventSha256:item.originalEventSha256,originalPreserved:true});
}
const result={checkedAt:new Date().toISOString(),results,evidence,counts,originalEventsUnchanged:true,
 olderPendingNotClaimedReviewed:true,noRealUserRetentionTrial:true,notAllIssuesFixed:true,
 auditedRunsPredateProductionPromotion:true,cloudCollectionProven:false};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase88-reviewed-events-handoff.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(result));
