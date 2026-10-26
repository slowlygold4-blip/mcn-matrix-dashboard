import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

const metricKeys = Object.keys(model.METRICS);
const metricSet = (delta, comparable = true) => Object.fromEntries(metricKeys.map(key => [key, {
  value: key === 'estimatedPlays' ? null : 100, delta: delta === null ? null : delta * (key === 'estimatedPlays' ? 100 : 1),
  comparable, dailyComparable: false, fullPeriodComparable: comparable, currentAt: '2026-09-28T10:00:00.000Z',
}]));
function fixtureData() {
  const range = { startDate: '2026-09-23', endDate: '2026-09-29', end: '2026-09-28T16:34:00.000Z', partialEndDay: true };
  const accounts = [1, 2].map(id => ({ id, label: `作者${id}`, enabled: true, platform: 'douyin', boards: [],
    metrics: metricSet(null, false), status: { lastSuccessAt: '2026-09-28T10:00:00.000Z' }, trend: [] }));
  const metrics = Object.fromEntries(metricKeys.map(key => [key, { delta: key === 'estimatedPlays' ? 500 : 5, comparableCount: 2, fullPeriodComparableCount: 2, deltaReliable: true, deltaCohortKey: 'a'.repeat(64) }]));
  return { period: 'custom', range, accounts, boards: [{ key: '团团', name: '团团' }],
    themeSummary: { items: [] }, classificationSummary: { items: [] },
    summary: { enabledCount: 2, metrics: Object.fromEntries(metricKeys.map(key => [key, { delta: null, comparableCount: 0 }])),
      trend: [{ date: '2026-09-28', followersDelta: 3 }, { date: '2026-09-29', followersDelta: null, followersObservedCount: 0 }] },
    recordedWindow: { baselineDate: '2026-09-22', endDate: '2026-09-28',
      range: { startDate: '2026-09-23', endDate: '2026-09-28' }, metrics,
      accounts: accounts.map((a, index) => ({ id: a.id, metrics: Object.fromEntries(metricKeys.map(key => [key, {
        ...metricSet(index + 2)[key], baselineAt: '2026-09-22T10:00:00.000Z',
        currentAt: '2026-09-28T10:00:00.000Z', comparisonCurrentAt: '2026-09-28T10:00:00.000Z' }])) })), boards: [{ key: '团团', metrics }],
      enabledCount: 2, comparableCount: 2 },
  };
}
const deepFreeze = value => { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(deepFreeze); } return value; };
function browserFixture(data = fixtureData()) {
  const nodes = new Map(), node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', textContent: '', hidden: false, open: false,
      setAttribute() {}, insertAdjacentHTML() {}, showModal() { this.open = true; } });
    return nodes.get(id);
  };
  const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8').replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '');
  const requests = [], downloads = [];
  class BrowserURL extends URL { static createObjectURL(blob) { downloads.push(blob); return 'blob:test'; } static revokeObjectURL() {} }
  const context = { ...model, fmt: model.formatNumber, URL: BrowserURL, URLSearchParams, Intl, Date, AbortController, Blob,
    beijingToday: () => '2026-09-29', rangeFor: period => model.rangeFor(period, '2026-09-29'), setTimeout() {}, clearTimeout() {},
    location: { href: 'http://127.0.0.1:4188/?period=week#overview' }, history: { replaceState() {} },
    document: { getElementById: node, querySelector: node, querySelectorAll: () => [], createElement: () => ({ click() {} }) },
    fetch: async path => { requests.push(path); return { ok: true, json: async () => path.includes('/accounts/') ? { account: data.accounts[0] } : data }; },
  };
  runInNewContext(`${source}\nthis.subject = {state, load, renderCatalog, renderSummary, renderAccounts, renderTrend, openAccount, downloadCsv, setView, effectiveMetricRange};`, context);
  context.subject.state.data = model.projectRecordedWindow(data, { period: 'week' });
  return { ...context.subject, node, requests, downloads, context };
}

test('preset periods keep strict metrics unchanged and expose a separate verified common-window panel', () => {
  const raw = deepFreeze(fixtureData()), projected = model.projectRecordedWindow(raw, { period: 'week' });
  assert.equal(projected, raw);
  const alternative = model.buildRecordedWindowAlternative(raw, { period: 'week' });
  assert.equal(alternative.comparableCount, 2);
  assert.equal(alternative.metrics.followers.delta, 5);
  assert.equal(alternative.metrics.estimatedPlays.delta, 500);
  assert.equal(projected.summary.metrics.followers.delta, null);
  assert.equal(projected.accounts[0].metrics.followers.delta, null);
  assert.equal(projected.boards[0].metrics, undefined);
  assert.equal(projected.range.endDate, '2026-09-29');
});
test('day, custom and explicit comparisons keep strict metrics; since can expose the verified recorded window', () => {
  const raw = fixtureData();
  for (const period of ['day', 'custom']) assert.equal(model.projectRecordedWindow(raw, { period }), raw);
  for (const period of ['week', 'month', '30d']) {
    assert.equal(model.projectRecordedWindow(raw, { period }), raw);
    assert.ok(model.buildRecordedWindowAlternative(raw, { period }));
    assert.equal(model.projectRecordedWindow(raw, { period, compare: true }), raw);
    assert.equal(model.buildRecordedWindowAlternative(raw, { period, compare: true }), null);
  }
  for (const period of ['since']) {
    assert.notEqual(model.projectRecordedWindow(raw, { period }), raw);
    assert.equal(model.projectRecordedWindow(raw, { period, compare: true }), raw);
  }
  const compared = { ...raw, comparison: {} };
  assert.equal(model.projectRecordedWindow(compared, { period: 'week' }), compared);
});
test('missing or invalid common window is not converted to fabricated zero or dates', () => {
  for (const change of [null, {}, { baselineDate: '2026-02-31' }, { endDate: '2026-09-22' }, { range: { startDate: '2026-09-22', endDate: '2026-09-28' } }, { accounts: null }]) {
    const raw = fixtureData(); raw.recordedWindow = change === null ? null : { ...raw.recordedWindow, ...change };
    if (change && Object.keys(change).length === 0) delete raw.recordedWindow.metrics;
    assert.equal(model.projectRecordedWindow(raw, { period: 'week' }), raw);
  }
});
test('a shared window remains available when any single metric has a larger strict cohort', () => {
  const raw = fixtureData();
  const templateAccount = raw.accounts[0], templateWindowAccount = raw.recordedWindow.accounts[0];
  for (let id = 3; id <= 10; id++) raw.accounts.push({ ...templateAccount, id, label: `作者${id}` });
  for (let id = 3; id <= 9; id++) raw.recordedWindow.accounts.push({ ...templateWindowAccount, id });
  raw.recordedWindow.accounts.push({ id: 10, metrics: metricSet(null, false) });
  raw.summary.enabledCount = raw.recordedWindow.enabledCount = 10;
  raw.recordedWindow.comparableCount = 9;
  for (const key of metricKeys) {
    raw.recordedWindow.metrics[key].comparableCount = 9;
    raw.recordedWindow.metrics[key].delta = key === 'estimatedPlays' ? 1900 : 19;
  }
  raw.summary.metrics.followers = { delta: 8, comparableCount: 10 };
  assert.equal(model.buildRecordedWindowAlternative(raw, { period: 'week' })?.comparableCount, 9);
  const f = browserFixture(raw); f.renderCatalog(); f.renderSummary();
  const cards = f.node('kpiGrid').innerHTML.split('<article class="kpi">').slice(1);
  assert.match(cards[0], />\+8</, 'strict follower change remains the card value');
  assert.doesNotMatch(cards[0], /共同采样窗口实测净变化/, 'a strict metric must not be replaced by an alternative');
  assert.match(cards[1], /共同采样窗口实测净变化/, 'a metric without a strict value can show the verified window');
  assert.match(f.node('recordedWindowAlternative').innerHTML, /9\/10 个账号可比/);
});
test('a separate window cannot leak into a strict-period account when the mapping is incomplete', () => {
  const raw = fixtureData(); raw.accounts[1].metrics = metricSet(99); raw.recordedWindow.accounts.pop();
  const projected = model.projectRecordedWindow(raw, { period: 'week' });
  assert.equal(projected, raw);
  assert.equal(projected.accounts[1].metrics.followers.delta, 99);
  assert.equal(model.sortAccounts(projected.accounts, 'followers.delta', 'desc')[0].id, 2);
  assert.equal(model.sortAccounts(projected.accounts, 'followers.delta', 'asc')[0].id, 2);
});
test('common-window contribution sums reconcile independently of selected-period metrics', () => {
  const projected = fixtureData(), alternative = model.buildRecordedWindowAlternative(projected, { period: 'week' });
  for (const key of metricKeys) {
    const window = { ...projected, summary: { ...projected.summary, metrics: projected.recordedWindow.metrics },
      accounts: projected.accounts.map(account => ({ ...account, metrics: projected.recordedWindow.accounts.find(row => row.id === account.id).metrics })) };
    const contribution = model.buildMetricContributions(window, key);
    assert.equal(contribution.reconciled, true);
    assert.equal(contribution.delta, alternative.metrics[key].delta);
  }
});
test('summary visibly opens and labels common-window evidence while preserving strict date scope', () => {
  const f = browserFixture(); f.renderCatalog(); f.renderSummary(); f.renderAccounts(); f.renderTrend();
  assert.equal(f.node('recordedWindowAlternative').hidden, false);
  assert.equal(f.node('recordedWindowAlternative').open, true);
  assert.match(f.node('recordedWindowAlternative').innerHTML, /共同采样窗口 · 非完整所选区间/);
  assert.match(f.node('recordedWindowAlternative').innerHTML, /2026-09-22 → 2026-09-28 · 2\/2 个账号可比/);
  assert.match(f.node('recordedWindowAlternative').innerHTML, /主卡、台账、账号明细与导出仍严格按所选日期/);
  assert.match(f.node('pageSubtitle').textContent, /2026-09-23 至 2026-09-29/);
  assert.match(f.node('kpiGrid').innerHTML, /0\/2 可比/);
  assert.match(f.node('kpiGrid').innerHTML, /另有共同采样窗口实测净变化/);
  assert.match(f.node('kpiGrid').innerHTML, /2026-09-22 → 2026-09-28 · 同一批 2\/2 个账号 · 非完整所选周期/);
  assert.match(f.node('kpiGrid').innerHTML, /\+5/);
  assert.match(f.node('kpiGrid').innerHTML, /\+500/);
  assert.doesNotMatch(f.node('kpiGrid').innerHTML, /已记录时段净变化/);
  assert.match(f.node('kpiGrid').innerHTML, /末日 2026-09-29 该项无有效观测/,
    'the actual selected-period value stays unknown rather than inheriting the earlier common-window change');
});
test('actual summary and ledger show recorded-window evidence while trends retain requested-day gaps', () => {
  const f = browserFixture(); f.renderCatalog(); f.renderSummary(); f.renderAccounts(); f.renderTrend();
  assert.match(f.node('pageSubtitle').textContent, /2026-09-23 至 2026-09-29/);
  assert.equal(f.node('recordedWindowAlternative').hidden, false);
  assert.equal((f.node('kpiGrid').innerHTML.match(/已记录时段净变化/g) || []).length, 0);
  assert.match(f.node('kpiGrid').innerHTML, /选中末日新采覆盖待核验/);
  assert.match(f.node('accountCount').textContent, /2026-09-23 至 2026-09-29/);
  assert.match(f.node('trendContext').innerHTML, /每日净变化不是观测总量的简单差额/);
  assert.match(f.node('trendEvidence').innerHTML, /2026-09-29/);
});
test('actual drawer requests and retains the exact selected-period dates', async () => {
  const f = browserFixture(); await f.openAccount(1);
  assert.match(f.requests.at(-1), /startDate=2026-09-23&endDate=2026-09-29/);
  assert.doesNotMatch(f.node('dialogBody').innerHTML, /已记录变化/);
  assert.equal(f.state.period, 'week');
});
test('CSV export does not substitute the independent window for strict selected-period metrics', async () => {
  const f = browserFixture(); f.downloadCsv();
  const text = await f.downloads[0].text();
  assert.doesNotMatch(text, /已记录时段净变化（非完整所选区间）/);
  assert.match(text, /"2026-09-23","2026-09-29"/);
});
test('account drawer keeps its own exact-period observation separate from the common-window panel', async () => {
  const data = fixtureData(); data.accounts[0].metrics = metricSet(77);
  data.recordedWindow.accounts[0].metrics = metricSet(null, false);
  const f = browserFixture(data); await f.openAccount(1);
  assert.match(f.node('dialogBody').innerHTML, /作品存量净变化/);
  assert.match(f.node('dialogBody').innerHTML, /title="77"|>\+77</);
  assert.match(f.node('dialogBody').innerHTML, /2026-09-23 至 2026-09-29/);
});
test('changing to topic view hides account recorded-window notice', () => {
  const f = browserFixture(); f.renderCatalog(); f.state.data = null; f.setView('topics');
  assert.equal(f.node('recordedWindowNotice').hidden, true);
});
test('no-window explanation returns when navigating back from topics to an account view', () => {
  const data = fixtureData(); data.recordedWindow = null;
  const f = browserFixture(data);
  f.state.data = data; f.renderCatalog();
  assert.equal(f.node('recordedWindowNotice').hidden, false);
  f.setView('topics'); assert.equal(f.node('recordedWindowNotice').hidden, true);
  f.setView('accounts', { renderData: false });
  assert.equal(f.node('recordedWindowNotice').hidden, false);
  assert.match(f.node('recordedWindowNotice').textContent, /不是 0/);
});
