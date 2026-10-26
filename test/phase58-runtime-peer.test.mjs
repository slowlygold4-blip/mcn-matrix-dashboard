import test from 'node:test';
import assert from 'node:assert/strict';
import { checksum } from '../lib/utils.mjs';
import { validateWorksOnlyEvidence } from '../lib/works-only-observation.mjs';

// Deterministic synthetic failure fixture, not an invented successful platform sample.
const NOW = Date.parse('2026-10-01T07:03:34.707Z');
function unavailable() {
  return { version: 1, kind: 'works-only-observation', source: 'authorised-browser', targetId: 287, runId: 2208,
    anchorSnapshotId: 1001, anchorChecksum: 'a'.repeat(64), requestedLimit: 30,
    identity: { secUid: `MS4wLj${'a'.repeat(32)}`, uid: '12345678' },
    requestStartedAt: '2026-10-01T06:52:49.932Z', requestFinishedAt: '2026-10-01T06:53:18.763Z',
    observedAt: null, status: 'unavailable', coverage: 'unavailable', errorCode: 'collector_error', posts: [], pagination: null };
}
const invalid = evidence => assert.throws(() => validateWorksOnlyEvidence(evidence, { now: NOW }),
  error => error.code === 'WORKS_OBSERVATION_INVALID');

test('canonical failed work attempt preserves null observation and contains no profile counters', () => {
  const original = unavailable(); const hash = checksum(original);
  const canonical = validateWorksOnlyEvidence(original, { now: NOW });
  assert.deepEqual(canonical, original); assert.equal(checksum(canonical), hash);
  assert.equal(canonical.observedAt, null); assert.equal(canonical.status, 'unavailable');
  assert.equal(canonical.coverage, 'unavailable'); assert.equal(canonical.posts.length, 0);
  for (const key of ['followers', 'total_likes', 'total_posts', 'hashtag_views', 'hashtag_participants'])
    assert.equal(Object.hasOwn(canonical, key), false);
});

test('failed attempt cannot be relabelled as actual observed zero or complete works coverage', () => {
  invalid({ ...unavailable(), observedAt: '2026-10-01T06:53:18.763Z' });
  invalid({ ...unavailable(), coverage: 'complete' });
  invalid({ ...unavailable(), status: 'accepted', errorCode: null });
});

test('failed empty body cannot smuggle observed posts or profile values into canonical failure', () => {
  invalid({ ...unavailable(), posts: [{ aweme_id: '1234567890123456789', author: { sec_uid: `MS4wLj${'a'.repeat(32)}`, uid: '12345678' }, statistics: {} }] });
  invalid({ ...unavailable(), followers: 0 });
  invalid({ ...unavailable(), total_posts: 0 });
});

test('chronology rejects future end, reversed interval and an over-budget request', () => {
  invalid({ ...unavailable(), requestFinishedAt: '2026-10-01T07:03:34.708Z' });
  invalid({ ...unavailable(), requestFinishedAt: '2026-10-01T06:52:49.931Z' });
  invalid({ ...unavailable(), requestFinishedAt: '2026-10-01T06:53:34.933Z' });
  invalid({ ...unavailable(), requestStartedAt: '2026-10-01T06:52:49Z' });
});

test('stable identity, exact anchor and finite policy bounds cannot be coerced or inferred', () => {
  invalid({ ...unavailable(), targetId: '287' });
  invalid({ ...unavailable(), runId: 0 });
  invalid({ ...unavailable(), anchorChecksum: 'a'.repeat(63) });
  invalid({ ...unavailable(), identity: { secUid: 'nickname-only', uid: '12345678' } });
  invalid({ ...unavailable(), requestedLimit: 101 });
});

test('private and unknown appended fields are rejected rather than silently changing sealed source identity', () => {
  invalid({ ...unavailable(), cookie: 'synthetic-not-a-real-secret' });
  invalid({ ...unavailable(), sourceUrl: 'https://private.invalid/' });
  invalid({ ...unavailable(), failureStage: 'unrecognised-stage' });
});

test('legacy failure without optional diagnostics retains exact original canonical hash and input', () => {
  const original = Object.freeze({ ...unavailable(), identity: Object.freeze(unavailable().identity), posts: Object.freeze([]) });
  const before = JSON.stringify(original);
  const canonical = validateWorksOnlyEvidence(original, { now: NOW });
  assert.equal(JSON.stringify(canonical), before); assert.equal(JSON.stringify(original), before);
  assert.equal(Object.hasOwn(canonical, 'failureDiagnostics'), false);
  assert.equal(Object.hasOwn(canonical, 'failureStage'), false);
});

test('permitted optional fixed failure stage is explicit append-only evidence, not collection success', () => {
  const original = { ...unavailable(), failureStage: 'browser-page' };
  const canonical = validateWorksOnlyEvidence(original, { now: NOW });
  assert.equal(checksum(canonical), checksum(original)); assert.equal(canonical.failureStage, 'browser-page');
  assert.equal(canonical.status, 'unavailable'); assert.equal(canonical.observedAt, null);
});
