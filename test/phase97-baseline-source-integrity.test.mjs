import test from 'node:test';
import assert from 'node:assert/strict';
import {MonitorDatabase} from '../lib/database.mjs';
import {normalizeCollection} from '../lib/providers/normalize.mjs';
import {checksum} from '../lib/utils.mjs';
import {exportPublicReplica,serializePublicReplica} from '../lib/public-replica-export.mjs';
import {readCommittedTargetPublication,preparePublishedSnapshotBaseline} from '../lib/committed-target-publication.mjs';
import {preparePublicReplicaPublication} from '../lib/public-replica-sync.mjs';
test('old published snapshot cap cannot authorize changed raw bytes with self-consistent new vector/hash and unmatched audit',async t=>{
 const oldAsOf='2026-09-20T01:45:00.000Z',asOf='2026-09-20T03:30:00.000Z',capturedAt='2026-09-20T01:00:00.000Z';
 t.mock.timers.enable({apis:['Date'],now:Date.parse(asOf)+1});
 const database=new MonitorDatabase(':memory:'),db=database.db;t.after(()=>database.close());
 const target=database.createTarget({type:'account',label:'Independent baseline bytes fixture',locator:'MS4wLjABAAAAPhase97IndependentBaseline',provider:'public-web',metadata:{platform:'douyin'}});
 const raw={capturedAt,profile:{user:{sec_uid:target.locator,uid:'123456789',follower_count:10,total_favorited:100,aweme_count:0}}};
 database.saveCollection(target,null,normalizeCollection(target,raw,{capturedAt}));
 const serialized=serializePublicReplica(exportPublicReplica(database,{asOf:oldAsOf}));
 const prepared=await preparePublicReplicaPublication(serialized,{dateIndex:true});
 const baseline=await preparePublishedSnapshotBaseline(serialized,{asOf:oldAsOf,manifestSha256:checksum(prepared.manifest)});
 raw.profile.user.follower_count=999;
 db.prepare('UPDATE snapshots SET raw_json=?,source_checksum=?,followers=999 WHERE target_id=?').run(JSON.stringify(raw),checksum(raw),target.id);
 assert.equal(db.prepare('SELECT count(*) n FROM snapshots s JOIN audits a ON a.target_id=s.target_id AND a.source_checksum=s.source_checksum').get().n,0);
 db.exec('BEGIN');try{const token=readCommittedTargetPublication(db,{asOf,baseline});const replica=exportPublicReplica(db,{asOf,committedPublication:token});assert.equal(token.runningSnapshotCount,0);assert.notEqual(replica.catalog.accounts[0].latest.followers.value,999,'cap is not exact authorization for changed source bytes');}finally{db.exec('ROLLBACK');}
});
