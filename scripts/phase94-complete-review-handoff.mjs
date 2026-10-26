// Fixed completed data/product audit only. This never rewrites input events.
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildPostIngestionReview, completePostIngestionProductReview } from '../lib/post-ingestion-review.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const prefix = 'data/maintenance-journal/2026-10-02-phase94-';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const expected = new Map([
  [prefix + 'data-audit.json', '8af48eb541830621c182a3a4f934f8990067f9a965c40be0b192aa20b66cd573'],
  [prefix + 'data-readback.json', 'a09a9efbd3ee554320c992b7f101935052c8f13bf5707686853fb0bc84a09ada'],
  [prefix + 'final-integrity-peer.json', '322437a413bde04e2233277f74be4a6ec61626df9375261d548ddf8ba9423252'],
  ['docs/phase94-data-audit.md', '2765a8a1b5e22c26bd4b3ed9371283a8529d524b9b12c675e6cfd412debabec1'],
]);
for (const [path, checksum] of expected) assert.equal(sha(await readFile(join(root, path))), checksum);
const audit = JSON.parse(await readFile(join(root, prefix + 'data-audit.json')));
const readback = JSON.parse(await readFile(join(root, prefix + 'data-readback.json')));
const verification = JSON.parse(await readFile(join(root, prefix + 'readonly-verification.json')));
const runIds = Array.from({ length: 22 }, (_, index) => 2556 + index);
assert.deepEqual(audit.runIds, runIds);
assert.deepEqual(readback.runIds, runIds);
assert.equal(audit.totalChanges, 0);
assert.equal(readback.totalChanges, 0);
assert.equal(audit.originalEventsByteUnchanged, true);
assert.equal(audit.sourceManifestByteUnchanged, true);
assert.equal(readback.exactMetricVectorCount, 302);
assert.equal(readback.firstSeenCount, 44);
assert.equal(readback.actualSettingsReader.mode, 'legacy');
assert.equal(sha(await readFile(join(root, 'data/source-poll/manifest.json'))), readback.source.sha256);
for (const [kind, count] of [['main', 4032], ['site', 47]]) {
  assert.equal(verification.tests[kind].tests, count);
  assert.equal(verification.tests[kind].pass, count);
  assert.equal(verification.tests[kind].fail + verification.tests[kind].cancelled + verification.tests[kind].skipped, 0);
  assert.equal(sha(await readFile(join(root, verification.tests[kind].logPath))), verification.tests[kind].logSha256);
}
assert.equal(verification.health.runtimeAI, false);
assert.equal(verification.siteUnchangedV39, true);
for (const [path, checksum] of Object.entries(verification.siteSource)) {
  assert.equal(sha(await readFile(join(root, '../mcn-public-site', path))), checksum);
}

const originals = [];
const db = new DatabaseSync(join(root, 'data/douyin-monitor.sqlite'), { readOnly: true });
try {
  db.exec('PRAGMA query_only=ON; BEGIN');
  for (const item of audit.proofs) {
    for (const key of ['fourSourceHashesEqual', 'actualReaderAccepted', 'runIdentityAnchorTimeVerified',
      'sourceBoundCursorChainVerified', 'exactEventRebuild', 'allFiveFieldsVerified']) assert.equal(item[key], true);
    assert.equal(item.originalEventFieldCount, 21);
    const path = join(root, 'data/ingestion-reviews/run-' + item.runId + '.json');
    const bytes = await readFile(path);
    assert.equal(sha(bytes), item.originalEventSha256);
    const event = JSON.parse(bytes);
    assert.deepEqual(buildPostIngestionReview({ database: db, runId: item.runId, now: new Date(event.reviewedAt) }), event);
    originals.push({ item, path });
  }
  assert.equal(db.prepare('SELECT total_changes() n').get().n, 0);
  db.exec('ROLLBACK');
} finally { db.close(); }

const evidence = ['data/maintenance-journal/2026-10-02-phase94.md', ...expected.keys(),
  prefix + 'readonly-verification.json', prefix + 'main-full.log', prefix + 'site-full.log'];
for (const path of evidence) assert.ok((await stat(join(root, path))).size > 0);
const results = [];
for (const { item, path } of originals) {
  const result = await completePostIngestionProductReview({ ledgerDir: join(root, 'data/ingestion-reviews'), runId: item.runId, evidence });
  assert.equal(sha(await readFile(path)), item.originalEventSha256);
  results.push({ runId: item.runId, status: result.status, originalEventSha256: item.originalEventSha256, originalPreserved: true,
    completionSha256: sha(await readFile(result.path)) });
}
const outcome = {
  completedAt: new Date().toISOString(), results, evidence, nextStrictAuditFromRunId: 2578,
  fixedMetricVectors: 302, fixedFirstSeenWorks: 44, fixedNewProfileSnapshots: 0,
  scope: 'Fixed source/identity/time/cursor/metric-vector and current product code/contract review; unchanged V39 UI source and full tests. Remaining runtime defects are documented, not declared fixed.',
  originalEventsUnchanged: true, oldPendingNotClaimedReviewed: true, running2578NotReviewed: true,
  candidateNotPromoted: true, noNewPublicUiAcceptanceClaim: true, noRealUserRetentionTrial: true,
  notAllIssuesFixed: true, noCloudSamplingOrAllWorksClaim: true,
};
await writeFile(join(root, prefix + 'reviewed-events-handoff.json'), JSON.stringify(outcome, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ completedAt: outcome.completedAt, count: results.length,
  created: results.filter(row => row.status === 'created').length, originalsPreserved: true, next: 2578, notAllIssuesFixed: true }));
