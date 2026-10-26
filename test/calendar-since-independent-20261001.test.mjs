import test from 'node:test';
import assert from 'node:assert/strict';
import { projectRecordedWindow, recordedWindowCaption, rangeFor } from '../public/console-model.js';

const keys = ['followers', 'likes', 'posts', 'estimatedPlays'];
function fixture(delta = 10) {
  const metrics = Object.fromEntries(keys.map(key => [key, { value: 100, knownValue: 100, delta,
    comparableCount: 2, fullPeriodComparableCount: 2, deltaReliable: true }]));
  const observed = { value: 100, delta, comparable: true, fullPeriodComparable: true,
    baselineAt: '2026-09-14T02:00:00.000Z', currentAt: '2026-09-30T02:00:00.000Z' };
  const requested = { startDate: '2026-09-12', endDate: '2026-10-01', end: '2026-09-30T17:40:00.000Z' };
  return { period: 'custom', range: requested,
    summary: { enabledCount: 2, metrics: Object.fromEntries(keys.map(key => [key, { value: null, knownValue: 100, delta: null }])),
      trend: [{ date: '2026-10-01', followers: null, followersDelta: null, missing: true }] },
    accounts: [1, 2].map(id => ({ id, enabled: true, metrics: Object.fromEntries(keys.map(key => [key, { value: 100, delta: null }])) })),
    boards: [], recordedWindow: { baselineDate: '2026-09-14', endDate: '2026-09-30', enabledCount: 2, comparableCount: 2,
      range: { startDate: '2026-09-15', endDate: '2026-09-30', end: '2026-09-30T15:59:59.999Z' },
      metrics, accounts: [1, 2].map(id => ({ id, metrics: Object.fromEntries(keys.map(key => [key, { ...observed }])) })), boards: [] } };
}

test('since exposes the actual common observed span while preserving 9/12 selection and today missingness', () => {
  const raw = fixture(), strict = structuredClone(raw);
  const projected = projectRecordedWindow(raw, { period: 'since' });
  assert.equal(projected.activeRecordedWindow, raw.recordedWindow, 'the span comes from the server verified common window');
  assert.equal(projected.requestedRange.startDate, '2026-09-12');
  assert.equal(projected.range, raw.range);
  assert.equal(projected.effectiveMetricRange.startDate, '2026-09-15');
  assert.equal(projected.activeRecordedWindow.baselineDate, '2026-09-14');
  assert.equal(projected.effectiveMetricRange.endDate, '2026-09-30');
  assert.equal(projected.summary.metrics.followers.delta, 10);
  assert.equal(projected.summary.trend.at(-1).followersDelta, null);
  assert.match(recordedWindowCaption(projected), /2026-09-14 采样 → 2026-09-30 采样/);
  assert.match(recordedWindowCaption(projected), /所选 2026-09-12 至 2026-10-01 完整区间数据尚不齐全/);
  assert.deepEqual(raw, strict, 'presentation never rewrites the strict source response');
  assert.deepEqual(rangeFor('since', '2026-10-01'), { start: '2026-09-12', end: '2026-10-01' });
});

test('since keeps null when no trustworthy common cohort exists and retains explicit observed zero', () => {
  const empty = fixture(); empty.recordedWindow = null;
  assert.equal(projectRecordedWindow(empty, { period: 'since' }), empty);
  assert.equal(empty.summary.metrics.followers.delta, null);
  for (const mutate of [
    raw => { raw.recordedWindow.comparableCount = 1; },
    raw => { raw.recordedWindow.metrics.likes.deltaReliable = false; },
    raw => { raw.recordedWindow.metrics.likes.delta = null; },
    raw => { raw.recordedWindow.metrics.likes.comparableCount = 1; },
  ]) {
    const raw = fixture(); mutate(raw);
    assert.equal(projectRecordedWindow(raw, { period: 'since' }), raw);
  }
  const zero = projectRecordedWindow(fixture(0), { period: 'since' });
  assert.equal(zero.summary.metrics.followers.delta, 0);
});

test('since rejects evidence outside the requested dates, future observations and invalid time values', () => {
  for (const mutate of [
    raw => { raw.recordedWindow.baselineDate = '2026-09-10'; raw.recordedWindow.range.startDate = '2026-09-11'; },
    raw => { raw.recordedWindow.endDate = '2026-10-02'; raw.recordedWindow.range.endDate = '2026-10-02'; },
    raw => { raw.recordedWindow.range.end = '2026-09-30T18:00:00.000Z'; },
    raw => { raw.recordedWindow.accounts[0].metrics.followers.currentAt = '2026-10-01T02:00:00.000Z'; },
    raw => { raw.recordedWindow.accounts[0].metrics.followers.baselineAt = 'invalid'; },
  ]) {
    const raw = fixture(); mutate(raw);
    assert.equal(projectRecordedWindow(raw, { period: 'since' }), raw);
    assert.equal(raw.summary.metrics.followers.delta, null);
  }
});

test('day and custom periods and since comparisons continue to require the requested endpoints', () => {
  const raw = fixture();
  for (const period of ['day', 'custom']) assert.equal(projectRecordedWindow(raw, { period }), raw);
  assert.equal(projectRecordedWindow(raw, { period: 'since', compare: true }), raw);
  const compared = { ...raw, comparison: {} };
  assert.equal(projectRecordedWindow(compared, { period: 'since' }), compared);
});

test('since never replaces a real fixed-period result, including partial, zero or negative growth', () => {
  for (const key of keys) for (const delta of [60, 0, -4]) {
    const raw = fixture();
    raw.summary.metrics[key] = { ...raw.summary.metrics[key], delta, comparableCount: 1 };
    const before = structuredClone(raw);
    assert.equal(projectRecordedWindow(raw, { period: 'since' }), raw);
    assert.deepEqual(raw, before);
  }
});
