import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWorkDailyLikes,dailyWorkLikesExport} from '../lib/work-daily-likes.mjs';
const options={targetId:1,workId:7,asOf:'2026-10-30T05:00:00.000Z'};
const sample=(id,capturedAt,likes,extra={})=>({id,targetId:1,workId:7,externalId:'7500000000000000001',capturedAt,likes,...extra});
const day=(date,likes,id=1)=>sample(id,date+'T04:00:00.000Z',likes);

test('daily work endpoints choose the last known value on each Beijing day without adding samples',()=>{
 const records=[day('2026-10-28',100),sample(2,'2026-10-29T01:00:00.000Z',110),
  sample(3,'2026-10-29T03:00:00.000Z',120),sample(4,'2026-10-29T04:00:00.000Z',null),day('2026-10-30',125,5)];
 const original=JSON.stringify(records),model=buildWorkDailyLikes(records,options);
 assert.deepEqual(model.rows.map(r=>[r.date,r.likes,r.likesDelta]),[['2026-10-28',100,null],['2026-10-29',120,20],['2026-10-30',125,5]]);
 assert.equal(model.rows[1].likesAt,'2026-10-29T03:00:00.000Z');assert.equal(model.rows[1].sampleCount,3);
 assert.equal(model.rows[2].baselineAt,model.rows[1].likesAt);assert.equal(model.samples.length,5);
 assert.equal(JSON.stringify(records),original);assert.equal(model.missingDays,0);assert.equal(model.modelCalls,0);
});

test('UTC rollover uses Beijing date and retains real zero and negative daily differences',()=>{
 const model=buildWorkDailyLikes([sample(1,'2026-10-28T15:59:59.000Z',10),
  sample(2,'2026-10-28T16:00:00.000Z',10),sample(3,'2026-10-29T16:00:00.000Z',0)],options);
 assert.deepEqual(model.rows.map(r=>[r.date,r.likes,r.likesDelta]),[['2026-10-28',10,null],['2026-10-29',10,0],['2026-10-30',0,-10]]);
 assert.equal(model.current.reason,'comparable');
});

test('missing dates cannot borrow an older baseline or become zero; today is explicit even when stale',()=>{
 const model=buildWorkDailyLikes([day('2026-10-25',100),day('2026-10-28',150,2)],options);
 assert.deepEqual(model.gaps,[{start:'2026-10-26',end:'2026-10-27',days:2},{start:'2026-10-29',end:'2026-10-30',days:2}]);
 assert.equal(model.missingDays,4);assert.equal(model.latest.likes,150);
 assert.equal(model.rows[1].likesDelta,null);assert.equal(model.rows[1].reason,'missing-baseline');
 assert.equal(model.current.date,'2026-10-30');assert.equal(model.current.likes,null);
 assert.equal(model.current.likesDelta,null);assert.equal(model.current.reason,'missing-current');
});

test('an observation with an unknown count is not a witnessed zero',()=>{
 const model=buildWorkDailyLikes([day('2026-10-29',null),day('2026-10-30',0,2)],options);
 assert.equal(model.observedDays,1);assert.equal(model.missingDays,1);
 assert.equal(model.current.likes,0);assert.equal(model.current.likesDelta,null);
 assert.equal(model.current.reason,'missing-baseline');
});

test('empty work history shows no fabricated current count or baseline',()=>{
 const model=buildWorkDailyLikes([],options);
 assert.equal(model.externalId,null);assert.equal(model.latest,null);assert.equal(model.observedDays,0);
 assert.equal(model.missingDays,1);assert.equal(model.current.reason,'missing-current');assert.equal(model.current.sampleCount,0);
});

test('other works in the same account cannot contribute to a work delta',()=>{
 const model=buildWorkDailyLikes([day('2026-10-29',9999,1),day('2026-10-30',1,2),
  day('2026-10-30',99999,3,{})].map((row,i)=>i===0?{...row,workId:8}:i===2?{...row,workId:9}:row),options);
 assert.equal(model.samples.length,1);assert.equal(model.current.likes,1);assert.equal(model.current.likesDelta,null);
});

test('foreign accounts, identity drift, duplicate IDs, future timestamps and invalid counters fail closed',()=>{
 for(const extra of [{targetId:2},{workId:0},{id:0},{capturedAt:'invalid'},{capturedAt:'2026-10-31T00:00:00.000Z'},
  {likes:undefined},{likes:false},{likes:''},{likes:-1},{likes:1.5},{likes:9007199254740992},{externalId:''}])
  assert.throws(()=>buildWorkDailyLikes([day('2026-10-30',100),sample(2,'2026-10-30T03:00:00.000Z',101,extra)],options));
 assert.throws(()=>buildWorkDailyLikes([day('2026-10-30',1),day('2026-10-30',1)],options));
 assert.throws(()=>buildWorkDailyLikes([day('2026-10-29',1),day('2026-10-30',2,2,{})].map((r,i)=>i?{...r,externalId:'different'}:r),options));
 assert.throws(()=>buildWorkDailyLikes([], {...options,asOf:'2026-10-30'}));
});

test('same-time contradictory values do not silently win by insertion order',()=>{
 for(const rows of [[day('2026-10-29',10),day('2026-10-29',20,2)],
  [day('2026-10-29',20,2),day('2026-10-29',10)]])assert.throws(()=>buildWorkDailyLikes(rows,options));
 const model=buildWorkDailyLikes([day('2026-10-29',10),day('2026-10-29',10,2),day('2026-10-29',null,3)],options);
 assert.equal(model.rows[0].likes,10);assert.equal(model.rows[0].sampleCount,3);
});

test('sparse long retention does not allocate one object for every missing calendar day',()=>{
 const model=buildWorkDailyLikes([sample(1,'2000-01-01T00:00:00.000Z',1)],{...options,asOf:'2100-01-01T00:00:00.000Z'});
 assert.equal(model.rows.length,2);assert.equal(model.gaps.length,1);assert.ok(model.missingDays>36000);
});

test('daily export retains both true observation timestamps, nulls and the exact immutable partition hash',()=>{
 const model=buildWorkDailyLikes([day('2026-10-29',10),day('2026-10-30',7,2)],options);
 const account={id:1,label:'fixture'},manifest={asOf:options.asOf,files:[{path:'work-metrics/1.json',kind:'workMetrics',targetId:1,count:2,sha256:'a'.repeat(64)}]};
 const result=dailyWorkLikesExport(model,{account,manifest});
 const record=Object.fromEntries(result[0].map((k,i)=>[k,result[2][i]]));
 assert.equal(record['日净变化'],-3);assert.equal(record['指标采样UTC'],'2026-10-30T04:00:00.000Z');
 assert.equal(record['前日指标采样UTC'],'2026-10-29T04:00:00.000Z');assert.equal(record['历史分区SHA256'],'a'.repeat(64));
 assert.equal(result[1][10],null);
 for(const bad of [{...manifest,asOf:'2026-10-29T00:00:00.000Z'}, {...manifest,files:[]},
  {...manifest,files:[{...manifest.files[0],targetId:2}]}, {...manifest,files:[manifest.files[0],manifest.files[0]]}])
  assert.throws(()=>dailyWorkLikesExport(model,{account,manifest:bad}));
});
