import test from 'node:test';import assert from 'node:assert/strict';import {createHash}from'node:crypto';
import {publishingCalendar,loadPublishingDay}from'../lib/publishing-view.mjs';
import {publishingPartitions}from'../lib/replica-publishing.mjs';
const asOf='2026-10-29T07:00:00.000Z',row=(id,date='')=>({contentId:String(id),date,author:'作者',title:'作品',targetId:1,classifications:['slice'],origin:'platform'});
function fixture(rows){const files=publishingPartitions(rows).map(p=>{const value={version:1,asOf,timeZone:'Asia/Shanghai',...(p.items?{items:p.items}:{scope:p.scope,complete:p.complete,count:p.count,days:p.days})};const content=JSON.stringify(value);return {value,content,meta:{path:p.path,kind:p.kind,count:p.items?.length??p.count,bytes:Buffer.byteLength(content),sha256:createHash('sha256').update(content).digest('hex')}};});const manifest={asOf,files:files.map(f=>f.meta)},index=files[0].value;let calls=0;
const fetcher=async(url,{signal}={})=>{calls++;if(signal?.aborted)throw new DOMException('aborted','AbortError');const q=new URL(url,'https://fixture.test').searchParams;assert.equal(q.get('generation'),asOf);const f=files.find(f=>f.meta.path===q.get('part'));return new Response(f.content,{headers:{'X-Data-SHA256':f.meta.sha256,'X-Data-Cutoff':asOf}});};return{manifest,index,files,fetcher,calls:()=>calls};}
test('Beijing calendar preserves known zero and missing days as different values',()=>{
 const days=publishingCalendar({days:[{date:'2026-10-28',works:0,tracks:{}},{date:'',works:7,tracks:{}}]},asOf);
 assert.equal(days.length,48);assert.equal(days.at(-2).works,0);assert.equal(days.at(-1).works,null);
 assert.equal(days.reduce((n,d)=>n+(d.works??0),0),0);
 assert.equal(publishingCalendar(null,'2026-10-29T15:59:59.000Z').at(-1).date,'2026-10-29');
 assert.equal(publishingCalendar(null,'2026-10-29T16:00:00.000Z').at(-1).date,'2026-10-30');
 assert.throws(()=>publishingCalendar(null,'invalid'),/日期范围/);
});
test('undated works are directly readable without fabricating a publication date',async()=>{
 const f=fixture([row(1),row(2),row(3,'2026-10-29')]);
 const rows=await loadPublishingDay({...f,day:''});assert.equal(rows.length,2);assert.equal(rows[0].date,'');assert.equal(f.calls(),1);
});
test('one selected day reads all bounded shards, without requesting other days',async()=>{
 const f=fixture([...Array.from({length:1001},(_,i)=>row(i+1,'2026-10-28')),row(2000,'2026-10-29')]);
 const rows=await loadPublishingDay({...f,day:'2026-10-28'});assert.equal(rows.length,1001);assert.equal(f.calls(),3);
});
test('generation, date, missing-part and duplicate-part mismatches stop before network',async()=>{
 const f=fixture([row(1)]);
 await assert.rejects(loadPublishingDay({...f,index:{...f.index,asOf:'older'},day:''}),/版本/);
 await assert.rejects(loadPublishingDay({...f,day:'2026-10-28'}),/尚无/);
 f.index.days[0].parts.push(f.index.days[0].parts[0]);await assert.rejects(loadPublishingDay({...f,day:''}),/重复/);f.index.days[0].parts.pop();
 await assert.rejects(loadPublishingDay({...f,manifest:{...f.manifest,files:[]},day:''}),/清单/);assert.equal(f.calls(),0);
});
test('valid hashes cannot legitimize wrong-day or duplicate work identities',async()=>{
 for(const bad of ['day','duplicate']){
  const f=fixture([row(1),row(2)]),p=f.files[1];if(bad==='day')p.value.items[0].date='2026-10-28';else p.value.items[1].contentId='1';
  p.content=JSON.stringify(p.value);p.meta.bytes=Buffer.byteLength(p.content);p.meta.sha256=createHash('sha256').update(p.content).digest('hex');
  await assert.rejects(loadPublishingDay({...f,day:''}),bad==='day'?/日期/:/去重/);
 }
});
