import test from 'node:test';
import assert from 'node:assert/strict';
import { createImportMonitoring, validateImportMonitoring } from '../public/import-monitoring.js';
import { mountMasterRoster, resolveRosterSupplementEntry } from '../public/master-roster.js';

const JOB = 'c9895a58-14ef-4f1f-8c88-428fb3ce8d6f', OTHER = 'b1111111-1111-4111-8111-111111111111';
const STAMP = '2026-10-09T18:00:00.000Z', SHA = 'a'.repeat(64), ENTRY = 'original:douyin:00123';
const request = () => ({ entryKey: ENTRY, platform: 'douyin', submittedId: '00123' });
const attempt = () => ({ origin: 'authorised-work', status: 'unavailable', errorCode: 'identity_mismatch',
  reason: '该次作品作者与原提交 ID 不一致', sourceRow: 682,
  startedAt: '2026-10-09T17:59:00.000Z', finishedAt: '2026-10-09T17:59:30.000Z', recordedAt: STAMP });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };

function monitoring({ status = 'pending', ...fields } = {}) {
  const item = { key: 'douyin:submitted:00123', platform: 'douyin', submittedId: '00123', name: '<同名作者>', sourceRows: 10,
    status, targetId: ['enabled', 'paused'].includes(status) ? 99 : null, reason: '原资料尚待核对',
    sampledAt: status === 'enabled' ? STAMP : null, profileStatus: status === 'enabled' ? 'fresh' : 'not_enabled',
    ...(status === 'pending' ? { resolutionState: 'evidence_missing' } : {}), ...fields };
  const resolutionCounts = { retrying: 0, evidence_exhausted: 0, evidence_missing: 0 };
  if (status === 'pending') resolutionCounts[item.resolutionState] = 1;
  return { jobId: JOB, scope: 'current-import-account-monitoring', checkedAt: STAMP, sourceAvailable: true, sourceReason: null,
    inputRows: 3988, identitySummary: { unknownIdentityItemCount: 0, ambiguousIdentityItemCount: 0 },
    counts: { submittedIdentities: 1, enabled: Number(status === 'enabled'), paused: Number(status === 'paused'),
      pending: Number(status === 'pending'), conflict: Number(status === 'conflict'), unknown: Number(status === 'unknown'),
      freshProfiles: Number(status === 'enabled'), staleProfiles: 0, missingProfiles: 0, invalidProfiles: 0 },
    resolutionCounts, items: [item], pagination: { offset: 0, limit: 20, total: 1, hasMore: false }, notes: [] };
}
function roster() {
  return { snapshotAt: STAMP, workbook: { fileName: '原总表.xlsx', sha256: SHA },
    summary: { total: 2, registered: 0, enabled: 0, paused: 0, pending: 2 }, items: [ENTRY, 'other-same-name'].map((key, index) => ({
      key, platform: 'douyin', name: '同名作者', accountIds: [index ? 'different' : '00123'], targetId: null, monitorStatus: 'pending',
      originalNames: [], identityStatus: '待核对', profileLinks: [], sourceLinks: [], sourceTitles: ['原资料来源'], reviewReasons: ['待补充主页或作品'],
      theme: { key: 'original', label: '原主题' }, classifications: [],
    })) };
}

// Minimal DOM fixture: no real browser, server, account or platform is contacted.
class Node {
  constructor(tag, doc) { this.tagName = tag; this.owner = this.ownerDocument = doc; this.children = []; this.parent = null; this.listeners = new Map(); this.dataset = {}; this.attributes = new Map(); this.className = ''; this.id = ''; this.value = ''; this._text = ''; this._html = ''; this.hidden = false; this.disabled = false; this.open = false; }
  get isConnected() { return this === this.owner.body || Boolean(this.parent?.isConnected); }
  get firstChild() { return this.children[0]; }
  get options() { return this.children; }
  get textContent() { return this._text + this.children.map(item => item.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.replaceChildren(); }
  set innerHTML(source) { this._html = source; this.replaceChildren(); if (this.className === 'master-roster') buildSkeleton(this, source); }
  get innerHTML() { return this._html; }
  append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
  replaceChildren(...items) { for (const item of this.children) item.parent = null; this.children = []; this.append(...items); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  removeAttribute(key) { this.attributes.delete(key); }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
    const attr = selector.match(/^(\w+)?\[([^=\]]+)(?:="([^"]+)")?\]$/);
    if (attr) {
      const value = attr[2].startsWith('data-') ? this.dataset[attr[2].slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] : this.attributes.get(attr[2]);
      return (!attr[1] || this.tagName === attr[1]) && (attr[3] === undefined ? value !== undefined : value === attr[3]);
    }
    return this.tagName === selector;
  }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) {
    if (selector === 'thead th:nth-child(3)') return this.querySelector('thead').children[2];
    if (selector.includes(' > ')) { const [parent, child] = selector.split(' > '); return this.querySelector(parent)?.children.find(node => node.matches(child)); }
    return this.querySelectorAll(selector)[0] || null;
  }
  closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector); }
  addEventListener(type, listener) { const items = this.listeners.get(type) || []; items.push(listener); this.listeners.set(type, items); }
  removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== listener)); }
  async emit(type, target = this) { for (const listener of this.listeners.get(type) || []) await listener({ target, preventDefault() {} }); await settle(); }
  focus() { this.owner.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; void this.emit('close'); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); this.parent = null; }
}
function make(doc, parent, tag, className = '', text = '') { const node = doc.createElement(tag); node.className = className; node.textContent = text; parent.append(node); return node; }
function buildSkeleton(root, source) {
  const doc = root.owner, id = source.match(/id="(master-roster-\d+)-search"/)[1];
  const details = make(doc, root, 'details', 'master-roster-disclosure'), summary = make(doc, details, 'summary');
  for (const css of ['master-roster-title', 'master-roster-counts', 'master-roster-expand']) make(doc, summary, 'span', css);
  const body = make(doc, details, 'div', 'master-roster-body'), toolbar = make(doc, body, 'div', 'master-roster-toolbar');
  for (const field of ['search', 'status', 'theme', 'classification']) {
    const label = make(doc, toolbar, 'label'); label.setAttribute('for', `${id}-${field}`); make(doc, label, 'span', '', field);
    const input = make(doc, label, field === 'search' ? 'input' : 'select'); input.id = `${id}-${field}`; input.value = field === 'search' ? '' : 'all';
    if (field === 'status') for (const value of ['all', 'registered', 'enabled', 'paused', 'pending']) { const option = make(doc, input, 'option', '', value); option.value = value; option.setAttribute('value', value); }
  }
  for (const action of ['reload', 'export']) make(doc, toolbar, 'button').dataset.rosterAction = action;
  make(doc, body, 'p', 'master-roster-filter-count'); const table = make(doc, body, 'table'), head = make(doc, table, 'thead');
  for (let n = 0; n < 4; n++) make(doc, head, 'th'); make(doc, table, 'tbody');
  const pager = make(doc, body, 'div', 'master-roster-pagination'); make(doc, pager, 'span');
  for (const page of ['prev', 'next']) make(doc, pager, 'button').dataset.rosterPage = page;
  make(doc, root, 'p', 'master-roster-policy'); make(doc, root, 'p', 'master-roster-read-status');
}
function documentFixture() {
  const doc = { nodes: [], events: [], createElement(tag) { const node = new Node(tag, this); this.nodes.push(node); return node; },
    hasFocus: () => true, addEventListener() {}, removeEventListener() {}, dispatchEvent(event) { this.events.push(event); return true; } };
  doc.body = doc.createElement('body'); doc.documentElement = doc.createElement('html'); doc.activeElement = doc.body; return doc;
}
function importFixture(payload = monitoring()) {
  const doc = documentFixture(), root = make(doc, doc.body, 'section'); let allowed = true, visible = true, current = payload, nextRead = null;
  const nodes = Object.fromEntries(['refresh', 'summary', 'checkedAt', 'form', 'filter', 'search', 'status', 'rows', 'previous', 'next'].map(key => {
    const node = make(doc, root, 'div'); node.dataset.monitoring = key; return [key, node];
  }));
  const calls = [], controller = createImportMonitoring({ root, canRead: () => allowed, isVisible: () => visible, api: async (path, options) => {
    calls.push({ path, options }); return nextRead ? nextRead.promise : structuredClone(current);
  } });
  const click = (key = payload.items[0].key) => { const button = make(doc, nodes.rows, 'button'); button.dataset.monitoringSupplement = key; nodes.rows.onclick({ target: button }); return button; };
  return { doc, root, nodes, controller, calls, click, get actions() { return doc.events.filter(event => event.type === 'mcn:import-monitoring-supplement'); },
    set allowed(value) { allowed = value; }, set visible(value) { visible = value; }, set payload(value) { current = value; }, set nextRead(value) { nextRead = value; } };
}
async function mounted(run) {
  const previous = { document: globalThis.document, Option: globalThis.Option, location: globalThis.location }, doc = documentFixture();
  globalThis.document = doc; globalThis.Option = class extends Node { constructor(label, value) { super('option', doc); this.textContent = label; this.value = value; } }; globalThis.location = { href: 'http://localhost:4188/#accounts' };
  let payload = roster(), nextRead = null, allowed = true, visible = true; const reads = [], writes = [], host = make(doc, doc.body, 'main');
  const controller = mountMasterRoster({ host, isVisible: () => visible, canEdit: () => allowed,
    api: async (...args) => { writes.push(args); throw new Error('No writes permitted in bridge tests'); },
    fetcher: async (path, options) => { reads.push({ path, options }); return nextRead ? nextRead.promise : { ok: true, json: async () => structuredClone(payload) }; } });
  await controller.ready;
  try { await run({ doc, root: host.children[0], controller, reads, writes,
    get payload() { return payload; }, set payload(value) { payload = value; }, set nextRead(value) { nextRead = value; },
    set allowed(value) { allowed = value; }, set visible(value) { visible = value; } }); }
  finally { controller.destroy(); Object.assign(globalThis, previous); }
}

test('current monitoring responses cannot invent a recent attempt or supplement capability', async () => {
  const f = importFixture(); await f.controller.setJob({ id: JOB, status: 'completed' });
  assert.match(f.nodes.rows.innerHTML, /当前接入核对：原资料尚待核对/);
  assert.match(f.nodes.rows.innerHTML, /缺少可核验主页或作品证据/);
  assert.match(f.nodes.rows.innerHTML, /暂无近期单项作品核验记录/);
  assert.doesNotMatch(f.nodes.rows.innerHTML, /data-monitoring-supplement|最近单项作品核验：/);
  f.click(); assert.equal(f.actions.length, 0); f.controller.dispose();
});
test('a source-bound latest work attempt is escaped and scoped; enabled monitoring never becomes an account-wide failure', async () => {
  const f = importFixture(monitoring({ status: 'enabled', resolutionAttempt: { ...attempt(), reason: '<img src=x> 该作品不匹配' } }));
  await f.controller.setJob({ id: JOB, status: 'completed' }); const html = f.nodes.rows.innerHTML;
  assert.match(html, /启用监控/); assert.match(html, /监控账号 #99/); assert.match(html, /最近单项作品核验：&lt;img src=x&gt;/);
  assert.match(html, /原表第 682 行/); assert.match(html, /2026\/10\/10 01:59:30/); assert.match(html, /不代表整个作者不存在/);
  assert.doesNotMatch(html, /<img|data-monitoring-supplement/); f.controller.dispose();
});
test('invalid optional attempts or capabilities fail closed while absent and null fields remain backwards compatible', () => {
  validateImportMonitoring(monitoring({ resolutionAttempt: null, rosterEntryKey: null }), JOB);
  for (const changed of [{ origin: 'journal' }, { status: 'ok' }, { errorCode: 'https://secret' }, { sourceRow: 0 }, { sourceRow: '682' }, { finishedAt: '2026-10-08T00:00:00Z' }, { recordedAt: 'yesterday' }, { reason: {} }]) {
    assert.throws(() => validateImportMonitoring(monitoring({ resolutionAttempt: { ...attempt(), ...changed } }), JOB));
  }
  for (const rosterEntryKey of ['', 123, 'x\nunsafe']) assert.throws(() => validateImportMonitoring(monitoring({ rosterEntryKey }), JOB));
  for (const status of ['enabled', 'paused', 'conflict', 'unknown']) assert.throws(() => validateImportMonitoring(monitoring({ status, rosterEntryKey: ENTRY }), JOB));
});
test('only the current backend-provided item capability dispatches exact identity; opening performs no POST or prefilled evidence', async () => {
  const f = importFixture(monitoring({ resolutionAttempt: attempt(), rosterEntryKey: ENTRY })); await f.controller.setJob({ id: JOB, status: 'completed' });
  assert.match(f.nodes.rows.innerHTML, /补充身份资料/); f.click('forged-name'); assert.equal(f.actions.length, 0); f.click();
  assert.equal(f.actions.length, 1); assert.deepEqual(f.actions[0].detail, { jobId: JOB, ...request() });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.method, undefined); assert.equal(f.calls[0].options.body, undefined); f.controller.dispose();
});
test('role loss, hidden view, in-flight read, changed job and disposed controller block synthetic action activation', async () => {
  for (const scenario of ['role', 'hidden', 'flight', 'job', 'dispose']) {
    const f = importFixture(monitoring({ rosterEntryKey: ENTRY })); await f.controller.setJob({ id: JOB, status: 'completed' }); const wait = deferred(); let pending;
    if (scenario === 'role') f.allowed = false;
    if (scenario === 'hidden') f.visible = false;
    if (scenario === 'flight') { f.nextRead = wait; pending = f.controller.refresh(); }
    if (scenario === 'job') { f.nextRead = wait; pending = f.controller.setJob({ id: OTHER, status: 'completed' }); }
    if (scenario === 'dispose') f.controller.dispose();
    f.click(); assert.equal(f.actions.length, 0, scenario);
    wait.resolve({ ...monitoring({ rosterEntryKey: ENTRY }), jobId: scenario === 'job' ? OTHER : JOB }); await pending; f.controller.dispose();
  }
});
test('malformed fresh metadata retains the last valid monitoring result and cannot replace it with a new action', async () => {
  const f = importFixture(); await f.controller.setJob({ id: JOB, status: 'completed' }); const before = f.nodes.rows.innerHTML;
  f.payload = monitoring({ rosterEntryKey: ENTRY, resolutionAttempt: { ...attempt(), sourceRow: -1 } }); await f.controller.refresh();
  assert.equal(f.nodes.rows.innerHTML, before); assert.match(f.nodes.status.textContent, /保留上次/); f.click(); assert.equal(f.actions.length, 0); f.controller.dispose();
});
test('exact roster resolution preserves leading zeroes and rejects same-name, duplicate, live, paused, bound and pending-task entries', () => {
  const source = roster(); assert.equal(resolveRosterSupplementEntry(source, request()), source.items[0]);
  assert.equal(resolveRosterSupplementEntry(source, { ...request(), submittedId: ' @００１２３ ' }), source.items[0]);
  for (const changed of [{ submittedId: '123' }, { submittedId: 123 }, { entryKey: 'same-name' }, { entryKey: 'other-same-name' }, { platform: 'bilibili' }]) assert.equal(resolveRosterSupplementEntry(source, { ...request(), ...changed }), null);
  for (const changed of [{ targetId: 12 }, { monitorStatus: 'paused' }, { liveSource: true }, { readOnly: true }, ...['queued', 'running', 'awaiting-verification', 'conflict'].map(status => ({ supplement: { status } }))]) {
    const value = roster(); Object.assign(value.items[0], changed); assert.equal(resolveRosterSupplementEntry(value, request()), null);
  }
  source.items.push({ ...source.items[0] }); assert.equal(resolveRosterSupplementEntry(source, request()), null);
});
test('exact bridge re-reads the roster and opens the existing blank preview/confirm dialog with zero writes', async () => {
  await mounted(async f => {
    const before = structuredClone(f.payload); assert.equal(await f.controller.openSearch(request()), true);
    const dialog = f.doc.nodes.find(node => node.tagName === 'dialog'); assert.equal(dialog.open, true);
    assert.match(dialog.textContent, /抖音 · 00123/); assert.match(dialog.textContent, /原资料来源/); assert.match(dialog.textContent, /先预览，再确认提交/);
    assert.equal(dialog.querySelector('input').value, ''); assert.equal(f.doc.activeElement, dialog.querySelector('input'));
    assert.equal(f.reads.length, 2); assert.ok(f.reads.every(read => read.options.method === 'GET')); assert.equal(f.writes.length, 0); assert.deepEqual(f.payload, before);
  });
});
test('freshly paused or already linked roster prevents opening and never falls back to another same-name entry', async () => {
  for (const monitorStatus of ['enabled', 'paused']) await mounted(async f => {
    f.payload.items[0].monitorStatus = monitorStatus; f.payload.items[0].targetId = 99;
    f.payload.summary = { total: 2, registered: 1, enabled: Number(monitorStatus === 'enabled'), paused: Number(monitorStatus === 'paused'), pending: 1 };
    assert.equal(await f.controller.openSearch(request()), false); assert.equal(f.doc.nodes.find(node => node.tagName === 'dialog').open, false);
    assert.match(f.root.querySelector('.master-roster-read-status').textContent, /不会按名字/); assert.equal(f.writes.length, 0);
  });
});
test('an existing supplement draft survives another precise jump and causes no read or write', async () => {
  await mounted(async f => {
    await f.controller.openSearch(request()); const dialog = f.doc.nodes.find(node => node.tagName === 'dialog'); const input = dialog.querySelector('input');
    input.value = '保留草稿'; await input.emit('input'); const readCount = f.reads.length;
    assert.equal(await f.controller.openSearch({ entryKey: 'other-same-name', platform: 'douyin', submittedId: 'different' }), false);
    assert.equal(dialog.open, true); assert.equal(input.value, '保留草稿'); assert.equal(f.reads.length, readCount); assert.equal(f.writes.length, 0);
  });
});
test('newer navigation, role revocation or leaving accounts invalidates an awaited precise jump', async () => {
  for (const scenario of ['search', 'role', 'hidden', 'newer']) await mounted(async f => {
    const wait = deferred(); f.nextRead = wait; const first = f.controller.openSearch(request()); await settle();
    let second;
    if (scenario === 'search') { const input = f.root.querySelector('input'); input.value = '用户新搜索'; await f.root.emit('input', input); }
    if (scenario === 'role') { f.allowed = false; f.controller.syncRole(); }
    if (scenario === 'hidden') f.visible = false;
    if (scenario === 'newer') { f.nextRead = null; second = f.controller.openSearch({ query: '新搜索' }); }
    wait.resolve({ ok: true, json: async () => roster() }); assert.equal(await first, false, scenario); await second;
    assert.equal(f.doc.nodes.find(node => node.tagName === 'dialog').open, false); assert.equal(f.writes.length, 0);
  });
});
test('failed fresh read cannot open from a previously valid cached capability', async () => {
  await mounted(async f => {
    const wait = deferred(); f.nextRead = wait; const opening = f.controller.openSearch(request()); await settle(); wait.reject(new Error('offline'));
    assert.equal(await opening, false); assert.equal(f.doc.nodes.find(node => node.tagName === 'dialog').open, false); assert.match(f.root.querySelector('.master-roster-read-status').textContent, /保留/); assert.equal(f.writes.length, 0);
  });
});
