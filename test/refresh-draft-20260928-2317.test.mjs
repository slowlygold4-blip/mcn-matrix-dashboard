import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

function fixture() {
  const nodes = new Map(), calls = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, value: '', textContent: '', innerHTML: '', hidden: true, open: false,
      dataset: {}, files: [], checked: false, isConnected: true, classList: { toggle() {}, add() {}, remove() {} },
      setAttribute() {}, getAttribute() {}, addEventListener() {}, insertAdjacentHTML() {},
      querySelector() { return null; }, closest() { return null; }, matches() { return false; },
      focus() { document.activeElement = this; }, contains(other) { return this === other; } });
    return nodes.get(id);
  };
  const document = { getElementById: node, querySelector: node, querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {}, hasFocus: () => true, body: node('body'), documentElement: node('html') };
  document.activeElement = document.body;
  const location = new URL('http://matrix.test/?theme=tuantuan&classification=slice&period=week&compare=1&compareStart=2026-09-15&compareEnd=2026-09-21#overview');
  let revision = 0, handler = null;
  const payload = () => ({ revision: ++revision, theme: 'tuantuan', classification: 'slice', boards: [], accounts: [],
    range: { startDate: '2026-09-22', endDate: '2026-09-28' }, summary: { metrics: {}, trend: [] },
    comparison: { range: { startDate: '2026-09-15', endDate: '2026-09-21' }, summary: { metrics: {}, trend: [] } },
    themeSummary: { items: [{ key: 'tuantuan', label: '团团', count: 1 }] },
    classificationSummary: { items: [{ key: 'slice', label: '切片', count: 1 }] } });
  const context = { ...model, fmt: model.formatNumber, Date, URL, URLSearchParams, Intl, AbortController, document, location,
    beijingToday: () => '2026-09-28', rangeFor: p => model.rangeFor(p, '2026-09-28'),
    history: { replaceState(_a, _b, value) { location.href = String(value); } },
    window: { addEventListener() {}, matchMedia: () => ({ matches: true }) },
    fetch: async path => {
      if (path === '/api/monitoring-status') return { ok: true, json: async () => ({}) };
      calls.push(path); if (handler) return handler(path);
      return { ok: true, json: async () => payload() };
    } };
  const source = readFileSync(process.env.MCN_REBUILD_DRAFT_SOURCE || new URL('../public/rebuild.js', import.meta.url), 'utf8')
    .replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '');
  runInNewContext(`${source}\nthis.subject={state,load,refreshSnapshot,bind,setupDates,saveLocation,renderCatalog,renderSummary,renderAccounts,renderTrend,hasUnappliedScope};`, context);
  const f = { ...context.subject, node, calls, location, payload, setHandler(fn) { handler = fn; } };
  f.node('compareStart').value = '2026-09-15'; f.node('compareEnd').value = '2026-09-21';
  f.setupDates(); f.bind(); return f;
}

test('fresh applied evidence and comparison are rendered while manual comparison draft remains unapplied', async () => {
  const f = fixture(); await f.load(); const before = f.state.data.revision, originalUrl = f.location.href;
  f.node('compareStart').value = '2026-09-16'; f.node('compareStart').oninput();
  await f.refreshSnapshot();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1], f.calls[0]);
  assert.equal(f.state.data.revision, before + 1, 'refresh actually adopts fresh evidence');
  assert.equal(f.node('compareStart').value, '2026-09-16');
  assert.equal(f.state.data.comparison.range.startDate, '2026-09-15');
  assert.equal(f.location.href, originalUrl); assert.equal(f.hasUnappliedScope(), true);
  assert.match(f.node('filterBrief').textContent, /2026-09-15 至 2026-09-21/);
  assert.match(f.node('notice').textContent, /已刷新.*未应用.*保留/);
  f.renderAccounts(); f.renderTrend(); f.saveLocation(); assert.equal(f.location.href, originalUrl);
});

test('invalid main date, period and scope drafts do not block applied refresh or leak into rendered range', async () => {
  const f = fixture(); await f.load(); const originalUrl = f.location.href;
  Object.assign(f.state, { period: 'custom', start: '2099-01-01', end: '2099-01-02', board: 'draft-board', theme: 'draft-theme', classification: 'draft-tag' });
  f.node('periodSelect').value = 'custom'; f.node('startDate').value = ''; f.node('endDate').value = '2099-01-02';
  f.node('compareStart').value = ''; f.node('compareEnd').value = '2099-01-01';
  await f.refreshSnapshot();
  assert.equal(f.calls[1], f.calls[0]); assert.equal(f.state.data.revision, 2);
  assert.equal(f.state.period, 'custom'); assert.equal(f.state.theme, 'draft-theme');
  assert.equal(f.node('startDate').value, ''); assert.equal(f.node('endDate').value, '2099-01-02');
  assert.equal(f.node('compareStart').value, ''); assert.equal(f.node('compareEnd').value, '2099-01-01');
  assert.equal(f.node('themeSelect').value, 'draft-theme'); assert.equal(f.node('classificationSelect').value, 'draft-tag');
  assert.match(f.node('pageSubtitle').textContent, /团团.*切片.*2026-09-22 至 2026-09-28/);
  assert.doesNotMatch(f.node('scopeSummary').innerHTML, /draft-/); assert.equal(f.location.href, originalUrl);
  f.renderCatalog(); f.renderSummary(); f.renderAccounts(); f.renderTrend();
  assert.equal(f.location.href, originalUrl); assert.doesNotMatch(f.node('pageSubtitle').textContent, /2099|draft-/);
});

test('draft edits made after refresh dispatch are preserved with new evidence and no implicit apply', async () => {
  const f = fixture(); await f.load(); let finish;
  f.setHandler(() => new Promise(resolve => { finish = resolve; }));
  const refresh = f.refreshSnapshot(); const oldUrl = f.location.href;
  f.node('compareEnd').value = '2026-09-20'; f.node('compareEnd').oninput();
  finish({ ok: true, json: async () => f.payload() }); await refresh;
  assert.equal(f.state.data.revision, 2); assert.equal(f.node('compareEnd').value, '2026-09-20');
  assert.equal(f.location.href, oldUrl); assert.equal(f.hasUnappliedScope(), true);
});

test('explicit apply remains the only action that commits a comparison draft', async () => {
  const f = fixture(); await f.load();
  f.node('compareStart').value = '2026-09-16'; f.node('compareStart').oninput();
  await f.load();
  assert.match(f.calls.at(-1), /comparisonStartDate=2026-09-16/);
  assert.equal(new URL(f.location).searchParams.get('compareStart'), '2026-09-16');
  assert.equal(f.hasUnappliedScope(), false);
});
