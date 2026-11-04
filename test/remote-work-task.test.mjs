import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MonitorDatabase} from '../lib/database.mjs';
import {normalizeCollection} from '../lib/providers/normalize.mjs';
import {createRemoteWorkTask,readRemoteWorkTaskConfig} from '../lib/remote-work-task.mjs';
import {readRemoteWorkCoverage} from '../lib/remote-work-coverage.mjs';
import {MonitorScheduler} from '../lib/scheduler.mjs';
import {validationCountsMatch} from '../lib/backup-manager.mjs';

const SEC='MS4wLjABAAAARemoteTaskFixture1234567';
const ORIGIN='https://demo.douyin.wtf';
function fixture(t){
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-04T10:00:00Z')});
 const database=new MonitorDatabase(':memory:');t.after(()=>database.close());
 const target=database.createTarget({type:'account',label:'fixture',provider:'public-web',locator:SEC});
 const raw={capturedAt:new Date().toISOString(),accountStatus:'validated',accountError:null,
  profile:{user:{sec_uid:SEC,uid:'123456789',follower_count:12,total_favorited:33,aweme_count:3}},
  worksCoverage:'unavailable',worksErrorCode:'deferred',works:{stopReason:'request-deferred',pagination:{requestCount:0,pages:[]}},
  provenance:{mode:'guest-ttwid-unsigned-profile',profileMode:'guest-ttwid-unsigned-profile',
   profileEndpoint:'https://www.douyin.com/aweme/v1/web/user/profile/other/',accountLocator:'sec_uid',cookiePersisted:false,runtimeAI:false,paidAPI:false}};
 database.saveCollection(target,null,normalizeCollection(target,raw,{capturedAt:raw.capturedAt}));
 const config={enabled:true,targetId:target.id,sourceOrigin:ORIGIN,startsOn:'2026-11-04',endsOn:'2026-11-10'};
 const receipt={source:ORIGIN,httpStatus:200,requestStartedAt:new Date().toISOString(),requestFinishedAt:new Date().toISOString(),
  meta:{endpoint:'douyin.author_posts',cached:false,guest_fallback:true,request_id:'scheduled-fixture'},
  data:{has_more:false,cursor:null,items:[{content_id:'7300000000000000001',platform:'douyin',
   created_at:'2026-11-01T04:00:00Z',fetched_at:new Date().toISOString(),author:{sec_uid:SEC,uid:SEC,nickname:'fixture'},
   is_deleted:false,is_private:false,stats:{digg_count:0,comment_count:2,share_count:null,collect_count:null}}]}};
 return {database,db:database.db,config,receipt,target};
}

test('finite task commits actual work vectors and a versioned execution atomically without profile success',async t=>{
 const f=fixture(t);let calls=0,notifications=0;
 const task=createRemoteWorkTask(f.db,f.config,{fetchPage:async args=>{
  calls++;assert.equal(args.secUid,SEC);assert.equal(args.authMode,'demo');
  return {receipt:f.receipt,transport:{totalRequests:4}};
 },onCommitted:()=>{notifications++;throw Error('reader unavailable');}});
 const run=task.reserve();assert.equal(typeof run,'function');assert.equal(task.reserve(),null);
 assert.deepEqual(await run(),{status:'success',postCount:1,coverage:'limited',runtimeAI:false});
 assert.equal(calls,1);assert.equal(notifications,1);assert.equal(task.reserve(),null);
 const row=f.db.prepare('SELECT * FROM remote_work_attempts').get();
 assert.equal(row.status,'success');assert.equal(row.request_count,4);assert.match(row.event_key,/^[a-f0-9]{64}$/);
 const event=JSON.parse(f.db.prepare("SELECT raw_json FROM account_events WHERE event_type='remote-work-observation'").get().raw_json);
 assert.equal(event.version,2);assert.equal(event.automaticCollectionEnabled,true);assert.equal(event.execution.attemptId,row.id);
 assert.equal(event.dailyPublicationCountConfirmed,false);
 assert.equal(f.db.prepare('SELECT likes FROM post_metrics').get().likes,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM runs').get().n,0);
 const window={since:'2026-11-03T16:00:00.000Z',now:new Date().toISOString()};
 assert.equal(readRemoteWorkCoverage(f.db,window).length,1);
 f.db.prepare("UPDATE remote_work_attempts SET status='failed',error_code='bad',post_count=0,event_key=NULL WHERE id=?").run(row.id);
 assert.deepEqual(readRemoteWorkCoverage(f.db,window),[]);
});

test('refusal records the real request count and stops subsequent automatic evaluation',async t=>{
 const f=fixture(t);let calls=0;
 const task=createRemoteWorkTask(f.db,f.config,{fetchPage:async()=>{calls++;throw Object.assign(Error('private upstream message'),
  {code:'HTTP_403',httpStatus:403,transport:{totalRequests:4}});}});
 assert.equal((await task.reserve()()).status,'stopped');
 t.mock.timers.setTime(Date.parse('2026-11-05T10:00:00Z'));
 assert.equal(task.reserve(),null);assert.equal(calls,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM post_metrics').get().n,0);
 assert.equal(task.state().lastAttempt.request_count,4);
 assert.equal(JSON.stringify(task.state()).includes('private upstream'),false);
});

test('identity change while awaiting HTTP leaves no work observations or successful event',async t=>{
 const f=fixture(t);
 const task=createRemoteWorkTask(f.db,f.config,{fetchPage:async()=>{
  f.db.prepare('UPDATE targets SET enabled=0 WHERE id=?').run(f.target.id);
  return {receipt:f.receipt,transport:{totalRequests:4}};
 }});
 assert.equal((await task.reserve()()).status,'failed');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM post_metrics').get().n,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM account_events WHERE event_type='remote-work-observation'").get().n,0);
 assert.equal(task.state().lastAttempt.status,'failed');
});

test('configuration is finite and opt in; malformed or arbitrary destinations cannot auto-enable network',t=>{
 const dir=mkdtempSync(join(tmpdir(),'remote-task-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'config.json');
 assert.equal(readRemoteWorkTaskConfig(path),null);
 writeFileSync(path,JSON.stringify({enabled:false}));assert.equal(readRemoteWorkTaskConfig(path),null);
 const good={enabled:true,targetId:1,sourceOrigin:ORIGIN,startsOn:'2026-11-04',endsOn:'2026-11-10'};
 for(const bad of [{...good,endsOn:'2026-11-11'},{...good,endsOn:'2026-11-03'},
  {...good,sourceOrigin:'https://unreviewed.example'},{...good,token:'secret'},
  {...good,startsOn:'2026-02-30'},[],null]){
  writeFileSync(path,JSON.stringify(bad));assert.throws(()=>readRemoteWorkTaskConfig(path));
 }
 writeFileSync(path,JSON.stringify(good));assert.deepEqual(readRemoteWorkTaskConfig(path),good);
});

test('scheduler HTTP lane gets a turn before a nonempty profile queue and shares stop/manual mutex',async t=>{
 const f=fixture(t);let release,startedResolve,reserves=0,profileRuns=0;
 const started=new Promise(r=>startedResolve=r),waiting=new Promise(r=>release=r);
 const scheduler=new MonitorScheduler(f.database,{remoteWorkTask:{state:()=>null,reserve:()=>{
  if(reserves++)return null;return async()=>{startedResolve();await waiting;};
 }}});
 scheduler.collectionSlot=()=>({key:'fixture'});
 scheduler.scheduledDueTargetIds=()=>[f.target.id];
 const original=scheduler.runAll.bind(scheduler);
 scheduler.runAll=async options=>{if(options.triggerType==='scheduled'){profileRuns++;return {};}return original(options);};
 const tick=scheduler.tick();await started;
 assert.equal(scheduler.running,true);assert.equal(profileRuns,0);
 await scheduler.tick();assert.equal(reserves,1);
 await assert.rejects(scheduler.runAll({targetId:f.target.id}),{code:'COLLECTION_SCOPE_CONFLICT'});
 let drained=false;const drain=scheduler.drain().then(()=>drained=true);
 await Promise.resolve();assert.equal(drained,false);release();await tick;await drain;
 assert.equal(profileRuns,0);assert.equal(scheduler.currentPromise,null);assert.equal(scheduler.running,false);
});

test('scheduler resumes the ordinary due queue after the one remote page',async t=>{
 const f=fixture(t),order=[];let reserved=false;
 const scheduler=new MonitorScheduler(f.database,{remoteWorkTask:{reserve:()=>{
  if(reserved)return null;reserved=true;return async()=>{order.push('remote');};
 }}});
 scheduler.collectionSlot=()=>({key:'fixture'});scheduler.scheduledDueTargetIds=()=>[f.target.id];
 scheduler.runAll=async()=>{order.push('profile');};
 await scheduler.tick();assert.deepEqual(order,['remote','profile']);
});

test('production asynchronous status includes the finite HTTP task state',async t=>{
 const f=fixture(t),task=createRemoteWorkTask(f.db,f.config);
 const scheduler=new MonitorScheduler(f.database,{asyncPlanning:true,remoteWorkTask:task});
 scheduler.readPlanning=async()=>({remoteWorkEvaluation:null});
 assert.deepEqual((await scheduler.getStatusAsync()).remoteWorkEvaluation,task.state());
});

test('HTTP 200 with an explicit upstream business refusal stops the source',async t=>{
 const f=fixture(t),task=createRemoteWorkTask(f.db,f.config,{fetchPage:async()=>{
  throw Object.assign(Error('do not retain'),{code:'upstream_error',httpStatus:200,upstreamCode:'FORBIDDEN',transport:{totalRequests:4}});
 }});
 assert.equal((await task.reserve()()).status,'stopped');
 assert.equal(task.state().lastAttempt.status,'stopped');
});

test('backup manifests must retain the automatic task ledger while legacy backups stay valid',()=>{
 const base=Object.fromEntries(['targets','board_catalog','target_boards','posts','post_metrics','snapshots','runs','audits','source_probes','author_resolution_queue','author_resolution_jobs'].map(k=>[k,0]));
 assert.equal(validationCountsMatch(base,base),true);
 assert.equal(validationCountsMatch({...base,remote_work_attempts:1},base),false);
 assert.equal(validationCountsMatch({...base,remote_work_attempts:1},{...base,remote_work_attempts:1}),true);
 assert.equal(validationCountsMatch({...base,remote_work_attempts:1},{...base,remote_work_attempts:0}),false);
});
