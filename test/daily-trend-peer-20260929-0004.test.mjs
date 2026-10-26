import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

// Independent user-visible behavior audit. The real model and renderer execute;
// only DOM/HTTP/clock/download boundaries are substituted. No production writes.
const response = body => ({ ok: true, status: 200, json: async () => body });
function point(date, delta, cohort = 'same-members', reliable = true, count = 1) {
  return { date, followersDelta: delta, followersDeltaCohortKey: cohort, followersDeltaReliable: reliable,
    followersComparableCount: count, likesDelta: delta == null ? null : delta * 2,
    likesDeltaCohortKey: cohort, likesDeltaReliable: reliable, likesComparableCount: count,
    estimatedPlaysDelta: delta == null ? null : delta * 200, estimatedPlaysDeltaCohortKey: cohort,
    estimatedPlaysDeltaReliable: reliable, postsDelta: delta == null ? null : Math.sign(delta),
    postsDeltaCohortKey: cohort, postsDeltaReliable: reliable, postsComparableCount: count };
}
function insight({ period = 'day', start = '2026-09-29', end = start, points = [], label = '已应用作者' } = {}) {
  const metrics = Object.fromEntries(Object.keys(model.METRICS).map(key => [key,
    { value: 1234, delta: key === 'estimatedPlays' ? 700 : 7, comparable: true, dailyComparable: true, comparableCount: 1 }]));
  return { period, range: { startDate: start, endDate: end }, accounts: [{ id: 1, label,
    platform: 'douyin', enabled: true, boards: [], metrics, status: {}, classification: { theme: { key: 'tuantuan', label: '团团' }, labels: [] } }],
    boards: [], theme: 'tuantuan', classification: 'ai-remix', selectedBoard: { key: 'matrix', name: '原矩阵' },
    summary: { enabledCount: 1, metrics, trend: points },
    themeSummary: { items: [{ key: 'all', label: '全部主题', count: 1 }, { key: 'tuantuan', label: '团团', count: 1 }] },
    classificationSummary: { items: [{ key: 'all', label: '全部内容', count: 1 }, { key: 'ai-remix', label: 'AI 二创', count: 1 }] } };
}
function fixture() {
  const nodes = new Map(), requests = [], blobs = [], downloads = [];
  let today = '2026-09-29';
  const document = { hidden: false, activeElement: null, querySelectorAll: () => [], hasFocus: () => true,
    addEventListener() {}, removeEventListener() {} };
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { id, value: '', innerHTML: '', textContent: '', hidden: id === 'importPreview',
      open: false, checked: false, disabled: false, files: [], dataset: {}, isConnected: true, attributes: {},
      scrollLeft: 0, scrollTop: 0, classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(k, v) { this.attributes[k] = v; }, getAttribute(k) { return this.attributes[k]; },
      querySelector: () => null, querySelectorAll: () => [], closest: () => null, matches: () => false,
      contains(other) { return other === this; }, addEventListener() {},
      insertAdjacentHTML(_where, html) { this.innerHTML += html; }, focus() { document.activeElement = this; },
      showModal() { this.open = true; }, close() { this.open = false; } });
    return nodes.get(id);
  }
  document.getElementById = node; document.querySelector = node; document.body = node('body');
  document.documentElement = node('html'); document.activeElement = document.body;
  document.createElement = () => ({ click() { downloads.push({ href: this.href, filename: this.download }); } });
  class FixtureURL extends URL { static createObjectURL(blob) { blobs.push(blob); return 'blob:fixture'; } static revokeObjectURL() {} }
  const location = new URL('http://local/?theme=tuantuan&classification=ai-remix&board=matrix#overview');
  let handler = () => insight({ points: [point('2026-09-28', 9), point('2026-09-29', 7)] });
  const context = { ...model, fmt: model.formatNumber, Date, Intl, URL: FixtureURL, URLSearchParams, Blob, AbortController,
    beijingToday: () => today, rangeFor: (period, end = today) => model.rangeFor(period, end),
    document, location, history: { replaceState(_a, _b, value) { location.href = String(value); } },
    window: { matchMedia: () => ({ matches: true }), addEventListener() {}, scrollTo() {}, scrollX: 0, scrollY: 0 },
    setTimeout() { return 1; }, clearTimeout() {}, fetch: async (path, options) => {
      assert.equal(options?.method || 'GET', 'GET'); if (path === '/api/monitoring-status') return response({});
      requests.push(path); return response(await handler(path));
    } };
  const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8')
    .replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '');
  runInNewContext(`${source}\nthis.subject={state,load,refreshSnapshot,setupDates,bind,renderTrend,renderSummary,renderAccounts,chartMarkup,downloadCsv,rememberAppliedRequest,appliedRange,openAccount,automaticRead,automaticApply,automaticScopeKey};`, context);
  const f = context.subject; f.setupDates(); f.bind();
  return { ...f, node, requests, blobs, downloads, document, location, setHandler(fn) { handler = fn; }, setToday(value) { today = value; } };
}
// 2026-10-01 user-selected dark/lime theme: match the exact primary theme token.
// Cohort, gap and measured-point assertions below remain unchanged.
function primaryPath(html) { return /<path d="([^"]*)"[^>]*stroke="var\(--blue\)"/.exec(html)?.[1] || ''; }

test('daily trend peer: single day expands only background points, preserving selected-day KPI and source data', () => {
  const data = insight({ points: [point('2026-08-30', 9999), point('2026-08-31', 0), point('2026-09-28', -2), point('2026-09-29', 7), point('2026-09-30', 9999)] });
  const before = JSON.stringify(data), result = model.buildTrendView(data, { period: 'day', key: 'followers' });
  assert.equal(result.background, true); assert.equal(result.start, '2026-08-31'); assert.equal(result.end, '2026-09-29');
  assert.equal(result.points.length, 30); assert.equal(result.points[0].followersDelta, 0);
  assert.equal(result.points.at(-2).followersDelta, -2); assert.equal(result.points.at(-1).followersDelta, 7);
  assert.equal(JSON.stringify(data), before); assert.equal(data.summary.metrics.followers.delta, 7);
});

test('daily trend peer: historical day is anchored to selected day, never wall-clock today', () => {
  const data = insight({ start: '2026-09-12', points: [point('2026-09-11', 0), point('2026-09-12', -7), point('2026-09-29', 9000)] });
  const result = model.buildTrendView(data, { period: 'day', key: 'followers' });
  assert.equal(result.start, '2026-08-14'); assert.equal(result.end, '2026-09-12'); assert.equal(result.points.length, 30);
  assert.equal(result.points.at(-1).followersDelta, -7); assert.ok(result.points.every(p => p.date <= '2026-09-12'));
});

test('daily trend peer: custom single-day and applied multi-day scopes never grow to a background month', () => {
  for (const [apiPeriod, appliedPeriod, start, end] of [['custom','custom','2026-09-29','2026-09-29'], ['custom','week','2026-09-23','2026-09-29'], ['day','custom','2026-09-29','2026-09-29']]) {
    const result = model.buildTrendView(insight({ period: apiPeriod, start, end, points: [point('2026-08-31', 999), point(end, 7)] }), { period: appliedPeriod, key: 'followers' });
    assert.equal(result.background, false); assert.equal(result.start, start); assert.equal(result.end, end);
    assert.ok(result.points.every(p => p.date >= start && p.date <= end));
  }
});

test('daily trend peer: real comparison retains separate intended dates and does not compare one day with 30', () => {
  const data = insight({ points: [point('2026-09-01', 999), point('2026-09-29', 7)] });
  data.comparison = { range: { startDate: '2026-09-28', endDate: '2026-09-28' }, summary: { trend: [point('2026-09-01', 999), point('2026-09-28', -1)] } };
  const result = model.buildTrendView(data, { period: 'day', key: 'followers' });
  assert.equal(result.background, false); assert.equal(result.points.length, 1); assert.equal(result.comparison.length, 1);
  assert.equal(result.comparison[0].date, '2026-09-28'); assert.equal(result.comparison[0].followersDelta, -1);
});

test('daily trend peer: omitted dates become unknown observations, never zero or a borrowed endpoint', () => {
  const result = model.buildTrendView(insight({ points: [point('2026-09-27', 0), point('2026-09-29', -7)] }), { period: 'day', key: 'followers' });
  const missing = result.points.find(p => p.date === '2026-09-28');
  assert.equal(model.numeric(missing.followersDelta), null); assert.notEqual(missing.followersComparableCount, 0);
  const f = fixture(), html = f.chartMarkup(result.points, 'followersDelta');
  assert.doesNotMatch(primaryPath(html), /L/); assert.match(html, /2026-09-27 · 0/); assert.match(html, /2026-09-29 · -7/);
});

test('daily trend peer: equal member counts cannot connect different or unknown member cohorts', () => {
  const f = fixture();
  for (const cohorts of [['roster-a','roster-b'], [null,null], ['roster-a',null]]) {
    const html = f.chartMarkup([point('2026-09-28', 0, cohorts[0]), point('2026-09-29', -7, cohorts[1])], 'followersDelta');
    assert.doesNotMatch(primaryPath(html), /L/); assert.match(html, /2026-09-29 · -7/);
  }
  assert.match(primaryPath(f.chartMarkup([point('2026-09-28', 0), point('2026-09-29', -7)], 'followersDelta')), /L/);
});

test('daily trend peer: chart cannot connect over a missing calendar day even when cohort matches', () => {
  const f = fixture(); const html = f.chartMarkup([point('2026-09-27', 0), point('2026-09-29', -7)], 'followersDelta');
  assert.doesNotMatch(primaryPath(html), /L/);
});

test('daily trend peer: renderer uses one scoped response; table, title and selected-day export remain distinguishable', async () => {
  const f = fixture(); await f.load();
  assert.equal(f.requests.length, 1); const query = new URL(f.requests[0], f.location).searchParams;
  assert.equal(query.get('theme'), 'tuantuan'); assert.equal(query.get('classification'), 'ai-remix'); assert.equal(query.get('board'), 'matrix');
  assert.match(f.node('trendEvidence').innerHTML, /2026-08-31/); assert.match(f.node('trendEvidence').innerHTML, /2026-09-29/);
  assert.match(f.node('trendCaption').textContent, /30|背景/);
  assert.match(f.node('trendContext').innerHTML, /上方 KPI 仅统计 2026-09-29/);
  assert.match(f.node('trendChart').innerHTML, /aria-label="[^"]*近30天背景/);
  assert.equal(f.appliedRange().start, '2026-09-29'); assert.equal(f.appliedRange().end, '2026-09-29');
  f.downloadCsv(); assert.equal(f.downloads.length, 1); assert.match(f.downloads[0].filename, /2026-09-29_2026-09-29/);
  const csv = await f.blobs[0].text(); assert.match(csv, /"2026-09-29","2026-09-29"/); assert.doesNotMatch(csv, /2026-08-31/);
});

test('daily trend peer: metric interaction and invalid date draft cannot relabel applied background or steal focus', async () => {
  const f = fixture(); await f.load(); const url = f.location.href;
  f.node('startDate').value = '2026-10-01'; f.node('endDate').value = '2026-09-01'; f.node('startDate').focus();
  f.node('compareToggle').checked = true; f.node('compareToggle').onchange();
  f.node('compareStart').value = '2026-09-03'; f.node('compareStart').oninput();
  f.state.metric = 'likes'; f.renderTrend(); f.renderSummary();
  assert.match(f.node('trendCaption').textContent, /30|背景/); assert.match(f.node('trendEvidence').innerHTML, /2026-08-31/);
  assert.doesNotMatch(f.node('chartAxis').innerHTML, /2026-10-01|2026-09-03/); assert.equal(f.location.href, url);
  assert.equal(f.document.activeElement, f.node('startDate')); assert.equal(f.node('startDate').value, '2026-10-01');
});

test('daily trend peer: a late old themed response cannot restore its 30-day background after explicit scope changes', async () => {
  const f = fixture(); let release; f.setHandler(() => new Promise(resolve => { release = resolve; }));
  const old = f.load(); f.state.theme = 'another-theme';
  f.setHandler(() => insight({ points: [point('2026-09-29', 47)], label: '新范围账号' })); await f.load();
  release(insight({ points: [point('2026-09-28', 999999)], label: '旧范围账号' })); await old;
  assert.match(f.node('trendEvidence').innerHTML, /47/); assert.doesNotMatch(f.node('trendEvidence').innerHTML, /999999/);
  assert.equal(f.state.data.accounts[0].label, '新范围账号');
});

test('daily trend peer: low coverage retains measured zero/negative values but marks hollow and does not draw a line', async () => {
  const f = fixture(); f.setHandler(() => insight({ points: [point('2026-09-28', 0, 'same', false, 0), point('2026-09-29', -8, 'same', false, undefined)] }));
  await f.load(); const html = f.node('trendChart').innerHTML, table = f.node('trendEvidence').innerHTML;
  assert.doesNotMatch(primaryPath(html), /L/); assert.match(html, /fill="var\(--panel\)"/);
  assert.match(html, /2026-09-28 · 0 · 部分可比账号/); assert.match(html, /2026-09-29 · -8 · 部分可比账号/);
  assert.match(table, /覆盖不足；不连线/); assert.match(table, /0 \/ 1/);
  const missingRow = table.match(/<tr[^>]*><td>2026-08-31[\s\S]*?<\/tr>/)?.[0];
  assert.ok(missingRow); assert.match(missingRow, /— \/ 1/); assert.doesNotMatch(missingRow, /0 \/ 1/);
});

test('daily trend peer: ambiguous duplicate dates and invalid date text cannot create a plotted observation or HTML', async () => {
  const data = insight({ points: [point('2026-09-28', 1), point('2026-09-28', 99999), point('<img src=x onerror=alert(1)>', 9999999), point('2026-02-30', 77)] });
  const normalized = model.buildTrendView(data, { period: 'day' });
  assert.equal(model.numeric(normalized.points.find(p => p.date === '2026-09-28').followersDelta), null);
  assert.equal(normalized.points.length, 30); assert.ok(normalized.points.every(p => /^\d{4}-\d{2}-\d{2}$/.test(p.date)));
  const f = fixture(); f.setHandler(() => data); await f.load();
  assert.doesNotMatch(f.node('trendChart').innerHTML + f.node('trendEvidence').innerHTML, /<img|onerror|99999/);
  assert.match(f.node('trendEvidence').innerHTML, /同日记录冲突/);
});

test('daily trend peer: an applied comparison flag without comparison payload cannot silently broaden to 30 days', () => {
  const result = model.buildTrendView(insight({ points: [point('2026-09-01', 999), point('2026-09-29', 7)] }), { period: 'day', compare: true });
  assert.equal(result.background, false); assert.equal(result.points.length, 1);
  assert.equal(result.points[0].date, '2026-09-29'); assert.equal(result.comparison.length, 0);
});

test('daily trend peer: future custom input is rejected without reading new evidence or discarding current background', async () => {
  const f = fixture(); await f.load(); const old = f.state.data, chart = f.node('trendChart').innerHTML, calls = f.requests.length;
  f.state.period = 'custom'; f.node('startDate').value = '2026-09-30'; f.node('endDate').value = '2026-10-01';
  await f.load(); assert.equal(f.requests.length, calls); assert.equal(f.state.data, old);
  assert.equal(f.node('trendChart').innerHTML, chart); assert.match(f.node('notice').textContent, /未来|今天/);
});

test('daily trend peer: estimated-play trend never substitutes cumulative actual playback', async () => {
  const f = fixture(); await f.load(); f.state.metric = 'estimatedPlays'; f.renderTrend();
  assert.match(f.node('trendContext').innerHTML, /当日获赞净变化 × 100/); assert.match(f.node('trendContext').innerHTML, /非实际播放量/);
  assert.match(f.node('trendEvidence').innerHTML, /当日观测点赞数（换算基数）/);
  assert.match(f.node('trendChart').innerHTML, /2026-09-29 · 1,400/);
});

test('daily trend peer: single-account detail retains its real adjacent-day curve without invented matrix coverage', async () => {
  const f = fixture(); const data = insight({ period: 'custom', start: '2026-09-26', end: '2026-09-29' });
  f.state.period = 'custom'; f.node('startDate').value = '2026-09-26'; f.node('endDate').value = '2026-09-29';
  f.setHandler(() => data); await f.load();
  // Actual accountTrend API shape deliberately has no aggregate reliability or cohort fields.
  const account = { ...data.accounts[0], trend: [
    { date: '2026-09-26', followers: 100, followersDelta: 0 },
    { date: '2026-09-27', followers: 101, followersDelta: 1 },
    { date: '2026-09-28', followers: null, followersDelta: null },
    { date: '2026-09-29', followers: 104, followersDelta: null },
  ] };
  f.setHandler(() => ({ ...data, account, recentWorks: [] })); await f.openAccount(1);
  const html = f.node('dialogBody').innerHTML, chart = /<svg[\s\S]*?<\/svg>/.exec(html)?.[0];
  assert.ok(chart); assert.equal((primaryPath(chart).match(/L/g) || []).length, 1);
  assert.equal((chart.match(/<circle/g) || []).length, 2);
  assert.doesNotMatch(chart, /覆盖待核验|部分可比账号/);
  assert.match(html, /2026-09-26 至 2026-09-29/); assert.equal(f.node('accountDialog').open, true);
});

test('daily trend peer: background follows an applied midnight refresh while KPI and CSV stay the new single day', async () => {
  const f = fixture(); await f.load(); const scopeKey = f.automaticScopeKey();
  f.setToday('2026-09-30'); f.setHandler(path => {
    const q = new URL(path, f.location).searchParams;
    assert.equal(q.get('period'), 'day'); assert.equal(q.get('endDate'), '2026-09-30');
    return insight({ start: '2026-09-30', points: [point('2026-09-01', 0), point('2026-09-30', 8)] });
  });
  const payload = await f.automaticRead({}); assert.equal(f.automaticApply(payload, { scopeKey }), true);
  assert.match(f.node('trendContext').innerHTML, /2026-09-01 — 2026-09-30/);
  assert.match(f.node('trendContext').innerHTML, /上方 KPI 仅统计 2026-09-30/);
  assert.equal(f.appliedRange().start, '2026-09-30'); f.downloadCsv();
  assert.match(f.downloads.at(-1).filename, /2026-09-30_2026-09-30/);
});

test('daily trend peer: an automatic result cannot replace the read background while a new comparison draft is being edited', async () => {
  const f = fixture(); await f.load(); const scopeKey = f.automaticScopeKey(), previous = f.node('trendEvidence').innerHTML;
  f.setToday('2026-09-30'); f.setHandler(() => insight({ start: '2026-09-30', points: [point('2026-09-30', 700000)] }));
  const payload = await f.automaticRead({});
  f.node('compareToggle').checked = true; f.node('compareToggle').onchange();
  f.node('compareStart').value = '2026-09-03'; f.node('compareStart').oninput(); f.node('compareStart').focus();
  assert.equal(f.automaticApply(payload, { scopeKey }), false);
  assert.equal(f.node('trendEvidence').innerHTML, previous); assert.equal(f.appliedRange().end, '2026-09-29');
  assert.equal(f.node('compareStart').value, '2026-09-03'); assert.equal(f.document.activeElement, f.node('compareStart'));
});
