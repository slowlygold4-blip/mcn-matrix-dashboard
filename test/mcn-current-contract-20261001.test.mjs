import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as model from '../public/console-model.js';
import { beijingCollectionSlot } from '../lib/collection-cadence.mjs';

// Entirely synthetic objects: no database, browser, server or platform request.
const keys = Object.keys(model.METRICS);
const baselineAt = '2026-09-14T02:00:00.000Z';
const currentAt = '2026-09-30T18:00:00.000Z';
const freeze = value => {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
};
function fixture(strictDelta = 2) {
  const metrics = (delta, comparable) => Object.fromEntries(keys.map(key => {
    const multiplier = key === 'estimatedPlays' ? 100 : 1;
    return [key, { value: 110 * multiplier, baseline: comparable ? 100 * multiplier : null,
      delta: comparable ? delta * multiplier : null, comparable, fullPeriodComparable: comparable,
      dailyComparable: false, baselineAt: comparable ? baselineAt : null, currentAt,
      comparisonCurrentAt: currentAt }];
  }));
  const accounts = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, label: `synthetic-${i + 1}`,
    enabled: true, metrics: metrics(strictDelta / 2, i < 2) }));
  const windowAccounts = accounts.map((account, i) => ({ ...account, metrics: metrics(10, i < 9) }));
  const range = { startDate: '2026-09-12', endDate: '2026-10-01',
    start: '2026-09-11T16:00:00.000Z', end: '2026-10-01T00:00:00.000Z' };
  const aggregate = Object.fromEntries(keys.map(key => {
    const multiplier = key === 'estimatedPlays' ? 100 : 1;
    return [key, { value: 990 * multiplier, baseline: 900 * multiplier, delta: 90 * multiplier,
      deltaReliable: true, comparableCount: 9, fullPeriodComparableCount: 9, deltaCohortKey: 'a'.repeat(64),
      valueCohortKey: 'a'.repeat(64), knownCohortKey: 'a'.repeat(64) }];
  }));
  return { period: 'custom', range, accounts, boards: [], summary: { enabledCount: 10,
    metrics: Object.fromEntries(keys.map(key => [key, { value: 1100, delta: strictDelta * (key === 'estimatedPlays' ? 100 : 1), comparableCount: 2 }])) },
    recordedWindow: { baselineDate: '2026-09-14', endDate: '2026-10-01', enabledCount: 10, comparableCount: 9,
      range: { startDate: '2026-09-15', endDate: '2026-10-01', end: range.end },
      accounts: windowAccounts, boards: [], metrics: aggregate } };
}
const alternative = (data, options = { period: 'since' }) => {
  assert.equal(typeof model.buildRecordedWindowAlternative, 'function', 'new independent preview contract must exist');
  return model.buildRecordedWindowAlternative(data, options);
};

for (const delta of [2, 0, -2]) test(`peer: strict since ${delta} remains untouched while higher-coverage window is separate`, () => {
  const raw = freeze(fixture(delta)), before = structuredClone(raw);
  const preview = alternative(raw);
  assert.ok(preview);
  assert.equal(preview.baselineDate, '2026-09-14');
  assert.equal(preview.endDate, '2026-10-01');
  assert.equal(preview.comparableCount, 9);
  assert.equal(preview.enabledCount, 10);
  assert.equal(preview.metrics.followers.delta, 90);
  assert.equal(preview.metrics.estimatedPlays.delta, preview.metrics.likes.delta * 100);
  assert.deepEqual(preview.requestedRange, { startDate: raw.range.startDate, endDate: raw.range.endDate });
  assert.deepEqual(raw, before, 'preview must not mutate summary, accounts, dates or export source');
  assert.equal(model.projectRecordedWindow(raw, { period: 'since' }), raw, 'strict projection still retains observed result including zero');
  assert.equal(raw.activeRecordedWindow, undefined);
});

test('peer: independent preview is available on presets, but rejects comparison, active window and exact custom/day scopes', () => {
  for (const period of ['day', 'custom']) assert.equal(alternative(fixture(), { period }), null);
  for (const period of ['week', 'month', '30d']) assert.ok(alternative(fixture(), { period }));
  assert.equal(alternative(fixture(), { period: 'since', compare: true }), null);
  for (const key of ['comparison', 'activeRecordedWindow']) { const raw = fixture(); raw[key] = {}; assert.equal(alternative(raw), null); }
  const raw = fixture(); for (const key of keys) raw.summary.metrics[key].delta = null;
  assert.ok(alternative(raw, { period: 'week' }), 'missing strict results should not hide a stronger independently verified window');
});

test('peer: future or malformed endpoint evidence cannot enter the independent preview', () => {
  for (const field of ['currentAt', 'comparisonCurrentAt', 'baselineAt']) {
    for (const value of ['2026-10-01T00:00:00.001Z', 'not-a-date']) {
      const raw = fixture(); raw.recordedWindow.accounts[0].metrics.followers[field] = value;
      assert.equal(alternative(raw), null, `${field} ${value}`);
    }
  }
  const raw = fixture(); raw.recordedWindow.range.end = '2026-10-01T00:00:00.001Z';
  assert.equal(alternative(raw), null);
});

test('peer: low coverage, non-improving coverage and mixed metric cohort are rejected', () => {
  const low = fixture(); low.recordedWindow.comparableCount = 8;
  for (const key of keys) low.recordedWindow.metrics[key].comparableCount = 8;
  assert.equal(alternative(low), null);
  const equal = fixture(); equal.summary.metrics.posts.comparableCount = 9;
  assert.equal(alternative(equal), null, 'window must improve coverage over every strict metric, not only followers');
  const mixed = fixture(); mixed.recordedWindow.metrics.posts.deltaCohortKey = 'different-cohort';
  assert.equal(alternative(mixed), null);
  const unreliable = fixture(); unreliable.recordedWindow.metrics.likes.deltaReliable = false;
  assert.equal(alternative(unreliable), null);
});

test('peer: foreign and duplicate IDs cannot substitute the selected enabled account population', () => {
  const foreign = fixture(); foreign.recordedWindow.accounts[0].id = 999;
  assert.equal(alternative(foreign), null);
  const duplicate = fixture(); duplicate.recordedWindow.accounts[1].id = duplicate.recordedWindow.accounts[0].id;
  assert.equal(alternative(duplicate), null);
  const missing = fixture(); missing.recordedWindow.accounts.pop();
  assert.equal(alternative(missing), null);
});

test('peer: a current cohort cannot claim other Beijing baseline or end dates, even before cutoff', () => {
  for (const [field, value] of [['baselineAt', '2026-09-13T02:00:00.000Z'],
    ['comparisonCurrentAt', '2026-09-29T18:00:00.000Z'], ['currentAt', '2026-09-29T18:00:00.000Z'],
    ['baselineAt', null], ['comparisonCurrentAt', null], ['currentAt', null]]) {
    const raw = fixture(); raw.recordedWindow.accounts[0].metrics.posts[field] = value;
    assert.equal(alternative(raw), null, `${field}: ${value} must not borrow a different date or omit endpoint evidence`);
  }
});

test('peer: valid independent per-metric times within the same Beijing day are allowed', () => {
  const raw = fixture(); raw.recordedWindow.accounts[0].metrics.posts.currentAt = '2026-09-30T19:00:00.000Z';
  raw.recordedWindow.accounts[0].metrics.posts.comparisonCurrentAt = '2026-09-30T19:00:00.000Z';
  assert.ok(alternative(raw), 'latest complete metrics need not have identical UTC instants');
});

test('peer: Beijing MCN day, rolling-week, month and fixed-business dates stay explicit', () => {
  assert.deepEqual(model.rangeFor('day', '2026-10-01'), { start: '2026-10-01', end: '2026-10-01' });
  assert.deepEqual(model.rangeFor('week', '2026-10-01'), { start: '2026-09-25', end: '2026-10-01' });
  assert.deepEqual(model.rangeFor('month', '2026-10-01'), { start: '2026-10-01', end: '2026-10-01' });
  assert.deepEqual(model.rangeFor('since', '2026-10-01'), { start: '2026-09-12', end: '2026-10-01' });
});

test('peer: automatic slots are Beijing 02/10/18 and source records no runtime AI', () => {
  for (const instant of ['2026-09-30T18:00:00Z', '2026-10-01T02:00:00Z', '2026-10-01T10:00:00Z']) {
    const slot = beijingCollectionSlot({ now: instant });
    assert.deepEqual(slot.slotTimes, ['02:00', '10:00', '18:00']);
    assert.equal(slot.startsAt, new Date(instant).toISOString());
  }
  const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(server, /scheduleIntervalHours:\s*8/);
  assert.match(server, /scheduleTimeZone:\s*["']Asia\/Shanghai["']/);
  assert.match(server, /runtimeAI:\s*false/);
});

test('peer: topic participants and platform views render as independent observed fields, never proxy plays', () => {
  const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8');
  const renderer = source.slice(source.indexOf('function renderTopicsData'), source.indexOf('async function loadTopics'));
  assert.match(renderer, /metric\('participants',\s*'参与人数'\)/);
  assert.match(renderer, /metric\('views',\s*'累计实际播放量'\)/);
  assert.doesNotMatch(renderer, /estimatedPlays|\*\s*100/);
});
