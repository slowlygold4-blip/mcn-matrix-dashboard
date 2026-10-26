import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {presentUnifiedWorkMetric} from '../lib/unified-work-presentation.mjs';
import {readReplicaPart,validateUnifiedWorksPart} from '../lib/replica-reader.mjs';

const asOf='2026-10-23T08:00:00.000Z';
const observedAt='2026-10-23T07:50:00.000Z';
const sourceRefreshedAt='2026-10-12T09:00:00.000Z';
const id='7695811343009594289';
const source={targetId:7,id:'creator-source:2:9',externalId:id,source:'creator-source',
 likes:30,plays:3000,sourceCumulativeLikes:30,sourceCumulativePlays:3000,
 sourceRefreshedAt,lastObservedAt:null};
const platform={targetId:7,id:90,externalId:id,source:null,likes:42,plays:4200,lastObservedAt:observedAt,
 playsEvidence:{mayBePlaceholder:false,note:'公开来源返回字段，未独立核验实际播放。'}};
const merged={...platform,source:'platform-and-creator-source',sourceCumulativeLikes:30,
 sourceCumulativePlays:3000,sourceRefreshedAt};

test('same work shows latest platform field and retains table cumulative without summing',()=>{
 const likes=presentUnifiedWorkMetric(merged,'likes'),plays=presentUnifiedWorkMetric(merged,'plays');
 assert.deepEqual([likes.value,likes.origin,likes.sourceValue,likes.platformValue,likes.observedAt],
  [42,'platform',30,42,observedAt]);
 assert.deepEqual([plays.value,plays.origin,plays.sourceValue,plays.platformValue],
  [4200,'platform',3000,4200]);
 assert.equal(likes.sourceRefreshedAt,sourceRefreshedAt);
 assert.match(likes.sourceNote,/不是这项指标的采样时间/);
 assert.equal('delta' in likes,false);
});

test('source-only and platform-only works remain single rows with distinct origins',()=>{
 assert.deepEqual([presentUnifiedWorkMetric(source,'likes').value,presentUnifiedWorkMetric(source,'likes').origin],[30,'source']);
 assert.deepEqual([presentUnifiedWorkMetric(platform,'likes').value,presentUnifiedWorkMetric(platform,'likes').origin],[42,'platform']);
 assert.equal(presentUnifiedWorkMetric(platform,'likes').sourceValue,null);
 const oldSource={targetId:7,id:'creator-source:1:7',externalId:'7695811343009594290',likes:0,plays:null};
 assert.deepEqual([presentUnifiedWorkMetric(oldSource,'likes').value,presentUnifiedWorkMetric(oldSource,'likes').origin],[0,'source']);
 assert.equal(presentUnifiedWorkMetric(oldSource,'plays').value,null);
});

test('a missing platform field falls back to source, without fabricating an observation date',()=>{
 const missing={...merged,likes:null,plays:null};
 const likes=presentUnifiedWorkMetric(missing,'likes'),plays=presentUnifiedWorkMetric(missing,'plays');
 assert.deepEqual([likes.value,likes.origin,likes.observedAt,likes.platformValue],[30,'source',null,null]);
 assert.deepEqual([plays.value,plays.origin,plays.observedAt],[3000,'source',null]);
 assert.equal(presentUnifiedWorkMetric({...platform,likes:null},'likes').value,null);
 const placeholder=presentUnifiedWorkMetric({...merged,plays:0,playsEvidence:{mayBePlaceholder:true}},'plays');
 assert.deepEqual([placeholder.value,placeholder.origin,placeholder.platformValue,placeholder.platformUsable],[3000,'source',0,false]);
 assert.match(placeholder.note,/可能是占位/);
});

test('undated platform observations do not supersede a known source value',()=>{
 for(const lastObservedAt of [null,'invalid']){
  const adopted=presentUnifiedWorkMetric({...merged,lastObservedAt},'likes');
  assert.deepEqual([adopted.value,adopted.origin,adopted.platformUsable],[30,'source',false]);
  assert.match(adopted.note,/未记录有效采样时间/);
 }
 const only=presentUnifiedWorkMetric({...platform,lastObservedAt:null},'likes');
 assert.equal(only.value,42);assert.equal(only.observedAt,null);assert.match(only.note,/未记录有效采样时间/);
});

test('identity and same-account content conflicts cannot be silently combined',()=>{
 assert.throws(()=>presentUnifiedWorkMetric({...merged,id:'creator-source:2:9'},'likes'),/冲突/);
 assert.throws(()=>presentUnifiedWorkMetric({...source,id:90},'likes'),/冲突/);
 assert.throws(()=>validateUnifiedWorksPart([source,{...platform,id:91}],asOf),/重复/);
 assert.throws(()=>validateUnifiedWorksPart([{...platform,sourceCumulativeLikes:30}],asOf),/缺少严格关联/);
 assert.throws(()=>validateUnifiedWorksPart([{...merged,sourceRefreshedAt:'2026-10-24T00:00:00.000Z'}],asOf),/超出固定版本/);
 assert.throws(()=>validateUnifiedWorksPart([{...source,sourceCumulativePlays:-1}],asOf),/累计指标无效/);
});

test('sealed per-account reader preserves all rows for caller pagination and makes one request',async()=>{
 const items=Array.from({length:45},(_,n)=>({...platform,id:100+n,externalId:String(7695811343009594289n+BigInt(n))}));
 const part='works/7.json',body=JSON.stringify({version:1,asOf,timeZone:'Asia/Shanghai',items});
 const sha256=createHash('sha256').update(body).digest('hex');
 const meta={path:part,kind:'works',targetId:7,count:items.length,bytes:Buffer.byteLength(body),sha256};
 let calls=0;
 const loaded=await readReplicaPart({generation:asOf,part,meta,fetcher:async(url)=>{
  calls++;assert.match(url,/part=works%2F7.json/);
  return new Response(body,{headers:{'X-Data-Cutoff':asOf,'X-Data-SHA256':sha256}});
 }});
 assert.equal(calls,1);assert.equal(loaded.items.length,45);
 assert.deepEqual(loaded.items.slice(20,40).map(x=>x.id),items.slice(20,40).map(x=>x.id));
});
