// Append independent completions only for the actually reviewed fixed batch.
import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {completePostIngestionProductReview} from '../lib/post-ingestion-review.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const prefix='data/maintenance-journal/2026-10-02-phase90-';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const evidence=['data/maintenance-journal/2026-10-02-phase90.md',prefix+'main-full-final.txt',prefix+'site-tests-final.txt',prefix+'site-types.txt',prefix+'topic-source-root-tests-final.txt',prefix+'data-audit.json',prefix+'data-verification.json',prefix+'publication-final.json',prefix+'runtime-final.json','data/maintenance-journal/phase90ux/topic-public-final.json','data/maintenance-journal/phase90ux/topic-responsive-final.json','data/maintenance-journal/phase90ux/public-flow-5.json','docs/phase90-data-audit.md','docs/phase90-topic-source-review.md','docs/phase90-topic-source-final-review.md','docs/phase90-public-ux-peer.md','docs/phase90-collection-path-peer.md'];
for(const path of evidence)assert.ok((await stat(join(root,path))).isFile());
const counts={};
for(const [suffix,min] of [['main-full-final.txt',4022],['site-tests-final.txt',43],['topic-source-root-tests-final.txt',6]]){
 const path=prefix+suffix,text=await readFile(join(root,path),'utf8');
 const n=Number(/ℹ tests (\d+)\b/.exec(text)?.[1]);assert.ok(n>=min);
 assert.equal(n,Number(/ℹ pass (\d+)\b/.exec(text)?.[1]));
 for(const key of ['fail','cancelled','skipped'])assert.match(text,new RegExp('ℹ '+key+' 0\\b'));counts[path]=n;
}
assert.equal((await readFile(join(root,prefix+'site-types.txt'))).length,0);
const publication=JSON.parse(await readFile(join(root,prefix+'publication-final.json')));
assert.equal(publication.status,'succeeded');assert.equal(publication.versionNumber,38);
assert.equal(publication.commitSha,'2b4aa1a7b2b6998c222d3bc608a1e926c4565b93');
const ux=JSON.parse(await readFile(join(root,'data/maintenance-journal/phase90ux/topic-public-final.json')));
assert.equal(ux.passed,true);assert.equal(ux.actualPublicSite,true);assert.equal(ux.responseMocking,false);
assert.equal(ux.closedFreshContext,true);assert.deepEqual(ux.errors,[]);
assert.equal(ux.result.traceRows,ux.result.totalRows);assert.equal(ux.result.totalRows,68);assert.equal(ux.result.metricCells,136);assert.equal(ux.result.nullCount,30);
const responsive=JSON.parse(await readFile(join(root,'data/maintenance-journal/phase90ux/topic-responsive-final.json')));
assert.equal(responsive.passed,true);assert.equal(responsive.closedFreshContext,true);assert.deepEqual(responsive.errors,[]);
const runtime=JSON.parse(await readFile(join(root,prefix+'runtime-final.json')));assert.equal(runtime.serviceReady,true);assert.equal(runtime.sourceManifestUnchanged,true);assert.equal(runtime.sourceJobIdsUnchanged,true);
const bytes=await readFile(join(root,prefix+'data-audit.json'));
assert.equal(sha(bytes),'a5a430851f224c5a6c588a4afee236f4a9e3e7906c8528a641dd0670095306f1');
const audit=JSON.parse(bytes);assert.deepEqual(audit.runIds,Array.from({length:26},(_,i)=>2442+i));
assert.equal(audit.queryOnlyConnections,2);assert.equal(audit.totalChanges,0);
assert.equal(audit.auditTotals.exactMetricVectors,408);assert.equal(audit.auditTotals.sourceBoundNewWorkRows,48);assert.equal(audit.auditTotals.newProfileSnapshotsFromTheseWorksOnlyRuns,0);
assert.equal(audit.originalEventsByteUnchanged,true);assert.equal(audit.sourceManifestByteUnchanged,true);
const results=[];
for(const item of audit.proofs){
 for(const key of ['fourSourceHashesEqual','actualReaderAccepted','runIdentityAnchorTimeVerified','exactEventRebuild'])assert.equal(item[key],true);
 assert.equal(item.originalEventFieldCount,21);
 const path=join(root,'data/ingestion-reviews/run-'+item.runId+'.json');assert.equal(sha(await readFile(path)),item.originalEventSha256);
 const result=await completePostIngestionProductReview({ledgerDir:join(root,'data/ingestion-reviews'),runId:item.runId,evidence});
 assert.equal(sha(await readFile(path)),item.originalEventSha256);
 results.push({runId:item.runId,status:result.status,originalEventSha256:item.originalEventSha256,originalPreserved:true});
}
const result={checkedAt:new Date().toISOString(),results,evidence,counts,nextStrictAuditFromRunId:2468,originalEventsUnchanged:true,olderPendingNotClaimedReviewed:true,noRealUserRetentionTrial:true,notAllIssuesFixed:true,collectorCandidateNotPromoted:true,cloudCollectionProven:false};
await writeFile(join(root,prefix+'reviewed-events-handoff.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({checkedAt:result.checkedAt,count:results.length,statuses:[...new Set(results.map(x=>x.status))],counts,originalEventsUnchanged:true}));
