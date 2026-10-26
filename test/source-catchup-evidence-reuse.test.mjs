import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildAuthorEvidenceRequests } from '../lib/author-resolution.mjs';
import { planStoredEvidenceReuse, applyStoredEvidenceReuse, applyWithExclusiveReceipt } from '../scripts/reuse-source-catchup-evidence.mjs';

const SEC='MS4wLjABAAAAabcdefghijklmnopqrstuvwx', SHARE='https://v.douyin.com/ExactCase/';
function table(db, name, rows) {
  const columns=Object.keys(rows[0]);
  db.exec(`CREATE TABLE ${name} (${columns.map(k=>`${k} ${typeof rows[0][k]==='number'?'INTEGER':'TEXT'}`).join(',')})`);
  const insert=db.prepare(`INSERT INTO ${name} VALUES (${columns.map(()=>'?').join(',')})`);
  for(const row of rows) insert.run(...columns.map(k=>row[k]??null));
}
function fixture(t) {
  const db=new DatabaseSync(':memory:'), before=new DatabaseSync(':memory:');
  t.after(()=>{db.close();before.close();});
  const row={sourceRow:2,name:'作者',platform:'douyin',douyinId:'public_id',locator:SEC,shareUrl:SHARE,status:'unresolved'};
  const key=buildAuthorEvidenceRequests([row])[0].key;
  const request={sourceUrl:'https://fixture.feishu.cn/sheets/Known?sheet=A',sourceRevision:9,sourceSha256:'a'.repeat(64)};
  const target={id:20,type:'account',provider:'public-web',label:'用户修改的别名',locator:SEC,enabled:0,
    metadata_json:JSON.stringify({platform:'douyin',resolution:{platform:'douyin',mode:'public-video-detail',publicDouyinId:'public_id',canonicalAccountId:SEC}})};
  const prior={id:1,identity_key:'legacy-key',name:'作者',douyin_id:'public_id',account_locator:SEC,video_ids_json:'[]',share_urls_json:JSON.stringify([SHARE]),status:'resolved',resolved_target_id:20,
    verification_policy_version:2,evidence_version:3,updated_at:'2026-09-27T19:00:00.000Z',created_at:'2026-09-20T00:00:00.000Z',lease_owner:null,lease_until:null,suspended_target_enabled:null,
    source_metadata_json:'{}',last_error:null};
  const incoming={...prior,id:2,identity_key:key,status:'pending',resolved_target_id:null,created_at:'2026-09-27T20:47:00.000Z',updated_at:'2026-09-27T20:47:00.000Z',source_metadata_json:JSON.stringify(request),evidence_version:1};
  for(const d of [db,before]){table(d,'targets',[target]);table(d,'target_boards',[{target_id:20,board_key:'团团',category:'用户保留标签'}]);table(d,'snapshots',[{id:1,captured_at:'2026-09-27T18:00:00.000Z',followers:555}]);}
  table(before,'author_resolution_queue',[prior]);table(db,'author_resolution_queue',[prior,incoming]);
  table(db,'author_resolution_jobs',[{id:'job',status:'completed',created_at:'2026-09-27T20:47:00.000Z',request_json:JSON.stringify(request),result_json:JSON.stringify({skipped:[row]})}]);
  const scope={createdAfter:'2026-09-27T20:40:21.000Z',board:'团团',jobIds:['job'],maxCandidates:10};
  return {db,before,scope,plan:()=>planStoredEvidenceReuse(db,before,scope),saved:()=>({target:db.prepare('SELECT * FROM targets').all(),boards:db.prepare('SELECT * FROM target_boards').all(),snapshots:db.prepare('SELECT * FROM snapshots').all(),prior:db.prepare('SELECT * FROM author_resolution_queue WHERE id=1').get()})};
}

test('dry-run uses strict stored proof without mutating any table; apply preserves paused account, user boards and historical samples', t=>{
  const f=fixture(t), original=f.saved(), beforeRow=f.db.prepare('SELECT * FROM author_resolution_queue WHERE id=2').get();
  const plan=f.plan();assert.equal(plan.reusable.length,1);assert.equal(plan.newPublicCollection,false);
  assert.deepEqual(f.saved(),original);assert.deepEqual(f.db.prepare('SELECT * FROM author_resolution_queue WHERE id=2').get(),beforeRow);
  const applied=applyStoredEvidenceReuse(f.db,f.before,plan);assert.equal(applied.resolvedCount,1);
  assert.deepEqual(f.saved(),original);
  const row=f.db.prepare('SELECT * FROM author_resolution_queue WHERE id=2').get();
  assert.equal(row.status,'resolved');assert.equal(row.resolved_target_id,20);
  const provenance=JSON.parse(row.source_metadata_json).evidenceReuse;
  assert.equal(provenance.newPublicCollection,false);assert.equal(provenance.verifiedAt,'2026-09-27T19:00:00.000Z');
  assert.equal(provenance.approvedPlanSha256,plan.planSha256);
  assert.throws(()=>applyStoredEvidenceReuse(f.db,f.before,plan),/changed/);
});

test('active or dangling leases, changed pause state, missing membership and changed source fingerprints are excluded', t=>{
  for(const sql of ["UPDATE author_resolution_queue SET lease_owner='worker' WHERE id=2", "UPDATE author_resolution_queue SET lease_until='2026-09-28T00:00:00Z' WHERE id=2",
    'UPDATE targets SET enabled=1', "UPDATE targets SET locator='MS4wLjABAAAAotheraccount000000000000'", 'DELETE FROM target_boards',
    "UPDATE author_resolution_queue SET source_metadata_json='{}' WHERE id=2", "UPDATE author_resolution_queue SET status='rejected' WHERE id=1"]){
    const f=fixture(t);f.db.exec(sql);assert.equal(f.plan().reusable.length,0,sql);
  }
});

test('unverified malicious URLs, changed ID and missing work evidence never reuse an old author identity', t=>{
  for(const [column,value] of [['share_urls_json',JSON.stringify(['https://evil.example/ExactCase/'])],['share_urls_json',JSON.stringify([SHARE.toLowerCase()])],
    ['share_urls_json',JSON.stringify([SHARE,'https://v.douyin.com/Another/'])],['douyin_id','other_public_id'],['video_ids_json',JSON.stringify(['7684617087687331118'])]]){
    const f=fixture(t);f.db.prepare(`UPDATE author_resolution_queue SET ${column}=? WHERE id=2`).run(value);assert.equal(f.plan().reusable.length,0);
  }
});

test('reviewed plan fails closed on queue/source CAS drift and rolls back a failing normal completion', t=>{
  const f=fixture(t),plan=f.plan();f.db.exec('UPDATE author_resolution_queue SET evidence_version=2 WHERE id=2');
  assert.throws(()=>applyStoredEvidenceReuse(f.db,f.before,plan),/changed/);assert.equal(f.db.prepare('SELECT status FROM author_resolution_queue WHERE id=2').get().status,'pending');
  const g=fixture(t),fresh=g.plan();g.db.exec("CREATE TRIGGER refuse_reuse BEFORE UPDATE OF source_metadata_json ON author_resolution_queue WHEN NEW.id=2 BEGIN SELECT RAISE(ABORT,'fixture provenance failure'); END");
  assert.throws(()=>applyStoredEvidenceReuse(g.db,g.before,fresh),/fixture provenance failure/);
  assert.equal(g.db.prepare('SELECT status FROM author_resolution_queue WHERE id=2').get().status,'pending');
  assert.equal(g.db.prepare('SELECT resolved_target_id FROM author_resolution_queue WHERE id=2').get().resolved_target_id,null);
});

test('queue key from one job cannot borrow the source fingerprint from another in-scope job', t=>{
  const f=fixture(t);const original=f.db.prepare('SELECT * FROM author_resolution_jobs WHERE id=?').get('job');
  const otherSource={...JSON.parse(original.request_json),sourceUrl:'https://fixture.feishu.cn/sheets/Other',sourceSha256:'b'.repeat(64)};
  f.db.prepare('INSERT INTO author_resolution_jobs VALUES (?,?,?,?,?)').run('other','completed',original.created_at,JSON.stringify(otherSource),JSON.stringify({skipped:[]}));
  f.db.prepare('UPDATE author_resolution_queue SET source_metadata_json=? WHERE id=2').run(JSON.stringify(otherSource));
  const p=planStoredEvidenceReuse(f.db,f.before,{...f.scope,jobIds:['job','other']});
  assert.equal(p.reusable.length,0);assert.equal(p.excluded[0].reason,'source-fingerprint-mismatch');
});

test('receipt collision or unwritable directory aborts before queue completion', async t=>{
  const f=fixture(t),plan=f.plan(),dir=await mkdtemp(join(tmpdir(),'mcn-reuse-receipt-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'receipt.json');await writeFile(path,'existing receipt');
  await assert.rejects(applyWithExclusiveReceipt(f.db,f.before,plan,path),{code:'EEXIST'});
  await assert.rejects(applyWithExclusiveReceipt(f.db,f.before,plan,join(dir,'missing','receipt.json')),{code:'ENOENT'});
  assert.equal(f.db.prepare('SELECT status FROM author_resolution_queue WHERE id=2').get().status,'pending');
});

test('source receipts need trusted HTTPS sheets, explicit safe positive revision and SHA-256', t=>{
  for(const patch of [{sourceUrl:'https://evil.example/sheets/Known'}, {sourceUrl:'http://fixture.feishu.cn/sheets/Known'},
    {sourceUrl:'https://user:password@fixture.feishu.cn/sheets/Known'}, {sourceRevision:0}, {sourceRevision:Number.MAX_SAFE_INTEGER+1},
    {sourceRevision:'9'}, {sourceRevision:null}, {sourceSha256:''}]){
    const f=fixture(t);const job=f.db.prepare('SELECT request_json FROM author_resolution_jobs WHERE id=?').get('job');
    f.db.prepare('UPDATE author_resolution_jobs SET request_json=? WHERE id=?').run(JSON.stringify({...JSON.parse(job.request_json),...patch}),'job');
    assert.throws(()=>f.plan(),/valid trusted source evidence/);
    assert.equal(f.db.prepare('SELECT status FROM author_resolution_queue WHERE id=2').get().status,'pending');
  }
});
