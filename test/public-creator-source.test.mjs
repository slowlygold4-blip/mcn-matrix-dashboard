import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {readFileSync,existsSync} from 'node:fs';
import {MonitorDatabase} from '../lib/database.mjs';
import {creatorSourcePartitions} from '../lib/public-creator-source.mjs';
import {auditCreatorPublication,creatorPartValid} from '../lib/replica-creator.mjs';
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
test('public source corpus is complete, sealed and contains no raw source, authorization, reward or uid fields',async t=>{
 const {db,read}=fixture(t),changes=db.prepare('SELECT total_changes() n').get().n,result=read(),proof=await audit(result);
 assert.deepEqual({authors:proof.authors,works:proof.works},{authors:1,works:2});
 for(const f of result.files)assert.equal(creatorPartValid(JSON.parse(f.content),f,asOf),true,f.path);
 const body=JSON.stringify(result);for(const forbidden of ['private.feishu.cn','private-document','private-bonus','sourceEditionEvidence','rowSha256'])assert.equal(body.includes(forbidden),false);
 const works=JSON.parse(result.files.find(f=>f.kind==='creatorWorks').content).items;
 assert.equal(works[1].plays,null);assert.equal(works[1].likes,0);assert.equal(works[1].publishDate,'');
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
 for(const name of ['creator-intelligence.mjs','source-ledger-track.mjs','replica-creator.mjs']){
  const sibling=new URL('../../mcn-public-site/lib/'+name,import.meta.url),tracked=new URL('../frontend/lib/'+name,import.meta.url);
  assert.equal(hash(readFileSync(new URL('../lib/'+name,import.meta.url))),hash(readFileSync(existsSync(sibling)?sibling:tracked)));
 }
});
