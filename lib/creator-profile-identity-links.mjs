import {createHash} from 'node:crypto';
import {verifyStoredDouyinProfileIdentity,readStoredDouyinProfileIdentityMatches} from './profile-identity-proof.mjs';
import {validateSubmittedAccountId} from './author-spreadsheet.mjs';

export const CREATOR_PROFILE_LINK_TABLE='creator_source_profile_identity_receipts';
const digest=value=>createHash('sha256').update(value).digest('hex');
const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
const has=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
// XLSX number cells are exact identifiers only within the safe integer range.
// Preserve the original typed row hash; never coerce rounded/scientific IDs.
const norm=value=>typeof value==='string'?validateSubmittedAccountId(value,'douyin').value.normalize('NFKC').toLowerCase()
 :Number.isSafeInteger(value)&&value>0?String(value):'';
const clock=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
 &&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===(value.includes('.')?value:value.replace(/Z$/,'.000Z'))?new Date(value).toISOString():null;
const sourceIdentity=imported=>({importId:imported.id,sha256:imported.source_sha256,url:imported.source_url,
 revision:String(imported.source_revision),modifiedAt:imported.source_modified_at});
const sourceRows=(db,imported)=>db.prepare("SELECT row_number,values_json FROM creator_source_rows WHERE import_id=? AND sheet_id='08' ORDER BY row_number").all(imported.id);
const validSource=imported=>Number.isSafeInteger(imported?.id)&&imported.id>0
 &&/^[a-f0-9]{64}$/.test(imported.source_sha256)&&clock(imported.imported_at);

/** Additive schema only. Raw sheets, samples and old video receipts are untouched. */
export function ensureCreatorProfileLinkSchema(db){
 db.exec(`CREATE TABLE IF NOT EXISTS ${CREATOR_PROFILE_LINK_TABLE}(
  id INTEGER PRIMARY KEY,import_id INTEGER NOT NULL REFERENCES creator_source_imports(id),
  author_row INTEGER NOT NULL,author_row_sha256 TEXT NOT NULL,target_id INTEGER NOT NULL REFERENCES targets(id),
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),audit_id INTEGER NOT NULL REFERENCES audits(id),
  run_id INTEGER NOT NULL REFERENCES runs(id),committed_at TEXT NOT NULL,
  receipt_json TEXT NOT NULL,receipt_sha256 TEXT NOT NULL,
  UNIQUE(import_id,author_row,author_row_sha256));
  CREATE INDEX IF NOT EXISTS idx_creator_profile_link_import ON ${CREATOR_PROFILE_LINK_TABLE}(import_id,committed_at);`);
}

function conflictHeld(db,targetId){
 if(!has(db,'author_resolution_queue'))return false;
 return db.prepare(`SELECT last_error FROM author_resolution_queue WHERE resolved_target_id=?
  AND suspended_target_enabled IS NOT NULL AND status IN ('pending','retry','rejected')`).all(targetId)
  .some(row=>/(?:作者|身份|账号|发布者).*(?:不一致|冲突|不同作者)|多项作品.*不同作者|同一线索对应多个不同作者/.test(String(row.last_error??'')));
}

function proofEvidence(db,profile,target){
 return {target,snapshot:db.prepare('SELECT * FROM snapshots WHERE id=?').get(profile.snapshotId),
  audit:db.prepare('SELECT * FROM audits WHERE id=?').get(profile.auditId),
  run:db.prepare('SELECT * FROM runs WHERE id=?').get(profile.runId)};
}

function sameProfileProof(saved,actual){
 if(!saved||!actual)return false;
 const fields=Object.keys(actual);
 // Account pause/resume does not change historical identity or authorize an enable.
 return Object.keys(saved).length===fields.length&&fields.every(key=>key==='targetEnabled'
  ?typeof saved[key]==='boolean':saved[key]===actual[key]);
}

function newerCanonicalConflict(db,target,profile,asOf){
 // Positive contradictions remain holds. A later network/login failure must
 // not hide an earlier verified change of UID. Stream only differing UID rows;
 // reverify every candidate's original checksum, official provenance and run.
 const snapshots=db.prepare(`SELECT * FROM snapshots WHERE target_id=?
  AND julianday(captured_at)>=julianday(?) AND julianday(captured_at)<=julianday(?)
  AND json_valid(raw_json) AND CASE WHEN json_valid(raw_json)
   THEN json_extract(raw_json,'$.profile.user.uid') END IS NOT NULL
  AND CASE WHEN json_valid(raw_json) THEN json_extract(raw_json,'$.profile.user.uid') END != ?
  ORDER BY julianday(captured_at) DESC,id DESC`).iterate(target.id,profile.observedAt,asOf,profile.uid);
 for(const snapshot of snapshots){
  if(snapshot.id===profile.snapshotId)continue;
  const user=parse(snapshot.raw_json)?.profile?.user,submitted=norm(user?.unique_id)||norm(user?.short_id);
  if(!submitted)continue;
  const audit=db.prepare(`SELECT * FROM audits WHERE target_id=? AND source_checksum=? AND provider='public-web'
   AND julianday(created_at)<=julianday(?) ORDER BY julianday(created_at) DESC,id DESC LIMIT 1`).get(target.id,snapshot.source_checksum,asOf);
  const run=audit&&db.prepare('SELECT * FROM runs WHERE id=?').get(audit.run_id),reference=clock(audit?.created_at);
  if(!reference||Date.parse(reference)>Date.parse(asOf))continue;
  const later=verifyStoredDouyinProfileIdentity({target,snapshot,audit,run,submittedAccountId:submitted,reference});
  if(later&&(later.canonicalAccountId!==profile.canonicalAccountId||later.uid!==profile.uid))return true;
 }
 return false;
}

/** Admission is fresh; an admitted identity does not expire when offline.
 * Reverify its exact stored sample/audit/run at the real admission time. */
export function readCreatorProfileIdentityLinks(db,{imported,reference=new Date().toISOString()}={}){
 const empty={links:[],accepted:0,rejected:0};
 if(!validSource(imported)||!has(db,CREATOR_PROFILE_LINK_TABLE))return empty;
 const asOf=clock(reference);if(!asOf)throw Error('invalid-profile-link-clock');
 const authors=sourceRows(db,imported),byRow=new Map(authors.map(row=>[row.row_number,row])),byId=new Map();
 for(const row of authors){const key=norm(parse(row.values_json)?.[1]);if(key)byId.set(key,(byId.get(key)||0)+1);}
 const saved=db.prepare(`SELECT * FROM ${CREATOR_PROFILE_LINK_TABLE} WHERE import_id=?
  AND julianday(committed_at)<=julianday(?) ORDER BY id`).all(imported.id,asOf);
 if(!saved.length)return empty;
 if(!['targets','snapshots','audits','runs'].every(table=>has(db,table)))return {...empty,rejected:saved.length};
 const candidates=[];let rejected=0;
 for(const receipt of saved){
  const body=parse(receipt.receipt_json),row=byRow.get(receipt.author_row),profile=body?.profile;
  const primary=row&&norm(parse(row.values_json)?.[1]),target=db.prepare('SELECT * FROM targets WHERE id=?').get(receipt.target_id);
  const metadata=target&&parse(target.metadata_json),admitted=clock(receipt.committed_at);
  const source={...sourceIdentity(imported),authorRow:receipt.author_row,authorRowSha256:row&&digest(row.values_json)};
  if(!row||!primary||byId.get(primary)!==1||body?.type!=='creator-source-profile-identity'||body.version!==1
   ||Object.keys(body).length!==4||JSON.stringify(body.source)!==JSON.stringify(source)
   ||digest(receipt.receipt_json)!==receipt.receipt_sha256||receipt.author_row_sha256!==source.authorRowSha256
   ||!admitted||Date.parse(admitted)>Date.parse(asOf)||Date.parse(imported.imported_at)>Date.parse(admitted)
   ||!profile||profile.targetId!==receipt.target_id||profile.snapshotId!==receipt.snapshot_id
   ||profile.auditId!==receipt.audit_id||profile.runId!==receipt.run_id||profile.submittedAccountId!==primary
   ||!target||metadata?.identityVerification?.accountId!==target.locator||conflictHeld(db,target.id)) {rejected++;continue;}
  const evidence=proofEvidence(db,profile,target);
  const verified=verifyStoredDouyinProfileIdentity({...evidence,submittedAccountId:primary,reference:admitted});
  if(!sameProfileProof(profile,verified)||newerCanonicalConflict(db,target,profile,asOf)){rejected++;continue;}
  candidates.push({author_row:receipt.author_row,target_id:target.id,matched_id:String(parse(row.values_json)[1]),
   origin:'stored-profile-identity-receipt',receiptId:receipt.id,profile});
 }
 // Reused public IDs cannot silently bind a second canonical account. A stale
 // own profile alone is not a revocation of the historical identity.
 const current=candidates.length?readStoredDouyinProfileIdentityMatches(db,candidates.map(row=>row.profile.submittedAccountId),{reference:asOf}):null;
 if(current&&current.status!=='ok')return {...empty,rejected:rejected+candidates.length};
 const ambiguous=new Set(current?.ambiguousIds||[]),fresh=new Map((current?.matches||[]).map(proof=>[proof.submittedAccountId,proof]));
 const links=[];
 for(const candidate of candidates){
  const next=fresh.get(candidate.profile.submittedAccountId);
  if(ambiguous.has(candidate.profile.submittedAccountId)||next&&(next.targetId!==candidate.target_id
   ||next.uid!==candidate.profile.uid||next.canonicalAccountId!==candidate.profile.canonicalAccountId)){rejected++;continue;}
  const {profile,...link}=candidate;links.push(link);
 }
 return {links,accepted:links.length,rejected};
}

/** Read-only proposal, using existing official samples. No profile requests. */
export function planCreatorProfileIdentityLinks(db,{imported,reference=new Date().toISOString(),currentLinks,targetIds}={}){
 const asOf=clock(reference);if(!asOf||!imported||!Array.isArray(currentLinks?.accountLinks))throw Error('invalid-profile-link-plan');
 if(!validSource(imported)||Date.parse(imported.imported_at)>Date.parse(asOf))return {status:'invalid-source',requested:0,candidates:[],ambiguousTargetClaims:0};
 const authors=sourceRows(db,imported),groups=new Map(),linkedRows=new Set(currentLinks.accountLinks.map(row=>row.author_row));
 const reserved=new Map(currentLinks.accountLinks.map(row=>[row.target_id,row.author_row]));
 for(const row of authors){const key=norm(parse(row.values_json)?.[1]);if(key){const rows=groups.get(key)||[];rows.push(row);groups.set(key,rows);}}
 let ids=[...groups].filter(([,rows])=>rows.length===1&&!linkedRows.has(rows[0].row_number)).map(([key])=>key);
 if(targetIds){
  const relevant=new Set(),snapshot=db.prepare('SELECT raw_json FROM snapshots WHERE target_id=? ORDER BY julianday(captured_at) DESC,id DESC LIMIT 1');
  for(const targetId of targetIds){const user=parse(snapshot.get(targetId)?.raw_json)?.profile?.user;
   for(const value of [user?.unique_id,user?.short_id]){const key=norm(value);if(key)relevant.add(key);}}
  ids=ids.filter(key=>relevant.has(key));
 }
 const proofs=ids.length?readStoredDouyinProfileIdentityMatches(db,ids,{reference:asOf}):{status:'ok',matches:[]};
 const candidates=[];
 for(const profile of proofs.matches){
  const row=groups.get(profile.submittedAccountId)?.[0],target=db.prepare('SELECT * FROM targets WHERE id=?').get(profile.targetId),metadata=target&&parse(target.metadata_json);
  if(!row||reserved.has(profile.targetId)||targetIds&&!targetIds.has(profile.targetId)
   ||metadata?.identityVerification?.accountId!==target.locator)continue;
  const source={...sourceIdentity(imported),authorRow:row.row_number,authorRowSha256:digest(row.values_json)};
  const body={type:'creator-source-profile-identity',version:1,source,profile};
  const receiptJson=JSON.stringify(body);
  candidates.push({importId:imported.id,authorRow:row.row_number,authorRowSha256:source.authorRowSha256,
   targetId:profile.targetId,snapshotId:profile.snapshotId,auditId:profile.auditId,runId:profile.runId,
   committedAt:asOf,receiptJson,receiptSha256:digest(receiptJson)});
 }
 // Two raw source IDs (e.g. unique_id and short_id) cannot claim one base row's
 // account twice. Resolve this in the source identity layer, never by name.
 const counts=new Map();for(const row of candidates)counts.set(row.targetId,(counts.get(row.targetId)||0)+1);
 return {status:proofs.status,sourceAuthorRows:authors.length,unlinkedSourceRows:authors.filter(row=>!linkedRows.has(row.row_number)).length,
  invalidSubmittedRows:authors.filter(row=>!norm(parse(row.values_json)?.[1])).length,
  requested:ids.length,unmatched:proofs.unmatchedIds?.length??0,unverified:proofs.unverifiedIds?.length??0,
  ambiguousIds:proofs.ambiguousIds?.length??0,candidates:candidates.filter(row=>counts.get(row.targetId)===1),
  ambiguousTargetClaims:candidates.filter(row=>counts.get(row.targetId)>1).length};
}

export function insertCreatorProfileIdentityReceipt(db,row){
 return db.prepare(`INSERT INTO ${CREATOR_PROFILE_LINK_TABLE}(import_id,author_row,author_row_sha256,target_id,
  snapshot_id,audit_id,run_id,committed_at,receipt_json,receipt_sha256) VALUES(?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(import_id,author_row,author_row_sha256) DO NOTHING`).run(row.importId,row.authorRow,row.authorRowSha256,
   row.targetId,row.snapshotId,row.auditId,row.runId,row.committedAt,row.receiptJson,row.receiptSha256).changes;
}
