import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorksOnlyEvidence } from '../lib/works-only-observation.mjs';
import { projectWorksOnlyFailure } from '../lib/works-only-failure.mjs';
import { checksum } from '../lib/utils.mjs';
const evidence = () => ({ version: 1, kind: 'works-only-observation', source: 'authorised-browser', targetId: 1, runId: 2,
  anchorSnapshotId: 1, anchorChecksum: 'a'.repeat(64), requestedLimit: 30,
  identity: { secUid: 'MS4wLjABAAAAWorksOnlyFixture12345678', uid: '123456789' },
  requestStartedAt: '2026-09-29T00:00:00.000Z', requestFinishedAt: '2026-09-29T00:00:10.000Z',
  observedAt: null, status: 'unavailable', coverage: 'unavailable', errorCode: 'collector_error', posts: [], pagination: null });
const now = Date.parse('2026-09-29T00:01:00.000Z');

test('optional diagnostic projection keeps historical canonical checksum unchanged', () => {
  const before = evidence(); const accepted = validateWorksOnlyEvidence(before, { now });
  assert.equal(checksum(before), checksum(accepted));
  assert.deepEqual(projectWorksOnlyFailure(before), {});
});

test('no-bound-request diagnostic is preserved without giving unavailable evidence a sample time', () => {
  const safe = projectWorksOnlyFailure({ failureStage: 'browser-page', failureDiagnostics: {
    version: 1, stopReason: 'no-bound-request', elapsedMs: 25000,
    navigation: { observed: true, committed: true, failed: false, timedOut: false },
    requests: { matched: 0, candidate: 0 }, finalPageKind: 'profile', message: 'SECRET', url: 'https://secret.example/?cookie=SECRET',
  } });
  const accepted = validateWorksOnlyEvidence({ ...evidence(), ...safe }, { now });
  assert.equal(accepted.failureDiagnostics.requests.matched, 0);
  assert.equal(accepted.failureDiagnostics.stopReason, 'no-bound-request');
  assert.equal(accepted.observedAt, null);
  assert.equal(JSON.stringify(accepted).includes('SECRET'), false);
});

test('known process codes persist but raw exception and unknown stages cannot enter canonical history', () => {
  const safe = projectWorksOnlyFailure({ failureStage: 'collector-process', failureCode: 'BROWSER_COLLECTOR_TIMEOUT', error: 'SECRET' });
  assert.equal(validateWorksOnlyEvidence({ ...evidence(), ...safe }, { now }).failureCode, 'BROWSER_COLLECTOR_TIMEOUT');
  for (const unknown of [{ failureStage: 'SECRET' }, { failureCode: 'SECRET' }, { failureDiagnostics: { version: 2, error: 'SECRET' } }]) {
    assert.deepEqual(projectWorksOnlyFailure(unknown), {});
    assert.throws(() => validateWorksOnlyEvidence({ ...evidence(), ...unknown }, { now }), { code: 'WORKS_OBSERVATION_INVALID' });
  }
});

test('diagnostic metadata does not bypass existing future timestamp or metric guards', () => {
  const row = { ...evidence(), ...projectWorksOnlyFailure({ failureStage: 'browser-page', failureDiagnostics: { version: 1, stopReason: 'success' } }) };
  assert.throws(() => validateWorksOnlyEvidence({ ...row, requestFinishedAt: '2026-09-30T00:00:10.000Z' }, { now }), { code: 'WORKS_OBSERVATION_INVALID' });
  assert.throws(() => validateWorksOnlyEvidence({ ...row, posts: [{ aweme_id: '12345678901234567' }] }, { now }), { code: 'WORKS_OBSERVATION_INVALID' });
});
