import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {dailyProfileCoverage} from '../lib/profile-daily-coverage.mjs';
const now='2026-10-30T03:00:00.000Z';
const enabled=[{id:1,type:'account',platform:'douyin'},{id:2,type:'account',platform:'douyin'},
 {id:3,type:'account',platform:'bilibili'},{id:4,type:'hashtag',platform:'unknown'}];
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE runs(id INTEGER,started_at TEXT,finished_at TEXT);
 CREATE TABLE audits(run_id INTEGER,target_id INTEGER,source_checksum TEXT,status TEXT,created_at TEXT);
 CREATE TABLE snapshots(target_id INTEGER,captured_at TEXT,followers,total_likes,quality_status TEXT,account_status TEXT,source_checksum TEXT);`);
 let id=0;
 const add=(target,at,followers,likes,opts={})=>{
  const n=++id,proof='proof-'+n;
  db.prepare('INSERT INTO runs VALUES(?,?,?)').run(n,opts.start??at,opts.finish??at);
  if(!opts.noAudit)db.prepare('INSERT INTO audits VALUES(?,?,?,?,?)').run(n,target,proof,opts.auditStatus??'validated',opts.auditAt??at);
  db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?,?,?)').run(target,at,followers,likes,opts.quality??'validated',opts.status??'partial',proof);
 };
 return {db,add,read:()=>dailyProfileCoverage(db,enabled,now)};
}
const zero={observed:0,comparable:0,missingBaseline:0,conflicting:0};
test('today is Beijing day; zero, drops, independent partial counters and an adjacent baseline count honestly',t=>{
 const {db,add,read}=fixture(t);
 add(1,'2026-10-29T15:59:59.999Z',10,20);
 add(1,'2026-10-29T16:00:00.000Z',0,null);
 add(2,'2026-10-30T01:00:00Z',null,3);
 const changes=db.prepare('SELECT total_changes() n').get().n;
 const result=read(),[d,b]=result.platforms;
 assert.equal(result.date,'2026-10-30');assert.equal(result.previousDate,'2026-10-29');assert.equal(result.since,'2026-10-29T16:00:00.000Z');
 assert.deepEqual(d,{platform:'douyin',accounts:2,followers:{observed:1,comparable:1,missingBaseline:0,conflicting:0},totalLikes:{observed:1,comparable:0,missingBaseline:1,conflicting:0}});
 assert.deepEqual(b,{platform:'bilibili',accounts:1,followers:zero,totalLikes:zero});
 assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);
});
test('offset and legacy UTC spelling of one instant cannot pick arbitrary conflicting day ends',t=>{
 const {add,read}=fixture(t);
 add(1,'2026-10-29T10:00:00Z',10,10);
 add(1,'2026-10-30T00:00:00Z',11,12);
 add(1,'2026-10-30T08:00:00+08:00',12,12);
 add(1,'2026-10-30 00:00:00',11,12);
 let d=read().platforms[0];assert.deepEqual(d.followers,{...zero,conflicting:1});assert.equal(d.totalLikes.comparable,1);
 add(1,'2026-10-30T00:00:01Z',13,null);
 d=read().platforms[0];assert.equal(d.followers.comparable,1);assert.equal(d.followers.conflicting,0);
});
test('a conflicting previous end is a missing baseline, not zero growth; earlier days do not substitute',t=>{
 const {add,read}=fixture(t);
 add(1,'2026-10-29T12:00:00Z',1,1);add(1,'2026-10-29T12:00:00Z',2,1);
 add(1,'2026-10-30T00:00:00Z',3,1);
 add(2,'2026-10-28T10:00:00Z',1,1);add(2,'2026-10-30T00:00:00Z',4,2);
 const d=read().platforms[0];assert.equal(d.followers.observed,2);assert.equal(d.followers.comparable,0);assert.equal(d.followers.missingBaseline,2);assert.equal(d.totalLikes.comparable,1);
});
test('unverified, rejected, future, wrong run clocks, disabled and topic samples never inflate counters',t=>{
 const {add,read}=fixture(t),at='2026-10-30T00:00:00Z';
 for(const opts of [{noAudit:true},{quality:'rejected'},{auditStatus:'rejected'},{status:'unavailable'},
  {start:'2026-10-30T00:01:00Z'},{auditAt:'2026-10-29T23:00:00Z'},
  {auditAt:'2026-10-30T01:00:00Z'},{finish:'2026-10-30T04:00:00Z'}])add(1,at,2,3,opts);
 add(1,'2026-10-30T04:00:00Z',2,3);add(99,at,2,3);add(4,at,2,3);
 assert.deepEqual(read().platforms[0].followers,zero);assert.deepEqual(read().platforms[0].totalLikes,zero);
});
test('invalid counters are absent and a later missing counter does not erase its last valid observation',t=>{
 const {add,read}=fixture(t);
 add(1,'2026-10-30T00:00:00Z',2,3);add(1,'2026-10-30T01:00:00Z',null,-1);
 for(const v of [null,'2',-1,1.5,Number.MAX_SAFE_INTEGER+1,9007199254740992n])add(2,'2026-10-30T02:00:00Z',v,v);
 const d=read().platforms[0];assert.equal(d.followers.observed,1);assert.equal(d.totalLikes.observed,1);
});
test('missing schema is unavailable; malformed clock fails explicitly; no targets is a valid empty denominator',t=>{
 const {db,read}=fixture(t);assert.equal(dailyProfileCoverage(db,[],now).platforms.length,0);
 assert.throws(()=>dailyProfileCoverage(db,enabled,'bad'),/clock/);
 db.exec('DROP TABLE audits');assert.equal(read(),null);
});
