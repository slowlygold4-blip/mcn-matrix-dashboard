// Append fixed-batch product receipts only after independently preserved gates.
import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {completePostIngestionProductReview} from '../lib/post-ingestion-review.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const prefix='data/maintenance-journal/2026-10-02-phase89-';
const sha=b=>createHash('sha256').update(b).digest('hex');
const evidence=['data/maintenance-journal/2026-10-02-phase89.md',prefix+'main-full.txt',prefix+'stage-full.txt',prefix+'coverage-related.txt',prefix+'site-tests.txt',prefix+'site-types.txt',prefix+'coverage-browser.json',prefix+'data-audit.json',prefix+'data-causal-proof.json',prefix+'backup.json',prefix+'publication.json','docs/phase89-data-audit.md','docs/phase89-collector-empty-cursor-peer.md','docs/phase89-okx-ux-peer.md',prefix+'collector-peer-candidate-final.txt'];
for(const path of evidence)assert.ok((await stat(join(root,path))).isFile());
const counts={};
for(const [suffix,want] of [['main-full.txt',4009],['stage-full.txt',4009],['coverage-related.txt',25],['site-tests.txt',43],['collector-peer-candidate-final.txt',52]]){
 const p=prefix+suffix,t=await readFile(join(root,p),'utf8');
 const count=Number(/ℹ tests (\d+)\b/.exec(t)?.[1]);assert.equal(count,want);
 assert.equal(count,Number(/ℹ pass (\d+)\b/.exec(t)?.[1]));
 for(const key of ['fail','cancelled','skipped'])assert.match(t,new RegExp('ℹ '+key+' 0\\b'));counts[p]=count;
}
assert.equal((await readFile(join(root,prefix+'site-types.txt'))).length,0);
assert.equal(sha(await readFile(join(root,'lib/browser-works-pagination.mjs'))),'af989dbd9c102b57d9afa85c30fa0c1e87c9ca6c89fee289db4ecc04c3cc4158');
const browser=JSON.parse(await readFile(join(root,prefix+'coverage-browser.json')));
assert.deepEqual(browser.errors,[]);assert.equal(browser.externalRequests,0);
assert.equal(browser.actualReactPreview,true);assert.equal(browser.cloudUIAcceptance,false);assert.equal(browser.liveCollection,false);
assert.equal(browser.steps.length,2);
for(const step of browser.steps)for(const key of ['exactTriggerFocus','page2Kept','rangeComparisonVersionKept','urlKept','csvBytesKept','scrollKept'])assert.equal(step[key],true);
assert.equal(sha(await readFile(join(root,'../mcn-public-site/components/coverage-panel.tsx'))),browser.sourceSha256);
const publication=JSON.parse(await readFile(join(root,prefix+'publication.json')));
assert.equal(publication.status,'succeeded');assert.equal(publication.versionNumber,36);assert.equal(publication.commitSha,'ff6b40de572760cbd47a05b353bd5af0de8b5d84');
const backup=JSON.parse(await readFile(join(root,prefix+'backup.json')));
assert.equal(backup.restoredCountsMatch,true);assert.equal(backup.validation.integrityCheck,'ok');assert.equal(backup.validation.foreignKeyViolations,0);assert.equal(backup.auditedBatch2424To2441Included,true);
const proofBytes=await readFile(join(root,prefix+'data-audit.json'));
assert.equal(sha(proofBytes),'5b2a1300953c66c775e3a94fb2a47f01f8a0f0d8a43e9d64f3a246c5deceb737');
const proof=JSON.parse(proofBytes);assert.deepEqual(proof.runIds,Array.from({length:18},(_,i)=>2424+i));
assert.equal(proof.queryOnlyConnections,2);assert.equal(proof.totalChanges,0);
assert.equal(proof.auditTotals.exactMetricVectors,259);assert.equal(proof.auditTotals.sourceBoundNewWorkRows,60);assert.equal(proof.auditTotals.newProfileSnapshotsFromTheseWorksOnlyRuns,0);
assert.equal(proof.originalEventsByteUnchanged,true);assert.equal(proof.sourceManifestByteUnchanged,true);
const results=[];
for(const item of proof.proofs){
 for(const key of ['fourSourceHashesEqual','actualReaderAccepted','runIdentityAnchorTimeVerified','exactEventRebuild'])assert.equal(item[key],true);
 assert.equal(item.originalEventFieldCount,21);
 const path=join(root,'data/ingestion-reviews/run-'+item.runId+'.json');assert.equal(sha(await readFile(path)),item.originalEventSha256);
 const receipt=await completePostIngestionProductReview({ledgerDir:join(root,'data/ingestion-reviews'),runId:item.runId,evidence});
 assert.equal(sha(await readFile(path)),item.originalEventSha256);
 results.push({runId:item.runId,status:receipt.status,originalEventSha256:item.originalEventSha256,originalPreserved:true});
}
const result={checkedAt:new Date().toISOString(),results,evidence,counts,originalEventsUnchanged:true,olderPendingNotClaimedReviewed:true,nextStrictAuditFromRunId:2442,noRealUserRetentionTrial:true,notAllIssuesFixed:true,cloudCollectionProven:false};
await writeFile(join(root,prefix+'reviewed-events-handoff.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({checkedAt:result.checkedAt,runIds:results.map(x=>x.runId),count:results.length,statuses:[...new Set(results.map(x=>x.status))],originalEventsUnchanged:true,counts}));
