import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { periodWindow } from '../../mcn-public-site/lib/replica-periods.mjs';
import { rowsFor, aggregate, validDate } from '../../mcn-public-site/lib/replica-model.mjs';
import { growthSeries } from '../../mcn-public-site/lib/replica-trends.mjs';

const dir = new URL('../data/public-replica-staging/2026-10-01T01-31-30-128Z/', import.meta.url);
const read = path => JSON.parse(readFileSync(new URL(path, dir), 'utf8'));
const manifest = read('manifest.json'), catalog = read('catalog.json'), summary = read('summary.json');
const points = summary.items ?? summary.shards.flatMap(shard => read(shard.path).items);
const all = catalog.accounts.filter(account => account.enabled);
const tuantuan = all.filter(account => account.boardKeys.includes('一条小团团切片矩阵'));
const metricKeys = ['followers', 'likes', 'posts'];
const account = (id, enabled = true) => ({ id, label: `账号${id}`, enabled });
const point = (targetId, date, values = [10, 20, 3]) => ({ targetId, date,
  capturedAt: `${date}T01:00:00.000Z`,
  ...Object.fromEntries(metricKeys.flatMap((key, index) => [[key, values[index]], [key + 'At', values[index] === null ? null : `${date}T01:00:00.000Z`]])),
});
const range = window => window && ({ start: window.start, end: window.end });
const clone = value => structuredClone(value);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

// A deliberately simple independent endpoint oracle. It does not call any Site helper.
function independentMetrics(accounts, source, start, end) {
  const index = new Map(source.map(p => [`${p.targetId}/${p.date}`, p]));
  return Object.fromEntries(metricKeys.map(key => {
    let knownCount = 0, value = 0, comparableCount = 0, delta = 0;
    for (const a of accounts) {
      const b = index.get(`${a.id}/${start}`), e = index.get(`${a.id}/${end}`);
      if (e?.[key] != null) { knownCount++; value += e[key]; }
      if (b?.[key] != null && e?.[key] != null) { comparableCount++; delta += e[key] - b[key]; }
    }
    return [key, { value: knownCount ? value : null, delta: comparableCount ? delta : null, knownCount, comparableCount }];
  }));
}
function actual(accounts, start, end) { return aggregate(rowsFor(accounts, points, start, end)); }

test('frozen generation has actual October 1 observations and a preserved partial September 12 baseline', () => {
  assert.equal(manifest.asOf, '2026-10-01T01:31:30.130Z');
  assert.equal(all.length, 701); assert.equal(tuantuan.length, 276); assert.equal(points.length, 16_327);
  const baseline = points.filter(p => p.date === '2026-09-12' && all.some(a => a.id === p.targetId));
  assert.equal(baseline.length, 455);
  assert.deepEqual(metricKeys.map(k => baseline.filter(p => p[k] !== null).length), [455, 441, 455]);
  for (const [key, start] of [['day', '2026-09-30'], ['week', '2026-09-24'], ['month', '2026-09-30'], ['since', '2026-09-12']]) {
    const result = periodWindow(key, all, points, manifest.asOf);
    assert.deepEqual(range(result), { start, end: '2026-10-01' });
    assert.equal(result.anchor, '2026-10-01');
  }
});

test('all four frozen metrics match the independent account-by-account endpoint oracle', () => {
  const cases = [
    [all, '2026-09-30', '2026-10-01', [305_534, 2_700_057, 25], [697, 697, 697]],
    [all, '2026-09-24', '2026-10-01', [2_005_833, 31_302_659, 1_603], [696, 696, 696]],
    [all, '2026-09-12', '2026-10-01', [5_616_779, 75_134_871, 1_754], [454, 440, 454]],
    [all, '2026-09-12', '2026-09-30', [5_311_314, 72_440_551, 1_764], [454, 440, 454]],
    [tuantuan, '2026-09-30', '2026-10-01', [118, 18_693, -1], [275, 275, 275]],
    [tuantuan, '2026-09-24', '2026-10-01', [3_209, 391_114, 1_032], [275, 275, 275]],
    [tuantuan, '2026-09-12', '2026-10-01', [7_917, 555_333, 832], [68, 68, 68]],
    [tuantuan, '2026-09-12', '2026-09-30', [7_871, 540_797, 867], [68, 68, 68]],
  ];
  for (const [accounts, start, end, deltas, counts] of cases) {
    const oracle = independentMetrics(accounts, points, start, end), result = actual(accounts, start, end);
    assert.deepEqual(result, oracle);
    assert.deepEqual(metricKeys.map(k => result[k].delta), deltas);
    assert.deepEqual(metricKeys.map(k => result[k].comparableCount), counts);
    assert.equal(result.likes.delta * 100, deltas[1] * 100);
  }
});

test('weekly change spans seven elapsed calendar days and retains eight positions including the real gap', () => {
  const window = periodWindow('week', all, points, manifest.asOf);
  const result = growthSeries(all, points, window);
  assert.equal((Date.parse(window.end) - Date.parse(window.start)) / 86_400_000, 7);
  assert.equal(result.points.length, 8); assert.equal(result.cohortCount, 696);
  assert.deepEqual(result.points.map(p => p.current), [0, 270_787, 433_438, null, 1_125_811, 1_368_401, 1_700_298, 2_005_833]);
  assert.equal(result.points[3].currentDate, '2026-09-27'); assert.equal(result.points[3].currentKnown, 687);
  const group = growthSeries(tuantuan, points, window);
  assert.equal(group.cohortCount, 275); assert.equal(group.points[3].current, null); assert.equal(group.points[3].currentKnown, 272);
});

test('high-coverage observed window is an explicit alternative and leaves September 12 requested facts intact', () => {
  const before = actual(all, '2026-09-12', '2026-10-01');
  const observed = periodWindow('observed', all, points, manifest.asOf);
  assert.deepEqual(range(observed), { start: '2026-09-14', end: '2026-10-01' });
  assert.match(observed.note, /不(?:等于|是)完整.*9.?12/);
  const alternative = actual(all, observed.start, observed.end);
  assert.equal(alternative.followers.comparableCount, 697); assert.equal(alternative.followers.delta, 4_148_523);
  assert.equal(alternative.likes.delta, 67_529_115); assert.equal(alternative.posts.delta, 3_951);
  assert.deepEqual(actual(all, '2026-09-12', '2026-10-01'), before);
  assert.equal(before.followers.comparableCount, 454); assert.equal(before.likes.comparableCount, 440);
});

test('observed fallback remains within the business boundary and does not fabricate full metric coverage', () => {
  const accounts = [account(1), account(2)];
  const source = [point(1, '2026-09-01'), point(2, '2026-09-01'), point(1, '2026-09-12', [10, null, 3])];
  const window = periodWindow('observed', accounts, source, '2026-10-01T09:00:00.000Z');
  assert.deepEqual(range(window), { start: '2026-09-12', end: '2026-09-12' });
  const result = aggregate(rowsFor(accounts, source, window.start, window.end));
  assert.equal(result.followers.delta, 0); assert.equal(result.followers.comparableCount, 1);
  assert.equal(result.likes.delta, null); assert.equal(result.likes.comparableCount, 0);
  // Ninety percent at each endpoint need not mean a ninety-percent intersection.
  const roster = Array.from({ length: 10 }, (_, i) => account(i + 1));
  const rotating = [...roster.slice(0, 9).map(a => point(a.id, '2026-09-24')), ...roster.slice(1).map(a => point(a.id, '2026-10-01'))];
  const chosen = periodWindow('observed', roster, rotating, '2026-10-01T09:00:00.000Z');
  assert.deepEqual(range(chosen), { start: '2026-09-24', end: '2026-10-01' });
  assert.equal(aggregate(rowsFor(roster, rotating, chosen.start, chosen.end)).followers.comparableCount, 8);
});

test('interval comparison uses the same four-endpoint cohort and does not reuse the broader single-window card', () => {
  const options = { start: '2026-09-14', end: '2026-10-01', otherStart: '2026-09-24', otherEnd: '2026-10-01' };
  const follower = growthSeries(all, points, options);
  const like = growthSeries(all, points, { ...options, metric: 'likes' });
  const estimate = growthSeries(all, points, { ...options, metric: 'estimated' });
  assert.equal(follower.cohortCount, 696);
  assert.equal(follower.points.at(-1).current, 4_148_524);
  assert.equal(like.points.at(-1).current, 67_529_104);
  assert.equal(estimate.points.at(-1).current, 6_752_910_400);
  assert.equal(follower.points[7].comparison, 2_005_833);
  assert.equal(follower.points[8].comparisonDate, null); assert.equal(follower.points[8].comparison, null);
  assert.equal(actual(all, options.start, options.end).followers.delta, 4_148_523);
});

test('month baseline includes October 1 saved change and the September business clip is explicit', () => {
  const current = periodWindow('month', all, points, manifest.asOf);
  assert.deepEqual(range(current), { start: '2026-09-30', end: '2026-10-01' });
  assert.equal(current.clipped, false);
  const september = points.filter(p => p.date < '2026-10-01');
  const prior = periodWindow('month', all, september, '2026-09-30T15:00:00.000Z');
  assert.deepEqual(range(prior), { start: '2026-09-12', end: '2026-09-30' });
  assert.equal(prior.clipped, true);
  assert.match(prior.note, /9.?12|2026-09-12/); assert.match(prior.note, /月初|不覆盖9\/1/);
});

test('month uses the fixed generation calendar month and retains a genuinely missing current-month endpoint', () => {
  const accounts = [account(1)], source = [point(1, '2026-09-29')];
  const result = periodWindow('month', accounts, source, '2026-10-05T01:00:00.000Z');
  assert.deepEqual(range(result), { start: '2026-09-30', end: '2026-10-05' });
  assert.equal(result.anchor, '2026-09-29'); assert.equal(result.clipped, false);
  const metrics = aggregate(rowsFor(accounts, source, result.start, result.end));
  for (const key of metricKeys) { assert.equal(metrics[key].delta, null); assert.equal(metrics[key].comparableCount, 0); }
  // The calendar date is Beijing October 1 although UTC still says September 30.
  const boundary = periodWindow('month', accounts, source, '2026-09-30T16:01:00.000Z');
  assert.deepEqual(range(boundary), { start: '2026-09-30', end: '2026-10-01' });
});

test('saved scope observation rather than wall clock or publication date anchors the presets', () => {
  const accounts = [account(1), account(2), account(3, false)];
  const source = [point(1, '2026-09-29'), point(2, '2026-10-01'), point(3, '2026-10-02')];
  const asOf = '2026-10-05T01:00:00.000Z';
  assert.deepEqual(range(periodWindow('day', [accounts[0]], source, asOf)), { start: '2026-09-28', end: '2026-09-29' });
  assert.deepEqual(range(periodWindow('week', accounts, source, asOf)), { start: '2026-09-24', end: '2026-10-01' });
});

test('a missing adjacent natural day remains missing and is not replaced by the previous saved day', () => {
  const accounts = [account(1)], source = [point(1, '2026-09-17'), point(1, '2026-09-20')];
  const result = periodWindow('day', accounts, source, '2026-09-21T01:00:00.000Z');
  assert.deepEqual(range(result), { start: '2026-09-19', end: '2026-09-20' });
  const metrics = aggregate(rowsFor(accounts, source, result.start, result.end));
  assert.equal(metrics.followers.delta, null); assert.equal(metrics.followers.comparableCount, 0);
});

test('null-only records do not advance the latest real observation', () => {
  const source = [point(1, '2026-10-01'), point(1, '2026-10-02', [null, null, null])];
  assert.equal(periodWindow('day', [account(1)], source, '2026-10-03T01:00:00.000Z').end, '2026-10-01');
});

test('empty, paused-only and all-null scopes return no fabricated wall-clock window', () => {
  const asOf = '2026-10-03T01:00:00.000Z';
  for (const key of ['day', 'week', 'month', 'since', 'observed']) {
    for (const [accounts, source] of [
      [[], [point(1, '2026-10-01')]], [[account(1, false)], [point(1, '2026-10-01')]],
      [[account(1)], [point(1, '2026-10-02', [null, null, null])]], [[account(1)], []],
    ]) {
      const result = periodWindow(key, accounts, source, asOf);
      assert.deepEqual(range(result), { start: null, end: null }); assert.equal(result.anchor, null);
      assert.match(result.note, /暂无|没有|缺测/);
    }
  }
});

test('calendar subtraction handles leap days and year boundaries', () => {
  for (const [key, end, start] of [
    ['day', '2028-03-01', '2028-02-29'], ['week', '2028-03-01', '2028-02-23'],
    ['month', '2028-03-05', '2028-02-29'], ['week', '2027-01-03', '2026-12-27'],
    ['month', '2027-01-01', '2026-12-31'],
  ]) assert.deepEqual(range(periodWindow(key, [account(1)], [point(1, end)], `${end}T09:00:00.000Z`)), { start, end });
});

test('invalid calendar dates and reversed custom intervals are rejected, actual missing dates are allowed', () => {
  for (const date of ['', '2026-02-29', '2026-02-30', '2026-13-01', '2026-09-2', '2026-09-12T00:00:00Z']) assert.equal(validDate(date), false);
  assert.equal(validDate('2028-02-29'), true);
  assert.throws(() => rowsFor(all, points, '2026-10-01', '2026-09-12'));
  const missing = actual(all, '2026-09-18', '2026-09-19');
  for (const key of metricKeys) assert.deepEqual(missing[key], { value: null, delta: null, knownCount: 0, comparableCount: 0 });
  assert.equal(growthSeries([], [], { start: '2026-01-01', end: '2027-01-01' }).points.length, 366);
  assert.throws(() => growthSeries([], [], { start: '2028-01-01', end: '2029-01-01' }), /366/);
});

test('same real endpoint is zero, while absent endpoints stay null and different metric cohorts stay separate', () => {
  const source = [point(1, '2026-09-12', [10, null, 3]), point(1, '2026-10-01', [7, 20, 2]), point(2, '2026-10-01', [0, 0, 0])];
  const accounts = [account(1), account(2)];
  const changed = aggregate(rowsFor(accounts, source, '2026-09-12', '2026-10-01'));
  assert.equal(changed.followers.delta, -3); assert.equal(changed.posts.delta, -1); assert.equal(changed.likes.delta, null);
  assert.deepEqual([changed.followers.comparableCount, changed.likes.comparableCount, changed.posts.comparableCount], [1, 0, 1]);
  const same = aggregate(rowsFor(accounts, source, '2026-10-01', '2026-10-01'));
  for (const key of metricKeys) { assert.equal(same[key].delta, 0); assert.equal(same[key].comparableCount, 2); }
  const future = aggregate(rowsFor(accounts, source, '2026-10-01', '2026-10-02'));
  for (const key of metricKeys) { assert.equal(future[key].delta, null); assert.equal(future[key].knownCount, 0); }
});

test('period candidates reject malformed source days, source times and duplicate account/date identities', () => {
  const accounts = [account(1)], source = [point(1, '2026-10-01')], asOf = '2026-10-02T01:00:00.000Z';
  const invalid = [
    { ...source[0], date: '2026-02-30' },
    { ...source[0], capturedAt: '2026-10-01T01:00:00Z' },
    { ...source[0], followersAt: '2026-09-30T01:00:00.000Z' },
    { ...source[0], followersAt: '2026-10-01T02:00:00.000Z' },
    { ...source[0], capturedAt: '2026-10-03T01:00:00.000Z' },
    { ...source[0], targetId: 1.5 }, { ...source[0], followers: -1 },
  ];
  for (const bad of invalid) assert.throws(() => periodWindow('day', accounts, [bad], asOf));
  assert.throws(() => periodWindow('day', [account(1), account(1)], source, asOf));
  assert.throws(() => periodWindow('day', accounts, [source[0], clone(source[0])], asOf));
  assert.throws(() => periodWindow('unknown', accounts, source, asOf));
  assert.throws(() => periodWindow('day', accounts, source, '2026-10-02T01:00:00Z'));
});

test('presets and read models do not mutate caller-owned frozen data or period options', () => {
  const accounts = freeze([account(1)]), source = freeze([point(1, '2026-09-24'), point(1, '2026-10-01', [8, 25, 2])]);
  const before = JSON.stringify([accounts, source]);
  const window = freeze(periodWindow('week', accounts, source, '2026-10-01T09:00:00.000Z'));
  const series = growthSeries(accounts, source, window);
  assert.equal(series.points.length, 8); assert.equal(series.points.at(-1).current, -2);
  assert.equal(JSON.stringify([accounts, source]), before);
});
