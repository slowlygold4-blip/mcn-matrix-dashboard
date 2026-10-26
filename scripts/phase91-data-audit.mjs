// Independent bounded Phase91 source audit. No collector, writer, or review completion.
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
const cutoff = '2026-10-02T00:52:42.846Z';
const runIds = Array.from({ length: 30 }, (_, i) => 2468 + i);
const baseline = { maxRun: 2467, snapshots: 43958, posts: 16372, post_metrics: 113084, works_observations: 1675 };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => readFile(join(root, path));
const at = value => Date.parse(value);
const fields = ['likes', 'comments', 'shares', 'collects', 'plays'];
const vector = object => Object.fromEntries(fields.map(key => [key, object[key] ?? null]));
const get = async path => {
  const response = await fetch('http://127.0.0.1:4188' + path, { signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200); return response.json();
};
const result = { startedAt: new Date().toISOString(), fixedTerminalCutoff: cutoff,
  scope: 'phase91-read-only-natural-data-audit', baseline, runIds, proofs: [],
  noManualSampling: true, noSupplierRequests: true, noForcedExportOrSync: true,
  noProductReviewCompletion: true, noTimerOrServiceControl: true,
  noDatabaseWrites: true, noPlatformCompletenessClaim: true };

// The product GET can perform its already-existing bounded receipt reconcile.
// Persist its literal result; do not claim the endpoint is filesystem-inert.
const oldEventFiles = (await readdir(join(root, 'data/ingestion-reviews'))).filter(file => /^run-\d+\.json$/.test(file) && Number(file.match(/\d+/)[0]) < 2468).sort();
const oldEventHashes = await Promise.all(oldEventFiles.map(async file => ({ file, sha256: sha(await read('data/ingestion-reviews/' + file)) })));
const queue = await get('/api/ingestion-reviews');
result.queue = { checkedAt: new Date().toISOString(), status: queue.status,
  totalPending: queue.totalPending, totalCompleted: queue.totalCompleted,
  productEndpointReconcile: { checkedAt: queue.queue?.checkedAt ?? null,
    fromRunId: queue.queue?.fromRunId ?? null, createdRunIds: queue.queue?.createdRunIds ?? [],
    pendingRunIds: queue.queue?.pendingRunIds ?? [], failedRunIds: queue.queue?.failedRunIds ?? [] } };
const inheritedBytes = await read('data/maintenance-journal/2026-10-02-phase90-data-audit.json');
const inherited = JSON.parse(inheritedBytes);
assert.equal(sha(inheritedBytes), 'a5a430851f224c5a6c588a4afee236f4a9e3e7906c8528a641dd0670095306f1');
assert.equal(inherited.auditTotals.exactMetricVectors, 408);
const fixedPrior = inherited;
assert.equal(fixedPrior.fixedCutoffCounts.terminalMaxRun, baseline.maxRun);
for (const key of Object.keys(baseline).filter(key => key !== 'maxRun')) assert.equal(fixedPrior.fixedCutoffCounts[key], baseline[key]);
result.inheritedProofSha256 = sha(inheritedBytes);
result.inheritedEvents = [];
for (const proof of [...inherited.inheritedEvents, ...inherited.proofs]) {
  const originalEventSha256 = sha(await read(`data/ingestion-reviews/run-${proof.runId}.json`));
  assert.equal(originalEventSha256, proof.originalEventSha256);
  result.inheritedEvents.push({ runId: proof.runId, originalEventSha256, unchanged: true });
}

const sourceBytes = await read('data/source-poll/manifest.json');
const source = JSON.parse(sourceBytes);
const jobs = Object.entries(source.sources).map(([key, value]) => ({ key, jobId: value.lastJobId ?? null })).sort((a, b) => a.key.localeCompare(b.key));
assert.equal(sha(sourceBytes), inherited.source.sha256);
assert.equal(checksum(jobs), inherited.source.jobIdProjectionSha256);
result.source = { sha256: sha(sourceBytes), sourceCount: jobs.length,
  lastFinishedAt: source.lastFinishedAt, jobIdProjectionSha256: checksum(jobs),
  unchangedSincePhase90: true, noNewSourceEventToAudit: true,
  statusCounts: Object.fromEntries([...new Set(Object.values(source.sources).map(item => item.lastStatus))]
    .map(status => [status, Object.values(source.sources).filter(item => item.lastStatus === status).length])) };
assert.deepEqual(result.source.statusCounts, { unchanged: 25, submitted: 2, blocked: 1 });


const promotionJournal = await read('data/maintenance-journal/2026-10-02-phase89.md');
assert.ok(promotionJournal.toString().includes('00:14:35仅lib/browser-works-pagination.mjs精确晋升'));
const promotion = { completedAt: '2026-10-02T00:14:35.000Z', precision: 'one second from Phase89 journal',
  afterHashes: { 'lib/browser-works-pagination.mjs': 'af989dbd9c102b57d9afa85c30fa0c1e87c9ca6c89fee289db4ecc04c3cc4158',
    'scripts/douyin_browser_collector.mjs': '420d4d18dda12987df0ef0cf2b7241130f2a1c0ef6ba3d411fe4d5a3d878369e',
    'lib/browser-first-works-request.mjs': '82151b237b23a056d877cf3c71a65100700b5c749e848ea306e6a5ced59b0aa7' } };
for (const [file, hash] of Object.entries(promotion.afterHashes)) assert.equal(sha(await read(file)), hash);
result.production = { promotionCompletedAt: promotion.completedAt, timePrecision: promotion.precision,
  promotionJournalSha256: sha(promotionJournal), hashes: promotion.afterHashes, exactRecordedBytesAtAudit: true,
  codeHashesDescribeAuditTimeNotPerRunLoadedCode: true };
const [health, status, history] = await Promise.all([get('/api/health'), get('/api/monitoring-status'),
  get('/api/rebuild/accounts/264/history?kind=daily&startDate=2026-09-01&endDate=2026-09-30&pageSize=100&order=asc')]);
assert.equal(health.status, 'ready'); assert.equal(health.runtimeAI, false);
assert.deepEqual(status.scheduler.slotTimes, ['02:00', '10:00', '18:00']);
assert.equal(status.scheduler.scheduleIntervalHours, 8);
const ps = execFileSync('/bin/ps', ['-ax', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n');
const services = ['server.mjs', 'scripts/source-poller.mjs --loop', 'scripts/public-replica-publisher.mjs'].map(file => {
  const matches = ps.filter(line => line.trim().endsWith(join(root, file))); assert.equal(matches.length, 1);
  const [, pid, ppid] = /^\s*(\d+)\s+(\d+)\s+/.exec(matches[0]); assert.equal(Number(ppid), 1);
  return { file, pid: Number(pid), ppid: Number(ppid), actualProcessPresent: true };
});
assert.deepEqual(services.map(x => x.pid), [81452, 26001, 92296]);
const listen = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(services[0].pid), '-iTCP:4188', '-sTCP:LISTEN', '-F', 'pn'], { encoding: 'utf8' });
assert.match(listen, new RegExp(`^p${services[0].pid}$`, 'm')); assert.match(listen, /n.*:4188/);
result.runtime = { status: health.status, runtimeAI: health.runtimeAI, services,
  actual4188ListenHandle: true, slotTimes: status.scheduler.slotTimes,
  scheduleIntervalHours: status.scheduler.scheduleIntervalHours, worksRetry: status.scheduler.worksOnlyRetry };

const backupReceipt = JSON.parse(await read('data/maintenance-journal/2026-10-02-phase89-backup.json'));
const db = new DatabaseSync(join(root, 'data/douyin-monitor.sqlite'), { readOnly: true });
const copy = new DatabaseSync(backupReceipt.restoredPath, { readOnly: true });
try {
  db.exec('PRAGMA query_only=ON; BEGIN'); copy.exec('PRAGMA query_only=ON; BEGIN');
  const runs = db.prepare("SELECT * FROM runs WHERE id>=2468 AND julianday(finished_at)<=julianday(?) AND status<>'running' ORDER BY id LIMIT 40").all(cutoff);
  assert.deepEqual(runs.map(run => run.id), runIds);
  const verified = loadVerifiedWorksOnlyRows(db, cutoff, null, { runIds });
  for (const run of runs) {
    assert.equal(run.trigger_type, 'works-only');
    const row = db.prepare('SELECT * FROM works_observations WHERE run_id=?').get(run.id); assert.ok(row);
    const raw = JSON.parse(row.raw_json), canonical = validateWorksOnlyEvidence(raw);
    const hashes = [sha(row.raw_json), checksum(raw), checksum(canonical), row.source_checksum];
    assert.equal(new Set(hashes).size, 1);
    assert.ok(verified.some(item => item.run_id === run.id && item.target_id === run.target_id));
    const target = db.prepare('SELECT id,locator FROM targets WHERE id=?').get(run.target_id);
    const anchor = db.prepare('SELECT * FROM snapshots WHERE id=?').get(row.anchor_snapshot_id); assert.ok(anchor);
    const anchorRaw = JSON.parse(anchor.raw_json);
    assert.equal(checksum(anchorRaw), row.anchor_checksum); assert.equal(anchor.source_checksum, row.anchor_checksum);
    assert.equal(raw.runId, run.id); assert.equal(raw.targetId, run.target_id);
    assert.equal(raw.anchorSnapshotId, anchor.id); assert.equal(anchor.target_id, run.target_id);
    assert.equal(raw.identity.secUid, target.locator); assert.equal(raw.identity.secUid, anchorRaw.profile.user.sec_uid);
    assert.equal(raw.identity.uid, anchorRaw.profile.user.uid);
    assert.ok(at(anchor.captured_at) <= at(raw.requestStartedAt));
    assert.ok(at(raw.requestStartedAt) - at(anchor.captured_at) <= 8 * 3600000);
    assert.ok(at(run.started_at) <= at(raw.requestStartedAt));
    assert.ok(at(raw.requestFinishedAt) <= at(row.created_at)); assert.ok(at(row.created_at) <= at(run.finished_at));
    assert.ok(at(raw.requestFinishedAt) - at(raw.requestStartedAt) <= 45000);
    let offset = 0; const sourceVectors = [];
    let priorPage = null;
    for (const page of raw.pagination?.pages ?? []) {
      assert.ok(at(page.observedAt) >= at(raw.requestStartedAt));
      assert.ok(at(page.observedAt) <= at(raw.requestFinishedAt));
      if (priorPage) {
        assert.equal(page.requestCursor, priorPage.response.max_cursor);
        assert.equal(priorPage.response.has_more, true);
        assert.ok(Number.isSafeInteger(page.requestCursor) && page.requestCursor > 0);
        assert.ok(at(page.observedAt) >= at(priorPage.observedAt));
      } else assert.equal(page.requestCursor, 0);
      priorPage = page;
      for (const post of raw.posts.slice(offset, offset + page.acceptedCount)) {
        const normalized = normalizePost(post);
        const saved = db.prepare('SELECT * FROM posts WHERE target_id=? AND external_id=?').get(run.target_id, post.aweme_id); assert.ok(saved);
        assert.equal(saved.author_id, raw.identity.secUid); assert.equal(post.author.sec_uid, raw.identity.secUid); assert.equal(post.author.uid, raw.identity.uid);
        assert.equal(saved.external_id, normalized.externalId);
        const metric = db.prepare('SELECT * FROM post_metrics WHERE post_id=? AND captured_at=?').get(saved.id, page.observedAt); assert.ok(metric);
        assert.deepEqual(vector(metric), vector(normalized));
        const currentFieldsMatchObservation = saved.last_seen_at === page.observedAt;
        if (currentFieldsMatchObservation) {
          if (normalized.caption) assert.equal(saved.caption, normalized.caption);
          if (normalized.publishedAt !== null) assert.equal(saved.published_at, normalized.publishedAt);
          assert.equal(checksum(JSON.parse(saved.raw_json)), checksum(post));
        }
        sourceVectors.push({ postId: saved.id, metricId: metric.id, externalIdSha256: sha(post.aweme_id),
          authorIdentitySha256: checksum(raw.identity), observedAt: page.observedAt, firstSeenAt: saved.first_seen_at,
          rawPostSha256: checksum(post), metricVectorSha256: checksum(vector(metric)), exactMetricVector: true,
          currentFieldsMatchObservation, firstSeenAtThisObservation: saved.first_seen_at === page.observedAt });
      }
      offset += page.acceptedCount;
    }
    assert.equal(sourceVectors.length, raw.posts.length);
    if (raw.status === 'unavailable') { assert.equal(raw.posts.length, 0); assert.equal(raw.pagination, null); assert.equal(raw.observedAt, null); }
    const eventBytes = await read(`data/ingestion-reviews/run-${run.id}.json`), event = JSON.parse(eventBytes);
    assert.equal(Object.keys(event).length, 21);
    assert.deepEqual(buildPostIngestionReview({ database: db, runId: run.id, now: new Date(event.reviewedAt) }), event);
    const diagnostic = raw.failureDiagnostics ?? null;
    result.proofs.push({ runId: run.id, targetId: run.target_id, triggerType: run.trigger_type,
      startedAt: run.started_at, finishedAt: run.finished_at, runStatus: run.status, status: row.status,
      coverage: row.coverage, errorCode: row.error_code, sourceSha256: row.source_checksum,
      fourSourceHashes: hashes, fourSourceHashesEqual: true, actualReaderAccepted: true,
      runIdentityAnchorTimeVerified: true, anchorSnapshotId: anchor.id, anchorCapturedAt: anchor.captured_at,
      requestStartedAt: raw.requestStartedAt, requestFinishedAt: raw.requestFinishedAt,
      sourceVectors, sourcePostCount: raw.posts.length,
      pageLedger: raw.pagination, pageLedgerSha256: checksum(raw.pagination), sourceBoundCursorChainVerified: true, sourceBoundNewWorkRows: sourceVectors.filter(x => x.firstSeenAtThisObservation).length,
      originalEventSha256: sha(eventBytes), originalEventFieldCount: 21, exactEventRebuild: true,
      originalProductReviewState: event.productReview.status, failureStage: raw.failureStage ?? null,
      diagnosticSha256: checksum(diagnostic),
      sourceDiagnostics: { httpStatuses: diagnostic?.httpStatuses ?? [], businessStatusCodes: diagnostic?.businessStatusCodes ?? [],
        stopReason: diagnostic?.stopReason ?? null, elapsedMs: diagnostic?.elapsedMs ?? null,
        requests: diagnostic?.requests ?? null, responses: diagnostic?.responses ?? null,
        firstPageRequest: diagnostic?.firstPageRequest ?? null,
        genericFetchFailures: diagnostic?.resourceObservation?.failuresByPhase?.beforeStop?.resources?.fetch ?? null,
        strictlyBoundAuthorPostFailures: diagnostic?.cdpObservation?.failuresByPhase?.beforeStop?.authorPosts ?? null },
      paginationStopReason: raw.pagination?.stopReason ?? null,
      pages: raw.pagination?.pages?.map(page => ({ requestCursor: page.requestCursor,
        responseCursor: page.response.max_cursor, rawCount: page.rawCount, truncated: page.truncated,
        observedAt: page.observedAt, acceptedCount: page.acceptedCount, hasMore: page.response.has_more })) ?? [],
      observedRequestState: { firstPageRequestState: diagnostic?.firstPageRequest?.state ?? null,
        requestCandidateCount: diagnostic?.requests?.candidate ?? null, requestMatchedCount: diagnostic?.requests?.matched ?? null,
        rejectedFirstCursorCount: diagnostic?.requests?.rejected?.firstCursor ?? null,
        activationStructureReason: diagnostic?.firstPageActivation?.structure?.reason ?? null },
      startedAfterPhase89Promotion: at(run.started_at) > at(promotion.completedAt) });
  }
  result.counts = Object.fromEntries(['targets', 'snapshots', 'posts', 'post_metrics', 'works_observations'].map(t => [t, db.prepare(`SELECT count(*) n FROM ${t}`).get().n]));
  result.counts.maxRun = db.prepare('SELECT max(id) n FROM runs').get().n;
  result.deltaFromBaseline = Object.fromEntries(['snapshots', 'posts', 'post_metrics', 'works_observations'].map(key => [key, result.counts[key] - baseline[key]]));
  result.liveCountsDescribeReadTransactionNotArtificialBackfilledCutoff = true;
  result.pendingRuns = db.prepare('SELECT id,trigger_type,target_id,status,started_at FROM runs WHERE id>=2468 AND finished_at IS NULL ORDER BY id LIMIT 40').all();
  result.postPromotion = {
    terminalRunIds: db.prepare("SELECT id FROM runs WHERE julianday(started_at)>=julianday(?) AND finished_at IS NOT NULL ORDER BY id LIMIT 40").all(promotion.completedAt).map(row => row.id),
    pendingRunIds: db.prepare('SELECT id FROM runs WHERE julianday(started_at)>=julianday(?) AND finished_at IS NULL ORDER BY id LIMIT 40').all(promotion.completedAt).map(row => row.id),
    ordinaryNewSourceProof: result.proofs.some(proof => proof.pages.length > 1 && proof.startedAfterPhase89Promotion),
    auditedMultiPageRunIds: result.proofs.filter(proof => proof.pages.length > 1).map(proof => proof.runId),
    causalityLimit: 'all audited runs are after Phase89 promotion but before any Phase91 candidate promotion; multi-page success is distinct from actual empty-advancing-page fix activation; no per-run code hash exists',
    fixtureIsNotPlatformProof: true };
  const sla = inspectUpdateSla(db, { now: new Date(status.updateSla.checkedAt ?? status.checkedAt), includeTargets: true });
  for (const [values, api, kind] of [[sla.coreAccounts.targets, status.updateSla.coreAccounts.daily, 'profile'],
    [sla.works.daily.targets, status.updateSla.works.daily, 'works'], [sla.topics.targets, status.updateSla.topics.daily, 'topics']]) {
    assert.equal(new Set(values.map(x => x.targetId)).size, values.length); assert.equal(values.length, api.total);
    assert.equal(values.filter(x => kind === 'works' ? x.state === 'complete' : x.dailyComplete).length, api.complete);
  }
  const states = Object.fromEntries(['complete', 'limited', 'unavailable', 'unknown', 'missing'].map(state => [state, sla.works.daily.targets.filter(x => x.state === state).length]));
  assert.deepEqual(states, status.updateSla.works.daily.counts);
  result.coverage = { checkedAt: sla.checkedAt, businessDate: sla.businessDate,
    profile: sla.coreAccounts.daily, works: states, topics: sla.topics.daily, distinctRealReaderEqualsAPI: true };
  assert.deepEqual(getAccountHistory(db, 264, { kind: 'daily', startDate: '2026-09-01', endDate: '2026-09-30', pageSize: 100,
    order: 'asc', asOf: history.asOf, ...history.revision }), history);
  assert.equal(history.items.length, 28); assert.equal(history.pagination.total, 28);
  assert.equal(history.coverage.missingDatesFilled, false); assert.equal(history.coverage.platformComplete, false);
  assert.ok(!history.items.some(x => ['2026-09-18', '2026-09-19'].includes(x.date)));
  const target = db.prepare('SELECT * FROM targets WHERE id=264').get(); const historyVectors = [];
  for (const item of history.items) {
    const saved = db.prepare('SELECT * FROM snapshots WHERE id=? AND target_id=264').get(item.id);
    const original = copy.prepare('SELECT raw_json,source_checksum FROM snapshots WHERE id=? AND target_id=264').get(item.id);
    assert.equal(saved.raw_json, original.raw_json); assert.equal(saved.source_checksum, original.source_checksum);
    const raw = JSON.parse(saved.raw_json), normalized = normalizeCollection(target, raw, { capturedAt: saved.captured_at });
    assert.equal(checksum(raw), item.sourceChecksum); assert.equal(item.date, businessDateKey(item.capturedAt));
    assert.equal(item.followers, normalized.snapshot.followers); assert.equal(item.likes, normalized.snapshot.totalLikes); assert.equal(item.posts, normalized.snapshot.totalPosts);
    historyVectors.push({ date: item.date, sourceSha256: item.sourceChecksum, rawBytesSha256: sha(saved.raw_json) });
  }
  result.history = { targetId: 264, dates: historyVectors, equalFrozenAPI: true, originalSourceVectorsVerified: true,
    equalExistingPrivateBackupBytes: true, missingDatesPreserved: ['2026-09-18', '2026-09-19'] };
  assert.equal(copy.prepare('SELECT max(id) n FROM runs').get().n, 2449);
  assert.equal(copy.prepare('SELECT max(id) n FROM runs WHERE finished_at IS NOT NULL').get().n, 2448);
  const backupIncludedRunIds = runIds.filter(id => id <= 2448);
  for (const runId of backupIncludedRunIds) {
    const original = copy.prepare('SELECT raw_json,source_checksum FROM works_observations WHERE run_id=?').get(runId);
    const current = db.prepare('SELECT raw_json,source_checksum FROM works_observations WHERE run_id=?').get(runId);
    assert.deepEqual(current, original);
  }
  const backupStat = await stat(backupReceipt.restoredPath);
  assert.equal(backupStat.size, 824643584); assert.equal(backupStat.mode & 511, 0o400);
  result.backup = { reusedExistingPrivateCopy: true, cutoffRun: 2449, terminalCutoffRun: 2448, containsAllAuditedRuns: false, includedAuditedRunIds: backupIncludedRunIds,
    excludedAuditedRunIds: runIds.filter(id => id > 2448), includedObservationBytesEqual: true, bytes: backupStat.size, mode: '400', noNewBackupOrCopy: true, sourceHistoryReadbackVerified: true };
  const fixedSla = inspectUpdateSla(db, { now: new Date(cutoff), includeTargets: true });
  result.fixedCutoffCoverage = { checkedAt: fixedSla.checkedAt, profile: fixedSla.coreAccounts.daily,
    works: Object.fromEntries(['complete','limited','unavailable','unknown','missing'].map(state => [state, fixedSla.works.daily.targets.filter(x=>x.state===state).length])),
    topics: fixedSla.topics.daily, actualProductionReader: true };
  assert.equal(new Set(fixedSla.works.daily.targets.map(x=>x.targetId)).size,701);
  result.fixedCutoffCounts = {
    snapshots: db.prepare('SELECT count(*) n FROM snapshots WHERE julianday(captured_at)<=julianday(?)').get(cutoff).n,
    posts: db.prepare('SELECT count(*) n FROM posts WHERE julianday(first_seen_at)<=julianday(?)').get(cutoff).n,
    post_metrics: db.prepare('SELECT count(*) n FROM post_metrics WHERE julianday(captured_at)<=julianday(?)').get(cutoff).n,
    works_observations: db.prepare('SELECT count(*) n FROM works_observations WHERE julianday(request_finished_at)<=julianday(?)').get(cutoff).n,
    terminalMaxRun: db.prepare('SELECT max(id) n FROM runs WHERE julianday(finished_at)<=julianday(?)').get(cutoff).n,
    method: 'real stored observation-time filter; not a physical database backup' };
  assert.equal(result.fixedCutoffCounts.terminalMaxRun,2497);
  for (const connection of [db, copy]) {
    assert.equal(connection.prepare('PRAGMA query_only').get().query_only, 1);
    assert.equal(connection.prepare('SELECT total_changes() n').get().n, 0); connection.exec('ROLLBACK');
  }
  result.queryOnlyConnections = 2; result.totalChanges = 0;
} finally { db.close(); copy.close(); }

for (const proof of result.proofs) assert.equal(sha(await read(`data/ingestion-reviews/run-${proof.runId}.json`)), proof.originalEventSha256);
assert.equal(sha(await read('data/source-poll/manifest.json')), sha(sourceBytes));
result.auditTotals = { terminalRunCount: result.proofs.length, acceptedRunCount: result.proofs.filter(p => p.status === 'accepted').length,
  unavailableRunCount: result.proofs.filter(p => p.status === 'unavailable').length,
  exactMetricVectors: result.proofs.reduce((sum, p) => sum + p.sourceVectors.length, 0),
  sourceBoundNewWorkRows: result.proofs.reduce((sum, p) => sum + p.sourceBoundNewWorkRows, 0), newProfileSnapshotsFromTheseWorksOnlyRuns: 0 };

const allVectors = result.proofs.flatMap(p => p.sourceVectors);
result.auditTotals.distinctObservedWorks = new Set(allVectors.map(p => p.postId)).size;
result.auditTotals.distinctFirstSeenWorks = new Set(allVectors.filter(p => p.firstSeenAtThisObservation).map(p => p.postId)).size;
assert.equal(result.auditTotals.sourceBoundNewWorkRows, result.auditTotals.distinctFirstSeenWorks);
result.auditTotals.laterPageMetricObservations = result.proofs.reduce((sum,p) => sum + p.pages.slice(1).reduce((a,b) => a + b.acceptedCount,0),0);
result.auditTotals.secondPageMetricObservations = result.proofs.reduce((sum,p) => sum + (p.pages[1]?.acceptedCount ?? 0),0);
result.auditTotals.thirdPageMetricObservations = result.proofs.reduce((sum,p) => sum + (p.pages[2]?.acceptedCount ?? 0),0);
result.nextStrictAuditFromRunId = 2498;
for (const entry of oldEventHashes) assert.equal(sha(await read('data/ingestion-reviews/' + entry.file)), entry.sha256);
result.oldOriginalEventPreservation = { fileCount: oldEventHashes.length, manifestSha256: checksum(oldEventHashes), unchangedBeforeAfter: true, files: oldEventHashes };
result.currentCountsMayIncludePostCutoffRuns = result.counts.maxRun > runIds.at(-1);
assert.equal(oldEventHashes.length,1713);
result.fixedDelta = Object.fromEntries(['snapshots','posts','post_metrics','works_observations'].map(key=>[key,result.fixedCutoffCounts[key]-baseline[key]]));
assert.equal(result.fixedDelta.snapshots,0);
assert.equal(result.fixedDelta.posts,result.auditTotals.distinctFirstSeenWorks);
assert.equal(result.fixedDelta.post_metrics,result.auditTotals.exactMetricVectors);
assert.equal(result.fixedDelta.works_observations,runIds.length);
const postPromotionProofs = result.proofs.filter(p=>p.startedAfterPhase89Promotion);
const emptyAdvancing = proof => proof.pageLedger?.pages.some(p=>p.rawCount===0 && p.response.has_more===true
  && Number.isSafeInteger(p.response.max_cursor) && p.response.max_cursor>0 && p.response.max_cursor!==p.requestCursor);
result.phase89FixEvaluation = {
  beforePromotionRunIds: result.proofs.filter(p=>!p.startedAfterPhase89Promotion).map(p=>p.runId),
  afterPromotionRunIds: postPromotionProofs.map(p=>p.runId),
  postPromotionEmptyAdvancingRunIds: postPromotionProofs.filter(emptyAdvancing).map(p=>p.runId),
  postPromotionThirdPageRunIds: postPromotionProofs.filter(p=>p.pages.length>=3).map(p=>p.runId),
  allThirdPageRunIds: result.proofs.filter(p=>p.pages.length>=3).map(p=>p.runId),
  actualFixActivationProven: postPromotionProofs.some(emptyAdvancing),
  noPerRunCodeHashAttestation: true, noClaimFixtureIsPlatformRecovery: true };
result.bottlenecks = {
  truncatedTerminalPageRuns: result.proofs.filter(p=>p.pages.at(-1)?.hasMore===false && p.pages.some(page=>page.truncated)).map(p=>({
    runId:p.runId,afterPromotion:p.startedAfterPhase89Promotion,sourceSha256:p.sourceSha256,
    requestedLimit:30,accepted:p.sourcePostCount,rawRows:p.pageLedger.pages.reduce((sum,page)=>sum+page.rawCount,0),
    rawRowsNotAccepted:p.pageLedger.pages.reduce((sum,page)=>sum+page.rawCount-page.acceptedCount,0),
    filteredCount:p.pageLedger.pages.reduce((sum,page)=>sum+page.filteredCount,0),
    duplicateCount:p.pageLedger.pages.reduce((sum,page)=>sum+page.duplicateCount,0),
    pages:p.pages,stopReason:p.paginationStopReason })),
  itemLimitRunIds:result.proofs.filter(p=>p.paginationStopReason==='item-limit').map(p=>p.runId),
  pageLimitRunIds:result.proofs.filter(p=>p.paginationStopReason==='page-limit').map(p=>p.runId),
  pageTimeoutRunIds:result.proofs.filter(p=>p.paginationStopReason==='page-timeout').map(p=>p.runId),
  totalUnacceptedRawRowsOnTruncatedPages:result.proofs.reduce((sum,p)=>sum+(p.pageLedger?.pages??[]).filter(page=>page.truncated).reduce((a,page)=>a+page.rawCount-page.acceptedCount,0),0),
  noClaimDiscardedRowsAreNewUniqueWorks: true, noRecoveryOfDiscardedBodies: true };
for(const proof of result.proofs.filter(p=>p.status==='unavailable')){
  assert.deepEqual(proof.sourceDiagnostics.httpStatuses,[403]);
  assert.equal(proof.sourceDiagnostics.requests.matched,1);assert.equal(proof.sourceDiagnostics.responses.matched,1);
  assert.equal(proof.sourceDiagnostics.stopReason,'http-rejection');assert.equal(proof.errorCode,'blocked');
}
result.strict403RunIds=result.proofs.filter(p=>p.status==='unavailable').map(p=>p.runId);
result.noAllU01ToU47CompletionClaim=true;result.macOffNewCollectionProven=false;result.allWorksComplete=false;
result.auditConstructionErrors = ['Phase90 closeout JSON guessed name absent; used current task_plan/progress/findings and immutable Phase90 data audit instead; no source mutation'];
result.originalEventsByteUnchanged = true; result.sourceManifestByteUnchanged = true;
result.finishedAt = new Date().toISOString(); result.auditScriptSha256 = sha(await read('scripts/phase91-data-audit.mjs'));
const serialized = JSON.stringify(result, null, 2) + '\n';
assert.doesNotMatch(serialized, /https?:\/\/|Bearer\s|Authorization\s*[:=]|Cookie\s*[:=]/i);
const output = join(root, 'data/maintenance-journal/2026-10-02-phase91-data-audit.json');
await writeFile(output, serialized, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output, checkedAt: result.finishedAt, runIds, totals: result.auditTotals,
  counts: result.counts, delta: result.deltaFromBaseline, coverage: result.coverage,
  postPromotion: result.postPromotion, queryOnlyConnections: result.queryOnlyConnections, totalChanges: result.totalChanges }));


