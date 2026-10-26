import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';
import { createLiveSync, monitoringFingerprint } from '../public/live-sync.js';

// Independent review harness: run the real console source and its real model.
// Only the DOM, clock and network boundary are substituted; no sync policy is
// reproduced here. Deferred responses deliberately ignore AbortSignal so that
// sequence guards, not an idealized network mock, have to preserve user intent.
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
function account(id, label = `作者 ${id}`) {
  return { id, label, enabled: true, platform: 'douyin', boards: [], trend: [],
    metrics: Object.fromEntries(Object.keys(model.METRICS).map(key => [key, { value: id * 10, delta: id, dailyComparable: true }])),
    status: { lastSuccessAt: '2026-09-28T01:00:00.000Z' },
    collection: { date: '2026-09-28', profileObserved: true, worksState: 'complete' } };
}
function insight(label, accounts = [], date = '2026-09-28') {
  return { reviewLabel: label, period: 'day', range: { startDate: date, endDate: date }, boards: [], accounts,
    recordedWindow: null,
    themeSummary: { total: accounts.length, assigned: 0, unassigned: accounts.length, items: [{ key: 'all', count: accounts.length }] },
    classificationSummary: { total: accounts.length, classified: 0, unclassified: accounts.length, items: [{ key: 'all', count: accounts.length }] },
    classificationSources: [], summary: { enabledCount: accounts.length, metrics: {}, trend: [] } };
}
function fixture(url = 'http://127.0.0.1:4188/#accounts') {
  const nodes = new Map(), documentListeners = new Map(), windowListeners = new Map();
  const timers = new Map();
  let today = '2026-09-28', clock = Date.parse('2026-09-28T01:00:00Z'), nextTimer = 1;
  class FixtureDate extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const document = { visibilityState: 'visible', hidden: false, activeElement: null,
    addEventListener(type, fn) { documentListeners.set(type, fn); },
    querySelectorAll() { return []; } };
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { id, value: '', innerHTML: '', textContent: '', hidden: id === 'importPreview',
      open: false, disabled: false, dataset: {}, tagName: 'DIV', isConnected: true, attributes: {},
      classList: { add() {}, remove() {}, toggle() {} },
      showModal() { this.open = true; }, close() { this.open = false; },
      setAttribute(key, value) { this.attributes[key] = value; }, getAttribute(key) { return this.attributes[key]; },
      insertAdjacentHTML(_position, html) { this.innerHTML += html; },
      querySelector() { return null; }, closest() { return null; }, matches() { return false; },
      addEventListener() {}, focus() { document.activeElement = this; } });
    return nodes.get(id);
  }
  document.getElementById = node;
  document.querySelector = selector => selector === 'dialog[open]' ? [...nodes.values()].find(value => value.open) || null
    : selector.includes('details[open]') ? null : node(selector);
  document.activeElement = node('body');
  const location = new URL(url);
  const context = { ...model, fmt: model.formatNumber, beijingToday: () => today,
    rangeFor: (period, end = today) => model.rangeFor(period, end), URL, URLSearchParams, Intl, Date: FixtureDate, structuredClone, AbortController, createLiveSync,
    fetch: async () => { throw new Error('unexpected request'); }, document, location,
    history: { replaceState(_a, _b, value) { location.href = String(value); } },
    window: { matchMedia: () => ({ matches: true }), addEventListener(type, fn) { windowListeners.set(type, fn); }, scrollTo() {}, scrollX: 0, scrollY: 0 }, navigator: { onLine: true },
    setTimeout(callback, delay) { const id = nextTimer++; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval: () => 1, clearInterval() {} };
  const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8')
    .replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '')
    // The dynamic browser loader has no DOM policy: inject that same real
    // module factory, not a copy, so the actual startup wiring is exercised.
    .replace(/const \{ createLiveSync \} = await import\('\.\/live-sync\.js[^']*'\);/, '/* live-sync module imported by test harness */');
  const optional = ['automaticScopeKey', 'automaticRead', 'automaticApply', 'syncBlockedReason', 'syncContext', 'startLiveSync', 'loadTopics', 'renderCatalog'];
  runInNewContext(`${source}\nthis.subject={state,load,renderAccounts,setupDates,selectedDates,appliedRange,bind,setView,openAccount,${optional.map(name => `${name}:typeof ${name}==='function'?${name}:undefined`).join(',')}};`, context);
  const subject = context.subject;
  subject.state.data = insight('saved');
  subject.setupDates();
  return { ...subject, node, document, location, documentListeners, windowListeners, timers,
    setToday(value) { today = value; }, setFetch(value) { context.fetch = value; }, advanceTime(value) { clock += value; },
    async runTimer(delay) {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `expected scheduled ${delay} ms timer`);
      timers.delete(entry[0]); clock += delay; entry[1].callback();
      await new Promise(setImmediate);
    } };
}

test('review: newest manual scope wins even when aborted older request later succeeds', async () => {
  const f = fixture(), older = deferred(), newer = deferred();
  let calls = 0;
  f.setFetch(path => path === '/api/monitoring-status' ? Promise.resolve(response({})) : (++calls === 1 ? older.promise : newer.promise));
  f.state.board = '旧板块'; const first = f.load();
  f.state.board = '新板块'; const second = f.load();
  newer.resolve(response(insight('newer', [account(2, '新板块作者')]))); await second;
  older.resolve(response(insight('older', [account(1, '旧板块作者')]))); await first;
  assert.equal(f.state.data.reviewLabel, 'newer');
  assert.match(f.node('accountsTable').innerHTML, /新板块作者/);
  assert.doesNotMatch(f.node('accountsTable').innerHTML, /旧板块作者/);
  assert.equal(f.state.busy, false);
});

test('review: late older network error cannot replace latest success feedback', async () => {
  const f = fixture(), older = deferred(); let calls = 0;
  f.setFetch(path => path === '/api/monitoring-status' ? Promise.resolve(response({})) : (++calls === 1 ? older.promise : Promise.resolve(response(insight('latest')))));
  const first = f.load(); await f.load();
  older.reject(new Error('old request failed')); await first;
  assert.equal(f.state.data.reviewLabel, 'latest');
  assert.doesNotMatch(f.node('notice').textContent, /old request failed/);
  assert.equal(f.node('connectionStatus').attributes['data-state'], 'success');
});

test('review: 403 keeps previously applied evidence and disables misleading new export', async () => {
  const f = fixture();
  f.state.data = insight('saved evidence', [account(1, '保留作者')], '2026-09-27');
  f.renderAccounts(); const original = f.node('accountsTable').innerHTML;
  f.setFetch(async path => path === '/api/monitoring-status' ? response({}) : response({ error: '需要重新登录' }, 403));
  await f.load();
  assert.equal(f.state.data.reviewLabel, 'saved evidence');
  assert.equal(f.node('accountsTable').innerHTML, original);
  assert.equal(f.appliedRange().end, '2026-09-27');
  assert.match(f.node('notice').textContent, /需要重新登录/);
  assert.match(f.node('notice').textContent, /保留/);
  assert.equal(f.node('exportButton').disabled, true);
});

test('review: data refresh preserves local investigation filters and clamps page only to actual results', async () => {
  const f = fixture();
  f.state.query = '团团'; f.state.platform = 'douyin'; f.state.enabled = 'active';
  f.state.sort = 'likes.value'; f.state.direction = 'asc'; f.state.page = 4;
  const next = deferred();
  f.setFetch(path => path === '/api/monitoring-status' ? Promise.resolve(response({})) : next.promise);
  const pending = f.load();
  assert.equal(f.state.page, 4, 'in-flight request does not prematurely clamp saved page');
  next.resolve(response(insight('small set', [account(2, '团团B'), account(1, '团团A'), account(3, '其他')]))); await pending;
  assert.equal(f.state.page, 1);
  assert.equal(f.state.query, '团团'); assert.equal(f.state.platform, 'douyin');
  assert.equal(f.state.sort, 'likes.value'); assert.equal(f.state.direction, 'asc');
  assert.match(f.node('accountCount').textContent, /筛选结果 2 个/);
  assert.ok(f.node('accountsTable').innerHTML.indexOf('团团A') < f.node('accountsTable').innerHTML.indexOf('团团B'));
  assert.doesNotMatch(f.node('accountsTable').innerHTML, /其他/);
});

function monitoring(completedCount = 1) {
  return { scheduler: { currentRun: { runId: 71, completedCount, heartbeatAt: '2026-09-28T01:00:00Z' },
    lastScheduledRunFinishedAt: '2026-09-27T19:00:00Z', currentSlotKey: '2026-09-28T02:00+08:00' },
  sourcePoller: { updatedAt: '2026-09-28T00:30:00Z' } };
}
function syncFixture(options = {}) {
  const current = { visible: true, online: true, blocked: '', busy: false, scopeKey: 'scope-a' };
  let time = 1_000, status = monitoring(), statusReads = 0, dataReads = 0;
  const applied = [], notifications = [];
  const sync = createLiveSync({ context: () => ({ ...current }), now: () => time,
    readStatus: async args => { statusReads++; return options.readStatus ? options.readStatus(args) : status; },
    readData: async args => { dataReads++; return options.readData ? options.readData(args) : { scope: args.scopeKey, revision: dataReads }; },
    applyData: (data, meta) => { applied.push({ data, meta }); return true; },
    notify: event => notifications.push(event) });
  sync.markApplied(status);
  return { sync, current, applied, notifications, reads: () => ({ status: statusReads, data: dataReads }),
    setTime(value) { time = value; }, setStatus(value) { status = value; } };
}

test('review: cheap polling ignores heartbeats without progress but detects all ingestion fingerprints', () => {
  const base = monitoring(), fingerprint = monitoringFingerprint(base);
  const heartbeat = structuredClone(base); heartbeat.scheduler.currentRun.heartbeatAt = '2026-09-28T01:00:30Z';
  assert.equal(monitoringFingerprint(heartbeat), fingerprint, 'heartbeat alone is not evidence of a changed snapshot');
  for (const mutate of [
    data => { data.scheduler.currentRun.runId++; },
    data => { data.scheduler.currentRun.completedCount++; },
    data => { data.scheduler.lastScheduledRunFinishedAt = '2026-09-28T01:01:00Z'; },
    data => { data.scheduler.currentSlotKey = '2026-09-28T10:00+08:00'; },
    data => { data.sourcePoller.updatedAt = '2026-09-28T01:00:30Z'; },
  ]) { const value = structuredClone(base); mutate(value); assert.notEqual(monitoringFingerprint(value), fingerprint); }
});

test('review: unchanged status stays cheap until exactly five-minute fallback, changed status refreshes immediately', async () => {
  const f = syncFixture();
  await f.sync.tick(); assert.deepEqual(f.reads(), { status: 1, data: 0 });
  f.setTime(300_999); await f.sync.tick(); assert.equal(f.reads().data, 0);
  f.setTime(301_000); await f.sync.tick(); assert.equal(f.reads().data, 1);
  f.setStatus(monitoring(2)); await f.sync.tick(); assert.equal(f.reads().data, 2);
  assert.equal(f.applied.length, 2);
});

test('review: hidden or offline tabs make no reads and resume from real status when visible again', async () => {
  const f = syncFixture();
  f.current.visible = false; await f.sync.tick({ force: true });
  f.current.visible = true; f.current.online = false; await f.sync.tick({ force: true });
  assert.deepEqual(f.reads(), { status: 0, data: 0 });
  f.current.online = true; f.setStatus(monitoring(3)); await f.sync.tick();
  assert.deepEqual(f.reads(), { status: 1, data: 1 }); assert.equal(f.applied.length, 1);
});

test('review: focus acquired during a slow read defers apply, then flush keeps the latest saved data', async () => {
  const data = deferred(), entered = deferred();
  const f = syncFixture({ readData: () => { entered.resolve(); return data.promise; } });
  f.setStatus(monitoring(2)); const pending = f.sync.tick(); await entered.promise;
  f.current.blocked = '正在输入'; data.resolve({ revision: 2 }); await pending;
  assert.equal(f.applied.length, 0); assert.equal(f.sync.snapshot().pending, true);
  f.current.blocked = ''; assert.equal(f.sync.flush(), true);
  assert.equal(f.applied[0].data.revision, 2); assert.equal(f.sync.snapshot().pending, false);
});

test('review: becoming hidden during a slow read cannot repaint until foreground returns', async () => {
  const data = deferred(), entered = deferred();
  const f = syncFixture({ readData: () => { entered.resolve(); return data.promise; } });
  const pending = f.sync.tick({ force: true }); await entered.promise;
  f.current.visible = false; data.resolve({ revision: 2 }); await pending;
  assert.equal(f.applied.length, 0); assert.equal(f.sync.flush(), false);
  f.current.visible = true; assert.equal(f.sync.flush(), true); assert.equal(f.applied.length, 1);
});

test('review: manual scope invalidation defeats a late automatic response even if abort is ignored', async () => {
  const data = deferred(), entered = deferred();
  const f = syncFixture({ readData: () => { entered.resolve(); return data.promise; } });
  const pending = f.sync.tick({ force: true }); await entered.promise;
  f.current.scopeKey = 'scope-b'; f.sync.invalidate();
  data.resolve({ scope: 'scope-a', revision: 2 }); await pending;
  assert.equal(f.applied.length, 0); assert.equal(f.sync.snapshot().pending, false);
  assert.equal(f.sync.snapshot().inFlight, false);
});

test('review: queued automatic data from an old scope cannot flush over a manual new scope', async () => {
  const f = syncFixture(); f.current.blocked = '详情查看中';
  await f.sync.tick({ force: true }); assert.equal(f.sync.snapshot().pending, true);
  f.current.scopeKey = 'scope-b'; f.current.blocked = '';
  assert.equal(f.sync.flush(), false); assert.equal(f.sync.snapshot().pending, false);
  assert.equal(f.applied.length, 0);
});

test('review: automatic requests are serialized and repeated ticks share the same in-flight work', async () => {
  const status = deferred(); const f = syncFixture({ readStatus: () => status.promise });
  const first = f.sync.tick({ force: true }), second = f.sync.tick({ force: true });
  assert.equal(first, second); assert.deepEqual(f.reads(), { status: 1, data: 0 });
  status.resolve(monitoring(2)); await Promise.all([first, second]);
  assert.equal(f.reads().data, 1); assert.equal(f.applied.length, 1);
});

test('review: a 403 snapshot failure preserves the applied fingerprint and is retryable without waiting five minutes', async () => {
  let denied = true;
  const f = syncFixture({ readData: async () => { if (denied) throw Object.assign(new Error('登录已过期'), { status: 403 }); return { revision: 2 }; } });
  const original = f.sync.snapshot().fingerprint; f.setStatus(monitoring(2));
  await f.sync.tick();
  assert.equal(f.applied.length, 0); assert.equal(f.sync.snapshot().fingerprint, original);
  assert.equal(f.sync.snapshot().failed, true);
  assert.equal(f.notifications.at(-1).status, 403);
  denied = false; await f.sync.tick();
  assert.equal(f.applied.length, 1); assert.equal(f.sync.snapshot().failed, false);
});

test('review: stopping while a request is unresolved suppresses all later data application', async () => {
  const data = deferred(), entered = deferred();
  const f = syncFixture({ readData: () => { entered.resolve(); return data.promise; } });
  const pending = f.sync.tick({ force: true }); await entered.promise;
  f.sync.stop(); data.resolve({ revision: 2 }); await pending;
  await f.sync.tick({ force: true });
  assert.equal(f.applied.length, 0); assert.deepEqual(f.reads(), { status: 1, data: 1 });
});

async function prime(f, data = insight('applied')) {
  f.setFetch(async path => path === '/api/monitoring-status' ? response(monitoring()) : response(data));
  await f.load();
  assert.equal(f.syncBlockedReason(), '');
}

test('review: actual UI automatic reads use committed custom/comparison dates, never unapplied drafts', async () => {
  const f = fixture('http://127.0.0.1:4188/?period=custom&start=2026-09-20&end=2026-09-22&compare=1&compareStart=2026-09-17&compareEnd=2026-09-19');
  f.node('compareStart').value = '2026-09-17'; f.node('compareEnd').value = '2026-09-19';
  const data = insight('applied custom'); data.period = 'custom'; data.range = { startDate: '2026-09-20', endDate: '2026-09-22' };
  await prime(f, data);
  f.node('startDate').value = '2026-09-21'; f.node('compareStart').value = '2026-09-18';
  assert.match(f.syncBlockedReason(), /未应用/);
  let request;
  f.setFetch(async path => { request = path; return response(data); });
  const payload = await f.automaticRead({ signal: new AbortController().signal });
  const query = new URL(request, 'https://example.test').searchParams;
  assert.equal(query.get('startDate'), '2026-09-20');
  assert.equal(query.get('comparisonStartDate'), '2026-09-17');
  assert.equal(f.automaticApply(payload, { scopeKey: f.automaticScopeKey() }), false);
  assert.equal(f.node('startDate').value, '2026-09-21'); assert.equal(f.node('compareStart').value, '2026-09-18');
});

test('review: real UI blocks automatic apply for import drafts, details and focused inputs', async () => {
  const f = fixture(); await prime(f);
  const scopeKey = f.automaticScopeKey(), payload = { insights: insight('next'), query: 'period=day' };
  f.node('accountDialog').open = true;
  assert.match(f.syncBlockedReason(), /详情/); assert.equal(f.automaticApply(payload, { scopeKey }), false);
  f.node('accountDialog').open = false; f.node('importPreview').hidden = false;
  assert.match(f.syncBlockedReason(), /导入/); assert.equal(f.automaticApply(payload, { scopeKey }), false);
  f.node('importPreview').hidden = true; f.node('fileInput').files = [{ name: '尚未确认.xlsx' }];
  assert.match(f.syncBlockedReason(), /导入/);
  f.node('fileInput').files = []; f.document.activeElement = { matches: () => true };
  assert.match(f.syncBlockedReason(), /正在输入/); assert.equal(f.automaticApply(payload, { scopeKey }), false);
  assert.equal(f.state.data.reviewLabel, 'applied');
});

test('review: Beijing midnight advances rolling automatic dates and visible controls together', async () => {
  const f = fixture('http://127.0.0.1:4188/?period=week');
  const old = insight('yesterday'); old.range = { startDate: '2026-09-22', endDate: '2026-09-28' }; old.period = 'custom';
  await prime(f, old); f.setToday('2026-09-29');
  const next = insight('new day', [], '2026-09-29'); next.range.startDate = '2026-09-23'; next.period = 'custom';
  let request;
  f.setFetch(async path => { request = path; return response(next); });
  const scopeKey = f.automaticScopeKey(), payload = await f.automaticRead({ signal: new AbortController().signal });
  assert.match(request, /startDate=2026-09-23&endDate=2026-09-29/);
  assert.equal(f.automaticApply(payload, { scopeKey }), true);
  assert.equal(f.node('startDate').value, '2026-09-23'); assert.equal(f.node('endDate').value, '2026-09-29');
  assert.equal(f.node('compareStart').max, '2026-09-29');
  assert.match(f.node('accountCount').textContent, /2026-09-23 至 2026-09-29/);
  assert.equal(f.syncBlockedReason(), '');
});

test('review: Beijing midnight does not move a committed custom historical interval', async () => {
  const f = fixture('http://127.0.0.1:4188/?period=custom&start=2026-09-20&end=2026-09-22');
  const data = insight('history'); data.period = 'custom'; data.range = { startDate: '2026-09-20', endDate: '2026-09-22' };
  await prime(f, data); f.setToday('2026-09-29');
  let request; f.setFetch(async path => { request = path; return response(data); });
  const scopeKey = f.automaticScopeKey(), payload = await f.automaticRead({ signal: new AbortController().signal });
  assert.match(request, /startDate=2026-09-20&endDate=2026-09-22/);
  assert.equal(f.automaticApply(payload, { scopeKey }), true);
  assert.equal(f.node('endDate').value, '2026-09-22'); assert.equal(f.state.period, 'custom');
});

test('review: actual automatic apply cannot replace a scope selected while its network request was pending', async () => {
  const f = fixture(); await prime(f);
  const pending = deferred(); f.setFetch(() => pending.promise);
  const scopeKey = f.automaticScopeKey(), request = f.automaticRead({ signal: new AbortController().signal });
  f.state.theme = 'tuantuan';
  pending.resolve(response(insight('old all-author scope')));
  const payload = await request;
  assert.equal(f.automaticApply(payload, { scopeKey }), false);
  assert.equal(f.state.data.reviewLabel, 'applied'); assert.equal(f.state.theme, 'tuantuan');
});

test('review: editing comparison controls during manual fetch stays an unapplied draft after its old response', async () => {
  const f = fixture('http://127.0.0.1:4188/?compare=1&compareStart=2026-09-20&compareEnd=2026-09-21');
  f.node('compareStart').value = '2026-09-20'; f.node('compareEnd').value = '2026-09-21';
  await prime(f);
  const next = deferred();
  f.setFetch(path => path === '/api/monitoring-status' ? Promise.resolve(response(monitoring())) : next.promise);
  const loading = f.load();
  f.node('compareStart').value = '2026-09-18';
  next.resolve(response(insight('old comparison request'))); await loading;
  assert.equal(f.node('compareStart').value, '2026-09-18');
  assert.match(f.syncBlockedReason(), /未应用/, 'request completion must not silently commit controls edited after dispatch');
});

test('review: successful automatic recovery clears obsolete manual error feedback and restores export', async () => {
  const f = fixture(); await prime(f);
  f.setFetch(async path => path === '/api/monitoring-status' ? response(monitoring()) : response({ error: '临时不可用' }, 503));
  await f.load();
  assert.equal(f.node('exportButton').disabled, true);
  const scopeKey = f.automaticScopeKey();
  const applied = f.automaticApply({ insights: insight('recovered'), query: 'period=day&board=&theme=all&classification=all' }, { scopeKey });
  assert.equal(applied, true); assert.equal(f.state.data.reviewLabel, 'recovered');
  assert.equal(f.node('exportButton').disabled, false, 'export is safe again once new data was actually applied');
  assert.doesNotMatch(f.node('notice').textContent, /临时不可用/);
  assert.notEqual(f.node('connectionStatus').attributes['data-state'], 'error');
});

test('review: a structurally invalid 200 insight response is a failure, not replacement of saved evidence', async () => {
  const f = fixture(); await prime(f, insight('last valid evidence', [account(1)]));
  const previous = f.state.data, table = f.node('accountsTable').innerHTML;
  f.setFetch(async path => path === '/api/monitoring-status' ? response(monitoring()) : response({ error: 'upstream response omitted insights' }));
  await f.load();
  assert.equal(f.state.data, previous, 'a malformed success envelope must not become the applied data');
  assert.equal(f.node('accountsTable').innerHTML, table);
  assert.equal(f.node('exportButton').disabled, true);
});

test('review: malformed nested catalog DTO cannot replace the last-good snapshot before render fails', async () => {
  const f = fixture(); await prime(f, insight('last valid evidence', [account(1)]));
  const previous = f.state.data, table = f.node('accountsTable').innerHTML, endDate = f.appliedRange().end;
  const malformed = insight('nested malformed evidence', [account(2)]);
  malformed.themeSummary.items = [null];
  f.setFetch(async path => path === '/api/monitoring-status' ? response(monitoring()) : response(malformed));
  await f.load();
  assert.equal(f.state.data, previous, 'nested validation must reject malformed catalog data before committing it');
  assert.equal(f.node('accountsTable').innerHTML, table, 'last-good account rows stay visible');
  assert.equal(f.appliedRange().end, endDate, 'last-good date range stays applied');
  assert.match(f.node('notice').textContent, /保留上次已读取的数据/);
  assert.equal(f.node('exportButton').disabled, true);
});

test('review: automatic sync uses the same nested DTO gate before replacing applied data', async () => {
  const f = fixture(); await prime(f, insight('last valid evidence', [account(1)]));
  const previous = f.state.data, malformed = insight('bad automatic snapshot', [account(2)]);
  malformed.classificationSummary.items = [null];
  assert.throws(() => f.automaticApply({ insights: malformed, query: 'period=day' }, { scopeKey: f.automaticScopeKey() }), /未替换已保存的画面/);
  assert.equal(f.state.data, previous);
  assert.match(f.node('accountsTable').innerHTML, /作者 1/);
});

test('review: a GET that never resolves times out, retains the last snapshot and can be retried', async () => {
  const f = fixture(); await prime(f, insight('last saved snapshot', [account(1)]));
  const previous = f.state.data, table = f.node('accountsTable').innerHTML;
  f.setFetch(path => path === '/api/monitoring-status' ? Promise.resolve(response(monitoring())) : new Promise(() => {}));
  const pending = f.load(); await new Promise(setImmediate); await f.runTimer(25_000); await pending;
  assert.equal(f.state.data, previous);
  assert.equal(f.node('accountsTable').innerHTML, table);
  assert.match(f.node('notice').textContent, /超过 25 秒/);
  assert.equal(f.state.busy, false);
  f.setFetch(path => path === '/api/monitoring-status' ? Promise.resolve(response(monitoring())) : Promise.resolve(response(insight('retry succeeded'))));
  await f.load();
  assert.equal(f.state.data.reviewLabel, 'retry succeeded');
});

test('review: a response body that never finishes is covered by the same GET deadline', async () => {
  const f = fixture(); await prime(f, insight('last saved snapshot', [account(1)]));
  const previous = f.state.data;
  f.setFetch(path => path === '/api/monitoring-status' ? Promise.resolve(response(monitoring()))
    : Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => {}) }));
  const pending = f.load(); await new Promise(setImmediate); await f.runTimer(25_000); await pending;
  assert.equal(f.state.data, previous);
  assert.match(f.node('notice').textContent, /超过 25 秒/);
  assert.equal(f.state.busy, false);
});

test('review: real startup installs one 30-second timer and foreground resumes without a hidden request', async () => {
  const f = fixture(); f.state.session = { authenticated: true }; await prime(f);
  const requests = [];
  f.setFetch(async path => { requests.push(path); return response(monitoring()); });
  await f.startLiveSync(); await f.startLiveSync();
  assert.equal([...f.timers.values()].filter(timer => timer.delay === 30_000).length, 1);
  await f.runTimer(30_000);
  assert.deepEqual(requests, ['/api/monitoring-status']);
  f.document.hidden = true; f.document.visibilityState = 'hidden';
  f.documentListeners.get('visibilitychange')();
  assert.equal(f.timers.size, 0, 'hidden tab cancels polling instead of continuing reads');
  f.document.hidden = false; f.document.visibilityState = 'visible';
  f.documentListeners.get('visibilitychange')(); await new Promise(setImmediate);
  assert.deepEqual(requests, ['/api/monitoring-status', '/api/monitoring-status']);
  assert.equal([...f.timers.values()].filter(timer => timer.delay === 30_000).length, 1);
});

test('review: real 30-second polling reads new saved data only after evidence changes and keeps local filters', async () => {
  const f = fixture(); f.state.session = { authenticated: true }; await prime(f);
  f.state.query = '团团'; f.state.sort = 'likes.delta'; f.state.direction = 'asc';
  const requests = [];
  f.setFetch(async path => { requests.push(path); return path === '/api/monitoring-status' ? response(monitoring(2)) : response(insight('fresh snapshot', [account(2, '团团新采'), account(1, '其他')])); });
  await f.startLiveSync(); await f.runTimer(30_000);
  assert.equal(requests.length, 2); assert.equal(f.state.data.reviewLabel, 'fresh snapshot');
  assert.match(f.node('accountsTable').innerHTML, /团团新采/); assert.doesNotMatch(f.node('accountsTable').innerHTML, /其他/);
  assert.equal(f.state.sort, 'likes.delta'); assert.equal(f.state.direction, 'asc');
  await f.runTimer(30_000);
  assert.equal(requests.length, 3, 'unchanged fingerprint only reads cheap status');
});

test('review: actual focus/blur wiring defers queued updates until the user has finished typing', async () => {
  const f = fixture(); f.state.session = { authenticated: true }; await prime(f);
  f.setFetch(async path => path === '/api/monitoring-status' ? response(monitoring(2)) : response(insight('queued until blur')));
  await f.startLiveSync();
  f.document.activeElement = { matches: () => true };
  f.documentListeners.get('input')();
  await f.runTimer(30_000);
  assert.equal(f.state.data.reviewLabel, 'applied');
  assert.match(f.node('liveSyncMessage').textContent, /待同步/);
  f.document.activeElement = f.node('body');
  f.documentListeners.get('focusout')(); await f.runTimer(1600);
  assert.equal(f.state.data.reviewLabel, 'queued until blur');
  assert.match(f.node('liveSyncMessage').textContent, /已同步新快照/);
});

test('review: actual automatic 403 keeps the old table and displays a precise authorization warning', async () => {
  const f = fixture(); f.state.session = { authenticated: true }; await prime(f, insight('saved', [account(1)]));
  const original = f.node('accountsTable').innerHTML;
  f.setFetch(async () => response({ error: '需要授权' }, 403));
  await f.startLiveSync(); await f.runTimer(30_000);
  assert.equal(f.state.data.reviewLabel, 'saved'); assert.equal(f.node('accountsTable').innerHTML, original);
  assert.match(f.node('liveSyncMessage').textContent, /登录或访问权限需检查/);
  assert.match(f.node('liveSyncMessage').textContent, /当前快照已保留/);
  assert.equal(f.node('liveSyncStatus').attributes['data-state'], 'error');
});

function topicData(label) {
  return { topics: [{ label, points: [{ date: '2026-09-28', participants: 123, views: 12300, participantsDelta: 2, viewsDelta: 200 }] }] };
}

test('review: a late manual topic response cannot overwrite newer automatically applied topic data', async () => {
  const f = fixture(); f.state.session = { authenticated: true }; await prime(f);
  f.state.view = 'topics'; const older = deferred(); let topicReads = 0;
  f.setFetch(async path => {
    if (path === '/api/monitoring-status') return response(monitoring(2));
    if (path.startsWith('/api/topics/history')) return ++topicReads === 1 ? older.promise : response(topicData('新快照话题'));
    return response(insight('new topic snapshot'));
  });
  const manual = f.loadTopics(); await f.startLiveSync(); await f.runTimer(30_000);
  assert.match(f.node('topicsGrid').innerHTML, /新快照话题/);
  older.resolve(response(topicData('过期话题响应'))); await manual;
  assert.match(f.node('topicsGrid').innerHTML, /新快照话题/);
  assert.doesNotMatch(f.node('topicsGrid').innerHTML, /过期话题响应/);
});

test('review: topic navigation after failed date selection uses the actually applied range', async () => {
  const f = fixture(); await prime(f, insight('last valid day', [], '2026-09-27'));
  f.state.period = 'custom'; f.node('startDate').value = '2026-09-28'; f.node('endDate').value = '2026-09-28';
  f.setFetch(async path => path === '/api/monitoring-status' ? response(monitoring()) : response({ error: 'offline' }, 503));
  await f.load();
  let requested;
  f.setFetch(async path => { requested = path; return response(topicData('保留日期')); });
  await f.loadTopics();
  assert.match(requested, /startDate=2026-09-27&endDate=2026-09-27/);
});

test('pending update remains explicitly actionable while a period selector retains focus', async () => {
  const f = fixture(); f.state.session = { authenticated: true }; await prime(f);
  f.setFetch(async path => path === '/api/monitoring-status' ? response(monitoring(2)) : response(insight('new snapshots')));
  const select = f.node('periodSelect'); select.matches = selector => selector.includes('select'); select.focus();
  await f.startLiveSync(); await f.runTimer(30_000);
  assert.equal(f.state.data.reviewLabel, 'applied', 'background sync must still protect the active control');
  assert.equal(f.node('applyLiveUpdate').hidden, false);
  assert.equal(f.node('applyLiveUpdate').disabled, false, 'explicit choice must not be disabled by harmless focus');
  assert.equal(f.node('applyLiveUpdate').onclick(), true);
  assert.equal(f.state.data.reviewLabel, 'new snapshots');
  assert.equal(f.node('applyLiveUpdate').hidden, true);
  assert.equal(f.document.activeElement, f.node('refreshBtn'), 'keyboard focus stays on a visible control after the action disappears');
});

test('an idle already-applied period selection no longer freezes automatic snapshots', async () => {
  const f = fixture(); f.state.session = { authenticated: true }; await prime(f);
  f.setFetch(async path => path === '/api/monitoring-status' ? response(monitoring(2)) : response(insight('automatic while focused')));
  const select = f.node('periodSelect'); select.value = f.state.period;
  select.matches = selector => selector.includes('select'); select.focus();
  await f.startLiveSync();
  f.documentListeners.get('keydown')();
  assert.match(f.syncBlockedReason(), /操作完成后/);
  await f.runTimer(30_000);
  assert.equal(f.state.data.reviewLabel, 'automatic while focused');
  assert.equal(f.document.activeElement, select);
  assert.equal(select.value, f.state.period);
});

for (const id of ['operationsDetails', 'filterDetails', 'rosterDistribution']) {
  for (const open of [false, true]) {
    test(`idle stable ${id} summary allows fresh data without losing ${open ? 'open' : 'closed'} state or focus`, async () => {
      const f = fixture(); f.state.session = { authenticated: true }; await prime(f);
      f.setFetch(async path => path === '/api/monitoring-status' ? response(monitoring(2)) : response(insight('fresh while reading stable summary')));
      const details = f.node(id), summary = f.node(`${id}:summary`);
      details.tagName = 'DETAILS'; details.open = open; details.firstElementChild = summary;
      summary.tagName = 'SUMMARY'; summary.parentElement = details;
      summary.matches = selector => selector.split(',').includes('summary'); summary.focus();
      f.document.querySelectorAll = selector => selector === 'details' ? [details] : [];
      await f.startLiveSync();
      f.documentListeners.get('pointerdown')();
      assert.match(f.syncBlockedReason(), /操作完成后/);
      await f.runTimer(30_000);
      assert.equal(f.state.data.reviewLabel, 'fresh while reading stable summary');
      assert.equal(f.document.activeElement, summary);
      assert.equal(details.open, open);
      assert.equal(f.node('applyLiveUpdate').hidden, true);
    });
  }
}

test('rebuilt summaries, links and nested nodes remain protected from background replacement', async () => {
  const f = fixture(); await prime(f);
  for (const id of ['recordedWindowAlternative', 'dynamic-metric', 'operationsDetails']) {
    const details = f.node(id), summary = f.node(`${id}:dynamic-summary`);
    details.firstElementChild = id === 'operationsDetails' ? f.node('different-summary') : summary;
    summary.tagName = 'SUMMARY'; summary.parentElement = details;
    summary.matches = selector => selector.split(',').includes('summary'); summary.focus();
    assert.match(f.syncBlockedReason(), /保留当前阅读焦点/);
  }
  const link = f.node('source-link'); link.tagName = 'A'; link.parentElement = f.node('operationsDetails');
  link.matches = selector => selector.split(',').includes('a'); link.focus();
  assert.match(f.syncBlockedReason(), /保留当前阅读焦点/);
});

test('stable disclosure focus never overrides uncommitted dates, imports or account details', async () => {
  const f = fixture(); await prime(f);
  const details = f.node('operationsDetails'), summary = f.node('stable-summary');
  details.firstElementChild = summary; summary.parentElement = details; summary.tagName = 'SUMMARY';
  summary.matches = selector => selector.split(',').includes('summary'); summary.focus();
  f.node('accountDialog').open = true; assert.match(f.syncBlockedReason(), /详情/);
  f.node('accountDialog').open = false; f.node('importPreview').hidden = false; assert.match(f.syncBlockedReason(), /导入/);
  f.node('importPreview').hidden = true; f.state.theme = 'different-theme'; assert.match(f.syncBlockedReason(), /未应用/);
});

test('explicit pending update cannot commit unapplied dates or replace an open detail/import draft', async () => {
  const f = fixture('http://127.0.0.1:4188/?period=custom&start=2026-09-20&end=2026-09-22');
  f.state.session = { authenticated: true };
  const before = insight('applied'); before.period = 'custom'; before.range = { startDate: '2026-09-20', endDate: '2026-09-22' };
  await prime(f, before);
  f.setFetch(async path => path === '/api/monitoring-status' ? response(monitoring(2)) : response({ ...before, reviewLabel: 'new' }));
  f.node('startDate').value = '2026-09-21';
  await f.startLiveSync(); await f.runTimer(30_000);
  assert.equal(f.node('applyLiveUpdate').disabled, true);
  assert.equal(f.node('applyLiveUpdate').onclick(), false);
  assert.equal(f.state.data.reviewLabel, 'applied'); assert.equal(f.node('startDate').value, '2026-09-21');
  f.node('startDate').value = '2026-09-20'; f.node('accountDialog').open = true;
  assert.equal(f.node('applyLiveUpdate').onclick(), false);
  f.node('accountDialog').open = false; f.node('importPreview').hidden = false;
  assert.equal(f.node('applyLiveUpdate').onclick(), false);
  assert.equal(f.state.data.reviewLabel, 'applied');
});

test('topic heading makes independent scope clear and restores account scope on return', async () => {
  const f = fixture('http://127.0.0.1:4188/?theme=tuantuan&classification=slice');
  const data = insight('selected');
  data.themeSummary.items.push({ key: 'tuantuan', label: '团团', count: 2 });
  data.classificationSummary.items.push({ key: 'slice', label: '切片', count: 2 });
  await prime(f, data);
  f.setFetch(async path => path.startsWith('/api/topics/history') ? response(topicData('topic')) : response(data));
  f.setView('topics');
  assert.match(f.node('pageSubtitle').textContent, /全部监控话题/);
  assert.doesNotMatch(f.node('pageSubtitle').textContent, /团团|切片/);
  f.renderCatalog(); assert.match(f.node('pageSubtitle').textContent, /独立于账号筛选/);
  f.setView('accounts');
  assert.match(f.node('pageSubtitle').textContent, /团团.*切片/);
  assert.equal(f.state.theme, 'tuantuan'); assert.equal(f.state.classification, 'slice');
});
