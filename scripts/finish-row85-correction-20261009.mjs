// One explicitly reviewed correction only; reuse the application's guarded admission.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { prepareImportAuthorisedDetail } from '../lib/import-authorised-detail.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)), origin='http://127.0.0.1:4188';
const jobId='e4e1c6dc-0550-45da-ba0e-ffc65baf6f31';
const db=new DatabaseSync(root+'data/douyin-monitor.sqlite',{readOnly:true});
let alreadyResolved=false;
try {
  const stored=db.prepare('SELECT * FROM author_resolution_jobs WHERE id=?').get(jobId);
  assert.equal(stored.status,'completed');
  const job={id:jobId,status:stored.status,request:JSON.parse(stored.request_json)};
  assert.deepEqual(job.request.masterRosterSupplement.correction,{originalAccountId:'没有后悔药',correctedAccountId:'51058454595'});
  const input=prepareImportAuthorisedDetail(job,{sourceRow:2});
  assert.equal(input.shareUrl,'https://v.douyin.com/xglrKXGaNFU/');
  const queue=db.prepare('SELECT * FROM author_resolution_queue WHERE identity_key=?').get(input.key);
  assert.ok(queue); alreadyResolved=queue.status==='resolved';
  if(!alreadyResolved) {
    assert.equal(queue.status,'pending'); assert.equal(queue.attempts,0);
    assert.equal(queue.lease_owner,null); assert.equal(queue.resolved_target_id,null);
    assert.equal(db.prepare("SELECT count(*) n FROM runs WHERE status IN ('running','queued')").get().n,0);
    assert.equal(db.prepare('SELECT count(*) n FROM author_resolution_queue WHERE lease_owner IS NOT NULL').get().n,0);
  }
} finally {db.close();}
if(alreadyResolved) { console.log('Already resolved; no repeat request'); process.exit(0); }
const response=await fetch(origin+'/api/auth/session'),auth=await response.json();assert.equal(auth.user.role,'admin');
const headers={Cookie:response.headers.get('set-cookie').split(';')[0],Origin:origin,'X-CSRF-Token':auth.csrfToken,'Content-Type':'application/json'};
const startedAt=new Date().toISOString();
const reply=await fetch(origin+`/api/author-spreadsheet/jobs/${jobId}/authorised-monitor`,{
  method:'POST',headers,body:JSON.stringify({sourceRow:2}),signal:AbortSignal.timeout(55000),redirect:'error'});
const data=await reply.json(),path=root+'data/maintenance-journal/20261009-id-correction/row85-admission-'+Date.now()+'.json';
await writeFile(path,JSON.stringify({startedAt,finishedAt:new Date().toISOString(),status:reply.status,data},null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({path,status:reply.status,result:data.result?.status,code:data.code??data.result?.errorCode,
  monitoringChanged:data.monitoringChanged,targetId:data.admission?.target?.id}));
assert.equal(reply.status,200);assert.equal(data.result.status,'ok');assert.equal(data.admission.target.id,2289);
