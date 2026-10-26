import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDailyCoverage, dailyCoverageMembers } from '../lib/daily-coverage-view.mjs';

const account = (id, overrides = {}) => ({ id, label: `账号${id}`, platform: 'douyin', enabled: true, ...overrides });
function point(targetId, date, values = {}) {
  const capturedAt = `${date}T04:00:00.000Z`;
  const p = { targetId, date, capturedAt, followers: 10, followersAt: capturedAt,
    likes: 20, likesAt: capturedAt, posts: 30, postsAt: capturedAt, ...values };
  for (const metric of ['followers', 'likes', 'posts']) if (p[metric] === null && !Object.hasOwn(values, `${metric}At`)) p[`${metric}At`] = null;
  return p;
}
const day = '2026-09-20';
const range = { start: day, end: day };

test('missing September 18/19 never borrows September 17 as September 20 baseline', () => {
  const result = buildDailyCoverage([account(1)], [point(1, '2026-09-17'), point(1, day)], { start: '2026-09-18', end: day });
  assert.equal(result.length, 3);
  for (const entry of result.slice(0, 2)) for (const c of Object.values(entry.metrics))
    assert.deepEqual(c, { total: 1, observed: 0, comparable: 0, missingCurrent: 1, missingBaseline: 0 });
  for (const c of Object.values(result[2].metrics))
    assert.deepEqual(c, { total: 1, observed: 1, comparable: 0, missingCurrent: 0, missingBaseline: 1 });
  assert.equal(result[2].baselineDate, '2026-09-19');
  assert.equal(dailyCoverageMembers([account(1)], [point(1, '2026-09-17'), point(1, day)],
    { date: day, metric: 'likes', reason: 'missingBaseline' })[0].delta, null);
});

test('metrics independently preserve zero, negative changes and mutually exclusive missing reasons', () => {
  const points = [point(1, '2026-09-19', { followers: 10, likes: 0, posts: null }),
    point(1, day, { followers: 0, likes: null, posts: 1 })];
  const entry = buildDailyCoverage([account(1)], points, range)[0];
  assert.equal(entry.metrics.followers.comparable, 1);
  assert.equal(entry.metrics.likes.missingCurrent, 1);
  assert.equal(entry.metrics.posts.missingBaseline, 1);
  const rows = dailyCoverageMembers([account(1)], points, { date: day, metric: 'followers', reason: 'comparable' });
  assert.equal(rows[0].currentValue, 0); assert.equal(rows[0].baselineValue, 10); assert.equal(rows[0].delta, -10);
});

test('real zero delta belongs to comparable rather than a missing bucket', () => {
  const rows = dailyCoverageMembers([account(1)], [point(1, '2026-09-19', { likes: 0 }), point(1, day, { likes: 0 })],
    { date: day, metric: 'likes', reason: 'comparable' });
  assert.equal(rows.length, 1); assert.equal(rows[0].delta, 0);
});

test('both missing belongs only to missingCurrent and does not count twice', () => {
  const c = buildDailyCoverage([account(1)], [], range)[0].metrics.likes;
  assert.deepEqual(c, { total: 1, observed: 0, comparable: 0, missingCurrent: 1, missingBaseline: 0 });
  const row = dailyCoverageMembers([account(1)], [], { date: day, metric: 'likes', reason: 'missingCurrent' })[0];
  assert.equal(row.currentValue, null); assert.equal(row.baselineValue, null); assert.equal(row.delta, null);
});

test('selected current enabled roster is the denominator; same-name crossplatform IDs remain distinct', () => {
  const accounts = [account(2, { label: '同名', platform: 'bilibili' }), account(1, { label: '同名' }), account(3, { enabled: false })];
  const points = [1, 2, 3, 99].flatMap(id => [point(id, '2026-09-19'), point(id, day)]);
  const c = buildDailyCoverage(accounts, points, range)[0].metrics.posts;
  assert.equal(c.total, 2); assert.equal(c.comparable, 2);
  const rows = dailyCoverageMembers(accounts, points, { date: day, metric: 'posts', reason: 'comparable' });
  assert.deepEqual(rows.map(row => row.id), [1, 2]);
  assert.deepEqual(rows.map(row => row.platform), ['douyin', 'bilibili']);
  const narrowed = buildDailyCoverage([accounts[0]], points, range)[0];
  assert.equal(narrowed.metrics.likes.total, 1);
});

test('metric-specific source timestamps survive byte-for-byte, not capturedAt replacements', () => {
  const prior = point(1, '2026-09-19', { likesAt: '2026-09-18T20:01:02.003Z' });
  const current = point(1, day, { likesAt: '2026-09-19T20:03:04.005Z' });
  const [row] = dailyCoverageMembers([account(1)], [prior, current], { date: day, metric: 'likes', reason: 'comparable' });
  assert.equal(row.currentAt, current.likesAt); assert.equal(row.baselineAt, prior.likesAt);
  assert.notEqual(row.currentAt, current.capturedAt);
});

test('missing current metric preserves a real prior value and does not invent delta', () => {
  const [row] = dailyCoverageMembers([account(1)], [point(1, '2026-09-19'), point(1, day, { likes: null })],
    { date: day, metric: 'likes', reason: 'missingCurrent' });
  assert.equal(row.baselineValue, 20); assert.equal(row.currentValue, null); assert.equal(row.delta, null);
});

test('catalog duplicate IDs and string/unsafe IDs reject rather than choose an ambiguous identity', () => {
  for (const accounts of [[account(1), account(1)], [account(1), account(1, { enabled: false })],
    [account('1')], [account(0)], [account(Number.MAX_SAFE_INTEGER + 1)], [account(1, { enabled: 1 })]])
    assert.throws(() => buildDailyCoverage(accounts, [], range), /daily-coverage-invalid/);
});

test('duplicate selected account/date points reject even when identical and never overwrite', () => {
  const p = point(1, day);
  assert.throws(() => buildDailyCoverage([account(1)], [p, { ...p }], range), /daily-coverage-invalid/);
  assert.throws(() => dailyCoverageMembers([account(1)], [p, { ...p, likes: 99 }],
    { date: day, metric: 'likes', reason: 'missingBaseline' }), /daily-coverage-invalid/);
});

test('selected point must have exact trusted-summary shape, finite nonnegative counters and canonical times', () => {
  const p = point(1, day);
  for (const invalid of [{ ...p, likes: undefined }, { ...p, likes: '20' }, { ...p, likes: -1 },
    { ...p, likes: NaN }, { ...p, likes: Infinity }, { ...p, likes: 1.2 }, { ...p, likesAt: null },
    { ...p, capturedAt: '2026-09-20T04:00:00Z' }, { ...p, likesAt: '2026-09-20T05:00:00.000Z' },
    { ...p, likesAt: '2026-09-18T04:00:00.000Z' }, { ...p, capturedAt: '2026-09-19T04:00:00.000Z' },
    { ...p, secret: 'not accepted' }])
    assert.throws(() => buildDailyCoverage([account(1)], [invalid], range), /daily-coverage-invalid/);
});

test('Beijing day boundaries are exact and independent of host timezone', () => {
  const capturedAt = '2026-09-19T16:00:00.000Z';
  const p = point(1, day, { capturedAt, followersAt: capturedAt, likesAt: capturedAt, postsAt: capturedAt });
  assert.equal(buildDailyCoverage([account(1)], [p], range)[0].metrics.likes.observed, 1);
  assert.throws(() => buildDailyCoverage([account(1)], [{ ...p, capturedAt: '2026-09-19T15:59:59.999Z' }], range), /daily-coverage-invalid/);
});

test('strict valid dates, inclusive budget, order and reason/metric contracts reject malformed requests', () => {
  for (const options of [{ start: '2026-02-29', end: day }, { start: day, end: '2026-09-19' },
    { start: '2026-9-20', end: day }, { start: day }, { start: '2024-01-01', end: '2025-01-01' },
    { start: '0000-01-01', end: '0000-01-01' }])
    assert.throws(() => buildDailyCoverage([], [], options), /daily-coverage-invalid/);
  for (const options of [{ date: day, metric: 'plays', reason: 'comparable' },
    { date: day, metric: 'likes', reason: 'all' }, { date: '2026-02-29', metric: 'likes', reason: 'missingCurrent' }])
    assert.throws(() => dailyCoverageMembers([], [], options), /daily-coverage-invalid/);
});

test('empty or paused-only scope preserves zero denominator rather than fabricated member counts', () => {
  for (const accounts of [[], [account(1, { enabled: false })]]) {
    const c = buildDailyCoverage(accounts, [], range)[0].metrics.likes;
    assert.deepEqual(c, { total: 0, observed: 0, comparable: 0, missingCurrent: 0, missingBaseline: 0 });
    assert.deepEqual(dailyCoverageMembers(accounts, [], { date: day, metric: 'likes', reason: 'missingCurrent' }), []);
  }
});

test('results do not mutate frozen inputs or leak returned references back into catalog', () => {
  const accounts = Object.freeze([Object.freeze(account(1))]);
  const points = Object.freeze([Object.freeze(point(1, '2026-09-19')), Object.freeze(point(1, day))]);
  const before = JSON.stringify({ accounts, points });
  const c = buildDailyCoverage(accounts, points, range);
  const rows = dailyCoverageMembers(accounts, points, { date: day, metric: 'posts', reason: 'comparable' });
  rows[0].label = '本地显示'; c[0].metrics.posts.total = 99;
  assert.equal(JSON.stringify({ accounts, points }), before);
  assert.equal(buildDailyCoverage(accounts, points, range)[0].metrics.posts.total, 1);
});

test('366-day selected window handles 701-account annual scope beyond old 200k summary cap', () => {
  const accounts = Array.from({ length: 701 }, (_, i) => account(i + 1));
  const points = [];
  for (let i = 0; i <= 366; i++) {
    const date = new Date(Date.parse('2023-12-31T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10);
    for (const a of accounts) points.push(point(a.id, date));
  }
  assert.equal(points.length, 257267);
  const days = buildDailyCoverage(accounts, points, { start: '2024-01-01', end: '2024-12-31' });
  assert.equal(days.length, 366);
  assert.equal(days[0].baselineDate, '2023-12-31');
  assert.equal(days.at(-1).date, '2024-12-31');
  for (const d of days) for (const c of Object.values(d.metrics)) {
    assert.equal(c.total, 701); assert.equal(c.observed, 701); assert.equal(c.comparable, 701);
    assert.equal(c.missingCurrent + c.missingBaseline, 0);
  }
});
