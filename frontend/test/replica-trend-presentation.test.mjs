import test from 'node:test';import assert from 'node:assert/strict';
import {trendEndpoint,trendTick} from '../lib/replica-trend-presentation.mjs';
test('visible endpoint keeps a missing final day instead of backfilling last known',()=>{
 const rows=[{day:0,currentDate:'2026-09-12',current:0,currentKnown:2},{day:1,currentDate:'2026-09-13',current:42,currentKnown:2},{day:2,currentDate:'2026-09-14',current:null,currentKnown:1}];
 assert.deepEqual(trendEndpoint(rows),{date:'2026-09-14',value:null,known:1});
 assert.equal(trendTick(rows,1,false),'9/13');assert.equal(trendTick(rows,1,true),'第1天');
});
test('unequal compared intervals retain separate real endpoints including zero and negative',()=>{
 const rows=[{day:90,currentDate:'2026-09-30',current:-8,currentKnown:1,comparisonDate:'2026-09-20',comparison:0,comparisonKnown:1},{day:91,currentDate:null,current:null,comparisonDate:'2026-09-21',comparison:null,comparisonKnown:0}];
 assert.deepEqual(trendEndpoint(rows),{date:'2026-09-30',value:-8,known:1});
 assert.deepEqual(trendEndpoint(rows,'comparison'),{date:'2026-09-21',value:null,known:0});assert.equal(trendTick(rows,90,false),'9/30');
 assert.equal(trendEndpoint([]),null);assert.equal(trendTick(rows,92,false),'');assert.equal(JSON.stringify(rows).includes('"current":-8'),true);
});
