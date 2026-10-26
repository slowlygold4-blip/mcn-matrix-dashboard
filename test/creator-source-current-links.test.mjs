import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readCurrentCreatorSourceLinks, withCreatorSourceLinkSnapshot } from '../lib/creator-source-current-links.mjs';
import { buildAuthorEvidenceRequests, verifyQueuedAuthorEvidence } from '../lib/author-resolution.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const account = 'MS4wLjABAAAACreatorSourceFixture0001', video = '7300000000000000001';
const at = new Date(Date.now()-60_000).toISOString(), before = new Date(Date.parse(at)-1000).toISOString();
function fixture(t, { frozen = false, resolved = true } = {}) {
 const db = new DatabaseSync(':memory:'); t.after(()=>db.close());
 db.exec(`CREATE TABLE creator_source_imports(id INTEGER,source_sha256 TEXT,source_url TEXT,source_revision TEXT,source_modified_at TEXT);
 CREATE TABLE creator_source_rows(import_id INTEGER,sheet_id TEXT,row_number INTEGER,values_json TEXT);
 CREATE TABLE creator_source_account_links(import_id INTEGER,author_row INTEGER,target_id INTEGER,matched_id TEXT,matched_at TEXT);
 CREATE TABLE targets(id INTEGER,type TEXT,provider TEXT,locator TEXT,metadata_json TEXT);
 CREATE TABLE author_resolution_queue(id INTEGER,identity_key TEXT,name TEXT,douyin_id TEXT,account_locator TEXT,
 video_ids_json TEXT,share_urls_json TEXT,status TEXT,evidence_version INTEGER,verification_policy_version INTEGER,
 resolved_target_id INTEGER,lease_owner TEXT,lease_until TEXT,suspended_target_enabled INTEGER,source_metadata_json TEXT);
 CREATE TABLE author_resolution_import_sources(queue_id INTEGER,queue_identity_key TEXT,payload_json TEXT,receipt_sha256 TEXT,observed_at TEXT);
 CREATE TABLE author_resolution_success_receipts(queue_id INTEGER,evidence_version INTEGER,identity_key TEXT,target_id INTEGER,
 platform TEXT,canonical_account_id TEXT,verified_at TEXT,payload_json TEXT,receipt_sha256 TEXT);`);
 const imported={id:1,source_sha256:'a'.repeat(64),source_url:'https://my.feishu.cn/sheets/Source',source_revision:'12',source_modified_at:before};
 db.prepare('INSERT INTO creator_source_imports VALUES(?,?,?,?,?)').run(...Object.values(imported));
 const author=JSON.stringify(['作者','creator_1']), works=[];
 db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run('08',2,author);
 for(let i=0;i<2;i++) { const v=Array(12).fill('');v[0]=String(BigInt(video)+BigInt(i));v[2]='creator_1';v[11]=`https://www.douyin.com/video/${v[0]}`;works.push(JSON.stringify(v));db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run('09',i+2,works[i]); }
 db.prepare('INSERT INTO targets VALUES(10,?,?,?,?)').run('account','public-web',account,JSON.stringify({platform:'douyin',douyinId:'creator_1',identityVerification:{accountId:account}}));
 if(frozen) db.prepare('INSERT INTO creator_source_account_links VALUES(1,2,10,?,?)').run('creator_1',at);
 if(resolved) {
  const request=buildAuthorEvidenceRequests([{name:'作者',douyinId:'creator_1',videoId:video,shareUrl:`https://www.douyin.com/video/${video}`}])[0];
  const verified=verifyQueuedAuthorEvidence(request,{key:request.key,errors:[],candidates:[{videoId:video,sourceEvidenceUrl:request.shareUrls[0],secUid:account,uniqueId:'creator_1',nickname:'公开昵称'}]});
  assert.equal(verified.status,'ready');const resolution={...verified.row.resolution,resolvedAt:at};
  const s={sourceType:'creator-source-sheet',sourceUrl:imported.source_url,sourceRevision:'12',sourceSha256:imported.source_sha256,sourceModifiedAt:before,authorRow:2,workRow:2,authorRowSha256:sha(author),workRowSha256:sha(works[0])};
  const payload=JSON.stringify({sourceRows:[2],sourceMetadata:s});
  db.prepare('INSERT INTO author_resolution_queue VALUES(1,?,?,?,?,?,?,?,1,2,10,NULL,NULL,NULL,?)').run(request.key,'作者','creator_1','',JSON.stringify(request.videoIds),JSON.stringify(request.shareUrls),'resolved',JSON.stringify(s));
  db.prepare('INSERT INTO author_resolution_import_sources VALUES(1,?,?,?,?)').run(request.key,payload,sha(payload),before);
  resolution.authorisedDetailReceipt={format:'mcn-creator-source-authorised-detail-v1',identityOnly:true,equivalentLocatorsForOneWork:true,
    source:{importId:1,sourceReceiptSha256:sha(payload),...s,videoId:video,shareUrl:request.shareUrls[0]},
    queue:{id:1,identityKey:request.key,evidenceVersion:1}};
  const proof={format:'mcn-author-resolution-success-v1',queueId:1,evidenceVersion:1,identityKey:request.key,verificationPolicyVersion:2,targetId:10,platform:'douyin',canonicalAccountId:account,verifiedAt:at,committedAt:at,evidence:{name:'作者',douyinId:'creator_1',accountLocator:'',videoIds:request.videoIds,shareUrls:request.shareUrls},resolution};
  const serialized=JSON.stringify(proof);
  db.prepare('INSERT INTO author_resolution_success_receipts VALUES(1,1,?,10,?,?,?, ?,?)').run(request.key,'douyin',account,at,serialized,sha(serialized));
 }
 return db;
}
test('same source version gains current strict links after a source-bound successful resolution without any source writes',t=>{
 const db=fixture(t),saved=db.prepare('SELECT * FROM author_resolution_success_receipts').get();
 db.exec('DELETE FROM author_resolution_success_receipts');
 const start=readCurrentCreatorSourceLinks(db),beforeChanges=db.prepare('SELECT total_changes() n').get().n;
 assert.equal(start.accountLinks.length,0);assert.equal(db.prepare('SELECT total_changes() n').get().n,beforeChanges);
 db.prepare('INSERT INTO author_resolution_success_receipts VALUES(?,?,?,?,?,?,?,?,?)').run(...Object.values(saved));
 const readChanges=db.prepare('SELECT total_changes() n').get().n;
 const linked=readCurrentCreatorSourceLinks(db);
 assert.equal(linked.accountLinks.length,1);assert.equal(linked.workLinks.length,2);assert.equal(linked.stats.receiptAccepted,1);
 assert.notEqual(linked.fingerprint,start.fingerprint);assert.equal(db.prepare('SELECT total_changes() n').get().n,readChanges);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM creator_source_account_links').get().n,0);
 assert.equal(readCurrentCreatorSourceLinks(db,{reference:before}).accountLinks.length,0,'historical cutoff does not inherit a later verification');
});
test('bare canonical sec_uid frozen links remain valid and source spelling is preserved',t=>{
 const db=fixture(t,{frozen:true,resolved:false});const r=readCurrentCreatorSourceLinks(db);
 assert.equal(r.stats.frozenAccepted,1);assert.equal(r.workLinks.length,2);
 assert.equal(readCurrentCreatorSourceLinks(db,{reference:before}).accountLinks.length,0);
 db.prepare('UPDATE targets SET metadata_json=?').run(JSON.stringify({platform:'douyin',douyinId:'unrelated',identityVerification:{accountId:account}}));
 assert.equal(readCurrentCreatorSourceLinks(db).accountLinks.length,0);
});
test('immutable canonical proof preserves a later public ID rename but not an invalid current identity anchor',t=>{
 const db=fixture(t);
 db.prepare('UPDATE targets SET metadata_json=?').run(JSON.stringify({platform:'douyin',douyinId:'renamed_creator',identityVerification:{accountId:account}}));
 assert.equal(readCurrentCreatorSourceLinks(db).accountLinks.length,1,'a public handle rename does not invalidate proven historical ownership');
 db.prepare('UPDATE targets SET metadata_json=?').run(JSON.stringify({platform:'douyin',douyinId:'renamed_creator',identityVerification:{accountId:'MS4wLjABAAAAOtherAccountFixture0002'}}));
 assert.equal(readCurrentCreatorSourceLinks(db).accountLinks.length,0,'current identity must still refer to the same canonical account');
});
test('only an immutable canonical proof admits a new account before its first profile sample',t=>{
 const db=fixture(t);
 db.prepare('UPDATE targets SET metadata_json=?').run(JSON.stringify({platform:'douyin',douyinId:'creator_1'}));
 assert.equal(readCurrentCreatorSourceLinks(db).accountLinks.length,1);
 const frozen=fixture(t,{frozen:true,resolved:false});
 frozen.prepare('UPDATE targets SET metadata_json=?').run(JSON.stringify({platform:'douyin',douyinId:'creator_1'}));
 assert.equal(readCurrentCreatorSourceLinks(frozen).accountLinks.length,0,'a frozen link alone is not a canonical success receipt');
 db.exec('CREATE TABLE snapshots(target_id INTEGER); INSERT INTO snapshots VALUES(10)');
 assert.equal(readCurrentCreatorSourceLinks(db).accountLinks.length,0,'a later proof cannot silently certify old unanchored profile history');
});
test('a success receipt binds one exact source receipt and import context rather than any matching row',t=>{
 for(const mutate of [p=>delete p.resolution.authorisedDetailReceipt,
   p=>p.resolution.authorisedDetailReceipt.source.sourceReceiptSha256='b'.repeat(64),
   p=>p.resolution.authorisedDetailReceipt.source.importId=2,
   p=>p.resolution.authorisedDetailReceipt.source.workRowSha256='b'.repeat(64)]){
  const db=fixture(t),saved=db.prepare('SELECT payload_json FROM author_resolution_success_receipts').get();
  const p=JSON.parse(saved.payload_json);mutate(p);const serialized=JSON.stringify(p);
  db.prepare('UPDATE author_resolution_success_receipts SET payload_json=?,receipt_sha256=?').run(serialized,sha(serialized));
  assert.equal(readCurrentCreatorSourceLinks(db).accountLinks.length,0);
 }
});
test('tampered source, proof, queue version and current identity cannot attach source metrics to a target',t=>{
 const faults=[
  db=>db.exec("UPDATE author_resolution_import_sources SET receipt_sha256='broken'"),
  db=>db.exec("UPDATE author_resolution_success_receipts SET receipt_sha256='broken'"),
  db=>db.exec("UPDATE author_resolution_queue SET evidence_version=2"),
  db=>db.exec("UPDATE author_resolution_queue SET status='rejected'"),
  db=>db.exec("UPDATE creator_source_rows SET values_json='[\"changed\",\"creator_1\"]' WHERE sheet_id='08'"),
  db=>db.exec("UPDATE targets SET provider='other'"),
  db=>db.exec("UPDATE targets SET locator='MS4wLjABAAAAOtherAccountFixture0002'"),
 ];
 for(const fault of faults){const db=fixture(t);fault(db);assert.equal(readCurrentCreatorSourceLinks(db).accountLinks.length,0);}
});
test('ambiguous strict targets preserve evidence but never select one owner for source works',t=>{
 const db=fixture(t,{frozen:true});const other='MS4wLjABAAAAOtherAccountFixture0002';
 db.prepare('INSERT INTO targets VALUES(11,?,?,?,?)').run('account','public-web',other,JSON.stringify({platform:'douyin',douyinId:'creator_1',identityVerification:{accountId:other}}));
 db.prepare('INSERT INTO creator_source_account_links VALUES(1,2,11,?,?)').run('creator_1',at);
 const r=readCurrentCreatorSourceLinks(db);assert.equal(r.accountLinks.length,0);assert.equal(r.stats.ambiguousAuthors,1);assert.equal(r.workLinks.length,0);
});
test('duplicate submitted source IDs cannot become a new automatic binding',t=>{
 const db=fixture(t);db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run('08',3,JSON.stringify(['同名','creator_1']));
 assert.equal(readCurrentCreatorSourceLinks(db).accountLinks.length,0);
});

test('transaction-scoped proof reuse expires after local writes and after the export',t=>{
 const db=fixture(t,{frozen:true,resolved:false});
 try {
  db.exec('BEGIN');
  const options={reference:at};
  let cached;
  withCreatorSourceLinkSnapshot(db,()=>{
   cached=readCurrentCreatorSourceLinks(db,options);
   assert.equal(readCurrentCreatorSourceLinks(db,options),cached);
   db.exec('DELETE FROM creator_source_account_links');
   const changed=readCurrentCreatorSourceLinks(db,options);
   assert.notEqual(changed,cached);assert.equal(changed.accountLinks.length,0);
  });
  assert.notEqual(readCurrentCreatorSourceLinks(db,options),cached);
  db.exec('ROLLBACK');
  assert.equal(readCurrentCreatorSourceLinks(db,options).accountLinks.length,1);
 } finally {if(db.isTransaction)db.exec('ROLLBACK');}
});
