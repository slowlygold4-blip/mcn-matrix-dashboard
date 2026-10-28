import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {collectionProgress} from '../lib/collection-progress.mjs';
test('rolling coverage deduplicates targets; profile-only refresh never erases complete work evidence; old/disabled excluded',()=>{
 const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE runs(id INTEGER,trigger_type TEXT,started_at TEXT,finished_at TEXT,status TEXT,target_count INTEGER,processed_count INTEGER,success_count INTEGER,error_count INTEGER,warning_count INTEGER,skipped_count INTEGER,heartbeat_at TEXT,current_target_id INTEGER,details_json TEXT);CREATE TABLE targets(id INTEGER,type TEXT,label TEXT,enabled INTEGER);CREATE TABLE author_resolution_queue(status TEXT);INSERT INTO targets VALUES(1,'account','matrix',1),(2,'account','missing',1),(3,'hashtag','topic',1),(4,'account','paused',0);`);
 const put=(id,date,details)=>db.prepare('INSERT INTO runs VALUES(?,\'scheduled\',?,?,\'success\',4,4,4,0,0,0,?,NULL,?)').run(id,date,date,date,JSON.stringify(details));
 put(1,'2026-10-24T01:00:00.000Z',[{targetId:2,profileUsable:true}]);put(2,'2026-10-26T01:00:00.000Z',[{targetId:1,profileUsable:true,worksCoverage:'complete'},{targetId:3,topicMetricsUsable:true},{targetId:4,profileUsable:true}]);put(3,'2026-10-26T02:00:00.000Z',[{targetId:1,profileUsable:true,worksCoverage:'unavailable'}]);
 const r=collectionProgress(db,{now:'2026-10-26T03:00:00.000Z'}).rolling;assert.equal(r.updated,2);assert.equal(r.total,3);assert.equal(r.notUpdated,1);assert.equal(r.profiles,1);assert.equal(r.worksComplete,1);assert.equal(r.attempted,2);db.close();
});

test('in-flight coverage reads only committed matching audits, never counts progress or missing vectors as success',()=>{
 const db=new DatabaseSync(':memory:');db.exec(`
 CREATE TABLE runs(id INTEGER,trigger_type TEXT,started_at TEXT,finished_at TEXT,status TEXT,target_count INTEGER,processed_count INTEGER,success_count INTEGER,error_count INTEGER,warning_count INTEGER,skipped_count INTEGER,heartbeat_at TEXT,current_target_id INTEGER,details_json TEXT);
 CREATE TABLE targets(id INTEGER,type TEXT,label TEXT,enabled INTEGER);
 CREATE TABLE author_resolution_queue(status TEXT);
 CREATE TABLE audits(run_id INTEGER,target_id INTEGER,source_checksum TEXT,status TEXT);
 CREATE TABLE snapshots(target_id INTEGER,source_checksum TEXT,quality_status TEXT,captured_at TEXT,account_status TEXT,followers INTEGER,total_likes INTEGER,total_posts INTEGER,hashtag_participants INTEGER,hashtag_views INTEGER,works_coverage TEXT,works_observed_at TEXT);
 INSERT INTO targets VALUES(1,'account','valid',1),(2,'account','partial vector',1),(3,'hashtag','valid topic',1),(4,'account','paused',0),(5,'account','bad proof',1),(6,'hashtag','missing views',1);
 INSERT INTO runs VALUES(1,'scheduled','2026-10-26T01:00:00.000Z',NULL,'running',6,6,6,0,0,0,'2026-10-26T03:00:00.000Z',NULL,'[]');`);
 const put=(id,type,overrides={})=>{
  const x={target_id:id,source_checksum:'proof-'+id,quality_status:'validated',captured_at:'2026-10-26T02:00:00.000Z',account_status:type==='account'?'available':'unknown',followers:10,total_likes:20,total_posts:3,hashtag_participants:30,hashtag_views:40,works_coverage:'complete',works_observed_at:'2026-10-26T02:00:00.000Z',...overrides};
  db.prepare('INSERT INTO snapshots VALUES('+Array(12).fill('?').join(',')+')').run(...Object.values(x));
  db.prepare('INSERT INTO audits VALUES(1,?,?,?)').run(id,'proof-'+id,'validated');
 };
 put(1,'account');put(2,'account',{total_likes:null});put(3,'hashtag');put(4,'account');put(5,'account',{source_checksum:'different'});put(6,'hashtag',{hashtag_views:null});
 db.exec("INSERT INTO audits VALUES(1,1,'proof-1','warning')");
 const r=collectionProgress(db,{now:'2026-10-26T03:00:00.000Z'}).rolling;
 assert.equal(r.profiles,1);assert.equal(r.topics,1);assert.equal(r.updated,2);assert.equal(r.total,5);assert.equal(r.notUpdated,3);
 assert.equal(r.worksComplete,2,'valid work proof can remain independent of a missing profile counter');
 assert.equal(r.attempted,4);db.close();
});
