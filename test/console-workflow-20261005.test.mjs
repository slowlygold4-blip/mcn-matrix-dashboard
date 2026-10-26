import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getWorkflowMetric, createWorkflowSummary, filterWorkflowAccounts,
} from '../public/console-workflow.js';

function account(id, followers, extra = {}) {
  return { id, enabled: true, metrics: { followers: { delta: followers } }, ...extra };
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function assertPartition(accounts, metric = 'followers', period) {
  const summary = createWorkflowSummary(accounts, metric, period);
  assert.equal(summary.all,
    summary.growing + summary.declining + summary.unobserved + summary.unchanged);
  for (const task of ['all', 'growing', 'declining', 'unobserved']) {
    assert.equal(filterWorkflowAccounts(accounts, { task, metric, period }).length, summary[task]);
  }
  return summary;
}

test('workflow metric follows each supported metric or its exact value/delta sort key', () => {
  for (const metric of ['followers', 'likes', 'posts', 'estimatedPlays']) {
    for (const suffix of ['', '.value', '.delta']) {
      assert.equal(getWorkflowMetric(`${metric}${suffix}`), metric);
    }
  }
});

test('unsupported, malformed or missing sort keys use the explicit fallback', () => {
  for (const key of [undefined, null, '', 'label', 'views.delta', 'followers.percent',
    'likes.value.delta', 'followers.delta.extra', 'Followers.delta', ' followers.delta',
    'followers.delta ', 'followers.delta\n', 'estimatedPlaysDelta', 0, {}]) {
    assert.equal(getWorkflowMetric(key), 'followers');
    assert.equal(getWorkflowMetric(key, 'likes'), 'likes');
  }
  assert.equal(getWorkflowMetric('posts.delta', 'likes'), 'posts');
});

test('positive, negative, zero and missing observations form one enabled account partition', () => {
  const rows = [account(1, 8), account(2, -3), account(3, 0), account(4, null),
    account(5, undefined), account(6, 999, { enabled: false })];
  assert.deepEqual(assertPartition(rows),
    { all: 5, growing: 1, declining: 1, unobserved: 2, unchanged: 1 });
  assert.deepEqual(filterWorkflowAccounts(rows, { task: 'all' }).map((row) => row.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(filterWorkflowAccounts(rows, { task: 'growing' }).map((row) => row.id), [1]);
  assert.deepEqual(filterWorkflowAccounts(rows, { task: 'declining' }).map((row) => row.id), [2]);
  assert.deepEqual(filterWorkflowAccounts(rows, { task: 'unobserved' }).map((row) => row.id), [4, 5]);
});

test('real zero and negative zero are unchanged, never missing or growth', () => {
  const rows = [account(1, 0), account(2, -0), account(3, '0')];
  assert.deepEqual(assertPartition(rows, 'followers', 'day'),
    { all: 3, growing: 0, declining: 0, unobserved: 0, unchanged: 3 });
});

test('missing delta or metric stays unobserved even with an available stock value', () => {
  const rows = [
    account(1, null), account(2, '', { metrics: { followers: { value: 123, delta: '' } } }),
    account(3, undefined, { metrics: { followers: { value: 0 } } }),
    account(4, undefined, { metrics: {} }), account(5, undefined, { metrics: undefined }),
    account(6, undefined, { metrics: { followers: null } }),
  ];
  assert.deepEqual(assertPartition(rows),
    { all: 6, growing: 0, declining: 0, unobserved: 6, unchanged: 0 });
});

test('nonfinite values are unobserved while the shared numeric contract accepts finite strings', () => {
  const rows = [account(1, NaN), account(2, Infinity), account(3, -Infinity),
    account(4, 'invalid'), account(5, '2'), account(6, '-2')];
  assert.deepEqual(assertPartition(rows),
    { all: 6, growing: 1, declining: 1, unobserved: 4, unchanged: 0 });
});

test('daily nonadjacent endpoints stay unobserved without erasing genuine longer-period deltas', () => {
  const rows = [
    account(1, 5, { metrics: { followers: { delta: 5, dailyComparable: false } } }),
    account(2, -5, { metrics: { followers: { delta: -5, dailyComparable: false } } }),
    account(3, 0, { metrics: { followers: { delta: 0, dailyComparable: false } } }),
    account(4, 1, { metrics: { followers: { delta: 1, dailyComparable: true } } }),
  ];
  assert.deepEqual(assertPartition(rows, 'followers', 'day'),
    { all: 4, growing: 1, declining: 0, unobserved: 3, unchanged: 0 });
  for (const period of ['week', 'month', '30d', 'since', 'custom', undefined]) {
    assert.deepEqual(assertPartition(rows, 'followers', period),
      { all: 4, growing: 2, declining: 1, unobserved: 0, unchanged: 1 });
  }
});

test('explicitly incomparable metrics cannot expose residual deltas, but legacy missing flags stay usable', () => {
  const rows = [
    account(1, 9, { metrics: { followers: { delta: 9, comparable: false } } }),
    account(2, -9, { metrics: { followers: { delta: -9, comparable: false } } }),
    account(3, 0, { metrics: { followers: { delta: 0, comparable: false } } }),
    account(4, 2, { metrics: { followers: { delta: 2, comparable: true } } }),
    account(5, -2),
  ];
  for (const period of ['day', 'week', 'since', undefined]) {
    assert.deepEqual(assertPartition(rows, 'followers', period),
      { all: 5, growing: 1, declining: 1, unobserved: 3, unchanged: 0 });
    assert.deepEqual(filterWorkflowAccounts(rows, { task: 'unobserved', period })
      .map((row) => row.id), [1, 2, 3]);
  }
});

test('only strict enabled true joins the workflow cohort', () => {
  const rows = [account(1, 1), account(2, -1, { enabled: false }),
    account(3, null, { enabled: undefined }), account(4, 0, { enabled: 1 }),
    account(5, 1, { enabled: 'true' }), null, undefined];
  assert.deepEqual(assertPartition(rows),
    { all: 1, growing: 1, declining: 0, unobserved: 0, unchanged: 0 });
});

test('each metric uses its own provided delta, without borrowing or estimating from another metric', () => {
  const rows = [
    { id: 1, enabled: true, metrics: {
      followers: { delta: 1 }, likes: { delta: -1 }, posts: { delta: 0 },
      estimatedPlays: { delta: null },
    } },
    { id: 2, enabled: true, metrics: {
      followers: { delta: null }, likes: { delta: 0 }, posts: { delta: -1 },
      estimatedPlays: { delta: 200 },
    } },
  ];
  assert.deepEqual(assertPartition(rows, 'followers'),
    { all: 2, growing: 1, declining: 0, unobserved: 1, unchanged: 0 });
  assert.deepEqual(assertPartition(rows, 'likes'),
    { all: 2, growing: 0, declining: 1, unobserved: 0, unchanged: 1 });
  assert.deepEqual(assertPartition(rows, 'posts'),
    { all: 2, growing: 0, declining: 1, unobserved: 0, unchanged: 1 });
  assert.deepEqual(assertPartition(rows, 'estimatedPlays'),
    { all: 2, growing: 1, declining: 0, unobserved: 1, unchanged: 0 });
  assert.deepEqual(filterWorkflowAccounts(rows, { task: 'growing', metric: 'estimatedPlays' })
    .map((row) => row.id), [2]);
});

test('unknown task selects all enabled accounts and unknown metric follows the default metric', () => {
  const rows = [account(1, -1), account(2, 0), account(3, 1, { enabled: false })];
  assert.deepEqual(filterWorkflowAccounts(rows, { task: 'unsupported' }), rows.slice(0, 2));
  assert.deepEqual(filterWorkflowAccounts(rows, { task: 'unchanged' }), rows.slice(0, 2));
  assert.deepEqual(filterWorkflowAccounts(rows, { task: 'declining', metric: 'unsupported' }), [rows[0]]);
  assert.deepEqual(createWorkflowSummary(rows, 'unsupported'), createWorkflowSummary(rows, 'followers'));
});

test('summary and every filter preserve deeply frozen inputs, row identity and source ordering', () => {
  const rows = deepFreeze([account(4, null), account(2, -3), account(1, 1),
    account(3, 0), account(5, 5, { enabled: false })]);
  const before = structuredClone(rows);
  assertPartition(rows, 'followers', 'day');
  for (const task of ['all', 'growing', 'declining', 'unobserved']) {
    const result = filterWorkflowAccounts(rows, { task });
    assert.notEqual(result, rows);
    assert.ok(result.every((row) => rows.includes(row)));
  }
  const all = filterWorkflowAccounts(rows);
  assert.deepEqual(all.map((row) => row.id), [4, 2, 1, 3]);
  assert.deepEqual(rows, before);
});

test('empty or unavailable account input returns an explicit empty cohort', () => {
  for (const rows of [[], undefined, null, {}]) {
    assert.deepEqual(createWorkflowSummary(rows),
      { all: 0, growing: 0, declining: 0, unobserved: 0, unchanged: 0 });
    assert.deepEqual(filterWorkflowAccounts(rows), []);
  }
});
