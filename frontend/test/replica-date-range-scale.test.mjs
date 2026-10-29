import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadSummaryRange} from '../lib/replica-date-range.mjs';
import {isCompactSummary} from '../lib/compact-summary-points.mjs';
import {growthSeries} from '../lib/replica-trends.mjs';
import {rowsFor} from '../lib/replica-model.mjs';

const asOf='2027-01-20T00:00:00.000Z';
const date=i=>new Date(Date.parse('2026-09-12T00:00:00Z')+i*86400000).toISOString().slice(0,10);
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const descriptor=(path,value,extra={})=>({path,...extra,bytes:Buffer.byteLength(JSON.stringify(value)),sha256:sha(value)});
function fixture(accounts=4081,days=90){
 const total=accounts*days,partAt=i=>({version:1,asOf,timeZone:'Asia/Shanghai',items:Array.from({length:Math.min(2000,total-i*2000)},(_,j)=>{
  const offset=i*2000+j,targetId=offset%accounts+1,d=Math.floor(offset/accounts),day=date(d),at=day+'T03:00:00.001Z';
  return {targetId,date:day,capturedAt:at,followers:10000+targetId-d,followersAt:at,likes:targetId*100+d,likesAt:at,posts:d,postsAt:at};
 })});
 const daily=Array.from({length:accounts},(_,i)=>({path:`daily/${i+1}.json`,kind:'daily',targetId:i+1,count:days,bytes:1000,sha256:'a'.repeat(64)}));
 const base={version:1,asOf,timeZone:'Asia/Shanghai',counts:{daily:total},files:daily};
 const shards=Array.from({length:Math.ceil(total/2000)},(_,i)=>{const p=partAt(i);return {...descriptor(`date-summary/${String(i+1).padStart(6,'0')}.json`,p,{count:p.items.length}),firstDate:p.items[0].date,lastDate:p.items.at(-1).date};});
 const index={version:1,asOf,timeZone:'Asia/Shanghai',format:'date-shards-v1',sourceManifestSha256:sha(base),sourceDaily:daily.map(({kind,...p})=>p),count:total,firstDate:date(0),lastDate:date(days-1),shards};
 const manifest={...base,files:[...daily,descriptor('date-summary-index.json',index,{kind:'summaryDateIndex',count:total}),...shards.map(({firstDate,lastDate,...p})=>({...p,kind:'summaryDateShard'}))]};
 return {manifest,index,partAt,shards,total};
}

test('4081 accounts across 90 observed days load all 367290 points with bounded storage and exact growth',async()=>{
 const {manifest,index,partAt,shards,total}=fixture();let active=0,maxActive=0,reads=0;
 const result=await loadSummaryRange({manifest,request:{ranges:[{start:date(0),end:date(89)}]},readPart:async path=>{
  if(path==='date-summary-index.json')return index;
  reads++;active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setImmediate(resolve));
  const i=Number(path.slice(-11,-5))-1,part=partAt(i);active--;return part;
 }});
 assert.ok(shards.reduce((n,s)=>n+s.bytes,0)>64_000_000,'fixture exceeds both old transfer and point limits');
 assert.ok(isCompactSummary(result.points));assert.equal(result.points.length,total);assert.equal(result.points.byteLength,total*64);
 assert.equal(result.receipt.complete,true);assert.equal(reads,shards.length);assert.ok(maxActive<=10);
 const accounts=Array.from({length:4081},(_,i)=>({id:i+1,enabled:true,label:'Author',platform:'抖音'}));
 const rows=rowsFor(accounts,result.points,date(0),date(89));assert.equal(rows.length,4081);assert.ok(rows.every(r=>r.metrics.followers.delta===-89&&r.metrics.likes.delta===89&&r.metrics.posts.delta===89));
 const curve=growthSeries(accounts,result.points,{start:date(0),end:date(89),metric:'followers',visibleOffset:0,visibleDays:90});
 assert.equal(curve.cohortCount,4081);assert.equal(curve.points[0].current,0);assert.equal(curve.points.at(-1).current,-89*4081);
});

test('range cancellation or corrupt late shard never returns a partial receipt',async()=>{
 const {manifest,index,partAt}=fixture(200,90),controller=new AbortController();let read=0;
 await assert.rejects(loadSummaryRange({manifest,signal:controller.signal,request:{ranges:[{start:date(0),end:date(89)}]},readPart:async path=>{
  if(path==='date-summary-index.json')return index;const part=partAt(Number(path.slice(-11,-5))-1);if(++read===3)controller.abort();return part;
 }}),e=>e.name==='AbortError');
 await assert.rejects(loadSummaryRange({manifest,request:{ranges:[{start:date(0),end:date(89)}]},readPart:async path=>{
  if(path==='date-summary-index.json')return index;const i=Number(path.slice(-11,-5))-1,part=partAt(i);if(i===8)part.items.at(-1).followers=-1;return part;
 }}),/日期历史与来源不一致/);
});
