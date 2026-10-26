// Add independent review receipts only after physical evidence and strict tests.
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { completePostIngestionProductReview } from '../lib/post-ingestion-review.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const evidence = ['data/maintenance-journal/2026-10-02-phase87.md',
  'data/maintenance-journal/2026-10-02-phase87-main-final.txt',
  'data/maintenance-journal/2026-10-02-phase87-stage-full-final.txt',
  'data/maintenance-journal/2026-10-02-phase87-data-peer-handoff.json',
  'docs/phase87-collector-peer.md', 'docs/phase87-pagination-safety-peer.md',
  'docs/phase87-natural-data-peer.md', 'docs/phase87-cloud-runtime-peer.md',
  'docs/okx-web-presentation-study-20261002.md', 'docs/okx-mcn-component-map-20261002.md'];
for (const path of evidence) assert.ok((await stat(join(root, path))).isFile());
const counts = {};
for (const path of evidence.slice(1, 3)) {
  const text = await readFile(join(root, path), 'utf8');
  const count = Number(/ℹ tests (\d+)\b/.exec(text)?.[1]);
  assert.ok(count >= 3975); assert.equal(count, Number(/ℹ pass (\d+)\b/.exec(text)?.[1]));
  for (const key of ['fail', 'cancelled', 'skipped']) assert.match(text, new RegExp('ℹ ' + key + ' 0\\b'));
  counts[path] = count;
}
assert.equal(sha(await readFile(join(root, 'scripts/douyin_browser_collector.mjs'))), '420d4d18dda12987df0ef0cf2b7241130f2a1c0ef6ba3d411fe4d5a3d878369e');
assert.equal(sha(await readFile(join(root, 'lib/browser-first-works-request.mjs'))), '82151b237b23a056d877cf3c71a65100700b5c749e848ea306e6a5ced59b0aa7');
const proof = JSON.parse(await readFile(join(root, evidence[3])));
assert.deepEqual(proof.proofs.map(p => p.runId), Array.from({ length: 12 }, (_, i) => 2405 + i));
assert.equal(proof.queryOnly, 1); assert.equal(proof.totalChanges, 0);
assert.equal(proof.auditTotals.exactMetricVectors, 234);
assert.equal(proof.auditTotals.sourceBoundNewWorkRows, 20);
assert.equal(proof.public.readbackVerified, true);
assert.equal(proof.public.newerLocalMetricObservationsOutsidePublicGeneration, 234);
const results = [];
for (const item of proof.proofs) {
  assert.equal(item.fourSourceHashesEqual, true); assert.equal(item.actualReaderAccepted, true);
  assert.equal(item.runIdentityAnchorTimeVerified, true); assert.equal(item.exactEventRebuild, true);
  assert.equal(item.originalEventFieldCount, 21);
  const path = join(root, 'data/ingestion-reviews/run-' + item.runId + '.json');
  assert.equal(sha(await readFile(path)), item.originalEventSha256);
  const receipt = await completePostIngestionProductReview({ ledgerDir: join(root, 'data/ingestion-reviews'), runId: item.runId, evidence });
  assert.equal(sha(await readFile(path)), item.originalEventSha256);
  results.push({ runId: item.runId, status: receipt.status, originalEventSha256: item.originalEventSha256, originalPreserved: true });
}
const result = { checkedAt: new Date().toISOString(), results, evidence, counts,
  originalEventsUnchanged: true, olderPendingNotClaimedReviewed: true, noRealUserRetentionTrial: true,
  notAllIssuesFixed: true, auditedRunsPredateProductionPromotion: true };
await writeFile(join(root, 'data/maintenance-journal/2026-10-02-phase87-reviewed-events-handoff.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(result));
