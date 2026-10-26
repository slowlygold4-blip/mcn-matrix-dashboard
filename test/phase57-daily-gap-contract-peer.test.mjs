import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDailyCoverage, dailyCoverageMembers } from '../lib/daily-coverage-view.mjs';

const START = '2026-09-30';
const END = '2026-10-01';
function account(id, extra = {}) { return { id, label: `同名账号`, platform: 'douyin', enabled: true, ...extra }; }
function point(targetId, date, followers, likes, posts, extra = {}) {
  const capturedAt = `${date}T10:00:00.000Z`;
  const observed = `${date}T09:59:00.000Z`;
  return { targetId, date, capturedAt, followers, followersAt: followers === null ? null : observed, likes, likesAt: likes === null ? null : observed, posts, postsAt: posts === null ? null : observed, ...extra };
}
function frozen(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
function fixture() {
  const accounts = [account(1), account(2, { platform: 'bilibili' }), account(3, { enabled: false }), account(4)];
  const points = [
    point(1, START, 100, 1000, 5), point(1, END, 100, 900, 6),
    point(2, START, null, 100, 3), point(2, END, 50, null, 3),
    point(3, START, 1_000_000, 9_000_000, 1000), point(3, END, 9_000_000, 9_999_999, 5000),
  ];
  return { accounts, points };
}
function errorCode(fn, fragment) {
  assert.throws(fn, (error) => typeof error?.code === 'string' && error.code.startsWith('daily-coverage-invalid-') && (!fragment || error.code.includes(fragment)));
}

test('metric-independent enabled denominator and mutually exclusive gap arithmetic', () => {
  const { accounts, points } = fixture();
  const rows = buildDailyCoverage(accounts, points, { start: END, end: END });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, END);
  assert.equal(rows[0].baselineDate, START);
  assert.deepEqual(rows[0].metrics.followers, { total: 3, observed: 2, comparable: 1, missingCurrent: 1, missingBaseline: 1 });
  assert.deepEqual(rows[0].metrics.likes, { total: 3, observed: 1, comparable: 1, missingCurrent: 2, missingBaseline: 0 });
  assert.deepEqual(rows[0].metrics.posts, { total: 3, observed: 2, comparable: 2, missingCurrent: 1, missingBaseline: 0 });
  for (const metric of Object.values(rows[0].metrics)) {
    assert.equal(metric.comparable + metric.missingCurrent + metric.missingBaseline, metric.total);
    assert.equal(metric.observed, metric.comparable + metric.missingBaseline);
  }
});

test('true zero, negative change and independent publication stock remain comparable', () => {
  const { accounts, points } = fixture();
  const followers = dailyCoverageMembers(accounts, points, { date: END, metric: 'followers', reason: 'comparable' });
  const likes = dailyCoverageMembers(accounts, points, { date: END, metric: 'likes', reason: 'comparable' });
  const posts = dailyCoverageMembers(accounts, points, { date: END, metric: 'posts', reason: 'comparable' });
  assert.equal(followers[0].delta, 0);
  assert.equal(likes[0].delta, -100);
  assert.deepEqual(posts.map((row) => [row.id, row.delta]), [[1, 1], [2, 0]]);
  assert.equal(likes[0].currentAt, `${END}T09:59:00.000Z`);
  assert.equal(likes[0].baselineAt, `${START}T09:59:00.000Z`);
  assert.equal(likes[0].platform, 'douyin');
});

test('missing current takes priority even if both days are absent; no null-to-zero', () => {
  const { accounts, points } = fixture();
  const missing = dailyCoverageMembers(accounts, points, { date: END, metric: 'likes', reason: 'missingCurrent' });
  assert.deepEqual(missing.map((row) => row.id), [2, 4]);
  assert.equal(missing[0].baselineValue, 100);
  assert.equal(missing[0].currentValue, null);
  assert.equal(missing[0].delta, null);
  assert.equal(missing[1].baselineValue, null);
  assert.equal(missing[1].currentValue, null);
  assert.equal(missing[1].baselineAt, null);
  assert.equal(missing[1].currentAt, null);
  assert.equal(missing[1].delta, null);
});

test('baseline gap is D-1 only, never D-2 last-known carry forward', () => {
  const accounts = [account(10)];
  const points = [point(10, '2026-09-29', 10, 20, 30), point(10, END, 12, 25, 31)];
  const row = buildDailyCoverage(accounts, points, { start: END, end: END })[0];
  assert.deepEqual(row.metrics.followers, { total: 1, observed: 1, comparable: 0, missingCurrent: 0, missingBaseline: 1 });
  const missing = dailyCoverageMembers(accounts, points, { date: END, metric: 'followers', reason: 'missingBaseline' });
  assert.equal(missing[0].baselineValue, null);
  assert.equal(missing[0].baselineAt, null);
  assert.equal(missing[0].delta, null);
});

test('same display names across IDs/platforms do not dedupe; disabled members excluded', () => {
  const { accounts, points } = fixture();
  const members = dailyCoverageMembers(accounts, points, { date: END, metric: 'posts', reason: 'comparable' });
  assert.deepEqual(members.map((row) => [row.id, row.label, row.platform]), [[1, '同名账号', 'douyin'], [2, '同名账号', 'bilibili']]);
  assert.ok(!members.some((row) => row.id === 3));
});

test('caller-selected scope re-derives denominator and ignores other valid global points', () => {
  const { accounts, points } = fixture();
  const row = buildDailyCoverage(accounts.filter((item) => item.id === 2), points, { start: END, end: END })[0];
  assert.deepEqual(row.metrics.posts, { total: 1, observed: 1, comparable: 1, missingCurrent: 0, missingBaseline: 0 });
  assert.deepEqual(dailyCoverageMembers(accounts.filter((item) => item.id === 2), points, { date: END, metric: 'posts', reason: 'comparable' }).map((item) => item.id), [2]);
});

test('empty enabled scope gives exact zero denominator, not inferred full success', () => {
  const { points } = fixture();
  const row = buildDailyCoverage([account(3, { enabled: false })], points, { start: END, end: END })[0];
  for (const metric of Object.values(row.metrics)) assert.deepEqual(metric, { total: 0, observed: 0, comparable: 0, missingCurrent: 0, missingBaseline: 0 });
  assert.deepEqual(dailyCoverageMembers([], points, { date: END, metric: 'followers', reason: 'missingCurrent' }), []);
});

test('zero stock values are observations; zero baseline is not a gap', () => {
  const accounts = [account(9)];
  const points = [point(9, START, 0, 0, 0), point(9, END, 0, 1, 0)];
  const row = buildDailyCoverage(accounts, points, { start: END, end: END })[0];
  assert.equal(row.metrics.followers.comparable, 1);
  assert.equal(row.metrics.likes.comparable, 1);
  assert.equal(row.metrics.posts.comparable, 1);
  assert.equal(dailyCoverageMembers(accounts, points, { date: END, metric: 'likes', reason: 'comparable' })[0].delta, 1);
});

test('all calendar days appear over holes and year boundary, no implicit 90-day truncation', () => {
  const rows = buildDailyCoverage([account(1)], [], { start: '2025-10-02', end: '2026-10-01' });
  assert.equal(rows.length, 365);
  assert.equal(rows[0].date, '2025-10-02');
  assert.equal(rows[0].baselineDate, '2025-10-01');
  assert.equal(rows.at(-1).date, END);
  assert.equal(rows.find((row) => row.date === '2026-01-01').baselineDate, '2025-12-31');
  assert.equal(rows.every((row) => row.metrics.followers.missingCurrent === 1), true);
});

test('drill membership stable numeric ID order; caller pages have no lost/repeated accounts', () => {
  const accounts = Array.from({ length: 27 }, (_, n) => account(27 - n));
  const rows = dailyCoverageMembers(accounts, [], { date: END, metric: 'followers', reason: 'missingCurrent' });
  assert.deepEqual(rows.map((row) => row.id), Array.from({ length: 27 }, (_, n) => n + 1));
  assert.deepEqual([rows.slice(0, 10), rows.slice(10, 20), rows.slice(20, 30)].flat().map((row) => row.id), rows.map((row) => row.id));
  assert.equal(rows.slice(20, 30).length, 7);
});

test('pure calculations preserve frozen input arrays, objects and order', () => {
  const { accounts, points } = frozen(fixture());
  const before = JSON.stringify({ accounts, points });
  buildDailyCoverage(accounts, points, { start: START, end: END });
  dailyCoverageMembers(accounts, points, { date: END, metric: 'followers', reason: 'missingCurrent' });
  assert.equal(JSON.stringify({ accounts, points }), before);
});

test('selected duplicate target/date rejected, cannot last-wins or double-count', () => {
  const accounts = [account(1)];
  const points = [point(1, START, 10, 20, 30), point(1, END, 11, 21, 31), point(1, END, 999, 888, 777)];
  errorCode(() => buildDailyCoverage(accounts, points, { start: END, end: END }));
  errorCode(() => dailyCoverageMembers(accounts, points, { date: END, metric: 'followers', reason: 'comparable' }));
});

test('duplicate stable account IDs rejected even if enabled states differ', () => {
  errorCode(() => buildDailyCoverage([account(1), account(1, { enabled: false })], [], { start: END, end: END }));
});

test('malformed/noncanonical/after-capture/cross-BJ-day metric times rejected', () => {
  const accounts = [account(1)];
  const cases = [
    { capturedAt: `${END}T10:00:00Z` },
    { followersAt: `${END}T10:01:00.000Z` },
    { followersAt: `${START}T09:59:00.000Z` },
    { capturedAt: `${START}T15:59:59.000Z` },
    { followersAt: null },
  ];
  for (const extra of cases) errorCode(() => buildDailyCoverage(accounts, [point(1, END, 1, 2, 3, extra)], { start: END, end: END }));
});

test('Beijing day conversion accepts previous UTC date only when actual BJ day matches', () => {
  const accounts = [account(1)];
  const points = [point(1, END, 0, 0, 0, { capturedAt: `${START}T16:01:00.000Z`, followersAt: `${START}T16:00:00.000Z`, likesAt: `${START}T16:00:00.000Z`, postsAt: `${START}T16:00:00.000Z` })];
  assert.equal(buildDailyCoverage(accounts, points, { start: END, end: END })[0].metrics.followers.observed, 1);
});

test('unsafe/non-numeric/negative stock values rejected, not rounded or coerced', () => {
  for (const bad of [-1, 1.2, '5', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    errorCode(() => buildDailyCoverage([account(1)], [point(1, END, bad, 2, 3)], { start: END, end: END }));
  }
});

test('dates, maximum span, metrics and reasons fail closed', () => {
  const accounts = [account(1)];
  for (const request of [{ start: '', end: END }, { start: '2026-02-30', end: END }, { start: END, end: START }, { start: '2025-09-29', end: END }]) errorCode(() => buildDailyCoverage(accounts, [], request));
  errorCode(() => dailyCoverageMembers(accounts, [], { date: END, metric: 'estimatedPlay', reason: 'missingCurrent' }));
  errorCode(() => dailyCoverageMembers(accounts, [], { date: END, metric: 'followers', reason: 'all' }));
});

test('legacy null metric may retain provenance time but cannot become observed or comparable', () => {
  const accounts = [account(1)];
  const points = [point(1, START, 50, 2, 3), point(1, END, null, 3, 4, { followersAt: `${START}T09:59:00.000Z` })];
  const row = buildDailyCoverage(accounts, points, { start: END, end: END })[0];
  assert.deepEqual(row.metrics.followers, { total: 1, observed: 0, comparable: 0, missingCurrent: 1, missingBaseline: 0 });
  const members = dailyCoverageMembers(accounts, points, { date: END, metric: 'followers', reason: 'missingCurrent' });
  assert.equal(members[0].currentValue, null);
  assert.equal(members[0].currentAt, `${START}T09:59:00.000Z`);
  assert.equal(members[0].delta, null);
  assert.equal(row.metrics.likes.comparable, 1);
});

test('public drill projection does not propagate extra account locator or credential-like fields', () => {
  const accounts = [account(1, { url: 'https://private.invalid/a', locator: 'private-location', cookie: 'sentinel-not-real-secret' })];
  const members = dailyCoverageMembers(accounts, [], { date: END, metric: 'followers', reason: 'missingCurrent' });
  assert.deepEqual(Object.keys(members[0]).sort(), ['id', 'label', 'platform', 'reason', 'currentValue', 'currentAt', 'baselineValue', 'baselineAt', 'delta'].sort());
  assert.ok(!JSON.stringify(members).includes('private.invalid'));
  assert.ok(!JSON.stringify(members).includes('sentinel-not-real-secret'));
});

test('selected point extra fields cannot silently survive a trusted exact-shape contract', () => {
  errorCode(() => buildDailyCoverage([account(1)], [point(1, END, 1, 2, 3, { sourceURL: 'https://private.invalid' })], { start: END, end: END }));
});

test('valid scope-excluded duplicate date points never inflate current roster denominator', () => {
  const points = [point(77, END, 1, 2, 3), point(77, END, 2, 3, 4)];
  const row = buildDailyCoverage([account(1)], points, { start: END, end: END })[0];
  assert.deepEqual(row.metrics.followers, { total: 1, observed: 0, comparable: 0, missingCurrent: 1, missingBaseline: 0 });
});
