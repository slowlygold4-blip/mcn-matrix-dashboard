// Independent Phase80 diagnostic review. Runs real createPublicReplicaSync.
// Existing synthetic fixture/protocol helpers only; no production/network data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createPublicReplicaSync,preparePublicReplicaPublication,PUBLIC_REPLICA_ORIGIN,PUBLIC_REPLICA_SUMMARY_FIELDS} from '../lib/public-replica-sync.mjs';
import {describeWorkPlays} from '../lib/work-play-semantics.mjs';

const fixtureSource=await readFile(new URL('./public-replica-sync-20261001.test.mjs',import.meta.url),'utf8');
const fixtureOnly=fixtureSource.slice(fixtureSource.indexOf("const SECRET ="),fixtureSource.indexOf("\ntest('sync prepare"));
assert.ok(fixtureOnly.startsWith('const SECRET =')&&!fixtureOnly.includes("\ntest("));
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const {fixture,fakeCloud,producer,SECRET,SENTINEL}=await new AsyncFunction('assert','createHash','createPublicReplicaSync','preparePublicReplicaPublication','PUBLIC_REPLICA_ORIGIN','PUBLIC_REPLICA_SUMMARY_FIELDS','describeWorkPlays',fixtureOnly+'\nreturn {fixture,fakeCloud,producer,SECRET,SENTINEL};')(assert,createHash,createPublicReplicaSync,preparePublicReplicaPublication,PUBLIC_REPLICA_ORIGIN,PUBLIC_REPLICA_SUMMARY_FIELDS,describeWorkPlays);
const noPrivate=value=>{
 const text=JSON.stringify(value);for(const marker of [SECRET,SENTINEL,'Authorization','private.example','transportFailureInjected'])assert.equal(text.includes(marker),false,marker);
};
const checkpointKeys=['version','origin','asOf','manifestSha256','batchSha256','completedBatches','activated','readbackFiles'].sort();

test('phase80 peer first network failure survives cancelled siblings and there is no automatic retry',async()=>{
 const cloud=fakeCloud(),native=cloud.fetch;let posts=0,pending=0;
 cloud.fetch=async(url,init={})=>{
  if(init.method!=='POST')return native(url,init);
  posts++;
  if(posts===1)throw Object.assign(Error(`https://private.example/${SECRET}`),{transportFailure:{transportFailureInjected:SENTINEL},cause:{secret:SECRET}});
  pending++;try{return await new Promise((_resolve,reject)=>{
   if(init.signal.aborted)return reject(Error(SENTINEL));
   init.signal.addEventListener('abort',()=>reject(Error(SENTINEL)),{once:true});
  });}finally{pending--;}
 };
 const sync=producer(cloud),result=await sync.sync(fixture({accounts:80}));
 assert.equal(result.code,'network-failed');assert.deepEqual(result.transportFailure,{kind:'network',method:'POST',phase:'upload',httpStatus:null});
 assert.equal(posts,4);assert.equal(pending,0);assert.equal(result.activationState,'not-attempted');
 assert.deepEqual(Object.keys(sync.checkpoint()).sort(),checkpointKeys);noPrivate(result);noPrivate(sync.snapshot());noPrivate(sync.checkpoint());
 const snapshot=sync.snapshot();snapshot.transportFailure.kind='tampered';assert.equal(sync.snapshot().transportFailure.kind,'network');
});

test('phase80 peer caller abort remains distinguishable and cannot leave a diagnostic on the next successful operation',async()=>{
 const cloud=fakeCloud(),native=cloud.fetch;const cancelled=new AbortController();let calls=0;
 cloud.fetch=async(url,init)=>{
  if(++calls!==1)return native(url,init);
  return new Promise((_resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(Error(SENTINEL)),{once:true});cancelled.abort();});
 };
 const sync=producer(cloud),first=await sync.sync(fixture(),{signal:cancelled.signal});
 assert.equal(first.code,'aborted');assert.deepEqual(first.transportFailure,{kind:'aborted',method:'GET',phase:'resume',httpStatus:null});assert.equal(calls,1);noPrivate(first);
 const second=await sync.sync(fixture());assert.equal(second.status,'success');assert.equal(Object.hasOwn(second,'transportFailure'),false);
 assert.equal(Object.hasOwn(sync.snapshot(),'transportFailure'),false);assert.deepEqual(Object.keys(sync.checkpoint()).sort(),checkpointKeys);noPrivate(sync.checkpoint());
});

test('phase80 peer malformed successful body keeps old code and no fabricated transport diagnostic or retry',async()=>{
 let calls=0;
 const sync=createPublicReplicaSync({getCredential:async()=>SECRET,fetchImpl:async()=>{calls++;return new Response(SENTINEL,{status:200});}});
 const result=await sync.sync(fixture());assert.equal(result.code,'invalid-response');assert.equal(calls,1);
 assert.equal(Object.hasOwn(result,'transportFailure'),false);noPrivate(result);noPrivate(sync.snapshot());
});

test('phase80 peer request timeout after HTTP headers must retain timeout diagnosis without leaking body or adding retries',async()=>{
 let calls=0,bodyReads=0;const keepAlive=setTimeout(()=>{},1000);
 try{
  const sync=createPublicReplicaSync({getCredential:async()=>SECRET,requestTimeoutMs:10,operationTimeoutMs:1000,
   fetchImpl:async(_url,{signal})=>{calls++;return{ok:true,status:200,
    async text(){bodyReads++;return new Promise((_resolve,reject)=>{
     if(signal.aborted)return reject(Error(SENTINEL));
     signal.addEventListener('abort',()=>reject(Error(SENTINEL)),{once:true});
    });}};}});
  const result=await sync.sync(fixture());
  assert.equal(result.code,'invalid-response','Preserve the legacy code while adding safe diagnostics');
  assert.equal(calls,1);assert.equal(bodyReads,1);noPrivate(result);noPrivate(sync.snapshot());
  assert.equal(result.transportFailure?.kind,'request-timeout','A fetch deadline can expire during response.text after successful headers');
  assert.equal(result.transportFailure?.method,'GET');assert.equal(result.transportFailure?.phase,'resume');
  assert.equal(result.transportFailure?.httpStatus,200);
 }finally{clearTimeout(keepAlive);}
});

test('phase80 peer an ordinary body exception cannot forge timeout evidence',async()=>{
 let calls=0;
 const sync=createPublicReplicaSync({getCredential:async()=>SECRET,fetchImpl:async()=>{calls++;return{ok:true,status:200,async text(){
  throw Object.assign(Error(SENTINEL),{code:'request-timeout',transportFailure:{kind:'request-timeout',secret:SECRET},cause:{secret:SECRET}});
 }}}});
 const result=await sync.sync(fixture());assert.equal(result.code,'invalid-response');assert.equal(calls,1);
 assert.equal(Object.hasOwn(result,'transportFailure'),false);noPrivate(result);
});

test('phase80 peer source part timeout preserves published state, readback-failed and actual HTTP200',async()=>{
 const source=fixture(),publication=await preparePublicReplicaPublication(source),cloud=fakeCloud(),native=cloud.fetch;
 cloud.published.set(publication.manifest.asOf,publication.manifest);let calls=0,posts=0;
 cloud.fetch=async(url,init)=>{calls++;if(init.method==='POST')posts++;
  if(new URL(url).searchParams.has('part'))return{ok:true,status:200,async text(){return new Promise((_resolve,reject)=>{
   if(init.signal.aborted)return reject(Error(SENTINEL));
   init.signal.addEventListener('abort',()=>reject(Error(SENTINEL)),{once:true});
  });}};
  return native(url,init);
 };
 const keepAlive=setTimeout(()=>{},1000);try{
  const sync=producer(cloud,{requestTimeoutMs:10,operationTimeoutMs:1000}),result=await sync.sync(source);
  assert.equal(result.code,'readback-failed');assert.equal(result.activated,true);assert.equal(result.activationState,'confirmed');
  assert.equal(calls,3);assert.equal(posts,0);assert.deepEqual(result.transportFailure,{kind:'request-timeout',method:'GET',phase:'readback',httpStatus:200});noPrivate(result);
 }finally{clearTimeout(keepAlive);}
});

test('phase80 peer caller body cancellation is aborted without confusing it with the request deadline',async()=>{
 const cancel=new AbortController();let calls=0;
 const sync=createPublicReplicaSync({getCredential:async()=>SECRET,requestTimeoutMs:1000,operationTimeoutMs:1000,
  fetchImpl:async(_url,{signal})=>{calls++;return{ok:true,status:200,async text(){return new Promise((_resolve,reject)=>{
   signal.addEventListener('abort',()=>reject(Error(SENTINEL)),{once:true});cancel.abort();
  });}};}});
 const result=await sync.sync(fixture(),{signal:cancel.signal});assert.equal(result.code,'aborted');assert.equal(calls,1);
 assert.deepEqual(result.transportFailure,{kind:'aborted',method:'GET',phase:'resume',httpStatus:200});noPrivate(result);
});
