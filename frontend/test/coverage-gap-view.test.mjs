import test from 'node:test';
import assert from 'node:assert/strict';
import {coverageGapView} from '../lib/coverage-gap-view.mjs';
const row=(id,changes={})=>({id,label:'账号'+id,profileFresh:true,worksComplete:false,
 worksUnavailableRecent:true,worksFresh:false,works:{status:'unavailable',observedAt:null,attemptedAt:'2026-10-29T16:00:00.000Z'},...changes});

test('every one of 4081 missing accounts is reachable once across all pages, not only the first 20',()=>{
 const rows=Array.from({length:4081},(_,i)=>row(i+1)),before=structuredClone(rows),first=coverageGapView(rows);
 assert.deepEqual([first.totalGaps,first.filteredCount,first.pageCount,first.from,first.to],[4081,4081,205,1,20]);
 const reached=[];
 for(let page=1;page<=first.pageCount;page++)reached.push(...coverageGapView(rows,{page}).rows.map(r=>r.id));
 assert.equal(reached.length,4081);assert.equal(new Set(reached).size,4081);
 assert.deepEqual(reached,rows.map(r=>r.id));assert.deepEqual(rows,before);
 const last=coverageGapView(rows,{page:205});assert.deepEqual([last.from,last.to,last.rows[0].id],[4081,4081,4081]);
});

test('profile and work gaps filter independently; complete work with old profile stays visible',()=>{
 const rows=[row(1,{worksComplete:true,worksUnavailableRecent:false,profileFresh:false,works:{status:'complete',observedAt:'2026-10-30T01:00:00.000Z'}}),
  row(2,{worksUnavailableRecent:false,works:{status:'limited',observedAt:'2026-10-30T00:00:00.000Z'}}),row(3),
  row(4,{worksComplete:true,worksUnavailableRecent:false})];
 assert.equal(coverageGapView(rows).totalGaps,3);
 assert.deepEqual(coverageGapView(rows,{filter:'profile'}).rows.map(r=>r.id),[1]);
 assert.deepEqual(coverageGapView(rows,{filter:'works'}).rows.map(r=>r.id),[3,2]);
 assert.deepEqual(coverageGapView(rows,{filter:'unavailable'}).rows.map(r=>r.id),[3]);
 assert.deepEqual(coverageGapView(rows,{filter:'limited'}).rows.map(r=>r.id),[2]);
 assert.deepEqual(coverageGapView(rows,{filter:'unobserved'}).rows.map(r=>r.id),[3]);
});

test('search covers later pages and normalized names or ID, preserving the applied issue filter',()=>{
 const rows=Array.from({length:80},(_,i)=>row(i+1));rows[79].label='ＡＬＰＨＡ 作者';
 const result=coverageGapView(rows,{query:' alpha ',page:4});
 assert.equal(result.filteredCount,1);assert.equal(result.page,1);assert.equal(result.rows[0].id,80);
 assert.equal(coverageGapView(rows,{query:'80'}).rows[0].id,80);
 assert.equal(coverageGapView(rows,{query:'alpha',filter:'profile'}).filteredCount,0);
});

test('empty matching result does not erase global gap count or report missing accounts as complete',()=>{
 const result=coverageGapView([row(1)],{query:'not-found'});
 assert.deepEqual([result.totalGaps,result.filteredCount,result.from,result.to,result.page,result.pageCount],[1,0,0,0,1,1]);
 assert.deepEqual(result.rows,[]);
 const empty=coverageGapView([]);assert.equal(empty.totalGaps,0);assert.equal(empty.page,1);
});

test('priority stays actionable; same-priority attempt timestamps compare as instants, with stable ID ties',()=>{
 const rows=[row(9,{worksUnavailableRecent:false,works:{status:'limited',observedAt:'2026-10-29T16:00:00.000Z'}}),
  row(8,{worksUnavailableRecent:false}),row(6,{works:{status:'unavailable',observedAt:null,attemptedAt:'2026-10-30T00:00:00Z'}}),
  row(4,{works:{status:'unavailable',observedAt:null,attemptedAt:'2026-10-30T00:00:00.500Z'}}),row(2)];
 assert.deepEqual(coverageGapView(rows).rows.map(r=>r.id),[4,6,2,8,9]);
 assert.deepEqual(coverageGapView([row(5),row(1)]).rows.map(r=>r.id),[1,5]);
});

test('clamps obsolete pages after a refreshed scope shrinks; invalid or zero page never loses rows',()=>{
 for(const page of [0,-1,NaN,'2',1.5,100]){
  const result=coverageGapView([row(1)],{page});assert.equal(result.page,1);assert.equal(result.rows[0].id,1);
 }
 const rows=Array.from({length:21},(_,i)=>row(i+1));
 assert.equal(coverageGapView(rows,{page:999}).rows[0].id,21);
 for(const pageSize of [0,51,1.2,'20'])assert.throws(()=>coverageGapView(rows,{pageSize}));
 assert.throws(()=>coverageGapView(rows,{filter:'unexpected'}));
});
