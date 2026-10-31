import test from 'node:test';import assert from 'node:assert/strict';
import {publicationDateCounts,publicationDateBasisValid,savedPublicationDateValid} from '../lib/publication-date-basis.mjs';
import {publishingPartitions,publishingPartValid,auditPublishing} from '../lib/replica-publishing.mjs';
import {scopedPublishingIndex,publishingSelection,publishingCalendar} from '../lib/publishing-view.mjs';
import {authorDailyPublication} from '../lib/author-daily-publication.mjs';
import {mergeAuthorWorks,authorWorkExportRows} from '../lib/author-unified-works.mjs';
import {creatorPartValid} from '../lib/replica-creator.mjs';
const at='2026-10-30T08:00:00.000Z',date='2026-10-30';
const metrics={likes:{value:0,origin:'source'},plays:{value:null,origin:'unavailable'}};
const row=(id,basis,scopeId=0)=>({contentId:String(7500000000000000000n+BigInt(id)),date:basis==='missing'?'':date,author:'作者',title:'作品',targetId:1,classifications:id===3?['slice','original']:['slice'],origin:'source',metrics,scopeId,platform:'douyin',dateBasis:basis});
function publication(){const rows=[row(1,'platform-timestamp'),row(2,'source-explicit-date'),row(3,'source-inferred-date',1),row(4,'source-date-conflict',1),row(5,'missing')];
 const scopes=[{theme:'tuantuan',boardKeys:['团团'],labels:['slice']},{theme:'other',boardKeys:['其他'],labels:['slice']}];
 const parts=publishingPartitions(rows,{withMetrics:true,scopes,withDates:true}),manifest={asOf:at,files:parts.map(p=>({path:p.path,kind:p.kind,count:p.items?.length??p.count}))};
 const bodies=new Map(parts.map(({path,kind,...body})=>[path,{version:1,asOf:at,timeZone:'Asia/Shanghai',...body}]));return {rows,manifest,bodies,index:bodies.get('publishing.json')};}
test('date authority remains separate from counters; filters and scopes recalculate the same exact date counts',async()=>{
 const p=publication();assert.deepEqual(publicationDateCounts(p.rows).all,{confirmed:2,unverified:2,missing:1});
 for(const meta of p.manifest.files)assert.equal(publishingPartValid(p.bodies.get(meta.path),meta,at),true,meta.path);
 await auditPublishing({manifest:p.manifest,readPart:async path=>p.bodies.get(path)});
 const scoped=scopedPublishingIndex(p.index,{theme:'tuantuan'}),selected=publishingSelection(scoped,{});
 assert.deepEqual(selected.dateCounts,{confirmed:2,unverified:0,missing:1});
 assert.deepEqual(publishingSelection(p.index,{track:'original'}).dateCounts,{confirmed:0,unverified:1,missing:0});
 const calendar=publishingCalendar(p.index,at,'2026-10-29');assert.equal(calendar[0].works,null);assert.equal(calendar[0].dateCounts,null);assert.deepEqual(calendar[1].dateCounts.all,{confirmed:2,unverified:2,missing:0});
 assert.equal(p.index.metrics.all.likes.value,0);assert.equal(p.index.metrics.all.plays.value,null);
});
test('a confidence swap with unchanged totals, missing row basis and unknown basis cannot pass publication audit',async()=>{
 for(const fault of ['swap','missing','invalid']){
  const p=publication(),path=p.index.days.find(d=>d.date===date).parts[0],part=p.bodies.get(path);
  if(fault==='swap'){p.index.days.find(d=>d.date===date).dateCounts.all.confirmed--;p.index.days.find(d=>d.date===date).dateCounts.all.unverified++;}
  if(fault==='missing')delete part.items[0].dateBasis;
  if(fault==='invalid')part.items[0].dateBasis='claimed-verified';
  await assert.rejects(auditPublishing({manifest:p.manifest,readPart:async path=>p.bodies.get(path)}));
 }
});
test('author daily publication counts precise and explicitly submitted dates, retains all pending records and their CSV provenance',()=>{
 const sourceWorks=[{row:2,contentId:row(2,'source-explicit-date').contentId,douyinId:'author_a',publishDate:date,dateBasis:'source-explicit-date',inferredPublishDate:'2026-10-29',likes:0,plays:null},
 {row:3,contentId:row(3,'source-inferred-date').contentId,douyinId:'author_a',publishDate:date,dateBasis:'source-inferred-date',likes:5,plays:null},
 {row:4,contentId:row(4,'missing').contentId,douyinId:'author_a',publishDate:'',dateBasis:'missing',likes:null,plays:null}];
 const sourceBefore=structuredClone(sourceWorks),merged=mergeAuthorWorks({author:{douyinId:'author_a',targetIds:[]},sourceWorks,platformWorks:[],asOf:at});
 const model=authorDailyPublication(merged,{asOf:at});assert.equal(model.knownWorks,1);assert.equal(model.recordedWorks,2);assert.equal(model.unverifiedDateWorks,1);assert.equal(model.status,'published');assert.equal(model.complete,false);
 assert.equal(merged[0].sourceInferredPublishedOn,'2026-10-29');assert.deepEqual(sourceWorks,sourceBefore);
 assert.equal(merged[2].publicationDateBasis,'missing');assert.equal(merged[2].publishedOn,null);assert.equal(model.undatedWorks,1);
 assert.equal(savedPublicationDateValid(merged[2],at),true);
 const table=authorWorkExportRows(merged);assert.ok(table[0].includes('发布日期依据'));assert.ok(table[1].includes('明确填报日期'));assert.equal(table[1].at(-1),'2026-10-29');assert.ok(table[2].includes('推算日期，待核验'));
 const pending=authorDailyPublication([merged[1]],{asOf:at});assert.equal(pending.status,'date-unverified');assert.equal(pending.knownWorks,0);assert.equal(pending.rows.length,1);
});
test('old records stay readable and strict date contracts reject invented precision or unsafe optional creator fields',()=>{
 for(const basis of ['source-explicit-date','source-inferred-date','source-date-conflict','unverified-date','creator-source-date-only'])assert.equal(savedPublicationDateValid({publicationDateBasis:basis,publishedAt:null,publishedOn:date},at),true,basis);
 assert.equal(savedPublicationDateValid({publishedAt:'2026-10-30T00:00:00.000Z'},at,{allowLegacy:true}),true);
 assert.equal(savedPublicationDateValid({publicationDateBasis:'source-explicit-date',publishedAt:'2026-10-30T00:00:00.000Z',publishedOn:date},at),false);
 assert.equal(publicationDateBasisValid('source-inferred-date',''),false);
 const work={row:2,contentId:row(2,'source-inferred-date').contentId,author:'作者',douyinId:'author_a',publishDate:date,type:'video',track:'',tracks:'',plays:null,likes:0,title:'标题',url:null};
 const meta={path:'creator/works-001.json',kind:'creatorWorks',count:1},part=value=>({version:1,asOf:at,timeZone:'Asia/Shanghai',revision:'1',items:[value]});
 assert.equal(creatorPartValid(part(work),meta,at),true);assert.equal(creatorPartValid(part({...work,dateBasis:'source-explicit-date',inferredPublishDate:'2026-10-29'}),meta,at),true);
 for(const extra of [{dateBasis:'platform-timestamp'},{dateBasis:'missing'},{dateBasis:'unknown'},{dateBasis:'source-explicit-date',inferredPublishDate:'2026-02-30'},{dateBasis:'source-explicit-date',private:'secret'}])assert.equal(creatorPartValid(part({...work,...extra}),meta,at),false);
});
