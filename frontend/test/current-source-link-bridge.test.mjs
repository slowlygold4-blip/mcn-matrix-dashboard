import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readValidatedCurrentSourceLinks} from '../lib/current-source-link-bridge.mjs';

function fixture(t){
 const creator=new DatabaseSync(':memory:'),monitor=new DatabaseSync(':memory:');
 t.after(()=>{creator.close();monitor.close();});
 for(const db of [creator,monitor]){
  db.exec('CREATE TABLE creator_source_imports(id INTEGER,source_sha256 TEXT,source_revision TEXT,source_modified_at TEXT,source_row_count INTEGER);');
  db.prepare('INSERT INTO creator_source_imports VALUES(1,?,?,?,?)').run('a'.repeat(64),'1697','2026-10-22T13:09:53Z',2);
 }
 creator.exec('CREATE TABLE source_rows(sheet_id TEXT,row_number INTEGER,values_json TEXT);');
 monitor.exec('CREATE TABLE creator_source_rows(import_id INTEGER,sheet_id TEXT,row_number INTEGER,values_json TEXT);');
 for(const [sheet,row,values] of [['08',2,['作者','author1']],['09',2,['7300000000000000001','作者','author1']]]){
  const json=JSON.stringify(values);
  creator.prepare('INSERT INTO source_rows VALUES(?,?,?)').run(sheet,row,json);
  monitor.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run(sheet,row,json);
 }
 creator.exec('PRAGMA query_only=ON; BEGIN');monitor.exec('PRAGMA query_only=ON; BEGIN');
 return {creator,monitor};
}

test('same frozen source is the only route to current proof projection',async t=>{
 const {creator,monitor}=fixture(t);
 let called=0;
 const projected=await readValidatedCurrentSourceLinks(creator,monitor,'/tmp/workbench/data/monitor.sqlite',{
  readLinks(_db,{imported}){called++;assert.equal(imported.source_revision,'1697');return {accountLinks:[{author_row:2,target_id:15,matched_id:'author1'}],workLinks:[],fingerprint:'receipt-fingerprint'};},
 });
 assert.equal(called,1);
 assert.equal(projected.mode,'current-strict');
 assert.deepEqual(projected.accountLinks,[{author_row:2,target_id:15,matched_id:'author1'}]);
 assert.equal(projected.fingerprint,'receipt-fingerprint');
});

test('same revision but changed raw author evidence fails before reading any links',async t=>{
 const creator=new DatabaseSync(':memory:'),monitor=new DatabaseSync(':memory:');
 t.after(()=>{creator.close();monitor.close();});
 for(const db of [creator,monitor]){
  db.exec('CREATE TABLE creator_source_imports(id INTEGER,source_sha256 TEXT,source_revision TEXT,source_modified_at TEXT,source_row_count INTEGER)');
  db.prepare('INSERT INTO creator_source_imports VALUES(1,?,?,?,?)').run('a'.repeat(64),'1697','2026-10-22T13:09:53Z',1);
 }
 creator.exec('CREATE TABLE source_rows(sheet_id TEXT,row_number INTEGER,values_json TEXT)');
 monitor.exec('CREATE TABLE creator_source_rows(import_id INTEGER,sheet_id TEXT,row_number INTEGER,values_json TEXT)');
 creator.prepare('INSERT INTO source_rows VALUES(?,?,?)').run('08',2,JSON.stringify(['作者甲','author1']));
 monitor.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run('08',2,JSON.stringify(['作者乙','author1']));
 let called=false;
 await assert.rejects(readValidatedCurrentSourceLinks(creator,monitor,'/tmp/workbench/data/monitor.sqlite',{
  readLinks(){called=true;return {accountLinks:[],workLinks:[],fingerprint:''};},
 }),/冻结来源行与作者总表原始行不一致/);
 assert.equal(called,false);
});

test('legacy fixture may omit both current imports but a one-sided import fails closed',async t=>{
 const creator=new DatabaseSync(':memory:'),monitor=new DatabaseSync(':memory:');
 t.after(()=>{creator.close();monitor.close();});
 const absent=await readValidatedCurrentSourceLinks(creator,monitor,'/tmp/workbench/data/monitor.sqlite',{allowAbsent:true});
 assert.equal(absent.mode,'absent');
 creator.exec('CREATE TABLE creator_source_imports(id INTEGER)');
 await assert.rejects(readValidatedCurrentSourceLinks(creator,monitor,'/tmp/workbench/data/monitor.sqlite',{allowAbsent:true}),/导入状态不一致/);
});

test('base author rows without a frozen import cannot silently publish stale links',async t=>{
 const creator=new DatabaseSync(':memory:'),monitor=new DatabaseSync(':memory:');
 t.after(()=>{creator.close();monitor.close();});
 creator.exec('CREATE TABLE source_rows(sheet_id TEXT,row_number INTEGER,values_json TEXT)');
 creator.prepare('INSERT INTO source_rows VALUES(?,?,?)').run('08',2,'["作者","author1"]');
 await assert.rejects(readValidatedCurrentSourceLinks(creator,monitor,'/tmp/workbench/data/monitor.sqlite',{allowAbsent:true}),/导入状态不一致/);
});
