import test from'node:test';import assert from'node:assert/strict';
import{publishingPartitions}from'../lib/replica-publishing.mjs';
import{scopedPublishingIndex,filterPublicationScopeRows,publishingSelection,filterPublishingRows,publishingCalendar}from'../lib/publishing-view.mjs';
const scopes=[
 {theme:'tuantuan',boardKeys:['团团矩阵','共同矩阵'],labels:['slice']},
 {theme:'tuantuan',boardKeys:['团团矩阵'],labels:['slice','original']},
 {theme:'anlan',boardKeys:['安澜矩阵','共同矩阵'],labels:['original']},
 {theme:'douyin-streamers',boardKeys:['抖音主播板块'],labels:[]},
];
const row=(id,scopeId,classes=['slice'],date='2026-10-29')=>({contentId:String(id),scopeId,platform:'douyin',date,author:'作者',title:'作品',targetId:id,classifications:classes,origin:'platform',
 metrics:{likes:{value:id,origin:'platform'},plays:{value:null,origin:'unavailable'}}});
const rows=[row(1,0,['original']),row(2,1,['slice','ai-remix']),row(3,2),row(4,3),row(5,0,[],'')];
const index=publishingPartitions(rows,{withMetrics:true,scopes})[0],asOf='2026-10-30T00:00:00.000Z';
test('parent matrix/theme/account label filter controls counts, card metrics, calendar and detail rows together',()=>{
 const cases=[
  [{},[1,2,3,5]], [{theme:'tuantuan'},[1,2,5]], [{theme:'anlan'},[3]],
  [{tag:'original'},[2,3]], [{theme:'tuantuan',tag:'original'},[2]],
  [{board:'共同矩阵'},[1,3,5]], [{board:'团团矩阵'},[1,2,5]],
  [{theme:'douyin-streamers'},[4]], [{board:'抖音主播板块'},[4]],
  [{theme:'anlan',tag:'slice'},[]],
 ];
 for(const [scope,expected]of cases){
  const filtered=filterPublicationScopeRows(rows,index,scope),scoped=scopedPublishingIndex(index,scope),selection=publishingSelection(scoped);
  assert.deepEqual(filtered.map(r=>Number(r.contentId)),expected);
  assert.equal(selection.works,expected.length);
  assert.equal(selection.metrics.likes.value,expected.length?expected.reduce((a,b)=>a+b,0):null);
  assert.equal(selection.metrics.plays.value,null);assert.equal(selection.metrics.plays.missing,expected.length);
  const dated=expected.filter(id=>id!==5);assert.equal(publishingSelection(scoped,{startDate:'2026-10-29',endDate:'2026-10-29'}).works,dated.length);
  const calendar=publishingCalendar(scoped,asOf,'2026-10-29','2026-10-29');assert.equal(calendar[0].works,dated.length||null);
 }
});
test('account original classification and work original tag are independent filters; overlaps never duplicate work counts',()=>{
 const accountScope={theme:'tuantuan',tag:'original'},scoped=scopedPublishingIndex(index,accountScope);
 assert.equal(publishingSelection(scoped,{track:'slice'}).works,1);
 assert.equal(publishingSelection(scoped,{track:'original'}).works,0);
 assert.equal(filterPublishingRows(filterPublicationScopeRows(rows,index,accountScope),'slice').length,1);
 assert.equal(publishingSelection(scoped,{track:'ai-remix'}).metrics.likes.value,2);
 assert.equal(publishingSelection(scoped).metrics.likes.value,2);
});
test('loading and unsupported legacy scopes never render a different theme as the chosen theme',()=>{
 assert.equal(scopedPublishingIndex(null,{theme:'anlan'}),null);assert.deepEqual(filterPublicationScopeRows([],null,{theme:'anlan'}),[]);
 const legacy=publishingPartitions(rows.map(({platform,scopeId,...r})=>r),{withMetrics:true})[0];
 assert.equal(scopedPublishingIndex(legacy,{theme:'tuantuan'}),legacy);
 assert.throws(()=>scopedPublishingIndex(legacy,{theme:'anlan'}),/尚未提供/);
 assert.throws(()=>scopedPublishingIndex(legacy,{theme:'tuantuan',tag:'slice'}),/尚未提供/);
});
