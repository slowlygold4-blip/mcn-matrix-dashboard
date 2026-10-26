import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const delayed = () => { let resolve; const promise = new Promise(yes => resolve = yes); return { promise, resolve }; };
function dataFor(path, label = 'snapshot') {
  const q = new URL(path, 'http://local').searchParams;
  const startDate = q.get('startDate') || '2026-09-28', endDate = q.get('endDate') || '2026-09-28';
  const summary = { enabledCount: 1, metrics: {}, trend: [] };
  return { label, period: 'custom', selectedTheme: q.get('theme'), selectedBoard: q.get('board'), selectedClassification: q.get('classification'),
    range: { startDate, endDate }, boards: [], summary,
    accounts: [{ id: 1, label: '保留账号', enabled: true, platform: 'douyin', boards: [], trend: [], status: {}, collection: {}, metrics: {} }],
    themeSummary: { items: [{ key: 'all', label: '全部主题', count: 1 }, { key: 'tuantuan', label: '团团', count: 1 }, { key: 'new-theme', label: '另一个主题', count: 1 }] },
    classificationSummary: { items: [{ key: 'all', label: '全部内容', count: 1 }] },
    ...(q.has('comparisonStartDate') ? { comparison: { range: { startDate: q.get('comparisonStartDate'), endDate: q.get('comparisonEndDate') }, summary } } : {}) };
}
function fixture() {
  const nodes = new Map(), listeners = new Map(), calls = [];
  const document = { activeElement: null, hidden: false, querySelectorAll: () => [], hasFocus: () => true,
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); } };
  const dispatch = (type, event) => { for (const fn of listeners.get(type) || []) fn(event); };
  function node(id) {
    if (!nodes.has(id)) {
      const n = { id, value: '', textContent: '', innerHTML: '', hidden: id === 'importPreview', checked: false,
        open: false, files: [], dataset: {}, isConnected: true, attributes: {}, tagName: 'DIV', _disabled: false,
        setAttribute(k,v) { this.attributes[k] = v; }, getAttribute(k) { return this.attributes[k]; },
        hasAttribute(k) { return Object.hasOwn(this.attributes,k); },
        classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [],
        querySelector: () => null, matches: () => false, closest: () => null, contains(other) { return other === this; },
        insertAdjacentHTML(_where, value) { this.innerHTML += value; },
        focus() { if (!this.disabled) { document.activeElement = this; dispatch('focusin', { target: this }); } } };
      Object.defineProperty(n, 'disabled', { get() { return this._disabled; }, set(v) { this._disabled = v; if (v && document.activeElement === this) document.activeElement = document.body; } });
      nodes.set(id,n);
    }
    return nodes.get(id);
  }
  document.getElementById = node; document.querySelector = node; document.body = node('body');
  document.documentElement = node('html'); document.activeElement = document.body;
  const location = new URL('http://127.0.0.1:4188/?period=custom&startDate=2026-09-22&endDate=2026-09-28&theme=tuantuan#accounts');
  let handler = path => response(dataFor(path));
  const context = { ...model, fmt: model.formatNumber, beijingToday: () => '2026-09-28',
    rangeFor: period => model.rangeFor(period, '2026-09-28'), URL, URLSearchParams, Date, Intl, AbortController,
    document, location, history: { replaceState(_a,_b,value) { location.href = String(value); } },
    window: { addEventListener() {}, matchMedia: () => ({ matches: true }), scrollTo() {}, scrollX: 0, scrollY: 0 },
    setTimeout, clearTimeout, fetch: async (path, options) => {
      assert.equal(options?.method || 'GET', 'GET', 'refresh must never write or collect');
      if (path === '/api/monitoring-status') return response({});
      calls.push(path); return handler(path);
    } };
  const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8').replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '');
  runInNewContext(`${source}\nthis.subject={state,load,refreshSnapshot,setupDates,bind,renderCatalog,renderSummary,renderAccounts,renderTrend,syncBlockedReason,appliedRange,internals:()=>({appliedRequest,appliedContext,comparisonAuto})};`, context);
  const f = context.subject;
  Object.assign(f.state, { period: 'custom', start: '2026-09-22', end: '2026-09-28', theme: 'tuantuan', view: 'accounts', compare: false });
  f.setupDates(); f.bind();
  return { ...f, node, calls, document, location, setHandler(fn) { handler = fn; } };
}

test('peer refresh: invalid date and unsubmitted comparison drafts survive while query stays committed', async () => {
  const f = fixture(); await f.load(); const committed = f.calls.at(-1), url = f.location.href;
  f.node('startDate').value = '2026-09-29'; f.node('endDate').value = '2026-09-20';
  f.node('compareToggle').checked = true; f.node('compareToggle').onchange();
  f.node('compareStart').value = '2026-09-01'; f.node('compareEnd').value = '2026-09-03'; f.node('compareStart').oninput();
  await f.refreshSnapshot();
  assert.equal(f.calls.at(-1), committed); assert.equal(f.calls.length, 2);
  assert.equal(f.node('startDate').value, '2026-09-29'); assert.equal(f.node('compareStart').value, '2026-09-01');
  assert.equal(f.state.compare, true); assert.equal(f.state.data.comparison, undefined);
  assert.equal(f.internals().appliedContext.compare, false); assert.equal(f.location.href, url);
  assert.match(f.syncBlockedReason(), /未应用|日期|筛选/);
  f.state.metric = 'likes'; f.renderTrend(); f.renderSummary();
  assert.equal(f.state.data.range.startDate, '2026-09-22'); assert.doesNotMatch(f.node('kpiGrid').innerHTML, /对比时段/);
});

test('peer refresh: failed theme selection cannot relabel committed evidence after refresh or rerender', async () => {
  const f = fixture(); await f.load(); const oldQuery = f.calls.at(-1), url = f.location.href;
  f.state.theme = 'new-theme'; f.node('themeSelect').value = 'new-theme';
  f.setHandler(() => response({ error: 'fixture scope failed' }, 503)); await f.load();
  f.setHandler(path => response(dataFor(path, 'refreshed'))); await f.refreshSnapshot();
  assert.equal(f.calls.at(-1), oldQuery); assert.equal(f.state.theme, 'new-theme');
  assert.equal(f.state.data.selectedTheme, 'tuantuan'); assert.equal(f.node('themeSelect').value, 'new-theme');
  assert.match(f.node('pageSubtitle').textContent, /团团/); assert.doesNotMatch(f.node('pageSubtitle').textContent, /另一个主题/);
  assert.equal(f.location.href, url);
  f.renderCatalog(); f.renderSummary(); f.state.sort = 'likes.delta'; f.renderAccounts(); f.renderTrend();
  assert.match(f.node('pageSubtitle').textContent, /团团/); assert.doesNotMatch(f.node('pageSubtitle').textContent, /另一个主题/);
  assert.match(f.node('themeGrid').innerHTML, /data-theme="tuantuan" aria-pressed="true"/);
  const expectedSorted = new URL(url); expectedSorted.searchParams.set('sort', 'likes.delta');
  assert.equal(f.location.href, expectedSorted.href); assert.match(f.syncBlockedReason(), /未应用|日期|筛选/);
});

test('peer refresh: a failing refresh preserves old data and drafts, and retry does not apply drafts', async () => {
  const f = fixture(); await f.load(); const oldQuery = f.calls.at(-1), oldData = f.state.data;
  f.node('startDate').value = '2026-09-24';
  f.setHandler(() => response({ error: 'read-only failure' }, 503)); f.node('refreshBtn').focus(); await f.refreshSnapshot();
  assert.equal(f.state.data, oldData); assert.equal(f.document.activeElement, f.node('refreshBtn'));
  assert.match(f.node('notice').textContent, /read-only failure/); assert.equal(f.node('startDate').value, '2026-09-24');
  f.setHandler(path => response(dataFor(path, 'retry'))); await f.refreshSnapshot();
  assert.equal(f.calls.at(-1), oldQuery); assert.equal(f.state.data.label, 'retry'); assert.equal(f.node('startDate').value, '2026-09-24');
});

test('peer refresh: input, upload preview and focus changed while reading are never rolled back', async () => {
  const f = fixture(); await f.load(); const pending = delayed(), query = f.calls.at(-1);
  f.setHandler(() => pending.promise); f.node('refreshBtn').focus(); const read = f.refreshSnapshot();
  f.node('startDate').value = '2026-09-25'; f.node('startDate').focus();
  f.node('importPreview').hidden = false; f.node('importPreview').innerHTML = 'preview still uploading';
  f.node('fileInput').files = [{ name: 'unsubmitted.xlsx' }];
  pending.resolve(response(dataFor(query))); await read;
  assert.equal(f.node('startDate').value, '2026-09-25'); assert.equal(f.document.activeElement, f.node('startDate'));
  assert.equal(f.node('importPreview').innerHTML, 'preview still uploading'); assert.equal(f.node('fileInput').files.length, 1);
  assert.match(f.syncBlockedReason(), /导入草稿/);
});

test('peer refresh: a late refresh cannot overwrite a newer deliberately applied date scope', async () => {
  const f = fixture(); await f.load(); const firstQuery = f.calls.at(-1), pending = delayed();
  f.setHandler(() => pending.promise); const oldRefresh = f.refreshSnapshot();
  f.node('startDate').value = '2026-09-24';
  f.setHandler(path => response(dataFor(path, 'new explicit scope'))); await f.load();
  pending.resolve(response(dataFor(firstQuery, 'old response'))); await oldRefresh;
  assert.equal(f.state.data.label, 'new explicit scope'); assert.equal(f.state.data.range.startDate, '2026-09-24');
  assert.equal(f.internals().appliedContext.start, '2026-09-24'); assert.equal(f.node('startDate').value, '2026-09-24');
});

test('peer refresh: an existing manual comparison retains its committed evidence while its next draft differs', async () => {
  const f = fixture(); f.state.compare = true; f.node('compareToggle').checked = true;
  f.node('compareStart').value = '2026-09-15'; f.node('compareEnd').value = '2026-09-21'; f.node('compareStart').oninput();
  await f.load(); const committed = f.calls.at(-1), url = f.location.href;
  f.node('compareStart').value = '2026-09-01'; f.node('compareEnd').value = '2026-09-07';
  f.node('compareStart').oninput(); await f.refreshSnapshot();
  assert.equal(f.calls.at(-1), committed); assert.equal(f.state.data.comparison.range.startDate, '2026-09-15');
  assert.equal(f.internals().appliedContext.compareStart, '2026-09-15');
  assert.equal(f.node('compareStart').value, '2026-09-01'); assert.equal(f.node('compareEnd').value, '2026-09-07');
  f.state.metric = 'posts'; f.renderTrend(); f.renderSummary();
  assert.equal(f.state.data.comparison.range.endDate, '2026-09-21'); assert.equal(f.location.href, url);
  assert.match(f.syncBlockedReason(), /未应用|日期|筛选/);
});
