// Phase87 independent original-run and public-byte readback. No producer or review mutations.
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
import { preparePublicReplicaPublication } from '../lib/public-replica-sync.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[2];
assert.ok(['initial', 'final', 'public', 'handoff'].includes(mode));
const output = join(root, `data/maintenance-journal/2026-10-02-phase87-data-peer-${mode}.json`);
const sha = value => createHash('sha256').update(value).digest('hex');
const read = path => readFile(join(root, path));
const oldBytes = await read('data/maintenance-journal/2026-10-02-phase86-natural-provenance-peer-handoff.json');
const old = JSON.parse(oldBytes);
assert.deepEqual(old.proofs.map(p => p.runId), Array.from({ length: 13 }, (_, i) => 2392 + i));
assert.equal(old.auditTotals.sourceBoundNewWorkRows, 23);
assert.equal(old.auditTotals.exactMetricVectors, 152);
const baseline = { maxRun: 2404, snapshots: 43958, posts: 16236, post_metrics: 112089, works_observations: 1612 };
const fields = ['likes', 'comments', 'shares', 'collects', 'plays'];
const vector = object => Object.fromEntries(fields.map(key => [key, object[key] ?? null]));
const startedAt = new Date().toISOString();
const get = async path => { const response = await fetch('http://127.0.0.1:4188' + path, { signal: AbortSignal.timeout(20000) }); assert.equal(response.status, 200); return response.json(); };
const sourceBefore = await read('data/source-poll/manifest.json');
assert.equal(sha(sourceBefore), old.source.sha256);
const source = JSON.parse(sourceBefore);
const jobProjection = Object.entries(source.sources).map(([key, value]) => ({ key, jobId: value.lastJobId ?? null })).sort((a, b) => a.key.localeCompare(b.key));
assert.equal(checksum(jobProjection), old.source.jobIdProjectionSha256);
const [health, status] = await Promise.all([get('/api/health'), get('/api/monitoring-status')]);
assert.equal(health.status, 'ready'); assert.equal(health.runtimeAI, false);
assert.deepEqual(status.scheduler.slotTimes, ['02:00', '10:00', '18:00']);
assert.equal(status.scheduler.scheduleIntervalHours, 8);
const ps = execFileSync('/bin/ps', ['-ax', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n');
const services = ['server.mjs', 'scripts/source-poller.mjs --loop', 'scripts/public-replica-publisher.mjs'].map(file => {
  const matches = ps.filter(line => line.trim().endsWith(join(root, file)));
  assert.equal(matches.length, 1);
  const [, pid, ppid] = /^\s*(\d+)\s+(\d+)\s+/.exec(matches[0]); assert.equal(Number(ppid), 1);
  return { file, pid: Number(pid), ppid: Number(ppid), actualProcessPresent: true };
});
const listen = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(services[0].pid), '-iTCP:4188', '-sTCP:LISTEN', '-F', 'pn'], { encoding: 'utf8' });
assert.match(listen, new RegExp(`^p${services[0].pid}$`, 'm')); assert.match(listen, /n.*:4188/);
const publisher = JSON.parse(await read('data/public-replica-publisher/state.json'));
const code = {};
for (const [key, file, expected] of [
  ['collector', 'scripts/douyin_browser_collector.mjs', 'ee1d40508a43a098cc28e5b522e0af60b563666c6f7f6ddd46258b6d069f2444'],
  ['firstPageRequestHelper', 'lib/browser-first-works-request.mjs', 'ccd295c0776c6b4af38c990e909358f36f72c44ae5b774d250fba993cec8926c'],
]) { code[key] = sha(await read(file)); code[key + 'MatchesInheritedBaseline'] = code[key] === expected;
  if (mode === 'initial') assert.equal(code[key], expected); }
const inherited = [];
for (const proof of old.proofs) {
  assert.equal(new Set(Object.values(proof.fourSourceHashes)).size, 1);
  const eventSha = sha(await read(`data/ingestion-reviews/run-${proof.runId}.json`));
  assert.equal(eventSha, proof.originalEventSha256);
  for (const item of proof.sourceVectors) assert.deepEqual(item.expectedMetrics, item.savedMetrics);
  inherited.push({ runId: proof.runId, sourceSha256: proof.sourceSha256, originalEventSha256: eventSha,
    sourceCount: proof.sourceVectors.length, sourceBoundNewWorkRows: proof.sourceBoundNewWorkRows });
}

const result = { startedAt, scope: 'phase87-read-only-natural-data-peer', baseline,
  inheritedProofSha256: sha(oldBytes), inherited, inheritedAuditNotReopened: true,
  runtime: { health, services, serverListenHandleVerified: true, scheduleSlots: status.scheduler.slotTimes,
    codeHashesDescribeAuditTimeNotPerRunLoadedCode: true,
    nextNaturalWorkRetryAt: status.scheduler.worksOnlyRetry.nextEligibleAt,
    worksRetry: status.scheduler.worksOnlyRetry, publisher: { status: publisher.status,
      publishedAsOf: publisher.publishedAsOf ?? null, activeAsOf: publisher.active?.asOf ?? null,
      syncStatus: publisher.sync?.status ?? null }, code },
  source: { sha256: sha(sourceBefore), sourceCount: jobProjection.length, jobIdProjectionSha256: checksum(jobProjection),
    lastFinishedAt: source.lastFinishedAt, unchangedInheritedBytesAndJobIds: true, noNewSourceEventToAudit: true },
  proofs: [], pendingRuns: [], noManualCollection: true, noSupplierRequests: true,
  noForcedExportOrSync: true, noProductReviewCompletion: true, noTimerOrServiceControl: true,
  noDatabaseOrExistingFileWrites: true, noPlatformCompletenessClaim: true };

if (mode !== 'public') {
  const history = await get('/api/rebuild/accounts/264/history?kind=daily&startDate=2026-09-01&endDate=2026-09-30&pageSize=100&order=asc');
  const db = new DatabaseSync(join(root, 'data/douyin-monitor.sqlite'), { readOnly: true });
  const backupReceipt = JSON.parse(await read('data/maintenance-journal/2026-10-02-phase86-backup.json'));
  const copy = new DatabaseSync(backupReceipt.restoredPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN'); copy.exec('PRAGMA query_only=ON; BEGIN');
    const runs = db.prepare("SELECT * FROM runs WHERE id>? AND finished_at IS NOT NULL AND status<>'running' ORDER BY id LIMIT 60").all(baseline.maxRun);
    assert.equal(runs.length, db.prepare("SELECT count(*) n FROM runs WHERE id>? AND finished_at IS NOT NULL AND status<>'running'").get(baseline.maxRun).n);
    const verified = runs.length ? loadVerifiedWorksOnlyRows(db, new Date().toISOString(), null, { runIds: runs.map(run => run.id) }) : [];
    for (const run of runs) {
      assert.equal(run.trigger_type, 'works-only');
      const row = db.prepare('SELECT * FROM works_observations WHERE run_id=?').get(run.id); assert.ok(row);
      const raw = JSON.parse(row.raw_json), canonical = validateWorksOnlyEvidence(raw);
      const hashes = [sha(row.raw_json), checksum(raw), checksum(canonical), row.source_checksum];
      assert.equal(new Set(hashes).size, 1);
      assert.ok(verified.some(item => item.run_id === run.id && item.target_id === run.target_id));
      const target = db.prepare('SELECT id,locator FROM targets WHERE id=?').get(run.target_id);
      const anchor = db.prepare('SELECT * FROM snapshots WHERE id=?').get(row.anchor_snapshot_id);
      const anchorRaw = JSON.parse(anchor.raw_json);
      assert.equal(checksum(anchorRaw), row.anchor_checksum); assert.equal(anchor.source_checksum, row.anchor_checksum);
      assert.equal(raw.runId, run.id); assert.equal(raw.targetId, run.target_id);
      assert.equal(raw.anchorSnapshotId, anchor.id); assert.equal(anchor.target_id, run.target_id);
      assert.equal(raw.identity.secUid, target.locator); assert.equal(raw.identity.secUid, anchorRaw.profile.user.sec_uid);
      assert.equal(raw.identity.uid, anchorRaw.profile.user.uid);
      const at = value => Date.parse(value);
      assert.ok(at(anchor.captured_at) <= at(raw.requestStartedAt));
      assert.ok(at(raw.requestStartedAt) - at(anchor.captured_at) <= 8 * 3600000);
      assert.ok(at(run.started_at) <= at(raw.requestStartedAt));
      assert.ok(at(raw.requestFinishedAt) <= at(row.created_at)); assert.ok(at(row.created_at) <= at(run.finished_at));
      assert.ok(at(raw.requestFinishedAt) - at(raw.requestStartedAt) <= 45000);
      let offset = 0;
      const sourceVectors = [];
      for (const page of raw.pagination?.pages ?? []) {
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
            publishedAt: normalized.publishedAt, captionSha256: sha(normalized.caption), rawPostSha256: checksum(post),
            metricVectorSha256: checksum(vector(metric)), exactMetricVector: true, currentFieldsMatchObservation,
            firstSeenAtThisObservation: saved.first_seen_at === page.observedAt });
        }
        offset += page.acceptedCount;
      }
      assert.equal(sourceVectors.length, raw.posts.length);
      if (raw.status === 'unavailable') { assert.equal(raw.posts.length, 0); assert.equal(raw.pagination, null); assert.equal(raw.observedAt, null); }
      const eventBytes = await read(`data/ingestion-reviews/run-${run.id}.json`), event = JSON.parse(eventBytes);
      assert.equal(Object.keys(event).length, 21);
      assert.deepEqual(buildPostIngestionReview({ database: db, runId: run.id, now: new Date(event.reviewedAt) }), event);
      const diagnostics = raw.failureDiagnostics ?? null;
      result.proofs.push({ runId: run.id, targetId: run.target_id, triggerType: run.trigger_type,
        startedAt: run.started_at, finishedAt: run.finished_at, runStatus: run.status, status: row.status,
        coverage: row.coverage, errorCode: row.error_code, fourSourceHashes: hashes,
        fourSourceHashesEqual: true, actualReaderAccepted: true, runIdentityAnchorTimeVerified: true,
        anchorSnapshotId: anchor.id, anchorCapturedAt: anchor.captured_at, requestStartedAt: raw.requestStartedAt,
        requestFinishedAt: raw.requestFinishedAt, sourceVectors, sourcePostCount: raw.posts.length,
        sourceBoundNewWorkRows: sourceVectors.filter(x => x.firstSeenAtThisObservation).length,
        originalEventSha256: sha(eventBytes), originalEventFieldCount: 21, exactEventRebuild: true,
        originalProductReviewState: event.productReview.status, failureStage: raw.failureStage ?? null,
        diagnosticSha256: checksum(diagnostics), diagnosticTopLevelKeys: diagnostics ? Object.keys(diagnostics).sort() : [],
        observedRequestState: { firstPageRequestState: diagnostics?.firstPageRequest?.state ?? null,
          firstPageRequestAttemptCount: diagnostics?.firstPageRequest?.attemptCount ?? null,
          firstPageActivationState: diagnostics?.firstPageActivation?.state ?? null,
          activationProbeCount: diagnostics?.firstPageActivation?.probeCount ?? null,
          activationActionCount: diagnostics?.firstPageActivation?.actionCount ?? null,
          activationStructureReason: diagnostics?.firstPageActivation?.structure?.reason ?? null,
          requestCandidateCount: diagnostics?.requests?.candidate ?? null,
          requestMatchedCount: diagnostics?.requests?.matched ?? null,
          rejectedFirstCursorCount: diagnostics?.requests?.rejected?.firstCursor ?? null,
          paginationPageCount: raw.pagination?.pages?.length ?? 0,
          finalPageHasMore: raw.pagination?.pages?.at(-1)?.response?.has_more ?? null },
        paginationStopReason: raw.pagination?.stopReason ?? null });
    }
    result.counts = Object.fromEntries(['targets', 'snapshots', 'posts', 'post_metrics', 'works_observations'].map(t => [t, db.prepare(`SELECT count(*) n FROM ${t}`).get().n]));
    result.counts.maxRun = db.prepare('SELECT max(id) n FROM runs').get().n;
    result.pendingRuns = db.prepare('SELECT id,trigger_type,target_id,status,started_at FROM runs WHERE id>? AND finished_at IS NULL ORDER BY id LIMIT 60').all(baseline.maxRun);
    result.deltaFromBaseline = Object.fromEntries(['snapshots', 'posts', 'post_metrics', 'works_observations'].map(key => [key, result.counts[key] - baseline[key]]));
    for (const value of Object.values(result.deltaFromBaseline)) assert.ok(value >= 0);
    const sla = inspectUpdateSla(db, { now: new Date(status.updateSla.checkedAt ?? status.checkedAt), includeTargets: true });
    for (const [values, api, kind] of [[sla.coreAccounts.targets, status.updateSla.coreAccounts.daily, 'profile'], [sla.works.daily.targets, status.updateSla.works.daily, 'works'], [sla.topics.targets, status.updateSla.topics.daily, 'topics']]) {
      assert.equal(new Set(values.map(x => x.targetId)).size, values.length); assert.equal(values.length, api.total);
      assert.equal(values.filter(x => kind === 'works' ? x.state === 'complete' : x.dailyComplete).length, api.complete);
    }
    const states = Object.fromEntries(['complete', 'limited', 'unavailable', 'unknown', 'missing'].map(state => [state, sla.works.daily.targets.filter(x => x.state === state).length]));
    assert.deepEqual(states, status.updateSla.works.daily.counts);
    assert.equal(sla.coreAccounts.daily.total, 701); assert.equal(sla.works.daily.total, 701); assert.equal(sla.topics.daily.total, 4);
    result.coverage = { businessDate: sla.businessDate, profile: sla.coreAccounts.daily, works: states, topics: sla.topics.daily, actualDistinctReaderEqualsAPI: true };
    assert.deepEqual(getAccountHistory(db, 264, { kind: 'daily', startDate: '2026-09-01', endDate: '2026-09-30', pageSize: 100, order: 'asc', asOf: history.asOf, ...history.revision }), history);
    assert.equal(history.items.length, 28); assert.equal(history.pagination.total, 28);
    assert.equal(history.coverage.missingDatesFilled, false); assert.equal(history.coverage.platformComplete, false);
    assert.ok(!history.items.some(x => ['2026-09-18', '2026-09-19'].includes(x.date)));
    const target = db.prepare('SELECT * FROM targets WHERE id=264').get();
    const historyVectors = [];
    for (const item of history.items) {
      const saved = db.prepare('SELECT * FROM snapshots WHERE id=? AND target_id=264').get(item.id);
      const original = copy.prepare('SELECT raw_json,source_checksum FROM snapshots WHERE id=? AND target_id=264').get(item.id);
      assert.equal(saved.raw_json, original.raw_json); assert.equal(saved.source_checksum, original.source_checksum);
      const raw = JSON.parse(saved.raw_json), normalized = normalizeCollection(target, raw, { capturedAt: saved.captured_at });
      assert.equal(checksum(raw), item.sourceChecksum); assert.equal(item.date, businessDateKey(item.capturedAt));
      assert.equal(item.followers, normalized.snapshot.followers); assert.equal(item.likes, normalized.snapshot.totalLikes); assert.equal(item.posts, normalized.snapshot.totalPosts);
      historyVectors.push({ date: item.date, sourceSha256: item.sourceChecksum, rawBytesSha256: sha(saved.raw_json) });
    }
    result.history = { targetId: 264, dates: historyVectors, preservedMissingDates: ['2026-09-18', '2026-09-19'],
      original28SourceVectorsVerified: true, equalFrozenAPI: true, equalExistingBackupBytes: true };
    assert.equal(copy.prepare('SELECT max(id) n FROM runs').get().n, 2399);
    result.backup = { reusedExistingPrivateCopy: true, cutoffRun: 2399, coversNewRunIds: false,
      bytes: (await stat(backupReceipt.restoredPath)).size, mode: ((await stat(backupReceipt.restoredPath)).mode & 511).toString(8) };
    assert.equal(result.backup.bytes, 823197696); assert.equal(result.backup.mode, '400');
    for (const connection of [db, copy]) { assert.equal(connection.prepare('PRAGMA query_only').get().query_only, 1); assert.equal(connection.prepare('SELECT total_changes() n').get().n, 0); connection.exec('ROLLBACK'); }
    result.queryOnly = 1; result.totalChanges = 0;
  } finally { db.close(); copy.close(); }
  if (mode === 'final' || mode === 'handoff') {
    const hashFile = async path => { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); };
    const hashes = await Promise.all([hashFile(backupReceipt.backupPath), hashFile(backupReceipt.restoredPath)]);
    assert.equal(hashes[0], backupReceipt.sha256); assert.equal(hashes[1], backupReceipt.sha256);
    result.backup.originalAndPrivateCopySha256 = hashes[0];
    result.backup.existingFilesByteExact = true; result.backup.newBackupOrCopyCreated = false;
  }
}

if (mode !== 'initial') {
  let publicReadStage = 'metadata';
  try {
  const exec = promisify(execFile);
  const publicGet = async path => {
    const { stdout } = await exec('/usr/bin/curl', ['-sS', '--max-time', '20', '-w', '\n%{http_code}', 'https://mcn-matrix-observatory.slowlygold4.chatgpt.site' + path], { encoding: 'buffer', maxBuffer: 20_000_000 });
    assert.equal(stdout.subarray(-4, -3).toString(), '\n'); assert.equal(Number(stdout.subarray(-3).toString()), 200);
    return stdout.subarray(0, -4);
  };
  const metadataBytes = await publicGet('/api/replica'), metadata = JSON.parse(metadataBytes), asOf = metadata.manifest.asOf;
  assert.equal(metadata.readOnly, true); assert.equal(metadata.collectionRequiresLocalComputer, true);
  result.public = { checkedAt: new Date().toISOString(), asOf, metadataSha256: sha(metadataBytes), publishedAt: metadata.publishedAt,
    readOnly: true, collectionRequiresLocalComputer: true, newGenerationActivated: asOf > '2026-10-01T22:44:10.262Z',
    noCredentialSupplied: true, noForceOrDeployment: true, parts: [], sourceBoundWorks: [], sourceBoundMetrics: [] };
  if (result.public.newGenerationActivated) {
    publicReadStage = 'sealed-publication-validation';
    assert.match(asOf, /^2026-10-01T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const directory = join(root, 'data/public-replica-staging', 'publisher-' + asOf.replace(/[:.]/g, '-'));
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json')));
    const publication = await preparePublicReplicaPublication({ manifest, files: await Promise.all(manifest.files.map(async f => ({ ...f, content: await readFile(join(directory, f.path), 'utf8') }))) }, { dateIndex: true });
    assert.deepEqual(metadata.manifest, publication.manifest);
    const proofs = [...old.proofs, ...result.proofs];
    const targets = [...new Set(proofs.filter(p => p.sourceVectors.some(source => source.observedAt <= asOf)).map(p => p.targetId))];
    const paths = ['catalog.json', 'topics.json', 'summary.json', 'date-summary-index.json', 'daily/264.json', ...targets.flatMap(id => [`works/${id}.json`, `work-metrics/${id}.json`])];
    const parts = new Map();
    for (const path of paths) {
      publicReadStage = 'part:' + path;
      const file = publication.files.find(f => f.path === path); assert.ok(file);
      const body = await publicGet('/api/replica?' + new URLSearchParams({ generation: asOf, part: path }));
      assert.equal(body.length, file.bytes); assert.equal(sha(body), file.sha256);
      const part = JSON.parse(body); assert.equal(part.asOf, asOf); parts.set(path, part);
      result.public.parts.push({ path, bytes: body.length, sha256: sha(body) });
    }
    publicReadStage = 'source-bound-vectors';
    result.public.firstSeenAtCanonicalizedCount = 0;
    const latestSource = new Map();
    for (const proof of proofs) for (const source of proof.sourceVectors) {
      const key = `${proof.targetId}:${source.postId}`;
      if (source.observedAt <= asOf && (!latestSource.has(key) || latestSource.get(key).observedAt < source.observedAt)) latestSource.set(key, source);
    }
    for (const proof of proofs) for (const source of proof.sourceVectors) {
      if (source.observedAt > asOf) continue;
      const work = parts.get(`works/${proof.targetId}.json`).items.find(x => x.id === source.postId); assert.ok(work);
      assert.equal(sha(work.externalId), source.externalIdSha256); assert.equal(work.publishedAt, source.publishedAt);
      // The public contract represents an empty normalized caption as null.
      assert.equal(sha(work.caption ?? ''), source.captionSha256);
      assert.equal(work.firstSeenAt, new Date(source.firstSeenAt).toISOString());
      if (work.firstSeenAt !== source.firstSeenAt) result.public.firstSeenAtCanonicalizedCount++;
      const metric = parts.get(`work-metrics/${proof.targetId}.json`).items.find(x => x.workId === source.postId && x.capturedAt === source.observedAt); assert.ok(metric);
      assert.equal(sha(metric.externalId), source.externalIdSha256);
      assert.equal(checksum(vector(metric)), source.metricVectorSha256 ?? checksum(source.expectedMetrics));
      if (latestSource.get(`${proof.targetId}:${source.postId}`) === source && source.currentFieldsMatchObservation) {
        assert.equal(work.lastObservedAt, source.observedAt);
        assert.equal(checksum(vector(work)), source.metricVectorSha256 ?? checksum(source.expectedMetrics));
      }
      result.public.sourceBoundMetrics.push({ runId: proof.runId, postId: source.postId, capturedAt: source.observedAt,
        metricVectorSha256: checksum(vector(metric)), externalIdSha256: source.externalIdSha256 });
      if (source.firstSeenAtThisObservation) result.public.sourceBoundWorks.push({ runId: proof.runId, postId: source.postId,
        firstSeenAt: source.firstSeenAt, captionSha256: sha(work.caption ?? ''), externalIdSha256: sha(work.externalId) });
    }
    const september = parts.get('daily/264.json').items.filter(x => x.date >= '2026-09-01' && x.date <= '2026-09-30');
    assert.equal(september.length, 28); assert.ok(!september.some(x => ['2026-09-18', '2026-09-19'].includes(x.date)));
    result.public.historical28DaysAndMissingDatesPreserved = true;
    const after = JSON.parse(await publicGet('/api/replica'));
    result.public.currentGenerationAtEnd = after.manifest.asOf;
    result.public.sameGenerationThroughoutReadback = after.manifest.asOf === asOf;
    publicReadStage = 'current-generation-readback';
    assert.equal(after.manifest.asOf, asOf);
    result.public.newWorkCount = result.public.sourceBoundWorks.length;
    result.public.sourceMetricObservationCount = result.public.sourceBoundMetrics.length;
    result.public.inheritedSourceBoundNewWorkCount = result.public.sourceBoundWorks.filter(x => x.runId <= 2404).length;
    result.public.currentSourceBoundNewWorkCount = result.public.sourceBoundWorks.filter(x => x.runId > 2404).length;
    result.public.inheritedSourceMetricObservationCount = result.public.sourceBoundMetrics.filter(x => x.runId <= 2404).length;
    result.public.currentSourceMetricObservationCount = result.public.sourceBoundMetrics.filter(x => x.runId > 2404).length;
    result.public.newerLocalMetricObservationsOutsidePublicGeneration = result.proofs.reduce((sum, proof) => sum + proof.sourceVectors.filter(source => source.observedAt > asOf).length, 0);
    result.public.manifestFiles = metadata.manifest.files.length;
    result.public.manifestCounts = metadata.manifest.counts;
    result.public.allAuditedPartBytesEqualSealedPublication = true;
    result.public.readbackVerified = true;
  }
  } catch (error) {
    result.public ??= {};
    result.public.readbackVerified = false;
    result.public.failure = { stage: publicReadStage, code: error.code ?? error.name,
      messageSha256: sha(String(error.message)), assertionActualSha256: error.actual == null ? null : checksum(error.actual),
      assertionExpectedSha256: error.expected == null ? null : checksum(error.expected) };
  }
}

for (const proof of result.proofs) assert.equal(sha(await read(`data/ingestion-reviews/run-${proof.runId}.json`)), proof.originalEventSha256);
assert.equal(sha(await read('data/source-poll/manifest.json')), sha(sourceBefore));
result.auditTotals = { terminalRunCount: result.proofs.length, acceptedRunCount: result.proofs.filter(p => p.status === 'accepted').length,
  unavailableRunCount: result.proofs.filter(p => p.status === 'unavailable').length,
  exactMetricVectors: result.proofs.reduce((sum, p) => sum + p.sourceVectors.length, 0),
  sourceBoundNewWorkRows: result.proofs.reduce((sum, p) => sum + p.sourceBoundNewWorkRows, 0) };
if (mode !== 'public') result.noNewTerminalRuns = result.proofs.length === 0;
else result.publicModeDidNotAuditNewLocalRuns = true;
result.finishedAt = new Date().toISOString();
result.auditScriptSha256 = sha(await read('scripts/phase87-natural-data-peer.mjs'));
// All persisted source identities, captions and vectors are hashes; never persist raw payloads or credentials.
const serialized = JSON.stringify(result, null, 2) + '\n';
assert.doesNotMatch(serialized, /https?:\/\/|Bearer\s|Authorization\s*[:=]|Cookie\s*[:=]/i);
await writeFile(output, serialized, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output, checkedAt: result.finishedAt, runIds: result.proofs.map(p => p.runId),
  auditTotals: result.auditTotals, counts: result.counts, delta: result.deltaFromBaseline,
  pendingRuns: result.pendingRuns, public: result.public ? { asOf: result.public.asOf, newGenerationActivated: result.public.newGenerationActivated,
    parts: result.public.parts?.length, newWorks: result.public.newWorkCount, metrics: result.public.sourceMetricObservationCount,
    readbackVerified: result.public.readbackVerified, failure: result.public.failure } : null,
  queryOnly: result.queryOnly, totalChanges: result.totalChanges }));
