import {readLatestSourceJobs} from './table-source-jobs.mjs';
import {readCurrentCreatorSourceLinks,withCreatorSourceLinkSnapshot} from './creator-source-current-links.mjs';
import {planSupplementProfileIdentityLinks,readSupplementProfileIdentityLinks,ensureSupplementProfileLinkSchema,insertSupplementProfileIdentityReceipt} from './supplement-profile-identity-links.mjs';
const has=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const pair=row=>`${row.matched_id}:${row.target_id}`;
const checkedClock=value=>{
 if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw Error('invalid-supplement-link-clock');
 return value;
};
function context(db,reference){
 const imported=db.prepare('SELECT * FROM creator_source_imports WHERE julianday(imported_at)<=julianday(?) ORDER BY id DESC LIMIT 1').get(reference);
 const baseLinks=imported?readCurrentCreatorSourceLinks(db,{imported,reference}).accountLinks:[];
 return {sources:readLatestSourceJobs(db,reference),reference,baseLinks};
}
export function reconcileSupplementProfileIdentityLinks(database,{runId,maxAdmissions=200,clock=()=>new Date().toISOString()}={}){
 const db=database?.db??database;if(db.isTransaction)throw Error('supplement-link-requires-committed-boundary');
 if(!Number.isSafeInteger(maxAdmissions)||maxAdmissions<1||maxAdmissions>1000)throw Error('invalid-supplement-link-limit');
 const at=checkedClock(clock());
 if(!['creator_source_imports','author_resolution_jobs','targets','snapshots','audits','runs'].every(name=>has(db,name)))
  return {status:'unavailable',admitted:0,platformRequests:0,modelCalls:0};
 let targetIds;
 if(runId!==undefined){
  if(!Number.isSafeInteger(runId)||runId<1)throw Error('invalid-supplement-link-run');
  targetIds=new Set(db.prepare(`SELECT DISTINCT a.target_id FROM audits a JOIN snapshots s
   ON s.target_id=a.target_id AND s.source_checksum=a.source_checksum
   WHERE a.run_id=? AND a.provider='public-web' AND s.account_status='available'`).all(runId).map(row=>row.target_id));
  if(!targetIds.size)return {status:'no-profile-evidence',admitted:0,platformRequests:0,modelCalls:0};
 }
 let plan;db.exec('BEGIN');try{withCreatorSourceLinkSnapshot(db,()=>{
  plan=planSupplementProfileIdentityLinks(db,{...context(db,at),targetIds});
 });}finally{db.exec('ROLLBACK');}
 if(plan.status!=='ok'||!plan.candidates.length)return {status:plan.status==='ok'?'up-to-date':plan.status,
  admitted:0,eligible:plan.candidates.length,requested:plan.requested,unmatched:plan.unmatched,unverified:plan.unverified,
  remaining:0,remainingBasis:'currently-eligible-only',platformRequests:0,modelCalls:0};
 const selected=new Set(plan.candidates.slice(0,maxAdmissions).map(row=>row.targetId));
 db.exec('BEGIN IMMEDIATE');try{
  const reference=checkedClock(clock());let ctx,fresh,before;
  withCreatorSourceLinkSnapshot(db,()=>{ctx=context(db,reference);before=readSupplementProfileIdentityLinks(db,ctx);
   fresh=planSupplementProfileIdentityLinks(db,{...ctx,targetIds:selected});});
  if(fresh.status!=='ok')throw Error('supplement-proof-refresh-unavailable');
  const planned=new Set(plan.candidates.map(row=>`${row.jobId}:${row.requestSha256}:${row.submittedId}:${row.targetId}`));
  const candidates=fresh.candidates.filter(row=>planned.has(`${row.jobId}:${row.requestSha256}:${row.submittedId}:${row.targetId}`)).slice(0,maxAdmissions);
  if(!candidates.length){db.exec('ROLLBACK');return {status:'evidence-changed',admitted:0,platformRequests:0,modelCalls:0};}
  ensureSupplementProfileLinkSchema(db);const added=candidates.filter(row=>insertSupplementProfileIdentityReceipt(db,row));
  const after=readSupplementProfileIdentityLinks(db,ctx),accepted=new Set(after.links.map(pair));
  if(before.links.some(row=>!accepted.has(pair(row)))||added.some(row=>!accepted.has(`${row.submittedId}:${row.targetId}`)))
   throw Error('supplement-link-admission-conflict');
  db.exec('COMMIT');return {status:'admitted',admitted:added.length,eligible:plan.candidates.length,
   remaining:Math.max(0,plan.candidates.length-added.length),remainingBasis:'currently-eligible-only',platformRequests:0,modelCalls:0};
 }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
}
