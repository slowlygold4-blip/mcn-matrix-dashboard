import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Worker} from 'node:worker_threads';
import {MonitorDatabase} from '../lib/database.mjs';
import {ConsoleReader} from '../lib/console-reader.mjs';
import {readCreatorOperatingView} from '../lib/creator-source-operating-view.mjs';
const ASOF='2026-10-30T18:35:00.000Z';
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'creator-operating-reader-')),database=new MonitorDatabase(join(dir,'fixture.sqlite')),db=database.db,workers=[];
 db.exec(`CREATE TABLE creator_source_imports(id INTEGER PRIMARY KEY,source_sha256 TEXT,source_url TEXT,source_revision TEXT,source_modified_at TEXT,imported_at TEXT,metadata_json TEXT,source_row_count INTEGER);
 CREATE TABLE creator_source_rows(import_id INTEGER,sheet_id TEXT,row_number INTEGER,values_json TEXT);
 CREATE TABLE creator_source_sheets(import_id INTEGER,sheet_id TEXT,sheet_name TEXT,row_count INTEGER,restricted INTEGER,headers_json TEXT);
 CREATE TABLE creator_source_account_links(import_id INTEGER,author_row INTEGER,target_id INTEGER,matched_id TEXT,matched_at TEXT);
 CREATE TABLE creator_source_work_links(import_id INTEGER,work_row INTEGER,target_id INTEGER);`);
 const edition=(id,likes)=>{
  const at=id===1?'2026-09-29T00:00:00.000Z':'2026-10-29T00:00:00.000Z';
  db.prepare('INSERT INTO creator_source_imports VALUES(?,?,?,?,?,?,?,?)').run(id,String(id).repeat(64),'https://fixture.feishu.cn/sheets/test',String(id),at,at,'{}',2);
  db.prepare("INSERT INTO creator_source_rows VALUES(?,'08',2,?)").run(id,JSON.stringify(['fixture author','fixture_handle',null,null,null,null,1,1,0,0,0,100,likes,null,null]));
  db.prepare("INSERT INTO creator_source_rows VALUES(?,'09',2,?)").run(id,JSON.stringify(['7300000000000000001','fixture author','fixture_handle','2026-09-30','video','切片激励','切片激励',100,likes,'','fixture work']));
 };
 edition(1,0);
 const reader=new ConsoleReader({databasePath:database.filePath,cacheTtlMs:30000,timeoutMs:5000,
  workerFactory:()=>{const worker=new Worker(new URL('../lib/console-reader-worker.mjs',import.meta.url),{workerData:{databasePath:database.filePath},execArgv:[]});workers.push(worker);return worker;}});
 t.after(async()=>{await reader.close();database.close();rmSync(dir,{recursive:true,force:true});});
 return{db,reader,edition,workers};
}

test('worker returns the complete direct author/work contract, keeps zero and re-reads externally committed editions at the same cutoff',async t=>{
 const f=fixture(t),query={view:'works',q:'fixture',asOf:ASOF,pageSize:'1'};
 const before=f.db.prepare('SELECT total_changes() n').get().n;
 const direct=readCreatorOperatingView(f.db,query),first=await f.reader.creatorOperatingView(query);
 assert.deepEqual(first,direct);assert.equal(first.summary.cumulativeLikes,0);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
 f.edition(2,99);const afterWrite=f.db.prepare('SELECT total_changes() n').get().n;
 const next=await f.reader.creatorOperatingView(query);assert.deepEqual(next,readCreatorOperatingView(f.db,query));
 assert.equal(next.summary.cumulativeLikes,99,'same asOf does not mean source/identity proof is unchanged');
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,afterWrite);assert.equal(f.reader.cache.size,0);
 const invalid=await f.reader.creatorOperatingView({...query,start:'2026-02-30'});assert.equal(invalid.statusCode,400);
});

test('a final cancelled creator read releases the old worker and preserves a queued fresh read',async t=>{
 const f=fixture(t),controller=new AbortController(),first=f.reader.creatorOperatingView({asOf:ASOF},{signal:controller.signal});
 const rejected=assert.rejects(first,{code:'CONSOLE_READER_ABORTED'}),next=f.reader.creatorOperatingView({asOf:ASOF});controller.abort();
 await rejected;assert.equal((await next).summary.works,1);assert.equal(f.workers.length,2);
 assert.equal(f.workers[0].threadId,-1);assert.equal(f.reader.jobs.size,0);assert.equal(f.reader.terminations.size,0);
});
