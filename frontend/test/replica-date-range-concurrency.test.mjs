import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadSummaryRange} from '../lib/replica-date-range.mjs';

const asOf='2026-10-24T00:45:25.946Z';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const descriptor=(path,value,extra={})=>({path,...extra,bytes:Buffer.byteLength(JSON.stringify(value)),sha256:hash(value)});
const dateAt=i=>new Date(Date.parse('2026-09-12T00:00:00.000Z')+i*86400000).toISOString().slice(0,10);
const point=i=>{const date=dateAt(i),capturedAt=date+'T03:00:00.000Z';return {targetId:1,date,capturedAt,followers:100+i,followersAt:capturedAt,likes:200+i,likesAt:capturedAt,posts:i,postsAt:capturedAt};};

function fixture(count=12){
 const points=Array.from({length:count},(_,i)=>point(i));
 const daily={version:1,asOf,timeZone:'Asia/Shanghai',items:points};
 const base={asOf,timeZone:'Asia/Shanghai',counts:{daily:count},files:[descriptor('daily/1.json',daily,{kind:'daily',targetId:1,count})]};
 const parts=Object.fromEntries(points.map((row,i)=>[`date-summary/${String(i+1).padStart(6,'0')}.json`,{version:1,asOf,timeZone:'Asia/Shanghai',items:[row]}]));
 const shards=points.map((row,i)=>({...descriptor(`date-summary/${String(i+1).padStart(6,'0')}.json`,parts[`date-summary/${String(i+1).padStart(6,'0')}.json`],{count:1}),firstDate:row.date,lastDate:row.date}));
 const index={version:1,asOf,timeZone:'Asia/Shanghai',format:'date-shards-v1',sourceManifestSha256:hash(base),sourceDaily:base.files.map(({kind,...file})=>file),count,firstDate:points[0].date,lastDate:points.at(-1).date,shards};
 parts['date-summary-index.json']=index;
 const manifest={...base,files:[...base.files,descriptor('date-summary-index.json',index,{kind:'summaryDateIndex',count}),...shards.map(s=>({...Object.fromEntries(['path','count','bytes','sha256'].map(k=>[k,s[k]])),kind:'summaryDateShard'}))]};
 const request={ranges:[{start:points[0].date,end:points.at(-1).date}]};
 return {manifest,parts,request,points};
}

test('selected date shards read concurrently but return original manifest order and complete receipt',async()=>{
 const {manifest,parts,request,points}=fixture();let active=0,maxActive=0;const calls=[];
 const readPart=async path=>{if(path==='date-summary-index.json')return parts[path];calls.push(path);active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,13-(Number(path.slice(-11,-5))%5)));active--;return parts[path];};
 const result=await loadSummaryRange({manifest,readPart,request});
 assert.ok(maxActive>6,'more than six selected shards should overlap to avoid a third network wave');
 assert.ok(maxActive<=10,'concurrent reads must remain bounded');
 assert.deepEqual(result.points,points,'completion must preserve date and target order');
 assert.deepEqual(result.receipt.loadedParts,manifest.files.filter(f=>f.kind==='summaryDateShard').map(f=>f.path));
 assert.equal(result.receipt.complete,true);
 assert.equal(calls.length,points.length);
});

test('first shard read failure stops the queue without returning partial summary',async()=>{
 const {manifest,parts,request}=fixture();let started=0;
 const readPart=async path=>{
  if(path==='date-summary-index.json')return parts[path];
  started++;
  if(path==='date-summary/000003.json')throw Error('synthetic shard unavailable');
  await new Promise(resolve=>setTimeout(resolve,15));return parts[path];
 };
 await assert.rejects(loadSummaryRange({manifest,readPart,request}),/synthetic shard unavailable/);
 assert.ok(started<=10,'no later batch may start after the read fails');
});

test('overlapping shards with a repeated account/date remain invalid despite concurrent delivery',async()=>{
 const {manifest,parts}=fixture(2),second=parts['date-summary/000002.json'];
 second.items[0]={...second.items[0],date:dateAt(0),capturedAt:dateAt(0)+'T03:00:00.000Z',followersAt:dateAt(0)+'T03:00:00.000Z',likesAt:dateAt(0)+'T03:00:00.000Z',postsAt:dateAt(0)+'T03:00:00.000Z'};
 const old=manifest.files.find(f=>f.path==='date-summary/000002.json');
 const index=parts['date-summary-index.json'];
 index.shards[1].firstDate=dateAt(0);index.shards[1].lastDate=dateAt(0);
 index.lastDate=dateAt(0);
 old.bytes=Buffer.byteLength(JSON.stringify(second));old.sha256=hash(second);
 index.shards[1].bytes=old.bytes;index.shards[1].sha256=old.sha256;
 const root=manifest.files.find(f=>f.kind==='summaryDateIndex');root.bytes=Buffer.byteLength(JSON.stringify(index));root.sha256=hash(index);
 const reads=[];
 await assert.rejects(loadSummaryRange({manifest,readPart:async path=>{reads.push(path);return parts[path];},request:{dates:[dateAt(0)]}}),/日期历史与来源不一致/);
 assert.ok(reads.includes('date-summary/000001.json')&&reads.includes('date-summary/000002.json'),'the error must follow both shard reads and cross-shard validation');
});
