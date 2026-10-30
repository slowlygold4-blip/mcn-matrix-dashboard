import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {collectionProgress} from '../lib/collection-progress.mjs';
import {dailyStoredWorkLikes,enabledCollectionTargets} from '../lib/collection-platform-progress.mjs';
function setup(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE targets(id INTEGER PRIMARY KEY,type TEXT,label TEXT,enabled INTEGER,metadata_json TEXT);
 CREATE TABLE runs(id INTEGER,trigger_type TEXT,started_at TEXT,finished_at TEXT,status TEXT,target_count INTEGER,processed_count INTEGER,success_count INTEGER,error_count INTEGER,warning_count INTEGER,skipped_count INTEGER,heartbeat_at TEXT,current_target_id INTEGER,details_json TEXT);
 CREATE TABLE author_resolution_queue(status TEXT);
 CREATE TABLE posts(id INTEGER PRIMARY KEY,target_id INTEGER,first_seen_at TEXT,external_id TEXT);
 CREATE TABLE post_metrics(post_id INTEGER,captured_at TEXT,likes);
 INSERT INTO targets VALUES(1,'account','d',1,'{"platform":"douyin"}'),(2,'account','b',1,'{"platform":"bilibili"}'),
 (3,'account','paused',0,'{"platform":"douyin"}'),(4,'hashtag','topic',1,'{}'),(5,'account','unknown',1,'{"platform":"PRIVATE_SENTINEL"}');`);
 return db;
}
const now='2026-10-30T02:00:00.000Z';
const enabled=[{id:1,type:'account',platform:'douyin'},{id:2,type:'account',platform:'bilibili'},{id:5,type:'account',platform:'unknown'}];
function run(db,details){db.prepare("INSERT INTO runs VALUES(1,'scheduled','2026-10-30T01:00:00Z','2026-10-30T01:00:01Z','success',5,5,5,0,0,0,'2026-10-30T01:00:00Z',NULL,?)").run(JSON.stringify(details));}

test('Bilibili work success cannot conceal a Douyin work refusal and raw platform names never leak',t=>{
 const db=setup(t);run(db,[{targetId:1,profileUsable:true,worksCoverage:'unavailable',worksErrorCode:'blocked'},
  {targetId:2,profileUsable:true,worksCoverage:'limited'}, {targetId:4,topicMetricsUsable:true}]);
 const x=collectionProgress(db,{now});assert.deepEqual(x.rolling.platforms,[
  {platform:'douyin',accounts:1,profiles:1,worksComplete:0,worksLimited:0,workIssues:1},
  {platform:'bilibili',accounts:1,profiles:1,worksComplete:0,worksLimited:1,workIssues:0},
  {platform:'unknown',accounts:1,profiles:0,worksComplete:0,worksLimited:0,workIssues:0}]);
 assert.equal(x.rolling.profiles,2);assert.equal(x.rolling.topics,1);
 assert.equal(JSON.stringify(x).includes('PRIVATE_SENTINEL'),false);
});

test('a topic is not an account profile/work and a false topic flag on an account is ignored',t=>{
 const db=setup(t);run(db,[{targetId:4,profileUsable:true,worksCoverage:'complete',worksErrorCode:'blocked'},
  {targetId:1,topicMetricsUsable:true}, {targetId:3,profileUsable:true,worksCoverage:'complete'}]);
 const r=collectionProgress(db,{now}).rolling;
 assert.equal(r.profiles,0);assert.equal(r.topics,0);assert.equal(r.updated,0);assert.equal(r.worksComplete,0);assert.equal(r.workIssues,0);
});

test('today counts distinct stored works; repeated samples, disabled accounts, future rows and unknown likes do not inflate it',t=>{
 const db=setup(t);
 db.exec(`INSERT INTO posts VALUES(1,1,'2026-09-12T00:00:00Z','work1'),(2,1,'2026-09-12T00:00:00Z','work2'),(3,2,'2026-09-12T00:00:00Z','work3'),
 (4,3,'2026-09-12T00:00:00Z','work4'),(5,1,'2026-10-31T00:00:00Z','work5'),(6,5,'2026-09-12T00:00:00Z','work6');
 INSERT INTO post_metrics VALUES(1,'2026-10-29T16:00:00.000Z',0),(1,'2026-10-30T00:00:00Z',10),
 (2,'2026-10-29T15:59:59.999Z',9),(2,'2026-10-30T03:00:00Z',9),
 (3,'2026-10-30T00:00:00Z',7),(4,'2026-10-30T00:00:00Z',8),(5,'2026-10-30T00:00:00Z',8),
 (6,'2026-10-30T00:00:00Z',NULL),(6,'2026-10-30T00:00:00Z','9'),(6,'2026-10-30T00:00:00Z',1.5),(6,'2026-10-30T00:00:00Z',-1);`);
 const before=db.prepare('SELECT total_changes() n').get().n;
 const x=dailyStoredWorkLikes(db,enabled,now);
 assert.equal(x.date,'2026-10-30');assert.equal(x.since,'2026-10-29T16:00:00.000Z');
 assert.equal(x.basis,'stored-work-like-observations');
 assert.deepEqual(x.platforms,[{platform:'douyin',storedWorks:2,observedWorks:1,observedAccounts:1},
  {platform:'bilibili',storedWorks:1,observedWorks:1,observedAccounts:1},
  {platform:'unknown',storedWorks:1,observedWorks:0,observedAccounts:0}]);
 assert.equal(db.prepare('SELECT total_changes() n').get().n,before);
});

test('legacy mixed UTC formats obey the actual Beijing boundary',t=>{
 const db=setup(t);db.exec("INSERT INTO posts VALUES(1,1,'2026-09-12T00:00:00Z','work1'),(2,1,'2026-09-12T00:00:00Z','work2'); INSERT INTO post_metrics VALUES(1,'2026-10-29 16:00:00',0),(2,'2026-10-29 15:59:59',1)");
 assert.equal(dailyStoredWorkLikes(db,enabled,now).platforms[0].observedWorks,1);
});

test('missing metrics schema means unavailable instead of a false zero observation',t=>{
 const db=setup(t);db.exec('DROP TABLE post_metrics');
 assert.equal(dailyStoredWorkLikes(db,enabled,now),null);
 assert.equal(collectionProgress(db,{now}).dailyWorkLikes,null);
});

test('a real zero stored-observation count is separate from a zero-valued metric',t=>{
 const db=setup(t);db.exec("INSERT INTO posts VALUES(1,1,'2026-09-12T00:00:00Z','work1')");
 const x=dailyStoredWorkLikes(db,enabled,now);assert.equal(x.platforms[0].storedWorks,1);assert.equal(x.platforms[0].observedWorks,0);
});

test('duplicate work IDs across account files count once per platform, with account records retained',t=>{
 const db=setup(t);db.exec(`INSERT INTO targets VALUES(6,'account','alias',1,'{"platform":"douyin"}');
 INSERT INTO posts VALUES(1,1,'2026-09-12T00:00:00Z','same-work'),(2,6,'2026-09-12T00:00:00Z','same-work'),(3,2,'2026-09-12T00:00:00Z','same-work');
 INSERT INTO post_metrics VALUES(1,'2026-10-30T00:00:00Z',3),(2,'2026-10-30T00:00:00Z',3),(3,'2026-10-30T00:00:00Z',4);`);
 const rows=dailyStoredWorkLikes(db,enabledCollectionTargets(db),now).platforms;
 assert.deepEqual(rows[0],{platform:'douyin',storedWorks:1,observedWorks:1,observedAccounts:2});
 assert.deepEqual(rows[1],{platform:'bilibili',storedWorks:1,observedWorks:1,observedAccounts:1});
});

test('legacy canonical sec_uid locators identify Douyin without guessing by name or overriding declarations',t=>{
 const db=setup(t);db.exec(`ALTER TABLE targets ADD COLUMN locator TEXT;
 INSERT INTO targets VALUES(6,'account','any name',1,'{}','MS4wLjABAAAAabcdefghijklmnop'),
 (7,'account','looks douyin',1,'{"platform":"bilibili"}','MS4wLjABAAAAabcdefghijklmnop'),
 (8,'account','looks douyin',1,'{}','MS4wLjbad!invalidvalue');`);
 const rows=enabledCollectionTargets(db);assert.equal(rows.find(r=>r.id===6).platform,'douyin');
 assert.equal(rows.find(r=>r.id===7).platform,'bilibili');assert.equal(rows.find(r=>r.id===8).platform,'unknown');
 const daily=dailyStoredWorkLikes(db,rows,now);assert.equal(daily.platforms[0].platform,'douyin');
});
