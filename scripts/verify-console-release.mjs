// Read-only production acceptance. No collection, account mutation or login.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { beijingToday, rangeFor, shiftDate } from '../public/console-model.js';

const output = process.argv[2];
const base = 'http://127.0.0.1:4188';
async function read(path) {
  const started = performance.now();
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(45000) });
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
  return { body: await response.json(), ms: Math.round(performance.now() - started) };
}
const result = { checkedAt: new Date().toISOString(), readOnly: true, periods: [] };
for (const period of ['day', 'week', 'month']) {
  const { body: data, ms } = await read(`/api/rebuild/insights?period=${period}`);
  const active = data.accounts.filter(account => account.enabled);
  assert.equal(data.summary.enabledCount, active.length);
  const metrics = {};
  for (const name of ['followers', 'likes', 'posts', 'estimatedPlays']) {
    const metric = data.summary.metrics[name];
    const known = active.map(account => account.metrics[name]?.value).filter(value => typeof value === 'number');
    const comparable = active.filter(account => account.metrics[name]?.comparable);
    assert.equal(metric.knownValue, known.length ? known.reduce((a, b) => a + b, 0) : null, `${period}/${name} known sum`);
    assert.equal(metric.knownCount, known.length);
    assert.equal(metric.comparableCount, comparable.length);
    assert.equal(metric.delta, comparable.length ? comparable.reduce((sum, account) => sum + account.metrics[name].delta, 0) : null);
    assert.equal(metric.fullPeriodComparableCount, comparable.length);
    for (const account of comparable) assert.equal(account.metrics[name].fullPeriodComparable, true);
    metrics[name] = { knownValue: metric.knownValue, knownCount: metric.knownCount, delta: metric.delta, comparableCount: metric.comparableCount };
  }
  const likes = metrics.likes.delta;
  assert.equal(metrics.estimatedPlays.delta, likes === null ? null : likes * 100);
  const coverage = data.summary.collectionCoverage;
  assert.equal(coverage.total, active.length);
  assert.equal(Object.values(coverage.works).reduce((sum, value) => sum + value, 0), active.length);
  result.periods.push({ period, range: data.range, ms, metrics, coverage });
}
// Today's collectors can commit between the three HTTP reads. Cross-period
// equality must use a closed Beijing day, not three different live cutoffs.
const closedDay = shiftDate(beijingToday(), -1);
result.closedDayPeriodConsistency = [];
for (const period of ['day', 'week', 'month']) {
  const { start, end } = rangeFor(period, closedDay);
  const { body: data } = await read(`/api/rebuild/insights?period=custom&startDate=${start}&endDate=${end}`);
  assert.equal(data.range.endDate, closedDay);
  result.closedDayPeriodConsistency.push({ period, startDate: start, endDate: end,
    knownValues: Object.fromEntries(Object.entries(data.summary.metrics).map(([name, metric]) => [name, metric.knownValue])) });
}
for (const name of ['followers', 'likes', 'posts', 'estimatedPlays']) {
  assert.equal(new Set(result.closedDayPeriodConsistency.map(period => period.knownValues[name])).size, 1, 'changing start day must not change a closed end-day known total');
}
const { body: continuity } = await read('/api/continuity');
result.continuity = { running: continuity.running, schedulerReady: continuity.schedulerReady, nextRunBeijing: continuity.nextRunBeijing, backup: continuity.backup?.status };
assert.equal(continuity.schedulerReady, true);
const benchmarkPath = `/api/rebuild/insights?period=custom&startDate=${shiftDate(closedDay, -1)}&endDate=${closedDay}`;
const parallel = await Promise.all(Array.from({ length: 8 }, () => read(benchmarkPath)));
const signatures = new Set(parallel.map(item => JSON.stringify(item.body.summary.metrics)));
assert.equal(signatures.size, 1, 'concurrent readers must agree');
result.concurrentEightReads = { ms: parallel.map(item => item.ms), consistent: true };
result.health = await read('/healthz');
result.ok = true;
if (output) writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
