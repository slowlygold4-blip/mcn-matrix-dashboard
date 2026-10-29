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
