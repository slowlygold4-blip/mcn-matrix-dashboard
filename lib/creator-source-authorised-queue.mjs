import { createHash } from 'node:crypto';
import { buildAuthorEvidenceRequests, verifyQueuedAuthorEvidence } from './author-resolution.mjs';
import { validateSubmittedAccountId } from './author-spreadsheet.mjs';
import { creatorSourceWorkEvidence } from './creator-source-work-evidence.mjs';
import { validateAuthorisedDetailResult } from './douyin-authorised-detail.mjs';
import { requireSameWork } from './import-authorised-detail.mjs';

const SOURCE_TYPE = 'creator-source-sheet';
const SOURCE_FILE = '一条小团团切片作品登记表-来源数据集';
const SHA = /^[a-f0-9]{64}$/;
const HANDLED_ERRORS = new Set([
  'disabled', 'ownership_required', 'invalid_input', 'session_required', 'session_permissions',
  'session_invalid', 'browser_unavailable', 'timeout', 'login_required', 'blocked',
  'rate_limited', 'challenge_required', 'business_error', 'identity_mismatch',
  'invalid_evidence', 'no_bound_response', 'navigation_error', 'collector_error',
  'cleanup_uncertain', 'cancelled', 'BROWSER_LANE_BUSY', 'BROWSER_LANE_LOCKED',
  'AUTHORISED_DETAIL_DISABLED', 'AUTHORISED_DETAIL_UNVERIFIED',
]);
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
const hash = value => createHash('sha256').update(value).digest('hex');
const normalizedId = value => validateSubmittedAccountId(value, 'douyin').value.toLowerCase();
const skipped = code => ({ status: 'skipped', code, attempted: false, monitoringChanged: false });
const unavailable = (code, attempted = false, extra = {}) => ({ status: 'unavailable', code,
  attempted, monitoringChanged: false, ...extra });
const validTime = value => Number.isFinite(Date.parse(value));

export function isCreatorSourceAuthorisedQueue(item) {
  // A damaged source_metadata_json must not route a known source batch into
  // the generic two-evidence anonymous resolver.
  return item?.file_name === SOURCE_FILE
    || (item?.sourceMetadata ?? parse(item?.source_metadata_json))?.sourceType === SOURCE_TYPE;
}

/** Read-only admission candidate. The original imported rows and receipt, not
 * queue display text, establish that both queued locators name one work.
 * A source-bound result is still only a candidate until a fresh page result
 * passes strict public-ID verification and the same checks repeat under lock.
 */
export function prepareCreatorSourceAuthorisedQueue(database, claimedItem, { owner, reference = new Date() } = {}) {
  const db = database?.db;
  const nowMs = reference instanceof Date ? reference.getTime() : Date.parse(reference);
  if (!db || !Number.isFinite(nowMs) || typeof owner !== 'string' || !owner || owner.length > 120
    || !Number.isSafeInteger(claimedItem?.id) || !Number.isSafeInteger(claimedItem?.evidence_version)) return skipped('claim_invalid');
  const row = db.prepare('SELECT * FROM author_resolution_queue WHERE id=?').get(claimedItem.id);
  if (!row || row.identity_key !== claimedItem.identity_key || row.evidence_version !== claimedItem.evidence_version
    || row.lease_owner !== owner || !validTime(row.lease_until) || Date.parse(row.lease_until) <= nowMs) return skipped('claim_stale');
  if (!['pending', 'retry'].includes(row.status) || row.verification_policy_version !== 2
    || row.resolved_target_id !== null || row.suspended_target_enabled !== null) return skipped('queue_not_eligible');
  const metadata = parse(row.source_metadata_json);
  if (metadata?.sourceType !== SOURCE_TYPE || !SHA.test(metadata.sourceSha256 ?? '')
    || !SHA.test(metadata.authorRowSha256 ?? '') || !SHA.test(metadata.workRowSha256 ?? '')
    || !SHA.test(metadata.frozenSourceDigest ?? '') || metadata.identityStatus !== 'unverified-candidate'
    || metadata.authorSheet !== '08_作者总表' || metadata.workSheet !== '09_去重作品'
    || !['direct-work-url','short-work-url-pending-redirect-verification'].includes(metadata.evidenceType)
    || !Number.isSafeInteger(metadata.authorRow) || metadata.authorRow < 2
    || !Number.isSafeInteger(metadata.workRow) || metadata.workRow < 2) return skipped('source_context_stale');
  const videoIds = parse(row.video_ids_json), shareUrls = parse(row.share_urls_json);
  const sourceRows = parse(row.source_rows_json), boards = parse(row.boards_json);
  const submittedId = normalizedId(row.douyin_id);
  if (!submittedId || row.account_locator !== '' || row.file_name !== SOURCE_FILE
    || row.sheet_name !== metadata.authorSheet
    || !Array.isArray(videoIds) || videoIds.length !== 1
    || !Array.isArray(shareUrls) || shareUrls.length !== 1 || !Array.isArray(sourceRows)
    || sourceRows.length !== 1 || sourceRows[0] !== metadata.authorRow || !Array.isArray(boards)) return skipped('source_evidence_conflict');
  const videoId = videoIds[0], shareUrl = shareUrls[0];
  if (typeof videoId !== 'string' || !/^[1-9]\d{14,24}$/.test(videoId)
    || (metadata.evidenceType === 'direct-work-url' && shareUrl !== `https://www.douyin.com/video/${videoId}`)) return skipped('source_evidence_conflict');
  const imported = db.prepare('SELECT * FROM creator_source_imports ORDER BY id DESC LIMIT 1').get();
  if (!imported || imported.source_sha256 !== metadata.sourceSha256
    || imported.source_url !== metadata.sourceUrl
    || String(imported.source_revision) !== String(metadata.sourceRevision)
    || imported.source_modified_at !== metadata.sourceModifiedAt
    || !validTime(imported.imported_at) || Date.parse(imported.imported_at) > nowMs) return skipped('source_version_changed');
  const receipts = db.prepare(`SELECT * FROM author_resolution_import_sources
    WHERE queue_id=? ORDER BY id LIMIT 65`).all(row.id);
  if (receipts.length > 64) return skipped('source_receipt_scan_bound');
  const matches = receipts.filter(candidate => {
    const payload = parse(candidate.payload_json), observed = Date.parse(candidate.observed_at);
    return typeof candidate.payload_json === 'string'
      && candidate.queue_identity_key === row.identity_key && SHA.test(candidate.receipt_sha256 ?? '')
      && hash(candidate.payload_json) === candidate.receipt_sha256 && Number.isFinite(observed)
      && observed <= nowMs && observed >= Date.parse(imported.imported_at)
      && payload?.fileName === row.file_name && payload.sheetName === row.sheet_name
      && JSON.stringify(payload.sourceRows) === JSON.stringify(sourceRows)
      && JSON.stringify(payload.boards) === row.boards_json
      && JSON.stringify(payload.sourceMetadata) === row.source_metadata_json;
  });
  if (!matches.length) return skipped('source_receipt_invalid');
  if (new Set(matches.map(candidate => candidate.receipt_sha256)).size !== 1) return skipped('source_receipt_ambiguous');
  // Identical immutable payloads may have been observed twice. Use the most
  // recent valid observation, bound in the admission fingerprint below.
  const receipt = matches.at(-1);
  const readRow = db.prepare(`SELECT values_json FROM creator_source_rows
    WHERE import_id=? AND sheet_id=? AND row_number=?`);
  const author = readRow.get(imported.id, '08', metadata.authorRow);
  const work = readRow.get(imported.id, '09', metadata.workRow);
  if (!author || !work || hash(author.values_json) !== metadata.authorRowSha256
    || hash(work.values_json) !== metadata.workRowSha256) return skipped('source_row_changed');
  const authorValues = parse(author.values_json), workValues = parse(work.values_json);
  const exactAccountCell = value => typeof value === 'string' || Number.isSafeInteger(value);
  if (!Array.isArray(authorValues) || !Array.isArray(workValues)
    || !exactAccountCell(authorValues[1]) || typeof workValues[0] !== 'string'
    || !exactAccountCell(workValues[2]) || normalizedId(authorValues[1]) !== submittedId
    || normalizedId(workValues[2]) !== submittedId || workValues[0] !== videoId
    || String(authorValues[0] ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim() !== row.name) return skipped('source_evidence_conflict');
  let workEvidence;
  try { if (metadata.evidenceType === 'direct-work-url') requireSameWork(workValues[11], videoId); workEvidence = creatorSourceWorkEvidence(workValues, metadata.workRow); }
  catch { return skipped('source_evidence_conflict'); }
  if (workEvidence?.evidenceType !== metadata.evidenceType || workEvidence.videoId !== videoId
    || workEvidence.shareUrl !== shareUrl) return skipped('source_evidence_conflict');
  // A duplicate primary ID makes the source author row ambiguous even if the
  // first matching row happens to have a valid video. Do not pick by order.
  let primaryMatches = 0;
  for (const value of db.prepare(`SELECT values_json FROM creator_source_rows WHERE import_id=? AND sheet_id='08'`).iterate(imported.id)) {
    if (normalizedId(parse(value.values_json)?.[1]) === submittedId && ++primaryMatches > 1) break;
  }
  if (primaryMatches !== 1) return skipped('source_author_ambiguous');
  const requests = buildAuthorEvidenceRequests([{ name: row.name, douyinId: row.douyin_id,
    videoId, shareUrl, sourceRow: metadata.authorRow, boards }]);
  if (requests.length !== 1 || requests[0].key !== row.identity_key
    || requests[0].videoIds.length !== 1 || requests[0].videoIds[0] !== videoId
    || requests[0].shareUrls.length !== 1 || requests[0].shareUrls[0] !== shareUrl) return skipped('source_evidence_conflict');
  const fingerprint = hash(JSON.stringify([imported.id, imported.source_sha256, row.id, row.identity_key,
    row.evidence_version, row.name, row.douyin_id, row.account_locator, row.file_name, row.sheet_name,
    row.boards_json, row.video_ids_json, row.share_urls_json, row.source_rows_json,
    row.source_metadata_json, receipt.receipt_sha256, receipt.observed_at,
    metadata.authorRowSha256, metadata.workRowSha256]));
  return { status: 'ready', input: { key: row.identity_key, ...(metadata.evidenceType === 'direct-work-url' ? { videoId } : { shareUrl }), submittedId },
    source: { importId: imported.id, sourceSha256: imported.source_sha256, sourceUrl: imported.source_url,
      sourceRevision: imported.source_revision, sourceModifiedAt: imported.source_modified_at,
      authorRow: metadata.authorRow, workRow: metadata.workRow, authorRowSha256: metadata.authorRowSha256,
      workRowSha256: metadata.workRowSha256, sourceReceiptSha256: receipt.receipt_sha256, videoId, shareUrl },
    queue: row, boards, fingerprint };
}

function verifiedSourceRow(prepared, proof) {
  const { queue, source, boards } = prepared;
  if (proof.candidate.videoId !== source.videoId) return null;
  const candidate = { ...proof.candidate,
    canonicalUrl: `https://www.douyin.com/user/${proof.candidate.secUid}`,
    evidenceUrl: `https://www.douyin.com/video/${source.videoId}`,
    sourceEvidenceUrl: source.shareUrl,
    endpoint: `${proof.evidence.origin}${proof.evidence.path}` };
  const verified = verifyQueuedAuthorEvidence({ key: queue.identity_key, platform: 'douyin',
    name: queue.name, douyinId: queue.douyin_id, accountLocator: '', videoIds: [source.videoId],
    shareUrls: [source.shareUrl], sourceRows: [source.authorRow], boards },
  { key: queue.identity_key, candidates: [candidate], errors: [] });
  if (verified.status !== 'ready' || verified.row?.locator !== proof.candidate.secUid
    || verified.row.resolution?.verificationPolicy !== 'all-submitted-evidence-v2'
    || verified.row.resolution.verifiedEvidenceCount !== 2) return null;
  const row = structuredClone(verified.row);
  row.resolution.resolvedAt = proof.evidence.observedAt;
  return row;
}

/** Commit after a second, write-locked source/receipt/lease check. No source
 * table is rewritten and no completed author_resolution_jobs row is invented.
 */
export function commitCreatorSourceAuthorisedQueue(database, prepared, result,
  { owner, startedAt, finishedAt, createInput } = {}) {
  if (typeof createInput !== 'function' || prepared?.status !== 'ready') return skipped('runtime_invalid');
  const db = database.db, now = new Date(), nowMs = now.getTime();
  let proof;
  try { proof = validateAuthorisedDetailResult(prepared.input, result, { startedAt, finishedAt }); }
  catch (error) { return unavailable(HANDLED_ERRORS.has(error?.code) ? error.code : 'AUTHORISED_DETAIL_UNVERIFIED', true); }
  if (proof.status !== 'ok') return unavailable(proof.errorCode, true, { result: proof, startedAt, finishedAt,
    sourceRow: prepared.source.authorRow });
  const observed = Date.parse(proof.evidence.observedAt);
  if (!Number.isFinite(observed) || observed > nowMs || nowMs - observed > 30 * 60_000) return unavailable('AUTHORISED_ADMISSION_STALE', true);
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = prepareCreatorSourceAuthorisedQueue(database, prepared.queue, { owner, reference: now });
    if (current.status !== 'ready' || current.fingerprint !== prepared.fingerprint) {
      db.exec('ROLLBACK'); return unavailable('AUTHORISED_ADMISSION_STALE', true);
    }
    const row = verifiedSourceRow(current, proof);
    if (!row) { db.exec('ROLLBACK'); return unavailable('AUTHORISED_ADMISSION_INVALID', true); }
    // createInput is the same existing server-owned author-target normalizer.
    // sourceContext is not an author_resolution_jobs record and has no job ID.
    const sourceContext = { fileName: current.queue.file_name, sheetName: current.queue.sheet_name,
      request: { sourceType: SOURCE_TYPE, sourceUrl: current.source.sourceUrl,
        sourceRevision: current.source.sourceRevision, sourceSha256: current.source.sourceSha256 } };
    const input = createInput(sourceContext, row);
    // The existing importableAuthorTargets normalizer intentionally returns
    // only {label,locator,metadata,boards}; the database commit supplies the
    // account/public-web constants. Reject contradictory explicit fields.
    if (!input || (input.type !== undefined && input.type !== 'account')
      || (input.provider !== undefined && input.provider !== 'public-web')
      || input.locator !== row.locator || input.metadata?.platform !== 'douyin'
      || input.metadata?.resolution?.verificationPolicy !== 'all-submitted-evidence-v2'
      || input.metadata.resolution.verifiedEvidenceSha256 !== row.resolution.verifiedEvidenceSha256) {
      db.exec('ROLLBACK'); return unavailable('AUTHORISED_ADMISSION_INVALID', true);
    }
    const receipt = { format: 'mcn-creator-source-authorised-detail-v1', identityOnly: true,
      source: { ...current.source }, queue: { id: current.queue.id,
        identityKey: current.queue.identity_key, evidenceVersion: current.queue.evidence_version,
        videoIds: [current.source.videoId], shareUrls: [current.source.shareUrl],
        sourceRows: [current.source.authorRow] },
      requestStartedAt: proof.requestStartedAt, requestFinishedAt: proof.requestFinishedAt,
      observedAt: proof.evidence.observedAt, preparedAt: now.toISOString(),
      responseSha256: proof.evidence.responseSha256,
      evidence: structuredClone(proof.evidence), provenance: structuredClone(proof.provenance),
      equivalentLocatorsForOneWork: true, metricsSampled: false, allAccountWorksCollected: false };
    input.metadata = { ...input.metadata, platform: 'douyin', douyinId: current.queue.douyin_id,
      importSource: { type: SOURCE_TYPE, fileName: current.queue.file_name,
        sheetName: current.queue.sheet_name, sourceRow: current.source.authorRow,
        sourceUrl: current.source.sourceUrl, sourceRevision: current.source.sourceRevision,
        sourceSha256: current.source.sourceSha256, importedAt: now.toISOString() },
      resolution: { ...row.resolution, authorisedDetailReceipt: receipt } };
    const committed = database.commitAuthorResolutionTarget(current.queue.id, input,
      { fileName: current.queue.file_name, sheetName: current.queue.sheet_name },
      { owner, evidenceVersion: current.queue.evidence_version,
        requireUnexpiredLease: true, withinTransaction: true });
    if (committed?.status === 'identity_conflict') {
      db.exec('COMMIT');
      return { status: 'rejected', code: 'AUTHOR_TARGET_PUBLIC_ID_CONFLICT', attempted: true,
        monitoringChanged: false, sourceRow: current.source.authorRow, result: proof };
    }
    if (!committed) { db.exec('ROLLBACK'); return unavailable('AUTHORISED_ADMISSION_STALE', true); }
    db.exec('COMMIT');
    return { status: 'resolved', code: null, attempted: true, monitoringChanged: true,
      sourceRow: current.source.authorRow, result: proof, admission: committed };
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    return unavailable(error?.code === 'AUTHOR_TARGET_PUBLIC_ID_CONFLICT' ? error.code : 'AUTHORISED_ADMISSION_INVALID', true);
  }
}

export async function runCreatorSourceAuthorisedQueue(database, claimedItem,
  { owner, provider, signal, createInput } = {}) {
  if (signal?.aborted) return unavailable('cancelled');
  const prepared = prepareCreatorSourceAuthorisedQueue(database, claimedItem, { owner });
  if (prepared.status !== 'ready') return prepared;
  if (typeof provider?.resolveAuthorisedDetail !== 'function' || typeof createInput !== 'function') return skipped('runtime_invalid');
  const startedAt = new Date().toISOString();
  let result;
  try {
    result = await provider.resolveAuthorisedDetail({ items: [prepared.input] });
  } catch (error) {
    return unavailable(HANDLED_ERRORS.has(error?.code) ? error.code : 'AUTHORISED_DETAIL_UNVERIFIED');
  }
  const finishedAt = new Date().toISOString();
  if (signal?.aborted) return unavailable('cancelled');
  return commitCreatorSourceAuthorisedQueue(database, prepared, result,
    { owner, startedAt, finishedAt, createInput });
}
