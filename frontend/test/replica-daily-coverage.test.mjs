import test from 'node:test';
import assert from 'node:assert/strict';
import {dailyCoverageWindow,dailyCoverageRequest} from '../lib/replica-daily-request.mjs';
import {buildDailyCoverage,dailyCoverageMembers} from '../lib/daily-coverage-view.mjs';
const account={id:1,label:'测试账号',platform:'douyin',enabled:true};
const point=(date,value)=>({targetId:1,date,capturedAt:date+'T04:00:00.000Z',followers:value,followersAt:date+'T04:00:00.000Z',likes:value,likesAt:date+'T04:00:00.000Z',posts:value,postsAt:date+'T04:00:00.000Z'});
test('first current day demands its preceding day without changing interval endpoints',()=>{
 const r=dailyCoverageRequest({start:'2026-09-20',end:'2026-10-01'});
 assert.deepEqual(r.dates,['2026-09-19','2026-09-20','2026-10-01']);
 assert.deepEqual(r.ranges,[{start:'2026-09-20',end:'2026-10-01'}]);
});
test('comparison keeps four endpoints and adds only current daily baseline',()=>{
 const r=dailyCoverageRequest({start:'2026-09-20',end:'2026-10-01',otherStart:'2026-09-01',otherEnd:'2026-09-15'});
 assert.deepEqual(r.dates,['2026-09-01','2026-09-15','2026-09-19','2026-09-20','2026-10-01']);
});
test('coverage window remains bounded90 while chosen multiyear range is not redefined',()=>{
 assert.deepEqual(dailyCoverageWindow({start:'2026-01-01',end:'2028-12-31'}),{start:'2026-01-01',end:'2026-03-31'});
 const r=dailyCoverageRequest({start:'2026-01-01',end:'2028-12-31',offset:90});
 assert.ok(r.dates.includes('2026-03-31'));assert.ok(r.dates.includes('2028-12-31'));
 assert.deepEqual(r.ranges,[{start:'2026-04-01',end:'2026-06-29'}]);
});
test('comparison-only trailing window does not invent current coverage days',()=>{
 assert.equal(dailyCoverageWindow({start:'2026-09-20',end:'2026-09-21',offset:90}),null);
 const r=dailyCoverageRequest({start:'2026-09-20',end:'2026-09-21',offset:90,otherStart:'2026-01-01',otherEnd:'2026-10-01'});
 assert.deepEqual(r.dates,['2026-01-01','2026-09-20','2026-09-21','2026-10-01']);
});
test('daily counts retain real zero and negative and exact adjacent baseline',()=>{
 const p=[point('2026-09-17',100),point('2026-09-20',10),point('2026-09-21',10),point('2026-09-22',8)];
 const days=buildDailyCoverage([account],p,{start:'2026-09-18',end:'2026-09-22'});
 assert.equal(days[0].metrics.followers.missingCurrent,1);assert.equal(days[2].metrics.followers.missingBaseline,1);
 assert.equal(days[3].metrics.followers.comparable,1);
 assert.equal(dailyCoverageMembers([account],p,{date:'2026-09-21',metric:'followers',reason:'comparable'})[0].delta,0);
 assert.equal(dailyCoverageMembers([account],p,{date:'2026-09-22',metric:'followers',reason:'comparable'})[0].delta,-2);
});
test('date windows reject malformed bounds and unbounded offsets',()=>{
 for(const o of [{start:'2026-02-30',end:'2026-03-01'},{start:'2026-09-21',end:'2026-09-20'},{start:'2026-09-20',end:'2026-09-21',offset:-1},{start:'2026-09-20',end:'2026-09-21',offset:Infinity}])assert.throws(()=>dailyCoverageRequest(o));
});
