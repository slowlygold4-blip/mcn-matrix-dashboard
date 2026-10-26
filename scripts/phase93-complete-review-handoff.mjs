// Fixed terminal data and product review only; never rewrite original events.
import assert from 'node:assert/strict';
import {readFile,stat,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {completePostIngestionProductReview} from '../lib/post-ingestion-review.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const prefix='data/maintenance-journal/2026-10-02-phase93-';
const sha=b=>createHash('sha256').update(b).digest('hex');
const evidence=['data/maintenance-journal/2026-10-02-phase93.md',prefix+'data-audit.json',prefix+'data-readback.json',prefix+'backup.json',prefix+'product-review-tests.json','docs/phase93-data-audit.md','docs/phase93-ui-sort-shortcuts.md','docs/phase93-ui-peer-review.md'];
for(const path of evidence)assert.ok((await stat(join(root,path))).isFile());
const bytes=await readFile(join(root,prefix+'data-audit.json'));
assert.equal(sha(bytes),'caf242a556219d7d3d284cf74844a7e159c48b79bd95cf26688e8b15deb674a3');
const readbackBytes=await readFile(join(root,prefix+'data-readback.json'));
assert.equal(sha(readbackBytes),'919381efc85405f2de252a7d21e13bb9bda093c84c7984a6fa8a05d8823438dc');
assert.equal(sha(await readFile(join(root,'docs/phase93-ui-peer-review.md'))),'9420c6372822545478016fb751ac16736130d24c60273cb31ba96491cf413a4a');
const audit=JSON.parse(bytes),readback=JSON.parse(readbackBytes);
assert.deepEqual(audit.runIds,Array.from({length:25},(_,i)=>2531+i));
assert.deepEqual(readback.runIds,audit.runIds);
assert.equal(audit.totalChanges,0);assert.equal(readback.totalChanges,0);
assert.equal(audit.originalEventsByteUnchanged,true);assert.equal(audit.sourceManifestByteUnchanged,true);
assert.equal(readback.readerUnchangedSinceAudit,true);assert.equal(readback.firstSeenCount,23);
assert.equal(readback.actualSettingsReader.mode,'legacy');
assert.equal(sha(await readFile(join(root,'data/source-poll/manifest.json'))),readback.source.sha256);
const tests=JSON.parse(await readFile(join(root,prefix+'product-review-tests.json')));
for(const [key,n] of [['site',47],['main',37]]){
 assert.equal(tests[key].tests,n);assert.equal(tests[key].pass,n);
 for(const field of ['fail','cancelled','skipped'])assert.equal(tests[key][field],0);
}
assert.equal(tests.mainHealth.runtimeAI,false);
const originals=[];
for(const item of audit.proofs){
 for(const key of ['fourSourceHashesEqual','actualReaderAccepted','runIdentityAnchorTimeVerified','sourceBoundCursorChainVerified','exactEventRebuild'])assert.equal(item[key],true);
 assert.equal(item.originalEventFieldCount,21);
 const path=join(root,'data/ingestion-reviews/run-'+item.runId+'.json');
 assert.equal(sha(await readFile(path)),item.originalEventSha256);
 originals.push({item,path});
}
const results=[];
for(const {item,path} of originals){
 const result=await completePostIngestionProductReview({ledgerDir:join(root,'data/ingestion-reviews'),runId:item.runId,evidence});
 assert.equal(sha(await readFile(path)),item.originalEventSha256);
 results.push({runId:item.runId,status:result.status,originalPreserved:true,originalEventSha256:item.originalEventSha256});
}
await writeFile(join(root,prefix+'reviewed-events-handoff.json'),JSON.stringify({checkedAt:new Date().toISOString(),results,evidence,nextStrictAuditFromRunId:2556,originalEventsUnchanged:true,olderPendingNotClaimedReviewed:true,reviewScope:'Fixed source/identity/time/cursor/metric vectors and UI direct-sort contracts plus local actual Chrome. No platform complete or true-user retention claim.',noRealUserRetentionTrial:true,notAllIssuesFixed:true,configurationNotActivated:true,worksCandidatePromoted:false,cloudCollectionProven:false},null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({count:results.length,created:results.filter(x=>x.status==='created').length,originalEventsPreserved:true,next:2556}));
