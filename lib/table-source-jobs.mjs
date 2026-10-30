import {latestSources} from './table-foundation.mjs';

/** Select source editions using only their metadata before materializing rows.
 * Duplicate top-level keys and non-array/malformed payloads take the original
 * JSON.parse path, preserving its selection and failure semantics. */
export function readLatestSourceJobs(db,asOf){
 const query=db.prepare(`SELECT id,created_at,finished_at,
  CASE WHEN json_valid(request_json) THEN json_remove(request_json,'$.rows') END metadata_json,
  CASE WHEN json_valid(request_json) THEN json_type(request_json,'$.rows') END rows_type,
  CASE WHEN json_valid(request_json) THEN
   (SELECT count(*)>count(DISTINCT key) FROM json_each(author_resolution_jobs.request_json))
   ELSE 1 END duplicate_keys
  FROM author_resolution_jobs WHERE status='completed' AND julianday(created_at)<=julianday(?)
   AND julianday(finished_at)<=julianday(?) ORDER BY created_at,id`);
 const readPayload=db.prepare('SELECT request_json FROM author_resolution_jobs WHERE id=?');
 const payload=id=>{const row=readPayload.get(id);if(!row)throw Error('source-job-disappeared');return row.request_json;};
 function* candidates(){
  for(const row of query.iterate(asOf,asOf)){
   const metadata=row.metadata_json;
   const compact=row.rows_type==='array'&&!row.duplicate_keys&&typeof metadata==='string'
    &&metadata.startsWith('{')&&metadata.endsWith('}');
   const request_json=compact?metadata.slice(0,-1)+(metadata.length===2?'':',')+'"rows":[]}' :payload(row.id);
   yield {id:row.id,created_at:row.created_at,finished_at:row.finished_at,request_json};
  }
 }
 return latestSources(candidates()).map(source=>{
  const request_json=payload(source.job.id);
  return {...source,request:JSON.parse(request_json||'{}'),job:{...source.job,request_json}};
 });
}

