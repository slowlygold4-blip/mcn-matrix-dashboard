import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {auditDatePublication} from '../lib/replica-date-audit.mjs';

const asOf='2026-10-23T10:00:00.000Z';
const digest=text=>createHash('sha256').update(text).digest('hex');
const seal=(path,value,extra={})=>{
 const text=JSON.stringify(value);
 return {meta:{path,...extra,bytes:Buffer.byteLength(text),sha256:digest(text)},text};
};
const point=id=>({targetId:id,date:'2026-10-23',capturedAt:'2026-10-23T03:00:00.000Z',followers:id,followersAt:'2026-10-23T03:00:00.000Z',likes:id*2,likesAt:'2026-10-23T03:00:00.000Z',posts:1,postsAt:'2026-10-23T03:00:00.000Z'});

function fixture(size,{mismatch=false,padding=0}={}){
 const texts=new Map(),daily=[],points=Array.from({length:size},(_,i)=>point(i+1));
 for(const p of points){const file=seal(`daily/${p.targetId}.json`,{version:1,asOf,timeZone:'Asia/Shanghai',items:[p],...(padding?{padding:'x'.repeat(padding)}:{})},{kind:'daily',targetId:p.targetId,count:1});daily.push(file.meta);texts.set(file.meta.path,file.text);}
 const base={asOf,timeZone:'Asia/Shanghai',counts:{daily:size},files:daily};
 const datePoints=points.map(p=>({...p}));
 if(mismatch)datePoints[0].followers++;
 const shards=[];
 for(let i=0;i<datePoints.length;i+=2000){
  const rows=datePoints.slice(i,i+2000),path=`date-summary/${String(shards.length+1).padStart(6,'0')}.json`;
  const file=seal(path,{version:1,asOf,timeZone:'Asia/Shanghai',items:rows},{count:rows.length});
  shards.push(file.meta);texts.set(path,file.text);
 }
 const sourceDaily=daily.map(file=>({path:file.path,targetId:file.targetId,count:file.count,bytes:file.bytes,sha256:file.sha256}));
 const index={version:1,asOf,timeZone:'Asia/Shanghai',format:'date-shards-v1',sourceManifestSha256:digest(JSON.stringify(base)),sourceDaily,count:size,firstDate:shards.length?'2026-10-23':null,lastDate:shards.length?'2026-10-23':null,shards:shards.map(meta=>({...meta,firstDate:'2026-10-23',lastDate:'2026-10-23'}))};
 const root=seal('date-summary-index.json',index,{kind:'summaryDateIndex',count:size});texts.set(root.meta.path,root.text);
 return {manifest:{...base,files:[...daily,root.meta,...shards.map(meta=>({...meta,kind:'summaryDateShard'}))]},texts};
}

test('fully audits 3001 daily partitions with bounded overlap and no skipped source',async()=>{
 const {manifest,texts}=fixture(3001),seen=new Map();let active=0,maximum=0;
 const result=await auditDatePublication({manifest,readText:async path=>{
  seen.set(path,(seen.get(path)||0)+1);
  if(path.startsWith('daily/')){active++;maximum=Math.max(maximum,active);await new Promise(resolve=>setImmediate(resolve));active--;}
  return texts.get(path);
 }});
 assert.deepEqual(result,{fullySourceBound:true,count:3001,shards:2});
 assert.equal(seen.size,3004);assert.ok([...seen.values()].every(count=>count===1));
 assert.ok(maximum>=5,'small daily sources need enough bounded overlap for the hosted activation window');
 assert.ok(maximum<=6,'no more than six daily sources may be in flight');
 assert.equal(active,0);
});

test('rejects a missing or tampered daily source, including an in-flight failure',async()=>{
 for(const failure of ['missing','tampered','throw','throw-undefined']){
  const {manifest,texts}=fixture(19);let active=0,maximum=0,reads=0;
  await assert.rejects(auditDatePublication({manifest,readText:async path=>{
   if(!path.startsWith('daily/'))return texts.get(path);
   reads++;
   active++;maximum=Math.max(maximum,active);
   await new Promise(resolve=>setImmediate(resolve));active--;
   if(path==='daily/2.json'){
    if(failure==='missing')return undefined;
    if(failure==='tampered')return texts.get(path).replace('"followers":2','"followers":9');
    if(failure==='throw-undefined')throw undefined;
    throw Error('R2 read failed');
   }
   return texts.get(path);
  }}));
  assert.equal(active,0,'in-flight reads must settle before audit rejects');
  assert.ok(maximum<=6);
  assert.ok(reads<19,'a failed partition must stop dispatching the rest of the manifest');
 }
});

test('large source bodies reduce the in-flight read budget instead of multiplying memory',async()=>{
 const {manifest,texts}=fixture(6,{padding:3_999_000});let active=0,maximum=0;
 await auditDatePublication({manifest,readText:async path=>{
  if(path.startsWith('daily/')){active++;maximum=Math.max(maximum,active);await new Promise(resolve=>setImmediate(resolve));active--;}
  return texts.get(path);
 }});
 assert.equal(maximum,2);
 assert.equal(active,0);
});

test('rejects a sealed date shard whose value differs from the sealed daily source',async()=>{
 const {manifest,texts}=fixture(35,{mismatch:true});
 await assert.rejects(auditDatePublication({manifest,readText:path=>texts.get(path)}),/date-source-audit-failed/);
});

test('abort stops dispatch and never reports a complete publication',async()=>{
 const {manifest,texts}=fixture(30),controller=new AbortController();let dailyReads=0;
 await assert.rejects(auditDatePublication({manifest,signal:controller.signal,readText:async path=>{
  if(path.startsWith('daily/')){dailyReads++;if(dailyReads===2)controller.abort(Error('client disconnected'));await new Promise(resolve=>setImmediate(resolve));}
  return texts.get(path);
 }}),/client disconnected/);
 assert.ok(dailyReads<=6,'aborted requests must not keep dispatching the rest of the manifest');
});

test('progress exposes only fixed phases and verified counts, never unfinished or private source data',async()=>{
 const {manifest,texts}=fixture(70),events=[];
 await auditDatePublication({manifest,readText:path=>texts.get(path),onProgress:e=>events.push(e)});
 assert.deepEqual(events.map(e=>e.phase),['index','shards','daily','daily','daily','done']);
 assert.deepEqual(events.at(-1),{phase:'done',verifiedDaily:70,expectedDaily:70});
 assert.ok(events.every(e=>Object.keys(e).sort().join(',')==='expectedDaily,phase,verifiedDaily'));
 const failed=[];await assert.rejects(auditDatePublication({manifest,readText:path=>path==='daily/2.json'?Promise.reject(Error('SYNTHETIC_PRIVATE_COOKIE')):texts.get(path),onProgress:e=>failed.push(e)}),e=>e.code==='date-storage-read'&&!e.message.includes('SYNTHETIC_PRIVATE'));
 assert.equal(failed.some(e=>e.phase==='done'),false);
});

test('fixed missing, checksum and digest codes identify the failure without leaking content',async()=>{
 for(const kind of ['missing','checksum','digest']){
  const {manifest,texts}=fixture(2,{mismatch:kind==='digest'});
  await assert.rejects(auditDatePublication({manifest,readText:path=>path==='daily/1.json'&&kind!=='digest'?kind==='missing'?undefined:'SYNTHETIC_PRIVATE_DATA':texts.get(path)}),e=>e.code===({'missing':'date-source-missing',checksum:'date-source-checksum',digest:'date-source-digest'})[kind]&&!e.message.includes('SYNTHETIC_PRIVATE'));
 }
});
