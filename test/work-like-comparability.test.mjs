import test from 'node:test';import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {summarizeWorkLikeComparability,readWorkLikeComparability} from '../lib/work-like-comparability.mjs';
const asOf='2026-10-30T05:00:00.000Z',enabled=[{id:1,type:'account',platform:'douyin'},{id:2,type:'account',platform:'bilibili'},{id:3,type:'account',platform:'douyin'}];
const r=(id,at,likes,target=1)=>({external_id:id,captured_at:at,likes,target_id:target});
const prev='2026-10-29T10:00:00.000Z',today='2026-10-30T02:00:00.000Z';
const summarize=rows=>summarizeWorkLikeComparability(rows,{enabled,asOf});
test('having a saved like today is different from having a daily change baseline',()=>{
 const x=summarize([r('first',today,10),r('zero',prev,0),r('zero',today,0),r('down',prev,8),r('down',today,2),r('gap','2026-10-28T10:00:00.000Z',9),r('gap',today,19),r('up',prev,2,2),r('up',today,3,2)]);
 assert.deepEqual(x,{version:1,previousDate:'2026-10-29',platforms:[{platform:'douyin',knownTodayWorks:4,comparableWorks:2,missingBaselineWorks:2,conflictingWorks:0},{platform:'bilibili',knownTodayWorks:1,comparableWorks:1,missingBaselineWorks:0,conflictingWorks:0}]});
});
test('last valid Beijing daily observation wins; same-instant contradictory values cannot prove a change',()=>{
 const rows=[r('same',prev,5),r('same',today,6),r('same','2026-10-30T03:00:00.000Z',8),r('same','2026-10-30T03:00:00.000Z',9),r('baseline',prev,1),r('baseline',prev,2),r('baseline',today,4),r('resolved',prev,1),r('resolved',prev,2),r('resolved','2026-10-29T11:00:00.000Z',3),r('resolved',today,4)];
 assert.deepEqual(summarize(rows).platforms[0],{platform:'douyin',knownTodayWorks:2,comparableWorks:1,missingBaselineWorks:1,conflictingWorks:1});
 assert.deepEqual(summarize([...rows].reverse()),summarize(rows));
});
test('deduplicates a platform work across account copies while retaining platform separation',()=>{
 const x=summarize([r('shared',prev,1),r('shared',today,2),r('shared',today,2,3),r('shared',prev,7,2),r('shared',today,8,2)]);
 assert.equal(x.platforms[0].knownTodayWorks,1);assert.equal(x.platforms[0].comparableWorks,1);assert.equal(x.platforms[1].comparableWorks,1);
 const conflict=summarize([r('shared',today,2),r('shared',today,3,3)]);assert.equal(conflict.platforms[0].conflictingWorks,1);
});
test('future, unknown and malformed counters never provide baseline and raw IDs are not emitted',()=>{
 const x=summarize([r('PRIVATE_SENTINEL',today,3),r('PRIVATE_SENTINEL',prev,null),r('x',today,'1'),r('y',today,-1),r('z',today,1.5),r('future','2026-10-30T06:00:00.000Z',1),r('disabled',today,1,9)]);
 assert.equal(x.platforms[0].knownTodayWorks,1);assert.equal(x.platforms[0].comparableWorks,0);assert.equal(JSON.stringify(x).includes('PRIVATE_SENTINEL'),false);
});
test('readonly database reader applies Beijing bounds, target state, first-seen date and actual SQL counter types',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(`CREATE TABLE targets(id INTEGER,type TEXT,enabled INTEGER);CREATE TABLE posts(id INTEGER,target_id INTEGER,external_id TEXT,first_seen_at TEXT);CREATE TABLE post_metrics(post_id INTEGER,captured_at TEXT,likes);INSERT INTO targets VALUES(1,'account',1),(2,'account',0);INSERT INTO posts VALUES(1,1,'work','2026-09-12T00:00:00Z'),(2,1,'future','2026-10-31T00:00:00Z'),(3,2,'paused','2026-09-12T00:00:00Z');INSERT INTO post_metrics VALUES(1,'2026-10-28 16:00:00',0),(1,'2026-10-29T16:00:00Z',3),(1,'2026-10-30T04:00:00Z','9'),(1,'2026-10-30T04:00:00Z',NULL),(2,'2026-10-29T16:00:00Z',4),(3,'2026-10-29T16:00:00Z',5)`);
 const before=db.prepare('SELECT total_changes() n').get().n,x=readWorkLikeComparability(db,enabled,asOf);
 assert.equal(x.platforms[0].knownTodayWorks,1);assert.equal(x.platforms[0].comparableWorks,1);assert.equal(db.prepare('SELECT total_changes() n').get().n,before);
});
test('invalid clocks cannot masquerade as a daily proof and unsupported platform text is never emitted',()=>{
 assert.throws(()=>summarizeWorkLikeComparability([],{enabled,asOf:'2026-10-30'}),/invalid/);
 const x=summarizeWorkLikeComparability([r('work',today,0)],{enabled:[{id:1,type:'account',platform:'PRIVATE_SENTINEL'}],asOf});
 assert.equal(x.platforms[0].platform,'unknown');assert.equal(JSON.stringify(x).includes('PRIVATE_SENTINEL'),false);
});
