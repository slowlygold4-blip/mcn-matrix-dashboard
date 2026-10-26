import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { validateMasterRoster, filterMasterRoster, createRosterSupplementWorkflow,
  canSupplementRosterEntry, rosterSummaryCaption, masterRosterCsv, mountMasterRoster } from '../public/master-roster.js';

const settle = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
const harness = readFileSync(new URL('./roster-refresh-ui-20261009.test.mjs', import.meta.url), 'utf8');
const { Node, make, fixture } = new Function('assert', 'settle',
  harness.slice(harness.indexOf('class Node {'), harness.indexOf('async function mounted(')) + '\nreturn {Node,make,fixture};')(assert, settle);
function liveFixture() {
  const payload = fixture();
  Object.assign(payload.items[5], { key: 'live-source:douyin:fixture', liveSource: true, readOnly: true,
    name: '一个西红柿OVO', originalNames: ['一个西红柿OVO', '西红柿原名'], accountIds: ['77344146652'] });
  payload.liveSources = { sourceJobCount: 2, sourceRowCount: 12, addedEntryCount: 1, aliasedEntryCount: 2,
    latestSourceAt: '2026-10-09T14:50:00.000Z' };
  return payload;
}
function linkedFixture(status = 'enabled', kind = 'strict-public-account-proof') {
  const payload = liveFixture();
  Object.assign(payload.items[5], { targetId: 99, monitorStatus: status, identityStatus: '来源凭据关联现有账号',
    liveSourceBinding: { kind, targetId: 99, jobId: '9e4f61b9-cfcb-4d6c-87cf-4b8c48f5a986' } });
  payload.summary.pending--; payload.summary.registered++; payload.summary[status]++;
  return payload;
}

test('live source flags and counts are validated and retain original archive provenance', () => {
  const raw = liveFixture(), value = validateMasterRoster(raw);
  assert.deepEqual(value.liveSources, raw.liveSources); assert.equal(value.workbook.sha256, raw.workbook.sha256);
  assert.equal(value.snapshotAt, raw.snapshotAt);
  for (const mutate of [
    v => { v.liveSources.addedEntryCount = 2; }, v => { v.liveSources.sourceRowCount = -1; },
    v => { v.liveSources.latestSourceAt = 'invalid'; }, v => { v.items[5].readOnly = false; },
    v => { v.items[5].liveSource = 'true'; }, v => { v.items[5].readOnly = 'true'; },
  ]) { const bad = liveFixture(); mutate(bad); assert.throws(() => validateMasterRoster(bad)); }
});

test('new author and exact stable-ID aliases are searchable without pretending to match other names', () => {
  const snapshot = validateMasterRoster(liveFixture());
  for (const query of ['西红柿', '西红柿原名', '77344146652']) {
    assert.equal(filterMasterRoster(snapshot.items, { query }).length, 1);
  }
  assert.equal(filterMasterRoster(snapshot.items, { query: '一条西红柿OVO' }).length, 0, 'must not silently guess a different author');
  assert.match(rosterSummaryCaption(snapshot), /完整名册 6 条 · 启用监控 2 · 已暂停 0 · 待接入 \/ 核对 4/);
});

test('read-only live source entries cannot issue a frozen-workbook supplement even through direct workflow use', async () => {
  let calls = 0; const workflow = createRosterSupplementWorkflow({ canEdit: () => true, api: async () => { calls++; } });
  const snapshot = validateMasterRoster(liveFixture());
  assert.equal(canSupplementRosterEntry(snapshot.items[5]), false);
  assert.throws(() => workflow.open(snapshot, snapshot.items[5]), /只有待核对的原总表/);
  assert.equal(await workflow.preview(), null); assert.equal(calls, 0);
  assert.equal(canSupplementRosterEntry(snapshot.items[2]), true);
  workflow.open(snapshot, snapshot.items[2]); assert.equal(workflow.state.context.entry.key, snapshot.items[2].key);
});

test('CSV labels latest-source rows without falsely assigning the frozen workbook hash or timestamp', () => {
  const snapshot = validateMasterRoster(liveFixture()), csv = masterRosterCsv(snapshot, [snapshot.items[5]]);
  assert.match(csv, /最新来源资料（非原总表行，待接入）/); assert.match(csv, /西红柿原名/);
  assert.ok(!csv.includes(snapshot.workbook.sha256)); assert.ok(!csv.includes(snapshot.snapshotAt));
});

test('bound source entries accept explicit validated proof shape and preserve enabled or paused state', () => {
  for (const status of ['enabled', 'paused']) for (const kind of ['strict-public-account-proof', 'completed-job-canonical-target']) {
    const snapshot = validateMasterRoster(linkedFixture(status, kind)), item = snapshot.items[5];
    assert.equal(item.monitorStatus, status); assert.equal(item.targetId, 99);
    assert.equal(canSupplementRosterEntry(item), false);
    assert.match(masterRosterCsv(snapshot, [item]), /已建档/);
    assert.ok(!masterRosterCsv(snapshot, [item]).includes('待接入'));
    assert.equal(snapshot.summary.registered, 3); assert.equal(snapshot.summary.pending, 3);
  }
  for (const mutate of [
    v => { delete v.items[5].liveSourceBinding; },
    v => { v.items[5].liveSourceBinding.kind = 'nickname-match'; },
    v => { v.items[5].liveSourceBinding.targetId = 100; },
    v => { v.items[5].liveSourceBinding.jobId = '../unverified'; },
    v => { v.items[5].liveSourceBinding.targetId = '99'; },
    v => { v.items[5].readOnly = false; },
  ]) { const bad = linkedFixture(); mutate(bad); assert.throws(() => validateMasterRoster(bad)); }
  const pending = liveFixture(); pending.items[5].liveSourceBinding = linkedFixture().items[5].liveSourceBinding;
  assert.throws(() => validateMasterRoster(pending), /身份或状态/);
});

async function mounted(run, payload = liveFixture()) {
  const previous = { document: globalThis.document, Option: globalThis.Option, CustomEvent: globalThis.CustomEvent };
  const events = [];
  const doc = { nodes: [], createElement(tag) { const node = new Node(tag, this); this.nodes.push(node); return node; },
    dispatchEvent(event) { events.push(event); } };
  doc.body = doc.createElement('body'); doc.activeElement = doc.body;
  globalThis.document = doc;
  globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail; } };
  globalThis.Option = class extends Node { constructor(label, value) { super('option', doc); this.textContent = label; this.value = value; } };
  const requests = [], host = make(doc, doc.body, 'main');
  const opened = [];
  const controller = mountMasterRoster({ host, pageSize: 2, canEdit: () => true,
    onOpenAccount: id => opened.push(id),
    fetcher: async (_url, options) => { requests.push(options.method); return { ok: true, json: async () => structuredClone(payload) }; },
    api: async () => { throw new Error('unexpected mutation'); } });
  try { await controller.ready; await run({ controller, doc, events, payload, requests, opened, root: host.children[0] }); }
  finally { controller.destroy(); Object.assign(globalThis, previous); }
}

test('explicit roster navigation finds the source-only author, opens first page and does not submit data', async () => {
  await mounted(async f => {
    assert.equal(await f.controller.openSearch({ query: '西红柿', theme: f.payload.items[5].theme.key }), true);
    assert.equal(f.root.querySelector('details').open, true);
    assert.equal(f.doc.activeElement, f.root.querySelector('input'));
    assert.match(f.root.querySelector('tbody').textContent, /一个西红柿OVO/);
    assert.match(f.root.querySelector('tbody').textContent, /最新来源已读取 · 待接入监控/);
    assert.equal(f.root.querySelector('[data-roster-supplement="live-source:douyin:fixture"]'), null);
    assert.match(f.root.querySelector('.master-roster-pagination > span').textContent, /1–1 \/ 1 条 · 第 1 \/ 1 页/);
    assert.deepEqual(f.requests, ['GET']);
    assert.equal(f.events.length, 1); assert.equal(f.events[0].type, 'mcn:master-roster-loaded');
    assert.deepEqual(Object.keys(f.events[0].detail.items[0]).sort(), ['accountIds', 'name', 'originalNames', 'targetId']);
    await f.controller.reload(); assert.equal(f.events.length, 1, 'unchanged snapshot does not cause a rendering loop');
  });
});

test('linked source row opens the verified target, is not shown as pending and cannot offer frozen supplement', async () => {
  for (const status of ['enabled', 'paused']) await mounted(async f => {
    await f.controller.openSearch({ query: '西红柿' });
    const body = f.root.querySelector('tbody');
    assert.match(body.textContent, /最新来源已建档 · 采样状态另查/);
    assert.doesNotMatch(body.textContent, /待接入监控|不计入经营统计/);
    assert.equal(f.root.querySelector('[data-roster-supplement="live-source:douyin:fixture"]'), null);
    const button = f.root.querySelector('[data-roster-target="99"]'); assert.ok(button);
    await f.root.emit('click', button); assert.deepEqual(f.opened, [99]);
    const published = f.events.find(event => event.type === 'mcn:master-roster-loaded').detail.items;
    assert.equal(published.find(item => item.name === '一个西红柿OVO').targetId, 99);
    assert.deepEqual(f.requests, ['GET']);
  }, linkedFixture(status));
});

test('automatic reads retain filters, page and focus; opening a source search cannot erase an active supplement draft', async () => {
  await mounted(async f => {
    const root = f.root, next = root.querySelector('[data-roster-page="next"]');
    next.focus(); await root.emit('click', next);
    assert.match(root.querySelector('.master-roster-pagination > span').textContent, /第 2 \/ 3 页/);
    f.payload.items[5].originalNames.push('最新别名');
    await f.controller.reload({ deferForInteraction: true });
    assert.equal(f.doc.activeElement, next);
    assert.match(root.querySelector('.master-roster-pagination > span').textContent, /第 2 \/ 3 页/);
    const opener = root.querySelector('[data-roster-supplement="item-2"]');
    await root.emit('click', opener);
    const dialog = f.doc.nodes.find(node => node.tagName === 'dialog'), input = dialog.querySelector('input');
    input.value = '尚未提交的主页线索'; await input.emit('input');
    assert.equal(await f.controller.openSearch({ query: '西红柿' }), false);
    assert.equal(input.value, '尚未提交的主页线索'); assert.equal(dialog.open, true);
  });
});

test('entry opens only upon explicit event, including a request queued while accounts are hidden', () => {
  const events = new Map(), view = { hidden: true }, opens = []; let visible;
  const doc = { hidden: false, getElementById: id => id === 'accountsView' ? view : {},
    addEventListener: (type, callback) => events.set(type, callback), dispatchEvent() {} };
  const source = readFileSync(new URL('../public/master-roster-entry.js', import.meta.url), 'utf8').replace(/^import[^\n]*\n/, '');
  vm.runInNewContext(source, { document: doc, CustomEvent: class {}, MutationObserver: class { constructor(callback) { visible = callback; } observe() {} },
    mountMasterRoster() { return { requestRefresh() {}, syncRole() {}, openSearch(options) { opens.push(options); } }; } });
  events.get('mcn:master-roster-open')({ detail: { query: '西红柿', theme: 'tuantuan' } }); assert.equal(opens.length, 0);
  view.hidden = false; visible(); assert.equal(opens.length, 1); assert.equal(opens[0].query, '西红柿'); assert.equal(opens[0].theme, 'tuantuan');
  events.get('visibilitychange')(); events.get('mcn:master-roster-refresh')({ detail: {} }); assert.equal(opens.length, 1);
});
