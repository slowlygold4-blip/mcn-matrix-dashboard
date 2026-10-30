import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {checksum} from '../lib/utils.mjs';
import {OFFICIAL_DOUYIN_PROFILE_ENDPOINT} from '../lib/official-profile-evidence.mjs';
import {readCurrentCreatorSourceLinks} from '../lib/creator-source-current-links.mjs';
import {ensureCreatorProfileLinkSchema,CREATOR_PROFILE_LINK_TABLE} from '../lib/creator-profile-identity-links.mjs';
import {reconcileCreatorProfileIdentityLinks} from '../lib/reconcile-creator-profile-links.mjs';
import {readUnifiedPublicationWorks} from '../lib/creator-source-operating-view.mjs';

const AT='2026-10-09T12:00:00.000Z',NOW='2026-10-09T15:00:00.000Z',LATER='2026-10-19T15:00:00.000Z';
const SEC='MS4wLjABAAAAStoredProfileIdentityOwner12345',OTHER='MS4wLjABAAAAStoredProfileIdentityOther12345';
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`PRAGMA foreign_keys=ON;
  CREATE TABLE creator_source_imports(id INTEGER PRIMARY KEY,source_sha256 TEXT,source_url TEXT,source_revision TEXT,source_modified_at TEXT,imported_at TEXT);
  CREATE TABLE creator_source_rows(import_id INTEGER,sheet_id TEXT,row_number INTEGER,values_json TEXT);
  CREATE TABLE creator_source_account_links(import_id INTEGER,author_row INTEGER,target_id INTEGER,matched_id TEXT,matched_at TEXT);
  CREATE TABLE targets(id INTEGER PRIMARY KEY,type TEXT,provider TEXT,locator TEXT,enabled INTEGER,metadata_json TEXT);
  CREATE TABLE snapshots(id INTEGER PRIMARY KEY,target_id INTEGER,captured_at TEXT,quality_status TEXT,account_status TEXT,source_checksum TEXT,raw_json TEXT);
  CREATE TABLE audits(id INTEGER PRIMARY KEY,target_id INTEGER,run_id INTEGER,created_at TEXT,provider TEXT,status TEXT,source_checksum TEXT);
  CREATE TABLE runs(id INTEGER PRIMARY KEY,target_id INTEGER,started_at TEXT,finished_at TEXT,status TEXT);
  CREATE TABLE account_events(id INTEGER PRIMARY KEY,target_id INTEGER,event_type TEXT,observed_at TEXT,event_json TEXT);
  CREATE TABLE author_resolution_queue(id INTEGER PRIMARY KEY,resolved_target_id INTEGER,suspended_target_enabled INTEGER,status TEXT,last_error TEXT);`);
 db.prepare('INSERT INTO creator_source_imports VALUES(1,?,?,?,?,?)').run('a'.repeat(64),'https://fixture.feishu.cn/sheets/test','1',AT,AT);
 db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run('08',2,JSON.stringify(['原作者','Example_A']));
 db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run('09',2,JSON.stringify(['7300000000000000000','原作者','Example_A']));
 db.prepare('INSERT INTO targets VALUES(1,?,?,?,?,?)').run('account','public-web',SEC,0,JSON.stringify({platform:'douyin',douyinId:'Example_A',identityVerification:{accountId:SEC},userTag:'保留'}));
 const raw={capturedAt:AT,profile:{user:{sec_uid:SEC,uid:'123456789012345',unique_id:'Example_A',short_id:'543211234',nickname:'名字不作证据'}},
  accountStatus:'validated',accountError:null,works:{aweme_list:[]},provenance:{mode:'guest-ttwid-unsigned-profile-a-bogus-posts',profileMode:'guest-ttwid-unsigned-profile',
   profileEndpoint:OFFICIAL_DOUYIN_PROFILE_ENDPOINT,accountLocator:'sec_uid',cookiePersisted:false,runtimeAI:false,paidAPI:false}};
 function sample(raw,{targetId=1,snapshotId=10,auditId=20,runId=30,at=AT}={}){
  const body={...structuredClone(raw),capturedAt:at},digest=checksum(body);
  db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?,?,?)').run(snapshotId,targetId,at,'warning','available',digest,JSON.stringify(body));
  db.prepare('INSERT INTO audits VALUES(?,?,?,?,?,?,?)').run(auditId,targetId,runId,at,'public-web','warning',digest);
  db.prepare('INSERT OR IGNORE INTO runs VALUES(?,?,?,?,?)').run(runId,null,at,at,'warning');
 }
 sample(raw);
 const imported=()=>db.prepare('SELECT * FROM creator_source_imports WHERE id=1').get();
 const read=(at=NOW)=>readCurrentCreatorSourceLinks(db,{imported:imported(),reference:at});
 const reconcile=(options={})=>reconcileCreatorProfileIdentityLinks(db,{clock:()=>NOW,...options});
 return {db,raw,sample,read,reconcile,imported};
}

test('official profile evidence admits an append-only source relationship without enabling, sampling or author-video receipts',t=>{
 const f=fixture(t),{db}=f,beforeTargets=db.prepare('SELECT * FROM targets').all(),beforeSource=db.prepare('SELECT * FROM creator_source_rows').all();
 assert.equal(f.read().accountLinks.length,0);
 const result=f.reconcile();assert.equal(result.status,'admitted');assert.equal(result.admitted,1);assert.equal(result.platformRequests,0);assert.equal(result.modelCalls,0);
 const links=f.read();assert.equal(links.accountLinks.length,1);assert.equal(links.accountLinks[0].origin,'stored-profile-identity-receipt');
 assert.equal(links.workLinks[0].target_id,1,'作品声明仍须后续独立核验原生作者，不伪造作品成功回执');
 assert.deepEqual(db.prepare('SELECT * FROM targets').all(),beforeTargets);assert.deepEqual(db.prepare('SELECT * FROM creator_source_rows').all(),beforeSource);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM snapshots').get().n,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM creator_source_account_links').get().n,0);
 const receipt=db.prepare(`SELECT * FROM ${CREATOR_PROFILE_LINK_TABLE}`).get(),body=JSON.parse(receipt.receipt_json);
 assert.equal(receipt.receipt_sha256,hash(receipt.receipt_json));assert.equal(body.profile.identityOnly,true);assert.equal(body.profile.submittedWorksVerified,false);
 assert.equal(body.source.authorRowSha256,hash(beforeSource[0].values_json));
 assert.equal(f.reconcile().admitted,0);assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${CREATOR_PROFILE_LINK_TABLE}`).get().n,1,'日常重试不堆积重复关系');
});

test('admitted relationships survive offline expiry and account pause/rename; admission itself remains limited to a fresh real sample',t=>{
 const f=fixture(t);f.reconcile();
 assert.equal(f.read(LATER).accountLinks.length,1);
 f.db.prepare('UPDATE targets SET enabled=1,metadata_json=?').run(JSON.stringify({platform:'douyin',douyinId:'renamed',identityVerification:{accountId:SEC}}));
 const renamed=structuredClone(f.raw);renamed.profile.user.unique_id='renamed';f.sample(renamed,{snapshotId:11,auditId:21,runId:31,at:'2026-10-10T12:00:00.000Z'});
 assert.equal(f.read(LATER).accountLinks.length,1,'canonical UID相同的改名不删除已确认历史身份');
 assert.equal(f.read('2026-10-09T14:59:59.000Z').accountLinks.length,0,'尚未准入时不能回填历史关系');
 const g=fixture(t);assert.equal(g.reconcile({clock:()=>LATER}).admitted,0);assert.equal(g.read(LATER).accountLinks.length,0);
});

test('a renamed account retains canonical native work adoption without weakening raw work-author checks',t=>{
 const f=fixture(t);f.reconcile();
 f.db.prepare('UPDATE targets SET metadata_json=?').run(JSON.stringify({platform:'douyin',douyinId:'renamed',identityVerification:{accountId:SEC}}));
 f.db.exec(`CREATE TABLE posts(id INTEGER PRIMARY KEY,target_id INTEGER,external_id TEXT,author_id TEXT,first_seen_at TEXT,last_seen_at TEXT,raw_json TEXT,published_at TEXT,caption TEXT,url TEXT);
 CREATE TABLE post_metrics(id INTEGER PRIMARY KEY,post_id INTEGER,captured_at TEXT,likes INTEGER,plays INTEGER);`);
 const id='7300000000000000000';
 f.db.prepare('INSERT INTO posts VALUES(1,1,?,?,?,?,?,?,?,?)').run(id,SEC,AT,AT,JSON.stringify({aweme_id:id,author:{sec_uid:SEC}}),AT,'真实作品','https://www.douyin.com/video/'+id);
 f.db.prepare('INSERT INTO post_metrics VALUES(1,1,?,?,NULL)').run(AT,7);
 assert.equal(readUnifiedPublicationWorks(f.db,LATER,{includeMetrics:true}).find(work=>work.contentId===id).latestLikes,7);
 f.db.prepare('UPDATE posts SET raw_json=?').run(JSON.stringify({aweme_id:id,author:{sec_uid:OTHER}}));
 assert.equal(readUnifiedPublicationWorks(f.db,LATER,{includeMetrics:true}).find(work=>work.contentId===id).latestLikes,null,'官方主页证明不能替代该作品自己的原生作者证明');
});

test('a later genuine UID contradiction remains a hold even after that newer profile gets older than 24 hours',t=>{
 const f=fixture(t);f.reconcile();const changed=structuredClone(f.raw);changed.profile.user.uid='987654321234567';changed.profile.user.unique_id='renamed';
 f.sample(changed,{snapshotId:11,auditId:21,runId:31,at:'2026-10-10T12:00:00.000Z'});
 assert.equal(f.read(LATER).accountLinks.length,0);
 const failed=structuredClone(f.raw);delete failed.profile;
 f.sample(failed,{snapshotId:12,auditId:22,runId:32,at:'2026-10-11T12:00:00.000Z'});
 assert.equal(f.read(LATER).accountLinks.length,0,'a later missing profile cannot hide a previously verified UID contradiction');
});

test('a newer lifecycle deletion blocks admission of old evidence but does not erase a historical admitted identity',t=>{
 const f=fixture(t);f.reconcile();f.db.exec(`INSERT INTO account_events VALUES(1,1,'lifecycle','2026-10-10T12:00:00.000Z','{"status":"deleted"}')`);
 assert.equal(f.read(LATER).accountLinks.length,1);
 const g=fixture(t);g.db.exec(`INSERT INTO account_events VALUES(1,1,'lifecycle','2026-10-09T13:00:00.000Z','{"status":"deleted"}')`);
 assert.equal(g.reconcile().admitted,0);
});

test('source edits, source version changes, checksum/audit/run corruption and explicit holds revoke current use without rewriting the receipt',t=>{
 for(const fault of ['source-row','source-sha','source-revision','source-url','receipt-hash','receipt-proof','snapshot-hash','audit-run','target-anchor','hold']){
  const f=fixture(t);f.reconcile();const saved=f.db.prepare(`SELECT receipt_json FROM ${CREATOR_PROFILE_LINK_TABLE}`).get().receipt_json;
  if(fault==='source-row')f.db.exec(`UPDATE creator_source_rows SET values_json='["changed","Example_A"]' WHERE sheet_id='08'`);
  if(fault==='source-sha')f.db.prepare('UPDATE creator_source_imports SET source_sha256=?').run('b'.repeat(64));
  if(fault==='source-revision')f.db.exec("UPDATE creator_source_imports SET source_revision='2'");
  if(fault==='source-url')f.db.exec("UPDATE creator_source_imports SET source_url='changed'");
  if(fault==='receipt-hash')f.db.exec(`UPDATE ${CREATOR_PROFILE_LINK_TABLE} SET receipt_sha256='bad'`);
  if(fault==='receipt-proof'){
   const body=JSON.parse(saved);body.profile.canonicalAccountId=OTHER;const json=JSON.stringify(body);
   f.db.prepare(`UPDATE ${CREATOR_PROFILE_LINK_TABLE} SET receipt_json=?,receipt_sha256=?`).run(json,hash(json));
  }
  if(fault==='snapshot-hash')f.db.exec("UPDATE snapshots SET raw_json='{}'");
  if(fault==='audit-run')f.db.exec('UPDATE audits SET run_id=99');
  if(fault==='target-anchor')f.db.prepare('UPDATE targets SET metadata_json=?').run(JSON.stringify({platform:'douyin',identityVerification:{accountId:OTHER}}));
  if(fault==='hold')f.db.exec(`INSERT INTO author_resolution_queue VALUES(1,1,0,'retry','作者身份冲突')`);
  assert.equal(f.read().accountLinks.length,0,fault);
  if(!fault.startsWith('receipt-'))assert.equal(f.db.prepare(`SELECT receipt_json FROM ${CREATOR_PROFILE_LINK_TABLE}`).get().receipt_json,saved,fault);
 }
});

test('duplicate source identifiers and duplicate target claims fail closed; prior source bindings are never stolen',t=>{
 const f=fixture(t);f.db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run('08',3,JSON.stringify(['重复ID','Example_A']));
 assert.equal(f.reconcile().admitted,0);
 const g=fixture(t);g.db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run('08',3,JSON.stringify(['同账号不同公开ID','543211234']));
 assert.equal(g.reconcile().admitted,0,'unique_id与short_id不能偷偷绑定两位不同原作者');
 const h=fixture(t);h.db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run('08',3,JSON.stringify(['已绑定作者','owner_b']));
 h.db.prepare('UPDATE targets SET metadata_json=?').run(JSON.stringify({platform:'douyin',douyinId:'owner_b',identityVerification:{accountId:SEC}}));
 h.db.prepare('INSERT INTO creator_source_account_links VALUES(1,3,1,?,?)').run('owner_b',AT);
 assert.equal(h.reconcile().admitted,0);assert.equal(h.read().accountLinks[0].author_row,3);
});

test('batch reconciliation isolates a committed run and rechecks proof changes before atomic commit',t=>{
 const f=fixture(t);assert.equal(f.reconcile({runId:99}).status,'no-profile-evidence');assert.equal(f.reconcile({runId:30}).admitted,1);
 const g=fixture(t);let clocks=0;
 const result=g.reconcile({clock:()=>{if(++clocks===2)g.db.exec("UPDATE snapshots SET raw_json='{}'");return NOW;}});
 assert.equal(result.status,'evidence-changed');assert.equal(g.read().accountLinks.length,0);
 assert.equal(g.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name=?").get(CREATOR_PROFILE_LINK_TABLE).n,0,'拒绝后不创建半成品关系表');
});

test('invalid source ID types, source digests and uncommitted transaction boundaries never gain identity authority',t=>{
 for(const value of [Number.MAX_SAFE_INTEGER+1,1.5,true,null,'0','名字不作证据']){
  const f=fixture(t);f.db.prepare("UPDATE creator_source_rows SET values_json=? WHERE sheet_id='08'").run(JSON.stringify(['名字',value]));
  assert.equal(f.reconcile().admitted,0,String(value));
 }
 const f=fixture(t);f.db.exec("UPDATE creator_source_imports SET source_sha256='not-a-sha'");assert.equal(f.reconcile().admitted,0);
 const g=fixture(t);g.db.exec('BEGIN');assert.throws(()=>g.reconcile(),/committed-boundary/);g.db.exec('ROLLBACK');
});

test('exact XLSX integer IDs are normalized without changing source cells; unsafe or non-integer cells remain unknown',t=>{
 const f=fixture(t),values=JSON.stringify(['数字单元格作者',543211234]);
 f.db.prepare("UPDATE creator_source_rows SET values_json=? WHERE sheet_id='08'").run(values);
 const result=f.reconcile();assert.equal(result.admitted,1);
 const receipt=f.db.prepare(`SELECT receipt_json FROM ${CREATOR_PROFILE_LINK_TABLE}`).get();
 assert.equal(JSON.parse(receipt.receipt_json).profile.matchedField,'short_id');
 assert.equal(f.read().accountLinks[0].matched_id,'543211234');
 assert.equal(f.db.prepare("SELECT values_json FROM creator_source_rows WHERE sheet_id='08'").get().values_json,values);
 assert.equal(f.read(LATER).accountLinks.length,1);assert.equal(f.reconcile().admitted,0);
});

function secondAuthor(f){
 f.db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run('08',3,JSON.stringify(['另一作者','Example_B']));
 f.db.prepare('INSERT INTO targets VALUES(2,?,?,?,?,?)').run('account','public-web',OTHER,1,JSON.stringify({platform:'douyin',douyinId:'Example_B',identityVerification:{accountId:OTHER}}));
 const raw=structuredClone(f.raw);raw.profile.user.sec_uid=OTHER;raw.profile.user.uid='987654321234567';raw.profile.user.unique_id='Example_B';raw.profile.user.short_id='987654321';
 f.sample(raw,{targetId:2,snapshotId:11,auditId:21,runId:31});
}
test('a later SQL failure rolls back every new receipt in the batch and retains all old evidence',t=>{
 const f=fixture(t);secondAuthor(f);ensureCreatorProfileLinkSchema(f.db);
 f.db.exec(`CREATE TRIGGER reject_second_profile_receipt BEFORE INSERT ON ${CREATOR_PROFILE_LINK_TABLE}
  WHEN NEW.author_row=3 BEGIN SELECT RAISE(ABORT,'fixture-second-receipt-failure'); END`);
 const targets=f.db.prepare('SELECT * FROM targets ORDER BY id').all();
 assert.throws(()=>f.reconcile(),/fixture-second-receipt-failure/);
 assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${CREATOR_PROFILE_LINK_TABLE}`).get().n,0);
 assert.deepEqual(f.db.prepare('SELECT * FROM targets ORDER BY id').all(),targets);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM snapshots').get().n,2);
});
test('bounded reconciliation reports remaining work and resumes idempotently without skipping the second author',t=>{
 const f=fixture(t);secondAuthor(f);
 const first=f.reconcile({maxAdmissions:1});assert.equal(first.admitted,1);assert.equal(first.remaining,1);
 const second=f.reconcile({maxAdmissions:1});assert.equal(second.admitted,1);assert.equal(second.remaining,0);
 assert.equal(f.reconcile({maxAdmissions:1}).admitted,0);assert.equal(f.read().accountLinks.length,2);
});
