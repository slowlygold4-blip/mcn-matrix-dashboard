// Read-only production checks; no collection, settings update or history writes.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

const base = 'http://127.0.0.1:4188';
async function get(path) {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(30_000) });
  assert.equal(response.ok, true, `Read failed for ${path}`);
  return response.json();
}

const bootstrap = await get('/api/bootstrap');
const continuity = await get('/api/continuity');
const query = new URLSearchParams({
  board: '一条小团团切片矩阵', period: 'custom', startDate: '2026-09-09', endDate: '2026-09-13',
  comparisonStartDate: '2026-09-09', comparisonEndDate: '2026-09-12',
});
const insights = await get(`/api/insights?${query}`);
assert.equal(bootstrap.scheduler.timeZone, 'Asia/Shanghai');
assert.equal(bootstrap.scheduler.scheduleTime, '10:00');
assert.equal(continuity.timeZone, 'Asia/Shanghai');
assert.equal(insights.timeZone, 'Asia/Shanghai');
assert.equal(insights.start, '2026-09-08T16:00:00.000Z');
assert.equal(insights.comparison.end, '2026-09-12T15:59:59.999Z');
assert.equal(insights.range.endDate, '2026-09-13');
assert.equal(insights.comparison.range.endDate, '2026-09-12');
for (const period of [insights, insights.comparison]) {
  assert.equal(period.summary.publishedSamples.asOf, period.end);
  assert.equal(period.summary.publishedSamples.basis, 'published_at');
  assert.equal(period.summary.publishedSamples.asOfBasis, 'first_seen_at');
  const { likes, estimatedPlays } = period.summary.metrics;
  assert.equal(estimatedPlays.value, likes.value === null ? null : likes.value * 100);
  assert.equal(estimatedPlays.delta, likes.delta === null ? null : likes.delta * 100);
}
const nextRun = new Date(bootstrap.scheduler.nextRunAt);
const nextTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(nextRun);
assert.equal(nextTime, '10:00');
for (const metric of Object.values(continuity.freshness.metrics)) {
  assert.equal(metric.freshCount + metric.agingCount + metric.staleCount + metric.missingCount + metric.inactiveCount, metric.total);
}
// Release-time proof for the user's exact 1–31 versus 2–28 shape. These
// historical dates predate this board's observations; do not fabricate zeros.
const emptyHistoryQuery = new URLSearchParams({
  board: '一条小团团切片矩阵', period: 'custom', startDate: '2026-08-01', endDate: '2026-08-31',
  comparisonStartDate: '2026-08-02', comparisonEndDate: '2026-08-28',
});
const emptyHistory = await get(`/api/insights?${emptyHistoryQuery}`);
for (const [period, days] of [[emptyHistory, 31], [emptyHistory.comparison, 27]]) {
  assert.equal(period.range.days, days);
  assert.equal(period.summary.trend.length, days);
  for (const metric of Object.values(period.summary.metrics)) {
    assert.equal(metric.value, null);
    assert.equal(metric.delta, null);
    assert.equal(metric.comparableCount, 0);
  }
  for (const point of period.summary.trend) {
    for (const metric of ['followers', 'likes', 'posts', 'estimatedPlays']) {
      assert.equal(point[metric], null);
      assert.equal(point[`${metric}Delta`], null);
    }
  }
}
const result = {
  checkedAt: new Date().toISOString(), ok: true,
  scheduler: bootstrap.scheduler,
  nextRunBeijing: continuity.nextRunBeijing,
  historySemantics: { timeZone: insights.timeZone, range: insights.range, comparisonRange: insights.comparison.range,
    start: insights.start, end: insights.end, comparisonEnd: insights.comparison.end,
    publication: insights.summary.publishedSamples, estimatedPlaysMultiplier: 100 },
  freshness: continuity.freshness,
  emptyHistoryComparison: { range: emptyHistory.range, comparisonRange: emptyHistory.comparison.range,
    currentDays: emptyHistory.summary.trend.length, comparisonDays: emptyHistory.comparison.summary.trend.length,
    missingMetricsPreservedAsNull: true },
  caveat: '验证当前配置与已保存记录，不把切换日补采或测试时钟当成未来每天实际已执行的证明',
};
writeFileSync(new URL('../output/playwright/business-timezone-release.json', import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ checkedAt: result.checkedAt, ok: result.ok, nextRunBeijing: result.nextRunBeijing,
  targetCount: result.freshness.total, activeCount: result.freshness.activeCount,
  freshCount: result.freshness.metrics.followers.freshCount, scheduler: result.scheduler }));
