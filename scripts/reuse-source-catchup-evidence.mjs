// Bounded local receipt reconciliation. Default is read-only; never contacts a
// platform or changes targets, boards, snapshots, metrics or earlier receipts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MonitorDatabase } from '../lib/database.mjs';
import { reusableStoredAuthorEvidence } from '../lib/author-evidence-reuse.mjs';
import { buildAuthorEvidenceRequests } from '../lib/author-resolution.mjs';

export const CATCHUP_SCOPE = Object.freeze({
  createdAfter: '2026-09-27T20:40:21.000Z', board: '一条小团团切片矩阵', maxCandidates: 500,
  jobIds: ['daebf1fe-ba37-42bd-a594-83f11c6b72d6', '631944b1-03dd-430a-8c82-6b221e00ad36',
    '2308acb6-eac6-47ab-abbf-1afaf2ba5872', '50b01ca0-463d-4e62-97d5-a1c2ca6c7db1', '002e4f09-cf8d-409e-8a1a-a231ad7e4cda'],
});
const DEFAULT_BACKUP = 'data/backups/maintenance-20260928-source-catchup/douyin-monitor-auto-20260927T204418387Z-source-catchup-c6d76236.sqlite';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = value => JSON.parse(value || '{}');
const normalizedId = value => String(value ?? '').normalize('NFKC').replace(/^@/, '').trim().toLowerCase();
function identity(target) {
  return target && { id: target.id, type: target.type, provider: target.provider, locator: target.locator, enabled: target.enabled };
}
function validSource(source) {
  if (!Number.isSafeInteger(source?.sourceRevision) || source.sourceRevision <= 0
    || typeof source.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(source.sourceSha256)) return false;
  try {
    const url = new URL(source.sourceUrl);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && /(^|\.)(feishu\.cn|larkoffice\.com|larksuite\.com)$/.test(url.hostname)
      && /^\/sheets\/[A-Za-z0-9]+\/?$/.test(url.pathname);
  } catch { return false; }
}

export function planStoredEvidenceReuse(db, before, scope = CATCHUP_SCOPE) {
  assert.ok(Array.isArray(scope.jobIds) && scope.jobIds.length > 0 && scope.jobIds.length <= 8);
  assert.ok(Number.isFinite(Date.parse(scope.createdAfter)) && scope.board);
  const jobs = scope.jobIds.map(id => {
    const row = db.prepare('SELECT * FROM author_resolution_jobs WHERE id=?').get(id);
    assert.ok(row && row.status === 'completed' && row.created_at >= scope.createdAfter, 'Missing/out-of-scope completed job');
    const request = parse(row.request_json), result = parse(row.result_json);
    assert.ok(validSource(request), 'Completed job lacks valid trusted source evidence');
    const evidenceKeys = new Set(buildAuthorEvidenceRequests((result.skipped || []).filter(item => item.status === 'unresolved')).map(item => item.key));
    return { row, request, result, evidenceKeys };
  });
  const keys = new Set(jobs.flatMap(job => buildAuthorEvidenceRequests((job.result.skipped || []).filter(row => row.status === 'unresolved')).map(row => row.key)));
  assert.ok(keys.size <= Math.min(500, scope.maxCandidates || 500), 'Candidate scope exceeds bound');
  const priorQueues = before.prepare("SELECT * FROM author_resolution_queue WHERE status='resolved' AND verification_policy_version>=2").all();
  const byId = new Map();
  for (const row of priorQueues) {
    const id = normalizedId(row.douyin_id); if (!byId.has(id)) byId.set(id, []); byId.get(id).push(row);
  }
  const reusable = [], excluded = [];
  let candidateCount = 0;
  for (const key of keys) {
    const row = db.prepare('SELECT * FROM author_resolution_queue WHERE identity_key=?').get(key);
    if (!row || row.created_at < scope.createdAfter || before.prepare('SELECT 1 FROM author_resolution_queue WHERE id=?').get(row.id)) continue;
    candidateCount++;
    const metadata = parse(row.source_metadata_json);
    const sourceJob = validSource(metadata) && jobs.find(job => job.evidenceKeys.has(row.identity_key) && metadata.sourceUrl === job.request.sourceUrl
      && /^[a-f0-9]{64}$/i.test(metadata.sourceSha256 || '') && metadata.sourceSha256 === job.request.sourceSha256
      && metadata.sourceRevision === job.request.sourceRevision);
    if (!sourceJob) { excluded.push({ id: row.id, reason: 'source-fingerprint-mismatch' }); continue; }
    const matches = [];
    for (const prior of byId.get(normalizedId(row.douyin_id)) || []) {
      const oldTarget = before.prepare('SELECT * FROM targets WHERE id=?').get(prior.resolved_target_id);
      const target = db.prepare('SELECT * FROM targets WHERE id=?').get(prior.resolved_target_id);
      if (!oldTarget || !target || digest(identity(oldTarget)) !== digest(identity(target))) continue;
      const currentPrior = db.prepare('SELECT * FROM author_resolution_queue WHERE id=?').get(prior.id);
      const proof = reusableStoredAuthorEvidence(row, prior, oldTarget, target);
      const currentProof = currentPrior && reusableStoredAuthorEvidence(row, currentPrior, oldTarget, target);
      if (!proof || !currentProof || proof.sourceEvidenceSha256 !== currentProof.sourceEvidenceSha256) continue;
      if (!db.prepare('SELECT 1 FROM target_boards WHERE target_id=? AND board_key=?').get(target.id, scope.board)) continue;
      matches.push({ prior, target, proof });
    }
    if (new Set(matches.map(item => item.target.id)).size !== 1) {
      excluded.push({ id: row.id, reason: matches.length ? 'ambiguous-target' : 'no-complete-stable-strict-receipt' }); continue;
    }
    const { prior, target, proof } = matches.sort((a, b) => a.prior.id - b.prior.id)[0];
    reusable.push({ id: row.id, evidenceVersion: row.evidence_version, rowSha256: digest(row),
      sourceJobId: sourceJob.row.id, sourceRequestSha256: digest(sourceJob.request), targetIdentity: identity(target),
      priorQueueId: prior.id, priorReceiptSha256: digest(prior), proof });
  }
  reusable.sort((a, b) => a.id - b.id); excluded.sort((a, b) => a.id - b.id);
  const payload = { version: 1, scope, candidateCount, reusable, excluded, newPublicCollection: false };
  return { ...payload, planSha256: digest(payload) };
}

export function applyStoredEvidenceReuse(db, before, approvedPlan) {
  const { planSha256, ...payload } = approvedPlan;
  assert.equal(planSha256, digest(payload), 'Plan checksum mismatch');
  assert.ok(approvedPlan.reusable.length > 0, 'No approved exact queue IDs');
  db.exec('BEGIN IMMEDIATE');
  try {
    const fresh = planStoredEvidenceReuse(db, before, approvedPlan.scope);
    assert.equal(fresh.planSha256, planSha256, 'Plan or proof changed; rerun read-only plan');
    const resolved = [], timestamp = new Date().toISOString();
    for (const item of fresh.reusable) {
      const row = db.prepare('SELECT * FROM author_resolution_queue WHERE id=?').get(item.id);
      assert.equal(digest(row), item.rowSha256, 'Queue CAS mismatch');
      assert.ok(!row.lease_owner && !row.lease_until && row.suspended_target_enabled == null);
      // Existing queue completion API only, not target/board import machinery.
      assert.equal(MonitorDatabase.prototype.markAuthorResolutionResolved.call({ db }, item.id, item.proof.targetId,
        { evidenceVersion: item.evidenceVersion }), true, 'Queue completion CAS failed');
      const metadata = parse(row.source_metadata_json);
      const provenance = { ...item.proof, reusedAt: timestamp, receiptSnapshotSha256: item.priorReceiptSha256,
        approvedPlanSha256: planSha256, sourceJobId: item.sourceJobId, newPublicCollection: false };
      assert.equal(db.prepare(`UPDATE author_resolution_queue SET source_metadata_json=?
        WHERE id=? AND status='resolved' AND resolved_target_id=? AND evidence_version=? AND source_metadata_json=?
          AND lease_owner IS NULL AND lease_until IS NULL AND suspended_target_enabled IS NULL`)
        .run(JSON.stringify({ ...metadata, evidenceReuse: provenance }), item.id, item.proof.targetId,
          item.evidenceVersion, row.source_metadata_json).changes, 1, 'Provenance CAS failed');
      resolved.push(item.id);
    }
    db.exec('COMMIT');
    return { resolvedCount: resolved.length, exactQueueIds: resolved, planSha256, newPublicCollection: false, appliedAt: timestamp };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export async function applyWithExclusiveReceipt(db, before, approvedPlan, receiptPath) {
  // Reserve the receipt before BEGIN IMMEDIATE. An existing/unwritable output
  // must not let a successful database commit look like an unsuccessful run.
  const handle = await open(receiptPath, 'wx', 0o600);
  let committed = false;
  try {
    const result = applyStoredEvidenceReuse(db, before, approvedPlan);
    committed = true;
    await handle.writeFile(`${JSON.stringify(result, null, 2)}\n`);
    await handle.sync();
    return result;
  } catch (error) {
    if (committed) {
      const report = new Error(`数据库已提交；回执写入失败。请保留 ${receiptPath} 并按 planSha256 ${approvedPlan.planSha256} 核对队列 evidenceReuse，勿重复执行。`);
      report.committed = true; report.receiptPath = receiptPath; throw report;
    }
    await handle.writeFile(`${JSON.stringify({ committed: false, planSha256: approvedPlan.planSha256, error: error.message })}\n`).catch(() => {});
    throw error;
  } finally { await handle.close(); }
}

async function main() {
  const args = process.argv.slice(2), apply = args.includes('--apply');
  const arg = name => { const at = args.indexOf(name); return at < 0 ? null : args[at + 1]; };
  if (apply) assert.ok(arg('--plan') && arg('--out'), 'Apply requires an approved --plan and --out receipt path');
  const db = new DatabaseSync('data/douyin-monitor.sqlite', { readOnly: !apply });
  const before = new DatabaseSync(DEFAULT_BACKUP, { readOnly: true });
  try {
    let result;
    if (apply) {
      const approved = parse(await readFile(arg('--plan'), 'utf8'));
      assert.equal(digest(approved.scope), digest(CATCHUP_SCOPE), 'Scope must exactly match this bounded catch-up');
      result = await applyWithExclusiveReceipt(db, before, approved, arg('--out'));
    } else {
      db.exec('BEGIN'); before.exec('BEGIN');
      try { result = planStoredEvidenceReuse(db, before); } finally { db.exec('ROLLBACK'); before.exec('ROLLBACK'); }
    }
    if (!apply && arg('--out')) await writeFile(arg('--out'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(apply ? result : { mode: 'dry-run', candidateCount: result.candidateCount,
      reusableCount: result.reusable.length, excludedCount: result.excluded.length,
      distinctAccountCount: new Set(result.reusable.map(item => item.proof.targetId)).size,
      pausedEvidenceCount: result.reusable.filter(item => !item.targetIdentity.enabled).length,
      planSha256: result.planSha256, newPublicCollection: false }));
  } finally { db.close(); before.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
