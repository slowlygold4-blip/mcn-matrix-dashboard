import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitorDatabase } from '../lib/database.mjs';
import { MonitorScheduler } from '../lib/scheduler.mjs';
import { ConsoleReader } from '../lib/console-reader.mjs';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { BrowserWorksPagination } from '../lib/browser-works-pagination.mjs';

const NOW=Date.parse('2026-09-29T02:01:00.000Z'),SEC='MS4wLjABAAAAPhase94AsyncFixture123456',UID='12345678';
function setup(t, options={}) {
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const dir=mkdtempSync(join(tmpdir(),'phase94-async-'));
  const database=new MonitorDatabase(join(dir,'test.sqlite'));
  const scheduler=new MonitorScheduler(database,{scheduleIntervalHours:8,worksOnlyEnabled:true,asyncPlanning:true,
    providerOptions:{accountBrowserFallback:true,execFileImpl:()=>{throw Error('NO_PROCESS');},fetchImpl:()=>{throw Error('NO_NETWORK');}},...options});
  t.after(async()=>{await scheduler.stop();database.close();rmSync(dir,{recursive:true,force:true});});
  const target=database.createTarget({type:'account',provider:'public-web',locator:SEC,label:'isolated'});
  function anchor() {
    const raw={capturedAt:new Date().toISOString(),accountStatus:'validated',accountError:null,
      profile:{user:{sec_uid:SEC,uid:UID,follower_count:20,total_favorited:40,aweme_count:300}},
      worksCoverage:'unavailable',worksErrorCode:'deferred',works:{stopReason:'request-deferred',pagination:{requestCount:0,pages:[]}},
      provenance:{mode:'guest-ttwid-unsigned-profile',profileMode:'guest-ttwid-unsigned-profile',
        profileEndpoint:'https://www.douyin.com/aweme/v1/web/user/profile/other/',accountLocator:'sec_uid',cookiePersisted:false,runtimeAI:false,paidAPI:false}};
    const run=database.beginRun('scheduled',target.id,1);database.saveCollection(target,run,normalizeCollection(target,raw,{capturedAt:raw.capturedAt}));
    database.finishRun(run,{status:'success',successCount:1,processedCount:1});t.mock.timers.setTime(Date.now()+1000);
  }
  return{database,scheduler,target,anchor};
}

test('actual async tick/guard/provider grows durable evidence; each same-asOf status revalidates parent sources',async t=>{
  const f=setup(t),requests=[];let normal=0;
  t.mock.method(f.scheduler,'runAll',async()=>{normal++;throw Error('NO_PROFILE_REQUEST');});
  t.mock.method(PublicWebProvider.prototype,'runBrowserWorks',async item=>{
    requests.push(item);const cursor=item.startCursor??0;
    const posts=Array.from({length:30},(_,i)=>({aweme_id:String(7200000000000000000n+BigInt(cursor+i)),author:{sec_uid:SEC,uid:UID},statistics:{digg_count:1}}));
    t.mock.timers.setTime(Date.now()+20);const ledger=new BrowserWorksPagination({limit:item.limit,startCursor:item.startCursor});
    ledger.accept({requestCursor:cursor,body:{aweme_list:posts,has_more:true},normalized:{posts,maxCursor:cursor+100,filteredCount:0,duplicateCount:0,locallyTruncated:false},observedAt:new Date().toISOString()});
    return{items:[{key:item.key,status:'ok',errorCode:null,...ledger.result(1)}]};
  });
  f.anchor();await f.scheduler.tick();
  t.mock.timers.setTime(NOW+8*3600_000);f.anchor();await f.scheduler.tick();
  assert.equal(normal,0);assert.deepEqual(requests.map(x=>x.startCursor),[undefined,100]);
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM posts').get().n,60);
  const at=new Date();const status=await f.scheduler.getStatusAsync(at);
  assert.equal(status.scheduledWorksLimitedTargetCount,1);assert.equal(status.scheduledWorksCompleteTargetCount,0);
  const sync=f.scheduler.getStatus(at);delete status.planningAsOf;assert.deepEqual(status,sync);
  const row=f.database.db.prepare('SELECT * FROM works_observations ORDER BY id LIMIT 1').get();
  f.database.db.exec('DROP TRIGGER works_observations_no_update');
  f.database.db.prepare('UPDATE works_observations SET source_checksum=? WHERE id=?').run('0'.repeat(64),row.id);
  assert.equal((await f.scheduler.getStatusAsync(at)).scheduledWorksLimitedTargetCount,0);
  f.database.db.prepare('UPDATE works_observations SET source_checksum=? WHERE id=?').run(row.source_checksum,row.id);
  assert.equal((await f.scheduler.getStatusAsync(at)).scheduledWorksLimitedTargetCount,1);
  const reader=f.scheduler.planningReaders.get('status');assert.equal(reader.cache.size,0);assert.equal(reader.jobs.size,0);
});

test('an active works-only request is not cancelled with unrelated server work',async t=>{
  const generalShutdown=new AbortController(),worksShutdown=new AbortController();
  const f=setup(t);f.scheduler.providerOptions.signal=generalShutdown.signal;f.scheduler.worksOnlySignal=worksShutdown.signal;
  let release,markStarted;const started=new Promise(resolve=>markStarted=resolve);
  t.mock.method(PublicWebProvider.prototype,'runBrowserWorks',async()=>{
    markStarted();return new Promise(resolve=>release=resolve);
  });
  f.anchor();
  const running=f.scheduler.tick();
  await started;
  generalShutdown.abort(new Error('server stopping'));
  assert.equal(worksShutdown.signal.aborted,false);
  const post={aweme_id:'7200000000000000001',author:{sec_uid:SEC,uid:UID},statistics:{digg_count:1}};
  release({items:[{key:String(f.target.id),secUid:SEC,status:'ok',worksCoverage:'complete',errorCode:null,
    posts:[post],hasMore:false,maxCursor:0,pagination:{version:1,maxPages:3,requestCount:1,collectedCount:1,
      stopReason:'end-of-list',errorCode:null,pages:[{requestCursor:0,response:{max_cursor:0,has_more:false},rawCount:1,
        acceptedCount:1,duplicateCount:0,filteredCount:0,truncated:false,observedAt:new Date().toISOString()}]}}]});
  await running;
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM works_observations').get().n,1);
  assert.equal(f.database.db.prepare("SELECT status FROM runs WHERE trigger_type='works-only'").get().status,'partial');
  assert.equal(worksShutdown.signal.aborted,false);
});

test('async monitoring status preserves the topic denominator and both-metric coverage contract',async t=>{
  const f=setup(t);
  const complete=f.database.createTarget({type:'hashtag',provider:'public-web',label:'#双指标完成',locator:'#双指标完成'});
  const missing=f.database.createTarget({type:'hashtag',provider:'public-web',label:'#缺播放量',locator:'#缺播放量'});
  const zero=f.database.createTarget({type:'hashtag',provider:'public-web',label:'#真实零值',locator:'#真实零值'});
  const manualReview=f.database.createTarget({type:'hashtag',provider:'public-web',label:'#身份待核话题',locator:'#身份待核话题'});
  const disabled=f.database.createTarget({type:'hashtag',provider:'public-web',label:'#停用话题',locator:'#停用话题'});
  f.database.db.prepare('UPDATE targets SET enabled=0 WHERE id=?').run(disabled.id);
  f.database.createTarget({type:'hashtag',provider:'manual',label:'#手动话题',locator:'#手动话题'});
  const run=f.database.beginRun('scheduled',null,3),capturedAt=new Date(NOW).toISOString();
  for(const [target,participants,views,qualityStatus] of [
    [complete,12,80,'validated'],[missing,7,null,'warning'],[zero,0,0,'validated'],
  ]) f.database.saveCollection(target,run,{capturedAt,snapshot:{hashtagParticipants:participants,hashtagViews:views},
    posts:[],qualityStatus,accountStatus:'unknown',worksCoverage:'not-applicable',raw:{source:'async-topic-status-fixture'}});
  f.database.finishRun(run,{status:'success',successCount:2,warningCount:1,processedCount:3});
  const reviewRun=f.database.beginRun('scheduled',manualReview.id,1);
  f.database.recordFailure(manualReview,reviewRun,new Error('关键词搜索结果无法唯一确认话题身份'));
  f.database.finishRun(reviewRun,{status:'error',errorCount:1,processedCount:1});
  const at=new Date(NOW),status=await f.scheduler.getStatusAsync(at),sync=f.scheduler.getStatus(at);
  assert.equal(status.scheduledTopicTargetCount,4,'count enabled public topics including unresolved ones; exclude disabled and manual-provider targets');
  assert.equal(status.scheduledTopicMetricCompletedTargetCount,2,'count only full participant+views observations, including genuine zeros');
  assert.equal(status.scheduledMetricCompletedTargetCount,2,'topic metrics remain separate from the pending account homepage');
  assert.equal(status.scheduledManualTargetCount,1,'identity-blocked topic stays visible but is not counted complete');
  delete status.planningAsOf;
  assert.deepEqual(status,sync,'the asynchronous worker must expose the same dated coverage as the direct planner');
});

for(const race of ['manual-running','stop','source-write','settings-write','run-write','slot-rollover','cancel'])test(`pending async tick does not act after ${race}`,async t=>{
  const controller=new AbortController();const f=setup(t,{providerOptions:{signal:controller.signal}});
  let release,reads=0,runs=0;
  t.mock.method(f.scheduler,'readPlanning',async()=>{reads++;return new Promise(resolve=>release=resolve);});
  t.mock.method(f.scheduler,'runAll',async()=>{runs++;});
  const slot=f.scheduler.collectionSlot(),pending=f.scheduler.tick();await f.scheduler.tick();assert.equal(reads,1);
  if(race==='manual-running')f.scheduler.running=true;
  if(race==='stop')await f.scheduler.stop();
  if(race==='source-write')f.database.db.prepare('UPDATE targets SET enabled=0 WHERE id=?').run(f.target.id);
  if(race==='settings-write')f.database.setSettings({scheduleTime:'09:30'});
  if(race==='run-write')f.database.beginRun('manual',f.target.id,1);
  if(race==='slot-rollover')t.mock.timers.setTime(NOW+8*3600_000);
  if(race==='cancel')controller.abort();
  release({asOf:new Date(NOW).toISOString(),slotKey:slot.key,dueIds:[f.target.id],worksTargetId:null});await pending;
  assert.equal(runs,0);assert.equal(f.scheduler.planningTick,false);assert.equal(f.database.db.prepare('SELECT count(*) n FROM runs').get().n,race==='run-write'?1:0);
});

test('scheduler drain waits for an in-flight works-only planning guard before service teardown',async t=>{
  const f=setup(t);let releaseGuard,markGuardStarted;const guardStarted=new Promise(resolve=>markGuardStarted=resolve);
  t.mock.method(f.scheduler,'readPlanning',async(mode,now,{targetId}={})=>{
    if(mode==='tick')return{asOf:now.toISOString(),slotKey:f.scheduler.collectionSlot(now).key,dueIds:[],worksTargetId:f.target.id};
    assert.equal(mode,'guard');
    markGuardStarted();
    return new Promise(resolve=>releaseGuard=resolve);
  });
  f.scheduler.start();
  await guardStarted;
  await f.scheduler.stop();
  let drained=false;
  const drain=f.scheduler.drain().then(()=>{drained=true;});
  await Promise.resolve();
  const waitedForGuard=!drained;
  releaseGuard({asOf:new Date(NOW).toISOString(),slotKey:f.scheduler.collectionSlot().key,targetId:f.target.id,allowed:true});
  await drain;
  assert.equal(waitedForGuard,true,'drain must not report a stopped service while the tick can still reserve a run');
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM runs').get().n,0,'the stopped works-only tick must not reserve a run');
  assert.equal(f.scheduler.worksPlanning,false);
});

test('ordinary authenticated session heartbeat cannot starve a pending natural plan',async t=>{
  const f=setup(t);const now=new Date().toISOString(),later=new Date(NOW+86400_000).toISOString();
  const user=f.database.ensureLocalOwner();f.database.createSession({tokenHash:'phase94-test-session',userId:user.id,csrfToken:'offline',createdAt:now,idleExpiresAt:later,absoluteExpiresAt:later});
  let release,runs=0;t.mock.method(f.scheduler,'readPlanning',async()=>new Promise(resolve=>release=resolve));
  t.mock.method(f.scheduler,'runAll',async()=>{runs++;});
  const slot=f.scheduler.collectionSlot(),pending=f.scheduler.tick();
  assert.ok(f.database.getSession('phase94-test-session',{now,idleExpiresAt:later}));
  release({asOf:now,slotKey:slot.key,dueIds:[f.target.id],worksTargetId:null});await pending;assert.equal(runs,1);
});

test('bootstrap readonly worker preserves original overview fields and does not cache results',async t=>{
  const f=setup(t);f.anchor();const reader=new ConsoleReader({databasePath:f.database.filePath});t.after(()=>reader.close());
  const options={board:null,timeZone:'Asia/Shanghai'};
  // Calendar report bounds use today's clock in this pre-existing API, so
  // compare after restoring the host Date rather than fabricating time fields.
  t.mock.timers.reset();
  const started=Date.now(),expected=f.database.getOverview(options),actual=await reader.bootstrapOverview(options),finished=Date.now();
  // These exact clock metadata fields are generated independently per API read.
  // Verify their real interval before equalizing them; all business fields and
  // fixed report bounds remain in the strict field-for-field comparison.
  for(const key of ['day','week','month'])for(const field of ['end','generatedAt']) {
    for(const value of [expected.reports[key][field],actual.reports[key][field]]) {
      assert.ok(Date.parse(value)>=started&&Date.parse(value)<=finished,`${key}.${field} is within the read interval`);
    }
    actual.reports[key][field]=expected.reports[key][field];
  }
  if(expected.reports.latestCompletedDay) {
    for(const value of [expected.reports.latestCompletedDay.generatedAt,actual.reports.latestCompletedDay.generatedAt])assert.ok(Date.parse(value)>=started&&Date.parse(value)<=finished);
    actual.reports.latestCompletedDay.generatedAt=expected.reports.latestCompletedDay.generatedAt;
  }
  assert.deepEqual(actual,expected);assert.equal(reader.cache.size,0);
  f.database.db.prepare('UPDATE targets SET label=? WHERE id=?').run('new label',f.target.id);
  assert.equal((await reader.bootstrapOverview(options)).targets[0].label,'new label');
});

test('status reflects live run state after worker read but keeps requested observation cutoff',async t=>{
  const f=setup(t);let release;t.mock.method(f.scheduler,'readPlanning',async()=>new Promise(resolve=>release=resolve));
  const p=f.scheduler.getStatusAsync(new Date(NOW));f.scheduler.running=true;f.scheduler.currentProgress={runId:77,currentTarget:{id:1}};
  release({running:false,scheduleState:'due',scheduledWorksLimitedTargetCount:0});const status=await p;
  assert.equal(status.running,true);assert.equal(status.scheduleState,'running');assert.equal(status.currentRun.runId,77);
  assert.equal(status.planningAsOf,new Date(NOW).toISOString());
});

class FakeWorker extends EventEmitter {
  sent=[];terminated=0;refs=0;unrefs=0;
  ref(){this.refs++;} unref(){this.unrefs++;}
  postMessage(job){this.sent.push(job);}
  terminate(){this.terminated++;return Promise.resolve(0);}
  answer(index,result){this.emit('message',{id:this.sent[index].id,ok:true,result});}
}
test('planning has no cache/coalescing, bounded queue, aborts queued work and closes concurrently',async t=>{
  const worker=new FakeWorker(),reader=new ConsoleReader({databasePath:'/not-real.sqlite',maxQueue:2,workerFactory:()=>worker});
  t.after(()=>reader.close());const opts={mode:'status',asOf:new Date(NOW).toISOString()},controller=new AbortController();
  const a=reader.planning(opts),b=reader.planning(opts,{signal:controller.signal});assert.notEqual(a,b);
  const rejected=assert.rejects(b,{code:'CONSOLE_READER_ABORTED'});controller.abort();await rejected;
  const c=reader.planning(opts);await assert.rejects(reader.planning(opts),{code:'CONSOLE_READER_BUSY'});
  worker.answer(0,{one:1});await a;worker.answer(1,{two:2});await c;assert.equal(reader.cache.size,0);
  const d=reader.planning(opts),closed=assert.rejects(d,{code:'CONSOLE_READER_CLOSED'});
  const closing=reader.close();assert.equal(reader.close(),closing);await Promise.all([closing,closed]);
  assert.equal(worker.terminated,1);assert.equal(reader.jobs.size,0);assert.ok(worker.refs>0&&worker.unrefs>0);
});
test('active cancellation/timeout retires worker and a later request revalidates on a new worker',async t=>{
  const workers=[],reader=new ConsoleReader({databasePath:'/not-real.sqlite',timeoutMs:30,workerFactory:()=>{const w=new FakeWorker();workers.push(w);return w;}});
  t.after(()=>reader.close());const controller=new AbortController(),opts={mode:'status',asOf:new Date(NOW).toISOString()};
  const a=reader.planning(opts,{signal:controller.signal}),rejected=assert.rejects(a,{code:'CONSOLE_READER_ABORTED'});controller.abort();await rejected;
  await assert.rejects(reader.planning(opts),{code:'CONSOLE_READER_TIMEOUT'});assert.equal(workers.length,2);
  const c=reader.planning(opts);workers[2].answer(0,{fresh:true});assert.deepEqual(await c,{fresh:true});
  await reader.close();assert.equal(reader.jobs.size,0);assert.equal(reader.terminations.size,0);
});
