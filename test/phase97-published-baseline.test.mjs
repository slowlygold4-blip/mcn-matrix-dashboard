import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const root=process.env.PHASE97_CANDIDATE?pathToFileURL(process.env.PHASE97_CANDIDATE+'/'):new URL('../',import.meta.url);
const {MonitorDatabase}=await import(new URL('lib/database.mjs',root));
const {normalizeCollection}=await import(new URL('lib/providers/normalize.mjs',root));
const {checksum}=await import(new URL('lib/utils.mjs',root));
const {exportPublicReplica,serializePublicReplica}=await import(new URL('lib/public-replica-export.mjs',root));
const {preparePublicReplicaPublication}=await import(new URL('lib/public-replica-sync.mjs',root));
const {readCommittedTargetPublication,preparePublishedSnapshotBaseline,releaseCommittedTargetPublication,
  assertCommittedTargetPublication}=await import(new URL('lib/committed-target-publication.mjs',root));
const oldAt='2026-10-02T01:45:00.000Z',now='2026-10-02T03:30:00.000Z';
async function fixture(t){
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-02T01:00:00.000Z')});
  const database=new MonitorDatabase(':memory:');t.after(()=>database.close());
  const target=database.createTarget({type:'account',label:'Synthetic preserved historical source',locator:'MS4wLjABAAAAPhase97BaselineSynthetic',provider:'public-web',metadata:{platform:'douyin'}});
  const raw=(capturedAt,n)=>({capturedAt,profile:{user:{sec_uid:target.locator,uid:'123456789',follower_count:n,total_favorited:100,aweme_count:0}},works:{aweme_list:[]}});
  const sample=(capturedAt,n)=>database.saveCollection(target,null,normalizeCollection(target,raw(capturedAt,n),{capturedAt}));
  sample('2026-10-02T01:01:00.000Z',10);t.mock.timers.setTime(Date.parse(now));
  const source=serializePublicReplica(exportPublicReplica(database,{asOf:oldAt}));
  const prepared=await preparePublicReplicaPublication(source,{dateIndex:true});
  const expected={asOf:oldAt,manifestSha256:checksum(prepared.manifest)};
  const baseline=await preparePublishedSnapshotBaseline(source,expected);
  return{database,target,source,expected,baseline,sample};
}
test('sealed prior generation retains previously authorized historical daily rows without inventing fresh coverage',async t=>{
  const f=await fixture(t);f.database.db.exec('BEGIN');try{
    const receipt=readCommittedTargetPublication(f.database,{asOf:now,baseline:f.baseline});
    const replica=exportPublicReplica(f.database,{asOf:now,committedPublication:receipt});
    assert.equal(replica.counts.daily,1);assert.equal(replica.catalog.accounts[0].latest.followers.value,10);
    assert.equal(replica.catalog.accounts[0].coverage.profileObservedAt,null);
  }finally{f.database.db.exec('ROLLBACK');}
});
for(const at of ['2026-10-02T02:00:00.000Z','2026-10-02T01:02:00.000Z'])test('new unpaired snapshot id cannot borrow sealed old cap even when backdated: '+at,async t=>{
  const f=await fixture(t);f.sample(at,999);f.database.db.exec('BEGIN');try{
    const receipt=readCommittedTargetPublication(f.database,{asOf:now,baseline:f.baseline});
    const replica=exportPublicReplica(f.database,{asOf:now,committedPublication:receipt});
    assert.equal(replica.catalog.accounts[0].latest.followers.value,10);
  }finally{f.database.db.exec('ROLLBACK');}
});
test('sealed old cap does not bypass existing raw/hash/vector validation',async t=>{
  const f=await fixture(t);f.database.db.prepare('UPDATE snapshots SET followers=999').run();
  f.database.db.exec('BEGIN');try{
    const receipt=readCommittedTargetPublication(f.database,{asOf:now,baseline:f.baseline});
    const replica=exportPublicReplica(f.database,{asOf:now,committedPublication:receipt});
    assert.equal(replica.counts.daily,0);assert.equal(replica.catalog.accounts[0].latest.followers.value,null);
  }finally{f.database.db.exec('ROLLBACK');}
});
test('baseline must match exact last-confirmed generation, complete source bytes and opaque identity',async t=>{
  const f=await fixture(t);
  await assert.rejects(preparePublishedSnapshotBaseline(f.source,{...f.expected,manifestSha256:'0'.repeat(64)}));
  await assert.rejects(preparePublishedSnapshotBaseline(f.source,{...f.expected,asOf:'2026-10-02T01:44:00.000Z'}));
  const altered=structuredClone(f.source);altered.files[0].content+=' ';
  await assert.rejects(preparePublishedSnapshotBaseline(altered,f.expected));
  f.database.db.exec('BEGIN');try{
    assert.throws(()=>readCommittedTargetPublication(f.database,{asOf:now,baseline:{...f.baseline}}));
  }finally{f.database.db.exec('ROLLBACK');}
});
test('explicit revoke prevents same-connection rollback/new-BEGIN token reuse',async t=>{
  const f=await fixture(t);f.database.db.exec('BEGIN');
  const receipt=readCommittedTargetPublication(f.database,{asOf:now,baseline:f.baseline});
  releaseCommittedTargetPublication(receipt);f.database.db.exec('ROLLBACK');f.database.db.exec('BEGIN');
  try{assert.throws(()=>assertCommittedTargetPublication(receipt,f.database,now));}finally{f.database.db.exec('ROLLBACK');}
});
