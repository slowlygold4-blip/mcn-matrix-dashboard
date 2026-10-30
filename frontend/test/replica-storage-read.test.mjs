import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readReplicaText} from '../lib/replica-reference.mjs';
import {replicaStorageFailure} from '../lib/replica-storage-read.mjs';
const asOf='2026-10-31T00:00:00.000Z',text=JSON.stringify({version:1,asOf,items:[{likes:0}]}),
 meta={bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')};
const object=()=>({size:meta.bytes,text:async()=>text});

test('bounded GET and body recovery still returns the exact checksum-verified bytes',async()=>{
 let gets=0;const waits=[];
 const bucket={get:async()=>{gets++;if(gets===1)throw Error('R2 GET failed: (10001) PRIVATE_SENTINEL');
  if(gets===2)return {size:meta.bytes,text:async()=>{throw Error('stream failed PRIVATE_SENTINEL');}};
  return object();}};
 assert.equal(await readReplicaText(bucket,asOf,meta,null,{wait:async ms=>{waits.push(ms);}}),text);
 assert.equal(gets,3);assert.deepEqual(waits,[50,150]);
});
test('persistent storage failure ends after three attempts with fixed non-private diagnostics',async()=>{
 let gets=0;
 await assert.rejects(readReplicaText({get:async()=>{gets++;throw Error('PRIVATE_SENTINEL');}},asOf,meta,null,{wait:async()=>{}}),
  error=>error.code==='replica-storage-read'&&error.storageFailure==='read-failed'&&error.attempts===3&&!error.message.includes('PRIVATE'));
 assert.equal(gets,3);
});
test('resource, authorization and provider abort failures do not retry',async()=>{
 for(const [message,kind] of [['Too many subrequests PRIVATE_SENTINEL','resource-limit'],
  ['Access denied PRIVATE_SENTINEL','access-denied'],['AbortError PRIVATE_SENTINEL','aborted']]){
  let gets=0,waits=0;
  await assert.rejects(readReplicaText({get:async()=>{gets++;throw Error(message);}},asOf,meta,null,{wait:async()=>{waits++;}}),
   error=>error.code==='replica-storage-read'&&error.storageFailure===kind&&error.attempts===1&&!error.message.includes('PRIVATE'));
  assert.equal(gets,1);assert.equal(waits,0);
 }
 assert.equal(replicaStorageFailure(undefined),'read-failed');
});
test('missing or corrupt content never becomes a retry-success or bypasses any source proof',async()=>{
 let gets=0,cancels=0;const bucket={get:async()=>{gets++;return null;}};
 assert.equal(await readReplicaText(bucket,asOf,meta,null),undefined);assert.equal(gets,1);
 gets=0;
 await assert.rejects(readReplicaText({get:async()=>{gets++;return {size:meta.bytes+1,body:{cancel:async()=>{cancels++;}},text:async()=>text};}},asOf,meta,null),
  error=>error.code==='replica-storage-repair');
 assert.equal(gets,1);assert.equal(cancels,1);
 gets=0;
 await assert.rejects(readReplicaText({get:async()=>{gets++;return {text:async()=>text.replace('"likes":0','"likes":1')};}},asOf,meta,null),
  error=>error.code==='replica-storage-repair');assert.equal(gets,1);
});
test('client cancellation during backoff prevents subsequent reads and leaves no background retry',async()=>{
 const controller=new AbortController(),reason=Error('cancelled'),bucket={get:async()=>{gets++;throw Error('storage unavailable');}};let gets=0;
 const result=readReplicaText(bucket,asOf,meta,null,{signal:controller.signal});
 setImmediate(()=>controller.abort(reason));await assert.rejects(result,error=>error===reason);
 await new Promise(resolve=>setTimeout(resolve,70));assert.equal(gets,1);
});
test('cancellation while a GET settles releases its unread body',async()=>{
 const controller=new AbortController();let cancelled=0;
 const bucket={get:async()=>{controller.abort();return {body:{cancel:async()=>{cancelled++;}},text:async()=>text};}};
 await assert.rejects(readReplicaText(bucket,asOf,meta,null,{signal:controller.signal}),error=>error.name==='AbortError');
 assert.equal(cancelled,1);
});
