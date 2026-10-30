import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {collectionProgress} from '../lib/collection-progress.mjs';
import {MonitorDatabase} from '../lib/database.mjs';
import {MonitorScheduler} from '../lib/scheduler.mjs';

test('profile coverage requires committed counter evidence, not a batch success flag; zeros and complete partial profiles remain usable',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE runs(id INTEGER,trigger_type TEXT,started_at TEXT,finished_at TEXT,status TEXT,target_count INTEGER,processed_count INTEGER,success_count INTEGER,error_count INTEGER,warning_count INTEGER,skipped_count INTEGER,heartbeat_at TEXT,current_target_id INTEGER,details_json TEXT);
 CREATE TABLE targets(id INTEGER,type TEXT,label TEXT,enabled INTEGER);
 CREATE TABLE author_resolution_queue(status TEXT);
 CREATE TABLE audits(run_id INTEGER,target_id INTEGER,source_checksum TEXT,status TEXT,created_at TEXT);
 CREATE TABLE snapshots(target_id INTEGER,source_checksum TEXT,quality_status TEXT,captured_at TEXT,account_status TEXT,followers INTEGER,total_likes INTEGER,total_posts INTEGER,hashtag_participants INTEGER,hashtag_views INTEGER,works_coverage TEXT,works_observed_at TEXT);`);
 const claims=[];
 for(let id=1;id<=10;id++){db.prepare("INSERT INTO targets VALUES(?,'account','fixture',?)").run(id,id===8?0:1);claims.push({targetId:id,profileUsable:id!==1&&id!==10,worksCoverage:'unknown'});}
 db.prepare("INSERT INTO runs VALUES(1,'scheduled','2026-10-30T01:00:00.000Z','2026-10-30T02:00:00.000Z','success',10,10,10,0,0,0,'2026-10-30T02:00:00.000Z',NULL,?)").run(JSON.stringify(claims));
 const evidence=(id,patch={})=>{
  const row={target_id:id,source_checksum:'proof-'+id,quality_status:'validated',captured_at:'2026-10-30T01:10:00.000Z',account_status:'available',followers:0,total_likes:0,total_posts:0,hashtag_participants:null,hashtag_views:null,works_coverage:'unknown',works_observed_at:null,...patch};
  db.prepare('INSERT INTO snapshots VALUES('+Array(12).fill('?').join(',')+')').run(...Object.values(row));
  db.prepare("INSERT INTO audits VALUES(1,?,?,'validated',?)").run(id,'proof-'+id,id===6?'2026-10-30T04:00:00.000Z':'2026-10-30T01:20:00.000Z');
 };
 evidence(1);evidence(2,{total_likes:null});evidence(3,{followers:0.5});evidence(4,{source_checksum:'wrong'});
 evidence(5,{captured_at:'2026-10-30T04:00:00.000Z'});evidence(6);evidence(8);evidence(9,{quality_status:'rejected'});evidence(10,{account_status:'partial'});
 const changes=db.prepare('SELECT total_changes() n').get().n;
 const result=collectionProgress(db,{now:'2026-10-30T03:00:00.000Z'});
 assert.equal(result.rolling.profiles,2);assert.equal(result.coverage.profiles,3,'the historical whole batch retains the valid now-paused target');
 assert.equal(result.rolling.notUpdated,7);assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);
 db.exec("UPDATE runs SET started_at='2026-10-28T01:00:00.000Z',finished_at=NULL,status='running',details_json='[]'");
 assert.equal(collectionProgress(db,{now:'2026-10-30T03:00:00.000Z'}).rolling.profiles,2,'a long-running batch retains real recent profiles but not future audits');
});

for(const [missing,values]of [['followers',[null,0,0]],['likes',[0,null,0]],['posts',[0,0,null]],['none',[0,0,0]]])
test(`scheduler preserves missing ${missing} and real zeros without claiming absent profile counters`,async t=>{
 const database=new MonitorDatabase(':memory:');t.after(()=>database.close());
 const locator='MS4wLjABAAAAProfileCounterEvidenceFixture',target=database.createTarget({type:'account',label:'fixture',locator,provider:'public-web',metadata:{platform:'douyin'}});
 const scheduler=new MonitorScheduler(database,{providerOptions:{cooldownMs:0,execFileImpl:(_file,_args,_options,callback)=>callback(null,JSON.stringify({ok:true,data:{profile:{user:{uid:'7462321330400166937',sec_uid:locator,unique_id:'counter_fixture',nickname:'fixture',follower_count:values[0],total_favorited:values[1],aweme_count:values[2]}},works:{aweme_list:[]},accountStatus:'validated',worksCoverage:'complete'}}),'')}});
 const result=await scheduler.runAll({targetId:target.id});
 assert.equal(result.details[0].profileUsable,missing==='none');
 const row=database.db.prepare('SELECT followers,total_likes,total_posts FROM snapshots WHERE target_id=?').get(target.id);
 assert.deepEqual({...row},{followers:values[0],total_likes:values[1],total_posts:values[2]},'preserve true zero and each missing counter without rejecting saved partial evidence');
});
