import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const account = id => ({ id, label: `团团${id}`, platform: 'douyin', enabled: true, boards: [], trend: [],
  status: {}, collection: {}, metrics: Object.fromEntries(Object.keys(model.METRICS).map(key => [key, { value: id, delta: null }])) });
function insights(label = 'fresh', count = 45) {
  return { reviewLabel: label, period: 'day', range: { startDate: '2026-09-28', endDate: '2026-09-28' },
    boards: [], accounts: Array.from({ length: count }, (_, index) => account(index + 1)),
    themeSummary: { items: [{ key: 'all', label: '全部主题', count }, { key: 'tuantuan', label: '团团', count }] },
    classificationSummary: { items: [{ key: 'all', label: '全部内容', count }] }, summary: { enabledCount: count, metrics: {}, trend: [] } };
}

// Real load/render/bind code; only browser DOM and read-only HTTP are fixtures.
// In particular the disabled setter models the observed native focus loss.
function fixture() {
  const nodes = new Map(), listeners = new Map();
  let documentFocused = true, insightReads = 0, generation = 0;
  const document = { activeElement: null, querySelectorAll: () => [],
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    hasFocus: () => documentFocused };
  const dispatch = (type, event) => { for (const fn of listeners.get(type) || []) fn(event); };
  function node(id) {
    if (nodes.has(id)) return nodes.get(id);
    const item = { id, value: '', textContent: '', hidden: id === 'importPreview', open: false, files: [],
      dataset: {}, tagName: 'DIV', isConnected: true, attributes: {}, focusCalls: [], _disabled: false, _html: '',
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(key, value) { this.attributes[key] = value; }, getAttribute(key) { return this.attributes[key]; },
      hasAttribute(key) { return Object.hasOwn(this.attributes, key); }, addEventListener() {},
      insertAdjacentHTML(_position, html) { this._html += html; },
      matches() { return false; }, contains(target) { return this === target; },
      closest(selector) { return this.rootId && selector.includes(`#${this.rootId}`) ? node(this.rootId) : null; },
      focus(options) { if (this.disabled) return; this.focusCalls.push(options); document.activeElement = this; dispatch('focusin', { target: this }); },
      showModal() { this.open = true; }, close() { this.open = false; },
      querySelector(selector) {
        const match = /^\[data-(sort|page)="([^"]+)"\]$/.exec(selector);
        if (!match || !this._html.includes(`data-${match[1]}="${match[2]}"`)) return null;
        const control = node(`${this.id}:control:${++generation}`);
        control.tagName = 'BUTTON'; control.dataset[match[1]] = match[2]; control.rootId = this.id;
        return control;
      } };
    Object.defineProperty(item, 'disabled', { get() { return this._disabled; }, set(value) {
      this._disabled = value;
      if (value && document.activeElement === this) document.activeElement = document.body;
    } });
    Object.defineProperty(item, 'innerHTML', { get() { return this._html; }, set(value) {
      const active = document.activeElement;
      if (active?.rootId === this.id) { active.isConnected = false; document.activeElement = document.body; }
      this._html = value;
    } });
    nodes.set(id, item); return item;
  }
  document.body = node('body'); document.documentElement = node('html'); document.activeElement = document.body;
  document.getElementById = node;
  document.querySelector = selector => node(selector);
  const location = new URL('http://127.0.0.1:4188/?theme=tuantuan&sort=likes.value&direction=asc&page=2#accounts');
  const context = { ...model, fmt: model.formatNumber, beijingToday: () => '2026-09-28',
    rangeFor: period => model.rangeFor(period, '2026-09-28'), URL, URLSearchParams, Intl, Date, AbortController,
    document, location, history: { replaceState(_a, _b, value) { location.href = String(value); } },
    window: { matchMedia: query => ({ matches: query.includes('prefers-reduced-motion') }), addEventListener() {} }, setTimeout, clearTimeout,
    fetch: async path => { if (path === '/api/monitoring-status') return response({}); insightReads++; return response(insights()); } };
  const sourcePath = process.env.REBUILD_FOCUS_CANDIDATE || new URL('../public/rebuild.js', import.meta.url);
  const source = readFileSync(sourcePath, 'utf8').replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '');
  runInNewContext(`${source}\nthis.subject={state,load,bind,renderAccounts};`, context);
  const subject = context.subject;
  subject.state.data = insights('saved'); subject.state.view = 'accounts'; subject.state.page = 2;
  subject.bind(); subject.renderAccounts();
  return { ...subject, node, document, location, dispatch, reads: () => insightReads,
    listeners: type => listeners.get(type)?.size || 0, setDocumentFocused(value) { documentFocused = value; },
    setInsights(handler) { context.fetch = async path => {
      if (path === '/api/monitoring-status') return response({});
      insightReads++; return handler(path);
    }; } };
}

test('manual refresh success restores only native disabled-button focus loss without scrolling', async () => {
  const f = fixture(), pending = deferred(), refresh = f.node('refreshBtn');
  f.setInsights(() => pending.promise); refresh.focus();
  const request = refresh.onclick();
  assert.equal(refresh.disabled, true); assert.equal(refresh.textContent, '读取中…');
  assert.equal(f.document.activeElement, f.document.body);
  pending.resolve(response(insights())); await request;
  // Also settle the original void onclick handler for the before/after proof.
  await new Promise(setImmediate);
  assert.equal(f.state.busy, false);
  assert.equal(f.document.activeElement, refresh);
  assert.equal(refresh.disabled, false); assert.equal(refresh.textContent, '刷新快照');
  assert.equal(refresh.focusCalls.at(-1).preventScroll, true);
  assert.equal(f.state.page, 2); assert.equal(f.state.sort, 'likes.value'); assert.equal(f.state.direction, 'asc');
  assert.match(f.location.href, /page=2/); assert.equal(f.listeners('focusin'), 0); assert.equal(f.listeners('pointerdown'), 0);
});

test('failed refresh retains data and keyboard focus; a retry succeeds with no stale feedback', async () => {
  const f = fixture(), refresh = f.node('refreshBtn');
  f.setInsights(() => response({ error: 'fixture unavailable' }, 503)); refresh.focus(); await refresh.onclick();
  assert.equal(f.document.activeElement, refresh); assert.equal(f.state.data.reviewLabel, 'saved');
  assert.match(f.node('notice').textContent, /fixture unavailable/);
  f.setInsights(() => response(insights('retry'))); await refresh.onclick();
  assert.equal(f.document.activeElement, refresh); assert.equal(f.state.data.reviewLabel, 'retry');
  assert.equal(f.node('notice').hidden, true); assert.equal(f.reads(), 2);
});

test('repeated manual activation while loading never duplicates the insight request', async () => {
  const f = fixture(), pending = deferred(), refresh = f.node('refreshBtn');
  f.setInsights(() => pending.promise); refresh.focus(); const first = refresh.onclick(); await refresh.onclick();
  assert.equal(f.reads(), 1); assert.equal(f.state.busy, true);
  pending.resolve(response(insights())); await first; assert.equal(f.document.activeElement, refresh);
});

for (const id of ['accountSearch', 'startDate', 'compareStart', 'classificationSelect', 'fileInput', 'detailClose']) {
  test(`refresh does not steal the user's newer ${id} focus or draft`, async () => {
    const f = fixture(), pending = deferred(), refresh = f.node('refreshBtn');
    f.setInsights(() => pending.promise); refresh.focus(); const request = refresh.onclick();
    const target = f.node(id); target.value = id === 'classificationSelect' ? 'all' : '未提交内容';
    if (id === 'detailClose') f.node('accountDialog').open = true;
    target.focus(); pending.resolve(response(insights())); await request;
    assert.equal(f.document.activeElement, target); assert.equal(refresh.focusCalls.length, 1);
    if (id !== 'classificationSelect') assert.equal(target.value, '未提交内容');
    if (id === 'detailClose') assert.equal(f.node('accountDialog').open, true);
  });
}

test('explicit pointer choice of the document background is not mistaken for native blur', async () => {
  const f = fixture(), pending = deferred(), refresh = f.node('refreshBtn');
  f.setInsights(() => pending.promise); refresh.focus(); const request = refresh.onclick();
  f.dispatch('pointerdown', { target: f.document.body });
  pending.resolve(response(insights())); await request;
  assert.equal(f.document.activeElement, f.document.body); assert.equal(refresh.focusCalls.length, 1);
});

test('focus moved away and then blurred does not get pulled back by completion', async () => {
  const f = fixture(), pending = deferred(), refresh = f.node('refreshBtn');
  f.setInsights(() => pending.promise); refresh.focus(); const request = refresh.onclick();
  f.node('accountSearch').focus(); f.document.activeElement = f.document.body;
  pending.resolve(response(insights())); await request; assert.equal(f.document.activeElement, f.document.body);
});

for (const kind of ['sort', 'page']) {
  test(`refresh preserves a newer ${kind} control focus when its table DOM is replaced`, async () => {
    const f = fixture(), pending = deferred(), refresh = f.node('refreshBtn');
    f.setInsights(() => pending.promise); refresh.focus(); const request = refresh.onclick();
    const target = f.node(`old-${kind}`); target.dataset[kind] = kind === 'sort' ? 'likes.value' : 'next';
    target.rootId = kind === 'sort' ? 'accountsTable' : 'pager'; target.focus();
    pending.resolve(response(insights())); await request;
    assert.equal(f.document.activeElement.dataset[kind], target.dataset[kind]);
    assert.notEqual(f.document.activeElement, refresh); assert.equal(refresh.focusCalls.length, 1);
  });
}

test('background tabs, detached buttons and non-button initiators never gain forced focus', async () => {
  for (const mode of ['background', 'detached', 'programmatic']) {
    const f = fixture(), pending = deferred(), refresh = f.node('refreshBtn');
    f.setInsights(() => pending.promise); if (mode !== 'programmatic') refresh.focus();
    const request = refresh.onclick();
    if (mode === 'background') f.setDocumentFocused(false);
    if (mode === 'detached') refresh.isConnected = false;
    pending.resolve(response(insights())); await request;
    assert.equal(f.document.activeElement, f.document.body, mode);
  }
});

test('superseding scope load owns busy state; the older manual request cannot restore early', async () => {
  const f = fixture(), older = deferred(), newer = deferred(), refresh = f.node('refreshBtn');
  let count = 0; f.setInsights(() => ++count === 1 ? older.promise : newer.promise);
  refresh.focus(); const first = refresh.onclick();
  f.node('themeSelect').focus(); f.state.theme = 'new-theme'; const second = f.load();
  older.resolve(response(insights('old'))); await first;
  assert.equal(refresh.disabled, true); assert.equal(f.state.busy, true);
  newer.resolve(response(insights('new'))); await second;
  assert.equal(f.document.activeElement, f.node('themeSelect')); assert.equal(f.state.data.reviewLabel, 'new');
  assert.equal(f.listeners('focusin'), 0); assert.equal(f.listeners('pointerdown'), 0);
});

test('a late old refresh cannot reclaim focus after a newer load already completed without focus movement', async () => {
  const f = fixture(), older = deferred(), newer = deferred(), refresh = f.node('refreshBtn');
  let count = 0; f.setInsights(() => ++count === 1 ? older.promise : newer.promise);
  refresh.focus(); const first = refresh.onclick();
  f.state.theme = 'new-theme'; const second = f.load();
  newer.resolve(response(insights('new'))); await second;
  assert.equal(f.state.busy, false); assert.equal(f.document.activeElement, f.document.body);
  older.resolve(response(insights('old'))); await first;
  assert.equal(f.state.data.reviewLabel, 'new'); assert.equal(f.document.activeElement, f.document.body);
  assert.equal(refresh.focusCalls.length, 1);
  assert.equal(f.listeners('focusin'), 0); assert.equal(f.listeners('pointerdown'), 0);
});
