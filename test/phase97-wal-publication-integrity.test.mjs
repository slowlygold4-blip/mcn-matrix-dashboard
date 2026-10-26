import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {MonitorDatabase} from '../lib/database.mjs';
import {normalizeCollection} from '../lib/providers/normalize.mjs';
import {exportPublicReplica} from '../lib/public-replica-export.mjs';
import {readCommittedTargetPublication,releaseCommittedTargetPublication,assertCommittedTargetPublication} from '../lib/committed-target-publication.mjs';
import {OFFICIAL_DOUYIN_PROFILE_ENDPOINT} from '../lib/official-profile-evidence.mjs';
test('actual WAL writer commit cannot enter in-flight token/export; fresh same-asOf receipt sees it, released token is invalid',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'phase97-integrity-wal-')),path=join(dir,'synthetic.sqlite');
 const asOf='2026-09-20T12:00:00.000Z';t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-20T00:00:00.000Z')});
 const writer=new MonitorDatabase(path);let reader;
 try{
 const target=writer.createTarget({type:'account',provider:'public-web',label:'Synthetic WAL target',locator:'MS4wLjABAAAAPhase97WALIndependent',metadata:{platform:'douyin'}});
 const runId=writer.beginRun('scheduled',target.id,1);
 const save=(at,n)=>{const raw={capturedAt:at,accountStatus:'validated',accountError:null,profile:{user:{sec_uid:target.locator,uid:'123456789',follower_count:n,total_favorited:100,aweme_count:0}},provenance:{mode:'guest-ttwid-unsigned-profile',profileMode:'guest-ttwid-unsigned-profile',profileEndpoint:OFFICIAL_DOUYIN_PROFILE_ENDPOINT,accountLocator:'sec_uid',cookiePersisted:false,runtimeAI:false,paidAPI:false}};t.mock.timers.setTime(Date.parse(at)+1000);writer.saveCollection(target,runId,{...normalizeCollection(target,raw,{capturedAt:at}),accountStatus:'available'});t.mock.timers.setTime(Date.parse(asOf)+1);};
 save('2026-09-20T01:00:00.000Z',10);reader=new DatabaseSync(path,{readOnly:true});reader.exec('PRAGMA query_only=ON;BEGIN');
 const old=readCommittedTargetPublication(reader,{asOf});assert.equal(old.runningSnapshotCount,1);
 save('2026-09-20T02:00:00.000Z',20);assert.equal(writer.db.prepare('SELECT count(*) n FROM snapshots').get().n,2);
 const replica=exportPublicReplica(reader,{asOf,committedPublication:old});assert.equal(replica.catalog.accounts[0].latest.followers.value,10);assert.equal(reader.prepare('SELECT count(*) n FROM snapshots').get().n,1);
 releaseCommittedTargetPublication(old);reader.exec('ROLLBACK;BEGIN');assert.throws(()=>assertCommittedTargetPublication(old,reader,asOf));
 const fresh=readCommittedTargetPublication(reader,{asOf});assert.equal(fresh.runningSnapshotCount,2);assert.equal(exportPublicReplica(reader,{asOf,committedPublication:fresh}).catalog.accounts[0].latest.followers.value,20);assert.equal(reader.prepare('SELECT total_changes() n').get().n,0);releaseCommittedTargetPublication(fresh);reader.exec('ROLLBACK');
 }finally{reader?.close();writer.close();await rm(dir,{recursive:true,force:true});}
});
