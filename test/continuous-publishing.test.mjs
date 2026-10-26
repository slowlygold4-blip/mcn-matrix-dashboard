import test from 'node:test';
import assert from 'node:assert/strict';
import {publishingPartitions,publishingPartValid,auditPublishing} from '../lib/replica-publishing.mjs';
const asOf='2026-10-24T07:00:00.000Z';
const row=(id,date='2026-10-13')=>({contentId:String(id),date,author:'团团作者',title:'作品',targetId:1,classifications:['slice'],origin:'platform'});
function fixture(rows){const parts=publishingPartitions(rows).map(p=>({meta:{path:p.path,kind:p.kind,count:p.items?.length??p.count},body:{version:1,asOf,timeZone:'Asia/Shanghai',...(p.items?{items:p.items}:{scope:p.scope,complete:p.complete,count:p.count,days:p.days})}}));return {parts,manifest:{asOf,files:parts.map(p=>p.meta)},readPart:async path=>parts.find(p=>p.meta.path===path)?.body};}
test('table and post-10/12 platform publications form one dated corpus, unknown date is retained separately',async()=>{
 const f=fixture([{...row(1,'2026-10-12'),origin:'source'},row(2),row(3,'')]);
 await auditPublishing(f);assert.equal(f.parts[0].body.count,3);assert.deepEqual(f.parts[0].body.days.map(d=>[d.date,d.works]),[['',1],['2026-10-12',1],['2026-10-13',1]]);assert.equal(f.parts[0].body.complete,false);
 assert.throws(()=>publishingPartitions([row(1),row(1)]),/duplicate/);
});
test('daily work rows page in bounded shards without losing any work or inventing missing days',async()=>{
 const f=fixture(Array.from({length:1001},(_,i)=>row(i+1)));await auditPublishing(f);
 assert.deepEqual(f.parts.slice(1).map(p=>p.body.items.length),[500,500,1]);assert.equal(f.parts[0].body.days.length,1);
 f.parts[0].body.days[0].works=1002;await assert.rejects(auditPublishing(f),/count/);
});
test('mixed generations, duplicate identities, stray shards and private fields fail validation',async()=>{
 const f=fixture([row(1),row(2)]),shard=f.parts[1];
 assert.equal(publishingPartValid({...shard.body,asOf:'2026-10-23T07:00:00.000Z'},shard.meta,asOf),false);
 shard.body.items[1]={...shard.body.items[0]};await assert.rejects(auditPublishing(f),/identity/);
 shard.body.items[1]={...row(2),cookie:'secret'};assert.equal(publishingPartValid(shard.body,shard.meta,asOf),false);
});
