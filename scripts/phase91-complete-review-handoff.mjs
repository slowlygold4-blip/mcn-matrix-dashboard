// Independent product-review completion for this fixed, actually audited batch.
import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {completePostIngestionProductReview} from '../lib/post-ingestion-review.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),prefix='data/maintenance-journal/2026-10-02-phase91-';
const sha=b=>createHash('sha256').update(b).digest('hex');
const evidence=['data/maintenance-journal/2026-10-02-phase91.md',prefix+'stage-full-verified.txt',prefix+'stage-archive-recheck.txt',prefix+'main-full-final.txt',prefix+'ui-related-final.txt',prefix+'ui-contract.txt',prefix+'data-audit.json',prefix+'data-causal-proof.json',prefix+'data-settings-review.json',prefix+'promotion.json',prefix+'runtime-final.json','data/maintenance-journal/phase91ux/candidate-chrome-sealed.json','data/maintenance-journal/phase91ux/live-echo.json','docs/phase91-data-audit.md','docs/phase91-settings-ux-peer.md'];
for(const path of evidence)assert.ok((await stat(join(root,path))).isFile());
const text=await readFile(join(root,prefix+'main-full-final.txt'),'utf8'),n=Number(/ℹ tests (\d+)\b/.exec(text)?.[1]);
assert.ok(n>=4035);assert.equal(n,Number(/ℹ pass (\d+)\b/.exec(text)?.[1]));
for(const key of ['fail','cancelled','skipped'])assert.match(text,new RegExp('ℹ '+key+' 0\\b'));
const runtime=JSON.parse(await readFile(join(root,prefix+'runtime-final.json')));
assert.equal(runtime.serviceReady,true);assert.equal(runtime.settingsReadback,true);assert.equal(runtime.legacyUnchanged,true);assert.equal(runtime.sourceManifestUnchanged,true);
const ux=JSON.parse(await readFile(join(root,'data/maintenance-journal/phase91ux/live-echo.json')));
assert.equal(ux.passed,true);
const bytes=await readFile(join(root,prefix+'data-audit.json'));assert.equal(sha(bytes),'f8736eb59a18ccb3a695ed7a876c417249f8d202d3c19132dadee53fd8b203f2');
const audit=JSON.parse(bytes);assert.deepEqual(audit.runIds,Array.from({length:30},(_,i)=>2468+i));assert.equal(audit.queryOnlyConnections,2);assert.equal(audit.totalChanges,0);
assert.equal(audit.auditTotals.exactMetricVectors,465);assert.equal(audit.auditTotals.sourceBoundNewWorkRows,85);assert.equal(audit.auditTotals.newProfileSnapshotsFromTheseWorksOnlyRuns,0);
assert.equal(audit.originalEventsByteUnchanged,true);assert.equal(audit.sourceManifestByteUnchanged,true);
const results=[];
for(const item of audit.proofs){
 for(const key of ['fourSourceHashesEqual','actualReaderAccepted','runIdentityAnchorTimeVerified','exactEventRebuild'])assert.equal(item[key],true);
 assert.equal(item.originalEventFieldCount,21);const path=join(root,'data/ingestion-reviews/run-'+item.runId+'.json');assert.equal(sha(await readFile(path)),item.originalEventSha256);
 const result=await completePostIngestionProductReview({ledgerDir:join(root,'data/ingestion-reviews'),runId:item.runId,evidence});assert.equal(sha(await readFile(path)),item.originalEventSha256);
 results.push({runId:item.runId,status:result.status,originalPreserved:true,originalEventSha256:item.originalEventSha256});
}
await writeFile(join(root,prefix+'reviewed-events-handoff.json'),JSON.stringify({checkedAt:new Date().toISOString(),results,evidence,mainTests:n,nextStrictAuditFromRunId:2498,originalEventsUnchanged:true,olderPendingNotClaimedReviewed:true,noRealUserRetentionTrial:true,notAllIssuesFixed:true,configurationNotActivated:true,cloudCollectionProven:false},null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({count:results.length,statuses:[...new Set(results.map(x=>x.status))],mainTests:n,originalPreserved:true}));
