import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {checksum} from '../lib/utils.mjs';
import {OFFICIAL_DOUYIN_PROFILE_ENDPOINT} from '../lib/official-profile-evidence.mjs';
import {readLatestSourceJobs} from '../lib/table-source-jobs.mjs';
import {readPublicTableFoundation} from '../lib/public-table-foundation.mjs';
import {reconcileSupplementProfileIdentityLinks} from '../lib/reconcile-supplement-profile-links.mjs';
import {reconcileCreatorProfileIdentityLinks} from '../lib/reconcile-creator-profile-links.mjs';
import {readCurrentCreatorSourceLinks} from '../lib/creator-source-current-links.mjs';
import {ensureSupplementProfileLinkSchema,readSupplementProfileIdentityLinks,planSupplementProfileIdentityLinks,SUPPLEMENT_PROFILE_LINK_TABLE} from '../lib/supplement-profile-identity-links.mjs';
import {linkRosterSourceProfiles} from '../lib/roster-profile-links.mjs';
const AT='2026-10-09T12:00:00.000Z',NOW='2026-10-09T15:00:00.000Z',LATER='2026-10-19T15:00:00.000Z';
const SEC='MS4wLjABAAAAStoredSupplementOwner123456';
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`PRAGMA foreign_keys=ON;
  CREATE TABLE creator_source_imports(id INTEGER PRIMARY KEY,source_sha256 TEXT,source_url TEXT,source_revision TEXT,source_modified_at TEXT,imported_at TEXT);
  CREATE TABLE creator_source_rows(import_id INTEGER,sheet_id TEXT,row_number INTEGER,values_json TEXT);
  CREATE TABLE creator_source_account_links(import_id INTEGER,author_row INTEGER,target_id INTEGER,matched_id TEXT,matched_at TEXT);
  CREATE TABLE author_resolution_jobs(id TEXT PRIMARY KEY,status TEXT,request_json TEXT,created_at TEXT,finished_at TEXT);
  CREATE TABLE targets(id INTEGER PRIMARY KEY,type TEXT,provider TEXT,locator TEXT,enabled INTEGER,metadata_json TEXT);
  CREATE TABLE snapshots(id INTEGER PRIMARY KEY,target_id INTEGER,captured_at TEXT,quality_status TEXT,account_status TEXT,source_checksum TEXT,raw_json TEXT);
  CREATE TABLE audits(id INTEGER PRIMARY KEY,target_id INTEGER,run_id INTEGER,created_at TEXT,provider TEXT,status TEXT,source_checksum TEXT);
  CREATE TABLE runs(id INTEGER PRIMARY KEY,target_id INTEGER,started_at TEXT,finished_at TEXT,status TEXT);
  CREATE TABLE account_events(id INTEGER PRIMARY KEY,target_id INTEGER,event_type TEXT,observed_at TEXT,event_json TEXT);
  CREATE TABLE author_resolution_queue(id INTEGER PRIMARY KEY,resolved_target_id INTEGER,suspended_target_enabled INTEGER,status TEXT,last_error TEXT);`);
 db.prepare('INSERT INTO creator_source_imports VALUES(1,?,?,?,?,?)').run('a'.repeat(64),'https://fixture.feishu.cn/sheets/base','1',AT,AT);
 function target(id=1,handle='Example_A',sec=SEC){db.prepare('INSERT INTO targets VALUES(?,?,?,?,?,?)').run(id,'account','public-web',sec,0,
  JSON.stringify({platform:'douyin',douyinId:handle,identityVerification:{accountId:sec},userTag:'keep'}));}
 function sample({id=10,targetId=1,handle='Example_A',sec=SEC,uid='123456789012345',at=AT,missing=false}={}){
  const body={capturedAt:at,profile:{user:{sec_uid:sec,uid,unique_id:handle,short_id:'543211234',nickname:'Not identity evidence'}},
   accountStatus:'validated',accountError:null,works:{aweme_list:[]},provenance:{mode:'guest-ttwid-unsigned-profile-a-bogus-posts',profileMode:'guest-ttwid-unsigned-profile',
    profileEndpoint:OFFICIAL_DOUYIN_PROFILE_ENDPOINT,accountLocator:'sec_uid',cookiePersisted:false,runtimeAI:false,paidAPI:false}};
  if(missing)delete body.profile;
  const hash=checksum(body);db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?,?,?)').run(id,targetId,at,'warning','available',hash,JSON.stringify(body));
  db.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run(id,null,at,at,'warning');
  db.prepare('INSERT INTO audits VALUES(?,?,?,?,?,?,?)').run(id,targetId,id,at,'public-web','warning',hash);
 }
 const row=(handle='Example_A')=>({platform:'douyin',board:'一条小团团切片矩阵',douyinId:handle,name:'submitted name',videoId:'7300000000000000000'});
 function job({id='source-one',revision=1,rows=[row()],at=AT}={}){
  db.prepare('INSERT INTO author_resolution_jobs VALUES(?,?,?,?,?)').run(id,'completed',JSON.stringify({fileName:'fixture.xlsx',sourceUrl:'https://fixture.feishu.cn/sheets/supplement',sourceRevision:revision,rows}),at,at);
 }
 target();sample();job();
 const sources=(at=NOW)=>readLatestSourceJobs(db,at);
 const read=(at=NOW)=>readSupplementProfileIdentityLinks(db,{sources:sources(at),reference:at});
 const reconcile=(options={})=>reconcileSupplementProfileIdentityLinks(db,{clock:()=>NOW,...options});
 const foundation=(at=NOW)=>readPublicTableFoundation(db,at,{rosterAccounts:[],sourceCorpus:{works:[],currentLinks:{accountLinks:[],fingerprint:'fixture'}}});
 return{db,target,sample,row,job,sources,read,reconcile,foundation};
}

function rosterItems(){
 const base={platform:'douyin',theme:{key:'tuantuan',label:'团团'},originalNames:[],sourceLinks:[],sourceTitles:[],evidenceLinks:[],reviewReasons:[],classifications:[],boards:[],sources:[],profileLinks:[]};
 return [{...structuredClone(base),key:'target:1',targetId:1,name:'保留的账号名',monitorStatus:'paused',accountIds:['old-handle']},
  {...structuredClone(base),key:'source:one',targetId:null,name:'来源作者',monitorStatus:'pending',accountIds:['Example_A'],
   creatorSourceRows:[7],creatorSourceAccountIds:['Example_A'],
   sources:[{liveJobId:'source-one',rows:['1']}],classifications:[{key:'slice',label:'切片'}]}];
}
test('canonical roster and public source foundation use the same current profile proof without changing jobs or targets',t=>{
 const f=fixture(t);f.job({id:'current-needs-locator',revision:2,rows:[{...f.row(),status:'needs_locator'}]});
 const items=rosterItems(),before=JSON.stringify(items),jobs=f.db.prepare('SELECT * FROM author_resolution_jobs').all(),targets=f.db.prepare('SELECT * FROM targets').all();
 assert.deepEqual(f.foundation().authors[0].targetIds,[1]);
 const merged=linkRosterSourceProfiles(f.db,items,{reference:NOW});
 assert.equal(merged.linkedEntryCount,1);assert.equal(merged.items.length,1);
 assert.equal(merged.items[0].targetId,1);assert.equal(merged.items[0].monitorStatus,'paused');
 assert.deepEqual(merged.items[0].sources[0].rows,['1']);assert.equal(merged.items[0].classifications[0].key,'slice');
 assert.deepEqual(merged.items[0].creatorSourceRows,[7]);assert.deepEqual(merged.items[0].creatorSourceAccountIds,['Example_A']);
 assert.equal(merged.items[0].linkedSourceEntries[0].proofs[0].submittedWorksVerified,false);
 assert.match(merged.items[0].identityStatus,/来源身份已核验/);
 assert.equal(JSON.stringify(items),before);assert.deepEqual(f.db.prepare('SELECT * FROM author_resolution_jobs').all(),jobs);
 assert.deepEqual(f.db.prepare('SELECT * FROM targets').all(),targets);
});
test('durable source links remain consistent in both projections after expiry, and corrupted source cannot use fresh fallback',t=>{
 const f=fixture(t);f.reconcile();
 assert.deepEqual(f.foundation(LATER).authors[0].targetIds,[1]);
 assert.equal(linkRosterSourceProfiles(f.db,rosterItems(),{reference:LATER}).linkedEntryCount,1);
 const request=JSON.parse(f.db.prepare('SELECT request_json FROM author_resolution_jobs').get().request_json);request.rows[0].name='edited';
 f.db.prepare('UPDATE author_resolution_jobs SET request_json=?').run(JSON.stringify(request));
 assert.equal(linkRosterSourceProfiles(f.db,rosterItems(),{reference:NOW}).linkedEntryCount,0);
 assert.deepEqual(f.foundation().authors[0].targetIds,[]);
});
test('source projection does not override corrected IDs, theme ownership, foreign profile links or ambiguous current profiles',t=>{
 const f=fixture(t);
 for(const change of [{identityCorrection:{status:'pending'}},{theme:{key:'another'}},{profileLinks:['https://www.douyin.com/user/AnotherOwner']}]){
  const items=rosterItems();Object.assign(items[1],change);
  assert.equal(linkRosterSourceProfiles(f.db,items,{reference:NOW}).linkedEntryCount,0);
 }
 f.target(2,'Example_A',SEC+'Other');f.sample({id:20,targetId:2,handle:'Example_A',sec:SEC+'Other'});
 assert.equal(linkRosterSourceProfiles(f.db,rosterItems(),{reference:NOW}).linkedEntryCount,0);
});

test('completed supplementary sources gain durable links without changing raw jobs, targets or work receipts',t=>{
 const f=fixture(t),raw=f.db.prepare('SELECT * FROM author_resolution_jobs').all(),targets=f.db.prepare('SELECT * FROM targets').all();
 assert.deepEqual(f.foundation().authors[0].targetIds,[1]);assert.deepEqual(f.foundation(LATER).authors[0].targetIds,[]);
 assert.equal(f.reconcile().admitted,1);assert.equal(f.reconcile().admitted,0);
 assert.equal(f.read(LATER).accepted,1);assert.deepEqual(f.foundation(LATER).authors[0].targetIds,[1]);
 assert.deepEqual(f.db.prepare('SELECT * FROM author_resolution_jobs').all(),raw);
 assert.deepEqual(f.db.prepare('SELECT * FROM targets').all(),targets);
 assert.equal(f.db.prepare(`SELECT count(*) n FROM ${SUPPLEMENT_PROFILE_LINK_TABLE}`).get().n,1);
});

test('a verified base ID containing a preserved accidental Markdown link also joins the canonical supplementary handle',t=>{
 const f=fixture(t),handle='Ni.De.GIRL_LMZW',rawId='[Ni.De](http://Ni.De).GIRL_LMZW';
 f.db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run('08',2,JSON.stringify(['Source author',rawId]));
 f.sample({id:11,handle});f.job({id:'source-two',revision:2,rows:[f.row(handle)]});
 assert.equal(reconcileCreatorProfileIdentityLinks(f.db,{clock:()=>NOW}).admitted,1);
 const imported=f.db.prepare('SELECT * FROM creator_source_imports').get();
 const currentLinks=readCurrentCreatorSourceLinks(f.db,{imported,reference:LATER});
 assert.equal(currentLinks.accountLinks[0].matched_id,rawId,'raw spelling remains inspectable');
 const projected=readPublicTableFoundation(f.db,LATER,{rosterAccounts:[],sourceCorpus:{works:[],currentLinks}});
 assert.deepEqual(projected.authors.find(author=>author.douyinId===handle).targetIds,[1]);
 assert.equal(f.db.prepare("SELECT values_json FROM creator_source_rows WHERE sheet_id='08'").get().values_json,JSON.stringify(['Source author',rawId]));
});

test('a current source replacement needs its own admission; obsolete receipts never rewrite or validate edited source bytes',t=>{
 const f=fixture(t);f.reconcile();const old=f.db.prepare(`SELECT * FROM ${SUPPLEMENT_PROFILE_LINK_TABLE}`).all();
 const request=JSON.parse(f.db.prepare('SELECT request_json FROM author_resolution_jobs').get().request_json);request.rows[0].name='edited';
 f.db.prepare('UPDATE author_resolution_jobs SET request_json=?').run(JSON.stringify(request));
 assert.equal(f.read().accepted,0);assert.deepEqual(f.foundation().authors[0].targetIds,[],'fresh fallback cannot override a rejected durable receipt');
 f.job({id:'source-two',revision:2});assert.equal(f.read().accepted,0);assert.equal(f.reconcile().admitted,1);
 assert.equal(f.read(LATER).accepted,1);assert.deepEqual(f.db.prepare(`SELECT * FROM ${SUPPLEMENT_PROFILE_LINK_TABLE} WHERE id=?`).get(old[0].id),old[0]);
});

test('later verified UID contradictions survive later missing profiles and cannot be hidden by the freshness fallback',t=>{
 const f=fixture(t);f.reconcile();f.sample({id:11,at:'2026-10-10T12:00:00.000Z',uid:'987654321234567'});
 assert.equal(f.read('2026-10-10T15:00:00.000Z').accepted,0);
 assert.deepEqual(f.foundation('2026-10-10T15:00:00.000Z').authors[0].targetIds,[]);
 f.sample({id:12,at:'2026-10-11T12:00:00.000Z',missing:true});assert.equal(f.read(LATER).accepted,0);
 assert.equal(f.reconcile({clock:()=>LATER}).admitted,0);
});

test('pause, rename and offline expiry preserve admitted canonical identity but never count as fresh samples',t=>{
 const f=fixture(t);f.reconcile();f.db.prepare('UPDATE targets SET enabled=1').run();
 f.sample({id:11,at:'2026-10-10T12:00:00.000Z',handle:'renamed'});
 assert.equal(f.read(LATER).accepted,1);assert.deepEqual(f.foundation(LATER).authors[0].targetIds,[1]);
 const g=fixture(t);assert.equal(g.reconcile({clock:()=>LATER}).admitted,0);
 assert.equal(g.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name=?").get(SUPPLEMENT_PROFILE_LINK_TABLE).n,0);
});

test('real audit/run scoping excludes unrelated batches and only admits committed source jobs',t=>{
 const f=fixture(t);assert.equal(f.reconcile({runId:999}).admitted,0);assert.equal(f.reconcile({runId:10}).admitted,1);
 const g=fixture(t);g.db.prepare("UPDATE author_resolution_jobs SET status='running'").run();assert.equal(g.reconcile().admitted,0);
 g.db.prepare("UPDATE author_resolution_jobs SET status='completed',finished_at='2026-10-20T12:00:00.000Z'").run();assert.equal(g.reconcile().admitted,0);
 assert.throws(()=>{g.db.exec('BEGIN');try{g.reconcile();}finally{g.db.exec('ROLLBACK');}},/committed-boundary/);
});

test('base-author reservations and two submitted handles for one canonical account fail closed',t=>{
 const f=fixture(t);let plan=planSupplementProfileIdentityLinks(f.db,{sources:f.sources(),reference:NOW,baseLinks:[{target_id:1,matched_id:'another_author'}]});
 assert.equal(plan.candidates.length,0);
 const g=fixture(t);g.job({id:'alias-source',revision:2,rows:[g.row(),g.row('543211234')]});
 plan=planSupplementProfileIdentityLinks(g.db,{sources:g.sources(),reference:NOW});assert.equal(plan.candidates.length,0);assert.equal(plan.ambiguousTargetClaims,2);
});

test('batch bounds resume, overlapping work rows never duplicate authors, and a late SQL failure rolls back the batch',t=>{
 const f=fixture(t),sec2=SEC+'Two';f.target(2,'Example_B',sec2);f.sample({id:20,targetId:2,handle:'Example_B',sec:sec2,uid:'222222222222222'});
 f.job({id:'source-two',revision:2,rows:[f.row(),f.row(),f.row('Example_B')]});
 const first=f.reconcile({maxAdmissions:1});assert.equal(first.admitted,1);assert.equal(first.remaining,1);
 assert.equal(f.reconcile({maxAdmissions:1}).admitted,1);assert.equal(f.reconcile().admitted,0);assert.equal(f.read(LATER).accepted,2);
 const g=fixture(t);g.target(2,'Example_B',sec2);g.sample({id:20,targetId:2,handle:'Example_B',sec:sec2,uid:'222222222222222'});
 g.job({id:'source-two',revision:2,rows:[g.row(),g.row('Example_B')]});ensureSupplementProfileLinkSchema(g.db);
 g.db.exec(`CREATE TRIGGER reject_second_supplement BEFORE INSERT ON ${SUPPLEMENT_PROFILE_LINK_TABLE} WHEN NEW.target_id=2 BEGIN SELECT RAISE(ABORT,'fixture-failure');END;`);
 assert.throws(()=>g.reconcile(),/fixture-failure/);assert.equal(g.db.prepare(`SELECT count(*) n FROM ${SUPPLEMENT_PROFILE_LINK_TABLE}`).get().n,0);
});

test('source and proof corruption withdraw current use while the append-only original receipt remains inspectable',t=>{
 for(const fault of ['receipt-hash','snapshot-hash','audit-run','target-anchor','source-status']){
  const f=fixture(t);f.reconcile();const before=f.db.prepare(`SELECT receipt_json FROM ${SUPPLEMENT_PROFILE_LINK_TABLE}`).get().receipt_json;
  if(fault==='receipt-hash')f.db.exec(`UPDATE ${SUPPLEMENT_PROFILE_LINK_TABLE} SET receipt_sha256='bad'`);
  if(fault==='snapshot-hash')f.db.exec("UPDATE snapshots SET source_checksum='bad'");
  if(fault==='audit-run')f.db.exec('UPDATE audits SET run_id=999');
  if(fault==='target-anchor')f.db.exec("UPDATE targets SET metadata_json='{}'");
  if(fault==='source-status')f.db.exec("UPDATE author_resolution_jobs SET status='failed'");
  assert.equal(f.read().accepted,0,fault);
  assert.equal(f.db.prepare(`SELECT receipt_json FROM ${SUPPLEMENT_PROFILE_LINK_TABLE}`).get().receipt_json,before,fault);
 }
});
