import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

function account(id, delta, { enabled = true, theme = 'tuantuan', label = '团团' } = {}) {
  const metric = { delta, comparable: delta !== null, dailyComparable: delta !== null };
  return { id, label: `账号${id}`, publicId: `public${id}`, platform: 'douyin', enabled,
    classification: { theme: { key: theme, label } }, boards: [{ key: 'a' }, { key: 'b' }],
    metrics: { followers: { ...metric }, likes: { ...metric }, posts: { ...metric },
      estimatedPlays: { ...metric, delta: delta === null ? null : delta * 100 } } };
}
function payload() {
  const accounts = [account(1, 50), account(2, -20, { theme: 'anchors', label: '抖音主播' }), account(3, 0), account(4, null), account(5, 999, { enabled: false })];
  return { accounts, period: 'custom', range: { startDate: '2026-09-22', endDate: '2026-09-28' },
    selectedBoard: null, theme: 'all', classification: 'all', themeSummary: { items: [] }, classificationSummary: { items: [] },
    summary: { enabledCount: 4, metrics: Object.fromEntries(Object.keys(model.METRICS).map(key => [key, { delta: key === 'estimatedPlays' ? 3000 : 30, comparableCount: 3 }])) } };
}
function harness(data = payload()) {
  const nodes = new Map();
  const document = { activeElement: null, querySelectorAll: () => [], querySelector: () => node('date-controls') };
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, innerHTML: '', textContent: '', hidden: false, value: '', disabled: false,
      setAttribute() {}, focus() { document.activeElement = this; }, scrollIntoView() {}, querySelector() { return null; } });
    return nodes.get(id);
  };
  document.getElementById = node;
  const ctx = { ...model, fmt: model.formatNumber, URL, URLSearchParams, Date, Intl, AbortController, document,
    location: new URL('http://127.0.0.1:4188/?theme=tuantuan&period=week#overview'), history: { replaceState() {} }, window: {},
    fetch: () => { throw new Error('explanation must not request network'); } };
  const js = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8').replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '');
  runInNewContext(`${js}\nthis.subject={state,renderMetricExplanation,selectMetricExplanation,showContributionLedger,rememberAppliedRequest,accountHealthMarkup,overviewAccountTable};`, ctx);
  Object.assign(ctx.subject.state, { data, start: data.range.startDate, end: data.range.endDate });
  return { ...ctx.subject, node, document };
}

test('contributions retain negative/zero, omit missing and paused, and never duplicate multi-board membership', () => {
  const data = payload(), before = JSON.stringify(data);
  const result = model.buildMetricContributions(data, 'likes');
  assert.equal(result.reconciled, true);
  assert.deepEqual(result.rows.map(row => row.delta), [50, -20, 0]);
  assert.equal(result.delta, 30); assert.equal(result.missingCount, 1); assert.equal(result.enabledCount, 4);
  assert.deepEqual(result.groups.map(group => [group.key, group.count, group.delta]), [['tuantuan', 2, 50], ['anchors', 1, -20]]);
  assert.equal(JSON.stringify(data), before);
});

test('account health exposes bounded failure code and streak without rendering untrusted HTML', () => {
  const f = harness();
  const failed = f.accountHealthMarkup({ status: { label: '<img src=x>', consecutiveFailures: 3,
    lastErrorCode: 'blocked', lastAttemptAt: '2026-09-28T12:00:00Z', lastSuccessAt: '2026-09-27T12:00:00Z' } });
  assert.match(failed, /错误码 blocked/);
  assert.match(failed, /连续失败 3 次/);
  assert.match(failed, /最近成功/);
  assert.match(failed, /&lt;img src=x&gt;/);
  assert.doesNotMatch(failed, /<img/);
  const unknown = f.accountHealthMarkup({ status: { label: '待采集', consecutiveFailures: null } });
  assert.match(unknown, /连续失败次数未确认/);
  assert.doesNotMatch(unknown, /连续失败 0 次/);
  const oldFailure = f.accountHealthMarkup({ status: { label: '更新失败', consecutiveFailures: null,
    lastErrorCode: 'blocked' } });
  assert.match(oldFailure, /错误码 blocked/);
  assert.match(oldFailure, /连续失败次数未确认/);
  const firstScreen = f.overviewAccountTable([{ ...account(1, 5),
    status: { label: '更新待重试', consecutiveFailures: 3, lastErrorCode: 'blocked' } }]);
  assert.match(firstScreen, /错误码 blocked/);
  assert.match(firstScreen, /连续失败 3 次/);
});

test('estimated contribution uses the same signed likes and explicit aggregate multiplier', () => {
  const data = payload();
  assert.equal(model.buildMetricContributions(data, 'estimatedPlays').delta, 3000);
  data.summary.metrics.likes.delta = 999;
  assert.equal(model.buildMetricContributions(data, 'estimatedPlays').reconciled, false);
  data.summary.metrics.likes.delta = 30; data.accounts[0].metrics.estimatedPlays.delta = 5100;
  assert.equal(model.buildMetricContributions(data, 'estimatedPlays').reconciled, false);
  data.accounts[0].metrics.estimatedPlays.delta = 5000; data.accounts[0].metrics.likes.comparable = false;
  assert.equal(model.buildMetricContributions(data, 'estimatedPlays').reconciled, false);
});

test('duplicate identities, malformed counts and unsafe totals cannot masquerade as aligned contributions', () => {
  for (const mutate of [data => data.accounts.push(data.accounts[0]), data => data.summary.enabledCount++,
    data => data.summary.metrics.likes.delta++, data => data.summary.metrics.likes.comparableCount++,
    data => { data.accounts[0].metrics.likes.delta = '50'; }, data => { data.accounts[0].id = 0; },
    data => { data.accounts[0].metrics.likes.delta = Number.MAX_SAFE_INTEGER + 1; }]) {
    const data = payload(); mutate(data);
    assert.equal(model.buildMetricContributions(data, 'likes').reconciled, false);
  }
});

test('missing endpoints remain unknown while an explicitly measured zero remains a contributor', () => {
  const data = payload(); data.accounts = [account(1, null)]; data.summary.enabledCount = 1;
  data.summary.metrics.likes = { delta: null, comparableCount: 0 };
  const unknown = model.buildMetricContributions(data, 'likes');
  assert.equal(unknown.reconciled, true); assert.equal(unknown.delta, null); assert.equal(unknown.rows.length, 0);
  data.accounts = [account(1, 0)]; data.summary.metrics.likes = { delta: 0, comparableCount: 1 };
  assert.equal(model.buildMetricContributions(data, 'likes').delta, 0);
  data.period = 'day'; data.accounts[0].metrics.likes.dailyComparable = false;
  assert.equal(model.buildMetricContributions(data, 'likes').reconciled, false);
});

test('unsafe intermediate cross-theme sums fail closed even when later cancellation produces a safe total', () => {
  const data = payload(); data.accounts = [account(1, Number.MAX_SAFE_INTEGER, { theme: 'a' }), account(2, 1, { theme: 'b' }), account(3, -2, { theme: 'c' })];
  data.summary.enabledCount = 3; data.summary.metrics.likes = { comparableCount: 3, delta: Number.MAX_SAFE_INTEGER - 1 };
  assert.equal(model.buildMetricContributions(data, 'likes').reconciled, false);
});

test('explanation shows applied API scope and exact calculation, never draft controls or local search', () => {
  const f = harness();
  Object.assign(f.state, { query: 'should-not-filter', platform: 'bilibili', enabled: 'paused', collectionFilter: 'missing-profile', theme: 'draft' });
  f.node('startDate').value = '2020-01-01';
  f.selectMetricExplanation('estimatedPlays');
  const html = f.node('metricExplanation').innerHTML;
  assert.match(html, /全部矩阵 ∩ 全部大主题 ∩ 全部内容类型/);
  assert.match(html, /2026-09-22 至 2026-09-28/);
  assert.match(html, /\+30 × 100 = \+3,000/);
  assert.match(html, /不是平台实际播放量/);
  assert.match(html, /3 \/ 4 个启用账号可比 · 1 个缺少可比端点/);
  assert.match(html, /-2,000/); assert.match(html, /每个账号只计入一个大主题/);
  assert.doesNotMatch(html, /should-not-filter|2020-01-01|draft|public5/);
});

test('inconsistent summary fails closed without exposing partial rankings or rewriting server values', () => {
  const data = payload(); data.summary.metrics.likes.delta = 123;
  const f = harness(data); f.selectMetricExplanation('likes');
  assert.match(f.node('metricExplanation').innerHTML, /贡献明细暂未对齐/);
  assert.doesNotMatch(f.node('metricExplanation').innerHTML, /data-account-id|净贡献|data-contribution-ledger/);
  assert.equal(data.summary.metrics.likes.delta, 123);
});

test('source labels are escaped and detail navigation uses numeric IDs, never source URLs', () => {
  const data = payload(); data.accounts[0].label = '<img src=x onerror=alert(1)>';
  data.accounts[0].classification.theme.label = '<script>bad</script>';
  data.selectedBoard = { name: '<svg onload=alert(2)>' };
  const f = harness(data); f.selectMetricExplanation('likes');
  const html = f.node('metricExplanation').innerHTML;
  assert.match(html, /&lt;img/); assert.match(html, /&lt;script/); assert.match(html, /&lt;svg/);
  assert.doesNotMatch(html, /<img|<script|<svg/); assert.match(html, /data-account-id="1"/);
});

test('expanded explanation is bounded to 10 rows and remains open against updated saved data', () => {
  const data = payload(); data.accounts = Array.from({ length: 22 }, (_, i) => account(i + 1, 1));
  data.summary.enabledCount = 22; data.summary.metrics.likes = { delta: 22, comparableCount: 22 };
  const f = harness(data); f.selectMetricExplanation('likes');
  assert.equal((f.node('metricExplanation').innerHTML.match(/data-account-id=/g) || []).length, 10);
  assert.match(f.node('metricExplanation').innerHTML, /此列表不是全部贡献/);
  f.renderMetricExplanation(); assert.equal(f.node('metricExplanation').hidden, false);
  f.selectMetricExplanation('likes'); assert.equal(f.node('metricExplanation').hidden, true);
});

test('ledger shortcut clears local investigations but retains global scope, applied range and comparison', () => {
  const f = harness(); Object.assign(f.state, { board: 'board-a', theme: 'tuantuan', classification: 'slice', period: 'week', compare: true,
    query: 'old search', platform: 'bilibili', enabled: 'paused', collectionFilter: 'missing-profile', page: 4 });
  f.rememberAppliedRequest('period=custom&startDate=2026-09-22&endDate=2026-09-28');
  f.showContributionLedger('likes');
  assert.equal(f.state.query, ''); assert.equal(f.state.platform, 'all'); assert.equal(f.state.enabled, 'active');
  assert.equal(f.state.collectionFilter, 'all'); assert.equal(f.state.sort, 'likes.delta'); assert.equal(f.state.direction, 'desc');
  assert.equal(f.state.board, 'board-a'); assert.equal(f.state.theme, 'tuantuan'); assert.equal(f.state.classification, 'slice');
  assert.equal(f.state.compare, true); assert.equal(f.state.period, 'week'); assert.equal(f.state.view, 'accounts');
  assert.equal(f.state.data.range.startDate, '2026-09-22');
});

test('unapplied custom/comparison drafts or failed new-scope loads cannot silently navigate old data under a new URL', () => {
  for (const change of [f => { f.node('startDate').value = '2026-09-01'; }, f => { f.state.board = 'failed-board'; },
    f => { f.state.theme = 'failed-theme'; }, f => { f.state.start = '2026-09-01'; },
    f => { f.node('compareStart').value = '2026-08-01'; }]) {
    const f = harness(); Object.assign(f.state, { period: 'custom', compare: true, query: 'keep-draft-query' });
    f.node('startDate').value = f.state.start; f.node('endDate').value = f.state.end;
    f.node('compareStart').value = '2026-09-15'; f.node('compareEnd').value = '2026-09-21';
    f.rememberAppliedRequest('applied'); change(f);
    const before = JSON.stringify({ start: f.node('startDate').value, comparison: f.node('compareStart').value, board: f.state.board, theme: f.state.theme });
    f.showContributionLedger('likes');
    assert.equal(f.state.view, 'overview'); assert.equal(f.state.query, 'keep-draft-query');
    assert.equal(JSON.stringify({ start: f.node('startDate').value, comparison: f.node('compareStart').value, board: f.state.board, theme: f.state.theme }), before);
    assert.match(f.node('notice').textContent, /请先应用或恢复未应用的筛选/);
  }
});

test('explanation actions cannot run during a newer range request or trigger collector/network work', () => {
  const f = harness(); f.state.busy = true;
  f.selectMetricExplanation('likes'); assert.equal(f.state.explanationKey, null);
  f.showContributionLedger('likes'); assert.equal(f.state.view, 'overview');
  f.state.busy = false; f.selectMetricExplanation('nonexistent'); assert.equal(f.state.explanationKey, null);
  f.selectMetricExplanation('posts'); assert.match(f.node('metricExplanation').innerHTML, /不等于本期新增发布量/);
});
