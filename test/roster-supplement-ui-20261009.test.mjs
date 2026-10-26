import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRosterSupplementWorkflow, mountRosterSupplementDialog, rosterImportJobHref, validateMasterRoster } from '../public/master-roster.js';

const UUID = '91fdbe72-b76d-477f-aeb0-33ad48ed53ba';
const SHA = 'a'.repeat(64), PREVIEW = 'b'.repeat(64);
function snapshot() {
  return { snapshotAt: '2026-10-09T12:00:00.000Z', workbook: { fileName: '总表.xlsx', sha256: SHA }, summary: { total: 1, registered: 0, enabled: 0, paused: 0, pending: 1 }, items: [{
    key: 'submitted:douyin:fixture', targetId: null, platform: 'douyin', name: '<img src=x>', originalNames: [], accountIds: ['00123'], theme: { key: 'tuantuan', label: '团团' }, classifications: [{ key: 'slice', label: '切片' }], monitorStatus: 'pending', identityStatus: '待补充', profileLinks: [], sourceTitles: ['团团总表'], sourceLinks: [], reviewReasons: ['原表缺少可核对的主页'],
  }] };
}
function receipt({ canSubmit = true, ...changes } = {}) {
  return { previewSha256: PREVIEW, entry: snapshot().items[0], evidence: 'https://v.douyin.com/example/', review: { status: canSubmit ? 'resolvable' : 'needs_locator', reason: '需核对视频作者，不代表已监控', canSubmit }, ...changes };
}
const job = () => ({ id: UUID, status: 'queued', fileName: '总表补充资料' });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function setup(api, overrides = {}) {
  const calls = [], source = snapshot();
  const workflow = createRosterSupplementWorkflow({ canEdit: () => true, randomUUID: () => UUID, api: async (path, options) => { calls.push({ path, options, body: JSON.parse(options.body) }); return api(path, options); }, ...overrides });
  workflow.open(source, source.items[0]); workflow.edit(' https://v.douyin.com/example/ ');
  return { workflow, calls, source };
}

test('preview sends only frozen roster identity and one evidence, never names, classification or source overrides', async () => {
  const { workflow, calls, source } = setup(async () => receipt()); const before = structuredClone(source);
  await workflow.preview();
  assert.deepEqual(calls[0].body, { workbookSha256: SHA, entryKey: source.items[0].key, evidence: 'https://v.douyin.com/example/' });
  assert.equal(calls[0].path, '/api/master-roster/supplement/preview'); assert.equal(calls.length, 1);
  assert.equal(workflow.state.canSubmit, true); assert.deepEqual(source, before);
});
test('viewers cannot preview or submit through programmatic activation', async () => {
  const { workflow, calls } = setup(async () => receipt(), { canEdit: () => false });
  await assert.rejects(workflow.preview(), /只读/); await assert.rejects(workflow.submit(), /只读/); assert.equal(calls.length, 0);
});
test('no submit before explicit preview; paused and already registered entries cannot open supplement workflow', async () => {
  const { workflow, source, calls } = setup(async () => receipt());
  await assert.rejects(workflow.submit(), /先预览/); assert.equal(calls.length, 0);
  for (const monitorStatus of ['enabled', 'paused']) assert.throws(() => workflow.open(source, { ...source.items[0], targetId: 1, monitorStatus }), /只有待核对/);
});
test('blank, multiline and oversized input never reaches preview API', async () => {
  const { workflow, calls } = setup(async () => receipt());
  for (const input of ['', ' \t ', 'one\ntwo', 'x'.repeat(1001)]) { workflow.edit(input); await assert.rejects(workflow.preview(), /只填写一个/); }
  assert.equal(calls.length, 0);
});
test('editing revokes approved preview and late old preview cannot resurrect submit', async () => {
  const wait = deferred(), { workflow } = setup(async () => wait.promise);
  const pending = workflow.preview(); workflow.edit('new-account'); wait.resolve(receipt());
  assert.equal(await pending, null); assert.equal(workflow.state.preview, null); assert.equal(workflow.state.canSubmit, false);
  await assert.rejects(workflow.submit(), /先预览/);
});
test('blocked review, pending verification and conflict receipts do not permit submit', async () => {
  const { workflow, calls, source } = setup(async () => receipt({ canSubmit: false }));
  await workflow.preview(); assert.equal(workflow.state.canSubmit, false); await assert.rejects(workflow.submit(), /先预览/);
  for (const status of ['queued', 'running', 'awaiting-verification', 'conflict']) {
    workflow.open(source, { ...source.items[0], supplement: { status } }); workflow.edit('123');
    await assert.rejects(workflow.preview(), /先查看任务/);
  }
  assert.equal(calls.length, 1);
});
test('preview receipt must correspond to the original entry and platform with explicit boolean approval', async () => {
  for (const changed of [receipt({ previewSha256: '' }), receipt({ entry: { key: 'other', platform: 'douyin' } }), receipt({ entry: { key: snapshot().items[0].key, platform: 'bilibili' } }), receipt({ review: { status: 'ready', reason: 'okay', canSubmit: 'true' } })]) {
    const { workflow } = setup(async () => changed); await assert.rejects(workflow.preview(), /不完整或与原资料不一致/); assert.equal(workflow.state.canSubmit, false);
  }
});
test('explicit confirm uses preview digest, same payload and valid idempotency key; double clicks do not submit twice', async () => {
  const wait = deferred(), { workflow, calls } = setup(async path => path.endsWith('/preview') ? receipt() : wait.promise);
  await workflow.preview(); const pending = workflow.submit(); assert.equal(await workflow.submit(), null); assert.equal(workflow.edit('change-during-submit'), false);
  assert.equal(calls.length, 2); assert.equal(calls[1].options.headers['Idempotency-Key'], UUID);
  assert.deepEqual(calls[1].body, { ...calls[0].body, previewSha256: PREVIEW });
  wait.resolve({ job: job(), idempotencyReplay: false }); assert.equal((await pending).id, UUID); assert.equal(workflow.state.canSubmit, false);
});
test('uncertain response retries the identical idempotency key without implying success', async () => {
  let count = 0;
  const { workflow, calls } = setup(async path => {
    if (path.endsWith('/preview')) return receipt();
    if (++count === 1) throw new Error('network offline'); return { job: job(), idempotencyReplay: true };
  });
  await workflow.preview(); await assert.rejects(workflow.submit(), /offline/); assert.equal(workflow.state.job, null);
  assert.equal(workflow.state.canSubmit, true); await workflow.submit();
  assert.equal(calls[1].options.headers['Idempotency-Key'], calls[2].options.headers['Idempotency-Key']); assert.deepEqual(calls[1].body, calls[2].body);
});
test('stale snapshot 409 discards preview and requires new user preview', async () => {
  const { workflow } = setup(async path => { if (path.endsWith('/preview')) return receipt(); throw Object.assign(new Error('名册变化'), { status: 409 }); });
  await workflow.preview(); await assert.rejects(workflow.submit(), /名册变化/); assert.equal(workflow.state.preview, null); assert.equal(workflow.state.canSubmit, false);
});
test('permission changes invalidate late approval and stop subsequent writes', async () => {
  let editable = true; const wait = deferred(); const { workflow, calls } = setup(async () => wait.promise, { canEdit: () => editable });
  const pending = workflow.preview(); editable = false; wait.resolve(receipt()); assert.equal(await pending, null);
  await assert.rejects(workflow.submit(), /只读/); assert.equal(calls.length, 1);
});
test('closing then reopening isolates old preview response from another draft', async () => {
  const wait = deferred(), { workflow, source } = setup(async () => wait.promise);
  const pending = workflow.preview(); workflow.close(); workflow.open(source, { ...source.items[0], key: 'another' }); workflow.edit('new');
  wait.resolve(receipt()); assert.equal(await pending, null); assert.equal(workflow.state.evidence, 'new'); assert.equal(workflow.state.preview, null);
});
test('missing job receipt stays uncertain and never reports linked or monitored', async () => {
  const { workflow } = setup(async path => path.endsWith('/preview') ? receipt() : { job: { id: 'bad', status: 'completed' } });
  await workflow.preview(); await assert.rejects(workflow.submit(), /回执不完整/); assert.equal(workflow.state.job, null); assert.equal(workflow.state.canSubmit, true);
});
test('task navigation uses the real importJob URL key and never accepts arbitrary redirect value', () => {
  const url = new URL(rosterImportJobHref(UUID, 'http://127.0.0.1:4188/?theme=tuantuan#accounts'));
  assert.equal(url.searchParams.get('importJob'), UUID); assert.equal(url.searchParams.get('theme'), 'tuantuan'); assert.equal(url.hash, '#import');
  assert.equal(rosterImportJobHref('javascript:alert(1)', url.href), null);
});
test('roster read model accepts all real supplement states and rejects malformed receipts without promoting pending records', () => {
  for (const status of ['queued', 'running', 'completed', 'failed', 'interrupted', 'awaiting-verification', 'review-required', 'conflict', 'linked']) {
    const source = snapshot(); source.items[0].supplement = { jobId: UUID, status, submittedAt: source.snapshotAt, reason: '<unsafe>' };
    const value = validateMasterRoster(source); assert.equal(value.items[0].targetId, null); assert.equal(value.summary.pending, 1); assert.equal(value.items[0].supplement.reason, '<unsafe>');
  }
  for (const changes of [{ jobId: 'bad' }, { status: 'invented' }, { submittedAt: 'bad' }, { reason: {} }]) {
    const source = snapshot(); source.items[0].supplement = { jobId: UUID, status: 'queued', submittedAt: source.snapshotAt, ...changes };
    assert.throws(() => validateMasterRoster(source));
  }
});

class FakeElement {
  constructor(tag, owner) { this.tagName = tag; this.owner = owner; this.children = []; this.parent = null; this.listeners = new Map(); this.attrs = new Map(); this.hidden = false; this.disabled = false; this.open = false; this.value = ''; this._text = ''; }
  set innerHTML(_) { throw new Error('Supplement must not insert raw HTML'); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  get isConnected() { return this === this.owner.body || Boolean(this.parent?.isConnected); }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const node of this.children) node.parent = null; this.children = []; this._text = ''; this.append(...nodes); }
  setAttribute(key, value) { this.attrs.set(key, String(value)); }
  removeAttribute(key) { this.attrs.delete(key); }
  addEventListener(type, callback) { const callbacks = this.listeners.get(type) || []; callbacks.push(callback); this.listeners.set(type, callbacks); }
  removeEventListener(type, callback) { this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== callback)); }
  async emit(type) { for (const callback of this.listeners.get(type) || []) await callback({ target: this, preventDefault() {} }); }
  showModal() { this.open = true; }
  close() { this.open = false; void this.emit('close'); }
  focus() { this.owner.activeElement = this; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(value => value !== this); this.parent = null; }
}
function fakeDom() {
  const doc = { activeElement: null, nodes: [], createElement(tag) { const node = new FakeElement(tag, this); this.nodes.push(node); return node; } };
  doc.body = doc.createElement('body'); return doc;
}
async function dialogFixture(run, { api = async path => path.endsWith('/preview') ? receipt() : { job: job() }, canEdit = () => true } = {}) {
  const previousDocument = globalThis.document, previousLocation = globalThis.location;
  const doc = fakeDom(); globalThis.document = doc; globalThis.location = { href: 'http://localhost:4188/#accounts' };
  const host = doc.createElement('section'), opener = doc.createElement('button'), fallback = doc.createElement('p'); doc.body.append(host, opener, fallback);
  const calls = []; let refreshed = 0;
  const controller = mountRosterSupplementDialog({ host, canEdit, api: async (...args) => { calls.push(args); return api(...args); }, focusFallback: fallback, onSettled: () => { refreshed++; } });
  const source = snapshot(); controller.open(source, source.items[0], opener);
  const find = text => doc.nodes.find(node => node.textContent === text), input = doc.nodes.find(node => node.tagName === 'input');
  try { await run({ doc, controller, source, opener, fallback, calls, input, find, get refreshed() { return refreshed; } }); }
  finally { controller.destroy(); globalThis.document = previousDocument; globalThis.location = previousLocation; }
}
test('dialog displays original identity, source, classifications and reason as plain text; no request on open or input', async () => {
  await dialogFixture(async ({ doc, input, calls }) => {
    const content = doc.body.textContent; for (const expected of ['<img src=x>', '抖音 · 00123', '团团 / 切片', '团团总表', '原表缺少可核对的主页']) assert.ok(content.includes(expected));
    assert.equal(doc.activeElement, input); assert.equal(input.maxLength, 1000); assert.ok(input.attrs.get('aria-describedby').includes('-error'));
    input.value = '123'; await input.emit('input'); assert.equal(calls.length, 0);
  });
});
test('dialog preview then explicit confirmation returns job link, not a claim that monitoring succeeded', async () => {
  await dialogFixture(async value => {
    value.input.value = 'https://v.douyin.com/example/'; await value.input.emit('input');
    await value.find('预览补充资料').emit('click'); assert.equal(value.calls.length, 1);
    const confirm = value.find('确认提交核对'); assert.equal(confirm.hidden, false); assert.equal(confirm.disabled, false);
    await confirm.emit('click'); assert.equal(value.calls.length, 2); assert.equal(value.refreshed, 1);
    const link = value.find('查看任务结果'); assert.equal(link.hidden, false); assert.equal(new URL(link.href).searchParams.get('importJob'), UUID);
    assert.match(value.doc.body.textContent, /不是采集成功通知/); assert.equal(value.input.disabled, true);
  });
});
test('dialog edits remove previous approval and Escape returns focus to opener or retained table fallback', async () => {
  await dialogFixture(async ({ doc, controller, source, opener, fallback, input, find }) => {
    input.value = '123'; await input.emit('input'); await find('预览补充资料').emit('click');
    input.value = '456'; await input.emit('input'); assert.equal(find('确认提交核对').hidden, true); assert.equal(find('确认提交核对').disabled, true);
    const dialog = doc.nodes.find(node => node.tagName === 'dialog'); await dialog.emit('cancel'); assert.equal(dialog.open, false); assert.equal(doc.activeElement, opener);
    controller.open(source, source.items[0], opener); opener.remove(); await dialog.emit('cancel'); assert.equal(doc.activeElement, fallback);
  });
});
test('dialog shows actionable 409 cause, keeps draft and requires fresh preview', async () => {
  await dialogFixture(async ({ doc, input, find }) => {
    input.value = '123'; await input.emit('input'); await find('预览补充资料').emit('click'); await find('确认提交核对').emit('click');
    assert.equal(input.value, '123'); assert.match(doc.body.textContent, /读取最新名册/); assert.equal(find('确认提交核对').disabled, true);
  }, { api: async path => { if (path.endsWith('/preview')) return receipt(); throw Object.assign(new Error('原资料已改变'), { status: 409 }); } });
});
test('dialog losing edit role removes approved action and synthetic clicks cannot write', async () => {
  let editable = true;
  await dialogFixture(async ({ controller, input, calls, find }) => {
    input.value = '123'; await input.emit('input'); await find('预览补充资料').emit('click'); editable = false; controller.syncRole();
    assert.equal(input.disabled, true); assert.equal(find('确认提交核对').hidden, true); await find('确认提交核对').emit('click'); assert.equal(calls.length, 1);
  }, { canEdit: () => editable });
});
test('session bridge reuses authenticated API with dynamic canEdit; archive export is explicitly not an import template', () => {
  const shell = fs.readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8');
  const entry = fs.readFileSync(new URL('../public/master-roster-entry.js', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../public/master-roster.js', import.meta.url), 'utf8');
  assert.match(shell, /mcn:master-roster-bind[^\n]+detail: \{ api, canEdit \}/); assert.match(shell, /mcn:master-roster-ready/);
  assert.match(entry, /canEdit: \(\) => bridge\?\.canEdit\?\.\(\) === true/); assert.match(entry, /return bridge\.api\(\.\.\.args\)/);
  assert.match(source, /导出归档名单/); assert.match(source, /不是导入模板，不可直接回导/);
  assert.doesNotMatch(source, /\/api\/targets|\/api\/collect/);
});
test('roster selects have stable accessible labels without reading every option', () => {
  const source = fs.readFileSync(new URL('../public/master-roster.js', import.meta.url), 'utf8');
  for (const [field, label] of [['status', '监控状态'], ['theme', '总表来源大主题'], ['classification', '总表来源内容分类']]) {
    assert.ok(source.includes(`${field}.setAttribute('aria-label', '${label}')`));
  }
});
