import test from 'node:test';import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';import {once} from 'node:events';import {writeFileSync} from 'node:fs';
import {ConsoleReader} from '../lib/console-reader.mjs';

test('real idle threads exit and the next uncached read recreates one worker with identical results',{timeout:10000},async()=>{
 const workers=[],observations=[];let active=0,peak=0;
 const reader=new ConsoleReader({databasePath:'unused-by-this-synthetic-worker',idleTimeoutMs:30,
  workerFactory:()=>{
   const worker=new Worker(`const {parentPort}=require('node:worker_threads');const held=Buffer.alloc(64*1024*1024,7);
    parentPort.on('message',job=>parentPort.postMessage({id:job.id,ok:true,result:{bytes:held.length,value:held[0],query:job.options.q}}));`,{eval:true});
   workers.push(worker);active++;peak=Math.max(peak,active);worker.once('exit',()=>{active--;});return worker;
  }});
 try{
  assert.equal(workers.length,0);
  const a=await reader.creatorOperatingView({q:'retention-fixture'}),first=workers[0];
  observations.push({phase:'first-response',rss:process.memoryUsage().rss});
  await once(first,'exit',{signal:AbortSignal.timeout(3000)});
  observations.push({phase:'idle-exit',rss:process.memoryUsage().rss});
  assert.equal(first.threadId,-1);assert.equal(reader.worker,null);assert.equal(reader.jobs.size,0);
  const b=await reader.creatorOperatingView({q:'retention-fixture'});assert.deepEqual(b,a);assert.equal(workers.length,2);assert.equal(peak,1);
  await reader.close();assert.equal(workers[1].threadId,-1);assert.equal(active,0);assert.equal(reader.maintenanceTimer,null);
  if(process.env.MCN_READER_LIFECYCLE_EVIDENCE)writeFileSync(process.env.MCN_READER_LIFECYCLE_EVIDENCE,JSON.stringify({kind:'synthetic-real-worker-lifecycle',workersCreated:workers.length,peakConcurrentWorkers:peak,heldBytesPerWorker:64*1024*1024,identicalResponses:true,observations,databaseReads:0,databaseWrites:0},null,2)+'\n',{flag:'wx'});
 }finally{await reader.close();}
});
