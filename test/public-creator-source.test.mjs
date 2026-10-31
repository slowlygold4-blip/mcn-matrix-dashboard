import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {readFileSync,existsSync} from 'node:fs';
import {MonitorDatabase} from '../lib/database.mjs';
import {creatorSourcePartitions} from '../lib/public-creator-source.mjs';
import {auditCreatorPublication,creatorPartValid} from '../lib/replica-creator.mjs';
import {readUnifiedCreatorSourceCorpus} from '../lib/creator-source-corpus.mjs';
const asOf='2026-10-25T00:00:00.000Z',hash=s=>createHash('sha256').update(s).digest('hex');
function fixture(t){const database=new MonitorDatabase(':memory:');t.after(()=>database.close());const db=database.db;
 db.exec(`CREATE TABLE creator_source_imports(id INTEGER,source_sha256 TEXT,source_url TEXT,source_revision TEXT,source_modified_at TEXT,imported_at TEXT,metadata_json TEXT,source_row_count INTEGER);
 CREATE TABLE creator_source_rows(import_id INTEGER,sheet_id TEXT,row_number INTEGER,values_json TEXT);
 CREATE TABLE creator_source_account_links(import_id INTEGER,author_row INTEGER,target_id INTEGER,matched_id TEXT,matched_at TEXT);
 CREATE TABLE creator_source_work_links(import_id INTEGER,work_row INTEGER,target_id INTEGER);`);
 db.prepare('INSERT INTO creator_source_imports VALUES(1,?,?,?,?,?,?,?)').run('a'.repeat(64),'https://private.feishu.cn/sheets/private','1697','2026-10-21T00:00:00Z','2026-10-22T00:00:00Z','{}',3);
 const add=(sheet,row,v)=>db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run(sheet,row,JSON.stringify(v));
 add('08',2,['作者A','handle_a',null,null,null,null,2,2,0,0,0,100,3,null,null,'private-document','private-bonus']);
 add('09',2,['7300000000000000001','作者A','handle_a','2026-09-12','video','切片激励','切片激励',100,3,'','标题A','https://v.douyin.com/a/']);
 add('09',3,['7300000000000000002','作者A','handle_a','','video','切片激励','切片激励',null,0,'','标题B','https://v.douyin.com/b/']);
 const read=(cutoff=asOf,options={})=>{const parts=creatorSourcePartitions(db,cutoff,options);const files=parts.map(({path,kind,count,...body})=>{const content=JSON.stringify({version:1,asOf:cutoff,timeZone:'Asia/Shanghai',...body})+'\n';return {path,kind,count,bytes:Buffer.byteLength(content),sha256:hash(content),content};});
 return {manifest:{asOf:cutoff,files:files.map(({content,...meta})=>meta)},files};};return {db,read};}
const audit=publication=>auditCreatorPublication({manifest:publication.manifest,readPart:async path=>JSON.parse(publication.files.find(f=>f.path===path).content)});

test('explicit field-order aliases collapse even without works, retain originals, and reappear as unverified if their proof changes',async t=>{
 const {db,read}=fixture(t);
 db.exec('CREATE TABLE creator_source_sheets(import_id INTEGER,sheet_id TEXT,headers_json TEXT)');
 db.prepare('INSERT INTO creator_source_sheets VALUES(1,?,?)').run('08',JSON.stringify(['作者名','主抖音号','账号别名']));
 db.prepare('INSERT INTO creator_source_sheets VALUES(1,?,?)').run('14',JSON.stringify(['作者名','填报账号']));
 const primary=['现在的显示名','87654321',null,null,null,null,0,0,0,0,0,0,0];
 const displaced=[87654321,'明确作者','保留备注',null,null,null,0,0,0,0,0,0,0];
 const insert=db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)');
 insert.run('08',4,JSON.stringify(primary));insert.run('08',5,JSON.stringify(displaced));insert.run('14',4,JSON.stringify(['明确作者','87654321']));
 const before=db.prepare('SELECT total_changes() n').get().n;
 let result=read(),authors=JSON.parse(result.files.find(f=>f.kind==='creatorAuthors').content).items;
 assert.equal(authors.length,2);assert.equal(authors.filter(a=>a.douyinId==='87654321').length,1);
 assert.equal((await audit(result)).works,2);
 const corpus=readUnifiedCreatorSourceCorpus(db,asOf).source,author=corpus.authors.find(a=>a.accountId==='87654321');
 assert.equal(author.sourceAliases[0].row,5);assert.equal(author.sourceAliases[0].identityFieldRepair.original.name,87654321);
 assert.equal(db.prepare("SELECT values_json FROM creator_source_rows WHERE sheet_id='08' AND row_number=5").get().values_json,JSON.stringify(displaced));
 assert.equal(db.prepare('SELECT total_changes() n').get().n,before);
 assert.equal(JSON.stringify(result).includes('rowSha256'),false);assert.equal(JSON.stringify(result).includes('保留备注'),false);
 db.prepare("UPDATE creator_source_rows SET values_json=? WHERE sheet_id='14' AND row_number=4").run(JSON.stringify(['另一个作者','87654321']));
 result=read();authors=JSON.parse(result.files.find(f=>f.kind==='creatorAuthors').content).items;
 assert.equal(authors.length,3,'changed source proof must not leave a cached confirmed alias');
 assert.equal(authors.some(a=>a.name==='87654321'&&a.douyinId==='明确作者'),true);
});
test('explicit registration categories publish even when no works have been recorded, without private evidence',async t=>{
 const {db,read}=fixture(t);
 const add=(sheet,row,values)=>db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run(sheet,row,JSON.stringify(values));
 add('08',3,['登记作者','registered_id',null,null,null,null,0,0,0,0,0,null,null,null,null]);
 add('11',2,['private-registration-record','slice_registry','登记作者','registered_id',null,null,'切片、手书、AI']);
 add('11',3,['other-private-registration','ai_registry','登记作者','registered_id',null,null,null]);
 const before=db.prepare('SELECT total_changes() n').get().n,first=read();
 const authors=JSON.parse(first.files.find(f=>f.kind==='creatorAuthors').content).items;
 const registered=authors.find(a=>a.douyinId==='registered_id');
 assert.deepEqual(registered.registeredClassifications,['slice','original','ai-remix']);
 assert.equal(registered.posts,0);assert.equal(registered.plays,null);assert.deepEqual(registered.targetIds,[]);
 assert.equal(JSON.stringify(first).includes('private-registration-record'),false);
 assert.equal((await audit(first)).authors,2);
 assert.equal(before,db.prepare('SELECT total_changes() n').get().n,'publication reads never write');
 const index=p=>JSON.parse(p.files.find(f=>f.kind==='creatorIndex').content);
 db.prepare('INSERT INTO creator_source_imports SELECT 2,?,source_url,?,source_modified_at,imported_at,metadata_json,source_row_count FROM creator_source_imports WHERE id=1').run('b'.repeat(64),'1698');
 db.exec('INSERT INTO creator_source_rows SELECT 2,sheet_id,row_number,values_json FROM creator_source_rows WHERE import_id=1');
 db.prepare("UPDATE creator_source_rows SET values_json=? WHERE import_id=2 AND sheet_id='11' AND row_number=2").run(JSON.stringify(['private-registration-record','slice_registry','登记作者','registered_id',null,null,'切片']));
 const afterImport=db.prepare('SELECT total_changes() n').get().n;
 const second=read();assert.notEqual(index(first).editionFingerprint,index(second).editionFingerprint);
 assert.deepEqual(JSON.parse(second.files.find(f=>f.kind==='creatorAuthors').content).items.find(a=>a.douyinId==='registered_id').registeredClassifications,['slice','ai-remix']);
 assert.equal(index(first).stats.works,index(second).stats.works);
 assert.equal(afterImport,db.prepare('SELECT total_changes() n').get().n,'reading a new immutable edition never writes');
});

test('unknown registration sources and duplicate source identities do not acquire guessed categories',t=>{
 for(const duplicate of [false,true]){
  const {db,read}=fixture(t),add=(sheet,row,values)=>db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run(sheet,row,JSON.stringify(values));
  add('11',2,['rec',duplicate?'ai_registry':'unknown_registry','作者A','handle_a',null,null,'切片AI']);
  if(duplicate)add('08',3,['同号另一作者','handle_a',null,null,null,null,0,0,0,0,0,null,null,null,null]);
  const authors=JSON.parse(read().files.find(f=>f.kind==='creatorAuthors').content).items;
  assert.ok(authors.every(a=>!a.registeredClassifications));
 }
});
test('public source corpus is complete, sealed and contains no raw source, authorization, reward or uid fields',async t=>{
 const {db,read}=fixture(t),changes=db.prepare('SELECT total_changes() n').get().n,result=read(),proof=await audit(result);
 assert.deepEqual({authors:proof.authors,works:proof.works},{authors:1,works:2});
 for(const f of result.files)assert.equal(creatorPartValid(JSON.parse(f.content),f,asOf),true,f.path);
 const body=JSON.stringify(result);for(const forbidden of ['private.feishu.cn','private-document','private-bonus','sourceEditionEvidence','rowSha256'])assert.equal(body.includes(forbidden),false);
 const works=JSON.parse(result.files.find(f=>f.kind==='creatorWorks').content).items;
 assert.equal(works[1].plays,null);assert.equal(works[1].likes,0);assert.equal(works[1].publishDate,'');
 assert.deepEqual(works.map(w=>w.classifications),[['slice'],['slice']],'known work categories survive publication without becoming new measurements');
 assert.equal(db.prepare('SELECT total_changes() n').get().n,changes,'builder performs no writes');
});
test('a changed publication timestamp alone keeps the public source content identity stable',t=>{
 const {read}=fixture(t),a=read(),b=read('2026-10-26T00:00:00.000Z');
 const root=r=>JSON.parse(r.files.find(f=>f.kind==='creatorIndex').content);
 assert.equal(root(a).editionFingerprint,root(b).editionFingerprint);
 assert.notEqual(a.files.find(f=>f.kind==='creatorWorks').sha256,b.files.find(f=>f.kind==='creatorWorks').sha256);
});
test('the production redactor cannot bypass the public text contract on unmatched angle brackets',async t=>{
 const {db,read}=fixture(t),select=db.prepare('SELECT rowid,values_json FROM creator_source_rows'),update=db.prepare('UPDATE creator_source_rows SET values_json=? WHERE rowid=?');
 for(const row of select.all()){
  const values=JSON.parse(row.values_json);
  if(values.length>13)values[0]='作者 < 甲';else values[10]='比较 1 < 2 > 与未闭合 < 字符';
  update.run(JSON.stringify(values),row.rowid);
 }
 const before=select.all(),result=read(asOf,{sanitize:value=>String(value??'').replace(/<[^>]*>/g,'')});
 for(const file of result.files)assert.equal(creatorPartValid(JSON.parse(file.content),file,asOf),true,file.path);
 assert.equal((await audit(result)).works,2);
 assert.deepEqual(select.all(),before,'publication normalization never changes original rows');
});
test('all source pages, exact totals, insights and data fingerprint are audited before activation',async t=>{
 const {read}=fixture(t);
 for(const kind of ['creatorWorks','creatorInsights','creatorIndex']){
  const result=read(),file=result.files.find(f=>f.kind===kind),part=JSON.parse(file.content);
  if(kind==='creatorWorks')part.items[0].plays=999;
  else if(kind==='creatorInsights')part.items[0].counts.cumulativePlays=999;
  else part.editionFingerprint='0'.repeat(64);
  file.content=JSON.stringify(part);await assert.rejects(audit(result),/creator-/);
 }
 const missing=read();missing.manifest.files=missing.manifest.files.filter(f=>f.kind!=='creatorWorks');await assert.rejects(audit(missing),/descriptor-conflict/);
});
test('shared creator analytics and validation contracts match the hosted copies',()=>{
 for(const name of ['creator-intelligence.mjs','source-ledger-track.mjs','replica-creator.mjs','source-work-classification.mjs']){
  const sibling=new URL('../../mcn-public-site/lib/'+name,import.meta.url),tracked=new URL('../frontend/lib/'+name,import.meta.url);
  assert.equal(hash(readFileSync(new URL('../lib/'+name,import.meta.url))),hash(readFileSync(existsSync(sibling)?sibling:tracked)));
 }
});
