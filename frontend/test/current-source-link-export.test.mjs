import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const creatorScript=fileURLToPath(new URL('../scripts/export-creator-source.mjs',import.meta.url));
const foundationScript=fileURLToPath(new URL('../scripts/export-table-foundation.mjs',import.meta.url));
const run=(script,args)=>spawnSync(process.execPath,[script,...args],{encoding:'utf8'});
const read=async(path)=>JSON.parse(await readFile(path,'utf8'));

test('a later strictly verified link updates both public author projection and foundation edition without changing source revision',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mcn-current-export-'));
 try{
  const workbench=join(root,'workbench'),dataDir=join(workbench,'data'),libDir=join(workbench,'lib');
  await Promise.all([mkdir(dataDir,{recursive:true}),mkdir(libDir,{recursive:true})]);
  // This stub isolates the exporter contract. Strict proof validation itself is
  // covered by the workbench module tests, not simulated by the public site.
  await writeFile(join(libDir,'creator-source-current-links.mjs'),
   'export function readCurrentCreatorSourceLinks(db){const accountLinks=db.prepare("SELECT author_row,target_id,matched_id FROM synthetic_strict_proofs ORDER BY author_row,target_id").all();return {accountLinks,workLinks:[],fingerprint:JSON.stringify(accountLinks),stats:{}};}\n');
  const creatorPath=join(dataDir,'creator.sqlite'),monitorPath=join(dataDir,'monitor.sqlite');
  const creator=new DatabaseSync(creatorPath),monitor=new DatabaseSync(monitorPath);
  try{
   for(const db of [creator,monitor]){
    db.exec('CREATE TABLE creator_source_imports(id INTEGER,source_sha256 TEXT,source_revision TEXT,source_modified_at TEXT,source_row_count INTEGER,imported_at TEXT)');
    db.prepare('INSERT INTO creator_source_imports VALUES(1,?,?,?,?,?)').run('a'.repeat(64),'1697','2026-10-22T13:09:53Z',2,'2026-10-22T15:00:00Z');
   }
   creator.exec('CREATE TABLE source_rows(sheet_id TEXT,row_number INTEGER,values_json TEXT); CREATE TABLE account_links(author_row INTEGER,target_id INTEGER); CREATE TABLE source_sheets(sheet_id TEXT,sheet_name TEXT,row_count INTEGER,restricted INTEGER)');
   monitor.exec('CREATE TABLE creator_source_rows(import_id INTEGER,sheet_id TEXT,row_number INTEGER,values_json TEXT); CREATE TABLE synthetic_strict_proofs(author_row INTEGER,target_id INTEGER,matched_id TEXT); CREATE TABLE targets(id INTEGER,type TEXT,metadata_json TEXT); CREATE TABLE author_resolution_jobs(id TEXT,created_at TEXT,finished_at TEXT,request_json TEXT,status TEXT)');
   const author=['作者甲','author1',null,null,null,null,1,1,0,0,0,100,10,null,20];
   const work=['7300000000000000001','作者甲','author1','2026-10-12','切片','切片激励','切片激励',100,10,null,'作品','https://www.douyin.com/video/7300000000000000001'];
   for(const [sheet,values] of [['08',author],['09',work]]){
    const raw=JSON.stringify(values);
    creator.prepare('INSERT INTO source_rows VALUES(?,?,?)').run(sheet,2,raw);
    monitor.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run(sheet,2,raw);
    creator.prepare('INSERT INTO source_sheets VALUES(?,?,?,0)').run(sheet,sheet,1);
   }
  }finally{creator.close();monitor.close();}
  const creatorOut=join(root,'creator-public'),foundationOut=join(root,'foundation-public');
  const creatorArgs=[creatorPath,creatorOut,monitorPath],foundationArgs=[monitorPath,creatorPath,foundationOut];
  for(const [script,args] of [[creatorScript,creatorArgs],[foundationScript,foundationArgs]]){
   const result=run(script,args);assert.equal(result.status,0,result.stderr);
  }
  const beforeCreator=await read(join(creatorOut,'index.json')),beforeFoundation=await read(join(foundationOut,'index.json'));
  assert.equal(beforeCreator.linkMode,'current-strict');assert.equal(beforeCreator.stats.linkedAuthors,0);
  assert.equal(beforeFoundation.linkMode,'current-strict');
  const db=new DatabaseSync(monitorPath);
  db.prepare('INSERT INTO synthetic_strict_proofs VALUES(?,?,?)').run(2,77,'author1');db.close();
  for(const [script,args] of [[creatorScript,creatorArgs],[foundationScript,foundationArgs]]){
   const result=run(script,args);assert.equal(result.status,0,result.stderr);
  }
  const afterCreator=await read(join(creatorOut,'index.json')),afterFoundation=await read(join(foundationOut,'index.json'));
  assert.equal(afterCreator.revision,'1697');assert.equal(afterCreator.stats.linkedAuthors,1);
  assert.notEqual(afterCreator.linkFingerprint,beforeCreator.linkFingerprint);
  assert.notEqual(afterCreator.files.find(file=>file.path==='authors.json').sha256,beforeCreator.files.find(file=>file.path==='authors.json').sha256);
  assert.notEqual(afterFoundation.revision,beforeFoundation.revision);
  assert.deepEqual((await read(join(creatorOut,'authors.json'))).items[0].targetIds,[77]);
  const frozenOut=join(root,'frozen-public'),legacy=run(creatorScript,[creatorPath,frozenOut]);
  assert.equal(legacy.status,0,legacy.stderr);
  assert.match(legacy.stderr,/仅导出冻结关联/);
  assert.equal((await read(join(frozenOut,'index.json'))).linkMode,'frozen');
  assert.equal((await read(join(frozenOut,'index.json'))).stats.linkedAuthors,0);
  // Raw source drift must fail before replacing the verified public index.
  const altered=new DatabaseSync(creatorPath);
  altered.prepare("UPDATE source_rows SET values_json=? WHERE sheet_id='08'").run(JSON.stringify(['别的作者','author1']));altered.close();
  const rejected=run(creatorScript,creatorArgs);
  assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/冻结来源行与作者总表原始行不一致/);
  assert.deepEqual(await read(join(creatorOut,'index.json')),afterCreator);
 }finally{await rm(root,{recursive:true,force:true});}
});
