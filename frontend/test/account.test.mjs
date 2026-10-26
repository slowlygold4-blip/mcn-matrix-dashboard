import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {parseAccountRequest,accountShareQuery,personalPoints,personalWindow} from '../lib/replica-account.mjs';
import {readReplicaPart} from '../lib/replica-reader.mjs';
const g='2026-10-01T02:00:00.000Z',p={targetId:348,id:1,date:'2026-09-08',capturedAt:'2026-09-08T02:00:00.000Z',followers:0,followersAt:'2026-09-08T02:00:00.000Z',likes:null,likesAt:null,posts:1,postsAt:'2026-09-08T02:00:00.000Z'};
test('personal share has one canonical author and fixed date/version with no reflected private parameters',()=>{const q=accountShareQuery({id:348,start:p.date,end:p.date,generation:g});assert.deepEqual(parseAccountRequest(q),{id:348,start:p.date,end:p.date,generation:g});assert.deepEqual(parseAccountRequest('?account=348&redirect=https://outside.invalid'),{id:348,start:null,end:null,generation:null});for(const x of ['?account=0348','?account=348&account=1','?account=348&start=2026-09-08','?account=348&start=2026-09-09&end=2026-09-08','?account=348&generation=yesterday'])assert.throws(()=>parseAccountRequest(x));});
test('paused pre-business observations retain zero and unknown, reject mixed identity, repeated dates and future samples',()=>{const input=[structuredClone(p)],points=personalPoints(input,348,g);assert.equal(points[0].followers,0);assert.equal(points[0].likes,null);assert.equal(Object.keys(points[0]).length,9);assert.deepEqual(personalWindow(points,g),{start:p.date,end:p.date});assert.deepEqual(input,[p]);assert.throws(()=>personalPoints([p,p],348,g));assert.throws(()=>personalPoints([p],1,g));assert.throws(()=>personalPoints([{...p,capturedAt:'2026-10-02T02:00:00.000Z'}],348,g));});
test('sealed personal history reader requires the actual bytes/hash/count, not a forged matching response header',async()=>{const text=JSON.stringify({version:1,asOf:g,timeZone:'Asia/Shanghai',items:[p]}),part='daily/348.json',meta={path:part,kind:'daily',targetId:348,count:1,bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')};const options={generation:g,part,meta,fetcher:async()=>new Response(text,{headers:{'X-Data-Cutoff':g,'X-Data-SHA256':meta.sha256}})};assert.equal((await readReplicaPart(options)).items[0].followers,0);await assert.rejects(()=>readReplicaPart({...options,meta:null}));await assert.rejects(()=>readReplicaPart({...options,meta:{...meta,count:2}}));await assert.rejects(()=>readReplicaPart({...options,fetcher:async()=>new Response(text+' ',{headers:{'X-Data-Cutoff':g,'X-Data-SHA256':meta.sha256}})}));});

test('sealed works reader accepts strict source-row IDs but still rejects forged or repeated IDs',async()=>{
 const part='works/348.json';
 const read=items=>{
  const text=JSON.stringify({version:1,asOf:g,timeZone:'Asia/Shanghai',items});
  const sha256=createHash('sha256').update(text).digest('hex');
  const meta={path:part,kind:'works',targetId:348,count:items.length,bytes:Buffer.byteLength(text),sha256};
  return readReplicaPart({generation:g,part,meta,fetcher:async()=>new Response(text,{headers:{'X-Data-Cutoff':g,'X-Data-SHA256':sha256}})});
 };
 const source={targetId:348,id:'creator-source:1:170',caption:'表格作品',publishedAt:null};
 assert.equal((await read([source,{...source,id:27}])).items[0].id,source.id);
 for(const id of ['creator-source:01:170','creator-source:1:0','creator-source:1:170:2','source:1:170',0,-1,1.5])
  await assert.rejects(read([{...source,id}]),/账号历史记录重复或无效/);
 await assert.rejects(read([source,{...source}]),/账号历史记录重复或无效/);
 await assert.rejects(read([{...source,targetId:349}]),/账号历史归属或条数不一致/);
 const daily={...p,id:'creator-source:1:170'};
 const dailyText=JSON.stringify({version:1,asOf:g,timeZone:'Asia/Shanghai',items:[daily]});
 const dailyHash=createHash('sha256').update(dailyText).digest('hex');
 await assert.rejects(readReplicaPart({generation:g,part:'daily/348.json',meta:{path:'daily/348.json',kind:'daily',targetId:348,count:1,bytes:Buffer.byteLength(dailyText),sha256:dailyHash},fetcher:async()=>new Response(dailyText,{headers:{'X-Data-Cutoff':g,'X-Data-SHA256':dailyHash}})}),/账号历史记录重复或无效/);
});
