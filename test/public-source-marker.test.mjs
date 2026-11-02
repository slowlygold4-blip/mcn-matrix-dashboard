import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {readPublicSourceMarker} from '../lib/public-source-marker.mjs';
test('source-only completions and corrections trigger publication without an account sampling run',()=>{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE author_resolution_jobs(id TEXT,status TEXT,created_at TEXT,finished_at TEXT,request_json TEXT)');
 try{
  const at='2026-10-29T05:00:00.000Z',first=readPublicSourceMarker(db,at);
  db.prepare('INSERT INTO author_resolution_jobs VALUES(?,?,?,?,?)').run('job','pending','2026-10-28T00:00:00Z',null,'{"PRIVATE_SECRET":1}');
  assert.equal(readPublicSourceMarker(db,at),first,'unfinished imports do not publish');
  db.prepare("UPDATE author_resolution_jobs SET status='completed',finished_at='2026-10-29T01:00:00Z'").run();
  const completed=readPublicSourceMarker(db,at);assert.notEqual(completed,first);assert.match(completed,/^[a-f0-9]{64}$/);assert.equal(completed.includes('PRIVATE_SECRET'),false);
  db.prepare('UPDATE author_resolution_jobs SET request_json=?').run('{"PRIVATE_SECRET":2}');assert.notEqual(readPublicSourceMarker(db,at),completed,'same-length correction is detected');
  const before=db.prepare('SELECT total_changes() n').get().n;readPublicSourceMarker(db,at);assert.equal(db.prepare('SELECT total_changes() n').get().n,before);
 }finally{db.close();}
});
test('future import completion is excluded until the actual cutoff reaches it',()=>{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE author_resolution_jobs(id TEXT,status TEXT,created_at TEXT,finished_at TEXT,request_json TEXT)');
 try{
  const before=readPublicSourceMarker(db,'2026-10-29T05:00:00Z');db.prepare('INSERT INTO author_resolution_jobs VALUES(?,?,?,?,?)').run('later','completed','2026-10-29T00:00:00Z','2026-10-30T01:00:00Z','{}');
  assert.equal(readPublicSourceMarker(db,'2026-10-29T05:00:00Z'),before);assert.notEqual(readPublicSourceMarker(db,'2026-10-30T05:00:00Z'),before);
 }finally{db.close();}
});
test('an identity-only admission triggers publication without a new sampling run or source edition',()=>{
 const db=new DatabaseSync(':memory:');try{
  const at='2026-10-30T05:00:00.000Z';let previous=readPublicSourceMarker(db,at);
  for(const table of ['creator_source_profile_identity_receipts','supplement_profile_identity_receipts']){
   db.exec(`CREATE TABLE ${table}(id INTEGER,receipt_sha256 TEXT,committed_at TEXT,receipt_json TEXT)`);
   assert.equal(readPublicSourceMarker(db,at),previous);
   db.prepare(`INSERT INTO ${table} VALUES(1,?,?,?)`).run('a'.repeat(64),'2026-10-30T06:00:00.000Z','PRIVATE_SECRET');
   assert.equal(readPublicSourceMarker(db,at),previous,'future admission is not published early');
   db.prepare(`UPDATE ${table} SET committed_at='2026-10-30T04:00:00.000Z'`).run();
   const next=readPublicSourceMarker(db,at);assert.notEqual(next,previous);assert.match(next,/^[a-f0-9]{64}$/);previous=next;
  }
 }finally{db.close()}
});

test('an accepted HTTP work observation triggers publication at commitment time without profile collection',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec('CREATE TABLE account_events(id INTEGER,target_id INTEGER,event_type TEXT,event_key TEXT,observed_at TEXT,source_checksum TEXT,created_at TEXT)');
  const asOf='2026-11-02T14:20:00Z',before=readPublicSourceMarker(db,asOf);
  const insert=db.prepare('INSERT INTO account_events VALUES(?,?,?,?,?,?,?)');
  insert.run(1,1,'lifecycle','unrelated','2026-11-02T14:00:00Z','a'.repeat(64),'2026-11-02T14:00:00Z');
  assert.equal(readPublicSourceMarker(db,asOf),before);
  insert.run(2,1,'remote-work-observation','receipt','2026-11-02T14:07:19.135Z','b'.repeat(64),'2026-11-02T14:19:19.575Z');
  assert.equal(readPublicSourceMarker(db,'2026-11-02T14:12:00Z'),before,'not visible before its real commitment');
  const after=readPublicSourceMarker(db,asOf);assert.notEqual(after,before);
  insert.run(3,1,'remote-work-observation','future-observation','2026-11-02T15:00:00Z','c'.repeat(64),'2026-11-02T14:19:19.575Z');
  assert.equal(readPublicSourceMarker(db,asOf),after);
  const changes=db.prepare('SELECT total_changes() n').get().n;readPublicSourceMarker(db,asOf);
  assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);
 }finally{db.close()}
});
