import test from 'node:test';
import assert from 'node:assert/strict';
import {MonitorDatabase} from '../lib/database.mjs';
import {normalizeCollection} from '../lib/providers/normalize.mjs';
import {checksum} from '../lib/utils.mjs';
import {validateAccountSnapshot} from '../lib/account-snapshot-integrity.mjs';
import {readCommittedTargetPublication,committedSnapshotAllowed,releaseCommittedTargetPublication} from '../lib/committed-target-publication.mjs';
import {exportPublicReplica} from '../lib/public-replica-export.mjs';

const AS='2026-09-20T12:00:00.000Z', SEC='MS4wLjABAAAAClockPrecisionOfflineAccount123';
function fixture(t, at='2026-09-20T02:00:00Z') {
 t.mock.timers.enable({apis:['Date'],now:Date.parse(at)-1000});
 const database=new MonitorDatabase(':memory:');t.after(()=>database.close());
 const target=database.createTarget({type:'account',provider:'public-web',label:'offline fixture',locator:SEC});
 const runId=database.beginRun('scheduled',target.id,1);
 const raw={capturedAt:at,accountStatus:'validated',accountError:null,
  profile:{user:{sec_uid:SEC,uid:'12345678',follower_count:20,total_favorited:40,aweme_count:0}},
  provenance:{mode:'guest-ttwid-unsigned-profile',profileMode:'guest-ttwid-unsigned-profile',
   profileEndpoint:'https://www.douyin.com/aweme/v1/web/user/profile/other/',accountLocator:'sec_uid',cookiePersisted:false,runtimeAI:false,paidAPI:false}};
 t.mock.timers.setTime(Date.parse(at)+1000);
 database.saveCollection(target,runId,normalizeCollection(target,raw,{capturedAt:at}));
 database.finishRun(runId,{status:'success',successCount:1,processedCount:1});
 t.mock.timers.setTime(Date.parse(AS)+1);
 const row=database.db.prepare('SELECT * FROM snapshots').get();
 const read=(asOf=AS)=>{const db=database.db;db.exec('BEGIN');let receipt;
  try{receipt=readCommittedTargetPublication(db,{asOf});const allowed=committedSnapshotAllowed(receipt,row);
   const replica=exportPublicReplica(db,{asOf,committedPublication:receipt});
   return {allowed,account:replica.catalog.accounts[0],daily:replica.partitions.find(p=>p.kind==='daily')?.items??[]};
  }finally{if(receipt)releaseCommittedTargetPublication(receipt);db.exec('ROLLBACK');}};
 return {database,db:database.db,target,runId,row,raw,read};
}

for(const at of ['2026-09-20T02:00:00Z','2026-09-20T02:00:00.1Z','2026-09-20T02:00:00.12Z','2026-09-20T02:00:00.123Z']) {
 test(`valid UTC clock precision ${at} preserves the actual profile and original bytes`,t=>{
  const f=fixture(t,at),before=f.db.prepare('SELECT total_changes() n').get().n;
  assert.equal(validateAccountSnapshot(f.row,f.target).valid,true);
  const out=f.read();assert.equal(out.allowed,true);assert.equal(out.account.latest.followers.value,20);
  assert.equal(out.account.latest.followers.observedAt,new Date(at).toISOString());
  assert.equal(out.daily[0].followersChecksum,f.row.source_checksum);
  assert.equal(f.db.prepare('SELECT raw_json FROM snapshots').get().raw_json,JSON.stringify(f.raw));
  assert.equal(f.db.prepare('SELECT captured_at FROM snapshots').get().captured_at,at);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
 });
}

test('each clock may use a different valid precision and numeric ordering still owns admission',t=>{
 const f=fixture(t);
 f.db.prepare('UPDATE runs SET started_at=?,finished_at=? WHERE id=?').run('2026-09-20T01:59:59Z','2026-09-20T02:00:01.1Z',f.runId);
 f.db.prepare('UPDATE audits SET created_at=?').run('2026-09-20T02:00:01Z');
 assert.equal(f.read().allowed,true);
});

for(const [kind,clock] of [['run','2026-09-20T02:00:00.001Z'],['audit','2026-09-20T01:59:59.999Z'],['finish','2026-09-20T02:00:00.999Z']]) {
 test(`${kind} clock order cannot be hidden by Z versus fractional-second lexical order`,t=>{
  const f=fixture(t);
  if(kind==='audit')f.db.prepare('UPDATE audits SET created_at=?').run(clock);
  else f.db.prepare(`UPDATE runs SET ${kind==='run'?'started_at':'finished_at'}=? WHERE id=?`).run(clock,f.runId);
  assert.equal(f.read().allowed,false);
 });
}

for(const clock of ['2026-09-20 02:00:01','2026-09-20T02:00:01+00:00','2026-02-30T02:00:01Z',
 '2026-09-20T24:00:00Z','2026-09-20T02:00:01.1234Z',' 2026-09-20T02:00:01Z']) {
 test(`ambiguous or invalid stored audit clock remains rejected: ${clock}`,t=>{
  const f=fixture(t);f.db.prepare('UPDATE audits SET created_at=?').run(clock);assert.equal(f.read().allowed,false);
 });
}

test('timestamp compatibility grants no missing audit, foreign identity or modified count authority',t=>{
 const f=fixture(t);f.db.prepare('DELETE FROM audits').run();assert.equal(f.read().allowed,false);
});

test('canonical generation cutoff remains strict even though legacy observation seconds are valid',t=>{
 const f=fixture(t);assert.throws(()=>f.read('2026-09-20T12:00:00Z'),/invalid-committed/);
});

test('the precision fix does not authorize a mutated raw source hash',t=>{
 const f=fixture(t);f.db.prepare('UPDATE snapshots SET source_checksum=?').run(checksum({fabricated:true}));
 assert.equal(f.read().account.latest.followers.value,null);
});
