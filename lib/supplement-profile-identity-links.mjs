import {createHash} from 'node:crypto';
import {validateSubmittedAccountId} from './author-spreadsheet.mjs';
import {readStoredDouyinProfileIdentityMatches} from './profile-identity-proof.mjs';
import {verifyAdmittedProfileIdentity,retainUncontestedProfileLinks} from './creator-profile-identity-links.mjs';

export const SUPPLEMENT_PROFILE_LINK_TABLE='supplement_profile_identity_receipts';
const digest=value=>createHash('sha256').update(value).digest('hex');
const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
export const submittedIdentity=value=>{
 const text=typeof value==='string'?value:Number.isSafeInteger(value)&&value>0?String(value):'';
 return validateSubmittedAccountId(text,'douyin').value.normalize('NFKC').toLowerCase();
};
const time=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?Date.parse(value):NaN;
const sourceBinding=source=>({jobId:source.job.id,key:source.key,requestSha256:digest(source.job.request_json),
 createdAt:source.job.created_at,finishedAt:source.job.finished_at});
const pair=row=>`${row.matched_id}:${row.target_id}`;
function sourceRecords(sources){
 return sources.map(source=>({source,binding:sourceBinding(source),ids:new Set(source.request.rows
  .filter(row=>row?.platform==='douyin').map(row=>submittedIdentity(row.douyinId)).filter(Boolean))}));
}
const reservation=(links)=>{
 const map=new Map();for(const link of links){const set=map.get(link.target_id)||new Set();set.add(submittedIdentity(link.matched_id));map.set(link.target_id,set);}return map;
};
const conflicts=(reserved,id,handle)=>reserved.has(id)&&[...reserved.get(id)].some(value=>value!==handle);

export function ensureSupplementProfileLinkSchema(db){
 db.exec(`CREATE TABLE IF NOT EXISTS ${SUPPLEMENT_PROFILE_LINK_TABLE}(
  id INTEGER PRIMARY KEY,job_id TEXT NOT NULL REFERENCES author_resolution_jobs(id),
  submitted_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,target_id INTEGER NOT NULL REFERENCES targets(id),
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),audit_id INTEGER NOT NULL REFERENCES audits(id),
  run_id INTEGER NOT NULL REFERENCES runs(id),committed_at TEXT NOT NULL,
  receipt_json TEXT NOT NULL,receipt_sha256 TEXT NOT NULL,
  UNIQUE(job_id,submitted_id,request_sha256));
  CREATE INDEX IF NOT EXISTS idx_supplement_profile_job ON ${SUPPLEMENT_PROFILE_LINK_TABLE}(job_id,committed_at);`);
}

/** Current source edition membership and immutable completed-job bytes are
 * independent of profile freshness. No nickname or metadata-only association. */
export function readSupplementProfileIdentityLinks(db,{sources,reference,baseLinks=[]}){
 const empty={links:[],accepted:0,rejected:0,recordedIds:[]};
 if(!Number.isFinite(time(reference)))throw Error('invalid-supplement-link-clock');
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(SUPPLEMENT_PROFILE_LINK_TABLE)||!sources.length)return empty;
 const records=new Map(sourceRecords(sources).map(row=>[row.source.job.id,row])),reserved=reservation(baseLinks);
 const saved=db.prepare(`SELECT * FROM ${SUPPLEMENT_PROFILE_LINK_TABLE}
  WHERE job_id IN(SELECT value FROM json_each(?)) AND julianday(committed_at)<=julianday(?) ORDER BY id`)
  .all(JSON.stringify([...records.keys()]),reference);
 const readJob=db.prepare('SELECT status,request_json,created_at,finished_at FROM author_resolution_jobs WHERE id=?'),jobs=new Map();
 const candidates=[];let rejected=0;
 for(const receipt of saved){
  const record=records.get(receipt.job_id),body=parse(receipt.receipt_json),profile=body?.profile,id=submittedIdentity(receipt.submitted_id);
  if(!jobs.has(receipt.job_id))jobs.set(receipt.job_id,readJob.get(receipt.job_id));
  const job=jobs.get(receipt.job_id),binding=record&&{...record.binding,submittedId:id};
  if(!record||!id||receipt.submitted_id!==id||!record.ids.has(id)||job?.status!=='completed'
   ||job.request_json!==record.source.job.request_json||!Number.isFinite(time(job.created_at))||!Number.isFinite(time(job.finished_at))
   ||time(job.created_at)>time(receipt.committed_at)||time(job.finished_at)>time(receipt.committed_at)
   ||body?.type!=='supplement-source-profile-identity'||body.version!==1||Object.keys(body).length!==4
   ||JSON.stringify(body.source)!==JSON.stringify(binding)||receipt.request_sha256!==record.binding.requestSha256
   ||digest(receipt.receipt_json)!==receipt.receipt_sha256||profile?.targetId!==receipt.target_id
   ||profile.snapshotId!==receipt.snapshot_id||profile.auditId!==receipt.audit_id||profile.runId!==receipt.run_id
   ||conflicts(reserved,receipt.target_id,id)
   ||!verifyAdmittedProfileIdentity(db,{profile,submittedAccountId:id,committedAt:receipt.committed_at,reference})){
   rejected++;continue;
  }
  candidates.push({matched_id:id,target_id:receipt.target_id,profile,origin:'stored-supplement-profile-identity-receipt',receiptId:receipt.id});
 }
 const kept=retainUncontestedProfileLinks(db,candidates,reference),handles=new Map(),targets=new Map();
 for(const row of kept){const ids=handles.get(row.matched_id)||new Set();ids.add(row.target_id);handles.set(row.matched_id,ids);
  const names=targets.get(row.target_id)||new Set();names.add(row.matched_id);targets.set(row.target_id,names);}
 const links=[],seen=new Set();
 for(const {profile,...row} of kept){
  if(handles.get(row.matched_id).size!==1||targets.get(row.target_id).size!==1){rejected++;continue;}
  if(!seen.has(pair(row))){seen.add(pair(row));links.push(row);}
 }
 return {links,accepted:links.length,rejected:rejected+candidates.length-kept.length,
  recordedIds:[...new Set(saved.map(row=>submittedIdentity(row.submitted_id)).filter(Boolean))]};
}

/** Only existing fresh official evidence can create a new durable binding. */
export function planSupplementProfileIdentityLinks(db,{sources,reference,baseLinks=[],targetIds}){
 const records=sourceRecords(sources),saved=readSupplementProfileIdentityLinks(db,{sources,reference,baseLinks});
 const current=[...baseLinks,...saved.links],reserved=reservation(current),covered=new Set([...saved.recordedIds,...current.map(row=>submittedIdentity(row.matched_id))]);
 let submitted=[...new Set(records.flatMap(row=>[...row.ids]))].filter(id=>!covered.has(id));
 if(targetIds){
  const relevant=new Set(),read=db.prepare('SELECT raw_json FROM snapshots WHERE target_id=? ORDER BY julianday(captured_at) DESC,id DESC LIMIT 1');
  for(const target of targetIds){const user=parse(read.get(target)?.raw_json)?.profile?.user;
   for(const value of [user?.unique_id,user?.short_id]){const id=submittedIdentity(value);if(id)relevant.add(id);}}
  submitted=submitted.filter(id=>relevant.has(id));
 }
 const proofs=submitted.length?readStoredDouyinProfileIdentityMatches(db,submitted,{reference}):{status:'ok',matches:[]};
 const possible=[];let invalidAdmissionEvidence=0;
 for(const profile of proofs.matches){
  if(conflicts(reserved,profile.targetId,profile.submittedAccountId)||targetIds&&!targetIds.has(profile.targetId))continue;
  if(!verifyAdmittedProfileIdentity(db,{profile,submittedAccountId:profile.submittedAccountId,committedAt:reference,reference})){
   invalidAdmissionEvidence++;continue;
  }
  // One receipt proves membership of the selected current source; repeated
  // work rows and overlapping sources do not create duplicate author entities.
  const record=records.find(row=>row.ids.has(profile.submittedAccountId));if(!record)continue;
  const body={type:'supplement-source-profile-identity',version:1,source:{...record.binding,submittedId:profile.submittedAccountId},profile};
  const receiptJson=JSON.stringify(body);
  possible.push({jobId:record.source.job.id,submittedId:profile.submittedAccountId,requestSha256:record.binding.requestSha256,
   targetId:profile.targetId,snapshotId:profile.snapshotId,auditId:profile.auditId,runId:profile.runId,
   committedAt:reference,receiptJson,receiptSha256:digest(receiptJson)});
 }
 const counts=new Map();for(const row of possible)counts.set(row.targetId,(counts.get(row.targetId)||0)+1);
 return {status:proofs.status,requested:submitted.length,alreadyLinked:saved.links.length,invalidAdmissionEvidence,
  unmatched:proofs.unmatchedIds?.length??0,unverified:proofs.unverifiedIds?.length??0,
  candidates:possible.filter(row=>counts.get(row.targetId)===1),ambiguousTargetClaims:possible.filter(row=>counts.get(row.targetId)>1).length};
}

export function insertSupplementProfileIdentityReceipt(db,row){
 return db.prepare(`INSERT INTO ${SUPPLEMENT_PROFILE_LINK_TABLE}(job_id,submitted_id,request_sha256,target_id,
  snapshot_id,audit_id,run_id,committed_at,receipt_json,receipt_sha256) VALUES(?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(job_id,submitted_id,request_sha256) DO NOTHING`).run(row.jobId,row.submittedId,row.requestSha256,row.targetId,
   row.snapshotId,row.auditId,row.runId,row.committedAt,row.receiptJson,row.receiptSha256).changes;
}
