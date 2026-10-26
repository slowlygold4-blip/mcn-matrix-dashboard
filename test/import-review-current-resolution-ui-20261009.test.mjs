import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createImportReview } from '../public/import-review.js';
import { projectImportReview } from '../lib/import-review.mjs';

const ID = '72222222-2222-4222-8222-222222222222', OTHER = '73333333-3333-4333-8333-333333333333';
const SCOPE = 'current-source-bound-evidence-resolution-not-account-monitoring';
const TIME = '2026-10-09T10:50:00.000Z', LATER = '2026-10-09T10:55:00.000Z';
const job = { id: ID, status: 'completed', result: { skipped: Array.from({ length: 45 }, (_, i) => ({ sourceRow: i + 2, name: `作者${i}`, douyinId: `ID${i}`, platform: 'douyin', status: 'deferred', reason: '任务完成时：等待后续核验' })) } };
const current = (status = 'pending', reason = '核验尚未开始') => ({ status, reason, updatedAt: TIME, nextRetryAt: null, counts: { total: 1, linked: 1, pending: status === 'pending' ? 1 : 0, retry: 0, processing: 0, rejected: 0, resolved: status === 'resolved' ? 1 : 0, unknown: 0 } });
function reply(call, extra = {}) {
  const page = projectImportReview({ ...job, id: call.id }, { query: call.query, status: call.status, offset: call.offset });
  return { ...page, currentResolutionScope: SCOPE, checkedAt: TIME, items: page.items.map(item => ({ ...item, currentResolution: current() })), ...extra };
}
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
class FakeNode {
  constructor(doc) { this.ownerDocument = doc; this.textContent = ''; this.innerHTML = ''; this.value = ''; this.attrs = {}; this._disabled = false; }
  get disabled() { return this._disabled; }
  set disabled(value) { this._disabled = value; if (value && this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  setAttribute(key, value) { this.attrs[key] = value; }
  contains(node) { return node === this; }
  focus() { this.ownerDocument.activeElement = this; this.ownerDocument.emit('focusin', this); }
}
function fixture(handler) {
  const doc = { activeElement: null, listeners: new Map(), hasFocus() { return true; },
    addEventListener(type, listener) { const list = this.listeners.get(type) || []; list.push(listener); this.listeners.set(type, list); },
    removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== listener)); },
    emit(type, target) { for (const listener of this.listeners.get(type) || []) listener({ target }); } };
  doc.body = new FakeNode(doc); doc.documentElement = new FakeNode(doc); doc.activeElement = doc.body;
  const nodes = Object.fromEntries(['rows', 'status', 'form', 'query', 'filter', 'previous', 'next', 'refresh', 'checkedAt'].map(key => [key, new FakeNode(doc)]));
  const root = { ownerDocument: doc, hidden: true, attrs: {}, setAttribute(key, value) { this.attrs[key] = value; }, querySelector(selector) { return nodes[/"(\w+)"/.exec(selector)[1]]; } };
  const calls = []; let allowed = true;
  const api = async (path, options) => {
    const u = new URL(path, 'http://fixture'); const call = { path, options, id: path.split('/')[4], query: u.searchParams.get('q'), status: u.searchParams.get('status'), offset: Number(u.searchParams.get('offset')) }; calls.push(call);
    return handler ? handler(call, calls.length) : reply(call);
  };
  return { doc, nodes, root, calls, controller: createImportReview({ root, api, canRead: () => allowed }), set allowed(value) { allowed = value; } };
}

test('current evidence is a sixth column separate from unchanged historical reasons, with actual Beijing query time', async () => {
  const f = fixture(call => { const data = reply(call); data.items[0].currentResolution = current('resolved', '当前凭据及账号身份一致'); return data; });
  await f.controller.setJob(job);
  assert.match(f.nodes.rows.innerHTML, /当时等待后续核验/);
  assert.match(f.nodes.rows.innerHTML, /任务完成时：等待后续核验/);
  assert.match(f.nodes.rows.innerHTML, /data-resolution="resolved">证据核验通过/);
  assert.match(f.nodes.rows.innerHTML, /不代表已建档、启用监控或首次采样完成/);
  assert.match(f.nodes.checkedAt.textContent, /2026\/10\/09 18:50:00（北京时间）/);
  assert.match(f.nodes.checkedAt.textContent, /仅对应本页 20 条历史记录/);
  assert.match(f.nodes.status.textContent, /不是当前待处理人数/);
  assert.equal((f.nodes.rows.innerHTML.match(/<td(?:\s|>)/g) || []).length, 120);
});

test('all current statuses have explicit safe Chinese labels and mixed evidence retains its failure reasons and counts', async () => {
  const statuses = { resolved: '证据核验通过', pending: '等待证据核验', retry: '等待重试核验', processing: '正在核验证据', rejected: '证据核验未通过', mixed: '多条证据状态不同', conflict: '证据关联冲突', unlinked: '未关联核验证据', unknown: '当前状态无法确认', unavailable: '当前状态读取失败' };
  const f = fixture(call => ({ ...reply(call), items: Object.keys(statuses).map(status => ({ name: status, status: 'deferred', reason: '历史原因', currentResolution: { ...current(status, '<script>读取失败</script>：需要补充公开作品证据'), counts: { total: 3, pending: 1, rejected: 1, resolved: 1 } } })) }));
  await f.controller.setJob(job);
  for (const [status, label] of Object.entries(statuses)) assert.ok(f.nodes.rows.innerHTML.includes(`data-resolution="${status}">${label}`));
  assert.match(f.nodes.rows.innerHTML, /&lt;script&gt;读取失败&lt;\/script&gt;/);
  assert.doesNotMatch(f.nodes.rows.innerHTML, /<script>/);
  assert.match(f.nodes.rows.innerHTML, /等待证据核验 1 条 · 证据核验未通过 1 条 · 证据核验通过 1 条/);
  assert.match(f.nodes.rows.innerHTML, /需要补充公开作品证据/);
});

test('missing or unrecognized current scope never promotes a historical or forged resolved field', async () => {
  for (const scope of [undefined, '', 'legacy-live-queue']) {
    const f = fixture(call => ({ ...reply(call), currentResolutionScope: scope, items: [{ status: 'deferred', reason: '旧记录', currentResolution: current('resolved', '不可信的旧声明') }] }));
    await f.controller.setJob(job);
    assert.match(f.nodes.rows.innerHTML, /当前状态未提供/); assert.doesNotMatch(f.nodes.rows.innerHTML, /data-resolution="resolved"|不可信的旧声明/);
    assert.match(f.nodes.rows.innerHTML, /当时等待后续核验/); assert.match(f.nodes.checkedAt.textContent, /未返回明确范围与有效查询时间/);
  }
});

test('missing or invalid checkedAt prevents evidence success claims rather than fabricating current time', async () => {
  for (const checkedAt of [undefined, null, '', 0, 'not-a-date', '2026-10-09', '2026-10-09T10:50:00']) {
    const f = fixture(call => ({ ...reply(call), checkedAt, items: [{ currentResolution: current('resolved') }] }));
    await f.controller.setJob(job);
    assert.match(f.nodes.rows.innerHTML, /当前状态未提供/); assert.doesNotMatch(f.nodes.rows.innerHTML, /data-resolution="resolved"/);
    assert.doesNotMatch(f.nodes.checkedAt.textContent, /查询于/);
  }
});

test('missing associations, unknown future statuses and absent reasons remain explicit and escaped', async () => {
  const f = fixture(call => ({ ...reply(call), items: [
    { name: '无字段' }, { name: '无关联', currentResolution: current('unlinked', '未找到严格来源关联') },
    { name: '未来状态', currentResolution: { status: '<img onerror=1>', reason: '<b>不能确认</b>' } },
    { name: '缺原因', currentResolution: { status: 'unknown', updatedAt: 'bad' } }
  ] }));
  await f.controller.setJob(job);
  assert.match(f.nodes.rows.innerHTML, /此行没有提供当前证据关联结果/);
  assert.match(f.nodes.rows.innerHTML, /未找到严格来源关联/);
  assert.match(f.nodes.rows.innerHTML, /&lt;b&gt;不能确认&lt;\/b&gt;/);
  assert.doesNotMatch(f.nodes.rows.innerHTML, /<img|<b>|状态更新：bad/);
  assert.match(f.nodes.rows.innerHTML, /未提供当前核验原因/);
});

test('retry plan uses supplied timestamp and is not stated as promised completion', async () => {
  const f = fixture(call => ({ ...reply(call), items: [{ currentResolution: { ...current('retry', 'HTTP 403，等待下一次允许的核验'), nextRetryAt: LATER } }] }));
  await f.controller.setJob(job);
  assert.match(f.nodes.rows.innerHTML, /下次重试计划：2026\/10\/09 18:55:00 北京时间；不保证届时完成/);
  assert.match(f.nodes.rows.innerHTML, /HTTP 403/);
});

test('refresh reads current applied page once without applying a draft or submitting and restores its keyboard focus', async () => {
  const wait = defer(); const f = fixture((call, count) => count === 3 ? wait.promise : reply(call));
  await f.controller.setJob(job); await f.nodes.next.onclick();
  f.nodes.query.value = '未应用草稿'; f.nodes.filter.value = 'needs_locator'; f.nodes.refresh.focus();
  const read = f.nodes.refresh.onclick(); assert.equal(f.nodes.refresh.disabled, true);
  await f.nodes.refresh.onclick(); await f.nodes.next.onclick(); assert.equal(f.calls.length, 3);
  const call = f.calls[2]; assert.equal(call.offset, 20); assert.equal(call.query, ''); assert.equal(call.status, '');
  wait.resolve(reply(call, { checkedAt: LATER })); await read;
  assert.equal(f.nodes.query.value, '未应用草稿'); assert.equal(f.nodes.filter.value, 'needs_locator');
  assert.match(f.nodes.status.textContent, /第 2 \/ 3 页/); assert.match(f.nodes.status.textContent, /新条件尚未应用/);
  assert.match(f.nodes.checkedAt.textContent, /18:55:00/); assert.equal(f.doc.activeElement, f.nodes.refresh);
  assert.ok(f.calls.every(call => call.options.method === undefined && call.options.body === undefined));
});

test('refresh failure preserves old rows, exact query time and page while explicitly reporting that they were not refreshed', async () => {
  let fail = false; const f = fixture(call => { if (fail) throw new Error('网络不可用'); return reply(call); });
  await f.controller.setJob(job); await f.nodes.next.onclick();
  const before = { rows: f.nodes.rows.innerHTML, time: f.nodes.checkedAt.textContent }; fail = true;
  f.nodes.refresh.focus(); await f.nodes.refresh.onclick();
  assert.equal(f.nodes.rows.innerHTML, before.rows); assert.equal(f.nodes.checkedAt.textContent, before.time);
  assert.match(f.nodes.status.textContent, /网络不可用/); assert.match(f.nodes.status.textContent, /当前核验结果及查询时间未刷新/);
  assert.match(f.nodes.status.textContent, /第 2 \/ 3 页，显示 21–40/); assert.equal(f.doc.activeElement, f.nodes.refresh);
});

test('a new search cancels a current refresh and its late evidence cannot overwrite the newer page or query time', async () => {
  const wait = defer(); const f = fixture((call, count) => count === 2 ? wait.promise : reply(call, { checkedAt: count === 3 ? LATER : TIME }));
  await f.controller.setJob(job); f.nodes.refresh.focus(); const old = f.nodes.refresh.onclick();
  f.nodes.query.value = 'ID44'; f.nodes.query.focus(); await f.nodes.form.onsubmit({ preventDefault() {} });
  const expected = { rows: f.nodes.rows.innerHTML, time: f.nodes.checkedAt.textContent };
  assert.equal(f.calls[1].options.signal.aborted, true); wait.resolve(reply(f.calls[1])); await old;
  assert.equal(f.nodes.rows.innerHTML, expected.rows); assert.equal(f.nodes.checkedAt.textContent, expected.time);
  assert.match(f.nodes.rows.innerHTML, /作者44/); assert.match(f.nodes.checkedAt.textContent, /本页 1 条/);
  assert.equal(f.doc.activeElement, f.nodes.query);
});

test('permission loss clears names and current evidence time; old pending responses cannot reintroduce them', async () => {
  const wait = defer(); const f = fixture((call, count) => count === 1 ? reply(call) : wait.promise);
  await f.controller.setJob(job); const read = f.nodes.refresh.onclick(); f.allowed = false;
  wait.resolve(reply(f.calls[1], { checkedAt: LATER })); await read;
  assert.equal(f.root.hidden, true); assert.equal(f.nodes.rows.innerHTML, ''); assert.equal(f.nodes.checkedAt.textContent, '');
  assert.equal(f.nodes.refresh.disabled, true); assert.equal(f.nodes.next.disabled, true);
});

test('switching jobs resets evidence time and stale refresh cannot restore previous job state', async () => {
  const wait = defer(); const f = fixture((call, count) => count === 2 ? wait.promise : reply(call, { checkedAt: count === 3 ? LATER : TIME }));
  await f.controller.setJob(job); const old = f.nodes.refresh.onclick();
  await f.controller.setJob({ ...job, id: OTHER }); const expected = f.nodes.checkedAt.textContent;
  wait.resolve(reply(f.calls[1])); await old;
  assert.equal(f.nodes.checkedAt.textContent, expected); assert.match(expected, /18:55:00/);
});

test('refresh does not steal focus after a deliberate pointer choice', async () => {
  const wait = defer(); const f = fixture((call, count) => count === 1 ? reply(call) : wait.promise);
  await f.controller.setJob(job); f.nodes.refresh.focus(); const read = f.nodes.refresh.onclick(); f.doc.emit('pointerdown', f.nodes.query);
  wait.resolve(reply(f.calls[1])); await read; assert.equal(f.doc.activeElement, f.doc.body);
});

test('empty historical filter results span all six columns and retain read-only current-page refresh', async () => {
  const f = fixture(); await f.controller.setJob(job); f.nodes.query.value = '完全无匹配'; await f.nodes.form.onsubmit({ preventDefault() {} });
  assert.match(f.nodes.rows.innerHTML, /colspan="6"/); assert.match(f.nodes.checkedAt.textContent, /本页 0 条/);
  assert.equal(f.nodes.refresh.disabled, false); assert.equal(f.nodes.previous.disabled, true); assert.equal(f.nodes.next.disabled, true);
});

test('HTML exposes separate historical and current headings, labelled historical filter, read timestamp and read-only refresh', () => {
  const html = readFileSync(new URL('../public/rebuild.html', import.meta.url), 'utf8');
  const section = html.slice(html.indexOf('<section id="importReviewList"'), html.indexOf('<details id="sourceImportHistory"'));
  assert.match(section, /历史未接入 \/ 审查原因/); assert.match(section, /<th scope="col">当前证据核验<\/th>/);
  assert.match(section, /data-review="checkedAt"/); assert.match(section, /data-review="refresh"[^>]*type="button"[^>]*disabled>刷新当前页状态/);
  assert.match(section, /aria-label="历史审查状态"/); assert.match(section, /搜索与筛选仅作用于历史记录/);
  assert.match(html, /<script type="module" src="\/import-review\.js\?v=[^"\s]+"><\/script>/);
});

test('review layout fits a laptop content pane with a fixed six-column layout, wrapped left-aligned text and small-screen scroll', () => {
  const css = readFileSync(new URL('../public/rebuild.css', import.meta.url), 'utf8');
  const tableRule = /\.import-review-scroll table\{([^}]+)\}/.exec(css)?.[1] || '';
  assert.match(tableRule, /min-width:880px/); assert.match(tableRule, /width:100%/); assert.match(tableRule, /table-layout:fixed/);
  const cells = /\.import-review-scroll \.table th,\.import-review-scroll \.table td\{([^}]+)\}/.exec(css)?.[1] || '';
  assert.match(cells, /text-align:left/); assert.match(cells, /white-space:normal/); assert.match(cells, /overflow-wrap:anywhere/);
  assert.ok(css.indexOf('.import-review-scroll .table th,') > css.indexOf('.table th:not(:first-child)'), 'local specificity and source order must override global numeric alignment');
  const widths = [...css.matchAll(/\.import-review-scroll \.table th:nth-child\((\d)\)\{width:(\d+)%\}/g)].map(match => [Number(match[1]), Number(match[2])]);
  assert.deepEqual(widths, [[1, 5], [2, 15], [3, 14], [4, 12], [5, 26], [6, 28]]);
  assert.equal(widths.reduce((sum, [, width]) => sum + width, 0), 100);
  const current = /\.import-review-scroll td\.import-review-resolution\{([^}]+)\}/.exec(css)?.[1] || '';
  assert.match(current, /min-width:0/); assert.doesNotMatch(current, /(?:min|max)-width:(?:235|320)px/);
  assert.match(css, /\.import-review-scroll\{[^}]*overflow:auto/);
});
