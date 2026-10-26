// Supplemental read-only source-bound proof; no collector or product completion.
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { checksum } from '../lib/utils.mjs';
import { validateWorksOnlyEvidence } from '../lib/works-only-observation.mjs';
import { loadVerifiedWorksOnlyRows } from '../lib/works-observation.mjs';
import { inspectUpdateSla } from '../lib/update-sla.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFile(join(root, path));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const auditBytes = await read('data/maintenance-journal/2026-10-02-phase89-data-audit.json');
assert.equal(sha(auditBytes), '5b2a1300953c66c775e3a94fb2a47f01f8a0f0d8a43e9d64f3a246c5deceb737');
const audit = JSON.parse(auditBytes);
assert.equal(audit.oldOriginalEventPreservation.fileCount, 1669);
const result = { checkedAt: new Date().toISOString(), auditReceiptSha256: sha(auditBytes),
  fixedTerminalCutoff: audit.fixedTerminalCutoff, auditedRunIds: audit.runIds,
  noSampling: true, noSupplierRequests: true, noDatabaseWrites: true, noReviewCompletion: true,
  noServiceControl: true, noOldHistoryBackfill: true, observations: [] };
const db = new DatabaseSync(join(root, 'data/douyin-monitor.sqlite'), { readOnly: true });
try {
  db.exec('PRAGMA query_only=ON; BEGIN');
  const actualRows = loadVerifiedWorksOnlyRows(db, audit.fixedTerminalCutoff, null, { runIds: audit.runIds });
  assert.equal(actualRows.length, 18);
  for (const proof of audit.proofs) {
    const row = db.prepare('SELECT * FROM works_observations WHERE run_id=?').get(proof.runId);
    const raw = JSON.parse(row.raw_json), canonical = validateWorksOnlyEvidence(raw);
    assert.deepEqual([sha(row.raw_json), checksum(raw), checksum(canonical), row.source_checksum], proof.fourSourceHashes);
    assert.deepEqual(raw.pagination, proof.pageLedger);
    assert.equal(checksum(raw.failureDiagnostics), proof.diagnosticSha256);
    assert.equal(sha(await read(`data/ingestion-reviews/run-${proof.runId}.json`)), proof.originalEventSha256);
    const anchor = db.prepare('SELECT raw_json,total_posts,works_coverage,captured_at FROM snapshots WHERE id=?').get(proof.anchorSnapshotId);
    const anchorRaw = JSON.parse(anchor.raw_json);
    assert.equal(checksum(anchorRaw), row.anchor_checksum);
    const previous = db.prepare('SELECT run_id,status,coverage,source_checksum,raw_json FROM works_observations WHERE target_id=? AND run_id<2424 ORDER BY id DESC LIMIT 1').get(proof.targetId);
    let previousProof = null;
    if (previous) {
      const prior = JSON.parse(previous.raw_json), priorCanonical = validateWorksOnlyEvidence(prior);
      const priorHashes = [sha(previous.raw_json), checksum(prior), checksum(priorCanonical), previous.source_checksum];
      assert.equal(new Set(priorHashes).size, 1);
      assert.equal(prior.identity.secUid, raw.identity.secUid);
      assert.equal(prior.identity.uid, raw.identity.uid);
      previousProof = { runId: previous.run_id, status: previous.status, coverage: previous.coverage,
        sourceSha256: previous.source_checksum, fourSourceHashesEqual: true,
        sameAuthorIdentityVerified: true, sourcePostCount: prior.posts.length,
        pages: prior.pagination?.pages.length ?? 0, stopReason: prior.pagination?.stopReason ?? prior.failureDiagnostics?.stopReason ?? null };
    }
    const d = raw.failureDiagnostics;
    if (raw.status === 'unavailable') {
      assert.deepEqual(d.httpStatuses, [403]); assert.equal(d.requests.matched, 1);
      assert.equal(d.responses.matched, 1); assert.equal(d.stopReason, 'http-rejection');
      assert.equal(raw.errorCode, 'blocked'); assert.equal(raw.posts.length, 0);
    }
    if (raw.pagination?.pages.length > 1) {
      assert.equal(d.requests.matched, raw.pagination.pages.length);
      assert.equal(d.responses.matched, raw.pagination.pages.length);
      assert.deepEqual(d.httpStatuses, [200]); assert.deepEqual(d.businessStatusCodes, [0]);
      assert.equal(d.responses.invalidBodies, 0); assert.equal(d.responses.bodyTimeouts, 0);
    }
    const firstPageCount = raw.pagination?.pages[0]?.acceptedCount ?? 0;
    result.observations.push({ runId: proof.runId, targetId: proof.targetId, sourceSha256: row.source_checksum,
      originalEventSha256: proof.originalEventSha256, status: raw.status, coverage: raw.coverage,
      sourcePostCount: raw.posts.length, firstSeenWorks: proof.sourceBoundNewWorkRows,
      secondPageMetrics: proof.sourceVectors.slice(firstPageCount).length,
      secondPageFirstSeenWorks: proof.sourceVectors.slice(firstPageCount).filter(v => v.firstSeenAtThisObservation).length,
      pageLedger: raw.pagination, diagnostics: proof.sourceDiagnostics,
      anchorObservedAt: anchor.captured_at, anchorTotalPosts: anchor.total_posts,
      anchorWorksCoverage: anchor.works_coverage, previousSameAuthorWorksOnly: previousProof });
  }
  const sla = inspectUpdateSla(db, { now: new Date(audit.fixedTerminalCutoff), includeTargets: true });
  const states = Object.fromEntries(['complete','limited','unavailable','unknown','missing'].map(state => [state, sla.works.daily.targets.filter(x => x.state === state).length]));
  assert.equal(new Set(sla.works.daily.targets.map(x => x.targetId)).size, 701);
  result.fixedCutoffCoverage = { checkedAt: sla.checkedAt, businessDate: sla.businessDate,
    profile: sla.coreAccounts.daily, works: states, topics: sla.topics.daily,
    actualProductionReader: true, allU01ToU47Complete: false, allWorksComplete: false, macOffNewCollectionProven: false };
  result.fixedCutoffCounts = {
    snapshots: db.prepare('SELECT count(*) n FROM snapshots WHERE julianday(captured_at)<=julianday(?)').get(audit.fixedTerminalCutoff).n,
    posts: db.prepare('SELECT count(*) n FROM posts WHERE julianday(first_seen_at)<=julianday(?)').get(audit.fixedTerminalCutoff).n,
    post_metrics: db.prepare('SELECT count(*) n FROM post_metrics WHERE julianday(captured_at)<=julianday(?)').get(audit.fixedTerminalCutoff).n,
    works_observations: db.prepare('SELECT count(*) n FROM works_observations WHERE julianday(request_finished_at)<=julianday(?)').get(audit.fixedTerminalCutoff).n,
    terminalMaxRun: db.prepare('SELECT max(id) n FROM runs WHERE julianday(finished_at)<=julianday(?)').get(audit.fixedTerminalCutoff).n,
    method: 'real stored observation-time filter; not a physical backup or full database snapshot' };
  for (const [key, delta] of Object.entries({ snapshots:0, posts:60, post_metrics:259, works_observations:18 })) {
    assert.equal(result.fixedCutoffCounts[key], audit.baseline[key] + delta);
  }
  assert.equal(result.fixedCutoffCounts.terminalMaxRun, 2441);
  assert.equal(db.prepare('PRAGMA query_only').get().query_only, 1);
  assert.equal(db.prepare('SELECT total_changes() n').get().n, 0);
  result.queryOnly = 1; result.totalChanges = 0; db.exec('ROLLBACK');
} finally { db.close(); }
for (const entry of audit.oldOriginalEventPreservation.files) assert.equal(sha(await read('data/ingestion-reviews/' + entry.file)), entry.sha256);
assert.equal(sha(await read('data/source-poll/manifest.json')), audit.source.sha256);
result.old1669OriginalEventsRemainByteIdentical = true;
result.sourceManifestUnchangedSincePhase88 = true;
result.totals = { multiPageRunIds: result.observations.filter(x=>x.pageLedger?.pages.length>1).map(x=>x.runId),
  endOfListRunIds: result.observations.filter(x=>x.pageLedger?.stopReason==='end-of-list').map(x=>x.runId),
  itemLimitRunIds: result.observations.filter(x=>x.pageLedger?.stopReason==='item-limit').map(x=>x.runId),
  noProgressRunIds: result.observations.filter(x=>x.pageLedger?.stopReason==='no-progress').map(x=>x.runId),
  strictlyMatched403RunIds: result.observations.filter(x=>x.status==='unavailable').map(x=>x.runId),
  secondPageMetrics: result.observations.reduce((s,x)=>s+x.secondPageMetrics,0),
  secondPageFirstSeenWorks: result.observations.reduce((s,x)=>s+x.secondPageFirstSeenWorks,0) };
assert.deepEqual(result.totals.multiPageRunIds,[2424,2427,2432,2440,2441]);
result.causalEvidenceBoundary = {
  naturalPostPromotionMultiPageSourceProven: true,
  mechanism: 'actual production provider starts a fresh owned Node collector child for each browser collection; promoted child imports helper from disk',
  productionReferences: ['lib/providers/public-web.mjs:576','scripts/douyin_browser_collector.mjs:936','lib/browser-first-works-request.mjs:9'],
  directPerRunCodeHashAttestation: false, persistedContinuationActionMarker: false,
  claim: 'natural bounded multi-page transport improved; source recovery for all works is not proven',
  nonCausalSignals: 'generic blocked-client fetch counts coexist with successful author-work responses; do not infer author endpoint failure from those counts' };
result.worksCompletenessBoundary = 'current canonical works-only contract always stores accepted observations as limited; end-of-list with a prior profile anchor does not upgrade complete coverage';
result.nextStrictAuditFromRunId = 2442;
result.finishedAt = new Date().toISOString();
result.scriptSha256 = sha(await read('scripts/phase89-data-causal-proof.mjs'));
const serialized = JSON.stringify(result,null,2)+'\n';
assert.doesNotMatch(serialized,/https?:\/\/|Bearer\s|Authorization\s*[:=]|Cookie\s*[:=]|MS4wLj/i);
const output = join(root,'data/maintenance-journal/2026-10-02-phase89-data-causal-proof.json');
await writeFile(output,serialized,{flag:'wx',mode:0o600});
assert.equal((await stat(output)).mode & 511,0o600);
console.log(JSON.stringify({output,sha256:sha(serialized),counts:result.fixedCutoffCounts,coverage:result.fixedCutoffCoverage,totals:result.totals}));
