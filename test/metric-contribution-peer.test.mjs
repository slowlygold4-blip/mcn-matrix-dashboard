import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

// Independent fixtures call the real model/UI. No network, database,
// collection request, production changes or substitute contribution formula.
function account(id, delta, { enabled = true, theme = 'tuantuan', label = `账号${id}` } = {}) {
  const metric = { value: 100, delta, comparable: delta !== null, dailyComparable: delta !== null };
  return { id, label, enabled, platform: 'douyin', publicId: `id${id}`, boards: [], trend: [], status: {}, collection: {},
    classification: { theme: { key: theme, label: theme === 'tuantuan' ? '团团' : '其他主题' }, labels: [] },
    metrics: { followers: { ...metric }, likes: { ...metric }, posts: { ...metric },
      estimatedPlays: { ...metric, delta: delta === null ? null : delta * 100 } } };
}
function data(accounts = [account(1, 10), account(2, -3), account(3, 0), account(4, null)]) {
  const active = accounts.filter(a => a.enabled);
  const eligible = active.filter(a => a.metrics.likes.comparable);
  const delta = eligible.length ? eligible.reduce((sum, a) => sum + a.metrics.likes.delta, 0) : null;
  const metric = { delta, comparableCount: eligible.length };
  return { accounts, period: 'custom', range: { startDate: '2026-09-22', endDate: '2026-09-28' },
    theme: 'tuantuan', classification: 'slice', selectedBoard: { name: '测试矩阵' },
    themeSummary: { items: [{ key: 'tuantuan', label: '团团' }] },
    classificationSummary: { items: [{ key: 'slice', label: '切片' }] },
    summary: { enabledCount: active.length, metrics: { likes: { ...metric }, followers: { ...metric }, posts: { ...metric },
      estimatedPlays: { ...metric, delta: delta === null ? null : delta * 100 } } } };
}
const contributions = (payload, key = 'likes') => model.buildMetricContributions(payload, key);

test('peer contributions: positive, negative and measured zero remain distinct from unknown', () => {
  const result = contributions(data());
  assert.equal(result.reconciled, true); assert.equal(result.delta, 7);
  assert.equal(result.enabledCount, 4); assert.equal(result.comparableCount, 3); assert.equal(result.missingCount, 1);
  assert.deepEqual(result.rows.map(r => r.delta), [10, -3, 0]);
  const missing = contributions(data([account(1, null)]));
  assert.equal(missing.reconciled, true); assert.equal(missing.delta, null); assert.equal(missing.rows.length, 0);
  const zero = contributions(data([account(1, 0)])); assert.equal(zero.delta, 0); assert.equal(zero.comparableCount, 1);
});

test('peer contributions: paused accounts never leak into a headline or missing denominator', () => {
  const payload = data([account(1, 10), account(2, 99999999, { enabled: false })]);
  const before = JSON.stringify(payload), result = contributions(payload);
  assert.equal(result.reconciled, true); assert.equal(result.delta, 10); assert.equal(result.enabledCount, 1);
  assert.equal(JSON.stringify(payload), before, 'input must remain unchanged');
});

test('peer contributions: multiple board memberships and secondary labels count once under the unique theme', () => {
  const payload = data([account(1, 10), account(2, -3, { theme: 'streamers' })]);
  payload.accounts[0].boards = [{ name: '团团' }, { name: '抖音主播' }, { name: '团团' }];
  payload.accounts[0].classification.labels = [{ key: 'ai' }, { key: 'slice' }];
  const result = contributions(payload);
  assert.equal(result.reconciled, true); assert.equal(result.rows.length, 2);
  assert.deepEqual(result.groups.map(g => [g.key, g.count, g.delta]), [['tuantuan', 1, 10], ['streamers', 1, -3]]);
});

test('peer contributions: duplicate or invalid active target identities fail closed, not silently deduplicated', () => {
  for (const id of [1, '2', 0, -1, NaN, 1.5]) {
    const payload = data(); payload.accounts[1].id = id;
    assert.equal(contributions(payload).reconciled, false, String(id));
  }
});

test('peer contributions: malformed counts, non-integer deltas and summary disagreement fail closed', () => {
  for (const value of ['10', true, undefined, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const payload = data(); payload.accounts[0].metrics.likes.delta = value;
    assert.equal(contributions(payload).reconciled, false, String(value));
  }
  for (const mutate of [d => d.summary.enabledCount++, d => d.summary.metrics.likes.comparableCount++,
    d => d.summary.metrics.likes.delta++, d => d.summary.metrics.likes.delta = null]) {
    const payload = data(); mutate(payload); assert.equal(contributions(payload).reconciled, false);
  }
});

test('peer contributions: a day metric cannot promote a non-daily observation window', () => {
  const payload = data(); payload.period = 'day'; payload.accounts[0].metrics.likes.dailyComparable = false;
  assert.equal(contributions(payload).reconciled, false);
  payload.summary.metrics.likes.delta = -3; payload.summary.metrics.likes.comparableCount = 2;
  const result = contributions(payload); assert.equal(result.reconciled, true); assert.equal(result.missingCount, 2);
});

test('peer contributions: estimates reconcile both account-level and headline source likes', () => {
  assert.equal(contributions(data(), 'estimatedPlays').delta, 700);
  for (const mutate of [
    d => d.accounts[0].metrics.estimatedPlays.delta++,
    d => d.accounts[0].metrics.likes.comparable = false,
    d => d.summary.metrics.likes.delta++,
    d => d.summary.metrics.likes.comparableCount++,
  ]) { const payload = data(); mutate(payload); assert.equal(contributions(payload, 'estimatedPlays').reconciled, false); }
});

test('peer contributions: extreme but valid values are not suppressed by a subjective threshold', () => {
  const payload = data([account(1, 31476997)]);
  const result = contributions(payload, 'estimatedPlays'); assert.equal(result.reconciled, true);
  assert.equal(result.delta, 3147699700); assert.equal(result.rows.length, 1);
});

function harness() {
  const nodes = new Map(), controls = new Map();
  const document = { activeElement: null, querySelectorAll: () => [...controls.values()] };
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, innerHTML: '', textContent: '', hidden: false, open: false, value: '',
      attributes: {}, dataset: {}, isConnected: true, classList: { toggle() {}, add() {}, remove() {} },
      setAttribute(k, v) { this.attributes[k] = String(v); }, focus(options) { document.activeElement = this; this.focusOptions = options; },
      scrollIntoView(options) { this.scrollOptions = options; } });
    return nodes.get(id);
  };
  for (const key of Object.keys(model.METRICS)) {
    const n = node(`trigger-${key}`); n.dataset.metricExplanation = key; controls.set(key, n);
  }
  document.getElementById = node;
  document.querySelector = selector => selector.includes('data-metric-explanation=')
    ? controls.get(/data-metric-explanation="([^"]+)"/.exec(selector)?.[1]) : node(selector);
  const location = new URL('http://127.0.0.1:4188/?period=custom&start=2026-09-22&end=2026-09-28&theme=tuantuan&classification=slice&page=2&q=局部查询#overview');
  const context = { ...model, fmt: model.formatNumber, beijingToday: () => '2026-09-28',
    URL, URLSearchParams, Intl, Date, AbortController, document, location,
    history: { replaceState(_a, _b, url) { location.href = String(url); } },
    window: { matchMedia: () => ({ matches: true }) },
    fetch: async () => { throw new Error('Unexpected network'); } };
  const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8')
    .replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '');
  runInNewContext(`${source}\nthis.subject={state,renderMetricExplanation,selectMetricExplanation,showContributionLedger,rememberAppliedRequest};`, context);
  context.subject.state.data = data();
  context.subject.state.board = '测试矩阵';
  node('startDate').value = context.subject.state.start;
  node('endDate').value = context.subject.state.end;
  context.subject.rememberAppliedRequest('period=custom&startDate=2026-09-22&endDate=2026-09-28&theme=tuantuan');
  return { ...context.subject, node, document, location, controls };
}

test('peer contribution UI: account names, theme labels and loaded scope are escaped, never HTML', () => {
  const f = harness(), payload = f.state.data;
  payload.accounts[0].label = '<img src=x onerror="attack()">';
  payload.accounts[0].classification.theme.label = '<script>attack()</script>';
  payload.selectedBoard.name = '<svg onload="attack()">';
  f.state.explanationKey = 'likes'; f.renderMetricExplanation();
  const html = f.node('metricExplanation').innerHTML;
  assert.doesNotMatch(html, /<img|<script|<svg/); assert.match(html, /&lt;img/); assert.match(html, /&lt;svg/);
  assert.match(html, /data-account-id="1"/); assert.match(html, /未补零/);
});

test('peer contribution UI: corrupted totals expose a warning and hide rankings', () => {
  const f = harness(); f.state.data.summary.metrics.likes.delta = 999; f.state.explanationKey = 'likes';
  f.renderMetricExplanation(); const html = f.node('metricExplanation').innerHTML;
  assert.match(html, /暂不展示贡献排名/); assert.doesNotMatch(html, /data-account-id|<tbody>/);
});

test('peer contribution UI: opening and closing keeps URL intact and returns keyboard focus without animation', () => {
  const f = harness(), original = f.location.href;
  f.selectMetricExplanation('estimatedPlays');
  assert.equal(f.document.activeElement, f.node('metricExplanationTitle'));
  assert.equal(f.node('metricExplanation').scrollOptions.behavior, 'instant');
  assert.match(f.node('metricExplanation').innerHTML, /不是平台实际播放量/);
  assert.match(f.node('metricExplanation').innerHTML, /按当前名单与归属回看历史/);
  f.selectMetricExplanation('estimatedPlays');
  assert.equal(f.document.activeElement, f.controls.get('estimatedPlays'));
  assert.equal(f.node('metricExplanation').hidden, true); assert.equal(f.location.href, original);
});

test('peer contribution UI: the caption uses applied dates and scope rather than in-progress form drafts', () => {
  const f = harness(); f.state.start = '2026-08-01'; f.state.end = '2026-08-31';
  f.state.theme = 'uncommitted-theme'; f.state.board = '尚未应用'; f.state.explanationKey = 'likes';
  f.renderMetricExplanation(); const html = f.node('metricExplanation').innerHTML;
  assert.match(html, /2026-09-22 至 2026-09-28/); assert.match(html, /测试矩阵/);
  assert.doesNotMatch(html, /2026-08-01|uncommitted-theme|尚未应用/);
});

test('peer contribution UI: top rows expose real Beijing baseline and end observation times', () => {
  const f = harness(), first = f.state.data.accounts[0];
  for (const key of ['likes', 'estimatedPlays']) {
    first.metrics[key].baselineAt = '2026-09-27T14:59:44Z';
    first.metrics[key].currentAt = '2026-10-03T18:10:11.477Z';
  }
  f.state.explanationKey = 'estimatedPlays'; f.renderMetricExplanation();
  const html = f.node('metricExplanation').innerHTML;
  assert.match(html, /北京时间采样端点/);
  assert.match(html, /09\/27 22:59/);
  assert.match(html, /10\/04 02:10/);
  assert.match(html, /基准采样：2026-09-27T14:59:44Z；结束采样：2026-10-03T18:10:11\.477Z/);
});

test('peer contribution UI: all-account navigation preserves service scope and dates, only resets local filters', () => {
  const f = harness(); Object.assign(f.state, { board: '测试矩阵', query: '局部查询', platform: 'bilibili',
    enabled: 'paused', collectionFilter: 'missing-profile', page: 8 });
  f.showContributionLedger('estimatedPlays');
  assert.equal(f.state.view, 'accounts'); assert.equal(f.state.page, 1); assert.equal(f.state.query, '');
  assert.equal(f.state.platform, 'all'); assert.equal(f.state.enabled, 'active'); assert.equal(f.state.collectionFilter, 'all');
  assert.equal(f.state.theme, 'tuantuan'); assert.equal(f.state.classification, 'slice'); assert.equal(f.state.board, '测试矩阵');
  assert.equal(f.state.start, '2026-09-22'); assert.equal(f.state.end, '2026-09-28');
  assert.equal(f.state.sort, 'estimatedPlays.delta'); assert.equal(f.state.direction, 'desc');
  assert.equal(f.document.activeElement, f.node('accountCount'));
  assert.equal(f.location.hash, '#accounts'); assert.equal(f.location.searchParams.get('q'), null);
});

test('peer contribution UI: failed range changes and unsubmitted date drafts cannot be disguised as the loaded ledger', () => {
  for (const change of [
    f => { f.state.start = '2026-08-01'; },
    f => { f.node('endDate').value = '2026-09-26'; },
    f => { f.state.theme = 'failed-load-theme'; },
    f => { f.state.classification = 'failed-load-label'; },
    f => { f.state.period = '30d'; },
  ]) {
    const f = harness(), url = f.location.href;
    f.state.query = '保留局部草稿'; f.state.page = 4; change(f);
    const before = JSON.stringify(f.state), dateDraft = f.node('endDate').value;
    f.showContributionLedger('likes');
    assert.equal(JSON.stringify(f.state), before); assert.equal(f.location.href, url);
    assert.equal(f.node('endDate').value, dateDraft);
    assert.match(f.node('notice').textContent, /先应用或恢复/);
    assert.notEqual(f.document.activeElement, f.node('accountCount'));
  }
});

test('peer contribution UI: pending manual comparison dates stay intact when ledger navigation is refused', () => {
  const f = harness(); f.state.compare = true;
  f.node('compareStart').value = '2026-09-15'; f.node('compareEnd').value = '2026-09-21';
  f.rememberAppliedRequest('committed-comparison'); f.node('compareStart').value = '2026-09-14';
  const url = f.location.href; f.showContributionLedger('likes');
  assert.equal(f.state.view, 'overview'); assert.equal(f.location.href, url);
  assert.equal(f.node('compareStart').value, '2026-09-14');
  assert.match(f.node('notice').textContent, /草稿已保留/);
});
