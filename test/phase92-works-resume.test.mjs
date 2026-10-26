import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitorDatabase } from '../lib/database.mjs';
import { MonitorScheduler } from '../lib/scheduler.mjs';
import { buildPostIngestionReview } from '../lib/post-ingestion-review.mjs';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { BrowserWorksPagination } from '../lib/browser-works-pagination.mjs';
import { loadVerifiedWorksOnlyRows, loadWorksObservations } from '../lib/works-observation.mjs';
import { inspectUpdateSla } from '../lib/update-sla.mjs';
import { recordWorksOnlyObservation, readWorksOnlyAnchor } from '../lib/works-only-observation.mjs';

const NOW = Date.parse('2026-09-29T02:01:00.000Z');
const SEC = 'MS4wLjABAAAAPhase92ResumeAccount123456';
const UID = '12345678';
const post = n => ({ aweme_id: String(7200000000000000000n + BigInt(n)), author: {sec_uid: SEC, uid: UID}, statistics: {digg_count:n} });

function setup(t) {
  t.mock.timers.enable({apis:['Date'], now:NOW});
  const directory = mkdtempSync(join(tmpdir(), 'phase92-works-sqlite-'));
  const path = join(directory, 'test.sqlite');
  let database = new MonitorDatabase(path);
  const target = database.createTarget({type:'account', provider:'public-web', label:'isolated test', locator:SEC});
  t.after(() => { database.close(); rmSync(directory,{recursive:true,force:true}); });
  const anchor = (totalPosts = 60) => {
    const raw = {capturedAt:new Date().toISOString(),accountStatus:'validated',accountError:null,
      profile:{user:{sec_uid:SEC,uid:UID,follower_count:20,total_favorited:40,aweme_count:totalPosts}},
      worksCoverage:'unavailable',worksErrorCode:'deferred',works:{stopReason:'request-deferred',pagination:{requestCount:0,pages:[]}},
      provenance:{mode:'guest-ttwid-unsigned-profile',profileMode:'guest-ttwid-unsigned-profile',
        profileEndpoint:'https://www.douyin.com/aweme/v1/web/user/profile/other/',accountLocator:'sec_uid',cookiePersisted:false,runtimeAI:false,paidAPI:false}};
    const run = database.beginRun('scheduled',target.id,1);
    database.saveCollection(target,run,normalizeCollection(target,raw,{capturedAt:raw.capturedAt}));
    database.finishRun(run,{status:'success',successCount:1,processedCount:1});
    t.mock.timers.setTime(Date.now()+1000);
  };
  const scheduler = () => new MonitorScheduler(database,{scheduleIntervalHours:8,worksOnlyEnabled:true,
    providerOptions:{accountBrowserFallback:true,execFileImpl:()=>{throw Error('NO_EXTERNAL_PROCESS');}, fetchImpl:()=>{throw Error('NO_NETWORK');}}});
  const reopen = () => { database.close(); database = new MonitorDatabase(path); };
  return {get database(){return database;},target,anchor,scheduler,reopen};
}

function response(t, item, pages) {
  const ledger = new BrowserWorksPagination({limit:item.limit, requestThreshold:item.requestThreshold, startCursor:item.startCursor});
  for (const [cursor, next, more, first, count] of pages) {
    t.mock.timers.setTime(Date.now()+20);
    const posts = Array.from({length:count},(_,i)=>post(first+i));
    ledger.accept({requestCursor:cursor,body:{aweme_list:posts,has_more:more},
      normalized:{posts,maxCursor:next,filteredCount:0,duplicateCount:0,locallyTruncated:false},observedAt:new Date().toISOString()});
  }
  return {items:[{key:item.key,status:'ok',errorCode:null,...ledger.result(pages.length)}]};
}

test('ordinary scheduler/provider persist a new-anchor continuation across disk reopen and reread the truncated request page',async t=>{
  const f=setup(t); const requests=[];
  t.mock.method(PublicWebProvider.prototype,'runBrowserWorks',async item=>{
    requests.push({...item});
    const pageSets=[[[0,100,true,1,20],[100,200,true,21,20]],[[100,200,true,21,20],[200,300,true,41,20]],[[200,0,false,41,20]]];
    return response(t,item,pageSets[requests.length-1]);
  });
  f.anchor(); await f.scheduler().tick();
  const first=f.database.db.prepare('SELECT * FROM works_observations').get();
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM posts').get().n,30);
  assert.equal(JSON.parse(first.raw_json).pagination.pages.at(-1).truncated,true);
  for(let round=1;round<3;round++) {
    f.reopen(); t.mock.timers.setTime(NOW+round*8*3600_000); f.anchor();
    await f.scheduler().tick();
  }
  assert.deepEqual(requests.map(item=>item.startCursor??0),[0,100,200]);
  assert.ok(requests.every(item=>item.limit===30 && item.requestThreshold===undefined));
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM posts').get().n,60);
  const rows=f.database.db.prepare('SELECT * FROM works_observations ORDER BY id').all();
  assert.equal(rows.length,3); assert.ok(rows.every(row=>row.coverage==='limited'));
  assert.equal(rows[0].source_checksum,first.source_checksum); assert.equal(rows[0].raw_json,first.raw_json);
  assert.notEqual(rows[0].anchor_snapshot_id,rows[1].anchor_snapshot_id);
  const raw=JSON.parse(rows[1].raw_json);
  assert.equal(raw.version,2); assert.equal(raw.continuation.sourceChecksum,first.source_checksum);
  assert.equal(raw.pagination.version,3); assert.equal(raw.pagination.pages[0].requestCursor,100);
  const verified=loadVerifiedWorksOnlyRows(f.database.db,new Date().toISOString(),f.target.id,{runIds:rows.map(row=>row.run_id)});
  assert.equal(verified.length,3);
  assert.ok(verified.every(row=>row.coverage==='limited'), 'immutable source evidence stays limited');
  const final=verified.find(row=>row.run_id===rows.at(-1).run_id);
  assert.equal(final.works_coverage,'complete', 'a verified head-to-end chain matching every profile inventory is complete in the read model');
  assert.equal(final.list_count,60);
  assert.equal(JSON.parse(final.entries_json).length,60);
  assert.equal(final.coverage_evidence?.kind,'verified-public-cursor-chain');
  assert.match(final.coverage_evidence.publicPostIdsChecksum,/^[a-f\d]{64}$/);
  assert.equal(loadWorksObservations(f.database,new Date().toISOString(),f.target.id).get(f.target.id).coverage,'complete');
  const completeSla=inspectUpdateSla(f.database.db,{now:new Date(),includeTargets:true}).works.fresh8h;
  assert.equal(completeSla.counts.complete,1,'the latest verified cursor chain is counted while it is the freshest works observation');
  const receipt=buildPostIngestionReview({database:f.database,runId:final.run_id,now:new Date()});
  assert.equal(receipt.account.worksComplete,1);
  assert.equal(receipt.account.worksLimited,0);
  assert.equal(receipt.samples[0].worksCoverage,'complete');
  assert.deepEqual(receipt.findings,[]);
  t.mock.timers.setTime(Date.now()+1000);
  f.anchor();
  const supersededSla=inspectUpdateSla(f.database.db,{now:new Date(),includeTargets:true}).works.fresh8h;
  assert.equal(supersededSla.counts.complete,0,'a newer profile whose works endpoint is unavailable supersedes the older complete list');
  assert.equal(supersededSla.counts.unavailable,1);
  assert.equal(f.database.getSettings().publicWorksPageMode,'legacy');
});

test('a changing profile inventory across a cursor chain remains limited',async t=>{
  const f=setup(t); const requests=[];
  t.mock.method(PublicWebProvider.prototype,'runBrowserWorks',async item=>{
    requests.push({...item});
    const pageSets=[[[0,100,true,1,20],[100,200,true,21,20]],[[100,200,true,21,20],[200,300,true,41,20]],[[200,0,false,41,20]]];
    return response(t,item,pageSets[requests.length-1]);
  });
  f.anchor(60); await f.scheduler().tick();
  t.mock.timers.setTime(NOW+8*3600_000); f.anchor(61); await f.scheduler().tick();
  t.mock.timers.setTime(NOW+16*3600_000); f.anchor(60); await f.scheduler().tick();
  const final=loadVerifiedWorksOnlyRows(f.database.db,new Date().toISOString(),f.target.id)[0];
  assert.equal(final?.works_coverage,'limited');
  assert.equal(final?.coverage_evidence,undefined);
});

test('forged predecessor, skipped truncated cursor and stale-anchor append reject without new posts',async t=>{
  const f=setup(t); f.anchor();
  t.mock.method(PublicWebProvider.prototype,'runBrowserWorks',async item=>response(t,item,[[0,100,true,1,20],[100,200,true,21,20]]));
  await f.scheduler().tick();
  t.mock.timers.setTime(NOW+8*3600_000);f.anchor();
  const anchor=readWorksOnlyAnchor(f.database.db,f.target.id);
  const source=f.database.db.prepare('SELECT * FROM works_observations').get();
  const originalCount=f.database.db.prepare('SELECT count(*) n FROM post_metrics').get().n;
  for(const tamper of ['hash','cursor','anchor']) {
    const runId=f.database.beginRun('works-only',f.target.id,1), started=new Date().toISOString();
    const item={key:String(f.target.id),limit:30,startCursor:tamper==='cursor'?200:100};
    const result=response(t,item,[[item.startCursor,300,true,21,30]]).items[0];
    assert.throws(()=>recordWorksOnlyObservation(f.database.db,{targetId:f.target.id,runId,
      anchorSnapshotId:tamper==='anchor'?source.anchor_snapshot_id:anchor.snapshotId,anchorChecksum:anchor.sourceChecksum,
      requestStartedAt:started,requestFinishedAt:new Date().toISOString(),requestedLimit:30,result,
      continuation:{version:1,observationId:source.id,runId:source.run_id,
        sourceChecksum:tamper==='hash'?'0'.repeat(64):source.source_checksum,cursor:item.startCursor,depth:1}}));
    f.database.finishRun(runId,{status:'error',processedCount:1,errorCount:1});
  }
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM works_observations').get().n,1);
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM post_metrics').get().n,originalCount);
});

test('ordinary provider persists a legal natural head as independent evidence after explicitly abandoning resume',async t=>{
  const f=setup(t);const requests=[];
  t.mock.method(PublicWebProvider.prototype,'runBrowserWorks',async item=>{
    requests.push(item);
    if(requests.length===1)return response(t,item,[[0,100,true,1,20],[100,200,true,21,20]]);
    const output=response(t,{...item,startCursor:undefined},[[0,0,false,99,1]]);
    output.items[0].continuationReset='natural-head';return output;
  });
  f.anchor();await f.scheduler().tick();f.reopen();t.mock.timers.setTime(NOW+8*3600_000);f.anchor();await f.scheduler().tick();
  assert.equal(requests[1].startCursor,100);
  const rows=f.database.db.prepare('SELECT * FROM works_observations ORDER BY id').all();assert.equal(rows.length,2);
  const latest=JSON.parse(rows[1].raw_json);assert.equal(latest.status,'accepted');assert.equal(latest.version,1);
  assert.equal(latest.continuation,undefined);assert.equal(latest.pagination.pages[0].requestCursor,0);
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM posts').get().n,31);
  assert.equal(loadVerifiedWorksOnlyRows(f.database.db,new Date().toISOString(),f.target.id).length,2);
});

test('an oversized single page remains limited and cannot manufacture an advancing continuation chain',async t=>{
  const f=setup(t);const requests=[];
  t.mock.method(PublicWebProvider.prototype,'runBrowserWorks',async item=>{requests.push(item);return response(t,item,[[0,100,true,1,31]]);});
  for(let round=0;round<3;round++){t.mock.timers.setTime(NOW+round*8*3600_000);f.anchor();await f.scheduler().tick();f.reopen();}
  assert.deepEqual(requests.map(item=>item.startCursor),[undefined,undefined,undefined]);
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM posts').get().n,30);
  const raws=f.database.db.prepare('SELECT raw_json FROM works_observations').all().map(row=>JSON.parse(row.raw_json));
  assert.ok(raws.every(raw=>raw.coverage==='limited'&&raw.continuation===undefined&&raw.pagination.pages[0].truncated));
});
