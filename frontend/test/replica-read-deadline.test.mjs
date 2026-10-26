import test from 'node:test';
import assert from 'node:assert/strict';
import {withReplicaReadDeadline} from '../lib/replica-read-deadline.mjs';
import {readReplicaPart} from '../lib/replica-reader.mjs';

test('a never settling whole read times out and aborts without retry',async()=>{
 const controller=new AbortController();let calls=0;
 await assert.rejects(withReplicaReadDeadline({controller,timeoutMs:5,operation:()=>{calls++;return new Promise(()=>{});}}),{name:'TimeoutError'});
 assert.equal(controller.signal.aborted,true);assert.equal(calls,1);
});
test('body decoding remains inside the same deadline',async()=>{
 const controller=new AbortController();let headersRead=false;
 await assert.rejects(withReplicaReadDeadline({controller,timeoutMs:5,operation:async()=>{headersRead=true;await new Promise(()=>{});}}),{name:'TimeoutError'});
 assert.equal(headersRead,true);
});
test('an external navigation abort settles a pending read',async()=>{
 const controller=new AbortController();const reason=new Error('superseded');
 const pending=withReplicaReadDeadline({controller,timeoutMs:100,operation:()=>new Promise(()=>{})});controller.abort(reason);
 await assert.rejects(pending,error=>error===reason);
});
test('a successful read cancels its owned timer',async()=>{
 const controller=new AbortController();assert.equal(await withReplicaReadDeadline({controller,timeoutMs:5,operation:()=>17}),17);
 await new Promise(resolve=>setTimeout(resolve,15));assert.equal(controller.signal.aborted,false);
});
test('a late resolution cannot turn the rejected lifecycle into success',async()=>{
 const controller=new AbortController();let finish;const work=new Promise(resolve=>{finish=resolve;});
 const pending=withReplicaReadDeadline({controller,timeoutMs:5,operation:()=>work});await assert.rejects(pending,{name:'TimeoutError'});finish(22);
 assert.equal(controller.signal.aborted,true);
});
test('independent part reads retain upstream cancellation even during body wait',async()=>{
 const controller=new AbortController();let received,bodyStarted;
 const started=new Promise(resolve=>{bodyStarted=resolve;});
 const pending=readReplicaPart({generation:'g',part:'catalog.json',meta:{path:'catalog.json',bytes:1,sha256:'a'.repeat(64)},signal:controller.signal,
  fetcher:async(_url,{signal})=>{received=signal;return {ok:true,text:()=>{bodyStarted();return new Promise(()=>{});}};}});
 await started;controller.abort(new Error('moved'));await assert.rejects(pending,/moved/);assert.equal(received.aborted,true);
});
test('a pre-aborted lifecycle never dispatches a read',async()=>{
 const controller=new AbortController();controller.abort();let calls=0;
 await assert.rejects(withReplicaReadDeadline({controller,operation:()=>{calls++;}}),{name:'AbortError'});assert.equal(calls,0);
});
test('an operation rejection clears its timer and retains the original error',async()=>{
 const controller=new AbortController(),reason=new Error('checksum mismatch');
 await assert.rejects(withReplicaReadDeadline({controller,timeoutMs:5,operation:()=>{throw reason;}}),error=>error===reason);
 await new Promise(resolve=>setTimeout(resolve,15));assert.equal(controller.signal.aborted,false);
});
test('invalid deadline budgets never dispatch an operation',async()=>{
 for(const timeoutMs of [0,-1,NaN,Infinity,1.5,2147483648]){let calls=0;
  await assert.rejects(withReplicaReadDeadline({controller:new AbortController(),timeoutMs,operation:()=>{calls++;}}),/参数/);assert.equal(calls,0);
 }
});
