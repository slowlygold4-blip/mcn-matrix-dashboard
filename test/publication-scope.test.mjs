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
