import test from 'node:test';
import assert from 'node:assert/strict';
import {MonitorScheduler} from '../lib/scheduler.mjs';
const good=()=>({triggerType:'works-only',successCount:1,details:[{attempted:true,errorCode:null}]});
function fixture(t){t.mock.timers.enable({apis:['setTimeout','Date'],now:10000});let wakes=0;const s=Object.create(MonitorScheduler.prototype);Object.assign(s,{timer:{},stopped:false,stopping:false,draining:false,shouldYieldScheduledCollection:()=>false,runManagedTick:()=>{wakes++;}});return {s,wakes:()=>wakes};}
test('successful work evidence advances once after a five second pause, with no duplicate wakeups',t=>{const f=fixture(t);f.s.queueWorksFollowup(good());f.s.queueWorksFollowup(good());assert.equal(f.s.worksNextAllowedAt,15000);t.mock.timers.tick(4999);assert.equal(f.wakes(),0);t.mock.timers.tick(1);assert.equal(f.wakes(),1);t.mock.timers.tick(30000);assert.equal(f.wakes(),1);});
test('denial, skipped lane, partial error and profile runs do not accelerate requests',t=>{const f=fixture(t);for(const x of [null,{...good(),triggerType:'scheduled'},{...good(),successCount:0},{...good(),details:[{attempted:false}]},{...good(),details:[{attempted:true,errorCode:'rate_limited'}]},{...good(),details:[{attempted:true,errorCode:'collector_error'}]}])f.s.queueWorksFollowup(x);t.mock.timers.tick(60000);assert.equal(f.wakes(),0);});
test('stopping or draining closes a queued wakeup even if its callback has already been scheduled',t=>{const f=fixture(t);f.s.queueWorksFollowup(good());f.s.stopped=true;t.mock.timers.tick(5000);assert.equal(f.wakes(),0);f.s.stopped=false;f.s.draining=true;f.s.queueWorksFollowup(good());t.mock.timers.tick(5000);assert.equal(f.wakes(),0);});
test('manual test ticks without a running scheduler never create background queue jobs',t=>{const f=fixture(t);f.s.timer=null;f.s.queueWorksFollowup(good());t.mock.timers.tick(30000);assert.equal(f.wakes(),0);});
test('stop cancels the queued timer and releases the planning readers', async t => {
  const f=fixture(t);
  Object.assign(f.s,{planningEpoch:0,planningReaders:new Map(),planningClose:Promise.resolve()});
  f.s.queueWorksFollowup(good());
  await f.s.stop();
  t.mock.timers.tick(30000);
  assert.equal(f.wakes(),0);
  assert.equal(f.s.worksFollowupTimer,null);
  assert.equal(f.s.worksNextAllowedAt,null);
  assert.equal(f.s.stopped,true);
});
test('periodic heartbeat cannot bypass the successful-work pause', async t => {
  const f=fixture(t);
  Object.assign(f.s,{tickCount:0,collectionSlot:()=>({key:'slot'}),scheduledDateKey:()=> '2026-10-26',scheduledDueTargetIds:()=>[],worksOnlyEnabled:true});
  f.s.queueWorksFollowup(good());
  // No database fixture is supplied: planning a new works request during this
  // pause would throw, proving this heartbeat stays before admission.
  await f.s.tick();
  assert.equal(f.wakes(),0);
  assert.equal(f.s.tickCount,1);
});
