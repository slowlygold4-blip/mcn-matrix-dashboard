import test from 'node:test';
import assert from 'node:assert/strict';
import { publicWorksCoverage } from '../lib/public-account-coverage.mjs';

const attemptedAt = '2026-10-24T00:00:02.000Z';
const observedAt = '2026-10-24T00:00:01.000Z';
const fields = ['attemptedAt', 'observedAt', 'status'];

test('public works coverage keeps the exact three-field publication contract', () => {
  for (const coverage of ['complete', 'limited', 'unavailable']) {
    const result = publicWorksCoverage({ coverage, carriedForward: false, lastAttemptAt: attemptedAt, observedAt }, { hasCandidates: true });
    assert.deepEqual(Object.keys(result).sort(), fields);
    assert.equal(result.status, coverage);
    assert.equal(result.attemptedAt, attemptedAt);
    assert.equal(result.observedAt, observedAt);
  }
});

test('verification budget exhaustion cannot leak an internal reason into public catalog', () => {
  const result = publicWorksCoverage({ coverage: 'complete', carriedForward: false, lastAttemptAt: attemptedAt, observedAt },
    { hasCandidates: true, verificationLimited: true });
  assert.deepEqual(result, { status: 'unavailable', attemptedAt: null, observedAt });
  assert.deepEqual(Object.keys(result).sort(), fields);
});

test('carried observations and absent candidates cannot masquerade as fresh works', () => {
  assert.deepEqual(publicWorksCoverage({ coverage: 'complete', carriedForward: true, lastAttemptAt: attemptedAt, observedAt },
    { hasCandidates: true }), { status: 'unavailable', attemptedAt, observedAt });
  assert.deepEqual(publicWorksCoverage({ coverage: 'complete', carriedForward: false, lastAttemptAt: attemptedAt, observedAt },
    { hasCandidates: false }), { status: 'missing', attemptedAt: null, observedAt: null });
});
