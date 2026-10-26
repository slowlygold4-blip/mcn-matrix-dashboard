import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

const original = { start: '2026-09-20', end: '2026-09-28', compareStart: '2026-09-11', compareEnd: '2026-09-19' };
const draft = { start: '2026-09-01', end: '2026-09-07', compareStart: '2026-08-25', compareEnd: '2026-08-31' };

function fixture({ period = 'custom', compare = true, delayedHistory = false } = {}) {
  const nodes = new Map(), calls = [], listeners = new Map(), windowListeners = new Map(), downloads = [], navigationPending = new Set();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, value: '', textContent: '', innerHTML: '', hidden: true, open: false,
      dataset: {}, files: [], checked: false, isConnected: true, scrollLeft: 0, scrollTop: 0, events: new Map(), classList: { toggle() {}, add() {}, remove() {} },
      setAttribute() {}, getAttribute() {}, hasAttribute() { return false; }, addEventListener(type, fn) { this.events.set(type, fn); }, insertAdjacentHTML() {},
      querySelector() { return null; }, closest() { return null; }, matches() { return false; },
      showModal() { this.open = true; }, close() { this.open = false; }, click() { downloads.push(this); },
      focus() { document.activeElement = this; }, contains(other) { return this === other; } });
    return nodes.get(id);
  };
  const document = { getElementById: node, querySelector: node, querySelectorAll: () => [], createElement: node,
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); }, removeEventListener() {},
    hasFocus: () => true, body: node('body'), documentElement: node('html') };
  document.activeElement = document.body;
  const location = new URL(`http://matrix.test/?board=first&theme=tuantuan&classification=slice&period=${period}&start=${original.start}&end=${original.end}${compare ? `&compare=1&compareStart=${original.compareStart}&compareEnd=${original.compareEnd}` : ''}#overview`);
  const entries = [{ url: location.href, state: null }], historyTraversalQueue = [];
  let historyIndex = 0, traversals = 0, backCalls = 0;
  const moveHistory = delta => {
    const next = historyIndex + delta;
    if (next < 0 || next >= entries.length) return;
    const previousHash = location.hash;
    historyIndex = next; location.href = entries[next].url; traversals++;
    const pending = Promise.resolve().then(async () => {
      const handlers = windowListeners.get('popstate') || [];
      const results = handlers.map(fn => fn({ state: entries[next].state }));
      if (previousHash !== location.hash) for (const fn of windowListeners.get('hashchange') || []) fn({});
      await Promise.all(results);
    });
    navigationPending.add(pending); void pending.finally(() => navigationPending.delete(pending));
  };
  const requestHistory = delta => {
    if (delayedHistory) historyTraversalQueue.push(() => moveHistory(delta));
    else moveHistory(delta);
  };
  const history = {
    get state() { return entries[historyIndex].state; },
    replaceState(value, _title, url) { location.href = String(url); entries[historyIndex] = { url: location.href, state: value }; },
    pushState(value, _title, url) { location.href = String(url); entries.splice(historyIndex + 1); entries.push({ url: location.href, state: value }); historyIndex++; },
    back() { backCalls++; requestHistory(-1); }, forward() { requestHistory(1); },
  };
  const window = { scrollX: 0, scrollY: 0,
    scrollTo({ left, top }) { this.scrollX = left; this.scrollY = top; },
    addEventListener(type, fn) { windowListeners.set(type, [...(windowListeners.get(type) || []), fn]); }, matchMedia: () => ({ matches: true }) };
  let handler = null, blob = null, today = '2026-09-28';
  class TestURL extends URL {
    static createObjectURL(value) { blob = value; return 'blob:scope-test'; }
    static revokeObjectURL() {}
  }
  const account = { id: 1, label: '测试账号', publicId: 'fixture', platform: 'douyin', enabled: true,
    classification: { theme: { key: 'tuantuan', label: '团团' }, labels: [{ key: 'slice', label: '切片' }] },
    metrics: Object.fromEntries(['followers', 'likes', 'posts', 'estimatedPlays'].map(key => [key, { value: 10, delta: 2, currentAt: '2026-09-28T02:00:00Z' }])),
    status: { lastSuccessAt: '2026-09-28T02:00:00Z' }, boards: [], trend: [] };
  const payload = path => {
    const p = new URL(path, location).searchParams;
    if (path.startsWith('/api/rebuild/accounts/')) {
      const detailAccount = { ...account, id: Number(path.match(/accounts\/(\d+)/)[1]) };
      return { account: detailAccount, recentWorks: [], comparison: p.has('comparisonStartDate') ? { account: detailAccount,
        range: { startDate: p.get('comparisonStartDate'), endDate: p.get('comparisonEndDate') } } : null };
    }
    return { period: p.get('period'), board: p.get('board'), theme: p.get('theme'), classification: p.get('classification'),
      boards: [{ key: 'first', name: '原板块' }, { key: 'second', name: '新板块' }], accounts: [account],
      range: { startDate: p.get('startDate'), endDate: p.get('endDate') }, recordedWindow: null,
      summary: { metrics: { followers: { delta: 2, comparableCount: 1 } }, trend: [] },
      comparison: p.has('comparisonStartDate') ? { range: { startDate: p.get('comparisonStartDate'), endDate: p.get('comparisonEndDate') }, summary: { metrics: { followers: { delta: 3, comparableCount: 1 } }, trend: [] } } : null,
      themeSummary: { items: [{ key: 'tuantuan', label: '团团', count: 1 }, { key: 'other', label: '其他主题', count: 1 }] },
      classificationSummary: { items: [{ key: 'slice', label: '切片', count: 1 }, { key: 'remix', label: '混剪', count: 1 }] } };
  };
  const context = { ...model, fmt: model.formatNumber, Date, URL: TestURL, URLSearchParams, Intl, AbortController, Blob,
    document, location, beijingToday: () => today, rangeFor: p => model.rangeFor(p, today), setTimeout() {}, clearTimeout() {},
    queueMicrotask: callback => Promise.resolve().then(callback),
    history, window,
    fetch: async path => {
      if (path === '/api/monitoring-status') return { ok: true, json: async () => ({}) };
      calls.push(path); if (handler) return handler(path);
      return { ok: true, json: async () => payload(path) };
    } };
  const source = readFileSync(process.env.MCN_REBUILD_SCOPE_SOURCE || new URL('../public/rebuild.js', import.meta.url), 'utf8')
    .replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '');
  runInNewContext(`${source}\nthis.subject={state,load,bind,setupDates,setView,openAccount,closeAccount,restoreNavigation,saveLocation,downloadCsv,hasUnappliedScope,getApplied:()=>({...appliedContext})};`, context);
  const f = { ...context.subject, node, calls, location, downloads, payload, document, window, history,
    historyEntries: () => entries.length, traversals: () => traversals, historyBackCalls: () => backCalls,
    queuedHistoryTraversals: () => historyTraversalQueue.length,
    async flushHistoryTraversal() { historyTraversalQueue.shift()?.(); await f.settled(); },
    cancelDialog() { const event = { prevented: false, preventDefault() { this.prevented = true; } }; node('accountDialog').events.get('cancel')(event); return event; },
    setHandler(fn) { handler = fn; }, setToday(value) { today = value; }, csv: async () => blob.text(),
    clickCard(dataset) { const button = { dataset, hasAttribute: name => Object.hasOwn(dataset, name.replace(/^data-/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())) }; for (const fn of listeners.get('click') || []) fn({ target: { closest: () => button } }); },
    async settled() { for (let i = 0; i < 80; i++) await Promise.resolve(); assert.equal(f.state.busy, false); assert.equal(navigationPending.size, 0); },
    editDates(value = draft) {
      f.state.period = 'custom'; f.node('periodSelect').value = 'custom';
      f.node('startDate').value = value.start; f.node('endDate').value = value.end;
      f.node('compareStart').value = value.compareStart; f.node('compareEnd').value = value.compareEnd;
      f.node('compareStart').oninput();
    } };
  f.node('compareStart').value = original.compareStart; f.node('compareEnd').value = original.compareEnd;
  f.node('compareToggle').checked = compare; f.setupDates(); f.bind(); return f;
}

const entrances = [
  ['board select', f => { f.node('boardSelect').value = 'second'; f.node('boardSelect').onchange(); }, { board: 'second', theme: 'tuantuan', classification: 'slice' }],
  ['theme select', f => { f.node('themeSelect').value = 'other'; f.node('themeSelect').onchange(); }, { board: 'first', theme: 'other', classification: 'slice' }],
  ['classification select', f => { f.node('classificationSelect').value = 'remix'; f.node('classificationSelect').onchange(); }, { board: 'first', theme: 'tuantuan', classification: 'remix' }],
  ['theme card', f => f.clickCard({ theme: 'other' }), { board: 'first', theme: 'other', classification: 'slice' }],
  ['classification card', f => f.clickCard({ classification: 'remix' }), { board: 'first', theme: 'tuantuan', classification: 'remix' }],
  ['clear scope', f => f.node('clearScopeBtn').onclick(), { board: '', theme: 'all', classification: 'all' }],
];

function assertRequest(path, dates, scope = null, compare = true) {
  const p = new URL(path, 'http://matrix.test').searchParams;
  assert.equal(p.get('startDate'), dates.start); assert.equal(p.get('endDate'), dates.end);
  assert.equal(p.get('comparisonStartDate'), compare ? dates.compareStart : null);
  assert.equal(p.get('comparisonEndDate'), compare ? dates.compareEnd : null);
  if (scope) for (const [key, value] of Object.entries(scope)) assert.equal(p.get(key), value);
}

test('week-period missing recorded window is explained as unknown rather than zero', async () => {
  const f = fixture({ period: 'week', compare: false }); await f.load();
  assert.ok(f.state.data, f.node('notice').textContent);
  assert.equal(f.node('recordedWindowNotice').hidden, false);
  assert.match(f.node('recordedWindowNotice').textContent, /共同起止采样窗口/);
  assert.match(f.node('recordedWindowNotice').textContent, /不是 0/);
});

test('week-period stale backend contract preserves the previous view and reports version mismatch', async () => {
  const f = fixture({ period: 'week', compare: false }); await f.load();
  const previous = f.state.data;
  f.setHandler(async path => { const data = f.payload(path); delete data.recordedWindow; return { ok: true, json: async () => data }; });
  await f.load(); await f.settled();
  assert.equal(f.state.data, previous);
  assert.match(f.node('notice').textContent, /共同采样窗口字段缺失或无效/);
  assert.match(f.node('notice').textContent, /保留上次已读取的数据/);
});

test('theme switch preserves the selected content type and explicitly avoids broadening to all accounts', async () => {
  const f = fixture(); await f.load(); assert.ok(f.state.data, f.node('notice').textContent);
  f.setHandler(async path => {
    const data = f.payload(path);
    data.accounts = [];
    data.classificationSummary = { items: [{ key: 'slice', label: '切片', count: 0 }, { key: 'remix', label: '混剪', count: 0 }] };
    return { ok: true, json: async () => data };
  });
  f.node('themeSelect').value = 'other'; f.node('themeSelect').onchange(); await f.settled();
  assertRequest(f.calls.at(-1), original, { board: 'first', theme: 'other', classification: 'slice' });
  assert.equal(f.state.theme, 'other'); assert.equal(f.state.classification, 'slice');
  assert.equal(f.node('classificationSelect').value, 'slice');
  assert.match(f.node('notice').textContent, /没有“切片”账号/);
  assert.match(f.node('notice').textContent, /未自动扩大范围/);
  assert.match(f.node('accountsTable').innerHTML, /没有符合条件的账号/);
  const applied = new URL(f.location).searchParams;
  assert.equal(applied.get('theme'), 'other'); assert.equal(applied.get('classification'), 'slice');
});

for (const [name, change, scope] of entrances) {
  test(`${name} changes only account scope; dates stay applied through list, detail and CSV until Apply`, async () => {
    const f = fixture(); await f.load(); f.editDates(); change(f); await f.settled();
    assert.equal(f.calls.length, 2); assertRequest(f.calls[1], original, scope);
    assert.equal(f.node('startDate').value, draft.start); assert.equal(f.node('endDate').value, draft.end);
    assert.equal(f.node('compareStart').value, draft.compareStart); assert.equal(f.node('compareEnd').value, draft.compareEnd);
    assert.equal(f.hasUnappliedScope(), true); assert.equal(f.state.data.range.startDate, original.start);
    const url = new URL(f.location);
    for (const [key, value] of Object.entries({ ...original, ...scope })) {
      assert.equal(url.searchParams.get(key) || (['theme', 'classification'].includes(key) ? 'all' : ''), value, `applied URL ${key}`);
    }
    assert.match(f.node('accountsTable').innerHTML, /测试账号/);
    await f.openAccount(1); assertRequest(f.calls.at(-1), original);
    assert.match(f.node('dialogBody').innerHTML, /2026-09-20 至 2026-09-28/);
    f.downloadCsv(); const csv = await f.csv();
    assert.match(csv, /"2026-09-20","2026-09-28"/); assert.doesNotMatch(csv, /2026-09-01/);
    assert.equal(f.downloads.at(-1).download, '矩阵数据_2026-09-20_2026-09-28.csv');
    f.node('applyDateBtn').onclick(); await f.settled();
    assertRequest(f.calls.at(-1), draft, scope); assert.equal(f.hasUnappliedScope(), false);
  });
}

for (const [name, change] of [
  ['board select', f => { f.node('boardSelect').value = 'second'; f.node('boardSelect').onchange(); }],
  ['theme select', f => { f.node('themeSelect').value = 'other'; f.node('themeSelect').onchange(); }],
  ['classification select', f => { f.node('classificationSelect').value = 'remix'; f.node('classificationSelect').onchange(); }],
  ['theme card', f => f.clickCard({ theme: 'other' })],
  ['classification card', f => f.clickCard({ classification: 'remix' })],
  ['clear scope', f => f.node('clearScopeBtn').onclick()],
]) {
  test(`${name} clears stale account-table filters while preserving date drafts and sort`, async () => {
    const f = fixture(); await f.load(); f.editDates();
    Object.assign(f.state, { query: 'old search', platform: 'bilibili', enabled: 'paused', collectionFilter: 'incomplete-works', page: 4, sort: 'likes.value', direction: 'asc' });
    f.node('accountSearch').value = 'old search'; f.node('platformSelect').value = 'bilibili';
    f.node('enabledSelect').value = 'paused'; f.node('collectionSelect').value = 'incomplete-works';

    change(f); await f.settled();

    assert.equal(f.state.query, ''); assert.equal(f.state.platform, 'all');
    assert.equal(f.state.enabled, 'all'); assert.equal(f.state.collectionFilter, 'all');
    assert.equal(f.state.page, 1); assert.equal(f.state.sort, 'likes.value'); assert.equal(f.state.direction, 'asc');
    assert.equal(f.node('accountSearch').value, ''); assert.equal(f.node('platformSelect').value, 'all');
    assert.equal(f.node('enabledSelect').value, 'all'); assert.equal(f.node('collectionSelect').value, 'all');
    assert.equal(f.node('startDate').value, draft.start); assert.equal(f.node('endDate').value, draft.end);
    const url = new URL(f.location);
    for (const key of ['q', 'platform', 'enabled', 'collectionFilter', 'page']) assert.equal(url.searchParams.has(key), false, `${key} is cleared from navigation`);
    assert.equal(url.searchParams.get('sort'), 'likes.value'); assert.equal(url.searchParams.get('direction'), 'asc');
    assert.equal(url.searchParams.get('start'), original.start); assert.equal(url.searchParams.get('end'), original.end);
  });
}

test('invalid date and comparison drafts do not block changing account scope', async () => {
  const f = fixture(); await f.load(); f.editDates({ start: '', end: '2099-01-01', compareStart: '', compareEnd: '2099-01-02' });
  entrances[2][1](f); await f.settled();
  assert.equal(f.calls.length, 2); assertRequest(f.calls[1], original, entrances[2][2]);
  assert.equal(f.node('startDate').value, ''); assert.equal(f.node('compareEnd').value, '2099-01-02');
});

test('scope switch preserves a custom-period draft against an applied preset without advancing dates', async () => {
  const f = fixture({ period: 'week' }); await f.load(); const before = f.getApplied();
  f.editDates(); f.setToday('2026-09-29'); entrances[0][1](f); await f.settled();
  assertRequest(f.calls[1], before, entrances[0][2]);
  assert.equal(f.getApplied().period, 'week'); assert.equal(f.state.period, 'custom');
  assert.equal(f.node('periodSelect').value, 'custom'); assert.equal(new URL(f.location).searchParams.get('period'), 'week');
  assert.equal(f.node('startDate').value, draft.start);
});

test('comparison enabled as a draft is not applied by an account scope switch', async () => {
  const f = fixture({ compare: false }); await f.load(); f.node('compareToggle').checked = true; f.node('compareToggle').onchange();
  f.editDates(); entrances[1][1](f); await f.settled();
  assertRequest(f.calls[1], original, entrances[1][2], false);
  assert.equal(f.state.compare, true); assert.equal(f.node('compareToggle').checked, true);
  assert.equal(f.getApplied().compare, false); assert.equal(f.state.data.comparison, null);
  assert.equal(new URL(f.location).searchParams.has('compare'), false);
});

test('date edits made while scope request is pending remain drafts', async () => {
  const f = fixture(); await f.load(); let finish;
  f.setHandler(path => new Promise(resolve => { finish = () => resolve({ ok: true, json: async () => f.payload(path) }); }));
  entrances[4][1](f); f.editDates(); finish(); await f.settled();
  assertRequest(f.calls[1], original, entrances[4][2]);
  assert.equal(f.node('startDate').value, draft.start); assert.equal(f.node('compareStart').value, draft.compareStart);
  assert.equal(f.hasUnappliedScope(), true);
});

test('initial scope navigation has a valid first load when no applied context exists', async () => {
  const f = fixture(); entrances[2][1](f); await f.settled();
  assert.equal(f.calls.length, 1); assertRequest(f.calls[0], original, entrances[2][2]);
  assert.equal(f.hasUnappliedScope(), false); assert.equal(f.node('exportButton').disabled, false);
});

test('custom date edits warn that displayed data and CSV still use the applied interval until Apply', async () => {
  const f = fixture({ compare: false }); await f.load();
  const beforeUrl = f.location.href, beforeKpis = f.node('kpiGrid').innerHTML;
  f.node('startDate').value = draft.start; f.node('startDate').oninput();
  assert.equal(f.node('notice').hidden, false);
  assert.match(f.node('notice').textContent, /日期范围或对比尚未应用/);
  assert.match(f.node('notice').textContent, /显示数据与导出仍使用已应用范围/);
  assert.equal(f.node('kpiGrid').innerHTML, beforeKpis);
  assert.equal(f.location.href, beforeUrl);
  f.downloadCsv();
  assert.match(await f.csv(), /"2026-09-20","2026-09-28"/);
  assert.doesNotMatch(await f.csv(), /"2026-09-01","2026-09-28"/);

  f.node('applyDateBtn').onclick(); await f.settled();
  assert.equal(f.node('notice').hidden, true);
  assert.equal(f.state.data.range.startDate, draft.start);
  assert.match(f.node('pageSubtitle').textContent, /2026-09-01 至 2026-09-28/);
  f.downloadCsv();
  assert.match(await f.csv(), /"2026-09-01","2026-09-28"/);
  assert.equal(f.hasUnappliedScope(), false);
});

test('switching from a preset into custom dates warns while retaining the last applied interval', async () => {
  const f = fixture({ period: 'week', compare: false }); await f.load();
  const beforeRange = { ...f.state.data.range };
  const beforeUrl = f.location.href;
  f.node('periodSelect').value = 'custom'; f.node('periodSelect').onchange();
  assert.match(f.node('notice').textContent, /日期范围或对比尚未应用/);
  assert.match(f.node('notice').textContent, /显示数据与导出仍使用已应用范围/);
  assert.equal(f.location.href, beforeUrl);
  assert.deepEqual(f.state.data.range, beforeRange);
  assert.equal(f.node('startDate').value, beforeRange.startDate);
  f.downloadCsv(); assert.match(await f.csv(), new RegExp(`"${beforeRange.startDate}","${beforeRange.endDate}"`));
  f.node('applyDateBtn').onclick(); await f.settled();
  assert.equal(f.node('notice').hidden, true);
  assert.deepEqual(f.state.data.range, beforeRange);
  assert.equal(f.getApplied().period, 'custom');
  assert.equal(f.hasUnappliedScope(), false);
});

test('choosing custom dates before the first read asks to Apply without claiming there is an old range', () => {
  const f = fixture({ period: 'week', compare: false });
  f.node('periodSelect').value = 'custom'; f.node('periodSelect').onchange();
  assert.match(f.node('notice').textContent, /日期范围尚未应用/);
  assert.match(f.node('notice').textContent, /点击「应用」后读取所选范围/);
  assert.doesNotMatch(f.node('notice').textContent, /仍使用已应用范围/);
});

for (const compare of [true, false]) {
  test(`comparison ${compare ? 'off then on' : 'on then off'} edits only the draft and keeps applied URL, KPI and CSV`, async () => {
    const f = fixture({ compare }); await f.load(); f.editDates();
    const appliedUrl = f.location.href, appliedKpis = f.node('kpiGrid').innerHTML, appliedBrief = f.node('filterBrief').textContent;
    f.downloadCsv(); const appliedCsv = await f.csv();
    for (const checked of [!compare, compare]) {
      f.node('compareToggle').checked = checked; f.node('compareToggle').onchange(); await f.settled();
      assert.equal(f.calls.length, 1, 'neither toggle direction may read or commit the date draft');
      assert.equal(f.state.compare, checked); assert.equal(f.node('compareDates').hidden, !checked);
      assert.equal(f.location.href, appliedUrl); assert.equal(f.getApplied().compare, compare);
      assert.equal(Boolean(f.state.data.comparison), compare); assert.equal(f.node('kpiGrid').innerHTML, appliedKpis);
      assert.equal(f.node('filterBrief').textContent, appliedBrief);
      assert.equal(f.node('startDate').value, draft.start); assert.equal(f.node('compareStart').value, draft.compareStart);
      assert.equal(f.node('exportButton').disabled, false); f.downloadCsv(); assert.equal(await f.csv(), appliedCsv);
    }
    assert.match(f.node('notice').textContent, /应用/);
  });
}

test('hidden comparison draft survives scope navigation; only Apply removes applied comparison and commits dates', async () => {
  const f = fixture(); await f.load(); f.editDates();
  f.node('compareToggle').checked = false; f.node('compareToggle').onchange(); await f.settled();
  assert.equal(f.calls.length, 1); assert.equal(f.node('compareDates').hidden, true);
  entrances[2][1](f); await f.settled();
  assertRequest(f.calls[1], original, entrances[2][2]);
  assert.equal(new URL(f.location).searchParams.get('compare'), '1');
  assert.match(f.node('kpiGrid').innerHTML, /compare-note/);
  assert.match(f.node('filterBrief').textContent, /2026-09-11 至 2026-09-19/);
  f.downloadCsv(); assert.match(await f.csv(), /"2026-09-20","2026-09-28"/);
  f.node('applyDateBtn').onclick(); await f.settled();
  assert.equal(f.calls.length, 3); assertRequest(f.calls.at(-1), draft, entrances[2][2], false);
  assert.equal(f.state.data.comparison, null); assert.equal(f.getApplied().compare, false);
  assert.equal(new URL(f.location).searchParams.has('compare'), false);
  assert.doesNotMatch(f.node('kpiGrid').innerHTML, /compare-note/);
  assert.match(f.node('filterBrief').textContent, /未开启时段对比/);
  f.downloadCsv(); assert.match(await f.csv(), /"2026-09-01","2026-09-07"/);
  assert.equal(f.hasUnappliedScope(), false);
});

test('only Apply enables comparison using its retained draft dates', async () => {
  const f = fixture({ compare: false }); await f.load(); f.editDates();
  f.node('compareToggle').checked = true; f.node('compareToggle').onchange(); await f.settled();
  assert.equal(f.calls.length, 1); assert.equal(f.state.data.comparison, null);
  f.node('applyDateBtn').onclick(); await f.settled();
  assert.equal(f.calls.length, 2); assertRequest(f.calls.at(-1), draft);
  assert.equal(f.getApplied().compare, true); assert.equal(new URL(f.location).searchParams.get('compare'), '1');
  assert.match(f.node('kpiGrid').innerHTML, /compare-note/);
  assert.match(f.node('filterBrief').textContent, /2026-08-25 至 2026-08-31/);
  assert.equal(f.hasUnappliedScope(), false);
});

async function managerLedger() {
  const f = fixture();
  f.setHandler(async path => {
    const data = f.payload(path);
    if (!path.startsWith('/api/rebuild/accounts/')) data.accounts = Array.from({ length: 45 }, (_, i) => ({ ...data.accounts[0], id: i + 1, label: `测试账号${i + 1}` }));
    return { ok: true, json: async () => data };
  });
  await f.load();
  Object.assign(f.state, { query: '测试账号', sort: 'likes.delta', direction: 'asc', page: 2 });
  f.node('accountSearch').value = f.state.query; f.setView('accounts');
  const trigger = f.node('account-row-21'); trigger.dataset.accountId = '21'; trigger.focus();
  f.window.scrollX = 15; f.window.scrollY = 650;
  f.node('accountsTable').scrollLeft = 90; f.node('accountsTable').scrollTop = 140;
  return { f, trigger };
}

test('manager detail Back/Forward retains parent filters, rank, page, date drafts, scroll and focus without reloading the ledger', async () => {
  const { f, trigger } = await managerLedger(), parentUrl = f.location.href, parent = f.state.data;
  await f.openAccount(21); f.editDates(); f.node('detail-close').focus();
  assert.equal(f.historyEntries(), 2); assert.equal(f.location.href, parentUrl);
  // A repaint must not erase the modal record that Forward needs.
  f.saveLocation();
  f.history.back(); await f.settled();
  assert.equal(f.node('accountDialog').open, false); assert.equal(f.state.detailId, null);
  assert.equal(f.document.activeElement, trigger); assert.equal(f.state.data, parent);
  assert.deepEqual([f.state.query, f.state.sort, f.state.direction, f.state.page], ['测试账号', 'likes.delta', 'asc', 2]);
  assert.equal(f.node('startDate').value, draft.start); assert.equal(f.node('compareEnd').value, draft.compareEnd);
  assert.deepEqual([f.window.scrollX, f.window.scrollY, f.node('accountsTable').scrollLeft, f.node('accountsTable').scrollTop], [15, 650, 90, 140]);
  assert.equal(f.calls.filter(path => path.startsWith('/api/rebuild/insights?')).length, 1);
  f.history.forward(); await f.settled();
  assert.equal(f.node('accountDialog').open, true); assert.equal(f.state.detailId, 21);
  assert.equal(f.state.data, parent); assert.match(f.node('dialogBody').innerHTML, /2026-09-20 至 2026-09-28/);
  assert.equal(f.calls.filter(path => path.startsWith('/api/rebuild/insights?')).length, 1);
  f.history.back(); await f.settled(); assert.equal(f.document.activeElement, trigger);
});

for (const closeKind of ['X', 'Escape']) {
  test(`${closeKind} consumes only the owned detail entry and Forward restores it`, async () => {
    const { f, trigger } = await managerLedger(); await f.openAccount(21);
    if (closeKind === 'X') f.clickCard({ closeDialog: '' });
    else assert.equal(f.cancelDialog().prevented, true);
    await f.settled();
    assert.equal(f.node('accountDialog').open, false); assert.equal(f.historyBackCalls(), 1);
    assert.equal(f.document.activeElement, trigger); assert.equal(f.state.page, 2);
    f.history.forward(); await f.settled();
    assert.equal(f.node('accountDialog').open, true); assert.equal(f.state.detailId, 21);
  });
}

test('delayed owned detail Back cannot override a newer explicit page navigation', async () => {
  const f = fixture({ delayedHistory: true }); await f.load();
  const parent = f.state.data;
  const trigger = f.node('overview-author-1'); trigger.focus();
  await f.openAccount(1);
  assert.equal(f.cancelDialog().prevented, true); await f.settled();
  assert.equal(f.node('accountDialog').open, false);
  assert.equal(f.historyBackCalls(), 1); assert.equal(f.traversals(), 0);
  assert.equal(f.queuedHistoryTraversals(), 1, 'Back is dispatched but has not traversed yet');

  f.setView('import'); f.setView('accounts');
  await f.flushHistoryTraversal();

  assert.equal(f.state.view, 'accounts', 'the latest explicit navigation wins the close traversal');
  assert.equal(f.location.hash, '#accounts'); assert.equal(f.node('accountDialog').open, false);
  assert.equal(f.state.data, parent, 'the consumed close traversal does not reload the old overview');
  assert.equal(f.calls.filter(path => path.startsWith('/api/rebuild/insights?')).length, 1);
  assert.equal(f.historyBackCalls(), 1); assert.equal(f.traversals(), 1);
  assert.equal(f.queuedHistoryTraversals(), 0);

  // Explicit navigation after closing still leaves the original modal record
  // available to Forward, exactly as navigation after a settled close does.
  f.history.forward(); await f.flushHistoryTraversal();
  assert.equal(f.state.view, 'overview'); assert.equal(f.node('accountDialog').open, true);
  assert.equal(f.state.detailId, 1);
  f.history.back(); await f.flushHistoryTraversal();
  assert.equal(f.state.view, 'accounts'); assert.equal(f.node('accountDialog').open, false);
});

test('delayed owned detail Back cannot close a newer explicitly opened account', async () => {
  const f = fixture({ delayedHistory: true }); await f.load();
  const parentUrl = f.location.href;
  f.node('overview-author-1').focus(); await f.openAccount(1);
  await f.closeAccount(); await f.settled();
  assert.equal(f.historyBackCalls(), 1); assert.equal(f.traversals(), 0);
  assert.equal(f.queuedHistoryTraversals(), 1);

  f.setView('accounts');
  const trigger = f.node('overview-author-2'); trigger.focus();
  f.window.scrollY = 470;
  await f.openAccount(2);
  const body = f.node('dialogBody').innerHTML;
  await f.flushHistoryTraversal();

  assert.equal(f.node('accountDialog').open, true); assert.equal(f.state.detailId, 2);
  assert.equal(f.state.view, 'overview', 'a newer account open supersedes the previously queued view');
  assert.equal(f.node('dialogBody').innerHTML, body);
  assert.equal(f.history.state.mcnAccountDetail.id, 2);
  assert.equal(f.historyEntries(), 2); assert.equal(f.historyBackCalls(), 1);
  assert.equal(f.traversals(), 1); assert.equal(f.queuedHistoryTraversals(), 0);
  f.history.back(); await f.flushHistoryTraversal();
  assert.equal(f.node('accountDialog').open, false); assert.equal(f.location.href, parentUrl);
  assert.equal(f.document.activeElement, trigger); assert.equal(f.window.scrollY, 470);
  f.history.forward(); await f.flushHistoryTraversal();
  assert.equal(f.node('accountDialog').open, true); assert.equal(f.state.detailId, 2);
  assert.equal(f.calls.filter(path => path.startsWith('/api/rebuild/insights?')).length, 1);
});

test('same-task detail reopen cancels an undispatched close traversal', async () => {
  const f = fixture({ delayedHistory: true }); await f.load();
  await f.openAccount(1);
  const closing = f.closeAccount();
  const opening = f.openAccount(2);
  await Promise.all([closing, opening]); await f.settled();
  assert.equal(f.node('accountDialog').open, true); assert.equal(f.state.detailId, 2);
  assert.equal(f.history.state.mcnAccountDetail.id, 2);
  assert.equal(f.historyBackCalls(), 0); assert.equal(f.queuedHistoryTraversals(), 0);
  // The cancelled pending record cannot trap subsequent ordinary navigation.
  await f.closeAccount(); await f.settled(); await f.flushHistoryTraversal();
  f.setView('accounts');
  assert.equal(f.state.view, 'accounts'); assert.equal(f.location.hash, '#accounts');
});

test('delayed owned detail Back after an applied parent repaint still honors newer navigation', async () => {
  const f = fixture({ delayedHistory: true }); await f.load();
  const parentBase = f.location.href;
  await f.openAccount(1);
  f.editDates(); await f.load();
  const applied = f.state.data;
  assert.notEqual(f.location.href, parentBase, 'the modal URL now describes the applied repaint');
  await f.closeAccount(); await f.settled();
  f.setView('accounts'); await f.flushHistoryTraversal();

  assert.equal(f.state.view, 'accounts'); assert.equal(f.location.hash, '#accounts');
  assert.equal(f.state.data, applied, 'consuming Back must not restore the old parent range');
  assert.equal(f.getApplied().start, draft.start); assert.equal(f.getApplied().end, draft.end);
  assert.equal(new URL(f.location.href).searchParams.get('start'), draft.start);
  assert.equal(f.calls.filter(path => path.startsWith('/api/rebuild/insights?')).length, 2);
});

test('closing a detail without a locally owned history record never calls browser Back', async () => {
  const f = fixture(); await f.load();
  f.history.pushState = undefined;
  f.history.replaceState({ external: 'preserve', mcnAccountDetail: { owner: 'a previous page lifetime', id: 1, base: f.location.href } }, '', f.location.href);
  await f.openAccount(1); await f.closeAccount();
  assert.equal(f.node('accountDialog').open, false); assert.equal(f.historyBackCalls(), 0);
  assert.equal(f.history.state.external, 'preserve');
});

test('Back during a pending detail read prevents its late response from reopening or overwriting a newer Forward read', async () => {
  const { f } = await managerLedger(); let finish;
  f.setHandler(path => new Promise(resolve => { finish = () => {
    const data = f.payload(path); data.account.metrics.likes.value = 999999;
    resolve({ ok: true, json: async () => data });
  }; }));
  const stale = f.openAccount(21);
  f.history.back(); await f.settled();
  assert.equal(f.node('accountDialog').open, false); assert.equal(f.state.detailId, null);
  f.setHandler(async path => ({ ok: true, json: async () => f.payload(path) }));
  f.history.forward(); await f.settled();
  const freshBody = f.node('dialogBody').innerHTML;
  finish(); await stale; await f.settled();
  assert.equal(f.node('accountDialog').open, true); assert.equal(f.state.detailId, 21);
  assert.equal(f.node('dialogBody').innerHTML, freshBody); assert.doesNotMatch(freshBody, /999,999/);
});

test('Forward after a parent scope change restores that detail entry scope before displaying its metrics', async () => {
  const { f } = await managerLedger(); await f.openAccount(21);
  f.history.back(); await f.settled();
  f.node('boardSelect').value = 'second'; f.node('boardSelect').onchange(); await f.settled();
  assert.equal(f.getApplied().board, 'second');
  f.history.forward(); await f.settled();
  assert.equal(f.getApplied().board, 'first'); assert.equal(f.state.board, 'first');
  assert.equal(f.node('accountDialog').open, true); assert.equal(f.state.detailId, 21);
  assert.equal(f.state.page, 2); assert.equal(f.state.query, '测试账号');
  assertRequest(f.calls.at(-1), original);
});

test('browser Back while X close animates does not consume the parent history a second time', async () => {
  const { f } = await managerLedger(); await f.openAccount(21); let finishAnimation;
  f.window.matchMedia = () => ({ matches: false });
  f.node('accountDialog').animate = () => ({ finished: new Promise(resolve => { finishAnimation = resolve; }) });
  const closing = f.closeAccount();
  f.history.back(); await f.settled();
  finishAnimation(); await closing; await f.settled();
  assert.equal(f.node('accountDialog').open, false); assert.equal(f.historyBackCalls(), 1);
});

test('an applied parent range repaint keeps the owned detail entry restorable through Back and Forward', async () => {
  const { f } = await managerLedger(); await f.openAccount(21);
  f.editDates(); await f.load();
  assert.equal(f.history.state.mcnAccountDetail.base, f.location.href);
  f.history.back(); await f.settled();
  assert.equal(f.node('accountDialog').open, false); assert.equal(f.state.page, 2);
  f.history.forward(); await f.settled();
  assert.equal(f.node('accountDialog').open, true); assert.equal(f.state.detailId, 21);
  assert.equal(f.getApplied().start, draft.start); assert.equal(f.getApplied().end, draft.end);
  assert.match(f.node('dialogBody').innerHTML, /2026-09-01 至 2026-09-07/);
});

for (const closeKind of ['X', 'Escape']) {
  test(`${closeKind} animation cannot close a restored detail or repeat Back after immediate Back then Forward`, async () => {
    const { f } = await managerLedger(); await f.openAccount(21);
    const address = f.location.href, entry = f.history.state.mcnAccountDetail;
    let finishAnimation, cancelled = 0;
    f.window.matchMedia = () => ({ matches: false });
    // Deliberately retain a pending finished promise after cancellation. The
    // real continuation guard, not an idealized animation mock, must win.
    f.node('accountDialog').animate = () => ({
      finished: new Promise(resolve => { finishAnimation = resolve; }), cancel() { cancelled++; },
    });
    if (closeKind === 'X') f.clickCard({ closeDialog: '' });
    else assert.equal(f.cancelDialog().prevented, true);
    f.history.back(); f.history.forward(); await f.settled();
    assert.equal(f.location.href, address); assert.equal(f.historyEntries(), 2);
    assert.equal(f.history.state.mcnAccountDetail.sequence, entry.sequence);
    assert.equal(f.historyBackCalls(), 1); assert.equal(f.traversals(), 2);
    assert.equal(f.node('accountDialog').open, true); assert.equal(f.state.detailId, 21);
    assert.equal(cancelled, 1);
    finishAnimation(); await f.settled();
    assert.equal(f.location.href, address); assert.equal(f.history.state.mcnAccountDetail.sequence, entry.sequence);
    assert.equal(f.historyBackCalls(), 1); assert.equal(f.traversals(), 2);
    assert.equal(f.node('accountDialog').open, true); assert.equal(f.state.detailId, 21);
    assert.equal(f.state.page, 2); assert.equal(f.state.query, '测试账号');
  });
}
