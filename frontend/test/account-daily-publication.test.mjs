import test from 'node:test';
import assert from 'node:assert/strict';
import {accountDailyPublication,authorDailyPublication} from '../lib/author-daily-publication.mjs';
import {historyExport} from '../lib/replica-export.mjs';
const asOf='2026-10-30T04:00:00.000Z';
const video=(id,publishedAt)=>({id,targetId:7,externalId:String(7500000000000000000n+BigInt(id)),caption:'作品'+id,publishedAt,likes:0,plays:null});

test('account publication uses saved work dates, never daily inventory changes or the observation day',()=>{
 const rows=[video(1,'2026-10-29T15:59:59.000Z'),video(2,'2026-10-29T16:00:00.000Z'),{...video(3,null),publishedOn:'2026-10-30',publicationDateBasis:'creator-source-date-only'}];
 const result=accountDailyPublication(rows,{targetId:7,platform:'douyin',asOf,date:'2026-10-30'});
 assert.equal(result.knownWorks,1);assert.equal(result.recordedWorks,2);assert.equal(result.unverifiedDateWorks,1);assert.equal(result.status,'published');assert.equal(result.complete,false);
 assert.deepEqual(result.rows.map(r=>r.id),[2,3]);
});
test('Bilibili work IDs are supported without accepting another platform or a different account',()=>{
 const row={...video(1,'2026-10-29T23:00:00.000Z'),externalId:'BV1xx411c7mD'};
 assert.equal(accountDailyPublication([row],{targetId:7,platform:'bilibili',asOf}).knownWorks,1);
 assert.equal(authorDailyPublication([row],{platform:'bilibili',asOf}).knownWorks,1);
 assert.throws(()=>accountDailyPublication([row],{targetId:7,platform:'douyin',asOf}),/身份/);
 assert.throws(()=>accountDailyPublication([video(1,asOf)],{targetId:7,platform:'bilibili',asOf}),/身份/);
 assert.throws(()=>accountDailyPublication([row],{targetId:8,platform:'bilibili',asOf}),/账号/);
 assert.throws(()=>accountDailyPublication([row],{targetId:7,platform:'unreviewed-platform',asOf}),/平台/);
});
test('no saved works, an absent day and future works remain unknown rather than zero publications',()=>{
 for(const rows of [[],[video(1,null)],[video(1,'2026-10-30T05:00:00.000Z')],[video(1,'2026-10-28T00:00:00.000Z')]]){
  const model=accountDailyPublication(rows,{targetId:7,platform:'douyin',asOf});
  assert.equal(model.knownWorks,0);assert.equal(model.status,'unknown');assert.equal(model.complete,false);
 }
});
test('the selected publication day keeps all matching works for history export beyond the first table page',()=>{
 const rows=Array.from({length:24},(_,i)=>video(i+1,i<21?'2026-10-29T02:00:00.000Z':'2026-10-28T02:00:00.000Z'));
 const original=structuredClone(rows),result=accountDailyPublication(rows,{targetId:7,platform:'douyin',asOf,date:'2026-10-29'});
 const manifest={asOf,timeZone:'Asia/Shanghai',files:[{path:'works/7.json',kind:'works',targetId:7,count:rows.length,sha256:'a'.repeat(64)}]};
 const csv=historyExport({rows:result.rows,kind:'works',account:{id:7,label:'账号',platform:'douyin'},manifest});
 assert.equal(result.knownWorks,21);assert.equal(csv.length,22);
 assert.equal(JSON.stringify(csv).includes('作品24'),false);assert.deepEqual(rows,original);
});
test('invalid dates, incomplete account binding and non-canonical IDs do not produce daily counts',()=>{
 for(const targetId of [0,-1,null,'7'])assert.throws(()=>accountDailyPublication([],{targetId,platform:'douyin',asOf}),/账号/);
 assert.throws(()=>accountDailyPublication([{...video(1,asOf),targetId:undefined}],{targetId:7,platform:'douyin',asOf}),/账号/);
 assert.throws(()=>accountDailyPublication([video(1,asOf)],{targetId:7,platform:'douyin',asOf,date:'2026-02-30'}));
 assert.throws(()=>accountDailyPublication([video(1,asOf)],{targetId:7,platform:'douyin',asOf,date:'2026-10-31'}));
});
