import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {MonitorDatabase} from '../lib/database.mjs';
import {normalizeCollection} from '../lib/providers/normalize.mjs';
import {checksum} from '../lib/utils.mjs';
import {exportPublicReplica,serializePublicReplica,PUBLIC_REPLICA_EXPORT_REVISION} from '../lib/public-replica-export.mjs';
import {preparePublicReplicaPublication} from '../lib/public-replica-sync.mjs';
import {readPublicReplicaStaging} from '../lib/public-replica-staging-reader.mjs';
import {preparePublishedSnapshotBaseline,preparePublishedSnapshotBaselineFromDirectory,
  readCommittedTargetPublication,releaseCommittedTargetPublication} from '../lib/committed-target-publication.mjs';

async function fixture(t){
  const dataDir=await mkdtemp(join(tmpdir(),'mcn-baseline-isolate-'));
  const db=new MonitorDatabase(':memory:');
  t.after(async()=>{db.close();await rm(dataDir,{recursive:true,force:true});});
  const asOf=new Date().toISOString(),at=new Date(Date.parse(asOf)-60_000).toISOString();
  const target=db.createTarget({type:'account',provider:'public-web',label:'synthetic old history',
    locator:'MS4wLjABAAAASyntheticBaselineWorker',metadata:{platform:'douyin'}});
  const raw={capturedAt:at,profile:{user:{sec_uid:target.locator,uid:'123456789',follower_count:0,total_favorited:100,aweme_count:0}},works:{aweme_list:[]}};
  db.saveCollection(target,null,normalizeCollection(target,raw,{capturedAt:at}));
  const source=serializePublicReplica(exportPublicReplica(db,{asOf}));
  const prepared=await preparePublicReplicaPublication(source,{dateIndex:true});
  const expected={asOf,manifestSha256:checksum(prepared.manifest),exportRevision:PUBLIC_REPLICA_EXPORT_REVISION};
  const directory=join(dataDir,'public-replica-staging','publisher-fixture');
  await mkdir(directory,{recursive:true});
  await writeFile(join(directory,'manifest.json'),JSON.stringify(source.manifest));
  for(const file of source.files){const path=join(directory,file.path);await mkdir(dirname(path),{recursive:true});await writeFile(path,file.content);}
  return {dataDir,directory,source,expected,db,target};
}
function projected(f,baseline){
  f.db.db.exec('BEGIN');let receipt;
  try{
    receipt=readCommittedTargetPublication(f.db,{asOf:new Date().toISOString(),baseline});
    const result=exportPublicReplica(f.db,{asOf:receipt.asOf,committedPublication:receipt});
    return {daily:result.partitions.filter(p=>p.kind==='daily').flatMap(p=>p.items),
      followers:result.catalog.accounts[0].latest.followers,coverage:result.catalog.accounts[0].coverage};
  }finally{if(receipt)releaseCommittedTargetPublication(receipt);f.db.db.exec('ROLLBACK');}
}
test('real disposable baseline worker preserves exact history, genuine zero and coverage without writes',async t=>{
  const f=await fixture(t),before=await readFile(join(f.directory,'manifest.json'));
  const inline=await preparePublishedSnapshotBaseline(f.source,f.expected);
  const isolated=await preparePublishedSnapshotBaselineFromDirectory(f.directory,{...f.expected,dataDir:f.dataDir});
  assert.deepEqual(isolated,inline);assert.ok(Object.isFrozen(isolated));
  assert.deepEqual(projected(f,isolated),projected(f,inline));
  assert.equal(projected(f,isolated).followers.value,0);
  assert.equal(projected(f,isolated).coverage.profileObservedAt,null,'old accepted history is not fresh collection');
  assert.deepEqual(await readFile(join(f.directory,'manifest.json')),before);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM snapshots').get().n,1);
  f.db.db.exec('BEGIN');try{assert.throws(()=>readCommittedTargetPublication(f.db,{asOf:new Date().toISOString(),baseline:{...isolated}}));}
  finally{f.db.db.exec('ROLLBACK');}
});
test('worker does not let newly inserted backdated snapshots borrow the verified generation cap',async t=>{
  const f=await fixture(t),baseline=await preparePublishedSnapshotBaselineFromDirectory(f.directory,{...f.expected,dataDir:f.dataDir});
  const old=f.db.db.prepare('SELECT * FROM snapshots').get();
  const raw=JSON.parse(old.raw_json);raw.profile.user.follower_count=999;raw.capturedAt=new Date(Date.parse(old.captured_at)+1000).toISOString();
  f.db.db.prepare('INSERT INTO snapshots(target_id,captured_at,followers,total_likes,total_posts,quality_status,raw_json,source_checksum,account_status) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(f.target.id,raw.capturedAt,999,100,0,'validated',JSON.stringify(raw),checksum(raw),'available');
  assert.equal(projected(f,baseline).followers.value,0);
});
test('worker verifies source bytes and exact published hash, never just the manifest metadata',async t=>{
  const f=await fixture(t),options={...f.expected,dataDir:f.dataDir};
  await assert.rejects(preparePublishedSnapshotBaselineFromDirectory(f.directory,{...options,manifestSha256:'0'.repeat(64)}));
  const file=f.source.files.find(p=>p.kind==='daily');
  await writeFile(join(f.directory,file.path),file.content+' ');
  await assert.rejects(preparePublishedSnapshotBaselineFromDirectory(f.directory,options),{message:'invalid-committed-target-publication'});
});
test('worker rejects changed counters with resealed file hashes and incomplete summary relationships',async t=>{
  const f=await fixture(t),file=f.source.files.find(p=>p.kind==='daily'),part=JSON.parse(file.content);
  part.items[0].followers=999;file.content=JSON.stringify(part);file.sha256=checksum(part);file.bytes=Buffer.byteLength(file.content);
  const meta=f.source.manifest.files.find(p=>p.path===file.path);Object.assign(meta,{sha256:file.sha256,bytes:file.bytes});
  await writeFile(join(f.directory,file.path),file.content);await writeFile(join(f.directory,'manifest.json'),JSON.stringify(f.source.manifest));
  await assert.rejects(preparePublishedSnapshotBaselineFromDirectory(f.directory,{...f.expected,dataDir:f.dataDir}));
});
test('abort and finite deadline stop actual workers before returning and do not admit a capability',async t=>{
  const f=await fixture(t),options={...f.expected,dataDir:f.dataDir},cancel=new AbortController();cancel.abort();
  await assert.rejects(preparePublishedSnapshotBaselineFromDirectory(f.directory,{...options,signal:cancel.signal}));
  const during=new AbortController(),request=preparePublishedSnapshotBaselineFromDirectory(f.directory,{...options,signal:during.signal});
  during.abort();await assert.rejects(request);
  await assert.rejects(preparePublishedSnapshotBaselineFromDirectory(f.directory,{...options,timeoutMs:1}));
  for(const timeoutMs of [0,300001,Infinity])await assert.rejects(preparePublishedSnapshotBaselineFromDirectory(f.directory,{...options,timeoutMs}));
});
test('shared staged reader rejects outside directories, traversal, file and directory symlinks',async t=>{
  const f=await fixture(t),options={dataDir:f.dataDir};
  assert.deepEqual(await readPublicReplicaStaging(f.directory,options),f.source);
  await assert.rejects(readPublicReplicaStaging(f.dataDir,options));
  const alias=join(f.dataDir,'public-replica-staging','alias');await symlink(f.directory,alias);
  await assert.rejects(readPublicReplicaStaging(alias,options));
  const file=f.source.files.find(p=>p.kind==='daily'),path=join(f.directory,file.path);
  await rm(path);await symlink(join(f.directory,'catalog.json'),path);
  await assert.rejects(readPublicReplicaStaging(f.directory,options));
  await writeFile(join(f.directory,'manifest.json'),JSON.stringify({...f.source.manifest,files:[{path:'../../outside.json'}]}));
  await assert.rejects(readPublicReplicaStaging(f.directory,options));
});
test('existing nested stages remain readable but no ancestor may redirect outside the staged tree',async t=>{
  const f=await fixture(t),options={dataDir:f.dataDir};
  const nested=join(f.dataDir,'public-replica-staging','retained','generation');
  await cp(f.directory,nested,{recursive:true});
  assert.deepEqual(await readPublicReplicaStaging(nested,options),f.source);
  const alias=join(f.dataDir,'public-replica-staging','linked-parent');
  await symlink(dirname(nested),alias);
  await assert.rejects(readPublicReplicaStaging(join(alias,'generation'),options));
});
