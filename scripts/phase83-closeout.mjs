// Validate closeout from persisted evidence; no sampling, source or Site writes.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),journal=join(root,'data/maintenance-journal'),sha=b=>createHash('sha256').update(b).digest('hex');
const json=async name=>JSON.parse(await readFile(join(journal,name)));
const [initial,final,publicProof,review,peer]=await Promise.all(['runtime-initial','runtime-final','public-readback','reviewed-events','callchain-final'].map(name=>json('2026-10-02-phase83-'+name+'.json')));
for(const key of ['targets','snapshots','posts','post_metrics'])assert.equal(initial.counts[key],final.counts[key]);
assert.equal(final.counts.works_observations-initial.counts.works_observations,1);assert.equal(final.counts.maxRun,2386);
assert.equal(final.counts.activeRuns,0);assert.deepEqual(initial.services,final.services);assert.equal(initial.source.sha256,final.source.sha256);
assert.equal(final.publisher.status,'success');assert.equal(final.publisher.activeAsOf,null);assert.equal(final.publisher.publishedAsOf,publicProof.asOf);
assert.equal(publicProof.assets.length,7);assert.equal(publicProof.parts.length,7);assert.equal(publicProof.manifestFiles,2281);
assert.equal(final.code.ownerSha256,'f0b67d310e255aa9a6d2f5b32762a49660b437442f0f20ed49a8c4efedf51b61');
assert.equal(sha(await readFile(join(root,'scripts/douyin_browser_collector.mjs'))),final.code.ownerSha256);
assert.equal(peer.ordinary.exitCode,0);assert.equal(peer.ordinary.tests,29);assert.equal(peer.chrome.exitCode,0);assert.equal(peer.chrome.scenarios,2);
const tests=await readFile(join(journal,'2026-10-02-phase83-main-final.txt'),'utf8');assert.match(tests,/ℹ pass 3850/);assert.match(tests,/ℹ fail 0/);
for(const item of review.results)assert.equal(sha(await readFile(join(root,`data/ingestion-reviews/run-${item.runId}.json`))),item.originalEventSha256);
const startedAt='2026-10-01T21:35:09.000Z',finishedAt=new Date().toISOString(),elapsedMs=Date.parse(finishedAt)-Date.parse(startedAt);
assert.ok(elapsedMs<30*60_000);
const result={startedAt,finishedAt,elapsedMs,productionFreezeAt:'2026-10-01T22:00:09.000Z',hardStopAt:'2026-10-01T22:05:09.000Z',
  tests:{full:3850,fail:0,skip:0,cancel:0,related:71,legacyContracts:111,independent:41,isolatedChromeScenarios:2},
  productionChanged:['scripts/douyin_browser_collector.mjs'],codeBackup:'/private/tmp/mcn-phase83-code-CVRphW',sourceAndRosterPreserved:true,
  counts:final.counts,profile:final.profile,works:final.works,topics:final.topics,source:final.source,services:final.services,
  reviewQueue:final.reviewQueue,reviewedRunIds:review.results.map(x=>x.runId),originalEventsPreserved:true,
  public:{url:publicProof.origin,version:33,asOf:publicProof.asOf,publishedAt:publicProof.publishedAt,assetsVerified:7,partsVerified:7,manifestFiles:2281,noDeployment:true},
  reusedBackup:{bytes:822730752,sha256:'6362eea58606483a28d08f23c6a7f2c5bb65f89be3a8ab5ba4cb60aaf432a62f',maxRun:2383,doesNotContainRuns:[2384,2385,2386]},
  nextPriorities:['Trusted parent execution deadline to child with real-process proof','Native Sites Cron registration and readback contract','Actual author works request formation; no unsupported selector or refusal bypass'],
  constraints:{runtimeAI:false,newAITimers:0,newAccounts:0,manualCollections:0,siteDeployments:0,macOffFreshSamplingVerified:false,allWorksRecovered:false,allNetworksVerified:false},
  fullGoalStatus:'active-not-complete',allPeersStopped:true,noRealUserRetentionTrial:true};
await writeFile(join(journal,'2026-10-02-phase83-closeout.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({finishedAt,elapsedMinutes:Number((elapsedMs/60000).toFixed(2)),fullTests:3850,reviewedRunIds:result.reviewedRunIds,
  publicAsOf:result.public.asOf,profile:result.profile.complete,completeWorks:result.works.complete,topics:result.topics.complete,fullGoalStatus:result.fullGoalStatus}));
