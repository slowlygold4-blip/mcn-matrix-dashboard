/** Recover only previously rejected physical rows from their immutable XLSX.
 * This is a parser projection, never a new source edition or metric sample. */
import {createHash} from 'node:crypto';
import {readWorkSourceWorkbook} from './work-source-workbook.mjs';
import {WORK_LINK_ROW_POLICY} from './work-source-tables.mjs';
export {WORK_LINK_ROW_POLICY} from './work-source-tables.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const cache=new Map();

export function recoveredWorkSourceRows(db,versionId,{forceVerify=false}={}){
 const version=db.prepare('SELECT * FROM work_source_versions WHERE id=?').get(versionId);
 if(!version)throw Error('source-row-version-missing');
 // Legacy/minimal editions without an original report cannot prove a recovery.
 // Their existing accepted membership remains usable through the strict path.
 if(version.report_json==null)return [];
 if(hash(version.report_json)!==version.report_sha256)throw Error('source-row-report-corrupt');
 const report=JSON.parse(version.report_json);
 const rejected=new Set((report.rejected??[]).filter(row=>row.reason==='invalid-work-url').map(row=>JSON.stringify([row.sheet,row.row])));
 if(!rejected.size)return [];
 const key=JSON.stringify([WORK_LINK_ROW_POLICY,version.source_sha256,version.report_sha256,version.facts_sha256,version.source_read_at]);
 if(cache.has(key)&&!forceVerify)return structuredClone(cache.get(key));
 const artifact=db.prepare('SELECT content FROM work_source_artifacts WHERE sha256=?').get(version.source_sha256);
 if(!artifact||hash(artifact.content)!==version.source_sha256)throw Error('source-row-artifact-corrupt');
 const parsed=readWorkSourceWorkbook(Buffer.from(artifact.content),{asOf:new Date(version.source_read_at).toISOString(),recoverLinkEvidence:true});
 const byRow=new Map(parsed.facts.map(fact=>[JSON.stringify([fact.sheet,fact.row]),fact]));
 const original=db.prepare(`SELECT m.ordinal,b.sha256,b.fact_json FROM work_source_version_facts m
  JOIN work_source_fact_blobs b ON b.sha256=m.fact_sha256 WHERE m.version_id=? ORDER BY m.ordinal`).all(versionId);
 if(original.length!==version.fact_count||hash(JSON.stringify(original.map(row=>row.sha256)))!==version.facts_sha256)
  throw Error('source-row-membership-corrupt');
 for(const row of original){
  if(hash(row.fact_json)!==row.sha256)throw Error('source-row-original-fact-corrupt');
  const fact=JSON.parse(row.fact_json),projected=byRow.get(JSON.stringify([fact.sheet,fact.row]));
  if(!projected||hash(JSON.stringify(projected))!==row.sha256)throw Error('source-row-recovery-changes-accepted-fact');
 }
 const recovered=parsed.facts.filter(fact=>rejected.has(JSON.stringify([fact.sheet,fact.row]))).map(fact=>{
  const json=JSON.stringify(fact),sha256=hash(json);
  return {sha256,json,fact,proof:{policy:WORK_LINK_ROW_POLICY,sourceSha256:version.source_sha256,
   originalReportSha256:version.report_sha256,rowSha256:fact.rowSha256}};
 });
 // Cache only the small recovered rows, never workbook buffers or full corpora.
 cache.set(key,recovered);while(cache.size>8)cache.delete(cache.keys().next().value);
 return structuredClone(recovered);
}
