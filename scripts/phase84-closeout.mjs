// Close only this bounded work turn, not the unfinished full product goal.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),dir=join(root,'data/maintenance-journal');
const sha=b=>createHash('sha256').update(b).digest('hex');
const read=async n=>JSON.parse(await readFile(join(dir,`2026-10-02-phase84-${n}.json`)));
const [initial,final,pub,review,backup,natural,handoff]=await Promise.all(['runtime-initial','runtime-final','public-readback','reviewed-events','backup-readback','natural-provenance-peer-final','runtime-handoff'].map(read));
for(const k of ['targets','snapshots','posts','post_metrics'])assert.equal(initial.counts[k],final.counts[k]);
assert.equal(final.counts.works_observations-initial.counts.works_observations,1); // Initial runtime receipt is AFTER 2387.
assert.equal(final.counts.maxRun,2388);assert.equal(final.counts.activeRuns,0);assert.equal(initial.source.sha256,final.source.sha256);
assert.equal(final.health.runtimeAI,false);assert.equal(final.health.status,'ready');
assert.deepEqual(final.services.map(x=>x.pid),[81452,26001,72426]);
assert.equal(handoff.onlyExistingIdleMainSignalled,true);assert.equal(handoff.originalKeepAliveOwnsResume,true);
assert.equal(pub.assets.length,7);assert.equal(pub.parts.length,7);assert.equal(pub.manifestFiles,2281);
assert.equal(final.publisher.publishedAsOf,pub.asOf);assert.equal(backup.cutoffRunId,2383);
assert.equal(natural.proofs.length,2);assert.deepEqual(review.results.map(x=>x.runId),[2387,2388]);
for(const x of review.results)assert.equal(sha(await readFile(join(root,`data/ingestion-reviews/run-${x.runId}.json`))),x.originalEventSha256);
const tests=await readFile(join(dir,'2026-10-02-phase84-main-final.txt'),'utf8');
for(const line of ['tests 3883','pass 3883','fail 0','skipped 0','cancelled 0'])assert.ok(tests.includes(`ℹ ${line}`));
assert.equal(sha(await readFile(join(root,'scripts/douyin_browser_collector.mjs'))),final.code.ownerSha256);
assert.equal(sha(await readFile(join(root,'lib/collector-ownership.mjs'))),'1de41c7999e8e2040a2fb9ee60be866e51d96e7f963b3d017aee2bc9ddc21335');
const startedAt='2026-10-01T21:57:34.000Z',finishedAt=new Date().toISOString(),elapsedMs=Date.parse(finishedAt)-Date.parse(startedAt);
assert.ok(elapsedMs>0&&elapsedMs<30*60_000);
const result={startedAt,finishedAt,elapsedMs,productionFreezeAt:'2026-10-01T22:22:34.000Z',hardStopAt:'2026-10-01T22:27:34.000Z',
  tests:{full:3883,pass:3883,fail:0,skip:0,cancel:0,latestParentPeer:17,independentDefault:15,independentReal45:1},
  productionChanged:['lib/collector-ownership.mjs','scripts/douyin_browser_collector.mjs','test/collector-process-ownership.test.mjs','test/works-failure-executor.test.mjs'],
  exactCodeBackup:'/private/tmp/mcn-phase84-stage-KsXDPG/original',counts:final.counts,profile:final.profile,works:final.works,topics:final.topics,source:final.source,
  services:final.services,reviewQueue:final.reviewQueue,reviewedRunIds:[2387,2388],originalEventsPreserved:true,
  public:{url:pub.origin,version:33,verifiedAsOf:pub.asOf,publishedAt:pub.publishedAt,assets:7,parts:7,manifestFiles:2281,noDeployment:true,newLocalStagedAsOf:final.publisher.activeAsOf},
  backup:{cutoffRunId:2383,bytes:822730752,sha256:'6362eea58606483a28d08f23c6a7f2c5bb65f89be3a8ab5ba4cb60aaf432a62f',doesNotContainLaterRuns:true},
  nextPriorities:['Actual author request formation from observed normal document; no unsupported action or refusal bypass','Native ordinary cloud execution registration/readback contract, no AI timer','New ordinary backup readback after later failed observations'],
  constraints:{runtimeAI:false,newAITimers:0,newAccounts:0,manualCollections:0,siteDeployments:0,macOffFreshSamplingVerified:false,allWorksRecovered:false,allNetworksVerified:false},
  fullGoalStatus:'active-not-complete',allPhase84PeersStopped:true,noRealUserRetentionTrial:true};
await writeFile(join(dir,'2026-10-02-phase84-closeout.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({finishedAt,elapsedMinutes:Number((elapsedMs/60000).toFixed(2)),fullTests:3883,reviewedRunIds:result.reviewedRunIds,fullGoalStatus:result.fullGoalStatus}));
