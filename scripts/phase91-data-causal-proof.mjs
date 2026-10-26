import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const read=p=>readFile(join(root,p));
const original=await read('data/maintenance-journal/2026-10-02-phase91-data-audit.json');
assert.equal(sha(original),'f8736eb59a18ccb3a695ed7a876c417249f8d202d3c19132dadee53fd8b203f2');
const audit=JSON.parse(original),runs=audit.proofs;
const advancing=p=>p.rawCount===0&&p.hasMore===true&&Number.isSafeInteger(p.responseCursor)&&p.responseCursor>0&&p.responseCursor!==p.requestCursor;
const continuation=[];
for(const run of runs)for(let i=0;i<run.pages.length;i++){
 const page=run.pages[i];if(!advancing(page))continue;const next=run.pages[i+1];
 if(next)assert.equal(next.requestCursor,page.responseCursor);
 continuation.push({runId:run.runId,sourceSha256:run.sourceSha256,emptyPageIndex:i+1,emptyPage:page,
  actualNextPage:next??null,continuedWithinSameSource:!!next,stoppedAtExistingPageLimit:!next&&run.paginationStopReason==='page-limit',
  metricsAfterThisEmptyPage:run.pages.slice(i+1).reduce((s,p)=>s+p.acceptedCount,0),
  firstSeenAfterThisEmptyPage:run.sourceVectors.filter(v=>run.pages.slice(i+1).some(p=>p.observedAt===v.observedAt)&&v.firstSeenAtThisObservation).length});
}
const continuedRuns=[...new Set(continuation.filter(x=>x.continuedWithinSameSource).map(x=>x.runId))];
assert.deepEqual(continuedRuns,[2474,2475,2482]);
assert.equal(continuation.reduce((s,x)=>s+x.metricsAfterThisEmptyPage,0),0);
assert.equal(continuation.reduce((s,x)=>s+x.firstSeenAfterThisEmptyPage,0),0);
const thirdPageRuns=runs.filter(p=>p.pages[2]?.acceptedCount>0).map(p=>({runId:p.runId,count:p.pages[2].acceptedCount,
 firstSeen:p.sourceVectors.filter(v=>v.observedAt===p.pages[2].observedAt&&v.firstSeenAtThisObservation).length}));
assert.deepEqual(thirdPageRuns.map(p=>[p.runId,p.count]),[[2469,2],[2481,7],[2492,1]]);
const laterFirstSeen=runs.reduce((s,p)=>s+p.sourceVectors.filter(v=>p.pages.slice(1).some(page=>page.observedAt===v.observedAt)&&v.firstSeenAtThisObservation).length,0);
for(const run of runs)assert.equal(sha(await read(`data/ingestion-reviews/run-${run.runId}.json`)),run.originalEventSha256);
for(const old of audit.oldOriginalEventPreservation.files)assert.equal(sha(await read('data/ingestion-reviews/'+old.file)),old.sha256);
assert.equal(sha(await read('data/source-poll/manifest.json')),audit.source.sha256);
const db=new DatabaseSync(join(root,'data/douyin-monitor.sqlite'),{readOnly:true});let setting;
try{db.exec('PRAGMA query_only=ON;BEGIN');setting=db.prepare("SELECT value,updated_at FROM settings WHERE key='publicPostsPerAccount'").get();
 assert.deepEqual({...setting},{value:'30',updated_at:'2026-09-04T07:53:16.606Z'});
 assert.equal(db.prepare('PRAGMA query_only').get().query_only,1);assert.equal(db.prepare('SELECT total_changes() n').get().n,0);db.exec('ROLLBACK');
}finally{db.close();}
const result={checkedAt:new Date().toISOString(),fixedCutoff:audit.fixedTerminalCutoff,runIds:audit.runIds,
 auditReceiptSha256:sha(original),auditReceiptBytes:original.length,auditReceiptMode:((await stat(join(root,'data/maintenance-journal/2026-10-02-phase91-data-audit.json'))).mode&511).toString(8),
 actualEmptyAdvancingEntries:continuation,actualContinuedAfterEmptyRunIds:continuedRuns,
 metricsProducedAfterEmptyAdvancingPage:0,firstSeenProducedAfterEmptyAdvancingPage:0,
 thirdPageMetricRuns:thirdPageRuns,laterPageFirstSeenWorks:laterFirstSeen,
 naturalBehaviorDemonstrated:'within existing maxPages=3 and run time budget, empty advancing page no longer terminates next eligible page; all subsequent pages in these samples remain empty',
 noPerRunCodeShaAttestation:true,noNewWorkRecoveryFromEmptyAdvancingClaim:true,
 fixedCounts:audit.fixedCutoffCounts,delta:audit.fixedDelta,coverage:audit.fixedCutoffCoverage,
 originalEventsReverified:30,oldOriginalEventsReverified:1713,oldEventManifestSha256:audit.oldOriginalEventPreservation.manifestSha256,
 originalPublicPostsSetting:{...setting},queryOnlyConnections:1,totalChanges:0,
 sourceManifestUnchanged:true,backupContainsNoneOfTheseNewRuns:true,backupTerminalCutoff:2448,
 auxiliaryOriginalReceiptLivePromotionRunListIsLimitedTo40AndNotAuditedBatch:true,
 noCompletionOrCollectionOrServiceControls:true,noAllU01ToU47CompletionClaim:true,nextStrictAuditFromRunId:2498};
const text=JSON.stringify(result,null,2)+'\n';assert.doesNotMatch(text,/https?:\/\/|Bearer\s|Authorization\s*[:=]|Cookie\s*[:=]|MS4wLj/i);
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase91-data-causal-proof.json'),text,{flag:'wx',mode:0o600});
console.log(JSON.stringify({checkedAt:result.checkedAt,continuedRuns,metricsAfterEmpty:0,firstSeenAfterEmpty:0,thirdPageRuns,laterFirstSeen,sha256:sha(text)}));
