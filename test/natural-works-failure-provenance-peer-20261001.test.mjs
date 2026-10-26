import test from 'node:test';
import assert from 'node:assert/strict';
import { worksOnlyRetryGate } from '../lib/works-only-scheduler.mjs';
import { classifyBrowserWorksFailure } from '../lib/douyin-browser-failure.mjs';
import { createBrowserResourceObservation } from '../lib/browser-resource-observation.mjs';
import { projectWorksOnlyFailure } from '../lib/works-only-failure.mjs';

// Independent local fixtures only: no browser, network, service, storage or session.
const NOW = new Date('2026-10-01T04:49:23.445Z');
const SLOT = { startsAt: '2026-10-01T02:00:00.000Z', endsAt: '2026-10-01T10:00:00.000Z' };
const SECRET = 'SYNTHETIC_PRIVATE_TRANSPORT_DETAIL_NOT_FOR_EXPORT';
function noBound() {
  return { version: 1, stopReason: 'no-bound-request', httpStatuses: [],
    navigation: { observed: true, committed: true, failed: false, timedOut: false },
    requests: { candidate: 0, matched: 0 }, responses: { matched: 0 },
    runtime: { boundRequestFailedCount: 0, navigationErrorKind: 'none' } };
}
function runs(codes) {
  return codes.map((errorCode, i) => ({ id: 900 - i, target_id: 900 - i, status: 'error',
    started_at: `2026-10-01T04:${String(40 - i).padStart(2, '0')}:00.000Z`,
    finished_at: `2026-10-01T04:${String(40 - i).padStart(2, '0')}:30.000Z`,
    details_json: JSON.stringify([{ mode: 'works-only', targetId: 900 - i, attempted: true,
      errorCode, failureDiagnostics: noBound() }]) }));
}
function readOnlyFixture(rows) {
  let calls = 0;
  const database = { db: { prepare(sql) {
    assert.match(sql, /^SELECT id,target_id,status,started_at,finished_at,details_json FROM runs/);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i);
    calls++;
    return { all(...params) {
      assert.deepEqual(params, [SLOT.startsAt, SLOT.endsAt, NOW.toISOString()]);
      return rows;
    } };
  } } };
  return { database, calls: () => calls };
}

test('five unbound observations trigger backpressure without proving a transport failure', () => {
  const diagnostics = noBound();
  const classification = classifyBrowserWorksFailure({ failureDiagnostics: diagnostics });
  assert.equal(classification.errorCode, 'collector_error');
  assert.equal(diagnostics.requests.matched, 0);
  assert.deepEqual(diagnostics.httpStatuses, []);
  assert.equal(diagnostics.runtime.boundRequestFailedCount, 0);
  const f = readOnlyFixture(runs(Array(5).fill(classification.errorCode)));
  const gate = worksOnlyRetryGate(f.database, { now: NOW, slot: SLOT });
  assert.equal(gate.deferred, true);
  assert.equal(gate.failureCount, 5);
  assert.equal(gate.nextEligibleAt, '2026-10-01T04:55:30.000Z');
  // The broad scheduling label must not imply a causal transport receipt.
  // A label-only production change preserves the original policy outcomes.
  assert.equal(gate.reason, 'consecutive-works-transient-failures');
  assert.equal(f.calls(), 1);
});

test('a platform denial is not added to the transient streak and does not erase it', () => {
  const f = readOnlyFixture(runs(['collector_error', 'collector_error', 'blocked', 'collector_error', 'collector_error']));
  const gate = worksOnlyRetryGate(f.database, { now: NOW, slot: SLOT });
  assert.equal(gate.deferred, false);
  assert.equal(gate.failureCount, 4);
  assert.equal(gate.nextEligibleAt, null);
});

function request(kind) {
  return { resourceType: () => kind, isNavigationRequest: () => false,
    failure() { throw new Error(SECRET); }, headers() { throw new Error(SECRET); },
    frame() { throw new Error(SECRET); }, body() { throw new Error(SECRET); },
    url() { throw new Error(SECRET); } };
}
function resourceFixture() {
  const observer = createBrowserResourceObservation();
  const ambient = request('xhr'), failed = request('fetch');
  observer.request(ambient);
  observer.response({ request: () => ambient, status: () => 403 });
  observer.finished(ambient);
  observer.request(failed);
  observer.failed(failed, 'unknown');
  observer.beginCleanup();
  return observer.close();
}

test('an unrelated HTTP 403 and unknown request failure are separate from bound works evidence', () => {
  const resource = resourceFixture();
  assert.equal(resource.resources.xhr.finished, 1);
  assert.equal(resource.resources.xhr.failed, 0);
  assert.deepEqual(resource.resources.xhr.statusCounts, [{ status: 403, count: 1 }]);
  assert.equal(resource.failuresByPhase.beforeStop.kinds.unknown, 1);
  for (const kind of ['dns', 'tls', 'timeout', 'connection', 'aborted']) {
    assert.equal(resource.failuresByPhase.beforeStop.kinds[kind], 0);
  }
  const diagnostics = { ...noBound(), resourceObservation: resource };
  assert.equal(classifyBrowserWorksFailure({ failureDiagnostics: diagnostics }).errorCode, 'collector_error');
  assert.equal(classifyBrowserWorksFailure({ httpStatuses: [403], failureDiagnostics: {
    ...diagnostics, stopReason: 'http-rejection', requests: { candidate: 1, matched: 1 },
    responses: { matched: 1 }, httpStatuses: [403] } }).errorCode, 'blocked');
  assert.equal(resource.trackedRequests, 0);
  assert.equal(JSON.stringify(resource).includes(SECRET), false);
});

test('failure evidence keeps only structural counters and rejects raw provenance or transport text', () => {
  const input = { failureStage: 'browser-page', errorText: SECRET, rawUrl: SECRET,
    failureDiagnostics: { ...noBound(), resourceObservation: resourceFixture(),
      message: SECRET, requestUrl: SECRET, cookie: SECRET } };
  const projected = projectWorksOnlyFailure(input);
  assert.deepEqual(Object.keys(projected), ['failureDiagnostics', 'failureStage']);
  assert.equal(projected.failureDiagnostics.stopReason, 'no-bound-request');
  assert.equal(projected.failureDiagnostics.requests.matched, 0);
  assert.equal(projected.failureDiagnostics.resourceObservation.failuresByPhase.beforeStop.kinds.unknown, 1);
  assert.equal(JSON.stringify(projected).includes(SECRET), false);
});
