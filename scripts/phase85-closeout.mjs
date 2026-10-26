// Finalize this bounded turn, without declaring the full MCN objective complete.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),dir=join(root,'data/maintenance-journal');
const sha=b=>createHash('sha256').update(b).digest('hex');
const read=async n=>JSON.parse(await readFile(join(dir,'2026-10-02-phase85-'+n+'.json')));
const [initial,final,pub,reviews,backup,natural]=await Promise.all(['runtime-initial','runtime-final','public-readback',
 'reviewed-events','backup-readback','natural-provenance-peer-final'].map(read));
assert.equal(final.health.status,'ready');assert.equal(final.health.runtimeAI,false);
assert.equal(final.counts.activeRuns,0);
assert.deepEqual(final.services.map(x=>x.pid),initial.services.map(x=>x.pid));
assert.equal(initial.source.sha256,final.source.sha256);
assert.equal(final.code.ownerSha256,'ee1d40508a43a098cc28e5b522e0af60b563666c6f7f6ddd46258b6d069f2444');
assert.equal(final.code.firstPageRequestHelperSha256,'ccd295c0776c6b4af38c990e909358f36f72c44ae5b774d250fba993cec8926c');
assert.equal(sha(await readFile(join(root,'scripts/douyin_browser_collector.mjs'))),final.code.ownerSha256);
assert.equal(sha(await readFile(join(root,'lib/browser-first-works-request.mjs'))),final.code.firstPageRequestHelperSha256);
const countDelta={};
for(const k of ['targets','snapshots','posts','post_metrics','works_observations']){
 assert.ok(final.counts[k]>=initial.counts[k]);countDelta[k]=final.counts[k]-initial.counts[k];
}
assert.equal(pub.assets.length,7);assert.equal(pub.parts.length,7);assert.equal(pub.manifestFiles,2281);
assert.equal(backup.cutoffRunId,2383);assert.ok(natural.proofs.length>0);
assert.deepEqual(reviews.results.map(x=>x.runId),natural.proofs.map(x=>x.runId));
for(const x of reviews.results)assert.equal(sha(await readFile(join(root,'data/ingestion-reviews/run-'+x.runId+'.json'))),x.originalEventSha256);
const parseTest=async name=>{
 const output=await readFile(join(dir,name),'utf8');
 const fields=Object.fromEntries(['tests','pass','fail','skipped','cancelled'].map(k=>[k,Number(new RegExp('ℹ '+k+' (\\d+)\\b').exec(output)?.[1])]));
 assert.ok(fields.tests>3900);assert.equal(fields.tests,fields.pass);
 for(const k of ['fail','skipped','cancelled'])assert.equal(fields[k],0);
 return fields;
};
const main=await parseTest('2026-10-02-phase85-main-final.txt'),stage=await parseTest('2026-10-02-phase85-stage-safety-final.txt');
const startedAt='2026-10-01T22:22:11.000Z',finishedAt=new Date().toISOString(),elapsedMs=Date.parse(finishedAt)-Date.parse(startedAt);
assert.ok(elapsedMs>0&&elapsedMs<30*60_000);
const result={startedAt,finishedAt,elapsedMs,productionFreezeAt:'2026-10-01T22:47:11.000Z',hardStopAt:'2026-10-01T22:52:11.000Z',
 productionChanged:['scripts/douyin_browser_collector.mjs','lib/browser-first-works-request.mjs'],
 promotionAt:'2026-10-01T22:40:59.000Z',exactCodeBackup:'/private/tmp/mcn-phase85-stage-MNwUpR/original',
 tests:{main,stage,currentActualOwner:22,independentSafety:20,currentIsolatedChromeScenarios:3},
 counts:final.counts,countDelta,profile:final.profile,works:final.works,topics:final.topics,source:final.source,
 services:final.services,reviewQueue:final.reviewQueue,reviewedRunIds:reviews.results.map(x=>x.runId),
 naturalRuns:natural.proofs.map(({runId,targetId,status,sourcePostCount,diagnostics})=>({runId,targetId,status,sourcePostCount,
  firstPageRequest:diagnostics?.firstPageRequest??null,stopReason:diagnostics?.stopReason??null})),
 public:{url:pub.origin,version:33,verifiedSavedAsOf:pub.asOf,publishedAt:pub.publishedAt,
  lastObservedPublisherAsOf:final.publisher.publishedAsOf,assets:7,parts:7,manifestFiles:2281,noDeployment:true},
 backup:{cutoffRunId:2383,doesNotContainLaterRuns:true,bytes:822730752,
  sha256:'6362eea58606483a28d08f23c6a7f2c5bb65f89be3a8ab5ba4cb60aaf432a62f'},
 constraints:{runtimeAI:false,newAITimers:0,newAccounts:0,manualCollections:0,siteDeployments:0,
  macOffFreshSamplingVerified:false,allWorksRecovered:false,allNetworksVerified:false,instantPostDispatchRevocation:false},
 nextPriorities:['Actual next ordinary source confirms whether late first0 path ran; preserve refusals and original source',
  'Native ordinary cloud registration/readback plus authorized source execution; no AI timer',
  'A future ordinary consistent backup covering later observations; never live-copy the database'],
 fullGoalStatus:'active-not-complete',allPhase85PeersStopped:true,originalEventsPreserved:true,noRealUserRetentionTrial:true};
await writeFile(join(dir,'2026-10-02-phase85-closeout.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({finishedAt,elapsedMinutes:Number((elapsedMs/60000).toFixed(2)),mainTests:main.tests,
 reviewedRunIds:result.reviewedRunIds,countDelta,fullGoalStatus:result.fullGoalStatus}));

