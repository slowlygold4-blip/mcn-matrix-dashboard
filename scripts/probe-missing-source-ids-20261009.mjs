// Read-only author discovery for five reviewed original invalid-ID source rows.
// No jobs, queues, targets, monitoring state, or historical samples are changed.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';
import { prepareImportWorkAuthorCandidate } from '../lib/douyin-work-author-candidate.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const jobId='c9895a58-14ef-4f1f-8c88-428fb3ce8d6f';
const allowedRows=[294,336,1532,1724,2045];
const sourceRows=process.argv[3]?process.argv[3].split(',').map(Number):allowedRows;
assert.ok(sourceRows.length>0&&sourceRows.every(row=>allowedRows.includes(row))&&new Set(sourceRows).size===sourceRows.length);
const mode=process.argv[2]??'plan';assert.ok(['plan','run'].includes(mode));
const db=new DatabaseSync(root+'data/douyin-monitor.sqlite',{readOnly:true});
let plan;
try {
  const saved=db.prepare('SELECT id,status,request_json FROM author_resolution_jobs WHERE id=?').get(jobId);
  const job={id:jobId,status:saved.status,request:JSON.parse(saved.request_json)};
  plan=sourceRows.map(sourceRow=>({sourceRow,original:job.request.rows.find(row=>row.sourceRow===sourceRow),input:prepareImportWorkAuthorCandidate(job,{sourceRow})}));
} finally { db.close(); }
if(mode==='plan') {console.log(JSON.stringify(plan.map(value=>({sourceRow:value.sourceRow,submittedId:value.original.douyinId,input:value.input}))));process.exit(0);}
const output=root+'data/maintenance-journal/20261009-id-correction/candidate-discovery-'+Date.now()+'/';
await mkdir(output,{recursive:true,mode:0o700});
const save=(name,value)=>writeFile(output+name+'.json',JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
await save('plan',{startedAt:new Date().toISOString(),jobId,plan,writeAuthority:'none'});
const stop=new Set(['blocked','rate_limited','challenge_required','login_required','session_required','session_permissions','session_invalid',
  'cleanup_uncertain','cancelled','collector_error','WORK_AUTHOR_CANDIDATE_UNVERIFIED','BROWSER_LANE_BUSY','BROWSER_LANE_LOCKED']);
const summaries=[];let reason=null;
for(const item of plan) {
  const check=new DatabaseSync(root+'data/douyin-monitor.sqlite',{readOnly:true});
  let busy;
  try {busy=check.prepare("SELECT count(*) n FROM runs WHERE status IN ('running','queued')").get().n
    +check.prepare('SELECT count(*) n FROM author_resolution_queue WHERE lease_owner IS NOT NULL').get().n;} finally {check.close();}
  if(busy){reason='local-operation-active-no-probe';break;}
  const provider=new PublicWebProvider({}, {workAuthorCandidateEnabled:true,signal:AbortSignal.timeout(55000)});
  const startedAt=new Date().toISOString();let result;
  try { result=await provider.resolveWorkAuthorCandidate({items:[item.input]}); }
  catch(error) {result={status:'unavailable',errorCode:stop.has(error.code)?error.code:'collector_error'};}
  const report={sourceRow:item.sourceRow,originalSubmittedId:item.original.douyinId,startedAt,finishedAt:new Date().toISOString(),
    input:item.input,result,monitoringChanged:false,submittedIdentityVerified:false};
  await save('row-'+item.sourceRow,report);
  const summary={sourceRow:item.sourceRow,status:result.status,errorCode:result.errorCode,
    ...(result.status==='candidate-only'?{publicId:result.candidate.uniqueId||result.candidate.shortId}:{}),monitoringChanged:false};
  summaries.push(summary);console.log(JSON.stringify(summary));
  if(stop.has(result.errorCode)){reason=result.errorCode;break;}
}
await save('summary',{finishedAt:new Date().toISOString(),planned:plan.length,attempted:summaries.length,stopped:reason,summaries,
  monitoringChanged:false,newTargets:0,newSnapshots:0});
console.log(JSON.stringify({output,attempted:summaries.length,stopped:reason}));
