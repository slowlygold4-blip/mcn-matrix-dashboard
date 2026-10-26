import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { completePostIngestionProductReview } from '../lib/post-ingestion-review.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const auditBytes = await readFile(join(root, 'docs/phase105-evidence/integrity/data-audit.json'));
assert.equal(sha(auditBytes), '85c791044aad16faca096001a22d942ee9a30ca4a798de4052a3266791864850');
const audit = JSON.parse(auditBytes);
const fixedRunIds = Array.from({ length: 40 }, (_, i) => 2636 + i);
assert.deepEqual(audit.fixedRunIds, fixedRunIds);
assert.equal(audit.originalEventsByteUnchanged, true);
assert.equal(audit.changesBefore, 0);
assert.equal(audit.changesAfter, 0);
const evidence = [
  'data/maintenance-journal/2026-10-02-phase105.md',
  'docs/phase105-product-review.md',
  'data/maintenance-journal/2026-10-02-phase105-main-full-tests.log',
  'docs/phase105-evidence/integrity/data-audit.json',
  'docs/phase105-evidence/integrity/data-review.md',
  'docs/phase105-evidence/runtime/browser-result.json',
  'docs/phase105-evidence/production-native200-middle.jpg',
  'data/maintenance-journal/2026-10-02-phase105-final-audit.json'
];
const evidenceChecks = [];
for (const reference of evidence) {
  assert.equal((await stat(join(root, reference))).isFile(), true);
  const bytes = await readFile(join(root, reference));
  assert.ok(bytes.length > 0);
  evidenceChecks.push({ reference, bytes: bytes.length, sha256: sha(bytes) });
}
const tests = await readFile(join(root, evidence[2]), 'utf8');
assert.match(tests, /(?:#|ℹ) pass 4262\b/);
assert.match(tests, /(?:#|ℹ) fail 0\b/);
assert.match(tests, /(?:#|ℹ) skipped 0\b/);
const originalChecks = [];
for (const runId of fixedRunIds) {
  const proof = audit.proofs.find((row) => row.runId === runId);
  assert.ok(proof);
  assert.equal(proof.event.exactObjectEqual, true);
  assert.equal(proof.event.independentlyRebuiltFields, 20);
  assert.equal(proof.event.reviewedAtTimeBoundOnly, true);
  const bytes = await readFile(join(root, `data/ingestion-reviews/run-${runId}.json`));
  assert.equal(sha(bytes), proof.event.sha256);
  originalChecks.push({ runId, sha256: proof.event.sha256 });
}
const completions = [];
for (const runId of fixedRunIds) {
  const result = await completePostIngestionProductReview({ ledgerDir: join(root, 'data/ingestion-reviews'), runId, evidence });
  completions.push({ runId, status: result.status, path: result.path, completedAt: result.completion.completedAt });
}
for (const entry of originalChecks) assert.equal(sha(await readFile(join(root, `data/ingestion-reviews/run-${entry.runId}.json`))), entry.sha256);
const receipt = { phase: 105, finishedAt: new Date().toISOString(), fixedRunIds, count: completions.length,
  evidenceChecks, originalEventsByteUnchanged: true, completions,
  meaning: 'Actual fixed-batch review only; not all problems fixed or real-user retention measured; no run 2676 or later reviewed here.' };
await writeFile(join(root, 'data/maintenance-journal/2026-10-02-phase105-product-completion.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
console.log(JSON.stringify({ count: receipt.count, created: completions.filter((row) => row.status === 'created').length, originalEventsByteUnchanged: true, finishedAt: receipt.finishedAt }));
