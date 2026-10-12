import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {MonitorDatabase} from '../lib/database.mjs';
import {buildAuthorEvidenceRequests} from '../lib/author-resolution.mjs';
import {prepareQueuedAuthorisedImport,runQueuedAuthorisedImport} from '../lib/authorised-import-queue.mjs';
import {commitAuthorisedImportDetail} from '../lib/authorised-import-service.mjs';

const VIDEO='7690702905876096104',SEC='MS4wLjABAAAAQueueAdmissionFixture0001',HANDLE='queue_handle',UID='1234567890123456';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('queue rejects an overlong external key without persisting a truncated collision', t => {
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const key = `douyin:${'a'.repeat(301)}`;
  assert.throws(() => database.enqueueAuthorResolutions([{ key, name: '作者', videoIds: ['7684603502123456789'] }]), /超过 300 字符/);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS n FROM author_resolution_queue').get().n, 0);
});
function fixture(t,{share=false,metadata={sourceType:'author-spreadsheet'},requestExtras={}}={}) {
  const database=new MonitorDatabase(':memory:');t.after(()=>database.close());const db=database.db;
  const source={sourceRow:2,platform:'douyin',name:'来源作者',douyinId:HANDLE,status:'resolvable',
    videoId:share?'':VIDEO,...(share?{shareUrl:'https://v.douyin.com/ExactShare/',videoLink:'https://v.douyin.com/ExactShare/'}:{})};
  const request={fileName:'queue-test.xlsx',sheetName:'账号',rows:[source],...requestExtras};
  const jobId=randomUUID();
  database.createAuthorResolutionJob({id:jobId,actorName:'离线测试',fileName:request.fileName,sheetName:request.sheetName,request});
  db.prepare('UPDATE author_resolution_jobs SET created_at=? WHERE id=?').run(new Date(Date.now()-1000).toISOString(),jobId);
  const evidence=buildAuthorEvidenceRequests([source])[0];
  database.enqueueAuthorResolutions([evidence],{fileName:request.fileName,sheetName:request.sheetName,sourceMetadata:metadata});
  db.prepare("UPDATE author_resolution_jobs SET status='completed',finished_at=? WHERE id=?").run(new Date().toISOString(),jobId);
  const owner='queue-test-owner',claimed=database.claimDueAuthorResolutions(1,{owner,leaseMs:60000})[0];
  assert.ok(claimed);
  const job=database.getAuthorResolutionJob(jobId),row=()=>db.prepare('SELECT * FROM author_resolution_queue WHERE id=?').get(claimed.id);
  const input=(j,r)=>{assert.equal(j.id,jobId);return{type:'account',provider:'public-web',label:r.name,locator:r.locator,
    boards:r.boards,metadata:{platform:'douyin',resolution:r.resolution}};};
  const capture=()=>JSON.stringify(Object.fromEntries(['targets','snapshots','author_resolution_queue','author_resolution_jobs',
    'author_resolution_import_sources','author_resolution_success_receipts','activity_log'].map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
  const proof=input=>{
    const at=new Date().toISOString(),response={status_code:0,aweme_detail:{aweme_id:VIDEO,author:{sec_uid:SEC,uid:UID,unique_id:HANDLE}}};
    const responseSha256=hash(response),responseSha256Scope='public-identity-projection-v1';
    return{status:'ok',key:input.key,submittedId:HANDLE,videoId:VIDEO,...(share?{shareUrl:input.shareUrl}:{}),
      requestStartedAt:at,requestFinishedAt:at,
      candidate:{videoId:VIDEO,secUid:SEC,uid:UID,uniqueId:HANDLE,shortId:'',provenance:'authorised-browser-natural-detail',
        observedAt:at,responseSha256,responseSha256Scope},
      evidence:{version:1,kind:'natural-main-frame-detail-response',origin:'https://www.douyin.com',path:'/aweme/v1/web/aweme/detail/',
        method:'GET',httpStatus:200,requestedVideoId:VIDEO,observedAt:at,responseSha256,responseSha256Scope,response,
        ...(share?{requestedShareUrl:input.shareUrl,finalUrl:`https://www.douyin.com/video/${VIDEO}`,finalUrlSha256:'a'.repeat(64),
          finalUrlScope:'observed-origin-path',finalVideoId:VIDEO}:{})},
      provenance:{mode:'authorised-browser-natural-detail',authorisedSessionUsed:true,authenticated:null,authenticationStatus:'not-verified',
        noChallengeBypass:true,runtimeAI:false,paidAPI:false}};
  };
  return{database,db,source,request,evidence,job,owner,claimed,row,input,capture,proof};
}

test('queue preparation is read-only, bound to immutable receipt, completed job and exact leased evidence',t=>{
  const f=fixture(t),before=f.capture(),p=prepareQueuedAuthorisedImport(f.database,f.claimed,{owner:f.owner});
  assert.equal(p.status,'ready');assert.equal(p.sourceRow,2);assert.equal(p.job.id,f.job.id);
  assert.equal(p.input.key,f.evidence.key);assert.equal(p.input.submittedId,HANDLE);
  assert.equal(p.claim.evidenceVersion,f.claimed.evidence_version);assert.equal(p.claim.sourceRowSha256,hash(f.source));
  assert.equal(f.capture(),before);
});

test('queue run reuses existing lease/transaction and emits immutable proof without sampling or duplicate claims',async t=>{
  for(const share of [false,true]) {
    const f=fixture(t,{share});let calls=0;
    const sources=f.db.prepare('SELECT * FROM author_resolution_import_sources').all();
    const r=await runQueuedAuthorisedImport(f.database,f.claimed,{owner:f.owner,createInput:f.input,
      provider:{resolveAuthorisedDetail:async({items})=>{calls++;assert.equal(items.length,1);return f.proof(items[0]);}}});
    assert.equal(r.status,'resolved');assert.equal(r.monitoringChanged,true);assert.equal(calls,1);
    assert.equal(r.result.status,'ok');assert.equal(r.job.id,f.job.id);assert.equal(r.sourceRow,2);
    assert.equal(f.row().status,'resolved');assert.equal(f.row().lease_owner,null);assert.equal(f.row().attempts,0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM snapshots').get().n,0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM author_resolution_success_receipts').get().n,1);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM activity_log WHERE action='author-resolution.claimed'").get().n,1);
    assert.deepEqual(f.db.prepare('SELECT * FROM author_resolution_import_sources').all(),sources);
    assert.equal(f.db.isTransaction,false);
    assert.equal(prepareQueuedAuthorisedImport(f.database,f.claimed,{owner:f.owner}).status,'skipped');
  }
});

test('missing/changed owner, expiry, policy, evidence, prior target and manual suspension cannot launch',async t=>{
  for(const [sql,code] of [
    ["lease_owner='other'",'claim_stale'],["lease_until='invalid-date'",'claim_stale'],
    ["lease_until='2000-01-01T00:00:00.000Z'",'claim_stale'],['evidence_version=evidence_version+1','claim_stale'],
    ['verification_policy_version=1','queue_not_eligible'],["status='rejected'",'queue_not_eligible'],
    ['suspended_target_enabled=0','queue_not_eligible'],['suspended_target_enabled=1','queue_not_eligible'],
    ["video_ids_json='[]'",'evidence_not_single'],["share_urls_json='[\"https://v.douyin.com/OtherShare/\"]'",'evidence_not_single'],
  ]) {
    const f=fixture(t);f.db.exec(`UPDATE author_resolution_queue SET ${sql}`);const before=f.capture();
    const r=await runQueuedAuthorisedImport(f.database,f.claimed,{owner:f.owner,createInput:f.input,
      provider:{resolveAuthorisedDetail:()=>assert.fail('must not launch')}});
    assert.equal(r.status,'skipped');assert.equal(r.code,code);assert.equal(f.capture(),before);
  }
});

test('source lookup rejects absent/tampered receipt, mismatched hash, wrong row or outside-job sampling time',t=>{
  for(const sql of [
    'DELETE FROM author_resolution_import_sources',
    "UPDATE author_resolution_import_sources SET receipt_sha256='bad'",
    "UPDATE author_resolution_import_sources SET observed_at='2000-01-01T00:00:00.000Z'",
    "UPDATE author_resolution_jobs SET status='running'",
    "UPDATE author_resolution_jobs SET file_name='other.xlsx'",
    "UPDATE author_resolution_queue SET source_rows_json='[3]'",
  ]) {
    const f=fixture(t);f.db.exec(sql);const before=f.capture();
    assert.equal(prepareQueuedAuthorisedImport(f.database,f.claimed,{owner:f.owner}).code,'source_unavailable');
    assert.equal(f.capture(),before);
  }
  const f=fixture(t,{metadata:{sourceType:'author-spreadsheet',sourceSha256:'a'.repeat(64)},requestExtras:{sourceSha256:'b'.repeat(64)}});
  assert.equal(prepareQueuedAuthorisedImport(f.database,f.claimed,{owner:f.owner}).code,'source_unavailable');
});

test('two original jobs with conflicting original rows are held rather than newest selected',t=>{
  const f=fixture(t),second=randomUUID();
  f.database.createAuthorResolutionJob({id:second,actorName:'offline',fileName:f.job.fileName,sheetName:f.job.sheetName,
    request:{...f.request,rows:[{...f.source,name:'different original row'}]}});
  f.db.prepare("UPDATE author_resolution_jobs SET status='completed',created_at=?,finished_at=? WHERE id=?")
    .run(f.job.createdAt,f.job.finishedAt,second);
  assert.equal(prepareQueuedAuthorisedImport(f.database,f.claimed,{owner:f.owner}).code,'source_ambiguous');
});

test('invalid master-roster supplement context is rechecked before launch and inside the write transaction',async t=>{
  const f=fixture(t,{requestExtras:{masterRosterSupplement:{version:1,purpose:'master-roster-supplement',entryKey:'missing-entry'}}});
  const before=f.capture(),r=await runQueuedAuthorisedImport(f.database,f.claimed,{owner:f.owner,createInput:f.input,
    provider:{resolveAuthorisedDetail:()=>assert.fail('stale source context must not launch')}});
  assert.equal(r.status,'skipped');assert.equal(r.code,'source_context_stale');assert.equal(f.capture(),before);
  const receipt=f.db.prepare('SELECT receipt_sha256 FROM author_resolution_import_sources').get();
  const claim={owner:f.owner,queueId:f.claimed.id,evidenceVersion:f.claimed.evidence_version,
    sourceReceiptSha256:receipt.receipt_sha256,sourceRowSha256:hash(f.source)};
  const result=f.proof({key:f.evidence.key,videoId:VIDEO});
  assert.throws(()=>commitAuthorisedImportDetail(f.database,f.job,{sourceRow:2},result,{startedAt:result.requestStartedAt,
    finishedAt:result.requestFinishedAt,existingClaim:claim,createInput:row=>f.input(f.job,row)}),{code:'AUTHORISED_ADMISSION_STALE'});
  assert.equal(f.capture(),before);assert.equal(f.db.isTransaction,false);
});

test('busy/gate/session/invalid response does not use anonymous fallback, mutate retry budget or release caller leases',async t=>{
  for(const code of ['BROWSER_LANE_BUSY','BROWSER_LANE_LOCKED','blocked','challenge_required','session_required','cleanup_uncertain','invalid_evidence']) {
    const f=fixture(t),before=f.capture();let calls=0;
    const r=await runQueuedAuthorisedImport(f.database,f.claimed,{owner:f.owner,createInput:f.input,provider:{
      resolveAuthors:()=>assert.fail('no legacy fallback'),
      resolveAuthorisedDetail:async({items:[input]})=>{calls++;if(code.startsWith('BROWSER'))throw Object.assign(new Error('PRIVATE_COOKIE'),{code});
        const at=new Date().toISOString();return{status:'unavailable',key:input.key,submittedId:input.submittedId,videoId:input.videoId,
          requestStartedAt:at,requestFinishedAt:at,errorCode:code,secret:'PRIVATE_COOKIE'};},
    }});
    assert.equal(r.status,'unavailable');assert.equal(r.code,code);assert.equal(calls,1);assert.equal(f.capture(),before);
    assert.doesNotMatch(JSON.stringify(r),/PRIVATE_COOKIE/);
  }
});

test('cancellation before and after provider cannot commit or modify caller-owned leases',async t=>{
  for(const beforeCall of [false,true]) {
    const f=fixture(t),before=f.capture(),controller=new AbortController();let calls=0;
    if(beforeCall)controller.abort();
    const r=await runQueuedAuthorisedImport(f.database,f.claimed,{owner:f.owner,signal:controller.signal,createInput:f.input,
      provider:{resolveAuthorisedDetail:async({items:[input]})=>{calls++;const result=f.proof(input);controller.abort();return result;}}});
    assert.equal(r.code,'cancelled');assert.equal(calls,beforeCall?0:1);assert.equal(f.capture(),before);
  }
});

test('in-flight owner/evidence/source mutation fails transaction admission; retained receipt must match exact prepared hash',async t=>{
  for(const kind of ['owner','version','source','job']) {
    const f=fixture(t);
    const r=await runQueuedAuthorisedImport(f.database,f.claimed,{owner:f.owner,createInput:f.input,provider:{resolveAuthorisedDetail:async({items:[input]})=>{
      if(kind==='owner')f.db.exec("UPDATE author_resolution_queue SET lease_owner='other'");
      if(kind==='version')f.db.exec('UPDATE author_resolution_queue SET evidence_version=evidence_version+1');
      if(kind==='source')f.db.exec("UPDATE author_resolution_import_sources SET receipt_sha256='bad'");
      if(kind==='job')f.db.exec("UPDATE author_resolution_jobs SET request_json='{}'");
      return f.proof(input);
    }}});
    assert.equal(r.status,'unavailable');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM targets').get().n,0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM author_resolution_success_receipts').get().n,0);assert.equal(f.db.isTransaction,false);
  }
});

test('existing-claim service refuses forged source, other sibling lease and exhausted rejected revival',t=>{
  for(const mutation of ['source','sibling','rejected']) {
    const f=fixture(t),p=prepareQueuedAuthorisedImport(f.database,f.claimed,{owner:f.owner});
    if(mutation==='source')p.claim.sourceRowSha256='0'.repeat(64);
    if(mutation==='rejected')f.db.exec("UPDATE author_resolution_queue SET status='rejected',attempts=7,last_error='达到公开核验重试上限；HTTP 403'");
    if(mutation==='sibling'){
      const other=buildAuthorEvidenceRequests([{...f.source,sourceRow:3,videoId:'7690702905876096105'}])[0];
      f.database.enqueueAuthorResolutions([other],{fileName:f.job.fileName,sheetName:f.job.sheetName,sourceMetadata:{}});
      f.db.prepare("UPDATE author_resolution_queue SET lease_owner='other',lease_until=? WHERE identity_key=?")
        .run(new Date(Date.now()+60000).toISOString(),other.key);
    }
    const before=f.capture(),proof=f.proof(p.input);
    assert.throws(()=>commitAuthorisedImportDetail(f.database,p.job,{sourceRow:p.sourceRow},proof,{startedAt:proof.requestStartedAt,
      finishedAt:proof.requestFinishedAt,existingClaim:p.claim,createInput:row=>f.input(p.job,row)}));
    assert.equal(f.capture(),before);assert.equal(f.db.isTransaction,false);
  }
});
