// Independent synthetic-only candidate review. No production DB or services.
import test from 'node:test';
import assert from 'node:assert/strict';
import {MonitorDatabase} from '../lib/database.mjs';
import {normalizeCollection} from '../lib/providers/normalize.mjs';
import {exportPublicReplica} from '../lib/public-replica-export.mjs';
import {readCommittedTargetPublication,assertCommittedTargetPublication} from '../lib/committed-target-publication.mjs';
import {OFFICIAL_DOUYIN_PROFILE_ENDPOINT} from '../lib/official-profile-evidence.mjs';
import {checksum} from '../lib/utils.mjs';
const AS='2026-09-20T12:00:00.000Z', OLD='2026-09-20T01:00:00.000Z', NEW='2026-09-20T02:00:00.000Z';
const SEC='MS4wLjABAAAAIndependentPublicationPeer20261002';
function setup(t){
 t.mock.timers.enable({apis:['Date'],now:Date.parse(AS)+1});
 const database=new MonitorDatabase(':memory:'),db=database.db;t.after(()=>database.close());
 const target=database.createTarget({type:'account',provider:'public-web',label:'独立合成账号',locator:SEC,metadata:{platform:'douyin'}});
 const sample=(at,followers,{terminal=false,changeRaw}={})=>{
  t.mock.timers.setTime(Date.parse(at)-1000);const runId=database.beginRun('scheduled',target.id,1);
  const raw={capturedAt:at,accountStatus:'validated',accountError:null,profile:{user:{sec_uid:SEC,uid:'123456789',follower_count:followers,total_favorited:100,aweme_count:0}},
   provenance:{mode:'guest-ttwid-unsigned-profile',profileMode:'guest-ttwid-unsigned-profile',profileEndpoint:OFFICIAL_DOUYIN_PROFILE_ENDPOINT,accountLocator:'sec_uid',cookiePersisted:false,runtimeAI:false,paidAPI:false}};
  changeRaw?.(raw);const collection={...normalizeCollection(target,raw,{capturedAt:at}),accountStatus:'available'};
  t.mock.timers.setTime(Date.parse(at)+1000);database.saveCollection(target,runId,collection);
  const snapshot=db.prepare('SELECT * FROM snapshots WHERE target_id=? ORDER BY id DESC LIMIT 1').get(target.id);
  const audit=db.prepare('SELECT * FROM audits WHERE run_id=?').get(runId);
  if(terminal){t.mock.timers.setTime(Date.parse(at)+2000);database.finishRun(runId,{status:'success',successCount:1});}
  t.mock.timers.setTime(Date.parse(AS)+1);return {runId,snapshot,audit,raw};
 };
 const old=sample(OLD,10,{terminal:true});
 const read=(asOf=AS)=>{db.exec('BEGIN');try{const token=readCommittedTargetPublication(db,{asOf});const replica=exportPublicReplica(db,{asOf,committedPublication:token});return {token,replica,account:replica.catalog.accounts.find(a=>a.id===target.id),daily:replica.partitions.find(p=>p.kind==='daily'&&p.targetId===target.id)?.items??[]};}finally{db.exec('ROLLBACK');}};
 return {database,db,target,sample,old,read};
}
test('committed running profile advances exact counters without finishing run or claiming complete works',t=>{
 const f=setup(t),fresh=f.sample(NEW,20),r=f.read();assert.equal(r.token.runningSnapshotCount,1);assert.equal(r.account.latest.followers.value,20);assert.equal(r.account.coverage.profileObservedAt,NEW);assert.notEqual(r.account.coverage.works.status,'complete');assert.equal(f.db.prepare('SELECT status,finished_at FROM runs WHERE id=?').get(fresh.runId).status,'running');assert.equal(r.daily[0].sampleCount,2);
});
const badCases={
 'missing audit':f=>f.db.prepare('DELETE FROM audits WHERE id=?').run(f.fresh.audit.id),
 'foreign targeted run':f=>{const other=f.database.createTarget({type:'account',provider:'public-web',label:'other',locator:SEC+'Other'});f.db.prepare('UPDATE runs SET target_id=? WHERE id=?').run(other.id,f.fresh.runId);},
 'wrong snapshot hash':f=>f.db.prepare('UPDATE snapshots SET source_checksum=? WHERE id=?').run('0'.repeat(64),f.fresh.snapshot.id),
 'wrong audit hash':f=>f.db.prepare('UPDATE audits SET source_checksum=? WHERE id=?').run('0'.repeat(64),f.fresh.audit.id),
 'tampered normalized vector':f=>f.db.prepare('UPDATE snapshots SET followers=999 WHERE id=?').run(f.fresh.snapshot.id),
 'audit beyond cutoff':f=>f.db.prepare('UPDATE audits SET created_at=? WHERE id=?').run('2026-09-20T12:00:01.000Z',f.fresh.audit.id),
 'rejected audit':f=>f.db.prepare("UPDATE audits SET status='rejected' WHERE id=?").run(f.fresh.audit.id),
 'rejected snapshot':f=>f.db.prepare("UPDATE snapshots SET quality_status='rejected' WHERE id=?").run(f.fresh.snapshot.id),
 'deleted account audit without snapshot':f=>f.db.prepare('DELETE FROM snapshots WHERE id=?').run(f.fresh.snapshot.id),
 'manual instead of scheduled run':f=>f.db.prepare("UPDATE runs SET trigger_type='manual' WHERE id=?").run(f.fresh.runId),
 'audit before capture':f=>f.db.prepare('UPDATE audits SET created_at=? WHERE id=?').run('2026-09-20T01:59:59.000Z',f.fresh.audit.id),
 'run begins after capture':f=>f.db.prepare('UPDATE runs SET started_at=? WHERE id=?').run('2026-09-20T02:00:01.000Z',f.fresh.runId),
};
for(const [name,mutate] of Object.entries(badCases))test(name+' cannot hide same-day older qualified sample',t=>{const f=setup(t);f.fresh=f.sample(NEW,20);mutate(f);const r=f.read();assert.equal(r.token.runningSnapshotCount,0);assert.equal(r.account.latest.followers.value,10);assert.equal(r.account.coverage.profileObservedAt,OLD);assert.equal(r.daily[0].followersChecksum,f.old.snapshot.source_checksum);assert.equal(r.daily[0].sampleCount,1);});
for(const [name,changeRaw] of Object.entries({
 'foreign profile identity':raw=>raw.profile.user.sec_uid=SEC+'Other',
 'login rejection':raw=>raw.login_required=true,
 'contradictory profile response':raw=>raw.profileResponse={status_code:0,user:{...raw.profile.user,uid:'987654321'}},
 'deleted profile':raw=>raw.profile.user.user_deleted=true,
 'unsafe provenance':raw=>raw.provenance.runtimeAI=true,
 'foreign higher-precedence user cannot replace bound profile counters':raw=>raw.user={sec_uid:SEC+'Foreign',uid:'987654321',follower_count:999,total_favorited:999,aweme_count:999},
 'foreign user_info cannot replace bound profile counters':raw=>raw.user_info={sec_uid:SEC+'Foreign',uid:'987654321',follower_count:999,total_favorited:999,aweme_count:999},
 'outer profile counters cannot replace bound user counters':raw=>Object.assign(raw.profile,{follower_count:999,total_favorited:999,aweme_count:999}),
}))test(name+' is excluded even when raw bytes and audit hash agree',t=>{const f=setup(t);f.sample(NEW,20,{changeRaw});const r=f.read();assert.equal(r.token.runningSnapshotCount,0);assert.equal(r.account.latest.followers.value,10);});
test('partial warning preserves legitimate single counter but does not claim complete fresh profile',t=>{const f=setup(t);f.sample(NEW,20,{changeRaw:r=>r.profile.user.aweme_count=null});const r=f.read();assert.equal(r.token.runningSnapshotCount,1);assert.equal(r.account.latest.followers.value,20);assert.equal(r.account.latest.posts.value,0);assert.equal(r.account.latest.posts.observedAt,OLD);assert.equal(r.account.coverage.profileObservedAt,OLD);});
test('opaque receipt rejects forgery, foreign connection, changed asOf, writes and closed transaction',t=>{const f=setup(t);f.sample(NEW,20);f.db.exec('BEGIN');const token=readCommittedTargetPublication(f.db,{asOf:AS});assert.throws(()=>assertCommittedTargetPublication({...token},f.db,AS));assert.throws(()=>assertCommittedTargetPublication(token,f.db,OLD));const other=new MonitorDatabase(':memory:');try{other.db.exec('BEGIN');assert.throws(()=>assertCommittedTargetPublication(token,other.db,AS));other.db.exec('ROLLBACK');}finally{other.close();}f.db.prepare('UPDATE targets SET label=label WHERE id=?').run(f.target.id);assert.throws(()=>assertCommittedTargetPublication(token,f.db,AS));f.db.exec('ROLLBACK');assert.throws(()=>assertCommittedTargetPublication(token,f.db,AS));});
test('saveCollection failure rolls back both snapshot and audit; no partial fresh authority',t=>{const f=setup(t);f.db.exec("CREATE TRIGGER reject_new_audit BEFORE INSERT ON audits BEGIN SELECT RAISE(ABORT,'synthetic forced rollback'); END");assert.throws(()=>f.sample(NEW,20),/synthetic forced rollback/);t.mock.timers.setTime(Date.parse(AS)+1);const r=f.read();assert.equal(r.token.runningSnapshotCount,0);assert.equal(r.account.latest.followers.value,10);assert.equal(f.db.prepare('SELECT count(*) n FROM snapshots').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM audits').get().n,1);});
