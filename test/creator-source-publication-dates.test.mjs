import test from 'node:test';import assert from 'node:assert/strict';
import {submittedPublicationDay,projectSourcePublicationDates} from '../lib/creator-source-publication-dates.mjs';
const context={start:'2026-09-10',end:'2026-10-12',asOf:'2026-10-22T00:00:00.000Z'};
test('submitted day uses the source year and accepts explicit common source formats without manufacturing a time',()=>{
 for(const value of ['9月12','2026.9.12','9.12','20260912','2026-09-12',20260912,'20260912 15:07','2026 0912 23;19','2026.9.12.01.55','2026.9.12  09.08','2026-09-12-23.52','26年9月12日00:41','9月12号'])
  assert.equal(submittedPublicationDay(value,context),'2026-09-12',String(value));
 assert.equal(submittedPublicationDay(9.13,context),'2026-09-13');
 assert.equal(submittedPublicationDay('10月13日',context),'2026-10-13','one source calendar year is explicit even when outside its aggregate range');
 assert.equal(submittedPublicationDay('2026-09-12T20:00:00Z',context),'2026-09-13');
 assert.equal(submittedPublicationDay('2026-09-12T23:59:00+08:00',context),'2026-09-12');
});
test('rounded numeric month-day, ambiguous years, impossible clocks and future dates remain unknown',()=>{
 for(const value of [9.1,9.2,9.3,Infinity,NaN,null,true,46000,'226.9.23','2026.2.30','2026.9.12 24:00','2026.9.12 19:60','2026.9.12 19:30:60','2026-02-30T00:00:00Z','2026-09-12T24:00:00Z','2026.11.00:52','9.12/9.13','2026.10.23'])
  assert.equal(submittedPublicationDay(value,context),null,String(value));
 assert.equal(submittedPublicationDay('9.12',{...context,start:undefined}),null);
 assert.equal(submittedPublicationDay('9.12',{...context,start:'2025-01-01',end:'2026-12-31'}),null);
 assert.equal(submittedPublicationDay('2026.9.12',{asOf:context.asOf}),'2026-09-12');
 assert.equal(submittedPublicationDay('2024.2.29',{asOf:context.asOf}),'2024-02-29');
});
function fixture(){
 const work=(id,publishedOn)=>({contentId:id,publishedOn,dateSource:'source_inferred_publication_date',cumulativeLikes:0,cumulativePlays:8,targetId:1});
 const ids=['7300000000000000001','7300000000000000002','7300000000000000003'];
 const sheets=[{sheet_id:'10',headers_json:JSON.stringify(['视频ID','原填发布时间'])},{sheet_id:'15',headers_json:JSON.stringify(['视频ID','原填日期'])}];
 const row=(sheet_id,row_number,values)=>({sheet_id,row_number,values_json:JSON.stringify(values)});
 return {imported:{imported_at:context.asOf},sheets,overview:[row('01',2,['统计开始',context.start]),row('01',3,['统计结束',context.end])],
  sourceRows:[row('10',2,[ids[0],'9月12']),row('15',2,[ids[0],'2026.9.12']),row('10',3,[ids[1],'2026.9.14']),row('15',3,[ids[1],'2026.9.15']),row('10',4,[ids[2],9.1])],
  works:ids.map(id=>work(id,'2026-09-13'))};
}
test('exact work-ID joins adopt explicit dates, retain estimates and conflicting raw claims, and never alter counters or input',()=>{
 const input=fixture(),before=structuredClone(input),result=projectSourcePublicationDates(input);
 assert.deepEqual(result.summary,{matchedRows:4,adopted:1,changedDays:1,conflicting:1,invalidRows:1});
 assert.equal(result.works[0].publishedOn,'2026-09-12');assert.equal(result.works[0].sourceInferredPublishedOn,'2026-09-13');assert.equal(result.works[0].dateSource,'source-explicit-publication-date');
 assert.equal(result.works[1].publishedOn,'2026-09-13');assert.equal(result.works[1].dateSource,'source-publication-date-conflict');assert.equal(result.works[1].sourcePublicationDateEvidence.length,2);
 assert.equal(result.works[2],input.works[2]);assert.deepEqual(input,before);
 assert.ok(result.works.every(w=>w.cumulativeLikes===0&&w.cumulativePlays===8&&w.targetId===1));
 assert.ok(result.works[0].sourcePublicationDateEvidence.every(r=>/^[a-f0-9]{64}$/.test(r.rowSha256)&&r.contentId===input.works[0].contentId));
});
test('missing or duplicate field roles, unsafe numeric IDs and an unrelated publication timestamp grant no authority',()=>{
 for(const variant of ['missing-header','duplicate-role','different-id','numeric-id','submission-time']){
  const input=fixture();input.sourceRows=input.sourceRows.slice(0,1);
  if(variant==='missing-header')input.sheets=[];
  if(variant==='duplicate-role')input.sheets[0].headers_json=JSON.stringify(['视频ID','原填发布时间','原填发布时间']);
  if(variant==='different-id')input.sourceRows[0].values_json=JSON.stringify(['7300000000000000099','9月12']);
  if(variant==='numeric-id')input.sourceRows[0].values_json=JSON.stringify([7300000000000000001,'9月12']);
  if(variant==='submission-time')input.sheets[0].headers_json=JSON.stringify(['视频ID','提交时间']);
  assert.equal(projectSourcePublicationDates(input).summary.adopted,0,variant);
 }
});
