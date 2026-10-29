import test from 'node:test';import assert from 'node:assert/strict';import {createHash}from'node:crypto';
import {publishingCalendar,loadPublishingDay,publishingTrackCount,filterPublishingRows}from'../lib/publishing-view.mjs';
import {publishingPartitions}from'../lib/replica-publishing.mjs';
const asOf='2026-10-29T07:00:00.000Z',row=(id,date='')=>({contentId:String(id),date,author:'作者',title:'作品',targetId:1,classifications:['slice'],origin:'platform'});
test('work-category counts and detail filters agree without adding multi-topic works twice',()=>{
 const rows=[{...row(1),classifications:['slice','ai-remix']},{...row(2),classifications:['original']},{...row(3),classifications:[]}];
 const index=publishingPartitions(rows)[0],day=index.days[0];
 assert.equal(publishingTrackCount(day,'all'),3);
 for(const track of ['slice','original','ai-remix','unclassified']){
  assert.equal(publishingTrackCount(day,track),1);
  assert.equal(filterPublishingRows(rows,track).length,1);
 }
 assert.equal(filterPublishingRows(rows).length,3);
 assert.equal(publishingTrackCount({works:null,tracks:{}} ,'slice'),null);
 assert.equal(publishingTrackCount({works:5,tracks:{}} ,'slice'),0);
 assert.throws(()=>filterPublishingRows(rows,'made-up'),/分类无效/);
});
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

test('publication cohort selection changes counts and adopted totals together; unknown dates are retained outside bounded cohorts',async()=>{
 const {publishingSelection,sortPublicationRows}=await import('../lib/publishing-view.mjs');
 const r=(id,date,likes,plays,classes=['slice'])=>({...row(id,date),classifications:classes,metrics:{likes:{value:likes,origin:likes===null?'unavailable':'platform'},plays:{value:plays,origin:plays===null?'unavailable':'source'}}});
 const rows=[r(1,'2026-10-28',0,100,['slice','ai-remix']),r(2,'2026-10-28',5,null),r(3,'2026-10-29',20,30,['original']),r(4,'',7,10,[])];
 const index=publishingPartitions(rows,{withMetrics:true})[0];
 assert.equal(publishingSelection(index).metrics.likes.value,32);
 const scoped=publishingSelection(index,{track:'slice',startDate:'2026-10-28',endDate:'2026-10-28'});
 assert.equal(scoped.works,2);assert.equal(scoped.metrics.likes.value,5);assert.equal(scoped.metrics.plays.known,1);assert.equal(scoped.metrics.plays.missing,1);
 assert.equal(publishingSelection(index,{track:'ai-remix'}).metrics.likes.value,0);
 assert.equal(publishingSelection(index,{startDate:'2026-10-28'}).works,3);
 assert.equal(publishingSelection(index,{startDate:'2026-10-28'}).undatedWorks,1);
 const empty=publishingSelection(index,{startDate:'2026-10-30'});assert.equal(empty.works,0);assert.equal(empty.metrics.likes.value,null);
 assert.equal(publishingSelection(publishingPartitions([row(1)])[0]).metrics,null,'旧发布版本不能回退到原表子集冒充合并合计');
 assert.throws(()=>publishingSelection(index,{startDate:'2026-02-30'}),/日期/);
 assert.throws(()=>publishingSelection(index,{startDate:'2026-10-29',endDate:'2026-10-28'}),/日期/);
 for(const direction of ['asc','desc'])assert.equal(sortPublicationRows(rows,'plays',direction).at(-1).contentId,'2','缺失值始终排在最后');
 assert.deepEqual(sortPublicationRows(rows,'likes','desc').map(r=>r.contentId),['3','4','2','1']);
 assert.deepEqual(sortPublicationRows(rows,'likes','asc').map(r=>r.contentId),['1','2','4','3']);
 assert.deepEqual(publishingCalendar(index,asOf,'2026-10-28','2026-10-28').map(d=>d.date),['2026-10-28']);
});
