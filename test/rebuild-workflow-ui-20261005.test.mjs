import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

const DAY = '2026-10-04';
const SOURCE = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8')
  .replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '');

function account(id, label, delta, extra = {}) {
  return {
    id, label, enabled: true, platform: 'douyin', status: {}, boards: [],
    collection: { date: DAY, profileObserved: true, worksState: 'complete' },
    metrics: Object.fromEntries(Object.keys(model.METRICS).map((key) =>
      [key, { value: 100 + id, delta, comparable: delta !== null, dailyComparable: true }])),
    ...extra,
  };
}

function accountsFixture() {
  const rows = [
    account(1, '搜索A增长', 5), account(2, '搜索A下滑', -2),
    account(3, '搜索B零', 0, { platform: 'bilibili' }),
    account(4, '搜索B缺测', null, { platform: 'bilibili' }),
    account(5, '搜索A跨日', 9), account(6, '暂停账号', 99, { enabled: false }),
  ];
  rows[1].collection = { date: DAY, profileObserved: false, worksState: 'limited' };
  rows[3].collection = { date: DAY, profileObserved: false, worksState: 'unavailable' };
  rows[4].metrics.followers.dailyComparable = false;
  const likes = [-4, 3, 0, null, -2, 99];
  rows.forEach((row, index) => {
    row.metrics.likes.delta = likes[index];
    row.metrics.likes.comparable = likes[index] !== null;
    row.metrics.estimatedPlays.delta = likes[index] === null ? null : likes[index] * 100;
    row.metrics.estimatedPlays.comparable = likes[index] !== null;
  });
  return rows;
}

function fixture({ accounts = accountsFixture(), url } = {}) {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      id, value: '', innerHTML: '', textContent: '', hidden: false, dataset: {}, attrs: {},
      scrollTop: 0, scrollLeft: 0,
      setAttribute(key, value) { this.attrs[key] = value; },
      getAttribute(key) { return this.attrs[key] ?? null; },
      querySelector() { return null; },
      focus() {}, scrollIntoView() {},
    });
    return nodes.get(id);
  };
  const location = new URL(url || `https://matrix.example.test/?period=custom&start=${DAY}&end=${DAY}#accounts`);
  let requests = 0;
  const context = {
    ...model, fmt: model.formatNumber, URL, URLSearchParams, Date, Intl, location,
    window: { matchMedia: () => ({ matches: false }) },
    document: { activeElement: null, getElementById: node,
      querySelectorAll: () => [], querySelector: () => null },
    history: { state: null, replaceState(state, _title, destination) {
      this.state = state; location.href = String(destination);
    } },
    fetch() { requests += 1; throw new Error('workflow UI tests prohibit network requests'); },
  };
  runInNewContext(`${SOURCE}\nthis.subject = {
    state,rows,renderWorkflow,selectWorkflow,navigationUrl,renderAccounts,renderSummary,
  };`, context);
  const subject = context.subject;
  Object.assign(subject.state, {
    view: 'accounts', period: 'custom', start: DAY, end: DAY,
    data: {
      period: 'day', range: { startDate: DAY, endDate: DAY }, accounts, boards: [],
      summary: { enabledCount: accounts.filter((row) => row.enabled === true).length,
        metrics: Object.fromEntries(Object.keys(model.METRICS).map((key) =>
          [key, { value: 1234, delta: key === 'likes' ? -3 : 3,
            comparableCount: 3, fullPeriodComparableCount: 3, observedCount: 5 }])), trend: [] },
    },
  });
  return { ...subject, node, location, requests: () => requests };
}

const ids = (rows) => Array.from(rows, (row) => row.id);
function tableIds(html) {
  return [...html.matchAll(/data-account-id="(\d+)"/g)].map((match) => Number(match[1]));
}
function counts(html) {
  return Object.fromEntries([...html.matchAll(
    /data-workflow-task="([^"]+)"[^>]*><span>[^<]*<\/span><strong>([^<]*)<\/strong>/g,
  )].map((match) => [match[1], Number(match[2].replaceAll(',', ''))]));
}

test('real rows distinguish growth, decline, measured zero and missing daily endpoints', () => {
  const f = fixture();
  const expected = { all: [1, 3, 2, 4, 5], growing: [1], declining: [2], unobserved: [4, 5] };
  for (const task of Object.keys(expected)) {
    f.state.workflowTask = task;
    assert.deepEqual(ids(f.rows()), expected[task]);
    assert.deepEqual(ids(f.rows({ overview: true })), expected[task]);
  }
  f.state.workflowTask = 'unobserved';
  assert.equal(ids(f.rows()).includes(3), false, 'measured zero is not missing');
  f.renderWorkflow();
  assert.deepEqual(counts(f.node('dailyWorkflow').innerHTML),
    { all: 5, growing: 1, declining: 1, unobserved: 2 });
  assert.match(f.node('dailyWorkflow').innerHTML, /data-workflow-task="unobserved" aria-pressed="true"/);
  assert.equal(f.requests(), 0);
});

test('local search, platform and collection narrow only ledger workflow counts, not the overview cohort', () => {
  const f = fixture();
  Object.assign(f.state, { query: '搜索A', platform: 'douyin', collectionFilter: 'missing-profile' });
  assert.deepEqual(ids(f.rows()), [2]);
  f.renderWorkflow();
  assert.deepEqual(counts(f.node('accountWorkflow').innerHTML),
    { all: 1, growing: 0, declining: 1, unobserved: 0 });
  assert.deepEqual(counts(f.node('dailyWorkflow').innerHTML),
    { all: 5, growing: 1, declining: 1, unobserved: 2 });
  assert.equal(f.rows({ overview: true }).length, 5);
  f.state.workflowTask = 'declining';
  assert.deepEqual(ids(f.rows()), [2]);
  f.state.workflowTask = 'growing';
  assert.deepEqual(ids(f.rows()), []);
  assert.deepEqual(ids(f.rows({ overview: true })), [1]);
});

test('workflow buttons count the entire filtered cohort before slicing or selecting a task', () => {
  const rows = Array.from({ length: 27 }, (_, index) => account(index + 1, `作者${index + 1}`, index + 1));
  const f = fixture({ accounts: rows });
  Object.assign(f.state, { workflowTask: 'growing', page: 2, pageSize: 10 });
  f.renderAccounts();
  assert.equal(tableIds(f.node('accountsTable').innerHTML).length, 10);
  assert.equal(tableIds(f.node('overviewTable').innerHTML).length, 8);
  assert.match(f.node('pager').innerHTML, /11–20 \/ 27 个账号/);
  assert.deepEqual(counts(f.node('accountWorkflow').innerHTML),
    { all: 27, growing: 27, declining: 0, unobserved: 0 });
  assert.deepEqual(counts(f.node('dailyWorkflow').innerHTML),
    { all: 27, growing: 27, declining: 0, unobserved: 0 });
  assert.match(f.node('workflowCaption').textContent, /27 个启用账号，展示前 8 个/);
});

test('selectWorkflow resets paging, uses the selected metric and sorts declines from lowest upward', () => {
  const f = fixture();
  Object.assign(f.state, { page: 4, enabled: 'all', query: '搜索A', platform: 'douyin' });
  f.selectWorkflow('declining', 'likes');
  assert.equal(f.state.page, 1);
  assert.equal(f.state.enabled, 'active');
  assert.equal(f.node('enabledSelect').value, 'active');
  assert.equal(f.state.sort, 'likes.delta');
  assert.equal(f.state.direction, 'asc');
  assert.equal(f.state.metric, 'likes');
  assert.equal(f.state.workflowMetric, 'likes');
  assert.equal(f.node('workflowMetric').value, 'likes');
  assert.equal(f.node('accountWorkflowMetric').value, 'likes');
  assert.deepEqual(ids(f.rows()), [1, 5]);
  assert.equal(f.state.query, '搜索A');
  assert.equal(f.state.platform, 'douyin');
  assert.equal(f.location.searchParams.get('task'), 'declining');
  assert.equal(f.location.searchParams.get('metric'), 'likes');
  f.selectWorkflow('growing', 'likes');
  assert.equal(f.state.direction, 'desc');
  assert.deepEqual(ids(f.rows()), [2]);
  const before = f.location.href;
  f.selectWorkflow('unknown', 'likes');
  f.selectWorkflow('declining', 'unknown');
  assert.equal(f.location.href, before, 'invalid commands are ignored');
  assert.equal(f.requests(), 0);
});

test('URL task/metric survive real navigation and defaults remove their obsolete query parameters', () => {
  const f = fixture({ url: `https://matrix.example.test/?period=custom&start=${DAY}&end=${DAY}&task=declining&metric=posts&theme=tuantuan#accounts` });
  assert.equal(f.state.workflowTask, 'declining');
  assert.equal(f.state.workflowMetric, 'posts');
  f.renderAccounts();
  const url = f.navigationUrl();
  assert.equal(url.searchParams.get('task'), 'declining');
  assert.equal(url.searchParams.get('metric'), 'posts');
  assert.equal(url.searchParams.get('theme'), 'tuantuan');
  assert.equal(url.searchParams.get('start'), DAY);
  assert.equal(url.searchParams.get('end'), DAY);
  assert.equal(url.hash, '#accounts');
  f.selectWorkflow('all', 'followers');
  const defaults = f.navigationUrl();
  assert.equal(defaults.searchParams.has('task'), false);
  assert.equal(defaults.searchParams.has('metric'), false);
  const invalid = fixture({ url: 'https://matrix.example.test/?task=unknown&metric=unknown#accounts' });
  assert.equal(invalid.state.workflowTask, 'all');
  assert.equal(invalid.state.workflowMetric, 'followers');
});

test('changing workflow and local filters never replaces the underlying scope or rendered KPI totals', () => {
  const f = fixture();
  f.renderSummary();
  const kpis = f.node('kpiGrid').innerHTML;
  const summary = structuredClone(f.state.data.summary);
  const sourceAccounts = f.state.data.accounts;
  Object.assign(f.state, { query: '搜索A', platform: 'douyin', collectionFilter: 'missing-profile' });
  f.selectWorkflow('declining', 'likes');
  assert.equal(tableIds(f.node('accountsTable').innerHTML).length, 0);
  assert.equal(f.node('kpiGrid').innerHTML, kpis);
  assert.equal(f.state.data.accounts, sourceAccounts);
  assert.deepEqual(f.state.data.summary, summary);
  f.renderSummary();
  assert.equal(f.node('kpiGrid').innerHTML, kpis, 'even a fresh KPI render still uses original scope');
  assert.match(f.node('workflowCaption').textContent, /仅筛选下方列表，上方区间总计不变/);
});

test('estimated play workflow retains its own delta, metric detail hooks and nonactual-play caption', () => {
  const f = fixture();
  f.selectWorkflow('growing', 'estimatedPlays');
  assert.deepEqual(ids(f.rows()), [2]);
  assert.equal(f.state.sort, 'estimatedPlays.delta');
  assert.equal(f.state.metric, 'estimatedPlays');
  assert.match(f.node('overviewTable').innerHTML, /data-account-id="2" data-account-metric="estimatedPlays"/);
  assert.match(f.node('workflowCaption').textContent, /获赞净变化 × 100，非实际播放/);
  assert.equal(f.location.searchParams.get('metric'), 'estimatedPlays');
});

test('all-enabled scope counts all real ledger rows while growth and decline still count only active accounts', () => {
  const f = fixture();
  f.state.enabled = 'all';
  f.renderAccounts();
  assert.equal(f.rows().length, 6);
  assert.deepEqual(counts(f.node('accountWorkflow').innerHTML),
    { all: 6, growing: 1, declining: 1, unobserved: 2 });
  assert.deepEqual(counts(f.node('dailyWorkflow').innerHTML),
    { all: 5, growing: 1, declining: 1, unobserved: 2 });
});

test('paused-only ledger hides active-performance task controls without hiding its actual paused rows', () => {
  const f = fixture();
  f.state.enabled = 'paused';
  f.renderAccounts();
  assert.deepEqual(ids(f.rows()), [6]);
  assert.deepEqual(tableIds(f.node('accountsTable').innerHTML), [6]);
  assert.equal(f.node('accountWorkflow').hidden, true);
  assert.equal(f.node('dailyWorkflow').hidden, false, 'overview still has its active source cohort');
});
