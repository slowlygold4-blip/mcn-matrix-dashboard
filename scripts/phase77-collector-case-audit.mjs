#!/usr/bin/env node
// Read-only peer audit of existing evidence. Never starts a collector/browser.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checksum } from '../lib/utils.mjs';
import { validateWorksOnlyEvidence } from '../lib/works-only-observation.mjs';
import { createCdpObservation } from '../lib/browser-cdp-observation.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const database = new DatabaseSync(`${project}/data/douyin-monitor.sqlite`, { readOnly: true });
const start = new Date().toISOString(), evidence = new Map(), cases = [];
const fixedRuns = [2330, 2350, 2351, 2363, 1160, 1611, 2364, 2366, 2367, 2368];
try {
  database.exec('PRAGMA query_only=ON; BEGIN');
  for (const runId of fixedRuns) {
    const row = database.prepare('SELECT * FROM works_observations WHERE run_id=?').get(runId);
    assert.ok(row, `missing actual persisted run ${runId}`);
    const raw = JSON.parse(row.raw_json);
    assert.equal(checksum(raw), row.source_checksum, 'raw source hash');
    validateWorksOnlyEvidence(raw, { now: Date.parse(start) });
    assert.equal(raw.runId, runId); assert.equal(raw.targetId, row.target_id);
    assert.equal(raw.status, row.status); assert.equal(raw.coverage, row.coverage);
    assert.equal(raw.requestStartedAt, row.request_started_at);
    assert.equal(raw.requestFinishedAt, row.request_finished_at);
    const run = database.prepare('SELECT id,target_id,trigger_type,status,started_at,finished_at,target_count FROM runs WHERE id=?').get(runId);
    assert.equal(run.target_id, row.target_id); assert.equal(run.trigger_type, 'works-only');
    assert.equal(run.target_count, 1); assert.notEqual(run.status, 'running');
    assert.ok(Date.parse(run.started_at) <= Date.parse(raw.requestStartedAt));
    assert.ok(Date.parse(run.finished_at) >= Date.parse(raw.requestFinishedAt));
    const anchor = database.prepare('SELECT source_checksum,raw_json,captured_at FROM snapshots WHERE id=? AND target_id=?').get(raw.anchorSnapshotId, row.target_id);
    assert.ok(anchor); assert.equal(anchor.source_checksum, raw.anchorChecksum);
    const anchorRaw = JSON.parse(anchor.raw_json);
    assert.equal(checksum(anchorRaw), anchor.source_checksum);
    assert.equal(anchorRaw.profile?.user?.sec_uid, raw.identity.secUid);
    assert.equal(String(anchorRaw.profile?.user?.uid), raw.identity.uid);
    assert.ok(Date.parse(anchor.captured_at) <= Date.parse(raw.requestStartedAt));
    assert.ok(Date.parse(raw.requestStartedAt) - Date.parse(anchor.captured_at) <= 8 * 3600000);
    evidence.set(runId, raw);
    const d = raw.failureDiagnostics ?? {}, resources = d.resourceObservation?.resources ?? {};
    cases.push({ observationId: row.id, runId, targetId: row.target_id,
      sourceChecksum: row.source_checksum, sourceHashVerified: true, canonicalContractVerified: true,
      anchorHashIdentityTimeVerified: true, runStatus: run.status,
      requestStartedAt: raw.requestStartedAt, requestFinishedAt: raw.requestFinishedAt,
      status: raw.status, coverage: raw.coverage, errorCode: raw.errorCode, posts: raw.posts.length,
      pagination: raw.pagination ? { stopReason: raw.pagination.stopReason, errorCode: raw.pagination.errorCode,
        requestCount: raw.pagination.requestCount, pages: raw.pagination.pages.map(p => ({ requestCursor: p.requestCursor,
          response: p.response, rawCount: p.rawCount, acceptedCount: p.acceptedCount, observedAt: p.observedAt })) } : null,
      requests: d.requests, responses: d.responses, firstPageRequest: d.firstPageRequest ?? null,
      httpStatuses: d.httpStatuses, businessStatusCodes: d.businessStatusCodes,
      firstScreen: d.firstScreen ? {
        readyState: d.firstScreen.readyState, bodyPresent: d.firstScreen.bodyPresent,
        worksAnchorCount: d.firstScreen.worksAnchorCount, render: d.firstScreen.render } : null,
      activation: d.firstPageActivation, lifecycle: d.lifecycle, terminalStructure: d.terminalStructure,
      elapsedMs: d.elapsedMs, diagnosticStopReason: d.stopReason,
      resourceScripts: resources.script, resourceXhr: resources.xhr, resourceFetch: resources.fetch,
      beforeStopFetchBlocked: d.resourceObservation?.failuresByPhase?.beforeStop?.kinds?.['blocked-client'] ?? null,
      cdp: d.cdpObservation ? { state: d.cdpObservation.state, capacity: d.cdpObservation.capacity,
        untracked: d.cdpObservation.untracked,
        authorPostsFailures: d.cdpObservation.failuresByPhase?.beforeStop?.authorPosts,
        authorPostsEndpointFailures: d.cdpObservation.failuresByPhase?.beforeStop?.authorPostsEndpoint } : null });
  }
  for (const id of [1160, 1611]) {
    assert.equal(evidence.get(id).targetId, evidence.get(2363).targetId);
    assert.deepEqual(evidence.get(id).identity, evidence.get(2363).identity, 'same target AND source-bound identity');
    assert.equal(evidence.get(id).status, 'accepted');
  }
  for (const id of [2330, 2350, 2351]) {
    const d = evidence.get(id).failureDiagnostics;
    assert.equal(evidence.get(id).status, 'accepted'); assert.ok(d.requests.candidate > 0);
    assert.deepEqual(Object.values(d.cdpObservation.failuresByPhase.beforeStop.authorPosts), [0, 0, 0]);
    assert.equal(d.resourceObservation.failuresByPhase.beforeStop.kinds['blocked-client'], 13);
  }
  for (const id of [2350, 2351, 2363]) {
    assert.equal(evidence.get(id).failureDiagnostics.resourceObservation.resources.xhr.statusCounts.find(x => x.status === 403)?.count, 1);
  }
  assert.equal(evidence.get(2363).failureDiagnostics.requests.candidate, 0);
  assert.equal(evidence.get(2363).failureDiagnostics.firstPageActivation.actionCount, 0);
  assert.equal(evidence.get(2363).failureDiagnostics.firstPageActivation.structure.reason, 'region-absent');
  for (const id of [2350, 2351]) assert.equal(evidence.get(id).failureDiagnostics.firstScreen.readyState, 'loading');
  const boundRefusal = evidence.get(2364);
  assert.equal(boundRefusal.status, 'unavailable'); assert.equal(boundRefusal.errorCode, 'blocked');
  assert.equal(boundRefusal.failureDiagnostics.requests.matched, 1);
  assert.equal(boundRefusal.failureDiagnostics.responses.matched, 1);
  assert.deepEqual(boundRefusal.failureDiagnostics.httpStatuses, [403]);
  assert.equal(boundRefusal.failureDiagnostics.stopReason, 'http-rejection');
  assert.equal(boundRefusal.posts.length, 0);
  for (const id of [2366, 2367, 2368]) {
    const r = evidence.get(id), d = r.failureDiagnostics;
    assert.equal(r.status, 'unavailable'); assert.equal(r.errorCode, 'blocked');
    assert.deepEqual(d.firstPageRequest, { kind: 'collector-same-origin-get', state: 'issued', attemptCount: 1 });
    assert.equal(d.requests.matched, 1); assert.equal(d.responses.matched, 1);
    assert.deepEqual(d.httpStatuses, [403]); assert.equal(r.posts.length, 0);
  }
  const latestRuns = database.prepare('SELECT id,trigger_type,status,started_at,finished_at,target_count,success_count,error_count FROM runs ORDER BY id DESC LIMIT 6').all();
  const openRuns = database.prepare("SELECT id,trigger_type,started_at FROM runs WHERE status='running' OR finished_at IS NULL ORDER BY id DESC LIMIT 8").all();
  assert.equal(database.prepare('SELECT total_changes() AS value').get().value, 0);
  if (!process.argv.includes('--summary')) for (const record of cases)
    console.log(JSON.stringify({ kind: 'phase77-verified-existing-case', ...record }));
  console.log(JSON.stringify({ kind: 'phase77-existing-source-audit', checkedAt: start, verifiedRuns: fixedRuns,
    sameIdentityAcceptedThenUnavailable: [1160, 1611, 2363], latestRuns, openRuns, readOnlyChanges: 0 }));
} finally { database.exec('ROLLBACK'); database.close(); }

// Exercise the actual production reducer, without launching any browser.
const secUid = 'MS4wLjABAAAAabcdefghijklmnopqrstuv';
const profile = `https://www.douyin.com/user/${secUid}`;
const works = `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${secUid}&max_cursor=0&count=20`;
const cdp = createCdpObservation({ mainFrameId: 'root', secUid });
const request = (requestId, type, url) => ({ requestId, type, frameId: 'root', loaderId: 'loader', request: { method: 'GET', url } });
cdp.request(request('doc', 'Document', profile));
cdp.response({ requestId: 'doc', type: 'Document', frameId: 'root', loaderId: 'loader', response: { status: 200, url: profile } });
cdp.commit({ frame: { id: 'root', loaderId: 'loader', url: profile } });
cdp.request(request('successful-work', 'XHR', works)); cdp.finished({ requestId: 'successful-work' });
assert.equal(cdp.snapshot().finished, 1);
assert.deepEqual(Object.values(cdp.snapshot().failuresByPhase.beforeStop.authorPosts), [0, 0, 0]);
cdp.request(request('failed-work', 'XHR', works)); cdp.failed({ requestId: 'failed-work', blockedReason: 'inspector' });
assert.equal(cdp.snapshot().failuresByPhase.beforeStop.authorPosts['current-document'], 1);
console.log(JSON.stringify({ actualReducerProof: 'successful works do not increment failed-authorPosts counters', offlineAssertionsPassed: true }));
for (const file of ['scripts/douyin_browser_collector.mjs', 'lib/browser-first-works-request.mjs', 'lib/browser-cdp-observation.mjs',
  'lib/browser-first-page-activation.mjs', 'lib/browser-render-diagnostics.mjs', 'lib/works-only-observation.mjs']) {
  const bytes = await readFile(`${project}/${file}`);
  console.log(JSON.stringify({ file, sha256: createHash('sha256').update(bytes).digest('hex') }));
}
