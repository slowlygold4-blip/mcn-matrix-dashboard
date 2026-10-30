import {readCurrentCreatorSourceLinks,withCreatorSourceLinkSnapshot} from './creator-source-current-links.mjs';
import {planCreatorProfileIdentityLinks,ensureCreatorProfileLinkSchema,insertCreatorProfileIdentityReceipt} from './creator-profile-identity-links.mjs';

const has=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const pair=row=>`${row.author_row}:${row.target_id}`;
const latest=(db,reference)=>db.prepare(`SELECT * FROM creator_source_imports WHERE julianday(imported_at)<=julianday(?) ORDER BY id DESC LIMIT 1`).get(reference);

/** Called after a committed profile run or source reconciliation. Existing
 * evidence only; no platform requests, enable actions or fake video receipts. */
export function reconcileCreatorProfileIdentityLinks(database,{runId,maxAdmissions=200,clock=()=>new Date().toISOString()}={}){
 const db=database?.db??database;
 if(db.isTransaction)throw Error('profile-link-reconcile-requires-committed-boundary');
 if(!Number.isSafeInteger(maxAdmissions)||maxAdmissions<1||maxAdmissions>1000)throw Error('invalid-profile-link-limit');
 const at=clock();if(typeof at!=='string'||!Number.isFinite(Date.parse(at)))throw Error('invalid-profile-link-clock');
 if(!['creator_source_imports','creator_source_rows','targets','snapshots','audits','runs'].every(name=>has(db,name)))
  return {status:'unavailable',admitted:0,platformRequests:0,modelCalls:0};
 let targetIds;
 if(runId!==undefined){
  if(!Number.isSafeInteger(runId)||runId<1)throw Error('invalid-profile-link-run');
  targetIds=new Set(db.prepare(`SELECT DISTINCT a.target_id FROM audits a JOIN snapshots s
   ON s.target_id=a.target_id AND s.source_checksum=a.source_checksum
   WHERE a.run_id=? AND a.provider='public-web' AND s.account_status='available'`).all(runId).map(row=>row.target_id));
  if(!targetIds.size)return {status:'no-profile-evidence',admitted:0,platformRequests:0,modelCalls:0};
 }
 let imported,plan;
 db.exec('BEGIN');
 try{
  imported=latest(db,at);
  if(!imported)return {status:'source-not-imported',admitted:0,platformRequests:0,modelCalls:0};
  withCreatorSourceLinkSnapshot(db,()=>{
   const currentLinks=readCurrentCreatorSourceLinks(db,{imported,reference:at});
   plan=planCreatorProfileIdentityLinks(db,{imported,reference:at,currentLinks,targetIds});
  });
 }finally{db.exec('ROLLBACK');}
 if(plan.status!=='ok'||!plan.candidates.length)return {status:plan.status==='ok'?'up-to-date':plan.status,
  requested:plan.requested,unlinkedSourceRows:plan.unlinkedSourceRows,unmatched:plan.unmatched,unverified:plan.unverified,
  eligible:plan.candidates.length,admitted:0,remaining:0,remainingBasis:'currently-eligible-only',platformRequests:0,modelCalls:0};
 const selected=new Set(plan.candidates.slice(0,maxAdmissions).map(row=>row.targetId));
 db.exec('BEGIN IMMEDIATE');
 try{
  const committedAt=clock(),current=latest(db,committedAt);
  if(!current||current.id!==imported.id||current.source_sha256!==imported.source_sha256){db.exec('ROLLBACK');return {status:'source-changed',admitted:0,platformRequests:0,modelCalls:0};}
  let before,fresh;
  withCreatorSourceLinkSnapshot(db,()=>{
   before=readCurrentCreatorSourceLinks(db,{imported:current,reference:committedAt});
   fresh=planCreatorProfileIdentityLinks(db,{imported:current,reference:committedAt,currentLinks:before,targetIds:selected});
  });
  if(fresh.status!=='ok')throw Error('profile-proof-refresh-unavailable');
  const candidates=fresh.candidates.slice(0,maxAdmissions);
  if(!candidates.length){db.exec('ROLLBACK');return {status:'evidence-changed',admitted:0,platformRequests:0,modelCalls:0};}
  ensureCreatorProfileLinkSchema(db);
  const inserted=[];
  for(const row of candidates)if(insertCreatorProfileIdentityReceipt(db,row))inserted.push(row);
  const after=readCurrentCreatorSourceLinks(db,{imported:current,reference:committedAt});
  const accepted=new Set(after.accountLinks.map(pair));
  if(before.accountLinks.some(row=>!accepted.has(pair(row)))||inserted.some(row=>!accepted.has(`${row.authorRow}:${row.targetId}`)))
   throw Error('profile-link-admission-conflict');
  db.exec('COMMIT');
  return {status:inserted.length?'admitted':'existing-receipt-retained',requested:plan.requested,eligible:plan.candidates.length,
   admitted:inserted.length,unlinkedSourceRows:plan.unlinkedSourceRows-inserted.length,unmatched:plan.unmatched,unverified:plan.unverified,
   remaining:Math.max(0,plan.candidates.length-inserted.length),remainingBasis:'currently-eligible-only',
   receiptIds:inserted.map(row=>({authorRow:row.authorRow,targetId:row.targetId})),platformRequests:0,modelCalls:0};
 }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
}
