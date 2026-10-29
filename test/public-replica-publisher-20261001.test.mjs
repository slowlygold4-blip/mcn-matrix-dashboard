import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,symlink,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {privateRead,privateWrite,recordPublisherPreparation,recordPublisherSyncStart,validatedReceipt,completedSourceMarker,acquirePublisherLock,shouldPreparePublicDateIndex,ensurePublisherBackgroundPriority} from '../scripts/public-replica-publisher.mjs';
import {PUBLIC_REPLICA_EXPORT_REVISION} from '../lib/public-replica-export.mjs';
test('publisher startup lowers only its own priority and keeps an already quieter worker unchanged',()=>{
 let priority=0,writes=0;const write=value=>{priority=value;writes++;};
 assert.deepEqual(ensurePublisherBackgroundPriority({read:()=>priority,write}),{status:'applied',priority:10});assert.equal(writes,1);
 priority=15;assert.deepEqual(ensurePublisherBackgroundPriority({read:()=>priority,write}),{status:'applied',priority:15});assert.equal(writes,1);
 assert.deepEqual(ensurePublisherBackgroundPriority({read:()=>{throw Error('unavailable');},write}),{status:'deferred',priority:null});assert.equal(writes,1);
});
test('a pending generation keeps its own date-index feature across exporter revisions',()=>{
  assert.equal(shouldPreparePublicDateIndex({exportRevision:'catalog-date-range-v1'}),true);
  assert.equal(shouldPreparePublicDateIndex({exportRevision:'catalog-date-range-v2-roster-classification'}),true);
  assert.equal(shouldPreparePublicDateIndex({exportRevision:PUBLIC_REPLICA_EXPORT_REVISION}),true);
  assert.equal(shouldPreparePublicDateIndex({exportRevision:'future-revision',dateIndex:true}),true);
  assert.equal(shouldPreparePublicDateIndex({exportRevision:'catalog-date-range-v1',dateIndex:false}),false);
  assert.equal(shouldPreparePublicDateIndex({exportRevision:'unknown'}),false);
  assert.equal(shouldPreparePublicDateIndex(null),false);
});
test('completed receipts are bound to exact persisted run and time',()=>{const run={id:1,trigger_type:'scheduled',status:'success',started_at:'2026-01-01T00:00:00.000Z',finished_at:'2026-01-01T00:01:00.000Z'};const r={version:1,runId:1,eventId:'collection-run-1',triggerType:'scheduled',runStatus:'success',startedAt:run.started_at,finishedAt:run.finished_at,reviewedAt:'2026-01-01T00:02:00.000Z'};assert.equal(validatedReceipt(run,r),true);for(const override of [{runId:2},{finishedAt:'2026-01-01T00:03:00.000Z'},{eventId:'reviewed-1'}])assert.equal(validatedReceipt(run,{...r,...override}),false);assert.equal(validatedReceipt({...run,status:'running'},r),false);});
test('source completion marker excludes private URLs and ignores intermediate writes',()=>{const m={lastFinishedAt:'2026-01-01T00:01:00.000Z',sources:{a:{sourceUrl:'SECRET',lastStatus:'success',sourceSha256:'a'}}};const a=completedSourceMarker(m);assert.match(a,/^[a-f0-9]{64}$/);assert.equal(a,completedSourceMarker({...m,sources:{a:{lastStatus:'failed',sourceSha256:'a'}}}));assert.notEqual(a,completedSourceMarker({...m,lastFinishedAt:'2026-01-01T00:02:00.000Z'}));assert.equal(completedSourceMarker({...m,sources:{a:{lastStatus:'pending'}}}),null);assert.equal(completedSourceMarker({...m,lastFinishedAt:null}),null);});
test('private files reject symlinks and readable credentials; lock is exclusive',async()=>{const dir=await mkdtemp(join(tmpdir(),'mcn-publisher-test-'));try{const p=join(dir,'credential');await writeFile(p,'a'.repeat(64),{mode:0o600});assert.equal(await privateRead(p,{credential:true}),'a'.repeat(64));await chmod(p,0o644);await assert.rejects(privateRead(p,{credential:true}));await chmod(p,0o600);await symlink(p,join(dir,'link'));await assert.rejects(privateRead(join(dir,'link'),{credential:true}));await privateWrite(join(dir,'state'),{version:1});assert.deepEqual(await privateRead(join(dir,'state')),{version:1});const lock=join(dir,'lock');await acquirePublisherLock(lock);await assert.rejects(acquirePublisherLock(lock),/publisher-already-running/);assert.equal(JSON.parse(await readFile(lock,'utf8')).pid,process.pid);}finally{await rm(dir,{recursive:true,force:true});}});


test('preparation is persisted before work while retaining the confirmed baseline', async () => {
 const dir=await mkdtemp(join(tmpdir(),'mcn-preparing-'));
 try {
  const path=join(dir,'state.json'),at='2026-10-29T07:20:14.558Z';
  const state={version:1,status:'success',active:null,publishedAsOf:'2026-10-29T06:49:45.845Z',sync:{status:'success',asOf:'2026-10-29T06:49:45.845Z'},coveredMarker:'synthetic-marker'};
  await recordPublisherPreparation(path,state,at);
  const observed=await privateRead(path);
  assert.equal(observed.status,'preparing');assert.equal(observed.checkedAt,at);
  assert.equal(observed.publishedAsOf,state.publishedAsOf);assert.equal(observed.sync.status,'success');
  assert.equal(observed.coveredMarker,'synthetic-marker');assert.deepEqual(observed,state);
  await assert.rejects(recordPublisherPreparation(path,{...state,active:{asOf:at}},at),/invalid-preparation/);
  await assert.rejects(recordPublisherPreparation(path,state,'invalid-time'),/invalid-preparation/);
  assert.deepEqual(await privateRead(path),observed);
 } finally {await rm(dir,{recursive:true,force:true});}
});


test('synchronization records current activity instead of retaining a previous failed status',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mcn-sync-status-'));try{
  const path=join(dir,'state.json'),at='2026-10-29T16:00:00.000Z',old={status:'failed',code:'aborted'},state={version:1,status:'failed',code:'aborted',active:{asOf:'2026-10-29T15:35:03.224Z',directory:'synthetic-stage'},publishedAsOf:'2026-10-29T10:54:17.235Z',coveredMarker:'same',sync:old};
  await recordPublisherSyncStart(path,state,at);const observed=await privateRead(path);assert.deepEqual(observed,state);assert.equal(observed.status,'syncing');assert.equal(observed.sync.status,'running');assert.equal(observed.sync.phase,'sync');assert.equal(observed.code,null);assert.deepEqual(observed.lastSync,old);assert.equal(observed.publishedAsOf,'2026-10-29T10:54:17.235Z');assert.equal(observed.active.directory,'synthetic-stage');
  await recordPublisherSyncStart(path,state,at);assert.deepEqual(state.lastSync,old,'an interrupted running status must not replace the last terminal result');
  for(const [input,time]of [[{...state,active:null},at],[state,'invalid'],[state,'2026-10-29T15:00:00.000Z']])await assert.rejects(recordPublisherSyncStart(path,input,time),/invalid-sync-start/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
