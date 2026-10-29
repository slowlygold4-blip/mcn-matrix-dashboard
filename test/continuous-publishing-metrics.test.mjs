import test from 'node:test';
import assert from 'node:assert/strict';
import {publishingPartitions,publishingPartValid,auditPublishing} from '../lib/replica-publishing.mjs';
const asOf='2026-10-30T00:00:00.000Z';
const point=(value,origin=value===null?'unavailable':'platform')=>({value,origin});
const row=(id,date,likes,plays,classes=['slice'])=>({contentId:String(id),date,author:'作者',title:'作品',targetId:1,
 classifications:classes,origin:'platform',metrics:{likes:point(likes),plays:point(plays)}});
const rows=()=>[row(1,'2026-10-28',0,100,['slice','ai-remix']),row(2,'2026-10-28',5,null),
 {...row(3,'2026-10-29',null,20,['original']),metrics:{likes:point(null,'conflict'),plays:point(20,'source')}},row(4,'',7,null,[])];
function fixture(input){const parts=publishingPartitions(input,{withMetrics:true}).map(({path,kind,count,items,...rest})=>({
 meta:{path,kind,count:items?.length??count},body:{version:1,asOf,timeZone:'Asia/Shanghai',...rest,...(items?{items}:{count})}}));
 return {parts,manifest:{asOf,files:parts.map(p=>p.meta)},readPart:async path=>parts.find(p=>p.meta.path===path)?.body};}
test('one adopted value feeds global, day, multi-category and row metrics without zeroing missing or adding duplicates',async()=>{
 const f=fixture(rows());await auditPublishing(f);const index=f.parts[0].body;
 assert.equal(index.metrics.all.works,4);assert.deepEqual(index.metrics.all.likes,{value:12,known:3,missing:1,conflicts:1,overflow:false});
 assert.deepEqual(index.metrics.all.plays,{value:120,known:2,missing:2,conflicts:0,overflow:false});
 assert.equal(index.metrics.slice.likes.value,5);assert.equal(index.metrics['ai-remix'].likes.value,0);
 assert.equal(index.metrics.unclassified.likes.value,7);assert.equal(index.days.find(d=>d.date==='2026-10-28').metrics.all.likes.value,5);
 assert.equal(index.days.find(d=>d.date==='2026-10-29').metrics.all.likes.value,null);
 assert.equal(index.complete,false);assert.throws(()=>publishingPartitions([...rows(),rows()[0]],{withMetrics:true}),/duplicate/);
});
test('safe integer overflow stays unavailable while preserving coverage counts',async()=>{
 const f=fixture([row(1,'2026-10-28',Number.MAX_SAFE_INTEGER,null),row(2,'2026-10-28',1,null)]);
 await auditPublishing(f);assert.deepEqual(f.parts[0].body.metrics.all.likes,{value:null,known:2,missing:0,conflicts:0,overflow:true});
});
test('forged global/day aggregates cannot pass a full row audit even when all values are valid numbers',async()=>{
 for(const scope of ['global','day']){const f=fixture(rows()),index=f.parts[0].body;
  (scope==='global'?index.metrics.all:index.days.find(d=>d.date==='2026-10-28').metrics.all).likes.value=99;
  assert.equal(publishingPartValid(index,f.parts[0].meta,asOf),true);
  await assert.rejects(auditPublishing(f),scope==='global'?/total-metrics/:/daily-metrics/);
 }
});
test('metric rows and historical rows cannot silently mix into a claimed complete aggregate',async()=>{
 const f=fixture(rows()),p=f.parts.find(p=>p.meta.kind==='publishingShard');delete p.body.items[0].metrics;
 await assert.rejects(auditPublishing(f),/metric-mode/);
 assert.throws(()=>publishingPartitions(rows()),/metric-mode/);
 assert.throws(()=>publishingPartitions([{...rows()[0],metrics:{likes:point(0,'conflict'),plays:point(null)}}],{withMetrics:true}),/metric-mode/);
 const index=f.parts[0].body;index.metrics.all.likes.missing=0;
 assert.equal(publishingPartValid(index,f.parts[0].meta,asOf),false);
});
test('empty but uncollected works never acquire zero engagement counters',async()=>{
 const f=fixture([]);await auditPublishing(f);assert.deepEqual(f.parts[0].body.metrics.all.likes,{value:null,known:0,missing:0,conflicts:0,overflow:false});
 const missing=fixture([row(1,'2026-10-28',null,null)]);await auditPublishing(missing);assert.equal(missing.parts[0].body.metrics.all.likes.value,null);
});
