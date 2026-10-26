import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {readImportMonitoringStatus} from '../lib/import-monitoring-status.mjs';
import {prepareImportAuthorisedDetail} from '../lib/import-authorised-detail.mjs';
import {classifyAuthorisedRetryEligibility} from '../lib/authorised-retry-eligibility.mjs';

// A bounded, single-lane import operation, not a daemon or a new schedule.
const jobId='c9895a58-14ef-4f1f-8c88-428fb3ce8d6f',origin='http://127.0.0.1:4188';
const mode=process.argv[2] || 'plan',limit=Number(process.argv[3] || 394);
assert.ok(['plan','run'].includes(mode));assert.ok(Number.isSafeInteger(limit)&&limit>0&&limit<=394);
// Optional operator-reviewed original rows exclude their entire evidence keys,
// not just row numbers: copied registrations may repeat the same failed work.
const omittedRows=process.argv[4] ? process.argv[4].split(',').map(Number) : [];
assert.ok(omittedRows.every(row=>Number.isSafeInteger(row)&&row>0));
// Optional explicit original rows for a separately reviewed alternate-source
// pass. This cannot broaden the existing source / queue / admission checks.
const requestedRows=process.argv[5] ? process.argv[5].split(',').map(Number) : [];
assert.ok(requestedRows.every(row=>Number.isSafeInteger(row)&&row>0));
assert.equal(new Set(requestedRows).size,requestedRows.length);
const root=new URL('../',import.meta.url).pathname;
const output=root+'data/maintenance-journal/20261009-author-detail-investigation/batch-'+Date.now()+'/';
await mkdir(output,{recursive:true,mode:0o700});
const save=(name,value)=>writeFile(output+name+'.json',JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const normalize=v=>String(v??'').normalize('NFKC').trim().replace(/^@/,'').toLowerCase();
const db=new DatabaseSync(root+'data/douyin-monitor.sqlite',{readOnly:true});
let job,before,items,omittedKeys;
try {
  db.exec('PRAGMA query_only=ON; BEGIN');
  const stored=db.prepare('SELECT * FROM author_resolution_jobs WHERE id=?').get(jobId);
  job={id:stored.id,status:stored.status,fileName:stored.file_name,sheetName:stored.sheet_name,request:JSON.parse(stored.request_json)};
  omittedKeys=new Set(omittedRows.map(sourceRow=>prepareImportAuthorisedDetail(job,{sourceRow}).key));
  const first=readImportMonitoringStatus(db,job,{status:'pending',limit:100}),pending=[...first.items];before=first.counts;
  for(let offset=100;offset<first.pagination.total;offset+=100) pending.push(...readImportMonitoringStatus(db,job,{status:'pending',limit:100,offset}).items);
  const ids=new Set(pending.map(i=>normalize(i.submittedId))),byId=new Map();
  for(const row of [...job.request.rows].sort((a,b)=>b.sourceRow-a.sourceRow)) {
    if(requestedRows.length && !requestedRows.includes(row.sourceRow))continue;
    if(!ids.has(normalize(row.douyinId))) continue;
    let input;try{input=prepareImportAuthorisedDetail(job,{sourceRow:row.sourceRow})}catch{continue}
    if(omittedKeys.has(input.key))continue;
    const queue=db.prepare('SELECT * FROM author_resolution_queue WHERE identity_key=?').get(input.key);
    if(!queue || queue.verification_policy_version!==2 || queue.resolved_target_id!==null || queue.suspended_target_enabled!==null) continue;
    const retry=classifyAuthorisedRetryEligibility(queue);
    if(!['pending','retry'].includes(queue.status)&&!retry.allowed)continue;
    const videos=JSON.parse(queue.video_ids_json),shares=JSON.parse(queue.share_urls_json);
    if(input.videoId ? videos.length!==1 || videos[0]!==input.videoId || shares.length!==0
      : videos.length!==0 || shares.length!==1 || shares[0]!==input.shareUrl)continue;
    const candidate={submittedId:input.submittedId,sourceRow:row.sourceRow,key:input.key,queueId:queue.id,
      queueStatus:queue.status,kind:input.videoId?'direct':'share',retryCode:retry.allowed?retry.code:null};
    const existing=byId.get(input.submittedId);
    if(!existing || (existing.queueStatus==='rejected'&&candidate.queueStatus!=='rejected'))byId.set(input.submittedId,candidate);
  }
  items=[...byId.values()].sort((a,b)=>(a.queueStatus==='rejected')-(b.queueStatus==='rejected') || a.sourceRow-b.sourceRow).slice(0,limit);
  assert.equal(db.prepare('SELECT total_changes() n').get().n,0);
}finally{db.exec('ROLLBACK');db.close()}
await save('plan',{at:new Date().toISOString(),jobId,before,items,selected:items.length,operatorReviewedSourceRows:requestedRows,operatorReviewedOmissions:{sourceRows:omittedRows,keys:[...omittedKeys]}});
console.log(JSON.stringify({output,before,selected:items.length,mode}));
if(mode==='plan')process.exit(0);
const auth=await fetch(origin+'/api/auth/session',{redirect:'error',signal:AbortSignal.timeout(3000)}),session=await auth.json();
assert.equal(auth.status,200);assert.equal(session.authenticated,true);assert.equal(session.user.role,'admin');
const cookie=(auth.headers.get('set-cookie')||'').split(';')[0];assert.ok(cookie && typeof session.csrfToken==='string' && session.csrfToken.length>10);
const headers={Cookie:cookie,Origin:origin,'X-CSRF-Token':session.csrfToken,'Content-Type':'application/json'};
const results=[],stopCodes=new Set(['login_required','session_required','session_permissions','session_invalid','challenge_required','rate_limited','blocked','cleanup_uncertain',
  'disabled','ownership_required','browser_unavailable','invalid_input','cancelled','collector_error']);
// A source-specific invalid identity payload is quarantined without binding.
// It does not authorize replay or weaker validation. Explicit access barriers,
// transport/protocol failure and uncertain cleanup still stop this whole run.
const deadline=Date.now()+45*60_000;
let stopped=null,consecutiveInvalidEvidence=0;
for(const item of items) {
  if(Date.now()>=deadline){stopped='bounded-operation-deadline';break;}
  let outcome;
  for(let attempt=0;attempt<10;attempt++) {
    if(Date.now()>=deadline){outcome={status:0,error:'bounded-operation-deadline'};break;}
    const at=new Date().toISOString();
    try {
      const response=await fetch(origin+`/api/author-spreadsheet/jobs/${jobId}/authorised-monitor`,{
        method:'POST',headers,redirect:'error',body:JSON.stringify({sourceRow:item.sourceRow}),signal:AbortSignal.timeout(55000)});
      const data=await response.json();outcome={...item,attempt:attempt+1,at,finishedAt:new Date().toISOString(),status:response.status,data};
    }catch(error){outcome={...item,attempt:attempt+1,at,finishedAt:new Date().toISOString(),status:0,error:'local-request-incomplete'};}
    await save('row-'+item.sourceRow+'-attempt-'+(attempt+1),outcome);
    const busy=(outcome.status===429 && outcome.data?.error==='单项核验正在运行或冷却中，请稍后再试')
      || (outcome.status===409 && outcome.data?.error==='采集通道正在使用或等待安全清理，请稍后再试');
    outcome.localBusy=busy;
    if(!busy)break;
    await new Promise(resolve=>setTimeout(resolve,5200));
  }
  if(outcome.status===200 && (outcome.data?.jobId!==jobId || outcome.data?.sourceRow!==item.sourceRow
    || outcome.data?.result?.key!==item.key || !['ok','unavailable'].includes(outcome.data?.result?.status)
    || normalize(outcome.data?.result?.submittedId)!==item.submittedId
    || (outcome.data?.result?.status==='ok' && outcome.data?.monitoringChanged!==true)
    || (outcome.data?.result?.status==='unavailable' && (outcome.data?.monitoringChanged!==false
      || outcome.data?.result?.candidate!==undefined || outcome.data?.result?.evidence!==undefined || outcome.data?.admission!==undefined))
    || (outcome.data?.monitoringChanged===true && (outcome.data?.admission?.status!=='committed'
      || !Number.isSafeInteger(outcome.data?.admission?.target?.id) || typeof outcome.data?.admission?.target?.enabled!=='boolean')))) {
    outcome.error='invalid-local-response';
  }
  const summary={sourceRow:item.sourceRow,submittedId:item.submittedId,status:outcome.status,
    monitoringChanged:outcome.data?.monitoringChanged===true,targetId:outcome.data?.admission?.target?.id??null,
    monitoringEnabled:outcome.data?.admission?.target?.enabled??null,
    code:outcome.error??outcome.data?.result?.errorCode??outcome.data?.code??null};
  results.push(summary);console.log(JSON.stringify(summary));
  consecutiveInvalidEvidence=summary.code==='invalid_evidence'?consecutiveInvalidEvidence+1:0;
  if(consecutiveInvalidEvidence>=3){stopped='repeated-invalid-evidence-review-required';break;}
  if(outcome.status===409 && String(summary.code).startsWith('AUTHORISED_ADMISSION_')){stopped=summary.code;break;}
  if(stopCodes.has(summary.code)||outcome.error||outcome.localBusy||outcome.status===429||outcome.status===0||outcome.status>=500||outcome.status===401||outcome.status===403) {stopped=summary.code||'authorization-or-transport';break;}
  await new Promise(resolve=>setTimeout(resolve,5200));
}
const report={at:new Date().toISOString(),jobId,selected:items.length,attempted:results.length,
  committed:results.filter(r=>r.monitoringChanged).length,stopped,results};
await save('summary',report);console.log(JSON.stringify({output,...report,results:undefined}));
