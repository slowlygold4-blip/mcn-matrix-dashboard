import test from 'node:test';import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';import {createHash} from 'node:crypto';import * as XLSX from '@e965/xlsx';
import {checksum} from '../lib/utils.mjs';import {OFFICIAL_DOUYIN_PROFILE_ENDPOINT} from '../lib/official-profile-evidence.mjs';
import {commitWorkSourceEdition,readWorkSourceEditions,readKnownWorkSourceFacts} from '../lib/work-source-store.mjs';
import {readCreatorSourceUIDEvidence} from '../lib/creator-source-uid-evidence.mjs';
import {readCurrentCreatorSourceLinks,projectCanonicalCreatorLinks} from '../lib/creator-source-current-links.mjs';
import {reconcileCreatorProfileIdentityLinks} from '../lib/reconcile-creator-profile-links.mjs';
import {CREATOR_PROFILE_LINK_TABLE} from '../lib/creator-profile-identity-links.mjs';
import {corpus} from '../lib/creator-source-corpus.mjs';
import {creatorSourcePartitions} from '../lib/public-creator-source.mjs';
import {creatorPartValid,auditCreatorPublication} from '../lib/replica-creator.mjs';
import {tableFoundationPartitions} from '../lib/public-table-foundation.mjs';
import {foundationPartValid,auditFoundationPublication} from '../lib/replica-foundation.mjs';
import {readSourceProfileTargets} from '../lib/source-profile-targets.mjs';
const AT='2026-10-09T12:00:00.000Z',NOW='2026-10-09T15:00:00.000Z',LATER='2026-10-19T15:00:00.000Z';
const SEC='MS4wLjABAAAAUIDSourceIdentityOwner12345',UID='7462321330400166937',A='7300000000000000000',B='7300000000000000001';
const hash=s=>createHash('sha256').update(s).digest('hex');
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
 for(const [row,id]of [[2,'Example_A'],[3,UID]])db.prepare("INSERT INTO creator_source_rows VALUES(1,'08',?,?)").run(row,JSON.stringify(['来源名字'+row,id,id,0,0,0,0,1]));
 for(const [row,id,owner]of [[2,A,'Example_A'],[3,B,UID]])db.prepare("INSERT INTO creator_source_rows VALUES(1,'09',?,?)").run(row,JSON.stringify([id,'来源名字'+row,owner,'2026-10-09','video','切片激励','切片激励',20,5,'','作品','https://www.douyin.com/video/'+id]));
 db.prepare('INSERT INTO targets VALUES(1,?,?,?,?,?)').run('account','public-web',SEC,0,JSON.stringify({platform:'douyin',douyinId:'Example_A',identityVerification:{accountId:SEC},userTag:'保留'}));
 db.prepare('INSERT INTO creator_source_account_links VALUES(1,2,1,?,?)').run('Example_A',AT);
 const raw={capturedAt:AT,profile:{user:{sec_uid:SEC,uid:UID,unique_id:'Example_A',short_id:'543211234',nickname:'不按名称匹配'}},accountStatus:'validated',accountError:null,works:{aweme_list:[]},provenance:{mode:'guest-ttwid-unsigned-profile-a-bogus-posts',profileMode:'guest-ttwid-unsigned-profile',profileEndpoint:OFFICIAL_DOUYIN_PROFILE_ENDPOINT,accountLocator:'sec_uid',cookiePersisted:false,runtimeAI:false,paidAPI:false}};
 db.prepare('INSERT INTO snapshots VALUES(10,1,?,?,?,?,?)').run(AT,'warning','available',checksum(raw),JSON.stringify(raw));
 db.prepare("INSERT INTO audits VALUES(20,1,30,?,'public-web','warning',?)").run(AT,checksum(raw));
 db.prepare("INSERT INTO runs VALUES(30,NULL,?,?,'warning')").run(AT,AT);
 const workbook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([['视频id','作者UID','点赞数','发布时间'],[B,UID,5,'2026-10-09']]),'原始作品');
 const before={url:'https://fixture.feishu.cn/sheets/UIDWorkbook123456?sheet=abcdef',revision:1,modifiedAt:AT,title:'原始作品',sheets:[{id:'one',name:'原始作品',region:'A1:D2'}]};
 commitWorkSourceEdition(db,{buffer:XLSX.write(workbook,{type:'buffer',bookType:'xlsx'}),before,after:structuredClone(before),readAt:AT},{now:()=>Date.parse(AT)});
 const laterSource=(id)=>{
  const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['视频id','作者UID','点赞数','发布时间'],...(id===null?[]:[[B,id,5,'2026-10-09']])]),'原始作品');
  const metadata={...before,revision:2,sheets:[{id:'one',name:'原始作品',region:id===null?'A1:D1':'A1:D2'}]};
  commitWorkSourceEdition(db,{buffer:XLSX.write(book,{type:'buffer',bookType:'xlsx'}),before:metadata,after:structuredClone(metadata),readAt:'2026-10-10T12:00:00.000Z'},{now:()=>Date.parse('2026-10-10T12:00:00.000Z')});
 };
 return {db,raw,laterSource,reconcile:()=>reconcileCreatorProfileIdentityLinks(db,{clock:()=>NOW}),read:(at=NOW)=>readCurrentCreatorSourceLinks(db,{reference:at})};
}
test('explicit source UID becomes a durable alias of one existing account; all works and source rows retained without double counting',async t=>{
 const f=fixture(t),before=f.db.prepare('SELECT * FROM targets').all(),rows=f.db.prepare('SELECT * FROM creator_source_rows').all();
 assert.equal(f.read().accountLinks.length,1);assert.equal(f.reconcile().admitted,1);
 const links=f.read();assert.equal(links.accountLinks.length,2);assert.equal(new Set(links.accountLinks.map(r=>r.target_id)).size,1);
 assert.equal(links.accountLinks.find(r=>r.author_row===3).canonicalAuthorRow,2);assert.equal(links.workLinks.length,2);
 assert.equal(readSourceProfileTargets(f.db,{sources:[],reference:NOW,baseLinks:links.accountLinks}).has(UID),false,'explicit source UID cannot become a public handle in another table');
 const imported=f.db.prepare('SELECT * FROM creator_source_imports').get(),data=corpus(f.db,imported,{reference:NOW});
 assert.equal(data.authors.length,1);assert.deepEqual(data.authors[0].sourceAliases.map(a=>a.row),[3]);
 assert.equal(data.works.length,2);assert.ok(data.works.every(w=>w.authorKey===data.authors[0].key&&w.targetId===1));
 const parts=creatorSourcePartitions(f.db,NOW),authors=parts.find(p=>p.kind==='creatorAuthors');
 assert.equal(authors.items.length,1);assert.ok(creatorPartValid({version:1,asOf:NOW,timeZone:'Asia/Shanghai',revision:authors.revision,items:authors.items},authors,NOW));
 assert.deepEqual(projectCanonicalCreatorLinks(links.accountLinks),[{authorRow:authors.items[0].row,targetId:1}],'cloud catalog references only the retained author and keeps its existing one-to-one contract');
 const files=parts.map(({path,kind,count,...body})=>{const content=JSON.stringify({version:1,asOf:NOW,timeZone:'Asia/Shanghai',...body})+'\n';
  const file={path,kind,count,sha256:hash(content),bytes:Buffer.byteLength(content),content};
  assert.ok(creatorPartValid(JSON.parse(content),file,NOW),path);return file;});
 await auditCreatorPublication({manifest:{asOf:NOW,files:files.map(({content,...meta})=>meta)},readPart:async path=>JSON.parse(files.find(f=>f.path===path).content)});
 const foundationParts=tableFoundationPartitions(f.db,NOW,{rosterAccounts:[]});
 const foundationFiles=foundationParts.map(({path,kind,count,...body})=>{const content=JSON.stringify({version:1,asOf:NOW,timeZone:'Asia/Shanghai',...body})+'\n';
  const file={path,kind,count,sha256:hash(content),bytes:Buffer.byteLength(content),content};
  assert.ok(foundationPartValid(JSON.parse(content),file,NOW),path);return file;});
 const allFiles=[...files,...foundationFiles];
 await auditFoundationPublication({manifest:{asOf:NOW,files:allFiles.map(({content,...meta})=>meta)},readPart:async path=>JSON.parse(allFiles.find(f=>f.path===path).content)});
 const foundationIndex=foundationParts.find(p=>p.kind==='foundationIndex');
 assert.equal(foundationIndex.stats.baseAuthors,1);assert.equal(foundationIndex.stats.reciprocalDuplicates,1);
 assert.equal(parts.find(p=>p.kind==='creatorIndex').stats.cumulativeLikes,10,'two real works, no repeated author totals');
 assert.deepEqual(f.db.prepare('SELECT * FROM targets').all(),before);assert.deepEqual(f.db.prepare('SELECT * FROM creator_source_rows').all(),rows);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM snapshots').get().n,1);assert.equal(f.reconcile().admitted,0);
 assert.equal(f.read(LATER).accountLinks.length,2,'identity persists after offline expiry');
 assert.equal(f.read('2026-10-09T14:59:59.000Z').accountLinks.length,1,'no admission backdating');
});
test('a modified UID receipt or original source work cannot authorize an alias',t=>{
 const f=fixture(t);f.reconcile();const receipt=f.db.prepare(`SELECT * FROM ${CREATOR_PROFILE_LINK_TABLE}`).get(),body=JSON.parse(receipt.receipt_json);
 body.uidEvidence.uid='99999';const json=JSON.stringify(body);f.db.prepare(`UPDATE ${CREATOR_PROFILE_LINK_TABLE} SET receipt_json=?,receipt_sha256=?`).run(json,hash(json));
 assert.equal(f.read().accountLinks.length,1);
});

test('historical UID receipts retain their immutable edition fingerprint across parser-projection upgrades',t=>{
 const f=fixture(t);assert.equal(f.reconcile().admitted,1);
 const receipt=f.db.prepare(`SELECT * FROM ${CREATOR_PROFILE_LINK_TABLE}`).get(),body=JSON.parse(receipt.receipt_json);
 // Reproduce a receipt committed before the row-projection executable existed.
 body.uidEvidence.sourceSetFingerprint=hash(JSON.stringify(readWorkSourceEditions(f.db,{asOf:NOW}).map(v=>[v.id,v.factsSha256])));
 const json=JSON.stringify(body);f.db.prepare(`UPDATE ${CREATOR_PROFILE_LINK_TABLE} SET receipt_json=?,receipt_sha256=?`).run(json,hash(json));
 assert.equal(f.read().accountLinks.length,2,'a parser/cache upgrade must not revoke the exact original identity proof');
 assert.equal(f.read(LATER).accountLinks.length,2);
 assert.equal(f.reconcile().admitted,0,'an existing receipt must not be replaced or duplicated');
});

test('derived rejected-row recovery supplies work facts without silently changing the original UID identity-proof namespace',t=>{
 const f=fixture(t);f.laterSource(null);
 const book=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet([['作品链接','作者UID','点赞数'],['https://www.douyin.com/video/'+B,UID,5]]);
 sheet.A2.l={Target:'mailto:unsupported@example.test'};XLSX.utils.book_append_sheet(book,sheet,'作品');
 const at='2026-10-10T12:00:00.000Z',metadata={url:'https://fixture.feishu.cn/sheets/RecoveredUID123456',revision:1,modifiedAt:at,title:'作品',sheets:[{id:'one',name:'作品',region:'A1:C2'}]};
 const raw=commitWorkSourceEdition(f.db,{buffer:XLSX.write(book,{type:'buffer',bookType:'xlsx'}),before:metadata,after:structuredClone(metadata),readAt:at},{now:()=>Date.parse(at)});
 assert.equal(raw.factCount,0);
 const known=readKnownWorkSourceFacts(f.db,{asOf:at});assert.ok(known.facts.some(f=>f.parserRecovery&&f.uid===UID));
 const imported=f.db.prepare('SELECT * FROM creator_source_imports').get();
 assert.equal(readCreatorSourceUIDEvidence(f.db,{imported,reference:at}).candidates.length,0,'derived rows require their own explicit identity admission contract');
});
test('a modified canonical-row pointer cannot evict an existing good binding; newer UID contradictions revoke only the alias',t=>{
 for(const scenario of ['pointer','new-uid']){
  const f=fixture(t);f.reconcile();
  if(scenario==='pointer'){
   f.db.prepare("INSERT INTO creator_source_rows VALUES(1,'08',4,?)").run(JSON.stringify(['other','Other']));
   const receipt=f.db.prepare(`SELECT * FROM ${CREATOR_PROFILE_LINK_TABLE}`).get(),body=JSON.parse(receipt.receipt_json);
   body.canonicalAuthorRow=4;body.canonicalAuthorRowSha256=hash(JSON.stringify(['other','Other']));
   const json=JSON.stringify(body);f.db.prepare(`UPDATE ${CREATOR_PROFILE_LINK_TABLE} SET receipt_json=?,receipt_sha256=?`).run(json,hash(json));
  }else{
   const raw=structuredClone(f.raw),at='2026-10-10T12:00:00.000Z';raw.capturedAt=at;raw.profile.user.uid='999999';
   f.db.prepare('INSERT INTO snapshots VALUES(11,1,?,?,?,?,?)').run(at,'warning','available',checksum(raw),JSON.stringify(raw));
   f.db.prepare("INSERT INTO audits VALUES(21,1,31,?,'public-web','warning',?)").run(at,checksum(raw));
   f.db.prepare("INSERT INTO runs VALUES(31,NULL,?,?,'warning')").run(at,at);
  }
  assert.equal(f.read(LATER).accountLinks.length,1,scenario);assert.equal(f.read(LATER).accountLinks[0].author_row,2);
 }
});
test('later explicit source UID contradictions hold the alias, while mere source removal preserves its historical identity',t=>{
 for(const next of ['999999',null]){const f=fixture(t);f.reconcile();f.laterSource(next);
  assert.equal(f.read(LATER).accountLinks.length,next===null?2:1);
  assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${CREATOR_PROFILE_LINK_TABLE}`).get().n,1,'never rewrite the historical receipt');
 }
});
test('bounded admissions retain the primary before its aliases, and UID-only source rows can bind an existing canonical account',t=>{
 const f=fixture(t);f.db.exec('DELETE FROM creator_source_account_links');
 assert.equal(reconcileCreatorProfileIdentityLinks(f.db,{clock:()=>NOW,maxAdmissions:1}).admitted,1);
 assert.equal(f.read().accountLinks.length,1);assert.equal(f.reconcile().admitted,1);assert.equal(f.read().accountLinks.length,2);
 const g=fixture(t);g.db.exec("DELETE FROM creator_source_account_links; DELETE FROM creator_source_rows WHERE row_number=2");
 assert.equal(g.reconcile().admitted,1);const link=g.read().accountLinks[0];
 assert.equal(link.author_row,3);assert.equal(link.canonicalAuthorRow,3);assert.equal(link.target_id,1);
 assert.equal(g.db.prepare('SELECT COUNT(*) n FROM targets').get().n,1);
});
test('duplicated UID, stale evidence, corrected identities and changed source owners cannot enter the alias chain',t=>{
 for(const scenario of ['duplicate','stale','correction','wrong-owner']){
  const f=fixture(t);
  if(scenario==='duplicate'){
   f.db.prepare('INSERT INTO targets VALUES(2,?,?,?,?,?)').run('account','public-web',SEC+'other',1,JSON.stringify({platform:'douyin'}));
   const raw=structuredClone(f.raw);raw.profile.user.sec_uid=SEC+'other';raw.profile.user.unique_id='Other';
   f.db.prepare('INSERT INTO snapshots VALUES(11,2,?,?,?,?,?)').run(AT,'warning','available',checksum(raw),JSON.stringify(raw));
  }
  if(scenario==='correction')f.db.prepare('UPDATE targets SET metadata_json=?').run(JSON.stringify({platform:'douyin',douyinId:'Example_A',identityVerification:{accountId:SEC},identityCorrection:{reason:'人工更正'}}));
  if(scenario==='wrong-owner')f.db.prepare("UPDATE creator_source_rows SET values_json=? WHERE sheet_id='09' AND row_number=3").run(JSON.stringify([B,'名字','Other','','','','','','','','','https://www.douyin.com/video/'+B]));
  const result=scenario==='stale'?reconcileCreatorProfileIdentityLinks(f.db,{clock:()=>LATER}):f.reconcile();
  assert.equal(result.admitted,0,scenario);assert.equal(f.read().accountLinks.length,1,scenario);
 }
});
