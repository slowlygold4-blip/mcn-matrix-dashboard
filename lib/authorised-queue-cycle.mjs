import { runQueuedAuthorisedImport } from './authorised-import-queue.mjs';
import { recordImportAuthorisedAttempt, authorisedAttemptReason } from './import-authorised-attempts.mjs';
import { authorQueuePlatform } from './author-queue-identity.mjs';

const STOP = new Set(['disabled','ownership_required','session_required','session_permissions','session_invalid','browser_unavailable',
  'login_required','blocked','rate_limited','challenge_required','cleanup_uncertain','cancelled','collector_error',
  'AUTHORISED_DETAIL_DISABLED','AUTHORISED_DETAIL_UNVERIFIED','BROWSER_LANE_BUSY','BROWSER_LANE_LOCKED',
  'AUTHORISED_ADMISSION_BUSY','AUTHORISED_ADMISSION_STALE','AUTHORISED_ADMISSION_NOT_ELIGIBLE','AUTHORISED_ADMISSION_INVALID']);

export function isCurrentAuthorQueueClaim(database, item, owner, now = Date.now()) {
  const row = database.db.prepare('SELECT * FROM author_resolution_queue WHERE id=?').get(item.id);
  return Boolean(row && row.identity_key === item.identity_key && row.evidence_version === item.evidence_version
    && row.lease_owner === owner && Date.parse(row.lease_until) > now && row.verification_policy_version === 2
    && ['pending','retry'].includes(row.status) && row.resolved_target_id === null && row.suspended_target_enabled === null);
}

/** A local wait is not a failed platform attempt. Preserve the failure budget. */
export function deferAuthorisedQueueClaim(database, item, { owner, nextAttemptAt, reason } = {}) {
  if (!owner || !Number.isSafeInteger(item?.evidence_version) || !Number.isFinite(Date.parse(nextAttemptAt))) return false;
  return database.db.prepare(`UPDATE author_resolution_queue SET next_attempt_at=?,last_error=?,lease_owner=NULL,lease_until=NULL,updated_at=?
    WHERE id=? AND identity_key=? AND evidence_version=? AND lease_owner=? AND status IN ('pending','retry')
      AND resolved_target_id IS NULL AND suspended_target_enabled IS NULL`).run(nextAttemptAt, String(reason).slice(0,300),
        new Date().toISOString(), item.id, item.identity_key, item.evidence_version, owner).changes === 1;
}

/** Reuses the existing tick, claim and provider lane; no new timers/daemon. */
export async function runAuthorisedQueueCycle(database, due, { owner, provider, signal, createInput, retryAt,
  run = runQueuedAuthorisedImport, now = Date.now } = {}) {
  const legacy = [], outcomes = [];
  let stopped = false;
  for (const item of due) {
    const claim = { owner, evidenceVersion: item.evidence_version };
    if (stopped || signal?.aborted) {
      deferAuthorisedQueueClaim(database, item, { owner, nextAttemptAt:new Date(now()+30*60_000).toISOString(), reason:'本批已安全停止，未向平台重复核验；稍后按计划检查' });
      continue;
    }
    const outcome = await run(database,item,{owner,provider,signal,createInput});
    outcomes.push({queueId:item.id,status:outcome.status,code:outcome.code,attempted:outcome.attempted});
    if (outcome.status === 'resolved') continue;
    if (outcome.status === 'skipped') {
      // These inputs were never sent to the authorised channel. Keep the
      // existing multi-evidence/non-Douyin resolver and its strict verifier.
      if ((outcome.code === 'evidence_not_single' || outcome.code === 'queue_not_eligible' && authorQueuePlatform(item) !== 'douyin')
        && isCurrentAuthorQueueClaim(database,item,owner,now())) legacy.push(item);
      else deferAuthorisedQueueClaim(database,item,{owner,nextAttemptAt:new Date(now()+30*60_000).toISOString(),reason:'原始任务与证据来源尚未能唯一关联；未作为网络失败消耗重试次数'});
      continue;
    }
    if (outcome.result?.status === 'unavailable') recordImportAuthorisedAttempt(database.db,outcome.job,{
      sourceRow:outcome.sourceRow,result:outcome.result,startedAt:outcome.startedAt,finishedAt:outcome.finishedAt });
    const reason = authorisedAttemptReason(outcome.code, outcome.result?.diagnostic);
    if (STOP.has(outcome.code) || outcome.attempted !== true) {
      stopped = true;
      deferAuthorisedQueueClaim(database,item,{owner,nextAttemptAt:new Date(now()+30*60_000).toISOString(),reason});
    } else database.markAuthorResolutionRetry(item.id,reason,retryAt(item.attempts),claim);
  }
  // Once a gate is encountered, no earlier deferred legacy request may become
  // an alternate access path in the same batch.
  if (stopped || signal?.aborted) {
    for (const item of legacy) deferAuthorisedQueueClaim(database,item,{owner,nextAttemptAt:new Date(now()+30*60_000).toISOString(),reason:'本批访问受限，未切换其他方式继续请求'});
    return {legacy:[],outcomes,stopped:true};
  }
  return {legacy,outcomes,stopped:false};
}
