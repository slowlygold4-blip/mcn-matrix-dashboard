import { createHash } from 'node:crypto';
import { prepareImportAuthorisedDetail } from './import-authorised-detail.mjs';
import { commitAuthorisedImportDetail } from './authorised-import-service.mjs';
import { validateAuthorisedDetailResult } from './douyin-authorised-detail.mjs';
import { authorQueuePlatform } from './author-queue-identity.mjs';
import { assertMasterRosterSupplementJob } from './master-roster-supplement.mjs';
import { bindQueuedImportEvidence } from './queued-import-evidence.mjs';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const hash=value=>createHash('sha256').update(value).digest('hex');
const id=value=>typeof value==='string'?value.normalize('NFKC').trim().replace(/^@/,'').toLowerCase():'';
const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
const skip=code=>({status:'skipped',code,attempted:false,monitoringChanged:false});
const MAX_SOURCES=64,MAX_JOBS=64,MAX_JOB_BYTES=8*1024*1024,MAX_TOTAL_BYTES=32*1024*1024;
const SOURCE_FIELDS=['sourceType','sourceUrl','sourceTitle','sourceRevision','sourceSheetId','sourceRange','sourceSha256','sourceExportSha256','sourceReadAt'];

/** Read only. A claimed queue row is not a source: bind a checksummed original
 * receipt to the completed job during whose lifetime it was written. The
 * exact original row must produce every one of this queue's submitted works.
 * Bounded/ambiguous legacy searches are held, never resolved by recency/name.
 */
export function prepareQueuedAuthorisedImport(database, claimedItem, {owner,reference=new Date()}={}) {
  const now=reference instanceof Date?reference.getTime():Date.parse(reference);
  if(!Number.isFinite(now)||typeof owner!=='string'||!owner||!Number.isSafeInteger(claimedItem?.id)
    ||!Number.isSafeInteger(claimedItem?.evidence_version)) return skip('claim_invalid');
  const db=database.db,row=db.prepare('SELECT * FROM author_resolution_queue WHERE id=?').get(claimedItem.id);
  if(!row||row.identity_key!==claimedItem.identity_key||row.evidence_version!==claimedItem.evidence_version
    ||row.lease_owner!==owner||!Number.isFinite(Date.parse(row.lease_until))||Date.parse(row.lease_until)<=now) return skip('claim_stale');
  if(authorQueuePlatform(row)!=='douyin'||row.verification_policy_version!==2||!['pending','retry'].includes(row.status)
    ||row.resolved_target_id!==null||row.suspended_target_enabled!==null) return skip('queue_not_eligible');
  const videos=parse(row.video_ids_json),shares=parse(row.share_urls_json),rows=parse(row.source_rows_json);
  if(!Array.isArray(videos)||!Array.isArray(shares)||videos.length+shares.length!==1
    ||![...videos,...shares].every(value=>typeof value==='string')||!Array.isArray(rows)||!rows.length
    ||rows.some(value=>!Number.isSafeInteger(value)||value<1)) return skip('evidence_not_single');
  const receipts=db.prepare(`SELECT receipt_sha256,payload_json,observed_at FROM author_resolution_import_sources
    WHERE queue_id=? AND queue_identity_key=? ORDER BY id LIMIT ?`).all(row.id,row.identity_key,MAX_SOURCES+1);
  if(receipts.length>MAX_SOURCES) return skip('source_scan_bound');
  const matches=[],loaded=new Map();let scannedBytes=0;
  for(const receipt of receipts) {
    if(typeof receipt.payload_json!=='string'||hash(receipt.payload_json)!==receipt.receipt_sha256) continue;
    const source=parse(receipt.payload_json),observed=Date.parse(receipt.observed_at);
    if(!object(source)||!Number.isFinite(observed)||source.fileName!==row.file_name||source.sheetName!==row.sheet_name
      ||!Array.isArray(source.sourceRows)||source.sourceRows.some(value=>!Number.isSafeInteger(value)||value<1)
      ||!object(source.sourceMetadata)) continue;
    const sourceRows=source.sourceRows.filter(value=>rows.includes(value));
    if(!sourceRows.length) continue;
    const jobs=db.prepare(`SELECT id,LENGTH(CAST(request_json AS BLOB)) AS byte_length FROM author_resolution_jobs
      WHERE status='completed' AND file_name=? AND sheet_name=?
        AND julianday(created_at)<=julianday(?) AND julianday(finished_at)>=julianday(?)
      ORDER BY created_at,id LIMIT ?`).all(row.file_name,row.sheet_name,receipt.observed_at,receipt.observed_at,MAX_JOBS+1);
    if(jobs.length>MAX_JOBS) return skip('source_scan_bound');
    for(const record of jobs) {
      let job=loaded.get(record.id);
      if(!job) {
        if(loaded.size>=MAX_JOBS||record.byte_length>MAX_JOB_BYTES||scannedBytes+record.byte_length>MAX_TOTAL_BYTES) return skip('source_scan_bound');
        scannedBytes+=record.byte_length;job=database.getAuthorResolutionJob(record.id);loaded.set(record.id,job);
      }
      if(!job||!object(job.request)||!Array.isArray(job.request.rows)) continue;
      if(job.request.masterRosterSupplement) {
        try{assertMasterRosterSupplementJob(db,job);}catch{return skip('source_context_stale');}
      }
      // Receipts with a stored source locator/fingerprint may not be silently
      // associated with a different revision sharing the same filename.
      if(SOURCE_FIELDS.some(field=>source.sourceMetadata[field]!==undefined&&field!=='sourceType'
        && source.sourceMetadata[field]!==job.request[field])) continue;
      for(const sourceRow of sourceRows) {
        let input;try{({input}=bindQueuedImportEvidence(job,sourceRow,row));}catch{continue;}
        if(input.key!==row.identity_key||input.submittedId!==id(row.douyin_id)
          ||(input.expectedSecUid??'')!==(row.account_locator??'')
          ||(input.shareUrl!==undefined ? videos.length!==0||shares[0]!==input.shareUrl : shares.length!==0||videos[0]!==input.videoId)) continue;
        const original=job.request.rows.find(value=>value.sourceRow===sourceRow);
        matches.push({job,sourceRow,input,sourceRowSha256:hash(JSON.stringify(original)),receiptSha256:receipt.receipt_sha256});
      }
    }
  }
  if(!matches.length) return skip('source_unavailable');
  // Identical source rows in repeated completed jobs are interchangeable only
  // as source observations; differing original rows are never chosen silently.
  if(new Set(matches.map(value=>value.sourceRowSha256)).size!==1) return skip('source_ambiguous');
  const chosen=matches[0];
  return {status:'ready',job:chosen.job,sourceRow:chosen.sourceRow,input:chosen.input,
    claim:{owner,queueId:row.id,evidenceVersion:row.evidence_version,sourceReceiptSha256:chosen.receiptSha256,
      sourceRowSha256:chosen.sourceRowSha256}};
}

const EXEC_FAILURES=new Set(['BROWSER_LANE_BUSY','BROWSER_LANE_LOCKED','AUTHORISED_DETAIL_DISABLED',
  'AUTHORISED_DETAIL_UNVERIFIED','AUTHORISED_ADMISSION_BUSY','AUTHORISED_ADMISSION_STALE','AUTHORISED_ADMISSION_NOT_ELIGIBLE',
  'AUTHORISED_ADMISSION_INVALID']);
/** One already fairly-claimed author per call. The caller owns tick limits,
 * retry scheduling and lease release. No anonymous fallback or rejection reset.
 * Provider owns the single browser lane and the 45-second execution deadline.
 */
export async function runQueuedAuthorisedImport(database,claimedItem,{owner,provider,signal,createInput}={}) {
  if(signal?.aborted) return {...skip('cancelled'),status:'unavailable'};
  const prepared=prepareQueuedAuthorisedImport(database,claimedItem,{owner});
  if(prepared.status!=='ready') return prepared;
  const {job,sourceRow,input,claim}=prepared;
  const base={job,sourceRow,input,claim,attempted:false,monitoringChanged:false};
  if(typeof provider?.resolveAuthorisedDetail!=='function'||typeof createInput!=='function') return {...base,status:'skipped',code:'runtime_invalid'};
  const startedAt=new Date().toISOString();let result;
  try {
    result=await provider.resolveAuthorisedDetail({items:[input]});
    const finishedAt=new Date().toISOString();
    if(signal?.aborted) return {...base,status:'unavailable',code:'cancelled',startedAt,finishedAt};
    result=validateAuthorisedDetailResult(input,result,{startedAt,finishedAt});
    const observed={...base,attempted:true,result,startedAt,finishedAt};
    if(result.status!=='ok') return {...observed,status:'unavailable',code:result.errorCode};
    const admission=commitAuthorisedImportDetail(database,job,{sourceRow},result,{startedAt,finishedAt,
      existingClaim:claim,createInput:row=>createInput(job,row)});
    if(admission.status==='rejected') return {...observed,status:'rejected',code:admission.code,admission,monitoringChanged:false};
    return {...observed,status:'resolved',code:null,admission,monitoringChanged:admission.monitoringChanged};
  } catch(error) {
    return {...base,status:'unavailable',code:signal?.aborted?'cancelled':EXEC_FAILURES.has(error?.code)?error.code:'AUTHORISED_DETAIL_UNVERIFIED',
      ...(result?.status==='ok'?{attempted:true}:{}),startedAt,finishedAt:new Date().toISOString()};
  }
}
