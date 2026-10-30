import { createHash } from 'node:crypto';
import { canonicalAccountLocator, validateSubmittedAccountId } from './author-spreadsheet.mjs';
import { validatedSuccessProof } from './author-resolution-proof.mjs';
import { sameResolvedAuthorEvidence } from './author-evidence-equivalence.mjs';
import { creatorSourceWorkEvidence } from './creator-source-work-evidence.mjs';

const parse = value => { try { return JSON.parse(value); } catch { return null; } };
const digest = value => createHash('sha256').update(value).digest('hex');
const norm = value => String(value ?? '').normalize('NFKC').trim().replace(/^@/, '').toLowerCase();
const validId = value => validateSubmittedAccountId(value, 'douyin').value;
const has = (db, table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));

/** Read a current identity projection without rewriting the original import.
 * New bindings require both the immutable source-row receipt and the strict
 * successful identity receipt. Editable display metadata alone cannot bind.
 */
const snapshotScopes = new WeakMap();
const workProjectionScope = Symbol('creator-source-work-projection');
/** Reuse the expensive ownership index only inside the owning synchronous
 * snapshot scope. A new cutoff, source edition or database write invalidates
 * it; no index survives COMMIT/ROLLBACK followed by another wrapper call. */
export function readCreatorSourceWorkProjectionSnapshot(db, source, reference, read) {
  const scope = db.isTransaction && snapshotScopes.get(db);
  if (!scope) return read();
  let sources = scope.get(workProjectionScope);
  if (!sources) { sources = new WeakMap(); scope.set(workProjectionScope, sources); }
  let reads = sources.get(source);
  if (!reads) { reads = new Map(); sources.set(source, reads); }
  const key = JSON.stringify([reference, db.prepare('SELECT total_changes() n').get().n]);
  if (!reads.has(key)) reads.set(key, read());
  return reads.get(key);
}
/** Synchronous, transaction-scoped reuse only. Never reuse proof across exports or writes. */
export function withCreatorSourceLinkSnapshot(db, callback) {
  if (!db.isTransaction || snapshotScopes.has(db)) return callback();
  const scope = new Map();snapshotScopes.set(db,scope);
  try { return callback(); } finally { snapshotScopes.delete(db); }
}
export function readCurrentCreatorSourceLinks(db, options = {}) {
  const scope = db.isTransaction && snapshotScopes.get(db);
  if (!scope) return readCurrentCreatorSourceLinksUncached(db, options);
  const imported = options.imported;
  const key = JSON.stringify([imported?.id, imported?.source_sha256,
    new Date(options.reference ?? new Date()).getTime(), db.prepare('SELECT total_changes() n').get().n]);
  if (scope.has(key)) return scope.get(key);
  const result = readCurrentCreatorSourceLinksUncached(db, options);
  scope.set(key,result);return result;
}
function readCurrentCreatorSourceLinksUncached(db, { imported, reference = new Date() } = {}) {
  const empty = { accountLinks: [], workLinks: [], fingerprint: digest('no-source'),
    stats: { frozenAccepted: 0, receiptAccepted: 0, rejected: 0, ambiguousAuthors: 0, ambiguousTargets: 0 } };
  if (!has(db, 'creator_source_imports')) return empty;
  imported ||= db.prepare('SELECT * FROM creator_source_imports ORDER BY id DESC LIMIT 1').get();
  if (!imported) return empty;
  const nowMs = new Date(reference).getTime();
  if (!Number.isFinite(nowMs)) throw Error('来源关联读取时间无效');
  const authors = new Map(db.prepare("SELECT row_number,values_json FROM creator_source_rows WHERE import_id=? AND sheet_id='08'")
    .all(imported.id).map(row => [row.row_number, { ...row, values: parse(row.values_json) }]));
  const works = db.prepare("SELECT row_number,values_json FROM creator_source_rows WHERE import_id=? AND sheet_id='09'")
    .all(imported.id).map(row => ({ ...row, values: parse(row.values_json) }));
  const worksByRow = new Map(works.map(row => [row.row_number, row]));
  const byHandle = new Map(), keysByAuthor = new Map();
  for (const row of authors.values()) {
    const key = norm(validId(row.values?.[1]));
    keysByAuthor.set(row.row_number, new Set(key ? [key] : []));
    if (!key) continue;
    if (!byHandle.has(key)) byHandle.set(key, new Set());
    byHandle.get(key).add(row.row_number);
  }
  for (const row of db.prepare("SELECT values_json FROM creator_source_rows WHERE import_id=? AND sheet_id='16'").all(imported.id)) {
    const values = parse(row.values_json), main = byHandle.get(norm(values?.[0]));
    if (main?.size !== 1) continue;
    const authorRow = [...main][0];
    for (const id of String(values?.[1] ?? '').split(/\s*\/\s*/).map(validId).filter(Boolean)) {
      keysByAuthor.get(authorRow).add(norm(id));
    }
  }
  const targets = has(db, 'targets') ? new Map(db.prepare("SELECT id,type,provider,locator,metadata_json FROM targets WHERE type='account'")
    .all().map(row => [row.id, { ...row, metadata: parse(row.metadata_json) }])) : new Map();
  const priorProfile = has(db, 'snapshots') ? db.prepare('SELECT 1 FROM snapshots WHERE target_id=? LIMIT 1') : null;
  const currentTarget = (targetId, canonical, { allowUnsampled = false } = {}) => {
    const target = targets.get(targetId), m = target?.metadata;
    const key = canonicalAccountLocator(target?.locator, 'douyin');
    const anchor = m?.identityVerification?.accountId;
    return target && target.provider === 'public-web' && m && (m.platform ?? 'douyin') === 'douyin'
      && key?.startsWith('secuid:')
      // A strict immutable success receipt can bind a newly admitted account
      // before its first profile sample. An explicit conflicting anchor never
      // passes, and old frozen links still require a current profile anchor.
      && (anchor === target.locator || allowUnsampled && anchor == null && !priorProfile?.get(targetId))
      && (!canonical || key === canonicalAccountLocator(canonical, 'douyin')) ? target : null;
  };
  const stats = { ...empty.stats }, accepted = new Map();
  const add = (authorRow, targetId, matchedId, origin) => {
    const key = `${authorRow}:${targetId}`;
    if (!accepted.has(key)) accepted.set(key, { author_row: authorRow, target_id: targetId, matched_id: matchedId, origin });
  };
  if (has(db, 'creator_source_account_links')) for (const link of db.prepare('SELECT * FROM creator_source_account_links WHERE import_id=?').all(imported.id)) {
    const target = currentTarget(link.target_id), m = target?.metadata;
    const observed = [m?.douyinId, m?.resolution?.publicDouyinId].map(norm);
    const matchedAt = Date.parse(link.matched_at);
    const primary = norm(validId(authors.get(link.author_row)?.values?.[1]));
    if (!target || !primary || byHandle.get(primary)?.size !== 1 || !Number.isFinite(matchedAt) || matchedAt > nowMs || !keysByAuthor.get(link.author_row)?.has(norm(link.matched_id))
      || m.identityVerification?.accountId !== target.locator || !observed.includes(norm(link.matched_id))) { stats.rejected++; continue; }
    add(link.author_row, link.target_id, link.matched_id, 'frozen-current-identity'); stats.frozenAccepted++;
  }
  const proofTables = ['author_resolution_import_sources','author_resolution_success_receipts','author_resolution_queue'];
  if (proofTables.every(table => has(db, table))) {
    const proofFor = db.prepare('SELECT * FROM author_resolution_success_receipts WHERE queue_id=? AND evidence_version=?');
    // Filter by this source at the database boundary. A missing receipt never
    // falls back to a same-nickname or editable public-ID match.
    // No queue_id index exists in older stores. Re-scanning the entire source
    // table once per author makes a few thousand authors take minutes. One
    // bounded membership scan preserves each receipt and all binding checks.
    const sourcesFor = db.prepare(`SELECT * FROM author_resolution_import_sources
      WHERE queue_id IN (SELECT value FROM json_each(?))`);
    const candidates = db.prepare(`SELECT * FROM author_resolution_queue WHERE status='resolved'
      AND json_valid(source_metadata_json) AND json_extract(source_metadata_json,'$.sourceType')='creator-source-sheet'
      AND json_extract(source_metadata_json,'$.sourceSha256')=?`).all(imported.source_sha256);
    const byQueue = new Map(candidates.map(queue => [queue.id, queue]));
    for (const saved of sourcesFor.iterate(JSON.stringify([...byQueue.keys()]))) {
      const queue = byQueue.get(saved.queue_id);
      const payload = parse(saved.payload_json), s = payload?.sourceMetadata, author = authors.get(s?.authorRow), work = worksByRow.get(s?.workRow);
      const successReceipt = proofFor.get(queue.id, queue.evidence_version);
      const proof = successReceipt && validatedSuccessProof(successReceipt);
      const target = proof && currentTarget(proof.targetId, proof.canonicalAccountId, { allowUnsampled: true });
      const observed = Date.parse(saved.observed_at), workEvidence = work && creatorSourceWorkEvidence(work.values, work.row_number);
      const sourceId = norm(validId(author?.values?.[1]));
      const sourceOk = payload && s?.sourceType === 'creator-source-sheet' && s.sourceSha256 === imported.source_sha256
        && digest(saved.payload_json) === saved.receipt_sha256 && author && work && workEvidence
        && s.sourceUrl === imported.source_url && String(s.sourceRevision) === String(imported.source_revision)
        && s.sourceModifiedAt === imported.source_modified_at && s.authorRowSha256 === digest(author.values_json)
        && s.workRowSha256 === digest(work.values_json) && sourceId && byHandle.get(sourceId)?.size === 1
        && sourceId === norm(work.values?.[2]) && Array.isArray(payload.sourceRows)
        && payload.sourceRows.length === 1 && payload.sourceRows[0] === author.row_number
        && Number.isFinite(observed) && observed <= nowMs;
      const admission = proof?.resolution?.authorisedDetailReceipt, bound = admission?.source;
      // The success must have inspected this exact receipt, not another
      // same-identity source appended before/after its admission transaction.
      const receiptBound = admission?.format === 'mcn-creator-source-authorised-detail-v1'
        && admission.identityOnly === true && admission.equivalentLocatorsForOneWork === true
        && bound?.sourceReceiptSha256 === saved.receipt_sha256 && bound.importId === imported.id
        && bound.sourceSha256 === imported.source_sha256 && bound.sourceUrl === imported.source_url
        && String(bound.sourceRevision) === String(imported.source_revision)
        && bound.sourceModifiedAt === imported.source_modified_at
        && bound.authorRow === author?.row_number && bound.workRow === work?.row_number
        && bound.authorRowSha256 === s?.authorRowSha256 && bound.workRowSha256 === s?.workRowSha256
        && bound.videoId === workEvidence?.videoId && bound.shareUrl === workEvidence?.shareUrl
        && admission.queue?.id === queue.id && admission.queue.identityKey === queue.identity_key
        && admission.queue.evidenceVersion === queue.evidence_version;
      const queueOk = proof && target && queue.status === 'resolved' && !queue.lease_owner && !queue.lease_until
        && queue.suspended_target_enabled == null && queue.verification_policy_version === 2
        && proof.platform === 'douyin' && saved.queue_identity_key === queue.identity_key
        && proof.identityKey === queue.identity_key && proof.targetId === queue.resolved_target_id
        && proof.evidence.name === queue.name && norm(proof.evidence.douyinId) === sourceId
        && proof.evidence.accountLocator === queue.account_locator
        && sameResolvedAuthorEvidence(queue, { douyin_id: proof.evidence.douyinId, account_locator: proof.evidence.accountLocator,
          video_ids_json: proof.evidence.videoIds, share_urls_json: proof.evidence.shareUrls })
        && Date.parse(proof.committedAt) >= observed && Date.parse(proof.committedAt) <= nowMs
        && proof.evidence.videoIds.includes(workEvidence?.videoId) && proof.evidence.shareUrls.includes(workEvidence?.shareUrl);
      if (!sourceOk || !receiptBound || !queueOk) { stats.rejected++; continue; }
      add(author.row_number, target.id, author.values[1], 'source-success-receipt'); stats.receiptAccepted++;
    }
  }
  const candidates = [...accepted.values()].sort((a,b) => a.author_row-b.author_row || a.target_id-b.target_id);
  const byAuthor = new Map(), byTarget = new Map();
  for (const row of candidates) {
    if (!byAuthor.has(row.author_row)) byAuthor.set(row.author_row, new Set());
    byAuthor.get(row.author_row).add(row.target_id);
    if (!byTarget.has(row.target_id)) byTarget.set(row.target_id, new Set());
    byTarget.get(row.target_id).add(row.author_row);
  }
  stats.ambiguousAuthors = [...byAuthor.values()].filter(ids => ids.size > 1).length;
  stats.ambiguousTargets = [...byTarget.values()].filter(ids => ids.size > 1).length;
  const links = candidates.filter(row => byAuthor.get(row.author_row).size === 1 && byTarget.get(row.target_id).size === 1);
  stats.rejected += candidates.length - links.length;
  const safeAuthorTargets = new Map(links.map(row => [row.author_row, row.target_id]));
  const workLinks = [];
  for (const work of works) {
    const sourceAuthors = byHandle.get(norm(work.values?.[2]));
    const targetId = sourceAuthors?.size === 1 ? safeAuthorTargets.get([...sourceAuthors][0]) : null;
    if (targetId) workLinks.push({ work_row: work.row_number, target_id: targetId });
  }
  return { accountLinks: links, workLinks,
    fingerprint: digest(JSON.stringify([imported.id, imported.source_sha256, links, workLinks])), stats };
}
