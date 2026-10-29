import test from 'node:test';
import assert from 'node:assert/strict';
import {compactSummaryBuilder,isCompactSummary} from '../lib/compact-summary-points.mjs';
import {rowsFor,aggregate} from '../lib/replica-model.mjs';
import {growthSeries} from '../lib/replica-trends.mjs';
import {buildDailyCoverage,dailyCoverageMembers} from '../lib/daily-coverage-view.mjs';
import {buildDailyOverviewTrend,buildOverviewTrendPreview} from '../lib/overview-trend-preview.mjs';
import {availableComparison} from '../lib/available-comparison.mjs';
import {trendExport} from '../lib/replica-export.mjs';
import {periodWindow} from '../lib/replica-periods.mjs';

const asOf='2026-10-24T00:00:00.000Z';
const accounts=[1,2,3].map(id=>({id,enabled:true,label:'Author '+id,platform:'抖音'}));
const point=(id,date,values={})=>{const at=date+'T03:12:34.567Z';return {targetId:id,date,capturedAt:at,followers:100+id,followersAt:at,likes:200+id,likesAt:at,posts:10+id,postsAt:at,...values};};
function fixture(){
 const raw=[];
 for(const [i,date] of ['2026-10-20','2026-10-21','2026-10-22'].entries())for(const {id} of accounts){
  if(id===2&&i===1)continue;
  raw.push(point(id,date,{followers:id===3&&i===0?null:100-id*i,followersAt:id===3&&i===0?null:date+'T02:00:00.123Z',likes:id===1&&i===1?0:id===3?Number.MAX_SAFE_INTEGER:200+id*i,posts:i}));
 }
 const builder=compactSummaryBuilder(raw.length,asOf);raw.forEach(p=>builder.append(p));return {raw,compact:builder.finish()};
}

test('compact storage round-trips exact times, max safe counters, real zero and null; sealed data is immutable',()=>{
 const {raw,compact}=fixture();assert.ok(isCompactSummary(compact,asOf));assert.equal(isCompactSummary(compact,'2026-10-25T00:00:00.000Z'),false);
 assert.equal(compact.byteLength,raw.length*64);assert.deepEqual([...compact],raw);
 for(const p of raw)assert.deepEqual(compact.get(p.targetId,p.date),p);
 assert.equal(compact.get(2,'2026-10-21'),undefined);assert.equal(compact.get(99,'2026-10-20'),undefined);
 const row=compact.get(1,'2026-10-20');row.likes=999;assert.notEqual(compact.get(1,row.date).likes,999);
 assert.throws(()=>{compact.length=1;});assert.equal(isCompactSummary({...compact}),false);
});

test('compact admission rejects duplicates, disorder, over-budget allocation, invalid timestamps and writes after seal',()=>{
 const p=point(1,'2026-10-20');const builder=compactSummaryBuilder(2,asOf);builder.append(p);
 assert.throws(()=>builder.append(p));builder.finish();assert.throws(()=>builder.append(point(2,p.date)));assert.throws(()=>builder.finish());
 assert.throws(()=>compactSummaryBuilder(1_000_001,asOf));
 for(const bad of [{...p,followersAt:'2026-10-19T03:00:00.000Z'},{...p,likes:Infinity},{...p,targetId:100_000_000},{...p,posts:-1}])assert.throws(()=>compactSummaryBuilder(1,asOf).append(bad));
 const order=compactSummaryBuilder(2,asOf);order.append(point(2,p.date));assert.throws(()=>order.append(p));
});

test('all user-facing metric computations and source-aware CSV match array input exactly',()=>{
 const {raw,compact}=fixture(),start='2026-10-20',end='2026-10-22';
 assert.deepEqual(rowsFor(accounts,compact,start,end),rowsFor(accounts,raw,start,end));
 assert.deepEqual(aggregate(rowsFor(accounts,compact,start,end)),aggregate(rowsFor(accounts,raw,start,end)));
 assert.deepEqual(availableComparison(accounts,compact,start,end),availableComparison(accounts,raw,start,end));
 for(const metric of ['followers','likes','posts','estimated']){
  const options={start,end,metric,otherStart:start,otherEnd:'2026-10-21',visibleOffset:0,visibleDays:90};
  assert.deepEqual(growthSeries(accounts,compact,options),growthSeries(accounts,raw,options));
  const manifest={version:1,asOf,timeZone:'Asia/Shanghai',files:accounts.map(a=>({path:`daily/${a.id}.json`,kind:'daily',targetId:a.id,count:raw.filter(p=>p.targetId===a.id).length,sha256:'a'.repeat(64)}))};
  assert.deepEqual(trendExport({accounts,points:compact,manifest,options}),trendExport({accounts,points:raw,manifest,options}));
  assert.throws(()=>trendExport({accounts,points:compact,manifest:{...manifest,asOf:'2026-10-25T00:00:00.000Z'},options}));
 }
 for(const metric of ['followers','likes','posts']){
  assert.deepEqual(buildDailyOverviewTrend(accounts,compact,{start,end,metric}),buildDailyOverviewTrend(accounts,raw,{start,end,metric}));
  assert.deepEqual(buildOverviewTrendPreview(accounts,compact,{start,end,metric}),buildOverviewTrendPreview(accounts,raw,{start,end,metric}));
  for(const date of [start,'2026-10-21',end])for(const reason of ['comparable','missingCurrent','missingBaseline'])assert.deepEqual(dailyCoverageMembers(accounts,compact,{date,metric,reason}),dailyCoverageMembers(accounts,raw,{date,metric,reason}));
 }
 assert.deepEqual(buildDailyCoverage(accounts,compact,{start,end}),buildDailyCoverage(accounts,raw,{start,end}));
 for(const period of ['since','day','week','month','observed'])assert.deepEqual(periodWindow(period,accounts,compact,asOf),periodWindow(period,accounts,raw,asOf));
});
