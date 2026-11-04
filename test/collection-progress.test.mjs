import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {collectionProgress} from '../lib/collection-progress.mjs';
import {saveProfileProgressFixture} from './helpers/profile-progress-fixture.mjs';
test('rolling coverage deduplicates targets; profile-only refresh never erases complete work evidence; old/disabled excluded',()=>{
 const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE runs(id INTEGER,trigger_type TEXT,started_at TEXT,finished_at TEXT,status TEXT,target_count INTEGER,processed_count INTEGER,success_count INTEGER,error_count INTEGER,warning_count INTEGER,skipped_count INTEGER,heartbeat_at TEXT,current_target_id INTEGER,details_json TEXT);CREATE TABLE targets(id INTEGER,type TEXT,label TEXT,enabled INTEGER);CREATE TABLE author_resolution_queue(status TEXT);INSERT INTO targets VALUES(1,'account','matrix',1),(2,'account','missing',1),(3,'hashtag','topic',1),(4,'account','paused',0);`);
 const put=(id,date,details)=>db.prepare('INSERT INTO runs VALUES(?,\'scheduled\',?,?,\'success\',4,4,4,0,0,0,?,NULL,?)').run(id,date,date,date,JSON.stringify(details));
 put(1,'2026-10-24T01:00:00.000Z',[{targetId:2,profileUsable:true}]);put(2,'2026-10-26T01:00:00.000Z',[{targetId:1,profileUsable:true,worksCoverage:'complete'},{targetId:3,topicMetricsUsable:true},{targetId:4,profileUsable:true}]);put(3,'2026-10-26T02:00:00.000Z',[{targetId:1,profileUsable:true,worksCoverage:'unavailable'}]);
 for(const [targetId,runId,at]of [[2,1,'2026-10-24T01:00:00.000Z'],[1,2,'2026-10-26T01:00:00.000Z'],[4,2,'2026-10-26T01:00:00.000Z'],[1,3,'2026-10-26T02:00:00.000Z']])saveProfileProgressFixture(db,targetId,runId,at);
 const r=collectionProgress(db,{now:'2026-10-26T03:00:00.000Z'}).rolling;assert.equal(r.updated,2);assert.equal(r.total,3);assert.equal(r.notUpdated,1);assert.equal(r.profiles,1);assert.equal(r.worksComplete,1);assert.equal(r.attempted,2);
 assert.deepEqual(r.issues,{version:1,since:r.since,asOf:'2026-10-26T03:00:00.000Z',missingProfileTargetIds:[2],missingTopicTargetIds:[],workIssueGroups:[]});db.close();
});

test('in-flight coverage reads only committed matching audits, never counts progress or missing vectors as success',()=>{
 const db=new DatabaseSync(':memory:');db.exec(`
 CREATE TABLE runs(id INTEGER,trigger_type TEXT,started_at TEXT,finished_at TEXT,status TEXT,target_count INTEGER,processed_count INTEGER,success_count INTEGER,error_count INTEGER,warning_count INTEGER,skipped_count INTEGER,heartbeat_at TEXT,current_target_id INTEGER,details_json TEXT);
 CREATE TABLE targets(id INTEGER,type TEXT,label TEXT,enabled INTEGER);
 CREATE TABLE author_resolution_queue(status TEXT);
 CREATE TABLE audits(run_id INTEGER,target_id INTEGER,source_checksum TEXT,status TEXT,created_at TEXT);
 CREATE TABLE snapshots(target_id INTEGER,source_checksum TEXT,quality_status TEXT,captured_at TEXT,account_status TEXT,followers INTEGER,total_likes INTEGER,total_posts INTEGER,hashtag_participants INTEGER,hashtag_views INTEGER,works_coverage TEXT,works_observed_at TEXT);
 INSERT INTO targets VALUES(1,'account','valid',1),(2,'account','partial vector',1),(3,'hashtag','valid topic',1),(4,'account','paused',0),(5,'account','bad proof',1),(6,'hashtag','missing views',1);
 INSERT INTO runs VALUES(1,'scheduled','2026-10-26T01:00:00.000Z',NULL,'running',6,6,6,0,0,0,'2026-10-26T03:00:00.000Z',NULL,'[]');`);
 const put=(id,type,overrides={})=>{
  const x={target_id:id,source_checksum:'proof-'+id,quality_status:'validated',captured_at:'2026-10-26T02:00:00.000Z',account_status:type==='account'?'available':'unknown',followers:10,total_likes:20,total_posts:3,hashtag_participants:30,hashtag_views:40,works_coverage:'complete',works_observed_at:'2026-10-26T02:00:00.000Z',...overrides};
  db.prepare('INSERT INTO snapshots VALUES('+Array(12).fill('?').join(',')+')').run(...Object.values(x));
  db.prepare('INSERT INTO audits VALUES(1,?,?,?,?)').run(id,'proof-'+id,'validated','2026-10-26T02:00:00.000Z');
 };
 put(1,'account');put(2,'account',{total_likes:null});put(3,'hashtag');put(4,'account');put(5,'account',{source_checksum:'different'});put(6,'hashtag',{hashtag_views:null});
 db.exec("INSERT INTO audits VALUES(1,1,'proof-1','warning','2026-10-26T02:00:00.000Z')");
 const r=collectionProgress(db,{now:'2026-10-26T03:00:00.000Z'}).rolling;
 assert.equal(r.profiles,1);assert.equal(r.topics,1);assert.equal(r.updated,2);assert.equal(r.total,5);assert.equal(r.notUpdated,3);
 assert.deepEqual(r.issues.missingProfileTargetIds,[2,5]);assert.deepEqual(r.issues.missingTopicTargetIds,[6]);
 assert.equal(new Set([...r.issues.missingProfileTargetIds,...r.issues.missingTopicTargetIds]).size,r.notUpdated);
 assert.equal(r.worksComplete,2,'valid work proof can remain independent of a missing profile counter');
 assert.equal(r.attempted,4);db.close();
});


test('structured HTTP works refusals and deferred requests remain visible independently of successful profiles',()=>{
 const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE runs(id INTEGER,trigger_type TEXT,started_at TEXT,finished_at TEXT,status TEXT,target_count INTEGER,processed_count INTEGER,success_count INTEGER,error_count INTEGER,warning_count INTEGER,skipped_count INTEGER,heartbeat_at TEXT,current_target_id INTEGER,details_json TEXT);CREATE TABLE targets(id INTEGER,type TEXT,label TEXT,enabled INTEGER);CREATE TABLE author_resolution_queue(status TEXT);INSERT INTO targets VALUES(1,'account','blocked',1),(2,'account','cooldown',1),(3,'account','recovered',1),(4,'account','private-code',1);`);
 const put=(id,details)=>{const at='2026-10-29T0'+id+':00:00.000Z';db.prepare("INSERT INTO runs VALUES(?,'scheduled',?,?,'success',4,4,4,0,4,0,?,NULL,?)").run(id,at,at,at,JSON.stringify(details));};
 put(1,[{targetId:1,profileUsable:true,worksCoverage:'unavailable',worksErrorCode:'blocked'},{targetId:2,profileUsable:true,worksCoverage:'unavailable',worksErrorCode:'deferred'},{targetId:3,worksCoverage:'unavailable',errorCode:'network_error'},{targetId:4,worksCoverage:'unavailable',errorCode:'PRIVATE_SENTINEL'}]);
 put(2,[{targetId:3,profileUsable:true,worksCoverage:'limited',worksErrorCode:null}]);
 for(const [targetId,runId]of [[1,1],[2,1],[3,2]])saveProfileProgressFixture(db,targetId,runId,`2026-10-29T0${runId}:00:00.000Z`);
 const result=collectionProgress(db,{now:'2026-10-29T03:00:00.000Z'});
 assert.equal(result.rolling.profiles,3);assert.equal(result.rolling.worksComplete,0);assert.equal(result.rolling.worksLimited,1);
 assert.deepEqual(new Map(result.rolling.reasons.map(r=>[r.code,r.count])),new Map([['blocked',1],['transport-cooldown',1],['unknown',1]]));
 assert.equal(result.rolling.workIssues,3);
 assert.deepEqual(result.rolling.issues.workIssueGroups,[{code:'blocked',targetIds:[1]},{code:'transport-cooldown',targetIds:[2]},{code:'unknown',targetIds:[4]}]);
 assert.deepEqual(result.rolling.issues.missingProfileTargetIds,[4]);assert.equal(JSON.stringify(result).includes('PRIVATE_SENTINEL'),false);db.close();
});


test('future clocks and corrupt detail containers cannot falsify or break the current status',()=>{
 const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE runs(id INTEGER,trigger_type TEXT,started_at TEXT,finished_at TEXT,status TEXT,target_count INTEGER,processed_count INTEGER,success_count INTEGER,error_count INTEGER,warning_count INTEGER,skipped_count INTEGER,heartbeat_at TEXT,current_target_id INTEGER,details_json TEXT);CREATE TABLE targets(id INTEGER,type TEXT,label TEXT,enabled INTEGER);CREATE TABLE author_resolution_queue(status TEXT);INSERT INTO targets VALUES(1,'account','real',1),(2,'account','future',1);`);
 const put=(id,start,end,details)=>db.prepare("INSERT INTO runs VALUES(?,'scheduled',?,?,'success',2,2,2,0,0,0,?,NULL,?)").run(id,start,end,start,JSON.stringify(details));
 put(1,'2026-10-29T01:00:00Z','2026-10-29T01:00:10Z',[{targetId:1,profileUsable:true,worksCoverage:'limited'}]);
 put(2,'2026-10-29T01:10:00Z','2026-10-29T01:10:10Z',{invalid:'container'});
 put(3,'2026-10-29T01:20:00Z','2026-10-29T01:20:10Z',[null,7]);
 put(4,'2026-10-30T01:00:00Z','2026-10-30T01:00:10Z',[{targetId:2,profileUsable:true,worksCoverage:'complete'}]);
 put(5,'2026-10-29T01:30:00Z','2026-10-30T01:00:00Z',[{targetId:2,profileUsable:true,worksCoverage:'complete'}]);
 saveProfileProgressFixture(db,1,1,'2026-10-29T01:00:00Z');saveProfileProgressFixture(db,2,4,'2026-10-30T01:00:00Z');saveProfileProgressFixture(db,2,5,'2026-10-29T01:30:00Z');
 const result=collectionProgress(db,{now:'2026-10-29T03:00:00.000Z'});
 assert.equal(result.run.id,3);assert.equal(result.coverage.runId,3);assert.equal(result.rolling.profiles,1);assert.equal(result.rolling.worksLimited,1);assert.equal(result.rolling.worksComplete,0);
 assert.deepEqual(result.rolling.issues.missingProfileTargetIds,[2]);db.close();
});

test('rolling window includes legacy UTC-space runs after the exact cutoff without admitting older runs',()=>{
 const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE runs(id INTEGER,trigger_type TEXT,started_at TEXT,finished_at TEXT,status TEXT,target_count INTEGER,processed_count INTEGER,success_count INTEGER,error_count INTEGER,warning_count INTEGER,skipped_count INTEGER,heartbeat_at TEXT,current_target_id INTEGER,details_json TEXT);CREATE TABLE targets(id INTEGER,type TEXT,label TEXT,enabled INTEGER);CREATE TABLE author_resolution_queue(status TEXT);INSERT INTO targets VALUES(1,'account','within',1),(2,'account','outside',1);`);
 const put=(id,start,targetId)=>db.prepare("INSERT INTO runs VALUES(?,'scheduled',?,?,'success',1,1,1,0,0,0,?,NULL,?)").run(id,start,start,start,JSON.stringify([{targetId,profileUsable:true,worksCoverage:'limited'}]));
 put(1,'2026-10-28 23:30:00',1);put(2,'2026-10-28 02:59:59',2);
 saveProfileProgressFixture(db,1,1,'2026-10-28 23:30:00');saveProfileProgressFixture(db,2,2,'2026-10-28 02:59:59');
 const r=collectionProgress(db,{now:'2026-10-29T03:00:00.000Z'}).rolling;assert.equal(r.profiles,1);assert.equal(r.worksLimited,1);assert.equal(r.attempted,1);db.close();
});

test('issue target lists reconcile across platforms, reject paused and foreign IDs, and retain every fixed reason beyond the top-five summary',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE runs(id INTEGER,trigger_type TEXT,started_at TEXT,finished_at TEXT,status TEXT,target_count INTEGER,processed_count INTEGER,success_count INTEGER,error_count INTEGER,warning_count INTEGER,skipped_count INTEGER,heartbeat_at TEXT,current_target_id INTEGER,details_json TEXT);
 CREATE TABLE targets(id INTEGER PRIMARY KEY,type TEXT,label TEXT,enabled INTEGER,metadata_json TEXT);
 CREATE TABLE author_resolution_queue(status TEXT);`);
 const codes=['blocked','deferred','login_required','network_error','business_error','upstream_changed','collector_error','PRIVATE_ERROR'];
 for(let id=1;id<=8;id++)db.prepare("INSERT INTO targets VALUES(?,'account','PRIVATE_LABEL',1,?)")
  .run(id,JSON.stringify({platform:id%2?'douyin':'bilibili',internalUrl:'https://private.invalid/PRIVATE_CREDENTIAL'}));
 db.exec("INSERT INTO targets VALUES(9,'account','paused',0,'{}'),(10,'hashtag','missing topic',1,'{}'),(11,'hashtag','observed topic',1,'{}'),(12,'hashtag','paused topic',0,'{}')");
 const at='2026-10-29T01:00:00.000Z',now='2026-10-29T03:00:00.000Z';
 const details=codes.flatMap((worksErrorCode,index)=>Array.from({length:2},()=>({targetId:index+1,worksErrorCode,worksCoverage:'unavailable',message:'PRIVATE_MESSAGE'})));
 details.push({targetId:9,worksErrorCode:'blocked'},{targetId:10,profileUsable:true,worksErrorCode:'blocked'},
  {targetId:11,topicMetricsUsable:true},{targetId:11,topicMetricsUsable:true},{targetId:12,topicMetricsUsable:true},
  {targetId:999,worksErrorCode:'blocked'},{targetId:'1',worksErrorCode:'login_required'});
 db.prepare("INSERT INTO runs VALUES(1,'scheduled',?,?,'success',12,12,12,0,0,0,?,NULL,?)").run(at,at,at,JSON.stringify(details));
 saveProfileProgressFixture(db,1,1,at);saveProfileProgressFixture(db,2,1,at);saveProfileProgressFixture(db,9,1,at);
 const changes=db.prepare('SELECT total_changes() n').get().n;
 const result=collectionProgress(db,{now}),r=result.rolling,i=r.issues;
 assert.equal(i.asOf,result.observedAt);assert.equal(i.since,r.since);assert.equal(i.version,1);
 assert.deepEqual(i.missingProfileTargetIds,[3,4,5,6,7,8]);assert.deepEqual(i.missingTopicTargetIds,[10]);
 const missing=[...i.missingProfileTargetIds,...i.missingTopicTargetIds];
 assert.equal(missing.length,r.notUpdated);assert.equal(new Set(missing).size,missing.length);
 const workIds=i.workIssueGroups.flatMap(g=>g.targetIds);
 assert.equal(workIds.length,r.workIssues);assert.equal(new Set(workIds).size,workIds.length);
 assert.deepEqual([...workIds].sort((a,b)=>a-b),[1,2,3,4,5,6,7,8]);
 assert.equal(r.reasons.length,5);assert.equal(i.workIssueGroups.length,8,'the top-five display must not truncate the full issue list');
 assert.deepEqual(i.workIssueGroups.find(g=>g.code==='blocked').targetIds,[1]);
 assert.deepEqual(i.workIssueGroups.find(g=>g.code==='transport-cooldown').targetIds,[2]);
 assert.deepEqual(i.workIssueGroups.find(g=>g.code==='unknown').targetIds,[8]);
 for(const p of r.platforms){
  const ids=new Set(Array.from({length:8},(_,index)=>index+1).filter(id=>p.platform===(id%2?'douyin':'bilibili')));
  assert.equal(workIds.filter(id=>ids.has(id)).length,p.workIssues);
 }
 assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);
 assert.equal(db.prepare('SELECT total_changes() n').get().n,changes,'issue projection is read-only');
});
