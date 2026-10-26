// Complete only this fixed, actually audited batch. Never rewrite originals.
import assert from 'node:assert/strict';
import {readFile,stat,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {completePostIngestionProductReview} from '../lib/post-ingestion-review.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const prefix='data/maintenance-journal/2026-10-02-phase92-';
const sha=b=>createHash('sha256').update(b).digest('hex');
const evidence=['data/maintenance-journal/2026-10-02-phase92.md',prefix+'data-audit.json',prefix+'data-mcn-endpoints.json',prefix+'data-causal-proof.json',prefix+'data-final-proof.json',prefix+'product-review-tests.json','docs/phase92-data-audit.md','docs/phase92-mcn-ux-readonly.md','docs/phase92-okx-frontend-verified-study.md'];
for(const path of evidence)assert.ok((await stat(join(root,path))).isFile());
const auditBytes=await readFile(join(root,prefix+'data-audit.json'));
assert.equal(sha(auditBytes),'803ffce096b07632394dd350ab800b8aaa901f053953c81ee51a63e58f480211');
const finalBytes=await readFile(join(root,prefix+'data-final-proof.json'));
assert.equal(sha(finalBytes),'6a9a9431e127ff54ce8ccfdc84ef3847acc4e11f2d8740a63c049ed3e3b52d3e');
const audit=JSON.parse(auditBytes),final=JSON.parse(finalBytes);
assert.deepEqual(audit.runIds,Array.from({length:33},(_,i)=>2498+i));
assert.equal(audit.totalChanges,0);assert.equal(final.totalChanges,0);
assert.equal(audit.originalEventsByteUnchanged,true);assert.equal(audit.sourceManifestByteUnchanged,true);
assert.equal(final.originalEventsReverified,33);assert.equal(final.correctPersistedKeyProjection,true);
assert.equal(final.newPolicyRows,0);assert.equal(final.actualProductionSettingsReader.mode,'legacy');
const tests=JSON.parse(await readFile(join(root,prefix+'product-review-tests.json')));
for(const [key,n] of [['site',19],['main',37]]){
 assert.equal(tests[key].tests,n);assert.equal(tests[key].pass,n);
 for(const field of ['fail','cancelled','skipped'])assert.equal(tests[key][field],0);
}
assert.equal(tests.mainHealth.runtimeAI,false);
const results=[];
for(const item of audit.proofs){
 for(const key of ['fourSourceHashesEqual','actualReaderAccepted','runIdentityAnchorTimeVerified','sourceBoundCursorChainVerified','exactEventRebuild'])assert.equal(item[key],true);
 assert.equal(item.originalEventFieldCount,21);
 const path=join(root,'data/ingestion-reviews/run-'+item.runId+'.json');
 assert.equal(sha(await readFile(path)),item.originalEventSha256);
 const result=await completePostIngestionProductReview({ledgerDir:join(root,'data/ingestion-reviews'),runId:item.runId,evidence});
 assert.equal(sha(await readFile(path)),item.originalEventSha256);
 results.push({runId:item.runId,status:result.status,originalPreserved:true,originalEventSha256:item.originalEventSha256});
}
await writeFile(join(root,prefix+'reviewed-events-handoff.json'),JSON.stringify({checkedAt:new Date().toISOString(),results,evidence,nextStrictAuditFromRunId:2531,originalEventsUnchanged:true,olderPendingNotClaimedReviewed:true,reviewScope:'Fixed persisted data, independent operating math, code-level interaction contracts and read-only MCN UX. Current public browser retry timed out; not claimed passed.',noRealUserRetentionTrial:true,notAllIssuesFixed:true,candidatePromotionNotAuthorizedByReceipt:true,configurationNotActivated:true,cloudCollectionProven:false},null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({count:results.length,created:results.filter(x=>x.status==='created').length,originalEventsPreserved:true,next:2531}));
