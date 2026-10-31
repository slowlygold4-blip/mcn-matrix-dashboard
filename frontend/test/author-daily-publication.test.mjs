import test from 'node:test';
import assert from 'node:assert/strict';
import {authorDailyPublication,publicationBusinessDay} from '../lib/author-daily-publication.mjs';
const asOf='2026-10-30T04:00:00.000Z';
const work=(id,publishedAt)=>({externalId:String(7500000000000000000n+BigInt(id)),publishedAt});
const dated=(id,publishedOn)=>({...work(id,null),publishedOn,publicationDateBasis:'creator-source-date-only'});

test('Beijing day uses precise publication time; unverified date-only records remain visible without confirming publication',()=>{
 assert.equal(publicationBusinessDay('2026-10-29T16:00:00.000Z'),'2026-10-30');
 const rows=[work(1,'2026-10-29T15:59:59.000Z'),{...work(2,'2026-10-29T16:00:00.000Z'),lastObservedAt:asOf},dated(3,'2026-10-30')];
 const result=authorDailyPublication(rows,{asOf});
 assert.equal(result.knownWorks,1);assert.equal(result.recordedWorks,2);assert.equal(result.unverifiedDateWorks,1);assert.equal(result.status,'published');assert.equal(result.complete,false);
 assert.deepEqual(result.rows.map(r=>r.externalId),[rows[1].externalId,rows[2].externalId]);
 assert.equal(authorDailyPublication(rows,{asOf,date:'2026-10-29'}).knownWorks,1);
});
test('no work, a missing day or an undated work never proves no publication',()=>{
 for(const rows of [[],[work(1,null)],[dated(2,'2026-10-28')]]){
  const result=authorDailyPublication(rows,{asOf});assert.equal(result.knownWorks,0);assert.equal(result.status,'unknown');assert.equal(result.complete,false);
 }
 assert.equal(authorDailyPublication([work(1,null)],{asOf}).undatedWorks,1);
});
test('future day and future same-day precise timestamps are excluded from current counts',()=>{
 const result=authorDailyPublication([dated(1,'2026-10-31'),work(2,'2026-10-30T05:00:00.000Z'),dated(3,'2026-10-30')],{asOf});
 assert.equal(result.futureDatedWorks,2);assert.equal(result.knownWorks,0);assert.equal(result.recordedWorks,1);
 assert.equal(authorDailyPublication([work(1,'2026-10-30T04:00:00.000Z')],{asOf}).knownWorks,1);
});
test('one work counts once; contradictory dates and ambiguous clocks fail instead of fabricating counts',()=>{
 const row=dated(1,'2026-10-30');const model=authorDailyPublication([row,{...row}],{asOf});assert.equal(model.knownWorks,0);assert.equal(model.recordedWorks,1);assert.equal(model.status,'date-unverified');
 assert.throws(()=>authorDailyPublication([row,dated(1,'2026-10-29')],{asOf}),/冲突/);
 assert.throws(()=>authorDailyPublication([{externalId:1}],{asOf}),/身份/);
 for(const date of ['2026-02-30','2026-09-11','2026-10-31',''])assert.throws(()=>authorDailyPublication([],{asOf,date}));
 for(const date of ['2026-02-30T00:00:00Z','2026-10-30 04:00:00','invalid'])assert.throws(()=>publicationBusinessDay(date));
});
test('historical selection and calculation leave the unified rows and metrics unchanged',()=>{
 const rows=[{...dated(1,'2026-09-12'),likes:0,adoptedLikes:123,plays:null}];const original=structuredClone(rows);
 const result=authorDailyPublication(rows,{asOf,date:'2026-09-12'});assert.equal(result.currentDay,false);assert.equal(result.rows[0],rows[0]);assert.deepEqual(rows,original);
});
