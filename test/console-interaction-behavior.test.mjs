import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

function fixture(url = 'http://127.0.0.1:4188/?theme=ghost&classification=unknown') {
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', textContent: '', hidden: false, open: false, showModal() { this.open = true; }, setAttribute() {}, insertAdjacentHTML(_p, html) { this.innerHTML += html; } }); return nodes.get(id); };
  const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8').replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '');
  // rangeFor closes over the imported module's real clock, not the VM's
  // beijingToday override. Pin both to keep this fixture valid after midnight.
  const context = { ...model, beijingToday: () => '2026-09-26', rangeFor: (period, end = '2026-09-26') => model.rangeFor(period, end), fmt: model.formatNumber, URL, URLSearchParams, Intl, Date, structuredClone, AbortController,
    fetch: async () => { throw new Error('test network failure'); },
    location: { href: url }, document: { getElementById: node, querySelector: node, querySelectorAll: () => [] }, history: { replaceState() {} } };
  runInNewContext(`${source}\nthis.subject={state,renderCatalog,chartMarkup,selectedDates,setupDates,load,renderAccounts,collectionOnDate,appliedRange,openAccount,renderTrend,setView};`, context);
  context.subject.state.data = { boards: [], themeSummary: { items: [{ key: 'all', count: 0 }], }, classificationSummary: { items: [{ key: 'all', count: 0 }] }, range: { startDate: '2026-09-26', endDate: '2026-09-26' } };
  return { ...context.subject, node, setFetch: (value) => { context.fetch = value; } };
}

test('invalid scope remains visibly invalid instead of being relabeled as all', () => {
  const f = fixture();
  f.renderCatalog();
  assert.equal(f.state.theme, 'ghost');
  assert.equal(f.node('themeSelect').value, 'ghost');
  assert.match(f.node('themeSelect').innerHTML, /无效主题/);
  assert.match(f.node('notice').textContent, /未识别的筛选值/);
});

test('chart keeps points but breaks lines across changed cohort or unreliable delta', () => {
  const f = fixture('http://127.0.0.1:4188/');
  f.state.metric = 'followers';
  const html = f.chartMarkup([
    { date: '2026-09-24', followersDelta: 1, followersDeltaCohortKey: 'a', followersDeltaReliable: true },
    { date: '2026-09-25', followersDelta: 2, followersDeltaCohortKey: 'b', followersDeltaReliable: true },
    { date: '2026-09-26', followersDelta: 3, followersDeltaCohortKey: 'b', followersDeltaReliable: false },
  ], 'followersDelta');
  assert.equal((html.match(/<circle/g) || []).length, 3);
  assert.match(html, /M[\d.,-]+,[\d.,-]+/);
  assert.doesNotMatch(html, /L[\d.,-]+,[\d.,-]+ L[\d.,-]+,[\d.,-]+/);
});

test('single-account detail without cohort remains connected and uses the requested metric label', () => {
  const f = fixture('http://127.0.0.1:4188/');
  const html = f.chartMarkup([{ date: '2026-09-25', followersDelta: 1 }, { date: '2026-09-26', followersDelta: 2 }], 'followersDelta', [], 'followers', { singleAccount: true });
  assert.match(html, /粉丝每日变化/);
  assert.match(html, /L[\d.,-]+,[\d.,-]+/);
});

test('comparison dates edited in controls are copied into state before request validation', () => {
  const f = fixture('http://127.0.0.1:4188/?period=day&compare=1&compareStart=2026-09-20&compareEnd=2026-09-21');
  f.node('startDate').value = '2026-09-26'; f.node('endDate').value = '2026-09-26';
  f.node('compareStart').value = '2026-09-18'; f.node('compareEnd').value = '2026-09-19';
  f.state.compare = true; f.state.period = 'day';
  f.selectedDates();
  assert.equal(f.state.compareStart, '2026-09-18');
  assert.equal(f.state.compareEnd, '2026-09-19');
});

test('cohort transition starts a new segment and retains the next comparable connection', () => {
  const f = fixture('http://127.0.0.1:4188/');
  const html = f.chartMarkup(['a', 'b', 'b'].map((cohort, i) => ({ date: `2026-09-${24 + i}`, followersDelta: i + 1, followersDeltaCohortKey: cohort, followersDeltaReliable: true })), 'followersDelta');
  const path = html.match(/<path d="([^"]*)"/)[1];
  assert.equal((path.match(/M/g) || []).length, 2);
  assert.equal((path.match(/L/g) || []).length, 1);
});

test('unequal comparison periods share a common day-index horizontal scale', () => {
  const f = fixture('http://127.0.0.1:4188/');
  const points = [1, 2, 3, 4].map((n) => ({ date: `2026-09-${20 + n}`, followersDelta: n }));
  const html = f.chartMarkup(points, 'followersDelta', points.slice(0, 2));
  const x = [...html.matchAll(/<circle cx="([^"]+)"/g)].map(match => Number(match[1]));
  assert.equal(x.length, 6); assert.equal(x[0], x[4]); assert.equal(x[1], x[5]);
  assert.ok(x[5] < x[3], 'short comparison must stop before the longer period ends');
});

test('failed request and later ledger rendering keep the applied dates and sampling coverage', async () => {
  const f = fixture('http://127.0.0.1:4188/');
  f.state.data.range = { startDate: '2026-09-20', endDate: '2026-09-20' };
  f.state.data.accounts = [];
  f.state.period = 'custom'; f.node('startDate').value = '2026-09-21'; f.node('endDate').value = '2026-09-21';
  f.node('exportButton').disabled = false;
  await f.load(); f.renderAccounts();
  assert.equal(f.node('exportButton').disabled, true);
  assert.match(f.node('notice').textContent, /test network failure/);
  assert.match(f.node('accountCount').textContent, /2026-09-20 至 2026-09-20/);
  assert.equal(f.collectionOnDate({ collection: { date: '2026-09-20', profileObserved: true } }).profileObserved, true);
  assert.equal(f.appliedRange().end, '2026-09-20');
});

test('date validation failure disables export before any network request', async () => {
  const f = fixture('http://127.0.0.1:4188/');
  f.state.period = 'custom'; f.node('startDate').value = '2026-09-25'; f.node('endDate').value = '2026-09-24';
  f.node('exportButton').disabled = false;
  await f.load();
  assert.equal(f.node('exportButton').disabled, true);
  assert.match(f.node('notice').textContent, /有效日期/);
});

test('account drawer request and visible period agree after a failed draft date change', async () => {
  const f = fixture('http://127.0.0.1:4188/');
  f.state.data.range = { startDate: '2026-09-20', endDate: '2026-09-20' };
  f.state.start = f.state.end = '2026-09-21';
  const account = { id: 1, label: '测试', platform: 'douyin', boards: [], trend: [], metrics: Object.fromEntries(['followers', 'likes', 'posts'].map(key => [key, { value: 3, delta: 1 }])) };
  f.state.data.accounts = [account];
  let request;
  f.setFetch(async path => { request = path; return { ok: true, json: async () => ({ account }) }; });
  await f.openAccount(1);
  assert.match(request, /startDate=2026-09-20&endDate=2026-09-20/);
  assert.match(f.node('dialogBody').innerHTML, /逐日变化明细 · 2026-09-20 至 2026-09-20/);
  assert.doesNotMatch(f.node('dialogBody').innerHTML, /2026-09-21/);
});

test('comparison axis uses day indices and both actual ranges when comparison is longer', () => {
  const f = fixture('http://127.0.0.1:4188/');
  const points = [20, 21, 22, 23].map(day => ({ date: `2026-09-${day}`, followersDelta: day, followersComparableCount: 1 }));
  f.state.data = { range: { startDate: '2026-09-20', endDate: '2026-09-21' }, summary: { trend: points.slice(0, 2), enabledCount: 1 }, comparison: { range: { startDate: '2026-09-20', endDate: '2026-09-23' }, summary: { trend: points } } };
  f.renderTrend();
  assert.match(f.node('chartAxis').innerHTML, /第 1 天/);
  assert.match(f.node('chartAxis').innerHTML, /第 4 天/);
  assert.match(f.node('chartAxis').innerHTML, /2026-09-20–2026-09-21/);
  assert.match(f.node('chartAxis').innerHTML, /2026-09-20–2026-09-23/);
});

test('account route initialization does not clamp saved page before data is loaded', () => {
  const f = fixture('http://127.0.0.1:4188/?page=4#accounts');
  f.state.data = null;
  f.setView('accounts', { renderData: false });
  assert.equal(f.state.page, 4);
  f.renderAccounts(); assert.equal(f.state.page, 4);
  f.state.data = { range: { startDate: '2026-09-26', endDate: '2026-09-26' }, accounts: [] };
  f.setView('accounts', { renderData: false });
  assert.equal(f.state.page, 4, 'history navigation must not clamp against the previous scope');
  f.renderAccounts(); assert.equal(f.state.page, 1, 'real empty results do clamp normally');
});
