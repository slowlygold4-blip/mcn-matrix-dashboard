// Explicit author UID from a supplied work row is a different namespace from
// a public handle. Reuse existing official profile proof; never guess by name.
import {createHash} from 'node:crypto';
import {readKnownWorkSourceFacts,readWorkSourceEditions} from './work-source-store.mjs';
import {readStoredDouyinProfileIdentityMatches} from './profile-identity-proof.mjs';
import {creatorSourceWorkEvidence} from './creator-source-work-evidence.mjs';
import {validateSubmittedAccountId} from './author-spreadsheet.mjs';
const digest=s=>createHash('sha256').update(s).digest('hex');
const norm=v=>typeof v==='string'?validateSubmittedAccountId(v,'douyin').value.normalize('NFKC').toLowerCase()
 :Number.isSafeInteger(v)&&v>0?String(v):'';
const uid=v=>typeof v==='string'&&/^[1-9]\d{1,24}$/.test(v)?v:null;
const has=(db,t)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

/** Cheap eligibility gate for a one-account completion hook. It grants no
 * identity authority; a hit still goes through full source/provenance checks. */
export function mayHaveCreatorUIDCandidate(db,{imported,reference,targetIds,unlinkedIds}){
 if(!targetIds)return true;
 if(!targetIds.size||!has(db,'work_source_versions'))return false;
 const uids=db.prepare(`SELECT CASE WHEN json_valid(s.raw_json) THEN json_extract(s.raw_json,'$.profile.user.uid') END uid
  FROM snapshots s WHERE s.id IN(SELECT(SELECT id FROM snapshots WHERE target_id=t.id ORDER BY julianday(captured_at) DESC,id DESC LIMIT 1)
   FROM targets t WHERE t.id IN(SELECT value FROM json_each(?)))`).all(JSON.stringify([...targetIds])).map(r=>r.uid).filter(uid);
 if(!uids.length)return false;
 const works=db.prepare("SELECT json_extract(values_json,'$[0]') id,json_extract(values_json,'$[2]') owner FROM creator_source_rows WHERE import_id=? AND sheet_id='09'")
  .all(imported.id).filter(r=>unlinkedIds.has(norm(r.owner))).map(r=>r.id).filter(v=>typeof v==='string'&&/^\d{15,25}$/.test(v));
 if(!works.length)return false;
 const versions=readWorkSourceEditions(db,{asOf:reference}).map(v=>v.id);
 return !!db.prepare(`SELECT 1 FROM work_source_fact_blobs f JOIN work_source_version_facts m ON m.fact_sha256=f.sha256
  WHERE f.content_id IN(SELECT value FROM json_each(?)) AND m.version_id IN(SELECT value FROM json_each(?))
   AND json_valid(f.fact_json) AND json_extract(f.fact_json,'$.uid') IN(SELECT value FROM json_each(?)) LIMIT 1`)
  .get(JSON.stringify(works),JSON.stringify(versions),JSON.stringify(uids));
}

/** Immutable original row coordinates, not caller-supplied verified flags. */
export function readCreatorSourceUIDEvidence(db,{imported,reference}={}){
 if(!imported||!has(db,'work_source_versions'))return {candidates:[],conflictingAuthors:[]};
 const source=readKnownWorkSourceFacts(db,{asOf:reference}),versions=new Map(source.versions.map(v=>[v.id,v]));
 const authors=new Map();
 for(const row of db.prepare("SELECT row_number,values_json FROM creator_source_rows WHERE import_id=? AND sheet_id='08' ORDER BY row_number").all(imported.id)){
  const id=norm(JSON.parse(row.values_json)?.[1]);if(!id)continue;
  const group=authors.get(id)||[];group.push(row);authors.set(id,group);
 }
 const works=new Map();
 for(const row of db.prepare("SELECT row_number,values_json FROM creator_source_rows WHERE import_id=? AND sheet_id='09' ORDER BY row_number").all(imported.id)){
  const values=JSON.parse(row.values_json),work=creatorSourceWorkEvidence(values,row.row_number),id=norm(values?.[2]);
  if(!work||!id)continue;
  const group=works.get(work.videoId)||[];group.push({...row,accountId:id});works.set(work.videoId,group);
 }
 const grouped=new Map(),conflicts=new Set();
 for(const fact of source.facts){
  if(!fact.presentInLatestEdition)continue;
  const rows=works.get(fact.contentId);if(!rows?.length||new Set(rows.map(r=>r.accountId)).size!==1)continue;
  const work=rows[0],author=authors.get(work.accountId);if(author?.length!==1)continue;
  if(fact.identityIssues?.length||fact.uid!=null&&!uid(fact.uid)){conflicts.add(author[0].row_number);continue;}
  if(!uid(fact.uid))continue;
  const version=versions.get(fact.sourceVersionId);if(!version)continue;
  const evidence={version:1,uid:fact.uid,sourceVersionId:version.id,sourceUrl:version.sourceUrl,
   sourceSha256:version.sourceSha256,sheet:fact.sheet,row:fact.row,rowSha256:fact.rowSha256,
   contentId:fact.contentId,workRow:work.row_number,workRowSha256:digest(work.values_json),sourceSetFingerprint:source.fingerprint};
  const group=grouped.get(author[0].row_number)||[];group.push(evidence);grouped.set(author[0].row_number,group);
 }
 for(const [row,facts]of grouped)if(new Set(facts.map(f=>f.uid)).size>1)conflicts.add(row);
 return {conflictingAuthors:[...conflicts],candidates:[...grouped].filter(([row])=>!conflicts.has(row))
  .map(([authorRow,facts])=>({authorRow,evidence:facts.sort((a,b)=>a.sourceVersionId-b.sourceVersionId
   ||a.sheet.localeCompare(b.sheet)||a.row-b.row||a.workRow-b.workRow)[0]}))};
}

export const creatorUIDSourceFingerprint=(db,reference)=>digest(JSON.stringify(readWorkSourceEditions(db,{asOf:reference}).map(v=>[v.id,v.factsSha256])));

/** A duplicated canonical UID claim is a hold even if one sample is invalid. */
export function readCurrentUIDClaims(db){
 const claims=new Map();
 for(const row of db.prepare(`SELECT t.id,CASE WHEN json_valid(s.raw_json) THEN json_extract(s.raw_json,'$.profile.user.uid') END uid,
  CASE WHEN json_valid(s.raw_json) THEN json_extract(s.raw_json,'$.profile.user.unique_id') END handle,
  CASE WHEN json_valid(s.raw_json) THEN json_extract(s.raw_json,'$.profile.user.short_id') END shortId
  FROM targets t JOIN snapshots s ON s.id=(SELECT id FROM snapshots WHERE target_id=t.id ORDER BY julianday(captured_at) DESC,id DESC LIMIT 1)
  WHERE t.type='account' AND t.provider='public-web' AND json_valid(t.metadata_json)
   AND COALESCE(json_extract(t.metadata_json,'$.platform'),'douyin')='douyin'`).all()){
  if(!uid(row.uid))continue;const group=claims.get(row.uid)||[];group.push(row);claims.set(row.uid,group);
 }
 return claims;
}

export function readVerifiedCreatorUIDProfiles(db,uids,reference){
 const claims=readCurrentUIDClaims(db),wanted=new Set(uids),handles=[];
 for(const [id,rows]of claims)if(wanted.has(id)&&rows.length===1){const handle=norm(rows[0].handle)||norm(rows[0].shortId);if(handle)handles.push(handle);}
 const result=handles.length?readStoredDouyinProfileIdentityMatches(db,[...new Set(handles)],{reference}):{status:'ok',matches:[]};
 if(result.status!=='ok')return {status:result.status,matches:new Map()};
 return {status:'ok',matches:new Map(result.matches.filter(p=>wanted.has(p.uid)&&claims.get(p.uid)?.length===1
  &&claims.get(p.uid)[0].id===p.targetId).map(p=>[p.uid,p]))};
}
