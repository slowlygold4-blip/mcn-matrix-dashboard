// Read-only supplemental actual request diagnostics for the already bounded audit.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { checksum } from '../lib/utils.mjs';
import { validateWorksOnlyEvidence } from '../lib/works-only-observation.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const auditBytes = await readFile(join(root, 'data/maintenance-journal/2026-10-02-phase88-data-audit-verified.json'));
assert.equal(sha(auditBytes), '603c4197285cbec8421bf88083220d882b43231c3fcd899d0affd172e93c0382');
const audit = JSON.parse(auditBytes);
const db = new DatabaseSync(join(root, 'data/douyin-monitor.sqlite'), { readOnly: true });
const result = { checkedAt: new Date().toISOString(), fixedTerminalCutoff: audit.fixedTerminalCutoff,
  auditReceiptSha256: sha(auditBytes), observations: [], noManualSampling: true,
  noSupplierRequests: true, noDatabaseWrites: true, noReviewCompletion: true };
try {
  db.exec('PRAGMA query_only=ON; BEGIN');
  for (const proof of audit.proofs) {
    const row = db.prepare('SELECT raw_json,source_checksum FROM works_observations WHERE run_id=?').get(proof.runId);
    const raw = JSON.parse(row.raw_json), canonical = validateWorksOnlyEvidence(raw);
    assert.deepEqual([sha(row.raw_json), checksum(raw), checksum(canonical), row.source_checksum], proof.fourSourceHashes);
    assert.equal(checksum(raw.failureDiagnostics ?? null), proof.diagnosticSha256);
    const d = raw.failureDiagnostics;
    result.observations.push({ runId: proof.runId, targetId: proof.targetId, sourceSha256: row.source_checksum,
      status: raw.status, coverage: raw.coverage, errorCode: raw.errorCode,
      sourcePosts: raw.posts.length, diagnosticSha256: proof.diagnosticSha256,
      httpStatuses: d?.httpStatuses ?? [], businessStatusCodes: d?.businessStatusCodes ?? [],
      stopReason: d?.stopReason ?? null, elapsedMs: d?.elapsedMs ?? null,
      responses: d?.responses ?? null, finalPageKind: d?.finalPageKind ?? null,
      matchedRequestCount: d?.requests?.matched ?? null,
      paginationStopReason: raw.pagination?.stopReason ?? null });
    assert.equal(sha(await readFile(join(root, `data/ingestion-reviews/run-${proof.runId}.json`))), proof.originalEventSha256);
  }
  assert.equal(db.prepare('PRAGMA query_only').get().query_only, 1);
  assert.equal(db.prepare('SELECT total_changes() n').get().n, 0); db.exec('ROLLBACK');
  result.queryOnly = 1; result.totalChanges = 0;
} finally { db.close(); }
assert.deepEqual(result.observations.filter(o => o.status === 'unavailable').map(o => o.runId), [2419, 2420, 2423]);
for (const o of result.observations.filter(o => o.status === 'unavailable')) {
  assert.deepEqual(o.httpStatuses, [403]); assert.equal(o.stopReason, 'http-rejection');
  assert.equal(o.matchedRequestCount, 1); assert.equal(o.responses.matched, 1);
  assert.equal(o.sourcePosts, 0); assert.equal(o.errorCode, 'blocked');
}
result.allRunsBeforeContinuationPromotion = true;
result.noClaimNewContinuationFixedSource = true;
const serialized = JSON.stringify(result, null, 2) + '\n';
assert.doesNotMatch(serialized, /https?:\/\/|Bearer\s|Authorization\s*[:=]|Cookie\s*[:=]/i);
await writeFile(join(root, 'data/maintenance-journal/2026-10-02-phase88-data-diagnostics.json'), serialized, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ runIds: result.observations.map(o => o.runId), matched403RunIds: [2419, 2420, 2423],
  sourceBound: true, queryOnly: 1, totalChanges: 0, receiptSha256: sha(serialized) }));
