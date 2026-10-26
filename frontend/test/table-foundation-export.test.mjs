import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

test('source export preserves absent observations, retains real zero and seals the output',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mcn-foundation-export-'));
 const monitorPath=join(root,'monitor.sqlite'),creatorPath=join(root,'creator.sqlite'),output=join(root,'public');
 const monitor=new DatabaseSync(monitorPath),creator=new DatabaseSync(creatorPath);
 const samples=[null,'','   ',false,[],{},0,'0',42,'123',-1,1.5,'invalid'];
 const expected=[null,null,null,null,null,null,0,0,42,123,null,null,null];
 try{
  monitor.exec("CREATE TABLE targets(id INTEGER,type TEXT,metadata_json TEXT); CREATE TABLE author_resolution_jobs(id TEXT,created_at TEXT,finished_at TEXT,request_json TEXT,status TEXT)");
  creator.exec('CREATE TABLE source_rows(sheet_id TEXT,row_number INTEGER,values_json TEXT); CREATE TABLE source_sheets(sheet_id TEXT,sheet_name TEXT,row_count INTEGER,restricted INTEGER)');
  const insert=creator.prepare('INSERT INTO source_rows VALUES(?,?,?)');
  for(const [index,value] of samples.entries()){
   const row=Array(14).fill(null);row[2]='测试作者';row[3]='author-id';row[5]=String(7300000000000000000n+BigInt(index));row[8]=value;row[9]=value;row[13]='2026-10-23T00:00:00Z';
   insert.run('10',index+2,JSON.stringify(row));
  }
  creator.prepare('INSERT INTO source_sheets VALUES(?,?,?,?)').run('10','来源观测',samples.length,1);
 }finally{monitor.close();creator.close();}
 try{
  const beforeMonitor=await readFile(monitorPath),beforeCreator=await readFile(creatorPath);
  execFileSync(process.execPath,[fileURLToPath(new URL('../scripts/export-table-foundation.mjs',import.meta.url)),monitorPath,creatorPath,output],{stdio:'pipe'});
  const index=JSON.parse(await readFile(join(output,'index.json'),'utf8'));
  const bytes=await readFile(join(output,'observations.json'));
  const body=JSON.parse(bytes);
  assert.deepEqual(body.items.map(row=>row.plays),expected);
  assert.deepEqual(body.items.map(row=>row.likes),expected);
  assert.equal(body.revision,index.revision);
  const manifest=index.files.find(file=>file.path==='observations.json');
  assert.equal(manifest.count,samples.length);
  assert.equal(manifest.bytes,bytes.length);
  assert.equal(manifest.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(await readFile(monitorPath),beforeMonitor);
  assert.deepEqual(await readFile(creatorPath),beforeCreator);
 }finally{await rm(root,{recursive:true,force:true});}
});
