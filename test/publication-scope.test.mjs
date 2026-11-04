import test from 'node:test';import assert from 'node:assert/strict';
import {buildPublicationCatalog}from'../lib/publication-catalog.mjs';
import {publishingPartitions,auditPublishing,publishingPartValid}from'../lib/replica-publishing.mjs';
const asOf='2026-10-30T00:00:00.000Z';
const account=(id,theme,labels,boards=['测试矩阵'],platform='douyin')=>({id,label:'作者'+id,platform,boardKeys:boards,
 classification:{theme:{key:theme,confirmed:true},labels:labels.map(key=>({key}))}});
const work=(id,extra={})=>({externalId:String(id),caption:'作品',publishedAt:'2026-10-28T17:00:00Z',lastObservedAt:asOf,likes:5,plays:0,...extra});
const source=(id,extra={})=>({contentId:String(id),date:'2026-10-29',author:'原作者',title:'原作品',targetId:null,
 classifications:['original'],origin:'source',metrics:{likes:{value:10,origin:'source'},plays:{value:20,origin:'source'}},...extra});
function edition(catalog){catalog=structuredClone(catalog);const parts=publishingPartitions(catalog.rows,{withMetrics:true,scopes:catalog.scopes}).map(({path,kind,count,items,...rest})=>({
 meta:{path,kind,count:items?.length??count},body:{version:1,asOf,timeZone:'Asia/Shanghai',...rest,...(items?{items}:{count})}}));
 return {parts,manifest:{asOf,files:parts.map(p=>p.meta)},readPart:async path=>parts.find(p=>p.meta.path===path)?.body};}
test('all verified catalog works join source corpus even without a source import, including Bilibili and other themes',async()=>{
 const accounts=[account(1,'tuantuan',['slice']),account(2,'anlan',['original']),account(3,'douyin-streamers',[],['抖音主播板块']),account(4,'anlan',[],'B站矩阵'.split(), 'bilibili')];
 const partitions=accounts.map(a=>({kind:'works',targetId:a.id,items:[work(a.id===4?'BV1233d6aESc':a.id)]}));
 const catalog=buildPublicationCatalog({sourceWorks:[source(99)],accounts,partitions,asOf});
 assert.equal(catalog.rows.length,5);assert.equal(catalog.rows.filter(r=>r.platform==='bilibili').length,1);
 assert.equal(catalog.rows.find(r=>r.contentId==='4')?.platform,undefined);
 assert.equal(catalog.rows.find(r=>r.platform==='bilibili').metrics.plays.value,0);
 assert.equal(catalog.rows.find(r=>r.contentId==='1').metrics.plays.value,null,'Douyin zero placeholders are missing');
 assert.equal(catalog.rows.find(r=>r.contentId==='1').date,'2026-10-29','publication day uses Beijing time');
 const f=edition(catalog);await auditPublishing(f);assert.equal(f.parts[0].body.scope,'matrix');
});
test('overlapping source/platform work is one row with existing adopted values, not a sum or arbitrary overwrite',()=>{
 const accounts=[account(1,'tuantuan',['slice'])],partitions=[{kind:'works',targetId:1,items:[work(1,{likes:999})]}];
 const c=buildPublicationCatalog({sourceWorks:[source(1,{targetId:1})],accounts,partitions,asOf});
 assert.equal(c.rows.length,1);assert.equal(c.rows[0].metrics.likes.value,10);assert.equal(c.rows[0].origin,'source');
 assert.deepEqual(c.scopes[c.rows[0].scopeId].labels,['slice']);assert.deepEqual(c.rows[0].classifications,['original'],'work and account labels remain separate');
});
test('unlinked dataset proves Tuantuan slice-matrix ownership; work hashtags cannot invent author labels',()=>{
 const c=buildPublicationCatalog({sourceWorks:[source(1),source(2,{registeredAuthorClassifications:['ai-remix']})],accounts:[],partitions:[],asOf});
 assert.deepEqual(c.scopes[c.rows.find(r=>r.contentId==='1').scopeId],{theme:'tuantuan',boardKeys:['一条小团团切片矩阵'],labels:['slice']});
 assert.deepEqual(c.scopes[c.rows.find(r=>r.contentId==='2').scopeId].labels,['ai-remix','slice']);
});
test('ambiguous platform ownership is retained only in original histories, not arbitrarily counted in unified ledger',()=>{
 const accounts=[account(1,'anlan',[]),account(2,'tuantuan',[])],partitions=accounts.map(a=>({kind:'works',targetId:a.id,items:[work(1)]}));
 const c=buildPublicationCatalog({sourceWorks:[],accounts,partitions,asOf});assert.equal(c.rows.length,0);assert.equal(c.ambiguousPlatformWorks,1);
 assert.equal(partitions[0].items.length,1);assert.equal(partitions[1].items.length,1);
});
test('source-enriched histories retain source provenance and explicit zero; public ledger titles obey tight text contract',async()=>{
 const c=buildPublicationCatalog({sourceWorks:[],accounts:[account(1,'tuantuan',['slice'])],partitions:[{kind:'works',targetId:1,
  items:[work(1,{source:'creator-source',lastObservedAt:null,caption:'<'.repeat(5)+'长'.repeat(500),plays:0})]}],asOf});
 assert.equal(c.rows[0].origin,'source');assert.deepEqual(c.rows[0].metrics.plays,{value:0,origin:'source'});
 assert.equal(c.rows[0].title.length,300);assert.equal(c.rows[0].title.includes('<'),false);await auditPublishing(edition(c));
});
test('scope aggregates are checked against all work rows; tampered scope IDs/groups and mixed protocols fail',async()=>{
 const c=buildPublicationCatalog({sourceWorks:[source(1),source(2,{registeredAuthorClassifications:['ai-remix']})],accounts:[],partitions:[],asOf});
 for(const type of ['aggregate','id','metadata']){
  const f=edition(c),index=f.parts[0].body;
  if(type==='aggregate')index.days[0].scopeGroups[0].metrics.all.likes.value=999;
  if(type==='id')f.parts[1].body.items[0].scopeId=500;
  if(type==='metadata')index.scopes[0].cookie='private';
  await assert.rejects(auditPublishing(f),/scope|index/);
 }
 const f=edition(c);assert.equal(publishingPartValid(f.parts[1].body,f.parts[1].meta,asOf),true);
 const row={...c.rows[0]};delete row.scopeId;assert.throws(()=>publishingPartitions([row],{withMetrics:true,scopes:c.scopes}),/scope-mode/);
});
test('registered links join the existing undated ledger with only board-supported scope and no invented metrics or identity',async()=>{
 const c=buildPublicationCatalog({sourceWorks:[],accounts:[account(1,'yuqilin',['slice'],['玉麒麟切片矩阵'])],partitions:[],asOf,withDates:true,
  referenceWorks:[{contentId:'99',author:'团团字样不能证明归属',board:'玉麒麟切片矩阵'}]});
 assert.equal(c.rows.length,1);const r=c.rows[0];assert.equal(r.date,'');assert.equal(r.dateBasis,'missing');assert.equal(r.targetId,null);
 assert.deepEqual(r.metrics,{likes:{value:null,origin:'unavailable'},plays:{value:null,origin:'unavailable'}});
 assert.deepEqual(c.scopes[r.scopeId],{theme:'yuqilin',boardKeys:['玉麒麟切片矩阵'],labels:[]});assert.deepEqual(r.classifications,[]);
});
test('work references do not duplicate facts, resurrect pre-start records, or choose an ambiguous native owner',()=>{
 const accounts=[account(1,'tuantuan',['slice']),account(2,'anlan',[])];
 const partitions=[{kind:'works',targetId:1,items:[work(1),work(3,{publishedAt:'2026-08-01T00:00:00.000Z'}),work(5)]},
  {kind:'works',targetId:2,items:[work(5)]}];
 const c=buildPublicationCatalog({sourceWorks:[source(2)],accounts,partitions,asOf,knownSourceWorkIds:['2','4'],
  referenceWorks:[1,2,3,4,5].map(id=>({contentId:String(id),author:'登记',board:'未分板块'}))});
 assert.deepEqual(c.rows.map(r=>r.contentId).sort(),['1','2']);assert.equal(c.rows.find(r=>r.contentId==='2').metrics.likes.value,10);
});
test('repeated reference IDs stay one work, and conflicting or absent board evidence stays unassigned',()=>{
 const c=buildPublicationCatalog({sourceWorks:[],accounts:[account(1,'tuantuan',[],['A']),account(2,'yuqilin',[],['B'])],partitions:[],asOf,
  referenceWorks:[{contentId:'99',author:'甲',board:'A'},{contentId:'99',author:'乙',board:'B'},
   {contentId:'100',author:'甲',board:'未分板块'}]});
 assert.equal(c.rows.length,2);const first=c.rows.find(r=>r.contentId==='99');assert.equal(first.author,'乙 / 甲');
 assert.equal(c.scopes[first.scopeId].theme,'unassigned');assert.deepEqual(c.scopes[first.scopeId].boardKeys,['A','B']);
 assert.deepEqual(c.scopes[c.rows.find(r=>r.contentId==='100').scopeId],{theme:'unassigned',boardKeys:[],labels:[]});
});
test('dated catalog preserves explicit, inferred and conflicting saved date authority and exact counts',async()=>{
 const bases=['source-explicit-date','source-inferred-date','source-date-conflict','unverified-date','creator-source-date-only','missing','platform-timestamp'];
 const partitions=[{kind:'works',targetId:1,items:bases.map((basis,index)=>work(index+1,{
  source:'creator-source',publishedAt:basis==='platform-timestamp'?'2026-10-28T17:00:00.000Z':null,
  publishedOn:['missing','platform-timestamp'].includes(basis)?null:'2026-10-29',publicationDateBasis:basis,
 }))}];
 const before=structuredClone(partitions),catalog=buildPublicationCatalog({sourceWorks:[],accounts:[account(1,'tuantuan',['slice'])],partitions,asOf,withDates:true});
 assert.deepEqual(catalog.rows.map(row=>row.dateBasis),bases.map(basis=>basis==='creator-source-date-only'?'unverified-date':basis));
 assert.deepEqual(catalog.rows.map(row=>row.date),bases.map(basis=>basis==='missing'?'':'2026-10-29'));
 assert.deepEqual(partitions,before,'date projection cannot change saved work/owner/metric evidence');
 assert.ok(catalog.rows.every(row=>row.targetId===1&&row.metrics.likes.value===5&&row.origin==='source'));
 const parts=publishingPartitions(catalog.rows,{withMetrics:true,scopes:catalog.scopes,withDates:true}).map(({path,kind,count,items,...rest})=>({
  meta:{path,kind,count:items?.length??count},body:{version:1,asOf,timeZone:'Asia/Shanghai',...rest,...(items?{items}:{count})}}));
 assert.deepEqual(parts[0].body.dateCounts.all,{confirmed:2,unverified:4,missing:1});
 await auditPublishing({manifest:{asOf,files:parts.map(part=>part.meta)},readPart:async path=>parts.find(part=>part.meta.path===path).body});
});
test('dated catalog rejects nonstandard timestamps and inconsistent date authority instead of inventing dates',()=>{
 const build=extra=>buildPublicationCatalog({sourceWorks:[],accounts:[account(1,'tuantuan',[])],
  partitions:[{kind:'works',targetId:1,items:[work(1,extra)]}],asOf,withDates:true});
 for(const extra of [
  {publishedAt:'2026-10-29'}, {publishedAt:'2026-10-29 01:00:00'},
  {publishedAt:'2026-02-30T00:00:00.000Z'}, {publishedAt:'2026-10-31T00:00:00.000Z'},
  {publishedAt:null,publishedOn:'2026-02-30',publicationDateBasis:'source-explicit-date'},
  {publishedAt:'2026-10-29T00:00:00.000Z',publishedOn:'2026-10-29',publicationDateBasis:'source-explicit-date'},
  {publishedAt:null,publishedOn:'2026-10-29',publicationDateBasis:'platform-timestamp'},
  {publishedAt:null,publishedOn:'2026-10-29',publicationDateBasis:'unknown'},
 ])assert.throws(()=>build(extra),/invalid-publication-work-date/);
 const timestamp=build({publishedAt:'2026-10-28T17:00:00.000Z'}).rows[0];
 assert.equal(timestamp.date,'2026-10-29');assert.equal(timestamp.dateBasis,'platform-timestamp');
 const legacy=build({publishedAt:null,publishedOn:'2026-10-29'}).rows[0];
 assert.equal(legacy.date,'2026-10-29');assert.equal(legacy.dateBasis,'unverified-date');
});
