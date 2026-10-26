import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

// Real rendering/request functions, virtual Beijing date and read-only HTTP fixtures.
// No browser clock changes, production reads, database writes or collection calls.
function fixture(period = 'day', inputUrl = null) {
  const nodes = new Map(), requests = [];
  let today = '2026-09-28', handler = null;
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, value: '', textContent: '', innerHTML: '', hidden: true, open: false,
      dataset: {}, files: [], checked: false, isConnected: true, scrollLeft: 0, scrollTop: 0,
      classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, getAttribute() {},
      addEventListener() {}, insertAdjacentHTML() {}, querySelectorAll: () => [], querySelector: () => null,
      closest: () => null, matches: () => false, contains(other) { return this === other; },
      focus() { document.activeElement = this; } });
    return nodes.get(id);
  };
  const document = { getElementById: node, querySelector: node, querySelectorAll: () => [], hidden: false,
    addEventListener() {}, removeEventListener() {}, hasFocus: () => true, body: node('body'), documentElement: node('html') };
  document.activeElement = document.body;
  const location = new URL(inputUrl || `http://matrix.test/?period=${period}#overview`);
  const context = { ...model, fmt: model.formatNumber, Date, URL, URLSearchParams, Intl, AbortController, document, location,
    setTimeout, clearTimeout,
    beijingToday: () => today, rangeFor: p => model.rangeFor(p, today),
    history: { replaceState(_a, _b, value) { location.href = String(value); } },
    window: { addEventListener() {}, matchMedia: () => ({ matches: true }), scrollTo() {}, scrollX: 0, scrollY: 0 },
    fetch: async path => {
      if (path === '/api/monitoring-status') return { ok: true, json: async () => ({}) };
      requests.push(path);
      if (handler) return handler(path);
      const q = new URL(path, location).searchParams;
      const range = q.has('startDate') ? { start: q.get('startDate'), end: q.get('endDate') } : model.rangeFor(q.get('period'), today);
      const summary = { metrics: {}, trend: [] };
      return { ok: true, json: async () => ({ period: q.get('period'), range: { startDate: range.start, endDate: range.end }, accounts: [], boards: [], summary,
        ...(q.has('comparisonStartDate') ? { comparison: { range: { startDate: q.get('comparisonStartDate'), endDate: q.get('comparisonEndDate') }, summary } } : {}) }) };
    } };
  const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8').replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '');
  runInNewContext(`${source}\nthis.subject={state,load,refreshSnapshot,bind,setupDates,automaticRead,automaticApply,automaticScopeKey,hasUnappliedScope,saveLocation,internals:()=>({appliedRequest,appliedContext,comparisonAuto})};`, context);
  const f = { ...context.subject, node, requests, location, setToday(value) { today = value; }, setHandler(value) { handler = value; } };
  if (f.state.compare) { node('compareStart').value = f.state.compareStart; node('compareEnd').value = f.state.compareEnd; }
  f.setupDates(); f.bind(); return f;
}

async function automaticComparison(f) {
  f.node('compareToggle').checked = true; f.node('compareToggle').onchange(); await f.load();
  assert.equal(f.internals().comparisonAuto, true); assert.equal(f.hasUnappliedScope(), false);
}

test('day-boundary: no-draft manual refresh advances an automatic daily comparison with the primary day', async () => {
  const f = fixture('day'); await automaticComparison(f);
  assert.equal(f.state.data.comparison.range.endDate, '2026-09-27');
  f.setToday('2026-09-29'); await f.refreshSnapshot();
  assert.equal(f.state.data.range.endDate, '2026-09-29');
  assert.equal(f.state.data.comparison.range.endDate, '2026-09-28', 'today vs yesterday must not become today vs two days ago');
});

test('day-boundary: no-draft rolling-week manual refresh follows the current seven-day period', async () => {
  const f = fixture('week'); await automaticComparison(f);
  f.setToday('2026-09-29'); await f.refreshSnapshot();
  assert.equal(f.state.data.range.endDate, '2026-09-29');
  assert.equal(f.state.data.range.startDate, '2026-09-23');
  assert.equal(f.state.data.comparison.range.endDate, '2026-09-22');
});

test('day-boundary: month rollover retains an equal-length automatic comparison, not the old 28-day interval', async () => {
  const f = fixture('month'); await automaticComparison(f);
  f.setToday('2026-10-01'); await f.refreshSnapshot();
  assert.equal(f.state.data.range.startDate, '2026-10-01');
  assert.equal(f.state.data.comparison.range.startDate, '2026-09-30');
  assert.equal(f.state.data.comparison.range.endDate, '2026-09-30');
});

test('day-boundary: automatic background read itself already advances both rolling ranges correctly', async () => {
  const f = fixture('week'); await automaticComparison(f); f.setToday('2026-09-29');
  const payload = await f.automaticRead({});
  assert.equal(payload.insights.range.endDate, '2026-09-29');
  assert.equal(payload.insights.comparison.range.endDate, '2026-09-22');
});

test('day-boundary: intentional custom historical dates and manual comparison remain fixed', async () => {
  const f = fixture('custom', 'http://matrix.test/?period=custom&start=2026-09-20&end=2026-09-22&compare=1&compareStart=2026-09-01&compareEnd=2026-09-03');
  await f.load(); f.setToday('2026-09-29'); await f.refreshSnapshot();
  assert.equal(f.state.data.range.endDate, '2026-09-22');
  assert.equal(f.state.data.comparison.range.endDate, '2026-09-03');
});

test('day-boundary: daily refresh with an unapplied comparison draft pins the old day instead of server today', async () => {
  const f = fixture('day'); await automaticComparison(f);
  f.node('compareStart').value = '2026-09-25'; f.node('compareStart').oninput();
  f.setToday('2026-09-29'); await f.refreshSnapshot();
  const request = new URL(f.requests.at(-1), f.location).searchParams;
  assert.equal(request.get('period'), 'day'); assert.equal(request.get('startDate'), '2026-09-28');
  assert.equal(request.get('endDate'), '2026-09-28');
  assert.equal(f.state.data.range.endDate, '2026-09-28');
  assert.equal(f.state.data.comparison.range.endDate, '2026-09-27');
  assert.equal(f.node('compareStart').value, '2026-09-25'); assert.equal(f.hasUnappliedScope(), true);
});

test('day-boundary: an initial explicit apply pins both endpoints and equal comparison in one context', async () => {
  const f = fixture('day'); await automaticComparison(f); f.setToday('2026-09-29'); await f.load();
  const q = new URL(f.requests.at(-1), f.location).searchParams;
  assert.equal(q.get('startDate'), '2026-09-29'); assert.equal(q.get('endDate'), '2026-09-29');
  assert.equal(q.get('comparisonStartDate'), '2026-09-28'); assert.equal(q.get('comparisonEndDate'), '2026-09-28');
});

test('day-boundary: persisted explicit auto mode advances after reopening, legacy manual links do not', async () => {
  const f = fixture('week'); await automaticComparison(f);
  assert.equal(f.location.searchParams.get('compareMode'), 'auto');
  const reopened = fixture('week', f.location.href); reopened.setToday('2026-09-29'); reopened.setupDates(); await reopened.load();
  assert.equal(reopened.internals().comparisonAuto, true);
  assert.equal(reopened.state.data.comparison.range.endDate, '2026-09-22');
  const legacyUrl = new URL(f.location); legacyUrl.searchParams.delete('compareMode');
  const legacy = fixture('week', legacyUrl.href); legacy.setToday('2026-09-29'); legacy.setupDates(); await legacy.load();
  assert.equal(legacy.internals().comparisonAuto, false);
  assert.equal(legacy.state.data.comparison.range.endDate, '2026-09-21');
});

test('day-boundary: manual date editing clears auto mode in the saved URL', async () => {
  const f = fixture('week'); await automaticComparison(f);
  f.node('compareStart').value = '2026-09-10'; f.node('compareStart').oninput(); await f.load();
  assert.equal(f.location.searchParams.has('compareMode'), false);
  assert.equal(f.location.searchParams.get('compareStart'), '2026-09-10');
});

test('day-boundary: failed refresh leaves the applied day, URL and next retry intent intact', async () => {
  const f = fixture('day'); await automaticComparison(f); const old = f.state.data, url = f.location.href;
  f.setToday('2026-09-29'); f.setHandler(() => ({ ok: false, status: 503, json: async () => ({ error: 'offline fixture' }) }));
  await f.refreshSnapshot(); assert.equal(f.state.data, old); assert.equal(f.location.href, url);
  assert.equal(f.node('compareEnd').value, '2026-09-27');
  f.setHandler(null); await f.refreshSnapshot();
  assert.equal(f.state.data.range.endDate, '2026-09-29'); assert.equal(f.node('compareEnd').value, '2026-09-28');
});

test('day-boundary: response after midnight uses the dispatched single day rather than the new server day', async () => {
  const f = fixture('day'); await automaticComparison(f); let reply;
  f.setHandler(path => new Promise(resolve => { reply = () => {
    const q = new URL(path, f.location).searchParams, summary = { metrics: {}, trend: [] };
    resolve({ ok: true, json: async () => ({ period: 'day', accounts: [], boards: [], summary,
      range: { startDate: q.get('startDate'), endDate: q.get('endDate') },
      comparison: { range: { startDate: q.get('comparisonStartDate'), endDate: q.get('comparisonEndDate') }, summary } }) });
  }; }));
  const pending = f.refreshSnapshot(); f.setToday('2026-09-29'); reply(); await pending;
  assert.equal(f.state.data.period, 'day', 'server daily semantics are preserved without front-end rewriting');
  assert.equal(f.state.data.range.endDate, '2026-09-28');
  assert.equal(f.state.data.comparison.range.endDate, '2026-09-27');
});

test('day-boundary: editing a comparison while a no-draft rolling refresh is pending preserves that new draft', async () => {
  const f = fixture('week'); await automaticComparison(f); f.setToday('2026-09-29'); let reply;
  f.setHandler(path => new Promise(resolve => { reply = () => {
    const q = new URL(path, f.location).searchParams, summary = { metrics: {}, trend: [] };
    resolve({ ok: true, json: async () => ({ period: 'custom', accounts: [], boards: [], summary,
      range: { startDate: q.get('startDate'), endDate: q.get('endDate') },
      comparison: { range: { startDate: q.get('comparisonStartDate'), endDate: q.get('comparisonEndDate') }, summary } }) });
  }; }));
  const pending = f.refreshSnapshot();
  f.node('compareStart').value = '2026-09-03'; f.node('compareStart').oninput();
  reply(); await pending;
  assert.equal(f.state.data.range.endDate, '2026-09-29');
  assert.equal(f.state.data.comparison.range.endDate, '2026-09-22');
  assert.equal(f.node('compareStart').value, '2026-09-03'); assert.equal(f.hasUnappliedScope(), true);
  assert.equal(f.location.searchParams.get('compareStart'), '2026-09-16');
});
