import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { reusableStoredAuthorEvidence } from '../lib/author-evidence-reuse.mjs';

const directory = 'data/tuantuan-hotspot-onikEQ';
const action = process.argv[2];
assert.ok(['plan', 'apply'].includes(action), 'Use plan or apply');
const source = JSON.parse(await readFile(`${directory}/source-audit.json`, 'utf8'));
const validation = JSON.parse(await readFile(`${directory}/preview-validation.json`, 'utf8'));
const submitted = JSON.parse(await readFile(`${directory}/submitted-job.json`, 'utf8'));
assert.ok(validation.accepted && source.revision === validation.revision);
if (action === 'apply') {
  const plan = JSON.parse(await readFile(`${directory}/stored-evidence-plan.json`, 'utf8'));
  assert.equal(plan.sourceSha256, validation.contentSha256);
  assert.ok(plan.reusable.length > 0);
  try { await readFile(`${directory}/stored-evidence-reuse.json`); throw new Error('Reuse already committed'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const before = new DatabaseSync(`${directory}/before.sqlite`, { readOnly: true });
const db = new DatabaseSync('data/douyin-monitor.sqlite', { readOnly: action !== 'apply' });
const parse = value => JSON.parse(value || '{}');
const normalizedId = value => String(value ?? '').normalize('NFKC').replace(/^@/, '').trim().toLowerCase();
const oldQueue = before.prepare('SELECT * FROM author_resolution_queue').all();
const oldIds = new Set(oldQueue.map(row => row.id));
const oldTargets = new Map(before.prepare('SELECT * FROM targets').all().map(row => [row.id, row]));
const oldProofsById = new Map();
for (const row of oldQueue.filter(row => row.status === 'resolved' && row.verification_policy_version >= 2)) {
  const key = normalizedId(row.douyin_id);
  if (!oldProofsById.has(key)) oldProofsById.set(key, []);
  oldProofsById.get(key).push(row);
}
let transaction = false;
try {
  if (action === 'apply') { db.exec('BEGIN IMMEDIATE'); transaction = true; }
  const currentTargets = new Map(db.prepare('SELECT * FROM targets').all().map(row => [row.id, row]));
  const currentQueue = db.prepare('SELECT * FROM author_resolution_queue').all();
  const currentById = new Map(currentQueue.map(row => [row.id, row]));
  const candidates = currentQueue.filter(row => {
    const metadata = parse(row.source_metadata_json);
    return !oldIds.has(row.id) && ['pending', 'retry'].includes(row.status)
      && row.created_at >= submitted.createdAt && metadata.sourceRevision === source.revision
      && metadata.sourceSha256 === validation.contentSha256
      && metadata.sourceUrl === `${source.url}?sheet=d8a44f`;
  });
  const reusable = [];
  const unresolved = [];
  for (const row of candidates) {
    const proofs = (oldProofsById.get(normalizedId(row.douyin_id)) || []).flatMap(prior => {
      const currentProof = currentById.get(prior.id);
      const oldTarget = oldTargets.get(prior.resolved_target_id);
      const target = currentTargets.get(prior.resolved_target_id);
      const proof = reusableStoredAuthorEvidence(row, prior, oldTarget, target);
      // The original receipt must still be valid in the live database too.
      if (!proof || !currentProof || !reusableStoredAuthorEvidence(row, currentProof, oldTarget, target)) return [];
      if (!db.prepare('SELECT 1 FROM target_boards WHERE target_id=? AND board_key=?')
        .get(proof.targetId, '一条小团团切片矩阵')) return [];
      return [{ proof, prior }];
    });
    if (new Set(proofs.map(item => item.proof.targetId)).size !== 1) {
      unresolved.push({ queueId: row.id, reason: proofs.length ? 'Ambiguous receipt targets' : 'No complete matching stored receipt' });
      continue;
    }
    if (row.lease_owner || row.suspended_target_enabled != null) {
      unresolved.push({ queueId: row.id, reason: 'Active lease or suspended target state must not be overridden' });
      continue;
    }
    const { proof, prior } = proofs[0];
    reusable.push({ queueId: row.id, evidenceVersion: row.evidence_version, sourceRows: parse(row.source_rows_json),
      before: row, proof, priorReceipt: prior });
  }
  const checkedAt = new Date().toISOString();
  const output = { checkedAt, action, sourceUrl: `${source.url}?sheet=d8a44f`,
    sourceSha256: validation.contentSha256, sourceRevision: source.revision,
    note: 'Reuses matching persisted strict ownership receipts. This is not a new network observation, never creates public API candidates, and never changes targets, metrics, memberships, or prior receipts.',
    reusable, unresolved, candidateCount: candidates.length };
  if (action === 'apply') {
    const update = db.prepare(`UPDATE author_resolution_queue SET status='resolved', resolved_target_id=?,
      last_error=NULL, updated_at=?, source_metadata_json=?
      WHERE id=? AND evidence_version=? AND status IN ('pending','retry') AND lease_owner IS NULL
        AND suspended_target_enabled IS NULL AND source_metadata_json=?`);
    for (const item of reusable) {
      const metadata = parse(item.before.source_metadata_json);
      const provenance = { ...item.proof, reusedAt: checkedAt, originalReceiptUpdatedAt: item.proof.sourceReceiptUpdatedAt,
        receiptSnapshotSha256: createHash('sha256').update(JSON.stringify(item.priorReceipt)).digest('hex'),
        newPublicCollection: false };
      assert.equal(update.run(item.proof.targetId, checkedAt, JSON.stringify({ ...metadata, evidenceReuse: provenance }),
        item.queueId, item.evidenceVersion, item.before.source_metadata_json).changes, 1, 'Concurrent queue change');
    }
    db.exec('COMMIT'); transaction = false;
  }
  await writeFile(`${directory}/${action === 'apply' ? 'stored-evidence-reuse' : 'stored-evidence-plan'}.json`, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ action, candidateCount: candidates.length, reused: reusable.length,
    unresolved: unresolved.length, targetCount: new Set(reusable.map(item => item.proof.targetId)).size }));
} catch (error) {
  if (transaction) db.exec('ROLLBACK');
  throw error;
} finally { db.close(); before.close(); }
