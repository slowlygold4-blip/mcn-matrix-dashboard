import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {readSourceIndex,readSourcePart} from '../lib/source-part-reader.mjs';
import {sourceEditionIdentity} from '../lib/source-edition-loader.mjs';
const generation='2026-10-29T02:00:00.000Z',hash=s=>createHash('sha256').update(s).digest('hex');
function fixture(){
 const body=JSON.stringify({version:1,asOf:generation,timeZone:'Asia/Shanghai',revision:'1',items:[{row:2,name:'作者'}]});
 const part={path:'authors.json',count:1,bytes:Buffer.byteLength(body),sha256:hash(body),generation};
 const index={version:1,asOf:generation,timeZone:'Asia/Shanghai',revision:'1',editionFingerprint:'a'.repeat(64),stats:{authors:1,works:0},files:[part]};
 const root=JSON.stringify(index),meta={path:'creator/index.json',kind:'creatorIndex',bytes:Buffer.byteLength(root),sha256:hash(root),count:0};
 const calls=[];const fetcher=async url=>{calls.push(url);if(url==='/api/replica')return Response.json({manifest:{asOf:generation,files:[meta]}});
  const query=new URL(url,'https://fixture.local').searchParams;
  if(query.get('generation')!==generation)throw Error('wrong generation');
  return new Response(query.get('part')==='creator/index.json'?root:body);};
 return {body,part,index,meta,root,calls,fetcher};
}
test('creator index reads the live sealed corpus and parts stay pinned across later publication changes',async()=>{
 const f=fixture(),index=await readSourceIndex('/creator-source/index.json',{preferReplica:true,fetcher:f.fetcher});
 assert.equal(index.asOf,generation);assert.deepEqual(await readSourcePart(index.files[0],'1',null,'/creator-source/',{fetcher:f.fetcher}),[{row:2,name:'作者'}]);
 assert.equal(f.calls.some(url=>url.startsWith('/creator-source/')),false);
 assert.ok(f.calls.every(url=>url==='/api/replica'||url.includes(encodeURIComponent(generation))));
});
test('only an old published manifest without creator parts permits static fallback',async()=>{
 const f=fixture(),calls=[];
 const index=await readSourceIndex('/creator-source/index.json',{preferReplica:true,fetcher:async url=>{calls.push(url);return Response.json(url==='/api/replica'?{manifest:{asOf:generation,files:[]}}:f.index);}});
 assert.equal(index.revision,'1');assert.deepEqual(calls,['/api/replica','/creator-source/index.json']);
 const blocked=[];await assert.rejects(readSourceIndex('/creator-source/index.json',{preferReplica:true,fetcher:async url=>{blocked.push(url);return new Response('',{status:503});}}),/暂不可读/);
 assert.deepEqual(blocked,['/api/replica']);
});
test('hash or generation drift never silently falls back to stale static data',async()=>{
 for(const change of ['hash','generation']){
  const f=fixture(),index={...f.index,files:f.index.files.map(x=>({...x,generation:change==='generation'?'2026-10-28T00:00:00.000Z':generation}))};
  const body=JSON.stringify(index),meta={...f.meta,bytes:Buffer.byteLength(body),sha256:change==='hash'?'0'.repeat(64):hash(body)};
  await assert.rejects(readSourceIndex('/creator-source/index.json',{preferReplica:true,fetcher:async url=>url==='/api/replica'?Response.json({manifest:{asOf:generation,files:[meta]}}):new Response(body)}),/校验|版本/);
 }
});
test('source content identity ignores publication-only clock changes but detects actual corpus changes',()=>{
 const f=fixture(),a=f.index,b={...a,asOf:'2026-10-29T03:00:00.000Z',files:a.files.map(x=>({...x,generation:'2026-10-29T03:00:00.000Z',sha256:'b'.repeat(64)}))};
 assert.equal(sourceEditionIdentity(a),sourceEditionIdentity(b));assert.notEqual(sourceEditionIdentity(a),sourceEditionIdentity({...b,editionFingerprint:'c'.repeat(64)}));
});
test('a previously verified manifest avoids another metadata request and keeps old-generation static sources independent',async()=>{
 const f=fixture(),calls=[];
 await readSourceIndex('/creator-source/index.json',{preferReplica:true,manifest:{asOf:generation,files:[]},fetcher:async url=>{calls.push(url);assert.equal(url,'/creator-source/index.json');return Response.json(f.index);}});
 assert.deepEqual(calls,['/creator-source/index.json']);
});
