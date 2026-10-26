// Phase85: bounded reads of original, naturally completed runs and saved history.
// This file never schedules collection, opens a supplier/browser, changes DB or reviews.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { checksum, businessDateKey } from '../lib/utils.mjs';
import { validateWorksOnlyEvidence } from '../lib/works-only-observation.mjs';
import { loadVerifiedWorksOnlyRows } from '../lib/works-observation.mjs';
import { buildPostIngestionReview } from '../lib/post-ingestion-review.mjs';
import { normalizePost, normalizeCollection } from '../lib/providers/normalize.mjs';
import { getAccountHistory } from '../lib/account-history.mjs';
import { inspectUpdateSla } from '../lib/update-sla.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const suffix = process.argv[2] ?? 'initial';
assert.ok(['initial', 'final', 'handoff'].includes(suffix), 'bounded evidence suffix required');
const output = join(root, `data/maintenance-journal/2026-10-02-phase85-natural-provenance-peer-${suffix}.json`);
const sha = value => createHash('sha256').update(value).digest('hex');
const read = path => readFile(join(root, path));
const get = async path => {
  const result = await fetch(`http://127.0.0.1:4188${path}`, { signal: AbortSignal.timeout(20000) });
  assert.equal(result.status, 200, 'local read API must return 200');
  return result.json();
};
const baseline = { maxRun: 2388, snapshots: 43958, posts: 16213, post_metrics: 111913, works_observations: 1596 };
const expectedManifestSha = '184f0c655a7fc200a6d2e5979d15e92d73af8ec58883edc4d0f1635193c4d1d5';
const startedAt = new Date().toISOString();
const sourceBefore = await read('data/source-poll/manifest.json');
const source = JSON.parse(sourceBefore);
const sourceJobs = Object.entries(source.sources).map(([key, value]) => ({ key, jobId: value.lastJobId ?? null })).sort((a, b) => a.key.localeCompare(b.key));
assert.equal(sha(sourceBefore), expectedManifestSha, 'source manifest changed since Phase85 baseline');
const [health, status] = await Promise.all([get('/api/health'), get('/api/monitoring-status')]);
assert.equal(health.status, 'ready');
assert.equal(health.runtimeAI, false);

// One relevant account, bounded September range, with a frozen read revision.
const historyPath = '/api/rebuild/accounts/264/history?kind=daily&startDate=2026-09-01&endDate=2026-09-30&pageSize=100&order=asc';
const history = await get(historyPath);
const proofs = [];
let counts, pendingRuns, retainedHistory, dailyCoverage, queryOnly, totalChanges;
const db = new DatabaseSync(join(root, 'data/douyin-monitor.sqlite'), { readOnly: true });
try {
  db.exec('PRAGMA query_only=ON; BEGIN');
  const runs = db.prepare("SELECT * FROM runs WHERE id>? AND finished_at IS NOT NULL AND status<>'running' ORDER BY id LIMIT 20").all(baseline.maxRun);
  assert.ok(runs.length, 'no new terminal natural run yet');
  const verified = loadVerifiedWorksOnlyRows(db, new Date().toISOString(), null, { runIds: runs.map(run => run.id) });
  for (const run of runs) {
    assert.equal(run.trigger_type, 'works-only', 'new trigger needs a separate source audit');
    const row = db.prepare('SELECT * FROM works_observations WHERE run_id=?').get(run.id);
    assert.ok(row, 'original run has no immutable observation');
    const raw = JSON.parse(row.raw_json), canonical = validateWorksOnlyEvidence(raw);
    const hashes = [sha(row.raw_json), checksum(raw), checksum(canonical), row.source_checksum];
    assert.equal(new Set(hashes).size, 1, 'original bytes/parsed/canonical/ledger hashes differ');
    const reader = verified.find(item => item.run_id === run.id);
    assert.ok(reader, 'actual history reader rejected original observation');
    assert.equal(reader.target_id, run.target_id);
    const target = db.prepare('SELECT id,type,provider,locator FROM targets WHERE id=?').get(run.target_id);
    const anchor = db.prepare('SELECT * FROM snapshots WHERE id=?').get(row.anchor_snapshot_id);
    const anchorRaw = JSON.parse(anchor.raw_json);
    assert.equal(checksum(anchorRaw), row.anchor_checksum);
    assert.equal(anchor.source_checksum, row.anchor_checksum);
    assert.equal(raw.runId, run.id); assert.equal(raw.targetId, run.target_id);
    assert.equal(raw.anchorSnapshotId, anchor.id); assert.equal(anchor.target_id, run.target_id);
    assert.equal(raw.identity.secUid, target.locator);
    assert.equal(raw.identity.secUid, anchorRaw.profile.user.sec_uid);
    assert.equal(raw.identity.uid, anchorRaw.profile.user.uid);
    assert.ok(Date.parse(anchor.captured_at) <= Date.parse(raw.requestStartedAt));
    assert.ok(Date.parse(raw.requestStartedAt) - Date.parse(anchor.captured_at) <= 8 * 3600_000);
    assert.ok(Date.parse(run.started_at) <= Date.parse(raw.requestStartedAt));
    assert.ok(Date.parse(raw.requestFinishedAt) <= Date.parse(row.created_at));
    assert.ok(Date.parse(row.created_at) <= Date.parse(run.finished_at));
    assert.ok(Date.parse(raw.requestFinishedAt) - Date.parse(raw.requestStartedAt) <= 45000);

    // Only real source posts can authorize an exact saved work+metric vector.
    let postFieldsVerified = 0, metricVectorsVerified = 0, offset = 0;
    for (const page of raw.pagination?.pages ?? []) {
      for (const post of raw.posts.slice(offset, offset + page.acceptedCount)) {
        const normalized = normalizePost(post);
        const saved = db.prepare('SELECT * FROM posts WHERE target_id=? AND external_id=?').get(run.target_id, post.aweme_id);
        assert.ok(saved); assert.equal(saved.author_id, raw.identity.secUid);
        assert.equal(post.author.uid, raw.identity.uid);
        const metric = db.prepare('SELECT * FROM post_metrics WHERE post_id=? AND captured_at=?').get(saved.id, page.observedAt);
        assert.ok(metric, 'source page observation lacks exact metric timestamp');
        for (const field of ['likes', 'comments', 'shares', 'collects', 'plays']) assert.equal(metric[field], normalized[field] ?? null);
        if (saved.last_seen_at === page.observedAt) {
          if (normalized.caption) assert.equal(saved.caption, normalized.caption);
          if (normalized.publishedAt !== null) assert.equal(saved.published_at, normalized.publishedAt);
          assert.equal(checksum(JSON.parse(saved.raw_json)), checksum(post));
        }
        postFieldsVerified++; metricVectorsVerified++;
      }
      offset += page.acceptedCount;
    }
    assert.equal(postFieldsVerified, raw.posts.length);
    if (raw.status === 'unavailable') {
      assert.equal(raw.posts.length, 0); assert.equal(raw.pagination, null); assert.equal(raw.observedAt, null);
    }
    const eventPath = `data/ingestion-reviews/run-${run.id}.json`;
    const eventBytes = await read(eventPath), event = JSON.parse(eventBytes);
    assert.equal(Object.keys(event).length, 21, 'original works rule event shape changed');
    assert.deepEqual(buildPostIngestionReview({ database: db, runId: run.id, now: new Date(event.reviewedAt) }), event);
    const globalTimeWindowRecords = Object.fromEntries([
      ['snapshots', 'captured_at'], ['posts', 'first_seen_at'], ['post_metrics', 'captured_at'],
    ].map(([table, at]) => [table, db.prepare(`SELECT count(*) n FROM ${table} WHERE julianday(${at})>=julianday(?) AND julianday(${at})<=julianday(?)`).get(run.started_at, run.finished_at).n]));
    const targetTimeWindowRecords = {
      snapshots: db.prepare('SELECT count(*) n FROM snapshots WHERE target_id=? AND julianday(captured_at)>=julianday(?) AND julianday(captured_at)<=julianday(?)').get(run.target_id, run.started_at, run.finished_at).n,
      posts: db.prepare('SELECT count(*) n FROM posts WHERE target_id=? AND julianday(first_seen_at)>=julianday(?) AND julianday(first_seen_at)<=julianday(?)').get(run.target_id, run.started_at, run.finished_at).n,
      post_metrics: db.prepare('SELECT count(*) n FROM post_metrics m JOIN posts p ON p.id=m.post_id WHERE p.target_id=? AND julianday(m.captured_at)>=julianday(?) AND julianday(m.captured_at)<=julianday(?)').get(run.target_id, run.started_at, run.finished_at).n,
    };
    proofs.push({ runId: run.id, targetId: run.target_id, startedAt: run.started_at, finishedAt: run.finished_at,
      runStatus: run.status, status: row.status, coverage: row.coverage, errorCode: row.error_code,
      sourceSha256: hashes[0], fourSourceHashesEqual: true, actualReaderAccepted: true,
      runIdentityAnchorTimeVerified: true, anchorSnapshotId: anchor.id, anchorCapturedAt: anchor.captured_at,
      requestStartedAt: raw.requestStartedAt, requestFinishedAt: raw.requestFinishedAt,
      sourcePostCount: raw.posts.length, postFieldsVerified, metricVectorsVerified,
      globalTimeWindowRecords, targetTimeWindowRecords, timeWindowCountsAreNotRunAttribution: true,
      originalEventSha256: sha(eventBytes), originalEventFieldCount: 21, exactEventRebuild: true,
      originalProductReviewState: event.productReview.status,
      failureStage: raw.failureStage ?? null, diagnostics: raw.failureDiagnostics ?? null });
  }
  counts = Object.fromEntries(['targets', 'snapshots', 'posts', 'post_metrics', 'works_observations'].map(table => [table, db.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
  counts.maxRun = db.prepare('SELECT max(id) n FROM runs').get().n;
  counts.activeRuns = db.prepare('SELECT count(*) n FROM runs WHERE finished_at IS NULL').get().n;
  pendingRuns = db.prepare('SELECT id,trigger_type,target_id,status,started_at FROM runs WHERE id>? AND finished_at IS NULL ORDER BY id LIMIT 20').all(baseline.maxRun);
  for (const key of ['snapshots', 'posts', 'post_metrics', 'works_observations']) assert.ok(counts[key] >= baseline[key], 'historical row count decreased');

  const sla = inspectUpdateSla(db, { now: new Date(status.checkedAt), includeTargets: true });
  for (const [name, values, api] of [
    ['profile', sla.coreAccounts.targets, status.updateSla.coreAccounts.daily],
    ['works', sla.works.daily.targets, status.updateSla.works.daily],
    ['topics', sla.topics.targets, status.updateSla.topics.daily],
  ]) {
    assert.equal(new Set(values.map(value => value.targetId)).size, values.length, 'coverage contains duplicate targets');
    const actual = values.filter(value => name === 'works' ? value.state === 'complete' : value.dailyComplete).length;
    assert.equal(actual, api.complete); assert.equal(values.length, api.total);
  }
  assert.equal(sla.coreAccounts.daily.total, 701); assert.equal(sla.works.daily.total, 701); assert.equal(sla.topics.daily.total, 4);
  dailyCoverage = { businessDate: sla.businessDate, window: sla.windows.daily, distinctTargetIdsVerified: true,
    profile: sla.coreAccounts.daily, works: { ...status.updateSla.works.daily, missingTargetIds: undefined }, topics: sla.topics.daily,
    baselineComplete: { profile: 697, works: 2, topics: 4 },
    deltaFromBaseline: { profile: sla.coreAccounts.daily.complete - 697, works: sla.works.daily.complete - 2, topics: sla.topics.daily.complete - 4 },
    apiMatchesActualReader: true, profilesDoNotProveWorksComplete: true };

  const rebuiltHistory = getAccountHistory(db, 264, { kind: 'daily', startDate: '2026-09-01', endDate: '2026-09-30',
    pageSize: 100, order: 'asc', asOf: history.asOf, ...history.revision });
  assert.deepEqual(rebuiltHistory, history, 'frozen historical API differs from current source-bound reader');
  assert.ok(history.items.length > 0); assert.equal(history.pagination.total, history.items.length);
  assert.equal(history.coverage.missingDatesFilled, false); assert.equal(history.coverage.platformComplete, false);
  const historyTarget = db.prepare('SELECT * FROM targets WHERE id=264').get();
  for (const item of history.items) {
    assert.ok(item.date >= '2026-09-01' && item.date <= '2026-09-30');
    assert.equal(item.date, businessDateKey(item.capturedAt));
    const saved = db.prepare('SELECT * FROM snapshots WHERE id=? AND target_id=264').get(item.id);
    const raw = JSON.parse(saved.raw_json), normalized = normalizeCollection(historyTarget, raw, { capturedAt: saved.captured_at });
    assert.equal(checksum(raw), item.sourceChecksum);
    assert.equal(item.followers, normalized.snapshot.followers);
    assert.equal(item.likes, normalized.snapshot.totalLikes);
    assert.equal(item.posts, normalized.snapshot.totalPosts);
  }
  retainedHistory = { targetId: 264, label: 'Vheerego', apiPath: historyPath, status: 200,
    asOf: history.asOf, revision: history.revision, range: history.range, pagination: history.pagination,
    dates: history.items.map(item => item.date), earliestReturnedAt: history.items[0].capturedAt,
    latestReturnedAt: history.items.at(-1).capturedAt, originalSourceVectorsVerified: history.items.length,
    apiEqualsFrozenReader: true, sourceSnapshotCount: db.prepare('SELECT count(*) n FROM snapshots WHERE target_id=264').get().n,
    savedPostCount: db.prepare('SELECT count(*) n FROM posts WHERE target_id=264').get().n,
    coverage: history.coverage, scope: 'one-local-account-retained-history-not-public-all-suite-proof' };
  queryOnly = db.prepare('PRAGMA query_only').get().query_only;
  totalChanges = db.prepare('SELECT total_changes() n').get().n;
  assert.equal(queryOnly, 1); assert.equal(totalChanges, 0);
  db.exec('ROLLBACK');
} finally { db.close(); }
for (const proof of proofs) assert.equal(sha(await read(`data/ingestion-reviews/run-${proof.runId}.json`)), proof.originalEventSha256);
const sourceAfter = await read('data/source-poll/manifest.json');
assert.equal(sha(sourceAfter), sha(sourceBefore));
const afterJobs = Object.entries(JSON.parse(sourceAfter).sources).map(([key, value]) => ({ key, jobId: value.lastJobId ?? null })).sort((a, b) => a.key.localeCompare(b.key));
assert.deepEqual(afterJobs, sourceJobs);
const result = { startedAt, finishedAt: new Date().toISOString(), scope: 'phase85-original-natural-provenance-read-only',
  baseline, counts, pendingRuns, proofs, dailyCoverage, retainedHistory, queryOnly, totalChanges,
  source: { sha256: sha(sourceAfter), identicalPhase85BaselineManifest: true, sourceCount: sourceJobs.length,
    jobIdProjectionSha256: checksum(sourceJobs), jobIdsUnchangedWithinAudit: true, jobIdsUnchangedFromPhase85BaselineByManifestBytes: true,
    lastFinishedAt: source.lastFinishedAt },
  backup: { priorVerifiedCutoffRun: 2383, currentRunsNotIncludedInPriorBackup: proofs.map(proof => proof.runId),
    freshBackupAuditPerformed: false },
  originalEventsUnchanged: true, noManualCollection: true, noSupplierRequests: true,
  noDBSourceOrReviewMutation: true, noProductReviewCompletion: true, noNewTimerOrServiceControl: true,
  noRecoveryClaimFromOfflineTests: true, notPublicAllSuiteOrPlatformCompletenessProof: true };
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output, checkedAt: result.finishedAt, runIds: proofs.map(proof => proof.runId),
  proofResults: proofs.map(({ runId, runStatus, status, sourcePostCount, exactEventRebuild, fourSourceHashesEqual, globalTimeWindowRecords, targetTimeWindowRecords }) =>
    ({ runId, runStatus, status, sourcePostCount, exactEventRebuild, fourSourceHashesEqual, globalTimeWindowRecords, targetTimeWindowRecords })),
  counts, pendingRuns, coverage: { profile: dailyCoverage.profile.complete, works: dailyCoverage.works.complete, topics: dailyCoverage.topics.complete },
  historicalAccount: retainedHistory.targetId, historicalDates: retainedHistory.dates.length, sourceStable: true, queryOnly, totalChanges }));


