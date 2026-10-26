import test from 'node:test';
import assert from 'node:assert/strict';
import { describeWorksObservation, aggregateWorksObservations } from '../lib/works-observation.mjs';
import { accountCollectionCoverage } from '../lib/collection-coverage.mjs';

const capturedAt = '2026-09-25T02:00:00.000Z';
function row({ id = 1, sampleCount = 4, inventory = 22, coverage = 'complete', captured_at = capturedAt, stop_reason = null } = {}) {
  return { id, captured_at, total_posts: inventory, works_coverage: coverage,
    list_type: 'array', list_count: sampleCount, stop_reason,
    source_checksum: 'a'.repeat(64),
    entries_json: JSON.stringify(Array.from({ length: sampleCount }, (_, index) => ({
      id: String(7000000000000000000n + BigInt(index)), publishedAt: '2026-09-20T02:00:00Z',
    }))) };
}

test('claimed complete samples smaller than same-snapshot inventory are limited in the read model', () => {
  for (const [sampleCount, inventory] of [[4, 22], [10, 90], [30, 2316], [0, 12]]) {
    const original = row({ sampleCount, inventory, stop_reason: 'end-of-list' });
    const before = structuredClone(original);
    const result = describeWorksObservation([original], capturedAt);
    assert.equal(result.coverage, 'limited');
    assert.equal(result.sampleCount, sampleCount);
    assert.equal(result.observedAt, capturedAt);
    assert.equal(result.carriedForward, false);
    assert.deepEqual(result.integrity, {
      key: 'partial-inventory', reportedCoverage: 'complete', inventory, sampleCount,
      reason: `本次返回 ${sampleCount} 条作品，少于同次主页作品总量 ${inventory}；只能确认部分作品覆盖`,
    });
    assert.match(result.reason, /只能确认部分作品覆盖/);
    assert.equal(result.stopReason, 'end-of-list', 'upstream stopReason stays unchanged, even when the claim is inconsistent');
    assert.deepEqual(original, before, 'raw row and inventory must not be rewritten');
  }
});

test('equal inventories and explicit empty zero inventories remain complete', () => {
  for (const sampleCount of [0, 4, 30]) {
    const result = describeWorksObservation([row({ sampleCount, inventory: sampleCount })], capturedAt);
    assert.equal(result.coverage, 'complete');
    assert.equal(result.integrity, null);
    assert.equal(result.sampleCount, sampleCount);
  }
});

test('unknown inventory does not fabricate a partial-inventory contradiction', () => {
  const result = describeWorksObservation([row({ sampleCount: 4, inventory: null })], capturedAt);
  assert.equal(result.coverage, 'complete');
  assert.equal(result.integrity, null);
});

test('xiaohongshu 16–40 character hex IDs retain a verified sample fingerprint', () => {
  const example = row({ sampleCount: 2, inventory: 2 });
  example.entries_json = JSON.stringify([
    { id: 'AbCd1234AbCd1234AbCd', publishedAt: '2026-09-20T02:00:00Z' },
    { id: 'a'.repeat(24), publishedAt: '2026-09-21T02:00:00Z' },
  ]);
  const later = { ...example, id: 2, captured_at: '2026-09-25T03:00:00.000Z', total_posts: 3 };
  assert.equal(describeWorksObservation([later, example], later.captured_at).signal?.key, 'inventory-changed-window-unchanged');
});

test('failed latest collection retains earlier samples without becoming limited or complete', () => {
  const failed = { ...row({ id: 2, coverage: 'retry' }), list_type: null, list_count: null, entries_json: null, stop_reason: 'request-failed' };
  const earlier = row({ id: 1, sampleCount: 4, inventory: 22, captured_at: '2026-09-24T02:00:00.000Z' });
  const result = describeWorksObservation([failed, earlier], capturedAt);
  assert.equal(result.coverage, 'retry');
  assert.equal(result.carriedForward, true);
  assert.equal(result.observedAt, earlier.captured_at);
  assert.equal(result.lastAttemptAt, capturedAt);
  assert.equal(result.sampleCount, 4);
  assert.equal(result.integrity, null);
  assert.equal(result.stopReason, 'request-failed');
  assert.match(result.reason, /保留较早样本/);
});

test('inventory correction feeds aggregate and daily coverage without claiming complete works', () => {
  const partial = describeWorksObservation([row()], capturedAt);
  const complete = describeWorksObservation([row({ sampleCount: 4, inventory: 4 })], capturedAt);
  const accounts = [{ enabled: true, worksObservation: partial }, { enabled: true, worksObservation: complete }];
  const summary = aggregateWorksObservations(accounts, capturedAt);
  assert.equal(summary.completeCount, 1);
  assert.equal(summary.limitedCount, 1);
  assert.equal(accountCollectionCoverage(accounts[0], '2026-09-25').worksState, 'limited');
  assert.equal(accountCollectionCoverage(accounts[1], '2026-09-25').worksState, 'complete');
});
