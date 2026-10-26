import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {sourcePartsIdentity,readSourcePart,readSourceIndex} from '../lib/source-part-reader.mjs';

function sealed(items=[],revision='1697',path='authors.json') {
 const bytes=new TextEncoder().encode(JSON.stringify({revision,items}));
 return {file:{path,count:items.length,bytes:bytes.byteLength,sha256:createHash('sha256').update(bytes).digest('hex')},bytes};
}
const responder=bytes=>async()=>({ok:true,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)});
const never=()=>new Promise(()=>{});

test('source identity changes with same-revision content and includes directory, counts and lengths',()=>{
 const first=sealed([{name:'旧名字'}]),second=sealed([{name:'新名字'}]);
 assert.notEqual(sourcePartsIdentity([first.file],'1697'),sourcePartsIdentity([second.file],'1697'));
 for(const [field,value] of [['path','works-001.json'],['count',2],['bytes',first.file.bytes+1],['sha256','a'.repeat(64)]]){
  assert.notEqual(sourcePartsIdentity([first.file],'1697'),sourcePartsIdentity([{...first.file,[field]:value}],'1697'));
 }
 assert.notEqual(sourcePartsIdentity([first.file],'1697'),sourcePartsIdentity([first.file],'1697','/table-foundation/'));
 assert.notEqual(sourcePartsIdentity([first.file],'1697'),sourcePartsIdentity([first.file],'1698'));
 const another={...first.file,path:'works-001.json'};
 assert.equal(sourcePartsIdentity([first.file,another],'1697'),sourcePartsIdentity([another,first.file],'1697'));
 assert.doesNotThrow(()=>sourcePartsIdentity([],'1697'));
 assert.throws(()=>sourcePartsIdentity([first.file,first.file],'1697'),/重复/);
});

test('source reader validates sealed bytes and accepts zero records without losing real zero or null',async()=>{
 for(const items of [[],[{plays:null,likes:0,name:'一条测试'}]]){
  const {file,bytes}=sealed(items);let calls=0;
  const rows=await readSourcePart(file,'1697',undefined,'/creator-source/',{fetcher:async(url,options)=>{
   calls++;assert.equal(url,'/creator-source/authors.json');assert.equal(options.cache,'no-store');
   return responder(bytes)();
  }});
  assert.deepEqual(rows,items);assert.equal(calls,1);
 }
});

test('unsafe descriptors and invalid deadlines fail before any network call',async()=>{
 const {file}=sealed();let calls=0;const fetcher=()=>{calls++;return never();};
 for(const patch of [{path:'../outside.json'},{path:'/outside.json'},{path:'https://example.com/x.json'},{path:'nested//x.json'},{path:'a.json?x=1'},{path:'%2e%2e/x.json'},{sha256:'bad'},{count:-1},{count:null},{bytes:0}]){
  await assert.rejects(readSourcePart({...file,...patch},'1697',undefined,'/creator-source/',{fetcher}),/校验信息/);
 }
 for(const root of ['//evil/','/../','https://evil/'])await assert.rejects(readSourcePart(file,'1697',undefined,root,{fetcher}),/目录/);
 for(const url of ['https://evil/index.json','//evil/index.json','/../index.json'])await assert.rejects(readSourceIndex(url,{fetcher}),/路径/);
 await assert.rejects(readSourcePart(file,'',undefined,'/creator-source/',{fetcher}),/修订/);
 await assert.rejects(readSourcePart(file,'1697',undefined,'/creator-source/',{fetcher,timeoutMs:0}),/期限参数/);
 assert.equal(calls,0);
});

test('bytes, digest, revision and record-count mismatches are rejected',async()=>{
 const {file,bytes}=sealed([{name:'正确'}]);
 for(const patch of [{bytes:file.bytes+1},{sha256:'0'.repeat(64)},{count:2}])await assert.rejects(readSourcePart({...file,...patch},'1697',undefined,'/creator-source/',{fetcher:responder(bytes)}),/不符|校验失败/);
 await assert.rejects(readSourcePart(file,'1698',undefined,'/creator-source/',{fetcher:responder(bytes)}),/版本/);
 const malformed=new TextEncoder().encode('{');
 await assert.rejects(readSourcePart({...file,bytes:1,sha256:createHash('sha256').update(malformed).digest('hex')},'1697',undefined,'/creator-source/',{fetcher:responder(malformed)}),/内容无法读取/);
});

test('pending headers and bodies time out once, cancel their own request and leave the parent live',async()=>{
 const {file}=sealed();
 for(const phase of ['headers','body']){
  const parent=new AbortController();let requestSignal,calls=0;
  const fetcher=async(_url,{signal})=>{requestSignal=signal;calls++;return phase==='headers'?never():{ok:true,arrayBuffer:never};};
  await assert.rejects(readSourcePart(file,'1697',parent.signal,'/creator-source/',{fetcher,timeoutMs:5}),error=>error.name==='TimeoutError'&&/超时/.test(error.message));
  assert.equal(calls,1);assert.equal(requestSignal.aborted,true);assert.equal(parent.signal.aborted,false);
 }
});

test('hash validation stays within the whole-read deadline',async t=>{
 const {file,bytes}=sealed();const parent=new AbortController();let hashStarted=false;
 t.mock.method(crypto.subtle,'digest',()=>{hashStarted=true;return never();});
 await assert.rejects(readSourcePart(file,'1697',parent.signal,'/creator-source/',{fetcher:responder(bytes),timeoutMs:5}),{name:'TimeoutError'});
 assert.equal(hashStarted,true);assert.equal(parent.signal.aborted,false);
});

test('parent navigation cancellation remains AbortError even with a custom reason',async()=>{
 const {file}=sealed();const parent=new AbortController();let signal;
 const pending=readSourcePart(file,'1697',parent.signal,'/creator-source/',{fetcher:async(_url,options)=>{signal=options.signal;return never();}});
 parent.abort(new Error('route changed'));
 await assert.rejects(pending,{name:'AbortError'});assert.equal(signal.aborted,true);
 let calls=0;await assert.rejects(readSourcePart(file,'1697',parent.signal,'/creator-source/',{fetcher:()=>{calls++;}}),{name:'AbortError'});
 assert.equal(calls,0);
});

test('index headers and decoding share the deadline, successful reads clean up parent listeners and timers',async t=>{
 for(const phase of ['headers','body']){
  const parent=new AbortController();let signal;
  await assert.rejects(readSourceIndex('/creator-source/index.json',{signal:parent.signal,timeoutMs:5,fetcher:async(_url,options)=>{signal=options.signal;return phase==='headers'?never():{ok:true,json:never};}}),{name:'TimeoutError'});
  assert.equal(signal.aborted,true);assert.equal(parent.signal.aborted,false);
 }
 const parent=new AbortController();let signal;
 const add=t.mock.method(parent.signal,'addEventListener'),remove=t.mock.method(parent.signal,'removeEventListener');
 const body={version:1,stats:{works:0}};
 assert.deepEqual(await readSourceIndex('/creator-source/index.json',{signal:parent.signal,timeoutMs:10,fetcher:async(_url,options)=>{signal=options.signal;return {ok:true,json:async()=>body};}}),body);
 assert.equal(add.mock.callCount(),1);assert.equal(remove.mock.callCount(),1);
 await new Promise(resolve=>setTimeout(resolve,20));assert.equal(signal.aborted,false);
 parent.abort();assert.equal(signal.aborted,false);
});

test('index errors remain actionable and release the caller listener',async t=>{
 const parent=new AbortController();const remove=t.mock.method(parent.signal,'removeEventListener');
 await assert.rejects(readSourceIndex('/table-foundation/index.json',{signal:parent.signal,fetcher:async()=>({ok:false})}),/暂不可读/);
 await assert.rejects(readSourceIndex('/table-foundation/index.json',{signal:parent.signal,fetcher:async()=>({ok:true,json:async()=>{throw new SyntaxError('invalid');}})}),/内容无法读取/);
 assert.equal(remove.mock.callCount(),2);assert.equal(parent.signal.aborted,false);
});
