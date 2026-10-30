import {createHash} from 'node:crypto';
const has=(db,table)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
/** Bounded-memory change detection. Only a digest leaves this read; no model. */
export function readPublicSourceMarker(db,asOf){
 if(typeof asOf!=='string'||!Number.isFinite(Date.parse(asOf)))throw Error('invalid-source-marker-clock');
 const hash=createHash('sha256'),feed=(type,row)=>hash.update(JSON.stringify([type,row])).update('\n');
 if(has(db,'author_resolution_jobs'))for(const row of db.prepare("SELECT id,finished_at,request_json FROM author_resolution_jobs WHERE status='completed' AND julianday(created_at)<=julianday(?) AND julianday(finished_at)<=julianday(?) ORDER BY id").iterate(asOf,asOf)){
  feed('author-job',[row.id,row.finished_at,createHash('sha256').update(row.request_json).digest('hex')]);
 }
 if(has(db,'creator_source_imports'))for(const row of db.prepare('SELECT id,source_sha256,source_revision,imported_at FROM creator_source_imports WHERE julianday(imported_at)<=julianday(?) ORDER BY id').iterate(asOf))feed('creator-import',row);
 if(has(db,'work_source_versions'))for(const row of db.prepare('SELECT id,source_sha256,facts_sha256,committed_at FROM work_source_versions WHERE julianday(committed_at)<=julianday(?) ORDER BY id').iterate(asOf))feed('work-edition',row);
 if(has(db,'work_source_link_receipts'))for(const row of db.prepare('SELECT sha256,committed_at FROM work_source_link_receipts WHERE content_id IS NOT NULL AND julianday(committed_at)<=julianday(?) AND julianday(observed_at)<=julianday(?) ORDER BY sha256').iterate(asOf,asOf))feed('work-link-receipt',row);
 if(has(db,'master_roster_imports'))for(const row of db.prepare('SELECT id,payload_sha256,imported_at FROM master_roster_imports WHERE julianday(imported_at)<=julianday(?) ORDER BY id').iterate(asOf))feed('master-roster',row);
 for(const table of ['creator_source_profile_identity_receipts','supplement_profile_identity_receipts'])if(has(db,table))
  for(const row of db.prepare(`SELECT id,receipt_sha256,committed_at FROM ${table} WHERE julianday(committed_at)<=julianday(?) ORDER BY id`).iterate(asOf))feed(table,row);
 return hash.digest('hex');
}
