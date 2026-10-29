import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecordedWindowAlternative, projectRecordedWindow } from '../public/console-model.js';
const keys = ['followers', 'likes', 'posts', 'estimatedPlays'];
function fixture() {
  const deltas = { followers: 2, likes: 3, posts: -1, estimatedPlays: 300 };
  const accounts = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, enabled: true,
    metrics: Object.fromEntries(keys.map(key => [key, { comparable: i < 2, delta: i < 2 ? deltas[key] : null }])) }));
  return { period: 'custom', range: { startDate: '2026-09-12', endDate: '2026-10-01', end: '2026-10-01T00:20:00Z' }, accounts,
    summary: { enabledCount: 10, metrics: Object.fromEntries(keys.map(key => [key, { comparableCount: 2, delta: deltas[key] * 2 }])) },
    recordedWindow: { baselineDate: '2026-09-14', endDate: '2026-10-01', enabledCount: 10, comparableCount: 9,
      range: { startDate: '2026-09-15', endDate: '2026-10-01', end: '2026-10-01T00:20:00Z' },
      metrics: Object.fromEntries(keys.map(key => [key, { delta: deltas[key] * 9, comparableCount: 9, deltaReliable: true, deltaCohortKey: 'a'.repeat(64) }])),
      accounts: accounts.map((a, i) => ({ id: a.id, metrics: Object.fromEntries(keys.map(key => [key, {
        delta: i < 9 ? deltas[key] : null, comparable: i < 9,
        baselineAt: '2026-09-14T02:00:00Z', currentAt: '2026-09-30T18:00:00Z', comparisonCurrentAt: '2026-09-30T18:00:00Z' }])) })) } };
}
test('alternative reveals a separate common cohort without replacing strict positive, zero or negative metrics', () => {
  for (const delta of [4, 0, -2]) {
    const data = fixture(); data.summary.metrics.followers.delta = delta;
    const before = structuredClone(data), result = buildRecordedWindowAlternative(data, { period: 'since' });
    assert.equal(result.comparableCount, 9); assert.equal(result.metrics.followers.delta, 18);
    assert.equal(result.metrics.posts.delta, -9); assert.equal(result.metrics.estimatedPlays.delta, 2700);
    assert.equal(projectRecordedWindow(data, { period: 'since' }), data);
    assert.deepEqual(data, before); assert.equal(data.summary.metrics.followers.delta, delta);
    result.metrics.followers.delta = 999; assert.equal(data.recordedWindow.metrics.followers.delta, 18);
  }
});
test('alternative rejects foreign, duplicate, mismatched or non-reconciled cohorts and proxy values', () => {
  for (const mutate of [
    d => { d.recordedWindow.accounts[0].id = 999; },
    d => { d.recordedWindow.accounts[0].id = 2; },
    d => { d.recordedWindow.accounts.pop(); },
    d => { d.recordedWindow.metrics.followers.delta++; },
    d => { d.recordedWindow.accounts[0].metrics.estimatedPlays.delta++; d.recordedWindow.metrics.estimatedPlays.delta++; },
    d => { d.recordedWindow.metrics.likes.deltaReliable = false; },
    d => { d.recordedWindow.metrics.likes.deltaCohortKey = 'b'.repeat(64); },
    d => { d.recordedWindow.accounts[9].metrics.posts.comparable = true; },
    d => { d.recordedWindow.comparableCount = 8; },
    d => { d.recordedWindow.enabledCount = 9; },
  ]) { const data = fixture(); mutate(data); assert.equal(buildRecordedWindowAlternative(data, { period: 'since' }), null); }
});
test('alternative rejects future dates, invalid timestamps, wrong baseline and comparison/custom/day contexts', () => {
  for (const mutate of [
    d => { d.recordedWindow.accounts[0].metrics.followers.currentAt = '2026-10-01T01:00:00Z'; },
    d => { d.recordedWindow.accounts[0].metrics.followers.baselineAt = 'invalid'; },
    d => { d.recordedWindow.range.end = '2026-10-01T01:00:00Z'; },
    d => { d.recordedWindow.baselineDate = '2026-09-10'; },
    d => { d.comparison = {}; },
    d => { d.activeRecordedWindow = d.recordedWindow; },
  ]) { const data = fixture(); mutate(data); assert.equal(buildRecordedWindowAlternative(data, { period: 'since' }), null); }
  const data = fixture(); for (const period of ['day', 'custom']) assert.equal(buildRecordedWindowAlternative(data, { period }), null);
  for (const period of ['week', 'month', '30d']) assert.ok(buildRecordedWindowAlternative(data, { period }));
  assert.equal(buildRecordedWindowAlternative(data, { period: 'since', compare: true }), null);
});
test('alternative offers no redundant window when strict coverage is already at least as broad', () => {
  const data = fixture();
  for (const key of keys) data.summary.metrics[key].comparableCount = 9;
  assert.equal(buildRecordedWindowAlternative(data, { period: 'since' }), null);
});
test('one broad strict metric does not hide the useful recorded window for other missing metrics', () => {
  const data = fixture(); data.summary.metrics.followers.comparableCount = 9;
  const before = structuredClone(data);
  assert.equal(buildRecordedWindowAlternative(data, { period: 'since' }).comparableCount, 9);
  assert.deepEqual(data, before);
});
test('fully missing strict metrics still reveal a separate accurate common window', () => {
  const data = fixture();
  for (const key of keys) data.summary.metrics[key] = { delta: null, comparableCount: 0 };
  for (const period of ['week', 'month', '30d']) {
    const before = structuredClone(data), result = buildRecordedWindowAlternative(data, { period });
    assert.equal(result.comparableCount, 9);
    assert.equal(result.metrics.followers.delta, 18);
    assert.deepEqual(data, before, 'alternative must not rewrite exact-period source data');
  }
});
