import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { getProductInsights } from '../lib/product-insights.mjs';

function fixture(t) {
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const target = database.createTarget({ type: 'account', label: '日期边界隔离样本', provider: 'manual', locator: 'fixture-day', metadata: { platform: 'douyin' } });
  database.db.prepare("UPDATE targets SET created_at=? WHERE id=?").run("2020-01-01T00:00:00.000Z", target.id);
  const add = (day, followers, likes = followers, posts = followers) => database.db.prepare(`INSERT INTO snapshots
    (target_id,captured_at,followers,total_likes,total_posts,quality_status,account_status,works_coverage,source_checksum)
    VALUES(?,?,?,?,?,'validated','available','unavailable',?)`).run(target.id, `${day}T02:00:00.000Z`, followers, likes, posts, `fixture-${day}`);
  const read = (extra = {}) => getProductInsights(database, { period: 'day', timeZone: 'Asia/Shanghai', reference: new Date('2026-09-29T07:00:00Z'), startDate: '2026-09-28', endDate: '2026-09-28', ...extra });
  return { database, target, add, read };
}

test('explicit single Beijing day preserves daily semantics and 30-day trend after midnight', t => {
  const f = fixture(t); f.add('2026-09-27', 100, 200, 10); f.add('2026-09-28', 90, 210, 9); f.add('2026-09-29', 999, 999, 999);
  const before = f.database.db.prepare('SELECT total_changes() n').get().n;
  const data = f.read();
  assert.equal(data.period, 'day'); assert.equal(data.summary.trend.length, 30);
  assert.equal(data.summary.trend[0].date, '2026-08-30'); assert.equal(data.summary.trend.at(-1).date, '2026-09-28');
  assert.equal(data.range.end, '2026-09-28T15:59:59.999Z'); assert.equal(data.range.partialEndDay, false);
  assert.equal(data.accounts[0].metrics.followers.dailyComparable, true);
  assert.equal(data.summary.metrics.followers.delta, -10); assert.equal(data.summary.metrics.likes.delta, 10);
  assert.equal(data.summary.metrics.posts.delta, -1); assert.equal(data.summary.metrics.estimatedPlays.delta, 1000);
  assert.equal(data.accounts[0].metrics.followers.currentAt, '2026-09-28T02:00:00.000Z');
  assert.equal(f.database.db.prepare('SELECT total_changes() n').get().n, before);
});

test('explicit today equals implicit today for strict metrics and daily trend, including actual zero', t => {
  const f = fixture(t); f.add('2026-09-28', 10, 10, 2); f.add('2026-09-29', 0, 0, 0);
  const implicit = f.read({ startDate: undefined, endDate: undefined });
  const explicit = f.read({ startDate: '2026-09-29', endDate: '2026-09-29' });
  assert.equal(explicit.period, 'day');
  assert.deepEqual(explicit.summary.metrics, implicit.summary.metrics);
  assert.deepEqual(explicit.summary.trend, implicit.summary.trend);
  assert.equal(explicit.accounts[0].metrics.followers.dailyComparable, true);
  assert.equal(explicit.range.end, '2026-09-29T07:00:00.000Z'); assert.equal(explicit.range.partialEndDay, true);
});

test('explicit day cannot manufacture daily change across a missing adjacent date', t => {
  const f = fixture(t); f.add('2026-09-26', 100); f.add('2026-09-28', 130);
  const data = f.read();
  assert.equal(data.period, 'day'); assert.equal(data.accounts[0].metrics.followers.dailyComparable, false);
  assert.equal(data.summary.metrics.followers.delta, null); assert.equal(data.summary.metrics.estimatedPlays.delta, null);
  assert.equal(data.accounts[0].metrics.followers.observedWindow.delta, 30);
  assert.equal(data.summary.trend.find(p => p.date === '2026-09-27').followers, null);
});

test('custom single-day and day with multiple explicit dates retain existing custom contract', t => {
  const f = fixture(t); f.add('2026-09-26', 10); f.add('2026-09-28', 20);
  assert.equal(f.read({ period: 'custom' }).period, 'custom');
  assert.equal(f.read({ startDate: '2026-09-27' }).period, 'custom');
  assert.equal(f.read({ period: 'custom' }).summary.trend.length, 1);
});

test('fixed single day comparison reads its own exact endpoints and preserves future exclusion', t => {
  const f = fixture(t); f.add('2026-09-25', 10); f.add('2026-09-26', 20); f.add('2026-09-27', 50); f.add('2026-09-28', 55); f.add('2026-09-29', 888);
  const data = f.read({ comparisonStartDate: '2026-09-26', comparisonEndDate: '2026-09-26' });
  assert.equal(data.period, 'day'); assert.equal(data.summary.metrics.followers.delta, 5);
  assert.equal(data.comparison.period, 'custom'); assert.equal(data.comparison.summary.metrics.followers.delta, 10);
  assert.equal(data.comparison.accounts[0].metrics.followers.currentAt, '2026-09-26T02:00:00.000Z');
});
