import { createHash } from 'node:crypto';
import { buildAuthorEvidenceRequests, verifyQueuedAuthorEvidence } from './author-resolution.mjs';
import { prepareImportAuthorisedDetail } from './import-authorised-detail.mjs';
import { validateAuthorisedDetailResult } from './douyin-authorised-detail.mjs';
import { bindQueuedImportEvidence } from './queued-import-evidence.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const normalizeId = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/^@/, '').toLowerCase() : '';
const sha256 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const empty = value => value === null || value === undefined || value === '';
function rejected(message) {
  return Object.assign(new TypeError(message), { code: 'AUTHORISED_DETAIL_ADMISSION_REJECTED', statusCode: 409 });
}
function queueArray(queue, storedKey, parsedKey) {
  let value;
  try { value = JSON.parse(queue[storedKey]); } catch { throw rejected('原队列证据格式无效'); }
  if (!Array.isArray(value) || (queue[parsedKey] !== undefined && !equal(queue[parsedKey], value))) throw rejected('原队列与当前解析证据不一致');
  return value;
}
function sourceField(job, camel, snake, { allowEmpty = false } = {}) {
  const values = [job[camel], job[snake]].filter(value => value !== undefined);
  if (!values.length || values.some(value => typeof value !== 'string' || (!allowEmpty && !value) || value !== values[0])) throw rejected('原任务来源文件信息不完整或冲突');
  return values[0];
}

/** Pure source/proof adapter only. The caller must validate immutable source
 * receipts before claiming, then recheck the actual unexpired lease and exact
 * evidence in the commit transaction. No admission or sampling happens here.
 * This version admits exactly one direct work OR one exact short share. A
 * redirect's work ID never becomes a second, supposedly submitted work ID.
 * Suspended claims and prior resolved targets are outside this adapter.
 */
export function prepareAuthorisedDetailAdmission({ job, sourceRow, queueItem, result, startedAt, finishedAt, reference, owner } = {}) {
  const { input, request: boundRequest, originalInput } = bindQueuedImportEvidence(job, sourceRow, queueItem);
  if (typeof job.id !== 'string' || !job.id || job.id.length > 120 || /[\u0000-\u001f\u007f-\u009f]/.test(job.id)) throw rejected('缺少不可变原任务标识');
  const share = input.shareUrl !== undefined;
  const now = reference instanceof Date ? reference.getTime() : typeof reference === 'string' ? Date.parse(reference) : NaN;
  if (!Number.isFinite(now) || typeof owner !== 'string' || !owner || owner.length > 120 || /[\u0000-\u001f\u007f-\u009f]/.test(owner)) {
    throw rejected('缺少有效核验时间或队列租约 owner');
  }
  const proof = validateAuthorisedDetailResult(input, result, { startedAt, finishedAt });
  if (proof.status !== 'ok') throw rejected('本次未取得可用于接入的已核验作品身份');
  const observed = Date.parse(proof.evidence.observedAt), ended = Date.parse(finishedAt);
  if (ended > now || observed > now || now - observed > 30 * 60_000) throw rejected('作品身份回执已过期或时间位于未来');
  const queue = queueItem;
  if (!object(queue) || !Number.isSafeInteger(queue.id) || queue.id < 1
    || !Number.isSafeInteger(queue.evidence_version) || queue.evidence_version < 1 || queue.verification_policy_version !== 2
    || !['pending', 'retry'].includes(queue.status) || queue.lease_owner !== owner
    || typeof queue.lease_until !== 'string' || !Number.isFinite(Date.parse(queue.lease_until)) || Date.parse(queue.lease_until) <= now
    || !empty(queue.suspended_target_enabled) || !empty(queue.resolved_target_id)) throw rejected('队列未持有有效独占租约、已终结或涉及暂停恢复');
  if (queue.identity_key !== input.key || normalizeId(queue.douyin_id) !== input.submittedId
    || (queue.platform !== undefined && queue.platform !== 'douyin')) throw rejected('队列身份与所选原始行不一致');
  const fileName = sourceField(job, 'fileName', 'file_name'), sheetName = sourceField(job, 'sheetName', 'sheet_name', { allowEmpty: true });
  if (queue.file_name !== fileName || queue.sheet_name !== sheetName) throw rejected('队列不是当前原始文件和工作表的证据');
  const videoIds = queueArray(queue, 'video_ids_json', 'videoIds');
  const shareUrls = queueArray(queue, 'share_urls_json', 'shareUrls');
  const sourceRows = queueArray(queue, 'source_rows_json', 'sourceRows');
  const singleEvidenceMatches = share
    ? videoIds.length === 0 && shareUrls.length === 1 && shareUrls[0] === input.shareUrl
    : videoIds.length === 1 && videoIds[0] === input.videoId && shareUrls.length === 0;
  if (!singleEvidenceMatches
    || !sourceRows.includes(sourceRow) || sourceRows.some(value => !Number.isSafeInteger(value) || value < 1)) throw rejected('单次作品结果不能覆盖该队列全部原始证据');
  const originalRow = job.request.rows.find(row => row.sourceRow === sourceRow);
  const requests = [boundRequest];
  if (requests.length !== 1 || requests[0].key !== input.key || (share
    ? requests[0].videoIds.length !== 0 || requests[0].shareUrls.length !== 1 || requests[0].shareUrls[0] !== input.shareUrl
    : requests[0].videoIds.length !== 1 || requests[0].shareUrls.length !== 0)) throw rejected('所选原行不属于单一作品证据核验范围');
  const canonical = requests[0].accountLocator || '';
  if ((queue.account_locator || '') !== canonical || (queue.accountLocator !== undefined && queue.accountLocator !== canonical)) {
    throw rejected('原队列的 canonical 身份约束发生变化');
  }
  const candidate = { ...proof.candidate, canonicalUrl: `https://www.douyin.com/user/${proof.candidate.secUid}`,
    evidenceUrl: `https://www.douyin.com/video/${proof.candidate.videoId}`, endpoint: `${proof.evidence.origin}${proof.evidence.path}`,
    ...(share ? { sourceEvidenceUrl: input.shareUrl } : {}) };
  const verification = verifyQueuedAuthorEvidence({ ...requests[0], sourceRows: [sourceRow] },
    { key: input.key, candidates: [candidate], errors: [] });
  if (verification.status !== 'ready' || verification.row?.resolution?.verificationPolicy !== 'all-submitted-evidence-v2'
    || verification.row.resolution.verifiedEvidenceCount !== 1 || verification.row.locator !== proof.candidate.secUid) {
    throw rejected('现有逐项作品身份审查未通过');
  }
  const receipt = {
    format: 'mcn-authorised-detail-admission-v1', scope: 'one-queue-all-submitted-work-evidence', identityOnly: true,
    source: { jobId: job.id, fileName, sheetName, sourceRow, sourceRowSha256: sha256(originalRow), evidenceRequestKey: input.key,
      ...(originalInput.key !== input.key ? { originalEvidenceRequestKey: originalInput.key,
        additionalCanonicalConstraint: input.expectedSecUid } : {}) },
    queue: { id: queue.id, identityKey: queue.identity_key, evidenceVersion: queue.evidence_version,
      verificationPolicyVersion: queue.verification_policy_version, videoIds: [...videoIds], shareUrls: [...shareUrls], sourceRows: [...sourceRows] },
    requestStartedAt: proof.requestStartedAt, requestFinishedAt: proof.requestFinishedAt,
    observedAt: proof.evidence.observedAt, preparedAt: new Date(now).toISOString(),
    responseSha256: proof.evidence.responseSha256, responseSha256Scope: proof.evidence.responseSha256Scope,
    evidence: structuredClone(proof.evidence), provenance: structuredClone(proof.provenance),
    metricsSampled: false, allAccountWorksCollected: false,
  };
  const verifiedRow = structuredClone(verification.row);
  verifiedRow.resolution.resolvedAt = proof.evidence.observedAt;
  verifiedRow.resolution.authorisedDetailReceipt = structuredClone(receipt);
  return { verifiedRow, receipt,
    expected: { queueId: queue.id, owner, evidenceVersion: queue.evidence_version } };
}
