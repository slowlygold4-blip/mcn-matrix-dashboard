// Phase87 peer: read-only source proof. No platform network, state, scheduler,
// production writes, source repair or review completion is available here.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checksum } from '../lib/utils.mjs';
import { validateWorksOnlyEvidence } from '../lib/works-only-observation.mjs';
import { loadVerifiedWorksOnlyRows } from '../lib/works-observation.mjs';

export function readPhase87CollectorSources() {
  const db = new DatabaseSync(fileURLToPath(new URL('../data/douyin-monitor.sqlite', import.meta.url)), { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    const rows = db.prepare('SELECT run_id,target_id,raw_json,source_checksum FROM works_observations WHERE run_id BETWEEN 2390 AND 2404 ORDER BY run_id').all();
    assert.equal(rows.length, 15);
    const verified = loadVerifiedWorksOnlyRows(db, new Date().toISOString(), null, { runIds: rows.map(row => row.run_id) });
    const proofs = rows.map(row => {
      const raw = JSON.parse(row.raw_json), d = raw.failureDiagnostics;
      const hashes = [createHash('sha256').update(row.raw_json).digest('hex'), checksum(raw),
        checksum(validateWorksOnlyEvidence(raw)), row.source_checksum];
      assert.equal(new Set(hashes).size, 1);
      assert.ok(verified.some(value => value.run_id === row.run_id && value.target_id === row.target_id));
      return { runId: row.run_id, sourceSha256: hashes[0], fourSourceHashesEqual: true,
        actualReaderAccepted: true, status: raw.status, postCount: raw.posts.length,
        pageCount: raw.pagination?.pages?.length ?? 0, stopReason: raw.pagination?.stopReason ?? d?.stopReason,
        hasMore: raw.pagination?.pages?.at(-1)?.response?.has_more ?? null,
        requestCandidate: d?.requests?.candidate, requestMatched: d?.requests?.matched,
        responseMatched: d?.responses?.matched, firstPageRequest: d?.firstPageRequest ?? null,
        screenReadyState: d?.firstScreen?.readyState, worksAnchorCount: d?.firstScreen?.worksAnchorCount,
        activation: d?.firstPageActivation, elapsedMs: d?.elapsedMs };
    });
    const result = { observedAt: new Date().toISOString(), platformRequestIssuedByPeer: false,
      sourceRuns: proofs, queryOnly: db.prepare('PRAGMA query_only').get().query_only,
      totalChanges: db.prepare('SELECT total_changes() n').get().n };
    assert.equal(result.queryOnly, 1); assert.equal(result.totalChanges, 0);
    assert.doesNotMatch(JSON.stringify(result), /https?:|cookie|authorization|bearer|signature/i);
    db.exec('ROLLBACK'); return result;
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href)
  process.stdout.write(`${JSON.stringify(readPhase87CollectorSources(), null, 2)}\n`);
