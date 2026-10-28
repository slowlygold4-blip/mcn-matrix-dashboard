import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {readAccountSnapshotComparisons} from '../lib/account-report-comparisons.mjs';
const legacy=readFileSync(new URL('./fixtures/account-report-comparisons-legacy.sql',import.meta.url),'utf8');
const all={clause:'1=1',params:[]};
function setup(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE targets(id INTEGER PRIMARY KEY,type TEXT);
 CREATE TABLE snapshots(id INTEGER PRIMARY KEY,target_id INTEGER,captured_at TEXT,quality_status TEXT,
 account_status TEXT,works_coverage TEXT,account_error TEXT,works_error TEXT,warnings_json TEXT,
 followers INTEGER,total_likes INTEGER,source_checksum TEXT);
 CREATE INDEX idx_snapshot_endpoint ON snapshots(target_id,captured_at DESC,id DESC);`);
 return {db,target(id,type='account'){db.prepare('INSERT INTO targets VALUES(?,?)').run(id,type);},
 sample(id,at,f,l,{quality='validated',status='available'}={}){return Number(db.prepare('INSERT INTO snapshots(target_id,captured_at,quality_status,account_status,works_coverage,warnings_json,followers,total_likes,source_checksum) VALUES(?,?,?,?,?,?,?,?,?)').run(id,at,quality,status,'unavailable','[]',f,l,`${id}:${at}`).lastInsertRowid);}};
}
const bounds={start:'2026-10-10T00:00:00.000Z',end:'2026-10-20T23:59:59.999Z'};
const timeParameters=b=>[b.start,b.end,b.start,b.end,b.start,b.start,b.end,b.start,b.end,b.start,b.start,b.end];
function reference(db,b,scope=all){return db.prepare(legacy.replace('AND 1=1','AND '+scope.clause)).all(...scope.params,...timeParameters(b));}

test('indexed endpoints preserve counter-specific baselines, zero, rejected rows and ID tie breaks',t=>{
 const f=setup(t);f.target(1);f.target(2);f.target(3,'hashtag');f.target(4);
 f.sample(1,'2026-10-09T00:00:00.000Z',0,100);
 f.sample(1,'2026-10-11T00:00:00.000Z',10,110);
 f.sample(1,'2026-10-12T00:00:00.000Z',9,120);
 f.sample(1,'2026-10-12T00:00:00.000Z',8,null);
 f.sample(1,'2026-10-13T00:00:00.000Z',999,999,{quality:'rejected'});
 f.sample(1,'2026-10-21T00:00:00.000Z',999,999);
 f.sample(2,'2026-10-11T00:00:00.000Z',20,null);
 f.sample(2,'2026-10-12T00:00:00.000Z',15,2);
 f.sample(3,'2026-10-12T00:00:00.000Z',12,34);
 f.sample(4,'2026-10-09T00:00:00.000Z',12,34);
 const rows=readAccountSnapshotComparisons(f.db,{bounds,boardScope:all});
 assert.deepEqual(rows,reference(f.db,bounds));assert.equal(rows.length,2);
 assert.equal(rows[0].current_followers,8);assert.equal(rows[0].baseline_followers,0);
 assert.equal(rows[0].current_total_likes,120);assert.equal(rows[0].baseline_total_likes,100);
 assert.equal(rows[1].current_followers,15);assert.equal(rows[1].baseline_followers,20);
 assert.equal(rows[1].followers_baseline_mode,'first-in-period');assert.equal(rows[1].baseline_total_likes,null);
});

test('mixed histories and scoped targets match the original SQL over multiple periods',t=>{
 const f=setup(t);
 for(let id=1;id<=96;id++){
  f.target(id,id%13===0?'hashtag':'account');
  for(let day=1;day<=28;day+=2){const at=`2026-10-${String(day).padStart(2,'0')}T08:00:00.000Z`;
   f.sample(id,at,(day+id)%4?100+id-day:null,(day+id)%7?id*day:null,{quality:(day+id)%11?'validated':'rejected'});
  }
 }
 for(const b of [bounds,{start:'2026-10-01T00:00:00.000Z',end:'2026-10-28T23:59:59.999Z'},
  {start:'2026-10-27T00:00:00.000Z',end:'2026-10-27T23:59:59.999Z'}]){
  for(const scope of [all,{clause:'t.id IN (?,?)',params:[2,4]}]){
   assert.deepEqual(readAccountSnapshotComparisons(f.db,{bounds:b,boardScope:scope}),reference(f.db,b,scope));
  }
 }
});

test('planner uses indexed endpoint seeks instead of materializing seven history windows',t=>{
 const f=setup(t);f.target(1);f.sample(1,'2026-10-12T00:00:00.000Z',1,2);
 let sql,parameters;
 const db={prepare(text){sql=text;return{all(...args){parameters=args;return f.db.prepare(text).all(...args);}};}};
 readAccountSnapshotComparisons(db,{bounds,boardScope:all});
 const plan=f.db.prepare('EXPLAIN QUERY PLAN '+sql).all(...parameters).map(row=>row.detail);
 assert.equal(plan.filter(detail=>/SEARCH s USING.*INDEX idx_snapshot_endpoint/.test(detail)).length,7);
 assert.ok(!plan.some(detail=>detail.includes('MATERIALIZE')));
});
