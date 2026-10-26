import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDailyOverviewTrend} from '../lib/overview-trend-preview.mjs';
const accounts=[{id:1},{id:2}];
const p=(id,date,f,likes=f,posts=f)=>({targetId:id,date,capturedAt:date+'T03:00:00.000Z',followers:f,likes,posts});
const options={start:'2026-09-12',end:'2026-10-26'};
test('missing 9/12 baseline does not hide subsequent consecutive daily growth',()=>{
 const r=buildDailyOverviewTrend(accounts,[p(1,'2026-10-23',100),p(1,'2026-10-24',110),p(1,'2026-10-26',115)],options);
 assert.equal(r.state,'ready');assert.equal(r.samples.find(x=>x.date==='2026-10-24').value,10);
 assert.equal(r.samples.find(x=>x.date==='2026-10-25').value,null);
 assert.equal(r.samples.find(x=>x.date==='2026-10-26').value,null,'never label a two-day change as one-day growth');
});
test('per-day cohorts preserve true zero/negative and metric-specific missing fields',()=>{
 const points=[p(1,'2026-10-25',100,100,3),p(2,'2026-10-25',50,null,2),p(1,'2026-10-26',95,120,4),p(2,'2026-10-26',55,30,2)];
 const a=buildDailyOverviewTrend(accounts,points,options).samples.at(-1);assert.deepEqual([a.value,a.known],[0,2]);
 const b=buildDailyOverviewTrend(accounts,points,{...options,metric:'likes'}).samples.at(-1);assert.deepEqual([b.value,b.known],[20,1]);
 assert.equal(buildDailyOverviewTrend([accounts[0]],points,options).samples.at(-1).value,-5);
});
test('bad or duplicate source observations cannot silently produce daily values',()=>{
 const row=p(1,'2026-10-25',100);
 assert.equal(buildDailyOverviewTrend(accounts,[row,row],options).state,'error');
 assert.equal(buildDailyOverviewTrend(accounts,[{...row,followers:-1}],options).state,'error');
 assert.equal(buildDailyOverviewTrend(accounts,[],{...options,ready:false}).state,'loading');
});
