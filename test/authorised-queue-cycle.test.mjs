import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { deferAuthorisedQueueClaim, runAuthorisedQueueCycle } from '../lib/authorised-queue-cycle.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE author_resolution_queue(id INTEGER,identity_key TEXT,evidence_version INTEGER,lease_owner TEXT,status TEXT,
    next_attempt_at TEXT,last_error TEXT,lease_until TEXT,updated_at TEXT,resolved_target_id INTEGER,suspended_target_enabled INTEGER,attempts INTEGER,
    verification_policy_version INTEGER);
    INSERT INTO author_resolution_queue VALUES(1,'one',1,'worker','retry','','old failure','2099-01-01','','',NULL,3,2),(2,'two',1,'worker','pending','','','2099-01-01','',NULL,NULL,0,2);
    UPDATE author_resolution_queue SET resolved_target_id=NULL WHERE id=1;`);
  const due = db.prepare('SELECT * FROM author_resolution_queue').all(), retries = [];
  const database = { db, markAuthorResolutionRetry: (...args) => retries.push(args) };
  return { database, db, due, retries, options: { owner:'worker',retryAt:()=>new Date(Date.now()+3600_000).toISOString() } };
}
test('shared-lane busy defers all claimed items without attempts or anonymous fallback', async t => {
  const f=fixture(t); let calls=0;
  const result=await runAuthorisedQueueCycle(f.database,f.due,{...f.options,run:async()=>{calls++;return{status:'unavailable',code:'BROWSER_LANE_BUSY',attempted:false};}});
  assert.equal(calls,1);assert.equal(result.stopped,true);assert.deepEqual(result.legacy,[]);assert.equal(f.retries.length,0);
  const rows=f.db.prepare('SELECT * FROM author_resolution_queue ORDER BY id').all();
  assert.equal(rows[0].attempts,3); assert.equal(rows[1].attempts,0);assert.ok(rows.every(row=>row.lease_owner===null));
});
test('an earlier legacy item cannot run after a later gate', async t => {
  const f=fixture(t);
  const result=await runAuthorisedQueueCycle(f.database,f.due,{...f.options,run:async(_db,item)=>item.id===1
    ?{status:'skipped',code:'evidence_not_single',attempted:false}:{status:'unavailable',code:'challenge_required',attempted:true}});
  assert.deepEqual(result.legacy,[]);assert.equal(f.retries.length,0);
  assert.ok(f.db.prepare('SELECT lease_owner FROM author_resolution_queue').all().every(row=>row.lease_owner===null));
});
test('unattempted ambiguous original source does not consume network failure budget', async t => {
  const f=fixture(t);
  const result=await runAuthorisedQueueCycle(f.database,[f.due[0]],{...f.options,run:async()=>({status:'skipped',code:'source_ambiguous',attempted:false})});
  assert.equal(f.retries.length,0);assert.equal(result.stopped,false);assert.equal(result.legacy.length,0);
  assert.equal(f.db.prepare('SELECT attempts FROM author_resolution_queue WHERE id=1').get().attempts,3);
});
test('a real non-gate failure uses existing retry while successful admission is not reprocessed', async t => {
  const f=fixture(t);
  const result=await runAuthorisedQueueCycle(f.database,f.due,{...f.options,run:async(_db,item)=>item.id===1
    ?{status:'unavailable',code:'invalid_evidence',attempted:true}:{status:'resolved',attempted:true,monitoringChanged:true}});
  assert.equal(f.retries.length,1);assert.equal(f.retries[0][0],1);assert.equal(result.legacy.length,0);
  assert.equal(result.outcomes.length,2);
});
test('persisted identity rejection is terminal for this row but does not stop other accounts', async t => {
  const f=fixture(t);let calls=0;
  const result=await runAuthorisedQueueCycle(f.database,f.due,{...f.options,run:async(_db,item)=>{
    calls++;
    if(item.id===1){f.db.prepare("UPDATE author_resolution_queue SET status='rejected',lease_owner=NULL,lease_until=NULL WHERE id=1").run();
      return{status:'rejected',code:'AUTHOR_TARGET_PUBLIC_ID_CONFLICT',attempted:true};}
    return{status:'resolved',attempted:true,monitoringChanged:true};
  }});
  assert.equal(calls,2);assert.equal(result.stopped,false);assert.deepEqual(result.legacy,[]);
  assert.equal(f.retries.length,0);
  assert.equal(f.db.prepare('SELECT status FROM author_resolution_queue WHERE id=1').get().status,'rejected');
});
test('deferral is CAS-bound and cannot alter manual pauses, resolved or another lease', t => {
  const f=fixture(t), at=new Date(Date.now()+3600_000).toISOString();
  for(const sql of ["UPDATE author_resolution_queue SET lease_owner='other' WHERE id=1", "UPDATE author_resolution_queue SET lease_owner='worker',evidence_version=2 WHERE id=1",
    "UPDATE author_resolution_queue SET evidence_version=1,resolved_target_id=9 WHERE id=1", "UPDATE author_resolution_queue SET resolved_target_id=NULL,suspended_target_enabled=0 WHERE id=1"]) {
    f.db.exec(sql);assert.equal(deferAuthorisedQueueClaim(f.database,f.due[0],{owner:'worker',nextAttemptAt:at,reason:'wait'}),false);
  }
});
test('pre-cancelled batch does not start any provider work', async t => {
  const f=fixture(t),controller=new AbortController();controller.abort();
  const result=await runAuthorisedQueueCycle(f.database,f.due,{...f.options,signal:controller.signal,run:()=>assert.fail('Must not call')});
  assert.equal(result.stopped,true);assert.equal(result.outcomes.length,0);assert.equal(f.retries.length,0);
});
