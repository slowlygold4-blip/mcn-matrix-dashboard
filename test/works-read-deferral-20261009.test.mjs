import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { loadWorksObservations } from '../lib/works-observation.mjs';
import { publicAccountCoverage } from '../lib/public-account-coverage.mjs';
import { recordWorksOnlyObservation, initializeWorksOnlyObservations } from '../lib/works-only-observation.mjs';
import { loadVerifiedDeferredSnapshotIds, loadDeferredWorksSnapshotRead, DEFERRED_SNAPSHOT_LOOKBACK, MAX_DEFERRED_READ_BYTES } from '../lib/works-deferred-read.mjs';

const SEC='MS4wLjABAAAAzero_request_both_reads_0123456789', UID='1234567890123';
const ANCHOR='2026-10-09T09:00:00.000Z', START='2026-10-09T09:01:00.000Z', PAGE='2026-10-09T09:01:01.000Z', END='2026-10-09T09:01:02.000Z';
const LATER='2026-10-09T09:10:00.000Z', ASOF='2026-10-09T10:00:00.000Z';
const iso=value=>new Date(value).toISOString();
function profile(at){
  const mode='guest-ttwid-unsigned-profile';
  return {capturedAt:at,accountStatus:'validated',accountError:null,
    profile:{user:{sec_uid:SEC,uid:UID,follower_count:100,total_favorited:200,aweme_count:1}},
    worksCoverage:'unavailable',worksErrorCode:'deferred',works:{stopReason:'request-deferred',pagination:{requestCount:0,pages:[]}},
    provenance:{mode,profileMode:mode,profileEndpoint:'https://www.douyin.com/aweme/v1/web/user/profile/other/',accountLocator:'sec_uid',cookiePersisted:false,runtimeAI:false,paidAPI:false},
    worksRequestPolicy:{version:1,endpoint:'douyin.author_posts',scope:'endpoint-transport',
      anonymous:{transport:'anonymous-http',attempted:false,deferred:true,errorCode:'blocked'},
      browser:{transport:'authorised-browser',attempted:false,deferred:false,errorCode:null}},
    worksFallbackDeferred:{version:1,reason:'scheduled-profile-priority',mode:'works-only'}};
}
function fixture(t,{works=true}={}){
  t.mock.timers.enable({apis:['Date'],now:Date.parse(ANCHOR)});
  const database=new MonitorDatabase(':memory:');t.after(()=>database.close());
  const target=database.createTarget({type:'account',provider:'public-web',label:'offline',locator:SEC,metadata:{platform:'douyin'}});
  const save=(at=LATER,mutate=()=>{})=>{
    t.mock.timers.setTime(Date.parse(at));const raw=profile(at);mutate(raw);
    const run=database.beginRun('scheduled',target.id,1);database.saveCollection(target,run,normalizeCollection(target,raw,{capturedAt:at}));
    database.finishRun(run,{status:'success',successCount:1});
    return database.db.prepare('SELECT * FROM snapshots ORDER BY id DESC LIMIT 1').get();
  };
  const anchor=save(ANCHOR);initializeWorksOnlyObservations(database.db);
  if(works){
    t.mock.timers.setTime(Date.parse(START));const runId=database.beginRun('works-only',target.id,1);
    t.mock.timers.setTime(Date.parse(END));
    recordWorksOnlyObservation(database.db,{targetId:target.id,runId,anchorSnapshotId:anchor.id,anchorChecksum:anchor.source_checksum,
      requestStartedAt:START,requestFinishedAt:END,result:{status:'ok',posts:[{aweme_id:'7200000000000000001',author:{sec_uid:SEC,uid:UID},statistics:{digg_count:1}}],
        hasMore:false,maxCursor:0,pagination:{version:1,maxPages:3,requestCount:1,collectedCount:1,stopReason:'end-of-list',errorCode:null,
          pages:[{requestCursor:0,response:{max_cursor:0,has_more:false},rawCount:1,acceptedCount:1,duplicateCount:0,filteredCount:0,truncated:false,observedAt:PAGE}]}}});
    database.finishRun(runId,{status:'success',successCount:1});
  }
  const read=(asOf=ASOF)=>{
    t.mock.timers.setTime(Date.parse(ASOF)+1);
    const local=loadWorksObservations(database,asOf,target.id).get(target.id);
    const stored=database.db.prepare('SELECT * FROM targets WHERE id=?').get(target.id);
    const published=publicAccountCoverage(database.db,stored,{asOf,verifiedDaily:[{date:'2026-10-09'}]});
    return {local,published};
  };
  return{database,target,save,read};
}

test('both readers retain a verified work observation after a source-verified zero-request profile update',t=>{
  const f=fixture(t);f.save();const before=f.database.db.prepare('SELECT total_changes() n').get().n;f.database.db.exec('PRAGMA query_only=ON');
  const result=f.read();
  assert.equal(result.local.coverage,'complete');assert.equal(result.local.carriedForward,false);
  assert.equal(result.local.observedAt,PAGE);assert.equal(result.local.lastAttemptAt,END);
  assert.equal(result.published.works.status,'complete');assert.equal(result.published.works.observedAt,PAGE);assert.equal(result.published.works.attemptedAt,END);
  assert.equal(result.published.profileObservedAt,LATER);
  assert.equal(f.database.db.prepare('SELECT total_changes() n').get().n,before);
});

test('a real failed snapshot between success and deferral cannot be skipped to resurrect success',t=>{
  const f=fixture(t);const failedAt='2026-10-09T09:05:00.000Z';
  f.save(failedAt,raw=>{raw.worksErrorCode='blocked';raw.works.stopReason='request-failed';raw.works.pagination.requestCount=1;raw.worksRequestPolicy.anonymous.attempted=true;});
  f.save();const result=f.read();
  assert.equal(result.local.coverage,'unavailable');assert.equal(result.local.lastAttemptAt,failedAt);assert.equal(result.local.observedAt,PAGE);assert.equal(result.local.carriedForward,true);
  assert.equal(result.published.works.status,'unavailable');assert.equal(result.published.works.attemptedAt,failedAt);assert.equal(result.published.works.observedAt,PAGE);
});

test('deferral-only history does not become a works attempt or a successful empty list',t=>{
  const f=fixture(t,{works:false});f.save();const result=f.read();
  assert.ok(!result.local || result.local.coverage==='unknown');
  assert.deepEqual(result.published.works,{status:'missing',attemptedAt:null,observedAt:null});
  assert.equal(result.published.profileObservedAt,LATER);
});

test('an unknown legacy source stays latest even when its stored label says deferred',t=>{
  const f=fixture(t);f.save(LATER,raw=>{delete raw.worksRequestPolicy;});const result=f.read();
  assert.equal(result.local.coverage,'unavailable');assert.equal(result.local.lastAttemptAt,LATER);
  assert.equal(result.published.works.status,'unavailable');assert.equal(result.published.works.attemptedAt,LATER);
});

test('a future deferral never participates in an earlier as-of read',t=>{
  const f=fixture(t);f.save();const result=f.read('2026-10-09T09:09:59.999Z');
  assert.equal(result.local.coverage,'complete');assert.equal(result.local.lastAttemptAt,END);
  assert.equal(result.published.works.status,'complete');assert.equal(result.published.profileObservedAt,ANCHOR);
});

test('an already verified ledger cutoff only reduces exclusions and does not refresh observation time',t=>{
  const f=fixture(t),saved=f.save();
  const all=loadVerifiedDeferredSnapshotIds(f.database.db,ASOF,f.target.id);
  const bounded=loadVerifiedDeferredSnapshotIds(f.database.db,ASOF,f.target.id,new Map([[f.target.id,END]]));
  assert.equal(all.size,2);assert.deepEqual([...bounded],[saved.id]);
  const future=loadVerifiedDeferredSnapshotIds(f.database.db,ASOF,f.target.id,new Map([[f.target.id,'2026-10-10T00:00:00.000Z']]));
  assert.deepEqual([...future],[...all]);
  // Even an invalid caller hint cannot make a row trusted: it only leaves it
  // in the existing latest selection, never adds it to the excluded IDs.
  const untrusted=loadVerifiedDeferredSnapshotIds(f.database.db,ASOF,f.target.id,new Map([[f.target.id,ASOF]]));
  assert.equal(untrusted.size,0);
  const result=f.read();assert.equal(result.local.observedAt,PAGE);assert.equal(result.local.lastAttemptAt,END);
});

for(const count of [DEFERRED_SNAPSHOT_LOOKBACK,DEFERRED_SNAPSHOT_LOOKBACK+1])test(`bounded newest prefix retains an unverified barrier after ${count} deferrals`,t=>{
  const f=fixture(t);for(let i=0;i<count;i++)f.save(iso(Date.parse(LATER)+i*1000));
  const ignored=loadVerifiedDeferredSnapshotIds(f.database.db,ASOF,f.target.id);
  assert.equal(ignored.size,DEFERRED_SNAPSHOT_LOOKBACK);
  const result=f.read(),exhausted=count>DEFERRED_SNAPSHOT_LOOKBACK;
  assert.equal(result.local.coverage,exhausted?'unavailable':'complete');
  assert.equal(result.local.lastAttemptAt,exhausted?LATER:END);
  assert.equal(result.published.works.status,exhausted?'unavailable':'complete');
  assert.equal(result.published.works.observedAt,PAGE);
});

for(const [name,mutate]of[
  ['audit checksum',(db,id)=>db.prepare("UPDATE audits SET source_checksum='wrong' WHERE source_checksum=(SELECT source_checksum FROM snapshots WHERE id=?)").run(id)],
  ['audit target',(db,id)=>db.prepare('UPDATE audits SET target_id=NULL WHERE source_checksum=(SELECT source_checksum FROM snapshots WHERE id=?)').run(id)],
  ['audit provider',(db,id)=>db.prepare("UPDATE audits SET provider='manual' WHERE source_checksum=(SELECT source_checksum FROM snapshots WHERE id=?)").run(id)],
  ['run start',(db,id)=>db.prepare('UPDATE runs SET started_at=? WHERE id=(SELECT run_id FROM audits WHERE source_checksum=(SELECT source_checksum FROM snapshots WHERE id=?))').run('2026-10-09T09:11:00.000Z',id)],
  ['run future finish',(db,id)=>db.prepare('UPDATE runs SET finished_at=? WHERE id=(SELECT run_id FROM audits WHERE source_checksum=(SELECT source_checksum FROM snapshots WHERE id=?))').run('2026-10-09T10:00:01.000Z',id)],
  ['run foreign target',(db,id)=>{const other=db.prepare("INSERT INTO targets(type,label,locator,provider,created_at,updated_at) VALUES('account','other','MS4wLjABAAAAforeign_defer_fixture_0123456789','public-web',?,?)").run(ANCHOR,ANCHOR);db.prepare('UPDATE runs SET target_id=? WHERE id=(SELECT run_id FROM audits WHERE source_checksum=(SELECT source_checksum FROM snapshots WHERE id=?))').run(Number(other.lastInsertRowid),id);}],
  ['raw hash',(db,id)=>db.prepare("UPDATE snapshots SET raw_json=replace(raw_json,'1234567890123','1234567890124') WHERE id=?").run(id)],
  ['metadata corruption',(db)=>db.prepare("UPDATE targets SET metadata_json='{broken'").run()],
])test(`adapter cannot exclude a row with invalid ${name}`,t=>{
  const f=fixture(t),saved=f.save();mutate(f.database.db,saved.id);
  const ignored=loadVerifiedDeferredSnapshotIds(f.database.db,ASOF,f.target.id);
  assert.equal(ignored.has(saved.id),false);
  const local=loadWorksObservations(f.database,ASOF,f.target.id).get(f.target.id);
  assert.equal(local.coverage,'unavailable');assert.equal(local.lastAttemptAt,LATER);
});

test('candidate raw payload is streamed and oversized sources stay as unknown/failed barriers',t=>{
  const f=fixture(t);const saved=f.save(LATER,raw=>{raw.padding='x'.repeat(150000);});
  const returned=[];
  const wrapped=new Proxy(f.database.db,{get(db,key){if(key!=='prepare')return typeof db[key]==='function'?db[key].bind(db):db[key];return sql=>{
    const stmt=db.prepare(sql);if(!sql.includes('WITH selected_targets'))return stmt;
    return{*iterate(...args){for(const row of stmt.iterate(...args)){returned.push({id:row.id,rawLength:row.raw_json?.length??0});yield row;}}};
  };}});
  assert.equal(loadVerifiedDeferredSnapshotIds(wrapped,ASOF,f.target.id).has(saved.id),false);
  assert.equal(returned.find(row=>row.id===saved.id).rawLength,0);
  assert.equal(f.read().published.works.status,'unavailable');
});

test('global decode budget leaves unverified account prefixes in latest selection rather than treating them as success',t=>{
  const f=fixture(t,{works:false}),pad='x'.repeat(120000),created=[];
  for(let i=0;i<75;i++){
    const target=f.database.createTarget({type:'account',provider:'public-web',label:`budget${i}`,locator:SEC+String(i),metadata:{platform:'douyin'}});
    t.mock.timers.setTime(Date.parse(LATER));const raw=profile(LATER);raw.profile.user.sec_uid=target.locator;raw.padding=pad;
    const run=f.database.beginRun('scheduled',target.id,1);f.database.saveCollection(target,run,normalizeCollection(target,raw,{capturedAt:LATER}));
    f.database.finishRun(run,{status:'success',successCount:1});
    created.push(f.database.db.prepare('SELECT id,length(raw_json) bytes FROM snapshots WHERE target_id=?').get(target.id));
  }
  const failedTarget=f.database.createTarget({type:'account',provider:'public-web',label:'actual failure after budget',locator:SEC+'failed',metadata:{platform:'douyin'}});
  const failedRaw=profile(LATER);failedRaw.profile.user.sec_uid=failedTarget.locator;
  failedRaw.worksErrorCode='blocked';failedRaw.works.stopReason='request-failed';failedRaw.works.pagination.requestCount=1;
  failedRaw.worksRequestPolicy.anonymous.attempted=true;
  const failedRun=f.database.beginRun('scheduled',failedTarget.id,1);
  f.database.saveCollection(failedTarget,failedRun,normalizeCollection(failedTarget,failedRaw,{capturedAt:LATER}));
  f.database.finishRun(failedRun,{status:'success',successCount:1});
  const before=f.database.db.prepare('SELECT total_changes() n').get().n;f.database.db.exec('PRAGMA query_only=ON');
  const ignored=loadVerifiedDeferredSnapshotIds(f.database.db,ASOF);
  assert.ok(ignored.size>1&&ignored.size<75);
  assert.ok(created.filter(row=>ignored.has(row.id)).reduce((sum,row)=>sum+row.bytes,0)<=MAX_DEFERRED_READ_BYTES);
  assert.equal(ignored.has(created.at(-1).id),false);
  const result=loadWorksObservations(f.database,ASOF);
  assert.equal(result.get(76).coverage,'unknown');assert.equal(result.get(76).lastAttemptAt,null);
  assert.equal(result.get(76).verificationReason,'verification-budget-limit');
  assert.equal(result.get(failedTarget.id).coverage,'unavailable');assert.equal(result.get(failedTarget.id).lastAttemptAt,LATER);
  assert.equal(result.get(failedTarget.id).verificationReason,undefined);
  const bounded=loadDeferredWorksSnapshotRead(f.database.db,ASOF);
  assert.equal(bounded.budgetLimitedSnapshotIds.has(created.at(-1).id),true);
  assert.equal(f.database.db.prepare('SELECT total_changes() n').get().n,before);
});

test('bounded global verification visits every newest candidate before older prefixes can consume the budget',t=>{
  const f=fixture(t,{works:false}),targets=[];
  for(let i=0;i<8;i++){
    const target=f.database.createTarget({type:'account',provider:'public-web',label:`round${i}`,locator:SEC+String(i),metadata:{platform:'douyin'}});
    targets.push(target);
    for(let j=0;j<(i===7?1:DEFERRED_SNAPSHOT_LOOKBACK);j++){
      const at=iso(Date.parse(LATER)+j*1000);t.mock.timers.setTime(Date.parse(at));
      const raw=profile(at);raw.profile.user.sec_uid=target.locator;raw.padding='x'.repeat(120000);
      const run=f.database.beginRun('scheduled',target.id,1);f.database.saveCollection(target,run,normalizeCollection(target,raw,{capturedAt:at}));
      f.database.finishRun(run,{status:'success',successCount:1});
    }
  }
  const newest=f.database.db.prepare('SELECT id FROM snapshots WHERE target_id=? ORDER BY id DESC LIMIT 1').get(targets.at(-1).id);
  const ignored=loadVerifiedDeferredSnapshotIds(f.database.db,ASOF);
  assert.equal(ignored.has(newest.id),true);
  const bytes=f.database.db.prepare('SELECT SUM(length(raw_json)) bytes FROM snapshots WHERE id IN (SELECT value FROM json_each(?))').get(JSON.stringify([...ignored])).bytes;
  assert.ok(bytes<=MAX_DEFERRED_READ_BYTES);
});
