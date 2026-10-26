import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRosterRefreshCoordinator, mountMasterRoster } from '../public/master-roster.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };
function clockFixture(read) {
  let time = 0, visible = true, busy = false, sequence = 0;
  const timers = new Map();
  const coordinator = createRosterRefreshCoordinator({ read, now: () => time, isVisible: () => visible, isBusy: () => busy,
    schedule: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, at: time + delay }); return id; }, cancel: id => timers.delete(id) });
  return { coordinator, timers, set visible(value) { visible = value; }, set busy(value) { busy = value; },
    async advance(ms) { time += ms; for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); } await settle(); } };
}
test('periodic hints coalesce into one visible read per minute without an independent polling loop', async () => {
  let calls = 0; const f = clockFixture(async () => { calls++; return true; });
  await f.coordinator.request(); assert.equal(calls, 1);
  await f.coordinator.request(); await f.coordinator.request(); assert.equal(calls, 1); assert.equal(f.timers.size, 1);
  await f.advance(59_999); assert.equal(calls, 1); await f.advance(1); assert.equal(calls, 2); assert.equal(f.timers.size, 0);
  await f.advance(120_000); assert.equal(calls, 2, 'no perpetual polling is created'); f.coordinator.destroy();
});
test('manual force bypasses throttle but reuses an already active read', async () => {
  let calls = 0; const wait = deferred(); const f = clockFixture(() => { calls++; return wait.promise; });
  const a = f.coordinator.request(), b = f.coordinator.request({ force: true }); await settle(); assert.equal(calls, 1); assert.equal(a, b);
  wait.resolve(true); await a; await f.coordinator.request({ force: true }); assert.equal(calls, 2); f.coordinator.destroy();
});
test('hidden tabs and active editing queue a request without reading, then flush once after interaction', async () => {
  let calls = 0; const f = clockFixture(async () => { calls++; }); f.visible = false;
  await f.coordinator.request({ force: true }); assert.equal(calls, 0); f.visible = true; f.busy = true;
  await f.coordinator.flush(); assert.equal(calls, 0); f.busy = false; await f.coordinator.flush(); assert.equal(calls, 1);
  await f.coordinator.flush(); assert.equal(calls, 1); f.coordinator.destroy();
});
test('scheduled read rechecks visibility and a failed read does not wedge manual recovery', async () => {
  let calls = 0; const f = clockFixture(async () => { if (++calls === 2) throw new Error('read failed'); return true; });
  await f.coordinator.request(); await f.coordinator.request(); f.visible = false; await f.advance(60_000); assert.equal(calls, 1);
  f.visible = true; await assert.rejects(f.coordinator.flush(), /read failed/); await f.coordinator.request({ force: true }); assert.equal(calls, 3); f.coordinator.destroy();
});
test('destroy cancels any scheduled read and all later visibility hints', async () => {
  let calls = 0; const f = clockFixture(async () => { calls++; }); await f.coordinator.request(); await f.coordinator.request();
  f.coordinator.destroy(); assert.equal(f.timers.size, 0); await f.advance(60_000); await f.coordinator.request({ force: true }); assert.equal(calls, 1);
});
test('entry requests a refresh when returning to accounts, regaining visibility and receiving global hints without remount', () => {
  const events = new Map(), view = { hidden: false }, calls = []; let changed, mounts = 0;
  const doc = { hidden: false, getElementById: id => id === 'accountsView' ? view : {}, addEventListener: (type, callback) => events.set(type, callback), dispatchEvent() {} };
  const context = { document: doc, CustomEvent: class {}, MutationObserver: class { constructor(callback) { changed = callback; } observe() {} },
    mountMasterRoster(options) { mounts++; assert.equal(options.isVisible(), true); return { requestRefresh: arg => { calls.push(arg); }, syncRole() {} }; } };
  const source = fs.readFileSync(new URL('../public/master-roster-entry.js', import.meta.url), 'utf8').replace(/^import[^\n]*\n/, '');
  vm.runInNewContext(source, context); assert.equal(mounts, 1);
  view.hidden = true; changed(); assert.equal(calls.length, 0); view.hidden = false; changed(); assert.equal(calls.length, 1);
  doc.hidden = true; events.get('visibilitychange')(); assert.equal(calls.length, 1); doc.hidden = false; events.get('visibilitychange')(); assert.equal(calls.length, 2);
  events.get('mcn:master-roster-refresh')({ detail: { force: true } }); assert.equal(calls[2].force, true);
  events.get('mcn:master-roster-refresh')({ detail: { force: 'true' } }); assert.equal(calls[3].force, false); assert.equal(mounts, 1);
});

class Node {
  constructor(tag, doc) { this.tagName = tag; this.owner = doc; this.children = []; this.parent = null; this.listeners = new Map(); this.dataset = {}; this.attributes = new Map(); this.className = ''; this.id = ''; this.value = ''; this._text = ''; this.hidden = false; this.disabled = false; this.open = false; this.replacements = 0; }
  get isConnected() { return this === this.owner.body || Boolean(this.parent?.isConnected); }
  get firstChild() { return this.children[0]; }
  get options() { return this.children; }
  get textContent() { return this._text + this.children.map(item => item.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  set innerHTML(source) { assert.equal(this.className, 'master-roster'); buildSkeleton(this, source); }
  append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
  replaceChildren(...items) { this.replacements++; for (const item of this.children) item.parent = null; this.children = []; this._text = ''; this.append(...items); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  removeAttribute(key) { this.attributes.delete(key); }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
    const attr = selector.match(/^(\w+)?\[([^=]+)="([^"]+)"\]$/);
    if (attr) return (!attr[1] || this.tagName === attr[1]) && (attr[2].startsWith('data-') ? this.dataset[attr[2].slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] : this.attributes.get(attr[2])) === attr[3];
    return this.tagName === selector;
  }
  querySelector(selector) {
    if (selector === 'thead th:nth-child(3)') return this.querySelector('thead').children[2];
    if (selector.includes(' > ')) { const [parent, child] = selector.split(' > '); return this.querySelector(parent)?.children.find(node => node.matches(child)); }
    for (const child of this.children) { if (child.matches(selector)) return child; const found = child.querySelector(selector); if (found) return found; } return null;
  }
  closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector); }
  addEventListener(type, listener) { const items = this.listeners.get(type) || []; items.push(listener); this.listeners.set(type, items); }
  removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== listener)); }
  async emit(type, target = this) { for (const listener of this.listeners.get(type) || []) await listener({ target, preventDefault() {} }); await settle(); }
  focus() { this.owner.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; void this.emit('close'); }
  remove() { this.parent.children = this.parent.children.filter(item => item !== this); this.parent = null; }
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
  for (const action of ['reload', 'export']) { const button = make(doc, toolbar, 'button'); button.dataset.rosterAction = action; }
  make(doc, body, 'p', 'master-roster-filter-count'); const table = make(doc, body, 'table'), head = make(doc, table, 'thead');
  for (let n = 0; n < 4; n++) make(doc, head, 'th'); make(doc, table, 'tbody');
  const pager = make(doc, body, 'div', 'master-roster-pagination'); make(doc, pager, 'span');
  for (const page of ['prev', 'next']) { const button = make(doc, pager, 'button'); button.dataset.rosterPage = page; }
  make(doc, root, 'p', 'master-roster-policy'); make(doc, root, 'p', 'master-roster-read-status');
}
function fixture() {
  return { snapshotAt: '2026-10-09T01:00:00.000Z', workbook: { fileName: '总表.xlsx', sha256: 'a'.repeat(64) }, summary: { total: 6, registered: 2, enabled: 2, paused: 0, pending: 4 }, items: Array.from({ length: 6 }, (_, n) => ({
    key: `item-${n}`, targetId: n < 2 ? n + 1 : null, monitorStatus: n < 2 ? 'enabled' : 'pending', name: `资料 ${n}`, platform: 'douyin', originalNames: [], accountIds: [`ID${n}`], profileLinks: [], sourceLinks: [], sourceTitles: ['团团来源'], reviewReasons: [], identityStatus: '', theme: { key: 'tuantuan', label: '团团' }, classifications: [{ key: 'slice', label: '切片' }],
  })) };
}
async function mounted(run) {
  const previous = { document: globalThis.document, Option: globalThis.Option, location: globalThis.location };
  const doc = { nodes: [], createElement(tag) { const node = new Node(tag, this); this.nodes.push(node); return node; } }; doc.body = doc.createElement('body'); doc.activeElement = doc.body;
  globalThis.document = doc; globalThis.Option = class extends Node { constructor(label, value) { super('option', doc); this.textContent = label; this.value = value; } }; globalThis.location = { href: 'http://localhost:4188/#accounts' };
  const host = make(doc, doc.body, 'main'); let payload = fixture(), nextRead = null, visible = true, reads = 0;
  const controller = mountMasterRoster({ host, pageSize: 2, isVisible: () => visible, canEdit: () => true, api: async () => { throw new Error('Production writes forbidden'); },
    fetcher: async () => { reads++; if (nextRead) return nextRead.promise; return { ok: true, json: async () => structuredClone(payload) }; } });
  await controller.ready; const root = host.children[0];
  try { await run({ doc, controller, root, get reads() { return reads; }, get payload() { return payload; }, set payload(value) { payload = value; }, set nextRead(value) { nextRead = value; }, set visible(value) { visible = value; } }); }
  finally { controller.destroy(); Object.assign(globalThis, previous); }
}
test('unchanged refresh retains DOM nodes, filters and page instead of rebuilding every status check', async () => {
  await mounted(async ({ root, controller }) => {
    const select = root.querySelector('[aria-label="监控状态"]'); select.value = 'pending'; await root.emit('change', select);
    await root.emit('click', root.querySelector('[data-roster-page="next"]'));
    const body = root.querySelector('tbody'), before = body.replacements, row = body.children[0];
    await controller.requestRefresh({ force: true }); assert.equal(body.replacements, before); assert.equal(body.children[0], row);
    assert.equal(select.value, 'pending'); assert.match(root.querySelector('.master-roster-pagination > span').textContent, /第 2 \/ 2 页/);
  });
});
test('changed terminal snapshot updates the filtered current page without resetting its classification or page', async () => {
  await mounted(async value => {
    const status = value.root.querySelector('[aria-label="监控状态"]'); status.value = 'pending'; await value.root.emit('change', status);
    const classification = value.root.querySelector('[aria-label="总表来源内容分类"]'); classification.value = 'label:slice'; await value.root.emit('change', classification);
    await value.root.emit('click', value.root.querySelector('[data-roster-page="next"]'));
    value.payload.items[2].targetId = 20; value.payload.items[2].monitorStatus = 'enabled'; value.payload.summary = { total: 6, registered: 3, enabled: 3, paused: 0, pending: 3 };
    await value.controller.requestRefresh({ force: true });
    assert.equal(status.value, 'pending'); assert.equal(classification.value, 'label:slice'); assert.match(value.root.querySelector('.master-roster-pagination > span').textContent, /第 2 \/ 2 页/);
    assert.equal(value.root.querySelector('tbody').children.length, 1); assert.match(value.root.querySelector('.master-roster-counts').textContent, /已建档资料 3/);
  });
});
test('a response arriving during keyboard interaction is buffered without replacing the focused row, then applied on leaving', async () => {
  await mounted(async value => {
    const wait = deferred(); value.nextRead = wait; const body = value.root.querySelector('tbody'), before = body.replacements;
    const pending = value.controller.requestRefresh({ force: true }); await settle();
    const search = value.root.querySelector('input'); search.focus(); search.value = '资料';
    const changed = structuredClone(value.payload); changed.items[0].name = '资料已刷新'; wait.resolve({ ok: true, json: async () => changed }); await pending;
    assert.equal(value.doc.activeElement, search); assert.equal(search.value, '资料'); assert.equal(body.replacements, before);
    value.doc.body.focus(); await value.root.emit('focusout', search); assert.equal(body.replacements, before + 1); assert.match(body.textContent, /资料已刷新/);
  });
});
test('open supplement draft blocks global refresh and remains untouched until the user leaves the dialog and table control', async () => {
  await mounted(async value => {
    const status = value.root.querySelector('[aria-label="监控状态"]'); status.value = 'pending'; await value.root.emit('change', status);
    const opener = value.root.querySelector('[data-roster-supplement="item-2"]'); await value.root.emit('click', opener);
    const dialog = value.doc.nodes.find(node => node.tagName === 'dialog'), input = dialog.querySelector('input'); input.value = '待提交的新线索';
    await value.controller.requestRefresh({ force: true }); assert.equal(value.reads, 1); assert.equal(input.value, '待提交的新线索'); assert.equal(dialog.open, true);
    dialog.close(); await settle(); assert.equal(value.doc.activeElement, opener); assert.equal(value.reads, 1);
    value.doc.body.focus(); await value.root.emit('focusout', opener); await settle(); assert.equal(value.reads, 2);
  });
});
test('a failed refresh preserves the last verified roster and a later manual refresh recovers', async () => {
  await mounted(async value => {
    const before = value.root.querySelector('tbody').children[0], wait = deferred(); value.nextRead = wait;
    const pending = value.controller.requestRefresh({ force: true }); wait.reject(new Error('network failure')); await pending;
    assert.equal(value.root.querySelector('tbody').children[0], before); assert.match(value.root.querySelector('.master-roster-read-status').textContent, /保留/);
    value.nextRead = null; await value.controller.requestRefresh({ force: true }); assert.equal(value.reads, 3);
  });
});
test('awaiting-verification transitions to a rejected terminal explanation and reenables supplement without changing totals', async () => {
  await mounted(async value => {
    const status = value.root.querySelector('[aria-label="监控状态"]'); status.value = 'pending'; await value.root.emit('change', status);
    value.payload.items[2].supplement = { jobId: '91fdbe72-b76d-477f-aeb0-33ad48ed53ba', status: 'awaiting-verification', submittedAt: '2026-10-09T01:00:00Z', reason: '仍在核验' };
    await value.controller.requestRefresh({ force: true }); assert.equal(value.root.querySelector('[data-roster-supplement="item-2"]').disabled, true);
    const counts = value.root.querySelector('.master-roster-counts').textContent;
    value.payload.items[2].supplement.status = 'review-required'; value.payload.items[2].supplement.reason = '作品作者与原账号不一致，请更换作品';
    await value.controller.requestRefresh({ force: true }); assert.equal(value.root.querySelector('[data-roster-supplement="item-2"]').disabled, false);
    assert.equal(value.root.querySelector('.master-roster-counts').textContent, counts); assert.match(value.root.querySelector('tbody').textContent, /作品作者与原账号不一致，请更换作品/);
  });
});
test('shell sends a normal status hint and an explicit refresh hint through the agreed read-only event', () => {
  const source = fs.readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8');
  assert.match(source, /mcn:master-roster-refresh[^\n]+force: false/);
  assert.match(source, /mcn:master-roster-refresh[^\n]+force: true/);
});
