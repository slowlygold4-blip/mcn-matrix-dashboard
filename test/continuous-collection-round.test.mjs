import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ContinuousCollectionRound} from '../lib/continuous-collection-round.mjs';
import {MonitorDatabase} from '../lib/database.mjs';
import {MonitorScheduler} from '../lib/scheduler.mjs';
function setup(t){const dir=mkdtempSync(join(tmpdir(),'mcn-continuous-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'round.json');const store=new ContinuousCollectionRound(path,'2026-10-26T02:00:00.000Z');return{path,store};}
test('round survives midnight, scheduled slot boundaries and process restarts',t=>{const{path,store}=setup(t),key=store.window(new Date('2026-10-26T03:00:00Z')).key;assert.equal(store.window(new Date('2026-10-27T05:00:00Z')).key,key);assert.equal(new ContinuousCollectionRound(path,'2026-10-27T00:00:00Z').window().key,key);assert.equal(store.advance('stale',new Date('2026-10-27T05:00:00Z')),false);assert.equal(store.advance(key,new Date('2026-10-27T05:00:00Z')),true);assert.equal(new ContinuousCollectionRound(path,'ignored').window().startsAt,'2026-10-27T05:00:00.000Z');});
test('continuous status has no fixed schedule or next clock time and readonly planner shares round',t=>{const{store}=setup(t);const db=new MonitorDatabase(':memory:');t.after(()=>db.close());const s=new MonitorScheduler(db,{continuousRoundStore:store,worksOnlyEnabled:true});const now=new Date('2026-10-26T05:00:00Z');const status=s.getStatus(now);assert.equal(status.scheduleMode,'continuous');assert.equal(status.scheduleIntervalHours,null);assert.deepEqual(status.slotTimes,[]);assert.equal(status.nextRunAt,null);const worker=new MonitorScheduler(db,{continuousWindow:s.collectionSlot(now)});assert.equal(worker.collectionSlot(now).key,s.collectionSlot(now).key);});
test('settled profile pass advances, pending profile retries and active collection do not',async t=>{const{store}=setup(t);const db=new MonitorDatabase(':memory:');t.after(()=>db.close());const s=new MonitorScheduler(db,{continuousRoundStore:store,asyncPlanning:true,worksOnlyEnabled:true});let settled=false;const now=new Date();s.readPlanning=async()=>({asOf:now.toISOString(),slotKey:s.collectionSlot(now).key,dueIds:[],worksTargetId:null,roundSettled:settled,profilePassSettled:settled});let key=store.window().key;await s.tick(now);assert.equal(store.window().key,key);settled=true;await s.tick(now);assert.notEqual(store.window().key,key);key=store.window().key;s.running=true;await s.tick(now);assert.equal(store.window().key,key);});
test('real readonly planning worker receives the persisted continuous window',async t=>{const{path,store}=setup(t);const db=new MonitorDatabase(path+'.sqlite');t.after(()=>db.close());const target=db.createTarget({type:'account',provider:'public-web',label:'offline test',locator:'MS4wLjABAAAAContinuousFixture0123456789'});const s=new MonitorScheduler(db,{continuousRoundStore:store,asyncPlanning:true,worksOnlyEnabled:true});t.after(()=>s.stop());const now=new Date();const plan=await s.readPlanning('tick',now);assert.equal(plan.slotKey,store.window(now).key);assert.ok(plan.dueIds.includes(target.id));assert.equal(plan.roundSettled,false);});

// Reproduces the production deadlock: no profile work remains, while works
// transport is deferred, so roundSettled stays false indefinitely.
test('works deferral cannot freeze the next profile pass',async t=>{const{store}=setup(t);const db=new MonitorDatabase(':memory:');t.after(()=>db.close());const s=new MonitorScheduler(db,{continuousRoundStore:store,asyncPlanning:true,worksOnlyEnabled:true});const now=new Date();s.readPlanning=async()=>({asOf:now.toISOString(),slotKey:s.collectionSlot(now).key,dueIds:[],worksTargetId:null,roundSettled:false,profilePassSettled:true});const before=store.window().key;await s.tick(now);assert.notEqual(store.window().key,before);});

test('real planning marks profile pass settled while works remain due',async t=>{
 const {path,store}=setup(t),db=new MonitorDatabase(path+'.sqlite');t.after(()=>db.close());
 const locator='MS4wLjABAAAAContinuousFixture0123456789';
 const target=db.createTarget({type:'account',provider:'public-web',label:'fixture',locator});
 const {normalizeCollection}=await import('../lib/providers/normalize.mjs');
 const run=db.beginRun('scheduled',target.id,1),capturedAt=new Date().toISOString();
 const raw={capturedAt,accountStatus:'validated',accountError:null,profile:{user:{sec_uid:locator,uid:'12345678',follower_count:20,total_favorited:40,aweme_count:1}},worksCoverage:'unavailable',worksErrorCode:'deferred',works:{stopReason:'request-deferred',pagination:{requestCount:0,pages:[]}},provenance:{mode:'guest-ttwid-unsigned-profile',profileMode:'guest-ttwid-unsigned-profile',profileEndpoint:'https://www.douyin.com/aweme/v1/web/user/profile/other/',accountLocator:'sec_uid',cookiePersisted:false,runtimeAI:false,paidAPI:false}};
 db.saveCollection(target,run,normalizeCollection(target,raw,{capturedAt}));
 db.finishRun(run,{status:'partial',successCount:1,processedCount:1});
 const s=new MonitorScheduler(db,{continuousRoundStore:store,scheduleIntervalHours:8,asyncPlanning:true,worksOnlyEnabled:true});t.after(()=>s.stop());
 const plan=await s.readPlanning('tick',new Date());
 assert.deepEqual(plan.dueIds,[]);
 assert.equal(plan.worksTargetId,target.id);
 assert.equal(plan.roundSettled,false);
 assert.equal(plan.profilePassSettled,true);
});

// New authors may keep a pass open. Old profile success still has to expire.
test('continuous planner refreshes stale profiles even while the same pass remains open',async t=>{
 const realNow=Date.now();t.mock.timers.enable({apis:['Date'],now:realNow-24*60*60_000});
 const {path,store}=setup(t),db=new MonitorDatabase(path+'.sqlite');t.after(()=>db.close());
 const locator='MS4wLjABAAAAContinuousFixture0123456789',target=db.createTarget({type:'account',provider:'public-web',label:'fixture',locator});
 const {normalizeCollection}=await import('../lib/providers/normalize.mjs');
 const run=db.beginRun('scheduled',target.id,1),capturedAt=new Date().toISOString();
 const raw={capturedAt,profile:{user:{sec_uid:locator,uid:'12345678',follower_count:20,total_favorited:40,aweme_count:1}},worksCoverage:'unavailable',worksErrorCode:'deferred',works:{aweme_list:[]}};
 db.saveCollection(target,run,normalizeCollection(target,raw,{capturedAt}));db.finishRun(run,{status:'partial',successCount:1,processedCount:1});
 const s=new MonitorScheduler(db,{continuousRoundStore:store,asyncPlanning:true,worksOnlyEnabled:true});t.after(()=>s.stop());
 const freshPlan=await s.readPlanning('tick',new Date());
 assert.deepEqual(freshPlan.dueIds,[], 'fresh successful profile must not be retried');
 t.mock.timers.setTime(realNow);
 const plan=await s.readPlanning('tick',new Date());
 assert.ok(plan.dueIds.includes(target.id));
 assert.equal(store.state.round,1);
});
