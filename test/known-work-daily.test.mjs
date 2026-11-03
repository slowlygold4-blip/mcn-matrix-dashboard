import test from 'node:test';
import assert from 'node:assert/strict';
import {MonitorDatabase} from '../lib/database.mjs';
import {MonitorScheduler} from '../lib/scheduler.mjs';
import {PublicWebProvider} from '../lib/providers/public-web.mjs';
import {normalizeCollection} from '../lib/providers/normalize.mjs';
import {checksum} from '../lib/utils.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {bilibiliKnownWorkDailyState,knownWorkDailyDueTargetIds,readKnownBilibiliWorks} from '../lib/bilibili-known-works.mjs';

const NOW=Date.parse('2026-11-03T17:00:00.000Z'),mid='525138167';
const id=n=>'BV'+String(n).padStart(10,'0');
function fixture(t,count=10,file=':memory:'){
 t.mock.timers.enable({apis:['Date'],now:NOW});
 const database=new MonitorDatabase(file);t.after(()=>database.close());
 const target=database.createTarget({type:'account',provider:'public-web',locator:mid,label:'offline daily',metadata:{platform:'bilibili'}});
 for(let i=1;i<=count;i++)database.db.prepare("INSERT INTO posts(target_id,external_id,author_id,caption,first_seen_at,last_seen_at) VALUES(?,?,?,'',?,?)")
  .run(target.id,id(i),mid,'2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z');
 return {database,target,db:database.db,timers:t.mock.timers};
}
function raw(ids,{start='2026-11-03T16:00:01.000Z',finish='2026-11-03T16:00:03.000Z',observed='2026-11-03T16:00:02.000Z',failure=null}={}){
 const works=failure?[]:ids.map(aweme_id=>({aweme_id,author:{uid:mid},create_time:1789250000,statistics:{digg_count:0}}));
 return {capturedAt:finish,profile:{user:{uid:mid,follower_count:2,total_favorited:15,aweme_count:10}},works:{aweme_list:works},
 provenance:{mode:'bilibili-public-card-relation-wbi-view'},
 knownWorksEvidence:{version:1,source:'stored-account-work-ids',used:true,requestedCount:ids.length,attemptedIds:ids},
 workDetailEvidence:{errors:failure?[{contentId:ids[0],errorCode:failure}]:[]},
 workObservationTimes:{version:1,transport:'bilibili-official-http',startedAt:start,completedAt:finish,
  observations:works.map(w=>({contentId:w.aweme_id,observedAt:observed,source:'view'}))}};
}
function save(f,value){
 const previous=Date.now();f.timers.setTime(Date.parse(value.workObservationTimes.startedAt));
 const run=f.database.beginRun('scheduled',f.target.id,1),result=normalizeCollection(f.target,value,{capturedAt:value.capturedAt});
 f.timers.setTime(Date.parse(value.capturedAt));
 f.database.saveCollection(f.target,run,result);f.database.finishRun(run,{status:'success',successCount:1,warningCount:1});
 f.timers.setTime(previous);
 return run;
}

test('day selection settles successful zero likes and attempted failures separately, keeps manual refresh full',t=>{
 const f=fixture(t);save(f,raw([1,2,3,4,5,6].map(id)));
 assert.deepEqual(readKnownBilibiliWorks(f.database,f.target,mid,{dailyOnly:true}),[7,8,9,10].map(id));
 assert.equal(readKnownBilibiliWorks(f.database,f.target,mid).length,6,'manual refresh can reread today');
 save(f,raw([id(7)],{failure:'network_error',start:'2026-11-03T16:10:01.000Z',observed:'2026-11-03T16:10:02.000Z',finish:'2026-11-03T16:10:03.000Z'}));
 assert.deepEqual(bilibiliKnownWorkDailyState(f.database,f.target).pendingIds,[8,9,10].map(id));
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM post_metrics WHERE likes=0').get().n,6);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM post_metrics m JOIN posts p ON p.id=m.post_id WHERE p.external_id=?').get(id(7)).n,0);
});

test('independent work clocks cross Beijing midnight without falsely settling yesterday observations today',t=>{
 const f=fixture(t,2);save(f,raw([id(1)],{start:'2026-11-03T15:59:57.000Z',observed:'2026-11-03T15:59:59.000Z',finish:'2026-11-03T16:00:02.000Z'}));
 assert.deepEqual(bilibiliKnownWorkDailyState(f.database,f.target).pendingIds,[id(2),id(1)]);
 save(f,raw([id(2)]));
 assert.deepEqual(bilibiliKnownWorkDailyState(f.database,f.target).pendingIds,[id(1)]);
 t.mock.timers.setTime(Date.parse('2026-11-04T16:00:00.000Z'));
 assert.deepEqual(new Set(bilibiliKnownWorkDailyState(f.database,f.target).pendingIds),new Set([id(1),id(2)]));
});

test('refusal settles this known-work lane for this day, without hiding missing likes or blocking another author',t=>{
 const f=fixture(t);save(f,raw([id(1)],{failure:'blocked'}));
 const state=bilibiliKnownWorkDailyState(f.database,f.target);assert.equal(state.blocked,true);assert.deepEqual(state.pendingIds,[]);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM post_metrics').get().n,0);
 assert.deepEqual(knownWorkDailyDueTargetIds(f.database,[f.database.getTarget(f.target.id)]),[]);
 const other=f.database.createTarget({type:'account',provider:'public-web',locator:'525138168',label:'independent author',metadata:{platform:'bilibili'}});
 f.db.prepare("INSERT INTO posts(target_id,external_id,author_id,caption,first_seen_at,last_seen_at) VALUES(?,?,?,'',?,?)")
  .run(other.id,id(99),'525138168','2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z');
 assert.deepEqual(knownWorkDailyDueTargetIds(f.database,f.database.listTargets()),[other.id]);
 t.mock.timers.setTime(Date.parse('2026-11-04T16:00:00.000Z'));
 assert.equal(bilibiliKnownWorkDailyState(f.database,f.target).pendingIds.length,6);
});

test('tampered, wrong-owner, manual and future receipts cannot claim a work was attempted today',t=>{
 const f=fixture(t,1);
 for(const change of [r=>r.profile.user.uid='99999',r=>r.codexObservation={source:'manual-import'},r=>r.capturedAt='2026-11-04T16:00:00.000Z',r=>r.knownWorksEvidence.attemptedIds.push(id(1))]){
  f.db.exec('DELETE FROM snapshots');
  const value=raw([id(1)],{failure:'network_error'});change(value);
  f.db.prepare("INSERT INTO snapshots(target_id,captured_at,quality_status,raw_json,source_checksum) VALUES(?,?,'warning',?,?)")
   .run(f.target.id,value.capturedAt,JSON.stringify(value),checksum(value));
  assert.deepEqual(bilibiliKnownWorkDailyState(f.database,f.target).pendingIds,[id(1)]);
 }
 f.db.exec('DELETE FROM snapshots');const value=raw([id(1)],{failure:'network_error'});
 f.db.prepare("INSERT INTO snapshots(target_id,captured_at,quality_status,raw_json,source_checksum) VALUES(?,?,'warning',?,'wrong checksum')")
  .run(f.target.id,value.capturedAt,JSON.stringify(value));
 assert.deepEqual(bilibiliKnownWorkDailyState(f.database,f.target).pendingIds,[id(1)]);
});

test('cooldown, paused and foreign stored IDs remain out; invalid IDs cannot consume the six-row quota',t=>{
 const f=fixture(t,1);f.db.prepare("INSERT INTO posts(target_id,external_id,author_id,caption,first_seen_at,last_seen_at) VALUES(?,?,?,'',?,?)")
  .run(f.target.id,'BV!!!!!!!!!!',mid,'2020-01-01','2020-01-01');
 assert.deepEqual(bilibiliKnownWorkDailyState(f.database,f.target).pendingIds,[id(1)]);
 const target={...f.database.getTarget(f.target.id),last_checked_at:new Date(NOW-14*60_000).toISOString()};
 assert.deepEqual(knownWorkDailyDueTargetIds(f.database,[target]),[]);
 target.last_checked_at=new Date(NOW-15*60_000).toISOString();assert.deepEqual(knownWorkDailyDueTargetIds(f.database,[target]),[target.id]);
 f.database.updateTarget(target.id,{enabled:false});assert.deepEqual(bilibiliKnownWorkDailyState(f.database,target).pendingIds,[]);
});

test('continuous scheduler admits remaining known works despite fresh profiles, while manual and ordinary daily schedules retain scope',async t=>{
 const f=fixture(t,10);save(f,raw([1,2,3,4,5,6].map(id)));
 const opts={continuousWindow:{key:'offline-continuous',startsAt:'2026-11-03T16:00:00.000Z',endsAt:'9999-12-31T23:59:59.999Z'}};
 const scheduler=new MonitorScheduler(f.database,opts);t.after(()=>scheduler.stop());
 const ordinary=new MonitorScheduler(f.database,{scheduleIntervalHours:8});t.after(()=>ordinary.stop());
 assert.deepEqual(ordinary.scheduledDueTargetIds(ordinary.scheduledDateKey(),new Date(),ordinary.collectionSlot(new Date())),[],
  'ordinary eight-hour scheduling does not opt into continuous known-work rounds');
 const due=()=>scheduler.scheduledDueTargetIds(scheduler.scheduledDateKey(),new Date(),scheduler.collectionSlot(new Date()));
 assert.deepEqual(due(),[f.target.id]);
 const before=f.db.prepare('SELECT COUNT(*) n FROM snapshots').get().n;let received;
 t.mock.method(PublicWebProvider.prototype,'collect',async function(target){received=this.knownWorksDailyOnly;
  const ids=readKnownBilibiliWorks(f.database,target,mid,{dailyOnly:this.knownWorksDailyOnly});
  const value=raw(ids,{start:'2026-11-03T16:59:57.000Z',observed:'2026-11-03T16:59:58.000Z',finish:'2026-11-03T16:59:59.000Z'});
  return normalizeCollection(target,value,{capturedAt:value.capturedAt});});
 await scheduler.tick();assert.equal(received,true);assert.deepEqual(due(),[]);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM snapshots').get().n,before+1);
 assert.equal(f.db.prepare('SELECT COUNT(DISTINCT post_id) n FROM post_metrics WHERE captured_at>=?').get('2026-11-03T16:00:00.000Z').n,10);
 await scheduler.runAll({triggerType:'manual-refresh'});assert.equal(received,false,'explicit refresh still resamples all known IDs');
});

test('the real disposable read-only planner reads durable pending works and does not depend on process-local progress',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mcn-known-work-daily-'));
 const f=fixture(t,10,join(directory,'fixture.sqlite'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 save(f,raw([1,2,3,4,5,6].map(id)));
 const scheduler=new MonitorScheduler(f.database,{asyncPlanning:true,
  continuousWindow:{key:'durable-fixture',startsAt:'2026-11-03T16:00:00.000Z',endsAt:'9999-12-31T23:59:59.999Z'}});
 try{
  const result=await scheduler.readPlanning('tick',new Date());
  assert.deepEqual(result.dueIds,[f.target.id]);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM snapshots').get().n,1);
 }finally{await scheduler.stop();}
});

test('actual provider passes only pending IDs to the unchanged Python transport and explicit manual refresh can repeat IDs',async t=>{
 const f=fixture(t);save(f,raw([1,2,3,4,5,6].map(id)));const requests=[],preferFlags=[];
 const execFileImpl=(_file,args,_options,done)=>{
  const selected=args.flatMap((arg,i)=>arg==='--known-work'?[args[i+1]]:[]);requests.push(selected);preferFlags.push(args.includes('--prefer-known-works'));
  done(null,JSON.stringify({ok:true,data:raw(selected)}),'');
 };
 const automatic=new PublicWebProvider({}, {database:f.database,knownWorksDailyOnly:true,cooldownMs:0,execFileImpl});
 const observed=await automatic.collect(f.target);assert.deepEqual(requests[0],[7,8,9,10].map(id));
 assert.equal(observed.posts.length,4);assert.equal(observed.worksCoverage,'limited');
 const manual=new PublicWebProvider({}, {database:f.database,cooldownMs:0,execFileImpl});
 await manual.collect(f.target);assert.equal(requests[1].length,6);
 assert.deepEqual(preferFlags,[true,false]);
 assert.equal(requests[1].some(value=>[1,2,3,4,5,6].map(id).includes(value)),true);
});
