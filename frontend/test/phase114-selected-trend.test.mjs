import test from 'node:test';import assert from 'node:assert/strict';
import {trendPoint,trendMove,trendSelectionScope,trendEndpoint} from '../lib/replica-trend-presentation.mjs';
const points=[
 {day:90,currentDate:'2026-09-12',current:0,currentKnown:2,comparisonDate:'2026-09-20',comparison:0,comparisonKnown:2},
 {day:91,currentDate:'2026-09-13',current:-20,currentKnown:2,comparisonDate:'2026-09-21',comparison:3,comparisonKnown:2},
 {day:92,currentDate:'2026-09-14',current:null,currentKnown:1,comparisonDate:null,comparison:null,comparisonKnown:0},
];
test('selected relative day retains separate actual dates, zero and negatives',()=>{
 assert.deepEqual(trendPoint(points,90),{day:90,index:0,current:{date:'2026-09-12',value:0,known:2,state:'known'},comparison:{date:'2026-09-20',value:0,known:2,state:'known'}});
 assert.equal(trendPoint(points,91).current.value,-20);assert.equal(trendPoint(points,91).comparison.value,3);
});
test('selected missing day and short comparison do not borrow neighbors',()=>{
 const p=trendPoint(points,92);assert.equal(p.current.state,'missing');assert.equal(p.current.value,null);assert.equal(p.current.known,1);assert.equal(p.comparison.state,'outside');assert.equal(p.comparison.value,null);assert.equal(p.comparison.known,null);
 assert.equal(trendPoint(points,99),null);assert.equal(trendPoint([],0),null);assert.equal(trendPoint(null),null);
});
test('default selection is true final row, even missing, without replacing existing A/B endpoints',()=>{
 assert.equal(trendPoint(points).day,92);assert.equal(trendPoint(points).current.value,null);
 assert.deepEqual(trendEndpoint(points,'comparison'),{date:'2026-09-21',value:3,known:2});
});
test('keyboard selection is bounded to this screen, using exact day offsets',()=>{
 assert.equal(trendMove(points,90,'ArrowLeft'),90);assert.equal(trendMove(points,90,'ArrowRight'),91);assert.equal(trendMove(points,92,'ArrowRight'),92);assert.equal(trendMove(points,92,'Home'),90);assert.equal(trendMove(points,90,'End'),92);assert.equal(trendMove(points,null,'ArrowLeft'),91);assert.equal(trendMove(points,99,'End'),null);assert.equal(trendMove(points,91,'Tab'),null);
});
test('same refreshed scope stable; metric/account/page/applied range/scope reset keys',()=>{
 const base={accountIds:[2,1],scope:'tuantuan/slice/overview',start:'2026-09-12',end:'2026-09-14',metric:'followers',compare:true,otherStart:'2026-09-20',otherEnd:'2026-09-21',offset:0};
 const key=trendSelectionScope(base);assert.equal(key,trendSelectionScope({...base,accountIds:[1,2]}));
 for(const change of [{metric:'likes'},{accountIds:[1]},{offset:90},{start:'2026-09-13'},{scope:'tuantuan/ai/overview'},{compare:false},{otherEnd:'2026-09-22'}])assert.notEqual(key,trendSelectionScope({...base,...change}));
});
test('reading helpers never mutate source cumulative curve or convert missing to zero',()=>{
 const before=JSON.stringify(points);trendPoint(points,92);trendMove(points,91,'ArrowRight');trendSelectionScope({accountIds:[2,1],start:'x',end:'y',metric:'followers'});assert.equal(JSON.stringify(points),before);
});
