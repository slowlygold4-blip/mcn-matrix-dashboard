import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readCommittedTargetPublication,committedSnapshotAllowed,releaseCommittedTargetPublication} from '../lib/committed-target-publication.mjs';

// This resource regression forbids bulk history materialization, rather than
// relying on a machine-specific RSS threshold. The native SQLite cursor is real.
test('large committed history is consumed once without a bulk joined-row array',()=>{
 const db=new DatabaseSync(':memory:');let receipt;
 try{
  db.exec(`CREATE TABLE targets(id,type,provider,locator,metadata_json);
   CREATE TABLE snapshots(id,target_id,captured_at,source_checksum,quality_status,account_status,followers,total_likes,total_posts,raw_json);
   CREATE TABLE audits(id,target_id,provider,status,created_at,source_checksum,run_id);
   CREATE TABLE runs(id,target_id,trigger_type,status,started_at,finished_at);
   INSERT INTO targets VALUES(1,'account','public-web','synthetic','{}');
   INSERT INTO runs VALUES(1,1,'scheduled','success','2026-09-20T00:00:00Z','2026-09-20T03:00:00Z');
   WITH RECURSIVE rows(n) AS(VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<30000)
   INSERT INTO snapshots SELECT n,1,'2026-09-20T01:00:00Z',printf('%064d',n),'validated','available',n,n,0,'{}' FROM rows;
   INSERT INTO audits SELECT id,1,'public-web','validated','2026-09-20T02:00:00Z',source_checksum,1 FROM snapshots;
   INSERT INTO audits SELECT 30001,1,'public-web','validated','2026-09-20T02:00:00Z',source_checksum,1 FROM snapshots WHERE id=1;`);
  let visited=0,scans=0;
  const connection={get isTransaction(){return db.isTransaction;},prepare(sql){
   const statement=db.prepare(sql);
   if(!sql.includes('CASE WHEN r.status=\'running\''))return statement;
   return {all(){assert.fail('bulk history allocation is forbidden');},*iterate(...args){
    scans++;for(const row of statement.iterate(...args)){visited++;yield row;}
   }};
  }};
  db.exec('BEGIN');
  receipt=readCommittedTargetPublication(connection,{asOf:'2026-09-20T12:00:00.000Z'});
  assert.equal(scans,1);assert.equal(visited,30001);assert.equal(receipt.runningSnapshotCount,0);
  let accepted=0;
  for(const row of db.prepare('SELECT id,target_id,captured_at,source_checksum FROM snapshots').iterate()){
   accepted+=Number(committedSnapshotAllowed(receipt,row));
   assert.equal(committedSnapshotAllowed(receipt,{...row,source_checksum:'0'.repeat(64)}),false);
   assert.equal(committedSnapshotAllowed(receipt,row,{runningOnly:true}),false);
  }
  assert.equal(accepted,30000);db.exec('ROLLBACK');
 }finally{if(receipt)releaseCommittedTargetPublication(receipt);db.close();}
});
