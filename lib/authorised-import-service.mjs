import { createHash, randomUUID } from 'node:crypto';
import { prepareImportAuthorisedDetail } from './import-authorised-detail.mjs';
import { prepareAuthorisedDetailAdmission } from './authorised-detail-admission.mjs';
import { classifyAuthorisedRetryEligibility } from './authorised-retry-eligibility.mjs';
import { assertMasterRosterSupplementJob } from './master-roster-supplement.mjs';

const id = value => String(value ?? '').normalize('NFKC').trim().replace(/^@/, '').toLowerCase();
const fail = code => Object.assign(new Error(code), { code });
const hash = value => createHash('sha256').update(value).digest('hex');
const hydrate = row => ({...row,videoIds:JSON.parse(row.video_ids_json),shareUrls:JSON.parse(row.share_urls_json),
  sourceRows:JSON.parse(row.source_rows_json),boards:JSON.parse(row.boards_json),sourceMetadata:JSON.parse(row.source_metadata_json)});

// Synchronous, exact-source admission only. No browser, background retry or
// client-provided identity proof. The caller supplies its own freshly verified
// provider response and its existing target-input normalizer.
export function commitAuthorisedImportDetail(database, job, body, result, {startedAt, finishedAt, createInput, existingClaim} = {}) {
  const input = prepareImportAuthorisedDetail(job, body);
  if (typeof createInput !== 'function') throw fail('AUTHORISED_ADMISSION_INVALID');
  if (result?.status !== 'ok') return {monitoringChanged:false,status:'unavailable'};
  const leased=existingClaim!==undefined;
  if(leased && (!existingClaim || typeof existingClaim.owner!=='string' || !existingClaim.owner
    || existingClaim.owner.length>120 || /[\u0000-\u001f\u007f-\u009f]/.test(existingClaim.owner)
    || !Number.isSafeInteger(existingClaim.queueId) || existingClaim.queueId<1
    || !Number.isSafeInteger(existingClaim.evidenceVersion) || existingClaim.evidenceVersion<1
    || !/^[a-f0-9]{64}$/.test(existingClaim.sourceReceiptSha256??'')
    || !/^[a-f0-9]{64}$/.test(existingClaim.sourceRowSha256??''))) throw fail('AUTHORISED_ADMISSION_INVALID');
  const db=database.db, now=new Date(), at=now.toISOString(), owner=leased?existingClaim.owner:'authorised-import-'+randomUUID();
  db.exec('BEGIN IMMEDIATE');
  try {
    const savedJob=db.prepare('SELECT status,request_json,file_name,sheet_name,created_at,finished_at FROM author_resolution_jobs WHERE id=?').get(job.id);
    if(savedJob?.status!=='completed' || savedJob.request_json!==JSON.stringify(job.request)
      || savedJob.file_name!==job.fileName || savedJob.sheet_name!==job.sheetName) throw fail('AUTHORISED_ADMISSION_STALE');
    if(job.request.masterRosterSupplement) {
      try{assertMasterRosterSupplementJob(db,job);}catch{throw fail('AUTHORISED_ADMISSION_STALE');}
    }
    const row=db.prepare('SELECT * FROM author_resolution_queue WHERE identity_key=?').get(input.key);
    const reconsideration=leased?{allowed:false}:classifyAuthorisedRetryEligibility(row);
    if (!row || (!['pending','retry'].includes(row.status) && !reconsideration.allowed) || row.verification_policy_version!==2
      || row.resolved_target_id!==null || row.suspended_target_enabled!==null) throw fail('AUTHORISED_ADMISSION_NOT_ELIGIBLE');
    if(leased && (row.id!==existingClaim.queueId || row.evidence_version!==existingClaim.evidenceVersion
      || row.lease_owner!==owner || !Number.isFinite(Date.parse(row.lease_until)) || Date.parse(row.lease_until)<=now.getTime()
      || hash(JSON.stringify(job.request.rows.find(value=>value.sourceRow===body.sourceRow)))!==existingClaim.sourceRowSha256)) {
      throw fail('AUTHORISED_ADMISSION_STALE');
    }
    if(reconsideration.allowed && db.prepare('SELECT 1 FROM author_resolution_success_receipts WHERE queue_id=? LIMIT 1').get(row.id)) {
      throw fail('AUTHORISED_ADMISSION_NOT_ELIGIBLE');
    }
    const sourceReceipts=db.prepare('SELECT receipt_sha256,payload_json,observed_at FROM author_resolution_import_sources WHERE queue_id=? AND queue_identity_key=?').all(row.id,input.key);
    const matchingSource=sourceReceipts.some(receipt=>{
      if(leased && (receipt.receipt_sha256!==existingClaim.sourceReceiptSha256
        || !Number.isFinite(Date.parse(receipt.observed_at)) || !Number.isFinite(Date.parse(savedJob.created_at))
        || !Number.isFinite(Date.parse(savedJob.finished_at)) || Date.parse(receipt.observed_at)<Date.parse(savedJob.created_at)
        || Date.parse(receipt.observed_at)>Date.parse(savedJob.finished_at))) return false;
      if(hash(receipt.payload_json)!==receipt.receipt_sha256) return false;
      try {const source=JSON.parse(receipt.payload_json);return source.fileName===job.fileName && source.sheetName===job.sheetName
        && Array.isArray(source.sourceRows) && source.sourceRows.includes(body.sourceRow);}
      catch{return false;}
    });
    if(!matchingSource) throw fail('AUTHORISED_ADMISSION_INVALID');
    const sameIdentity=db.prepare(`SELECT id,douyin_id,lease_owner,lease_until FROM author_resolution_queue
      WHERE lease_owner IS NOT NULL AND (julianday(lease_until) IS NULL OR julianday(lease_until)>julianday(?))`).all(at);
    if (sameIdentity.some(other=>!(leased && other.id===row.id) && id(other.douyin_id)===input.submittedId)) throw fail('AUTHORISED_ADMISSION_BUSY');
    const prospective={...hydrate(row),status:row.status==='rejected'?'retry':row.status,
      lease_owner:owner,lease_until:leased?row.lease_until:new Date(now.getTime()+60000).toISOString()};
    // New, successful, source-bound platform proof is required before touching
    // a transport-exhausted rejection. It is never a retry-queue reset.
    prepareAuthorisedDetailAdmission({job,sourceRow:body.sourceRow,queueItem:prospective,result,
      startedAt,finishedAt,reference:now,owner});
    if(!leased) {
      const changed=db.prepare(`UPDATE author_resolution_queue SET status=?,lease_owner=?,lease_until=?,updated_at=?
      WHERE id=? AND identity_key=? AND evidence_version=? AND status=?
      AND verification_policy_version=2 AND resolved_target_id IS NULL AND suspended_target_enabled IS NULL
      AND (lease_owner IS NULL OR julianday(lease_until)<=julianday(?))`).run(prospective.status,owner,prospective.lease_until,at,row.id,input.key,row.evidence_version,row.status,at).changes;
      if(changed!==1) throw fail('AUTHORISED_ADMISSION_BUSY');
      db.prepare(`INSERT INTO activity_log(actor_name,action,resource_type,resource_id,created_at,details_json)
      VALUES('系统','author-resolution.claimed','author-resolution-identity',?,?,?)`).run(hash(JSON.stringify(['douyin','submitted-id',input.submittedId])),at,
        JSON.stringify({version:1,policy:'source-bound-authorised-detail-v1',queueId:row.id,evidenceVersion:row.evidence_version,jobId:job.id,sourceRow:body.sourceRow}));
    }
    const current=hydrate(db.prepare('SELECT * FROM author_resolution_queue WHERE id=?').get(row.id));
    const admission=prepareAuthorisedDetailAdmission({job,sourceRow:body.sourceRow,queueItem:current,result,startedAt,finishedAt,reference:new Date(),owner});
    let targetInput=createInput(admission.verifiedRow);
    if(targetInput?.locator!==admission.verifiedRow.locator || !targetInput.metadata?.resolution) throw fail('AUTHORISED_ADMISSION_INVALID');
    targetInput.metadata.resolution.authorisedDetailReceipt=admission.receipt;
    // Correcting a frozen source's submitted ID does not authorize replacing
    // an existing account's name or user-maintained metadata. Keep its current
    // values; only the freshly verified server-owned resolution is renewed.
    // The original source and new proof remain in their immutable receipts.
    if(job.request.masterRosterSupplement?.version===2) {
      const existing=db.prepare(`SELECT label,metadata_json FROM targets
        WHERE type='account' AND provider='public-web' AND locator=? LIMIT 2`).all(targetInput.locator);
      if(existing.length>1) throw fail('AUTHORISED_ADMISSION_INVALID');
      if(existing.length===1) {
        let metadata;try{metadata=JSON.parse(existing[0].metadata_json);}catch{throw fail('AUTHORISED_ADMISSION_INVALID');}
        if(!metadata || typeof metadata!=='object' || Array.isArray(metadata)
          || (metadata.platform??'douyin')!==admission.verifiedRow.platform) throw fail('AUTHORISED_ADMISSION_INVALID');
        targetInput={...targetInput,label:existing[0].label,metadata:{...metadata,resolution:targetInput.metadata.resolution}};
      }
    }
    if(reconsideration.allowed) {
      const prior={status:row.status,attempts:row.attempts,errorCode:reconsideration.code,errorSha256:reconsideration.errorSha256};
      targetInput.metadata.resolution.authorisedDetailReceipt.previousTransportOutcome=prior;
      // Original rejection stays recoverable in the local restricted ledger;
      // no raw upstream failure text goes into the target or HTTP response.
      db.prepare(`INSERT INTO activity_log(actor_name,action,resource_type,resource_id,created_at,details_json)
        VALUES('系统','author-resolution.authorised-reconsideration','author-resolution-queue',?,?,?)`).run(String(row.id),at,
        JSON.stringify({jobId:job.id,sourceRow:body.sourceRow,...prior,
          previous:{status:row.status,attempts:row.attempts,lastError:row.last_error,nextAttemptAt:row.next_attempt_at,evidenceVersion:row.evidence_version}}));
    }
    const committed=database.commitAuthorResolutionTarget(current.id,targetInput,{fileName:job.fileName,sheetName:job.sheetName},
      {owner,evidenceVersion:current.evidence_version,requireUnexpiredLease:true,withinTransaction:true});
    if(!committed) throw fail('AUTHORISED_ADMISSION_STALE');
    db.exec('COMMIT');
    return {monitoringChanged:true,status:'committed',queueId:current.id,...committed};
  } catch(error){db.exec('ROLLBACK');throw error;}
}
