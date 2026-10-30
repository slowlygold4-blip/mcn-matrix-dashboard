import test from 'node:test';
import assert from 'node:assert/strict';
import {adoptWorkMetric,indexWorkObservations,observationsForWork,summarizeAdoptedWorks} from '../lib/work-metric-adoption.mjs';
const asOf='2026-10-29T08:00:00.000Z';
test('owner-scoped indexed evidence cannot borrow same-work observations from another author',()=>{
 const rows=[{contentId:'123',douyinId:'Owner',likes:1,observedAt:'2026-10-28T08:00:00Z'},{contentId:'123',douyinId:'other',likes:99,observedAt:'2026-10-28T08:00:00Z'}];
 assert.deepEqual(observationsForWork(indexWorkObservations(rows,asOf),'123',['owner']).map(row=>row.likes),[1]);
 assert.throws(()=>indexWorkObservations(rows,null),/截止/);
});
test('same-time platform/source disagreement stays conflict instead of selecting a larger or older counter',()=>{
 const result=adoptWorkMetric({metric:'likes',sourceValue:9,platformValue:10,platformObservedAt:asOf,
  observations:[{likes:11,observedAt:asOf,sourceRow:2,timeBasis:'metric-observation'}],asOf});
 assert.equal(result.value,null);assert.equal(result.origin,'conflict');assert.equal(result.conflict,true);
});
test('a conflicting platform instant cannot fall back to an older source or silently agree with one of its values',()=>{
 const input={metric:'likes',sourceValue:99,platformValue:null,platformObservedAt:asOf,platformConflict:true,asOf};
 for(const observations of [[],[{likes:10,observedAt:asOf,sourceRow:2,timeBasis:'metric-observation'}]]){
  const result=adoptWorkMetric({...input,observations});
  assert.equal(result.value,null);assert.equal(result.origin,'conflict');assert.equal(result.conflict,true);
  assert.equal(result.observedAt,asOf);assert.equal(result.platformUsable,false);
 }
 const newer='2026-10-29T09:00:00.000Z';
 const resolved=adoptWorkMetric({...input,asOf:newer,observations:[{likes:0,observedAt:newer,timeBasis:'metric-observation'}]});
 assert.equal(resolved.value,0);assert.equal(resolved.origin,'source-observation');assert.equal(resolved.conflict,false);
 const historical=adoptWorkMetric({...input,asOf:'2026-10-28T08:00:00.000Z'});
 assert.equal(historical.value,99);assert.equal(historical.origin,'source');
});
test('totals use known adopted values once, keep unknown absent and refuse precision loss',()=>{
 const rows=[{externalId:'one',adoptedLikes:0,adoptedPlays:null},{externalId:'two',adoptedLikes:3,adoptedPlays:20},{externalId:'three',adoptedLikes:null,adoptedPlays:null,likesOrigin:'conflict'}];
 const total=summarizeAdoptedWorks(rows);assert.equal(total.works,3);assert.deepEqual(total.likes,{value:3,known:2,missing:1,conflicts:1,overflow:false});
 assert.equal(total.plays.value,20);assert.equal(total.plays.known,1);assert.equal(summarizeAdoptedWorks([]).likes.value,null);
 assert.throws(()=>summarizeAdoptedWorks([rows[0],rows[0]]),/重复/);
 const overflow=summarizeAdoptedWorks([{externalId:'one',adoptedLikes:Number.MAX_SAFE_INTEGER},{externalId:'two',adoptedLikes:1}]);
 assert.equal(overflow.likes.value,null);assert.equal(overflow.likes.overflow,true);
});
