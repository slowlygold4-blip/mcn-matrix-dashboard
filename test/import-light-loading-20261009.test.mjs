import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { File } from 'node:buffer';
import * as model from '../public/console-model.js';
import { createLiveSync } from '../public/live-sync.js';
import { createCollectionRefresh } from '../public/refresh-collection.js';

const JOB = 'a1111111-1111-4111-8111-111111111111';
const TODAY = '2026-10-09';
const response = body => ({ ok: true, status: 200, json: async () => body });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8')
  .replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '')
  .replace(/const \{ createLiveSync \} = await import\('\.\/live-sync\.js[^']*'\);/, '/* same factory injected below */')
  .replace(/const \{ createCollectionRefresh \} = await import\('\.\/refresh-collection\.js[^']*'\);/, '/* same factory injected below */');
function insight(path) {
  const query = new URL(path, 'http://fixture.test').searchParams;
  return { period: query.get('period'), range: { startDate: query.get('startDate') || TODAY, endDate: query.get('endDate') || TODAY },
    boards: [{ key: '团团切片', name: '团团切片' }], accounts: [], recordedWindow: null,
    themeSummary: { items: [] }, classificationSummary: { items: [] }, classificationSources: [], summary: { enabledCount: 0, metrics: {}, trend: [] } };
}
function fixture(url = 'http://fixture.test/?board=团团切片&theme=tuantuan&period=month#import') {
  const nodes = new Map(), calls = [], timers = new Map(), listeners = new Map();
  const document = { hidden: false, activeElement: null, addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener() {}, dispatchEvent() {}, hasFocus: () => true };
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, value: '', innerHTML: '', textContent: '', hidden: id === 'importPreview', open: false,
      disabled: false, isConnected: true, files: [], dataset: {}, attrs: {},
      setAttribute(key, value) { this.attrs[key] = value; }, getAttribute(key) { return this.attrs[key]; },
      classList: { add() {}, remove() {}, toggle() {} }, insertAdjacentHTML(_where, html) { this.innerHTML += html; },
      querySelector: () => null, querySelectorAll: () => [], matches: () => false, closest: () => null,
      contains(target) { return target === this; }, scrollIntoView() {}, addEventListener() {},
      focus() { document.activeElement = this; }, close() { this.open = false; } });
    return nodes.get(id);
  };
  Object.assign(document, { body: node('body'), documentElement: node('html'), getElementById: node, querySelectorAll: () => [], querySelector: selector => node(selector) });
  document.activeElement = document.body;
  const location = new URL(url);
  let timerId = 0, monitorCount = 0;
  const context = { ...model, fmt: model.formatNumber, beijingToday: () => TODAY, rangeFor: period => model.rangeFor(period, TODAY),
    URL, URLSearchParams, AbortController, Intl, Date, Uint8Array, File, structuredClone, createLiveSync, createCollectionRefresh,
    btoa: binary => Buffer.from(binary, 'binary').toString('base64'),
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    document, location, navigator: { onLine: true }, window: { addEventListener() {}, matchMedia: () => ({ matches: true }), scrollTo() {} },
    history: { state: null, replaceState(state, _unused, value) { this.state = state; location.href = String(value); } },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); },
    monitor: async () => { monitorCount++; return {}; },
    fetch: async path => { calls.push(path); return response(path === '/api/refresh-collection' ? { job: null } : path.includes('/recent?') ? { scope: 'mine', jobs: [] }
      : path.includes('/jobs/') ? { id: JOB, status: 'completed', fileName: '名单.csv', result: {} }
      : insight(path)); } };
  // Isolate this navigation/read policy from the parallel source-summary work.
  // Real boot/load/setView/API/live-sync/import parsing remain under test.
  runInNewContext(`${source}
    loadMonitoringStatus = async options => { const value = await monitor(options); latestMonitoringStatus = value; return value; };
    renderCatalog = () => {}; renderSummary = () => {}; renderAccounts = () => {}; renderTrend = () => {};
    closeAccount = async () => {};
    this.subject = {state, boot, load, refreshSnapshot, readSavedSnapshot, setView, restoreNavigation, setupDates, handleFile,
      loadImportWorkspace, importBoardCatalog, importSelectedBoard, startLiveSync,
      sync: () => liveSync, currentJob: () => currentImportJob, context: () => appliedContext};`, context);
  context.subject.state.session = { authenticated: true, user: { id: 'owner', role: 'admin' } };
  context.subject.setupDates();
  return { ...context.subject, node, calls, location, document, timers,
    monitorCount: () => monitorCount,
    setMonitor(fn) { context.monitor = async options => { monitorCount++; return fn(options); }; },
    setFetch(fn) { context.fetch = (path, options) => { calls.push(path); return fn(path, options); }; } };
}

test('cold import deep-link opens own task before status completes, without any insights/bootstrap read', async () => {
  const f = fixture(`http://fixture.test/?board=团团切片&theme=tuantuan&period=month&importJob=${JOB}#import`), gate = deferred();
  f.setMonitor(() => gate.promise);
  const boot = f.boot(); await settle();
  assert.ok(f.calls.includes(`/api/author-spreadsheet/jobs/${JOB}`));
  assert.ok(f.calls.includes('/api/author-spreadsheet/jobs/recent?limit=8&scope=mine'));
  assert.equal(f.calls.some(path => /insights|bootstrap/.test(path)), false);
  assert.equal(f.currentJob().id, JOB); assert.equal(f.state.busy, false);
  assert.equal(f.location.searchParams.get('board'), '团团切片');
  gate.resolve({}); await boot;
  assert.equal(f.state.data, null); assert.equal(f.node('refreshBtn').textContent, '刷新快照');
  assert.equal([...f.timers.values()].filter(timer => timer.delay === 30_000).length, 1);
});

test('saved import read only checks status/task and preserves preview, input and focus', async () => {
  const f = fixture(`http://fixture.test/?importJob=${JOB}#import`); await f.boot();
  f.node('importPreview').innerHTML = '不可丢失的预览'; f.node('importPreview').hidden = false;
  f.node('pasteAuthorsText').value = '待确认名单'; f.node('pasteAuthorsText').focus();
  const before = f.monitorCount(); await f.readSavedSnapshot(); await settle();
  assert.equal(f.monitorCount(), before + 1);
  assert.equal(f.calls.some(path => /insights|bootstrap/.test(path)), false);
  assert.equal(f.node('importPreview').innerHTML, '不可丢失的预览');
  assert.equal(f.node('pasteAuthorsText').value, '待确认名单');
  assert.equal(f.document.activeElement, f.node('pasteAuthorsText'));
});

test('first dashboard navigation after import loads its exact selected scope once', async () => {
  const f = fixture(); await f.boot(); f.setView('accounts'); await settle();
  const reads = f.calls.filter(path => path.startsWith('/api/rebuild/insights?'));
  assert.equal(reads.length, 1);
  const params = new URL(reads[0], f.location).searchParams;
  assert.equal(params.get('board'), '团团切片'); assert.equal(params.get('theme'), 'tuantuan');
  assert.equal(params.get('startDate'), '2026-10-01'); assert.equal(params.get('endDate'), TODAY);
  assert.equal(f.context().board, '团团切片'); assert.equal(f.state.busy, false);
});

test('navigating to import cancels a pending dashboard read and ignores a late success', async () => {
  const f = fixture('http://fixture.test/?period=month#accounts'), gate = deferred(); let dataPath;
  f.setFetch(path => path.includes('/insights?') ? (dataPath = path, gate.promise) : Promise.resolve(response({ scope: 'mine', jobs: [] })));
  f.setView('accounts', { renderData: false }); const pending = f.load();
  f.setView('import'); await settle(); gate.resolve(response(insight(dataPath))); await pending;
  assert.equal(f.state.view, 'import'); assert.equal(f.state.data, null); assert.equal(f.state.busy, false);
  assert.equal(f.location.hash, '#import'); assert.equal(f.node('connectionStatus').textContent, '导入状态已核对');
});

test('history navigation to an import URL reads its task immediately and preserves requested range for return', async () => {
  const f = fixture('http://fixture.test/?period=week#accounts'); await f.boot(); const before = f.calls.length;
  f.location.href = `http://fixture.test/?board=团团切片&theme=tuantuan&period=month&importJob=${JOB}#import`;
  await f.restoreNavigation({ state: null }); await settle();
  assert.equal(f.calls.slice(before).some(path => path.includes('/insights?')), false);
  assert.equal(f.currentJob().id, JOB); assert.equal(f.location.searchParams.get('period'), 'month');
  f.setView('overview'); await settle();
  const latest = new URL(f.calls.filter(path => path.includes('/insights?')).at(-1), f.location).searchParams;
  assert.equal(latest.get('startDate'), '2026-10-01'); assert.equal(latest.get('board'), '团团切片');
});

test('ordinary import round-trip preserves unapplied custom date draft and reads only applied dates', async () => {
  const f = fixture('http://fixture.test/?period=custom&start=2026-10-02&end=2026-10-06#accounts');
  await f.boot(); const applied = { ...f.context() };
  f.node('startDate').value = '2026-10-04'; f.node('endDate').value = '2026-10-08';
  f.setView('import'); await settle(); f.setView('accounts'); await settle();
  const params = new URL(f.calls.filter(path => path.includes('/insights?')).at(-1), f.location).searchParams;
  assert.equal(params.get('startDate'), applied.start); assert.equal(params.get('endDate'), applied.end);
  assert.equal(f.node('startDate').value, '2026-10-04'); assert.equal(f.node('endDate').value, '2026-10-08');
});

test('CSV preview uses its verified catalog on cold import and never invents an unknown URL board', async () => {
  const f = fixture(); await f.boot();
  f.setFetch(async () => response({ selectedSheet: 'CSV', sheets: [{ name: 'CSV' }], rows: [{ name: '作者', status: 'needs_locator' }],
    boardCatalog: [{ name: '团团切片' }, { name: '另一矩阵' }], summary: {} }));
  await f.handleFile(new File(['作者\n测试'], '名单.csv'));
  assert.match(f.node('importBoard').innerHTML, /团团切片/); assert.match(f.node('importBoard').innerHTML, /另一矩阵/);
  assert.equal(f.node('importBoard').value, '团团切片');
  f.state.board = 'URL未知矩阵'; await f.handleFile(new File(['作者\n测试'], '名单.csv'));
  assert.equal(f.node('importBoard').value, ''); assert.doesNotMatch(f.node('importBoard').innerHTML, /URL未知矩阵/);
});

test('batch preview confirms a URL key against the supplied catalog before setting blank-row default', async () => {
  const f = fixture('http://fixture.test/?board=board-a#import'); await f.boot();
  f.setFetch(async () => response({ uploadSha256: 'a'.repeat(64), totalAuthorRows: 1,
    boardCatalog: [{ key: 'board-a', name: '团团切片' }], sheets: [{ name: '账号', rowCount: 1, importable: true, summary: {}, sampleRows: [{ name: '作者' }] }] }));
  await f.handleFile(new File(['fixture'], '名单.xlsx'));
  assert.equal(f.node('batchBoard_0').value, '团团切片');
  assert.equal(f.calls.some(path => path.includes('/auto-monitor') || path.includes('/batch-submit')), false);
});

test('viewer cold import remains read-only without requesting task details or recent private jobs', async () => {
  const f = fixture(`http://fixture.test/?importJob=${JOB}#import`); f.state.session.user.role = 'viewer'; await f.boot();
  assert.equal(f.calls.length, 0); assert.equal(f.node('fileInput').disabled, true);
  assert.equal(f.node('previewPastedAuthors').disabled, true); assert.equal(f.state.data, null);
});

test('changing selected board on import saves navigation without querying matrix statistics', async () => {
  const f = fixture(); await f.boot(); f.state.board = '另一个已选择矩阵'; await f.load();
  assert.equal(f.location.searchParams.get('board'), '另一个已选择矩阵');
  assert.equal(f.location.searchParams.get('theme'), 'tuantuan');
  assert.equal(f.calls.some(path => path.includes('/insights?')), false);
});

test('preview catalog without a key does not erase an already verified opaque board key', () => {
  const f = fixture('http://fixture.test/?board=opaque-a#import');
  f.state.data = { boards: [{ key: 'opaque-a', name: '团团切片' }] };
  const catalog = f.importBoardCatalog([{ name: '团团切片' }]);
  assert.equal(f.importSelectedBoard(catalog), '团团切片');
  assert.equal(f.importSelectedBoard(catalog, undefined, 'arbitrary-key'), '');
});

test('repeated light reads share one pending status request without replacing the input draft', async () => {
  const f = fixture(), gate = deferred(); f.setView('import', { renderData: false });
  f.node('pasteAuthorsText').value = '还没确认'; f.setMonitor(() => gate.promise);
  const first = f.load(), second = f.load(); await settle(); assert.equal(f.monitorCount(), 1);
  gate.resolve({}); await Promise.all([first, second]);
  assert.equal(f.node('pasteAuthorsText').value, '还没确认'); assert.equal(f.node('refreshBtn').disabled, false);
});

test('import status errors preserve drafts, expose an escaped reason and release retry control', async () => {
  const f = fixture(); f.setView('import', { renderData: false });
  f.node('pasteAuthorsText').value = '还没确认'; f.setMonitor(async () => { throw new Error('<网络失败>'); });
  await f.load();
  assert.equal(f.node('pasteAuthorsText').value, '还没确认'); assert.equal(f.node('refreshBtn').disabled, false);
  assert.match(f.node('loadFeedback').innerHTML, /&lt;网络失败&gt;/);
  assert.equal(f.node('connectionStatus').attrs['data-state'], 'error');
});

test('light import status failure keeps editable draft and cannot overwrite a later dashboard result', async () => {
  const f = fixture(), gate = deferred(); f.setView('import', { renderData: false });
  f.node('pasteAuthorsText').value = '还没提交'; f.setMonitor(() => gate.promise);
  const old = f.loadImportWorkspace(); f.setMonitor(async () => ({}));
  f.setView('accounts'); await settle(); const caption = f.node('connectionStatus').textContent;
  gate.reject(new Error('旧请求失败')); await old;
  assert.equal(f.node('connectionStatus').textContent, caption); assert.equal(f.node('pasteAuthorsText').value, '还没提交');
});

test('live status-only mode skips full reads on forced ticks and five-minute fallback, then reads missed changes on return', async () => {
  let clock = 0, version = 0, statusReads = 0, dataReads = 0;
  const context = { visible: true, online: true, busy: false, blocked: '导入页', scopeKey: 'same', readDataAllowed: false };
  const sync = createLiveSync({ now: () => clock, context: () => context, readStatus: async () => { statusReads++; return { sourcePoller: { updatedAt: String(version) } }; },
    readData: async () => { dataReads++; return {}; }, applyData: () => true });
  sync.markApplied({ sourcePoller: { updatedAt: '0' } }); version++; clock = 300_001;
  await sync.tick({ force: true }); await sync.tick();
  assert.equal(statusReads, 2); assert.equal(dataReads, 0); assert.equal(sync.snapshot().pending, false);
  context.readDataAllowed = true; context.blocked = ''; await sync.tick(); assert.equal(dataReads, 1);
  context.visible = false; await sync.tick({ force: true }); assert.equal(statusReads, 3);
});

test('real import sync wiring reads status but no matrix before the first dashboard snapshot', async () => {
  const f = fixture(); await f.boot(); const before = f.monitorCount();
  await f.sync().tick({ force: true });
  assert.equal(f.monitorCount(), before + 1); assert.equal(f.calls.some(path => path.includes('/insights?')), false);
  f.document.hidden = true; await f.sync().tick({ force: true }); assert.equal(f.monitorCount(), before + 1);
});
