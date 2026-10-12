import { isVerifiedDeferredWorksSnapshot, MAX_DEFERRED_SOURCE_BYTES } from './works-deferred-snapshot.mjs';

export const DEFERRED_SNAPSHOT_LOOKBACK = 16;
export const MAX_DEFERRED_READ_BYTES = 8 * 1024 * 1024;

export function loadVerifiedDeferredSnapshotIds(db, asOf, targetId = null, latestAttemptByTarget = new Map()) {
  return loadDeferredWorksSnapshotRead(db, asOf, targetId, latestAttemptByTarget).ignoredIds;
}

/** Caller owns the read transaction. Only verify a bounded newest prefix per
 * account, stopping at its first actual/unknown attempt. Unverified candidates
 * remain in the caller's latest selection, including after either limit.
 * latestAttemptByTarget only stops work before an already loaded ledger attempt;
 * it cannot authorize excluding a row. The merge still retains those older rows.
 * No migrations, network, history rewrites, or caller-provided trusted flags.
 */
export function loadDeferredWorksSnapshotRead(db, asOf, targetId = null, latestAttemptByTarget = new Map()) {
  const nowMs = Date.parse(asOf);
  if (!Number.isFinite(nowMs) || targetId !== null && (!Number.isSafeInteger(targetId) || targetId < 1)) throw new TypeError('作品暂缓读取范围无效');
  const ignored = new Set(), budgetLimitedSnapshotIds = new Set();
  const result = { ignoredIds: ignored, budgetLimitedSnapshotIds };
  const columns = name => new Set(db.prepare(`PRAGMA table_info(${name})`).all().map(column => column.name));
  const targetColumns = columns('targets'), snapshotColumns = columns('snapshots'), auditColumns = columns('audits'), runColumns = columns('runs');
  const has = (fields, expected) => expected.every(field => fields.has(field));
  if (!has(targetColumns, ['id','type','provider','locator'])
    || !has(snapshotColumns, ['id','target_id','captured_at','followers','total_likes','total_posts','quality_status','account_status','works_coverage','source_checksum','raw_json'])
    || !has(auditColumns, ['id','target_id','run_id','provider','status','source_checksum','created_at'])
    || !has(runColumns, ['id','started_at','finished_at'])) return result;
  const hasWorksTime = snapshotColumns.has('works_observed_at');
  const worksTime = hasWorksTime ? 'COALESCE(candidate.works_observed_at,candidate.captured_at)' : 'candidate.captured_at';
  const sql = `WITH selected_targets AS (SELECT id
      FROM targets WHERE type='account' ${targetId === null ? '' : 'AND id=?'}), candidates AS (
      SELECT s.id,s.target_id,s.captured_at,${hasWorksTime ? 's.works_observed_at' : 'NULL'} AS works_observed_at
      FROM selected_targets t JOIN snapshots s ON s.id IN (
        SELECT candidate.id FROM snapshots candidate WHERE candidate.target_id=t.id AND candidate.quality_status!='rejected'
          AND julianday(${worksTime})<=julianday(?)
        ORDER BY julianday(${worksTime}) DESC,candidate.id DESC LIMIT ${DEFERRED_SNAPSHOT_LOOKBACK})
    ) SELECT c.*,ROW_NUMBER() OVER (PARTITION BY c.target_id ORDER BY julianday(COALESCE(c.works_observed_at,c.captured_at)) DESC,c.id DESC) AS candidate_rank
    FROM candidates c
    ORDER BY candidate_rank,c.target_id`;
  const args = targetId === null ? [asOf] : [targetId,asOf];
  // Ranking carries only IDs/times. Fetch proof bytes after the per-account
  // barrier/cutoff checks, rather than sorting all bounded raw payloads and
  // running their audit joins even when the caller will never verify them.
  const payload = db.prepare(`SELECT t.type AS target_type,t.provider AS target_provider,t.locator AS target_locator,
      ${targetColumns.has('metadata_json') ? 't.metadata_json' : "'{}'"} AS target_metadata_json,
      s.id,s.target_id,s.captured_at,s.followers,s.total_likes,s.total_posts,s.quality_status,s.account_status,s.works_coverage,s.source_checksum,
      ${hasWorksTime ? 's.works_observed_at' : 'NULL'} AS works_observed_at,
      CASE WHEN s.works_coverage='unavailable' AND length(s.raw_json)<=${MAX_DEFERRED_SOURCE_BYTES} AND json_valid(s.raw_json)
        THEN CASE WHEN json_extract(s.raw_json,'$.worksErrorCode')='deferred'
          AND json_extract(s.raw_json,'$.works.pagination.requestCount')=0 THEN s.raw_json END END AS raw_json
    FROM snapshots s JOIN targets t ON t.id=s.target_id WHERE s.id=?`);
  const audit = db.prepare(`SELECT a.id AS audit_id,a.target_id AS audit_target_id,a.run_id,a.provider AS audit_provider,a.status AS audit_status,
      a.source_checksum AS audit_checksum,a.created_at AS audited_at,r.started_at,r.finished_at
    FROM snapshots s JOIN audits a ON a.target_id=s.target_id AND a.source_checksum=s.source_checksum JOIN runs r ON r.id=a.run_id
    WHERE s.id=? AND a.provider='public-web' AND a.status IN ('validated','warning')
      ${runColumns.has('target_id') ? 'AND (r.target_id IS NULL OR r.target_id=s.target_id)' : ''}
      AND julianday(r.started_at)<=julianday(s.captured_at) AND julianday(s.captured_at)<=julianday(a.created_at)
      AND julianday(a.created_at)<=julianday(?)
      AND (r.finished_at IS NULL OR (julianday(a.created_at)<=julianday(r.finished_at) AND julianday(r.finished_at)<=julianday(?)))
    ORDER BY julianday(a.created_at) DESC,a.id DESC LIMIT 1`);
  const stoppedTargets = new Set();
  let bytes = 0;
  for (const candidate of db.prepare(sql).iterate(...args)) {
    if (stoppedTargets.has(candidate.target_id)) continue;
    const latestAttempt = Date.parse(latestAttemptByTarget.get(candidate.target_id));
    if (Number.isFinite(latestAttempt) && latestAttempt <= nowMs
      && Date.parse(candidate.works_observed_at ?? candidate.captured_at) <= latestAttempt) {
      stoppedTargets.add(candidate.target_id);
      continue;
    }
    const row = payload.get(candidate.id);
    const size = typeof row.raw_json === 'string' ? Buffer.byteLength(row.raw_json,'utf8') : 0;
    if (bytes + size > MAX_DEFERRED_READ_BYTES) {
      // This candidate remains a barrier, but its apparent deferral has not
      // been verified. Do not present that lack of verification as a request.
      budgetLimitedSnapshotIds.add(row.id);
      stoppedTargets.add(row.target_id);
      continue;
    }
    bytes += size;
    if (!size) { stoppedTargets.add(row.target_id); continue; }
    const proof = audit.get(row.id, asOf, asOf) ?? {};
    const target = { id:row.target_id,type:row.target_type,provider:row.target_provider,locator:row.target_locator,metadata_json:row.target_metadata_json };
    const evidence = { ...row, collectionEvidence:{ auditId:proof.audit_id,runId:proof.run_id,targetId:proof.audit_target_id,provider:proof.audit_provider,
      status:proof.audit_status,sourceChecksum:proof.audit_checksum,auditAt:proof.audited_at,runStartedAt:proof.started_at,runFinishedAt:proof.finished_at } };
    if (isVerifiedDeferredWorksSnapshot(evidence,target,{nowMs})) ignored.add(row.id);
    else stoppedTargets.add(row.target_id);
  }
  return result;
}
