import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createPublicReplicaSync,preparePublicReplicaPublication,PUBLIC_REPLICA_ORIGIN,PUBLIC_REPLICA_SUMMARY_FIELDS} from '../lib/public-replica-sync.mjs';
import {describeWorkPlays} from '../lib/work-play-semantics.mjs';

// Reuse the existing source fixture and protocol fake, rather than substitute
// the production sync. Old test bodies are registered with a no-op, never run.
const oldSource=await readFile(new URL('./public-replica-sync-20261001.test.mjs',import.meta.url),'utf8');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const {fixture,fakeCloud,producer,SECRET,SENTINEL}=await new AsyncFunction('test','assert','createHash','createPublicReplicaSync','preparePublicReplicaPublication','PUBLIC_REPLICA_ORIGIN','PUBLIC_REPLICA_SUMMARY_FIELDS','describeWorkPlays',oldSource.replace(/^import[\s\S]*?;\n/gm,'')+'\nreturn {fixture,fakeCloud,producer,SECRET,SENTINEL};')(()=>{},assert,createHash,createPublicReplicaSync,preparePublicReplicaPublication,PUBLIC_REPLICA_ORIGIN,PUBLIC_REPLICA_SUMMARY_FIELDS,describeWorkPlays);
const rejection=status=>({ok:false,status,text(){assert.fail('rejected body must never be read');},get headers(){assert.fail('rejected headers must never be copied');}});
function privateSafe(sync,result){
 for(const value of [result,sync.snapshot(),sync.checkpoint?.()]){
  const text=JSON.stringify(value)||'';assert.equal(text.includes(SECRET),false);assert.equal(text.includes(SENTINEL),false);assert.equal(text.includes('Authorization'),false);
 }
}

test('phase80 HTTP refusal records bounded status and operation, never body/headers/credential',async()=>{
 for(const [status,category] of [[401,'authorization'],[403,'authorization'],[409,'conflict'],[429,'rate-limited'],[500,'server'],[503,'server']]){
  const cloud=fakeCloud(),native=cloud.fetch;cloud.fetch=(url,init)=>init?.method==='POST'?rejection(status):native(url,init);
  const sync=producer(cloud),result=await sync.sync(fixture());assert.equal(result.code,'sync-rejected');
  assert.deepEqual(result.transportFailure,{kind:'http',method:'POST',phase:'upload',httpStatus:status,category});assert.equal(result.activationState,'not-attempted');privateSafe(sync,result);
  assert.equal(Object.hasOwn(sync.checkpoint(),'transportFailure'),false,'v1 resumable checkpoint remains unchanged');
 }
});
test('phase80 anonymous GET denial is not mislabelled as upload or Douyin collection failure',async()=>{
 const cloud=fakeCloud();cloud.fetch=async()=>rejection(403);const sync=producer(cloud),result=await sync.sync(fixture());
 assert.equal(result.code,'readback-rejected');assert.deepEqual(result.transportFailure,{kind:'http',method:'GET',phase:'resume',httpStatus:403,category:'authorization'});assert.equal(cloud.calls.length,0);privateSafe(sync,result);
});
test('phase80 activation409 still clears staging checkpoint; subsequent exact replay succeeds and clears stale diagnostic',async()=>{
 const cloud=fakeCloud();cloud.rejectActivationOnce=true;const sync=producer(cloud);
 const first=await sync.sync(fixture());assert.equal(first.code,'sync-rejected');assert.deepEqual(first.transportFailure,{kind:'http',method:'POST',phase:'activate',httpStatus:409,category:'conflict'});assert.deepEqual(sync.checkpoint().completedBatches,[]);
 const result=await sync.sync(fixture());assert.equal(result.status,'success');assert.equal(Object.hasOwn(result,'transportFailure'),false);assert.equal(Object.hasOwn(sync.snapshot(),'transportFailure'),false);privateSafe(sync,result);
});
test('phase80 real network exception is recorded without its message, cause or stack',async()=>{
 const cloud=fakeCloud();cloud.fetch=async()=>{throw Object.assign(Error(SECRET+' '+SENTINEL),{cause:SENTINEL,transportFailure:{secret:SECRET}});};
 const sync=producer(cloud),result=await sync.sync(fixture());assert.equal(result.code,'network-failed');assert.deepEqual(result.transportFailure,{kind:'network',method:'GET',phase:'resume',httpStatus:null});privateSafe(sync,result);
});
test('phase80 per-request timeout differs from ordinary network failure while retaining old error-code contract',async()=>{
 const keepAlive=setTimeout(()=>{},1000);try{
  const sync=createPublicReplicaSync({getCredential:async()=>SECRET,requestTimeoutMs:10,operationTimeoutMs:1000,
   fetchImpl:async(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error(SENTINEL)),{once:true}))});
  const result=await sync.sync(fixture());assert.equal(result.code,'network-failed');assert.deepEqual(result.transportFailure,{kind:'request-timeout',method:'GET',phase:'resume',httpStatus:null});privateSafe(sync,result);
 }finally{clearTimeout(keepAlive);}
});
test('phase80 parallel cancellation cannot replace the first HTTP failure and no request outlives it',async()=>{
 const cloud=fakeCloud(),native=cloud.fetch;let count=0,pending=0;
 cloud.fetch=async(url,init={})=>{
  if(init.method!=='POST')return native(url,init);
  if(++count===1)return rejection(429);
  pending++;try{return await new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(Error(SENTINEL)),{once:true}));}finally{pending--;}
 };
 const sync=producer(cloud),result=await sync.sync(fixture({accounts:40}));assert.equal(result.code,'sync-rejected');assert.equal(result.transportFailure.httpStatus,429);assert.equal(result.transportFailure.kind,'http');assert.equal(pending,0);assert.equal(count,4);privateSafe(sync,result);
});
test('phase80 forged diagnostics from credential supplier cannot enter safe product status',async()=>{
 const cloud=fakeCloud(),sync=producer(cloud,{getCredential:async()=>{throw Object.assign(Error(SENTINEL),{code:'sync-rejected',transportFailure:{httpStatus:403,secret:SECRET}});}});
 const result=await sync.sync(fixture());assert.equal(result.code,'credential-unavailable');assert.equal(Object.hasOwn(result,'transportFailure'),false);privateSafe(sync,result);
});
