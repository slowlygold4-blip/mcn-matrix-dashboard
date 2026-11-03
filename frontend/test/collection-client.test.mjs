import test from 'node:test';
import assert from 'node:assert/strict';
import {requestCollection,createCollectionStatusReader,collectionPercent} from '../lib/collection-client.mjs';
const response=value=>({ok:true,json:async()=>value});
const snapshot=name=>({online:true,canControl:true,status:{name}});
const defer=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test('a hanging fetch times out once, cancels its signal, and permits the next poll',async()=>{
 const values=[],errors=[];let calls=0,signal;
 const reader=createCollectionStatusReader({timeoutMs:10,onData:x=>values.push(x),onError:e=>errors.push(e),fetcher:async(_url,options)=>{
  calls++;signal=options.signal;return calls===1?new Promise(()=>{}):response(snapshot('recovered'));
 }});
 await reader.refresh();assert.equal(errors[0].name,'TimeoutError');assert.equal(signal.aborted,true);
 await reader.refresh();assert.equal(calls,2);assert.equal(values[0].status.name,'recovered');reader.dispose();
});
test('JSON decoding and a write are bounded without automatically repeating the command',async()=>{
 let calls=0,options;
 await assert.rejects(requestCollection({input:{action:'trigger',id:'same-id'},timeoutMs:10,fetcher:async(_url,opts)=>{
  calls++;options=opts;return {ok:true,json:()=>new Promise(()=>{})};
 }}),{name:'TimeoutError'});
 assert.equal(calls,1);assert.equal(options.method,'POST');assert.equal(options.signal.aborted,true);
 assert.deepEqual(JSON.parse(options.body),{action:'trigger',id:'same-id'});
});
test('overlapping passive polls share one read and manual refresh ignores the late old response',async()=>{
 const old=defer(),latest=defer(),values=[],errors=[];let calls=0,firstSignal;
 const reader=createCollectionStatusReader({onData:x=>values.push(x),onError:e=>errors.push(e),fetcher:(_url,{signal})=>{
  calls++;if(calls===1){firstSignal=signal;return old.promise;}return latest.promise;
 }});
 const first=reader.refresh();assert.equal(reader.refresh(),first);assert.equal(calls,1);
 const second=reader.refresh({replace:true});assert.equal(firstSignal.aborted,true);assert.equal(calls,2);
 latest.resolve(response(snapshot('new')));await second;old.resolve(response(snapshot('old')));await first;
 assert.deepEqual(values.map(x=>x.status.name),['new']);assert.deepEqual(errors,[]);reader.dispose();
});
test('unmount cancels the read and prevents late updates and subsequent requests',async()=>{
 const pending=defer();let signal,calls=0;const values=[],errors=[];
 const reader=createCollectionStatusReader({onData:x=>values.push(x),onError:e=>errors.push(e),fetcher:(_url,opts)=>{calls++;signal=opts.signal;return pending.promise;}});
 const read=reader.refresh();reader.dispose();assert.equal(signal.aborted,true);
 pending.resolve(response(snapshot('late')));await read;await reader.refresh();
 assert.equal(calls,1);assert.deepEqual(values,[]);assert.deepEqual(errors,[]);
});
test('HTTP errors and malformed snapshots report errors while retaining the last valid state',async()=>{
 const values=[],errors=[];let index=0;
 const replies=[response(snapshot('saved')),{ok:false,json:async()=>({error:'服务不可用'})},response([]),response({online:'yes',canControl:true})];
 const reader=createCollectionStatusReader({onData:x=>values.push(x),onError:e=>errors.push(e.message),fetcher:async()=>replies[index++]});
 for(const _ of replies)await reader.refresh();
 assert.deepEqual(values.map(x=>x.status.name),['saved']);assert.equal(errors.length,3);assert.equal(errors[0],'服务不可用');reader.dispose();
});
test('failed logout does not become a successful response',async()=>{
 await assert.rejects(requestCollection({input:{action:'logout'},fetcher:async()=>({ok:false,json:async()=>({error:'管理会话已失效'})})}),/管理会话已失效/);
});
test('display never rounds incomplete coverage up to 100 percent or invents a denominator',()=>{
 assert.equal(collectionPercent(4084,4085).label,'99.9');assert.ok(collectionPercent(4084,4085).value<100);
 assert.equal(collectionPercent(4085,4085).label,'100.0');assert.equal(collectionPercent(1,3).label,'33.3');
 for(const [done,total]of [[0,0],[1,null],[undefined,4],[-1,4],[Infinity,4]])assert.equal(collectionPercent(done,total),null);
});
