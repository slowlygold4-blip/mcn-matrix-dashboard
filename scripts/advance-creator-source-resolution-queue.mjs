import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  candidateBatchKey,
  enqueueCreatorSourceResolutionCandidates,
  parseEnqueueArguments,
  previousBatch,
} from './enqueue-creator-source-resolution-candidates.mjs';

// This is deliberately a one-shot governor, not a scheduler. An invocation
// may enqueue at most one small batch; a later invocation resumes from the
// last complete receipt chain. No model, paid API, or collection is invoked.
export const BATCH_POLICY = Object.freeze({
  maxBatchSize: 20,
  maxGlobalActive: 5000,
  maxSourceActive: 20,
  minimumEvaluatedSample: 10,
  evaluationWindow: 50,
  minimumSuccessRatio: 0.25,
  maximum403Ratio: 0.30,
  maxReceiptChain: 500,
});

const SHA = /^[a-f0-9]{64}$/i;
const blocked403 = error => /(?:^|\D)403(?:\D|$)|http[_ -]?forbidden|访问受限|access[_ -]?denied/i.test(String(error || ''));

export function parseAdvanceArguments(argv) {
  if (argv.includes('--after-author-row'))
    throw new Error('自治入队必须使用已完成收据自动续接；不可手动跳过作者行');
  const options = parseEnqueueArguments(argv);
  if (!SHA.test(options.sourceSha)) throw new Error('必须固定 --source-sha，防止静默切换来源');
  if (options.limit > BATCH_POLICY.maxBatchSize)
    throw new Error(`自治入队每次最多 ${BATCH_POLICY.maxBatchSize} 位作者`);
  return options;
}

export function resumeAuthorRow(db, sourceSha, limit, policy = BATCH_POLICY) {
  if (!SHA.test(sourceSha) || !Number.isSafeInteger(limit) || limit < 1 || limit > policy.maxBatchSize)
    throw new Error('来源 SHA 或小批量大小无效');
  let afterAuthorRow = 0;
  for (let count = 0; count < policy.maxReceiptChain; count++) {
    const key = candidateBatchKey({ sourceSha, afterAuthorRow, limit });
    const batch = previousBatch(db, key, sourceSha);
    if (!batch) return { afterAuthorRow, completedBatches: count, nextBatchKey: key };
    if (!Number.isSafeInteger(batch.lastAuthorRow) || batch.lastAuthorRow <= afterAuthorRow)
      throw new Error('来源收据游标未前进；拒绝自动续接');
    afterAuthorRow = batch.lastAuthorRow;
  }
  throw new Error('连续批次超过安全上限；请人工审查收据链');
}

export function readQueueHealth(db, sourceSha) {
  const globalActive = db.prepare("SELECT COUNT(*) n FROM author_resolution_queue WHERE status IN ('pending','retry')").get().n;
  const rows = db.prepare(`SELECT q.id,q.status,q.attempts,q.last_error
    FROM author_resolution_import_sources r
    JOIN author_resolution_queue q ON q.id=r.queue_id
    WHERE json_valid(r.payload_json)
      AND json_extract(r.payload_json,'$.sourceMetadata.identityStatus')='unverified-candidate'
      AND json_extract(r.payload_json,'$.sourceMetadata.sourceSha256')=?`).all(sourceSha);
  const unique = [...new Map(rows.map(row => [row.id, row])).values()];
  const active = unique.filter(row => row.status === 'pending' || row.status === 'retry').length;
  const settled = unique.filter(row => row.status === 'resolved' || row.status === 'rejected');
  // Evaluate the newest attempted candidates, not an all-time average that
  // could hide a fresh access-control failure behind earlier successes.
  const evaluated = unique.filter(row => Number(row.attempts) > 0
    || row.status === 'resolved' || row.status === 'rejected')
    .sort((a, b) => b.id - a.id).slice(0, BATCH_POLICY.evaluationWindow);
  const success = evaluated.filter(row => row.status === 'resolved').length;
  const failures403 = evaluated.filter(row => row.status !== 'resolved' && blocked403(row.last_error)).length;
  return { globalActive, sourceActive: active, sourceTotal: unique.length,
    settled: settled.length, evaluated: evaluated.length,
    evaluationWindow: BATCH_POLICY.evaluationWindow, success, failures403,
    successRatio: evaluated.length ? success / evaluated.length : null,
    failure403Ratio: evaluated.length ? failures403 / evaluated.length : null };
}

export function evaluateQueueHealth(health, policy = BATCH_POLICY, incoming = 0) {
  const reasons = [];
  if (health.globalActive + incoming > policy.maxGlobalActive)
    reasons.push(`全局待处理队列 ${health.globalActive} 加本批 ${incoming} 将超过 ${policy.maxGlobalActive}`);
  if (health.sourceActive + incoming > policy.maxSourceActive)
    reasons.push(`本来源待处理队列 ${health.sourceActive} 加本批 ${incoming} 将超过 ${policy.maxSourceActive}`);
  if (health.evaluated >= policy.minimumEvaluatedSample) {
    if (health.successRatio < policy.minimumSuccessRatio)
      reasons.push(`已尝试 ${health.evaluated} 条的成功率低于 ${Math.round(policy.minimumSuccessRatio * 100)}%`);
    if (health.failure403Ratio >= policy.maximum403Ratio)
      reasons.push(`已尝试 ${health.evaluated} 条的 403 比例达到 ${Math.round(policy.maximum403Ratio * 100)}%`);
  }
  return { paused: reasons.length > 0, reasons };
}

export function advanceCreatorSourceResolutionQueue(db, options) {
  if (!SHA.test(options.sourceSha) || options.limit > BATCH_POLICY.maxBatchSize || options.limit < 1)
    throw new Error('必须提供固定来源 SHA 和 1–20 位的小批量');
  const latest = db.prepare('SELECT source_sha256 FROM creator_source_imports ORDER BY id DESC LIMIT 1').get();
  if (latest?.source_sha256?.toLowerCase() !== options.sourceSha.toLowerCase())
    throw new Error('最新来源 SHA 与本次固定来源不同，拒绝自动切换');
  const cursor = resumeAuthorRow(db, options.sourceSha, options.limit);
  const health = readQueueHealth(db, options.sourceSha);
  const gate = evaluateQueueHealth(health, BATCH_POLICY, options.limit);
  if (gate.paused) return { status: 'paused', applied: false, productionDatabaseChanged: false,
    sourceSha256: options.sourceSha, limit: options.limit, cursor, health, reasons: gate.reasons };

  const beforeInsert = (lockedDb, { selected }) => {
    const lockedHealth = readQueueHealth(lockedDb, options.sourceSha);
    const lockedGate = evaluateQueueHealth(lockedHealth, BATCH_POLICY, selected.length);
    if (lockedGate.paused) throw new Error(`队列状态在入队前已变化：${lockedGate.reasons.join('；')}`);
  };
  const result = enqueueCreatorSourceResolutionCandidates(db, {
    ...options, afterAuthorRow: cursor.afterAuthorRow, beforeInsert,
  });
  return { ...result, limit: options.limit, cursor, health,
    nextCursor: result.lastAuthorRow ?? cursor.afterAuthorRow,
    stopAndResume: '每次只执行一批；再次运行同命令将依据完整来源收据链续接。' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseAdvanceArguments(process.argv.slice(2));
    const db = new DatabaseSync(options.dbPath, { readOnly: !options.apply });
    try { console.log(JSON.stringify(advanceCreatorSourceResolutionQueue(db, options), null, 2)); }
    finally { db.close(); }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
