import test from 'node:test';
import assert from 'node:assert/strict';
import { createImportReview } from '../public/import-review.js';
import { projectImportReview } from '../lib/import-review.mjs';

const ID = '91fdbe72-b76d-477f-aeb0-33ad48ed53ba', OTHER = 'a8222222-2222-4222-8222-222222222222';
const job = { id: ID, status: 'completed', result: { skipped: Array.from({ length: 45 }, (_, i) => ({ name: `甲作者${i}`, douyinId: `ID${i}`, platform: 'douyin', status: i % 2 ? 'needs_locator' : 'unresolved', reason: i % 2 ? '缺主页' : '待核对' })) } };
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
class FakeNode {
  constructor(doc, name) { this.ownerDocument = doc; this.name = name; this.value = ''; this.innerHTML = ''; this.textContent = ''; this._disabled = false; this.attrs = {}; }
  get disabled() { return this._disabled; }
  set disabled(value) { this._disabled = value; if (value && this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  setAttribute(name, value) { this.attrs[name] = value; }
  contains(node) { return node === this; }
  focus() { this.ownerDocument.activeElement = this; this.ownerDocument.emit('focusin', this); }
}
function fixture(handler) {
  const doc = { activeElement: null, listeners: new Map(), focused: true,
    addEventListener(type, listener) { const list = this.listeners.get(type) || []; list.push(listener); this.listeners.set(type, list); },
    removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== listener)); },
    emit(type, target) { for (const listener of this.listeners.get(type) || []) listener({ target }); }, hasFocus() { return this.focused; } };
  doc.body = new FakeNode(doc, 'body'); doc.documentElement = new FakeNode(doc, 'html'); doc.activeElement = doc.body;
  const nodes = Object.fromEntries(['rows', 'status', 'form', 'query', 'filter', 'previous', 'next'].map(key => [key, new FakeNode(doc, key)]));
  const root = { ownerDocument: doc, hidden: true, attrs: {}, setAttribute(key, value) { this.attrs[key] = value; }, querySelector(selector) { return nodes[selector.match(/"(\w+)"/)[1]]; } };
  const calls = []; let allowed = true;
  const api = async (path, options) => {
    const u = new URL(path, 'http://test'); const call = { path, options, query: u.searchParams.get('q'), status: u.searchParams.get('status'), offset: Number(u.searchParams.get('offset')) }; calls.push(call);
    if (handler) return handler(call, calls.length);
    return projectImportReview(job, { query: call.query, status: call.status, offset: call.offset, limit: 20 });
  };
  return { doc, root, nodes, calls, controller: createImportReview({ root, api, canRead: () => allowed }), set allowed(value) { allowed = value; } };
}
const reply = call => projectImportReview(job, { query: call.query, status: call.status, offset: call.offset, limit: 20 });

test('pagination uses the applied query and status, keeping an unsubmitted draft intact and explicit', async () => {
  const f = fixture(); await f.controller.setJob(job);
  f.nodes.query.value = '甲'; f.nodes.filter.value = 'unresolved'; await f.nodes.form.onsubmit({ preventDefault() {} });
  f.nodes.query.value = '乙'; f.nodes.filter.value = 'needs_locator';
  await f.nodes.next.onclick(); const call = f.calls.at(-1);
  assert.equal(call.query, '甲'); assert.equal(call.status, 'unresolved'); assert.equal(call.offset, 20);
  assert.equal(f.nodes.query.value, '乙'); assert.equal(f.nodes.filter.value, 'needs_locator');
  assert.match(f.nodes.status.textContent, /已应用：搜索“甲” \/ 尚未确认身份 · 第 2 \/ 2 页/);
  assert.match(f.nodes.status.textContent, /新条件尚未应用/);
});
test('failed new criteria identify the exact retained applied conditions, page and range', async () => {
  let fail = false; const f = fixture(call => { if (fail) throw new Error('offline'); return reply(call); });
  await f.controller.setJob(job); f.nodes.query.value = '甲'; await f.controller.load(); await f.nodes.next.onclick();
  const before = f.nodes.rows.innerHTML; f.nodes.query.value = '乙'; f.nodes.filter.value = 'needs_locator'; fail = true;
  await f.nodes.form.onsubmit({ preventDefault() {} });
  assert.equal(f.nodes.rows.innerHTML, before); assert.equal(f.nodes.query.value, '乙');
  assert.match(f.nodes.status.textContent, /保留上次已应用结果：搜索“甲” \/ 全部原因状态 · 第 2 \/ 3 页，显示 21–40 \/ 45 项/);
  assert.match(f.nodes.status.textContent, /输入框中的新条件未应用/); assert.match(f.nodes.status.textContent, /未提交任何名单/);
  fail = false; await f.nodes.next.onclick(); assert.equal(f.calls.at(-1).query, '甲'); assert.equal(f.calls.at(-1).status, ''); assert.equal(f.calls.at(-1).offset, 40);
});
test('repeated page activation sends one GET while pending and restores next when result remains pageable', async () => {
  const wait = defer(); const f = fixture((call, count) => count === 1 ? reply(call) : wait.promise);
  await f.controller.setJob(job); f.nodes.next.focus(); const read = f.nodes.next.onclick();
  assert.equal(f.nodes.previous.disabled, true); assert.equal(f.nodes.next.disabled, true); assert.equal(f.doc.activeElement, f.doc.body);
  await f.nodes.next.onclick(); await f.nodes.previous.onclick(); assert.equal(f.calls.length, 2);
  wait.resolve(reply(f.calls[1])); await read; assert.equal(f.doc.activeElement, f.nodes.next); assert.equal(f.nodes.next.disabled, false);
  assert.equal(f.doc.listeners.get('focusin').length, 0);
});
test('last-page and first-page keyboard focus safely transfer to the available reverse pager', async () => {
  const f = fixture(); await f.controller.setJob(job); await f.nodes.next.onclick(); f.nodes.next.focus(); await f.nodes.next.onclick();
  assert.equal(f.nodes.next.disabled, true); assert.equal(f.doc.activeElement, f.nodes.previous);
  await f.nodes.previous.onclick(); f.nodes.previous.focus(); await f.nodes.previous.onclick();
  assert.equal(f.nodes.previous.disabled, true); assert.equal(f.doc.activeElement, f.nodes.next);
});
test('focus restoration does not steal a later keyboard or pointer choice', async () => {
  for (const interaction of ['focus', 'pointer']) {
    const wait = defer(); const f = fixture((call, count) => count === 1 ? reply(call) : wait.promise); await f.controller.setJob(job);
    f.nodes.next.focus(); const read = f.nodes.next.onclick();
    if (interaction === 'focus') f.nodes.query.focus(); else f.doc.emit('pointerdown', f.nodes.query);
    wait.resolve(reply(f.calls[1])); await read;
    assert.equal(f.doc.activeElement, interaction === 'focus' ? f.nodes.query : f.doc.body);
  }
});
test('a new search can cancel in-flight pagination and an old response never alters result or focus', async () => {
  const waits = []; const f = fixture((call, count) => { if (count === 1) return reply(call); const wait = defer(); waits.push({ call, wait }); return wait.promise; });
  await f.controller.setJob(job); f.nodes.next.focus(); const page = f.nodes.next.onclick();
  f.nodes.query.value = 'ID44'; f.nodes.query.focus(); const search = f.nodes.form.onsubmit({ preventDefault() {} });
  assert.equal(waits[0].call.options.signal.aborted, true);
  waits[1].wait.resolve(reply(waits[1].call)); await search; const expected = f.nodes.rows.innerHTML;
  waits[0].wait.resolve(reply(waits[0].call)); await page;
  assert.equal(f.nodes.rows.innerHTML, expected); assert.match(expected, /甲作者44/); assert.equal(f.doc.activeElement, f.nodes.query);
  assert.equal(f.nodes.next.disabled, true); assert.equal(f.nodes.previous.disabled, true);
});
test('a failed page read keeps its old page and safely restores the originating pager focus', async () => {
  const f = fixture((call, count) => { if (count > 1) throw new Error('offline'); return reply(call); }); await f.controller.setJob(job);
  const before = f.nodes.rows.innerHTML; f.nodes.next.focus(); await f.nodes.next.onclick();
  assert.equal(f.nodes.rows.innerHTML, before); assert.equal(f.doc.activeElement, f.nodes.next); assert.match(f.nodes.status.textContent, /第 1 \/ 3 页/);
  assert.match(f.nodes.status.textContent, /本次读取未改变清单/);
});
test('no prior success is not represented as an empty list; permission loss clears old rows and pager access', async () => {
  let fail = true; const f = fixture(call => { if (fail) throw new Error('offline'); return reply(call); }); await f.controller.setJob(job);
  assert.match(f.nodes.status.textContent, /尚未取得有效审查清单，不以空名单代替/); assert.equal(f.nodes.previous.disabled, true); assert.equal(f.nodes.next.disabled, true);
  fail = false; await f.controller.load(); f.allowed = false; await f.controller.load();
  assert.equal(f.root.hidden, true); assert.equal(f.nodes.rows.innerHTML, ''); assert.equal(f.nodes.next.disabled, true); assert.equal(f.root.attrs['aria-busy'], 'false');
});
test('switching jobs clears the previous applied page and stale old reads cannot restore its names', async () => {
  const wait = defer(); let count = 0; const f = fixture(call => {
    count++; if (count === 2) return wait.promise;
    return projectImportReview({ ...job, id: count > 2 ? OTHER : ID }, { query: call.query, status: call.status, offset: call.offset });
  });
  await f.controller.setJob(job); f.nodes.next.focus(); const old = f.nodes.next.onclick();
  await f.controller.setJob({ ...job, id: OTHER }); const expected = f.nodes.rows.innerHTML;
  wait.resolve(projectImportReview(job, { offset: 20 })); await old;
  assert.equal(f.nodes.rows.innerHTML, expected); assert.match(f.nodes.status.textContent, /第 1 \/ 3 页/);
});
