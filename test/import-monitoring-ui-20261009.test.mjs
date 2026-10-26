import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createImportMonitoring } from '../public/import-monitoring.js';

const JOB = 'c9895a58-14ef-4f1f-8c88-428fb3ce8d6f', OTHER = 'b1111111-1111-4111-8111-111111111111';
const CHECKED = '2026-10-09T18:00:00.000Z', LATER = '2026-10-09T18:30:00.000Z';
const completed = id => ({ id, status: 'completed' });
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function response(call, options = {}) {
  const unavailable = options.sourceAvailable === false;
  const full = Array.from({ length: 394 }, (_, index) => {
    const status = unavailable ? 'unknown' : index < 153 ? 'enabled' : 'pending';
    return { key: `douyin:submitted:${index}`, platform: 'douyin', submittedId: `ID${index}`, name: `作者${index}`,
      sourceRows: index < 48 ? 11 : 10, status, targetId: status === 'enabled' ? index + 1 : null,
      reason: status === 'enabled' ? '已关联当前启用账号' : '尚未取得可用定位', sampledAt: status === 'enabled' ? CHECKED : null,
      profileStatus: status === 'enabled' ? 'fresh' : 'not_enabled',
      ...(status === 'pending' ? { resolutionState: index === 153 ? 'retrying' : index === 154 ? 'evidence_exhausted' : 'evidence_missing' } : {}) };
  });
  const filtered = call.status === 'all' ? full : full.filter(item => item.status === call.status);
  const offset = Math.min(call.offset, filtered.length ? Math.floor((filtered.length - 1) / 20) * 20 : 0);
  const items = filtered.slice(offset, offset + 20);
  return { jobId: call.jobId, scope: 'current-import-account-monitoring', checkedAt: options.checkedAt || CHECKED,
    sourceAvailable: !unavailable, sourceReason: unavailable ? '本任务已被较新的同来源任务取代' : null, inputRows: 3988,
    matrixScope: { available: true, boardNames: ['一条小团团切片矩阵'], boardCount: 1,
      totalAccounts: 821, enabledAccounts: 772, pausedAccounts: 49,
      scope: 'current-union-of-submitted-board-account-memberships-not-this-job-only' },
    identitySummary: { knownDistinctSubmittedIdentityCount: 394, distinctAccountCount: 394, unknownIdentityItemCount: 0, ambiguousIdentityItemCount: 0 },
    counts: { submittedIdentities: 394, enabled: unavailable ? 0 : 153, paused: 0, pending: unavailable ? 0 : 241,
      conflict: 0, unknown: unavailable ? 394 : 0, freshProfiles: unavailable ? 0 : 153, staleProfiles: 0, missingProfiles: 0, invalidProfiles: 0 },
    resolutionCounts: unavailable
      ? { retrying: 0, evidence_exhausted: 0, evidence_missing: 0 }
      : { retrying: 1, evidence_exhausted: 1, evidence_missing: 239 },
    items, pagination: { offset, limit: 20, total: filtered.length, hasMore: offset + items.length < filtered.length }, notes: [] };
}
class Node {
  constructor(doc) { this.ownerDocument = doc; this.hidden = false; this.textContent = ''; this.innerHTML = ''; this.value = ''; this.attrs = {}; this._disabled = false; }
  get disabled() { return this._disabled; }
  set disabled(value) { this._disabled = value; if (value && this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  setAttribute(key, value) { this.attrs[key] = value; }
  contains(node) { return node === this; }
  focus() { this.ownerDocument.activeElement = this; this.ownerDocument.emit('focusin', this); }
}
function fixture(handler) {
  let allowed = true, visible = true, now = 0;
  const doc = { listeners: new Map(), hasFocus: () => true,
    addEventListener(key, fn) { const list = this.listeners.get(key) || []; list.push(fn); this.listeners.set(key, list); },
    removeEventListener(key, fn) { this.listeners.set(key, (this.listeners.get(key) || []).filter(item => item !== fn)); },
    emit(key, target) { for (const fn of this.listeners.get(key) || []) fn({ target }); } };
  doc.body = new Node(doc); doc.documentElement = new Node(doc); doc.activeElement = doc.body;
  const nodes = Object.fromEntries(['refresh', 'summary', 'checkedAt', 'form', 'filter', 'search', 'status', 'rows', 'previous', 'next'].map(key => [key, new Node(doc)]));
  const root = new Node(doc); root.querySelector = selector => nodes[/"([^"]+)"/.exec(selector)[1]];
  const calls = [];
  const controller = createImportMonitoring({ root, canRead: () => allowed, isVisible: () => visible, now: () => now,
    api: async (path, options) => {
      const url = new URL(path, 'https://fixture.test');
      const call = { path, options, jobId: url.pathname.split('/')[4], offset: Number(url.searchParams.get('offset')), status: url.searchParams.get('status') };
      calls.push(call); return handler ? handler(call, calls.length) : response(call);
    } });
  return { controller, root, nodes, doc, calls, set allowed(value) { allowed = value; }, set visible(value) { visible = value; }, advance(ms) { now += ms; } };
}

test('394 explicit submitted identities and 3988 source rows are separate from 153 enabled and 241 pending accounts', async () => {
  const f = fixture(); await f.controller.setJob(completed(JOB));
  assert.equal(f.root.hidden, false);
  assert.match(f.nodes.summary.innerHTML, /提交身份<\/dt><dd>394/);
  assert.match(f.nodes.summary.innerHTML, /启用监控<\/dt><dd>153/);
  assert.match(f.nodes.summary.innerHTML, /尚未接入<\/dt><dd>241/);
  assert.match(f.nodes.summary.innerHTML, /后台自动重试 1 个 · 现有证据已耗尽 1 个 · 缺少可核验证据 239 个/);
  assert.match(f.nodes.summary.innerHTML, /原始 3,988 行/);
  assert.match(f.nodes.summary.innerHTML, /本表 394 个去重提交账号：153 个已建档，241 个仍待处理/);
  assert.match(f.nodes.summary.innerHTML, /一条小团团切片矩阵.*当前共 <strong>821<\/strong> 个经营账号（772 启用 · 49 暂停）/);
  assert.match(f.nodes.summary.innerHTML, /全部已证实来源的当前去重并集，不是本任务新增数/);
  assert.match(f.nodes.summary.innerHTML, /不代表作品明细或全部采集完成/);
  assert.match(f.nodes.checkedAt.textContent, /2026\/10\/10 02:00:00/);
  assert.equal(f.calls[0].path, `/api/author-spreadsheet/jobs/${JOB}/monitoring?status=all&offset=0&limit=20`);
  assert.ok(f.calls.every(call => call.options.method === undefined && call.options.body === undefined));
});

test('verified ID correction shows original and corrected identity, not a second author or fabricated sample', async () => {
  const f = fixture(call => {
    const data = response(call); data.items[0].identityCorrection = {
      originalAccountId: 'ID0', correctedAccountId: 'correct_id', status: 'verified',
    }; return data;
  });
  await f.controller.setJob(completed(JOB));
  assert.match(f.nodes.rows.innerHTML, /原表 ID：ID0 → 已核验更正 ID：correct_id/);
  assert.match(f.nodes.rows.innerHTML, /原始表格记录保留/);
  assert.match(f.nodes.summary.innerHTML, /提交身份<\/dt><dd>394/);
});

test('pending correction is visibly unverified and safely escaped', async () => {
  const f = fixture(call => {
    const data = response(call); if (call.status === 'pending') data.items[0].identityCorrection = {
      originalAccountId: data.items[0].submittedId, correctedAccountId: 'new_id', status: 'pending',
    }; return data;
  });
  await f.controller.setJob(completed(JOB)); f.nodes.filter.value = 'pending';
  await f.nodes.form.onsubmit({ preventDefault() {} });
  assert.match(f.nodes.rows.innerHTML, /申请更正 ID：new_id/);
  assert.match(f.nodes.rows.innerHTML, /更正申请仍待核验，不代表已接入监控/);
  assert.doesNotMatch(f.nodes.rows.innerHTML, /已核验更正 ID/);
});

test('pending rows distinguish automatic retry from evidence actions', async () => {
  const f = fixture(call => {
    const data = response(call);
    if (call.status === 'pending') {
      data.items[0].rosterEntryKey = 'retry-entry';
      data.items[1].rosterEntryKey = 'exhausted-entry';
      data.items[2].rosterEntryKey = 'missing-entry';
    }
    return data;
  });
  await f.controller.setJob(completed(JOB)); f.nodes.filter.value = 'pending';
  await f.nodes.form.onsubmit({ preventDefault() {} });
  assert.match(f.nodes.rows.innerHTML, /后台正在按计划重试身份核验/);
  assert.match(f.nodes.rows.innerHTML, /现有作品证据已重试完毕，需补充有效证据/);
  assert.match(f.nodes.rows.innerHTML, /缺少可核验主页或作品证据，需补充资料/);
  assert.doesNotMatch(f.nodes.rows.innerHTML, /data-monitoring-supplement="douyin:submitted:153"/);
  assert.match(f.nodes.rows.innerHTML, /data-monitoring-supplement="douyin:submitted:154"/);
  assert.match(f.nodes.rows.innerHTML, /data-monitoring-supplement="douyin:submitted:155"/);
});

for (const correction of [
  { originalAccountId: 'other_original', correctedAccountId: 'new_id', status: 'verified' },
  { originalAccountId: 'ID0', correctedAccountId: 'new_id', status: 'pending' },
  { originalAccountId: 'ID0', correctedAccountId: 'id0', status: 'verified' },
  { originalAccountId: 'ID0', correctedAccountId: 'new_id', status: 'unchecked' },
]) test(`contradicting correction fails closed: ${JSON.stringify(correction)}`, async () => {
  const f = fixture(call => { const data = response(call); data.items[0].identityCorrection = correction; return data; });
  await f.controller.setJob(completed(JOB));
  assert.match(f.nodes.status.textContent, /逐账号接入记录无效/);
  assert.equal(f.nodes.rows.innerHTML, '');
});

test('repeated shell hints and same-job receipts coalesce and throttle automatic reads for 30 seconds', async () => {
  const wait = defer(); const f = fixture((call, count) => count === 1 ? wait.promise : response(call));
  const first = f.controller.setJob(completed(JOB)), hint = f.controller.hint();
  assert.equal(first, hint); assert.equal(f.calls.length, 1);
  wait.resolve(response(f.calls[0])); await first;
  await f.controller.setJob(completed(JOB)); await f.controller.hint(); assert.equal(f.calls.length, 1);
  f.advance(29_999); await f.controller.hint(); assert.equal(f.calls.length, 1);
  f.advance(1); await f.controller.hint(); assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.options.method === undefined));
});

test('manual refresh bypasses throttle once and preserves unapplied status draft plus applied page', async () => {
  const f = fixture(); await f.controller.setJob(completed(JOB)); await f.nodes.next.onclick();
  f.nodes.filter.value = 'pending'; f.nodes.refresh.focus(); await f.nodes.refresh.onclick();
  assert.equal(f.calls.at(-1).status, 'all'); assert.equal(f.calls.at(-1).offset, 20);
  assert.equal(f.nodes.filter.value, 'pending'); assert.match(f.nodes.status.textContent, /新状态尚未应用/);
  assert.equal(f.doc.activeElement, f.nodes.refresh);
  await f.nodes.form.onsubmit({ preventDefault() {} });
  assert.equal(f.calls.at(-1).status, 'pending'); assert.equal(f.calls.at(-1).offset, 0);
  assert.match(f.nodes.status.textContent, /尚未接入.*241 个提交身份/);
  assert.match(f.nodes.rows.innerHTML, /ID153/); assert.doesNotMatch(f.nodes.rows.innerHTML, /监控账号 #/);
});

test('a shrinking result safely returns the last available page without altering the current filter', async () => {
  let shrunk = false;
  const f = fixture(call => {
    const data = response(call);
    if (shrunk && call.status === 'pending') {
      data.counts.enabled = 155; data.counts.pending = 239; data.counts.freshProfiles = 155;
      data.resolutionCounts = { retrying: 1, evidence_exhausted: 1, evidence_missing: 237 };
      data.items = [response({ ...call, offset: 220 }).items[0]];
      data.pagination = { offset: 220, limit: 20, total: 239, hasMore: false };
      data.items = Array.from({ length: 19 }, (_, index) => ({ ...data.items[0], key: `pending-${index}`, submittedId: `ID${375 + index}` }));
    }
    return data;
  });
  await f.controller.setJob(completed(JOB)); f.nodes.filter.value = 'pending'; await f.nodes.form.onsubmit({ preventDefault() {} });
  for (let index = 0; index < 12; index++) await f.nodes.next.onclick();
  assert.equal(f.calls.at(-1).offset, 240);
  shrunk = true; await f.controller.refresh();
  assert.equal(f.nodes.filter.value, 'pending'); assert.match(f.nodes.status.textContent, /第 12 \/ 12 页.*239 个提交身份/);
  assert.equal(f.nodes.next.disabled, true);
});

test('queued, running and failed import jobs do not initiate current monitoring reads', async () => {
  const f = fixture();
  for (const status of ['queued', 'running', 'failed']) await f.controller.setJob({ id: JOB, status });
  assert.equal(f.calls.length, 0); assert.equal(f.root.hidden, true);
});

test('hidden import views and background tabs stay read-only and silent until visible', async () => {
  const f = fixture(); f.visible = false; await f.controller.setJob(completed(JOB)); await f.controller.hint(); await f.controller.refresh();
  assert.equal(f.calls.length, 0);
  f.visible = true; await f.controller.hint(); assert.equal(f.calls.length, 1);
  f.visible = false; f.advance(30_000); await f.controller.hint(); assert.equal(f.calls.length, 1);
});

test('leaving the view aborts an in-flight read and a late result cannot alter the retained current snapshot', async () => {
  const wait = defer(); const f = fixture((call, count) => count === 2 ? wait.promise : response(call));
  await f.controller.setJob(completed(JOB)); const previous = f.nodes.checkedAt.textContent;
  const pending = f.controller.refresh(); f.visible = false; await f.controller.hint();
  assert.equal(f.calls[1].options.signal.aborted, true);
  wait.resolve(response(f.calls[1], { checkedAt: LATER })); await pending;
  assert.equal(f.nodes.checkedAt.textContent, previous);
  f.visible = true; await f.controller.hint(); assert.equal(f.calls.length, 3);
});

test('switching jobs invalidates old responses and starts the selected task from its first page', async () => {
  const wait = defer(); const f = fixture((call, count) => count === 2 ? wait.promise : response(call, { checkedAt: count === 3 ? LATER : CHECKED }));
  await f.controller.setJob(completed(JOB)); const old = f.controller.refresh();
  await f.controller.setJob(completed(OTHER)); const currentTime = f.nodes.checkedAt.textContent;
  assert.equal(f.calls[1].options.signal.aborted, true); assert.equal(f.calls[2].jobId, OTHER); assert.equal(f.calls[2].offset, 0);
  wait.resolve(response(f.calls[1])); await old;
  assert.equal(f.nodes.checkedAt.textContent, currentTime); assert.match(currentTime, /02:30:00/);
});

test('role revocation clears previously visible data and drops late reads without more requests', async () => {
  const wait = defer(); const f = fixture((call, count) => count === 2 ? wait.promise : response(call));
  await f.controller.setJob(completed(JOB)); const pending = f.controller.refresh(); f.allowed = false;
  wait.resolve(response(f.calls[1])); await pending; await f.controller.hint();
  assert.equal(f.root.hidden, true); assert.equal(f.nodes.rows.innerHTML, ''); assert.equal(f.nodes.summary.innerHTML, '');
  assert.equal(f.nodes.checkedAt.textContent, ''); assert.equal(f.calls.length, 2);
});

for (const status of [401, 403]) test(`HTTP ${status} clears sensitive current data and pagination`, async () => {
  const f = fixture((call, count) => { if (count === 2) throw Object.assign(new Error('cannot read'), { status }); return response(call); });
  await f.controller.setJob(completed(JOB)); await f.controller.refresh();
  assert.equal(f.root.hidden, true); assert.equal(f.nodes.rows.innerHTML, ''); assert.equal(f.nodes.next.disabled, true);
});

test('network failure preserves exact prior data and timestamp while stating that it was not refreshed', async () => {
  const f = fixture((call, count) => { if (count === 2) throw new Error('temporary network failure'); return response(call); });
  await f.controller.setJob(completed(JOB));
  const before = { rows: f.nodes.rows.innerHTML, time: f.nodes.checkedAt.textContent, summary: f.nodes.summary.innerHTML };
  await f.controller.refresh();
  assert.equal(f.nodes.rows.innerHTML, before.rows); assert.equal(f.nodes.checkedAt.textContent, before.time); assert.equal(f.nodes.summary.innerHTML, before.summary);
  assert.match(f.nodes.status.textContent, /不能视为本次已更新/); assert.equal(f.nodes.refresh.disabled, false);
});

test('unavailable source projection shows unknown identities rather than false pending or enabled counts', async () => {
  const f = fixture(call => response(call, { sourceAvailable: false })); await f.controller.setJob(completed(JOB));
  assert.match(f.nodes.summary.innerHTML, /当前来源关联不可用.*较新的同来源任务取代/);
  assert.match(f.nodes.summary.innerHTML, /无法确认 394/); assert.match(f.nodes.summary.innerHTML, /尚未接入<\/dt><dd>0/);
  assert.match(f.nodes.rows.innerHTML, /无法确认/); assert.doesNotMatch(f.nodes.rows.innerHTML, /监控账号 #/);
});

for (const mutate of [
  data => { data.scope = 'historical-job-review-not-live-queue'; },
  data => { data.checkedAt = '2026-10-09'; },
  data => { data.counts.enabled = 394; },
  data => { data.counts.pending = '241'; },
  data => { data.resolutionCounts.evidence_missing = 238; },
  data => { data.matrixScope.enabledAccounts = 800; },
  data => { data.items[0].status = 'future'; },
  data => { data.items[0].targetId = null; },
]) test(`malformed current response is rejected without changing the last known snapshot: ${mutate}`, async () => {
  const f = fixture((call, count) => { const data = response(call); if (count === 2) mutate(data); return data; });
  await f.controller.setJob(completed(JOB)); const previous = f.nodes.rows.innerHTML;
  await f.controller.refresh(); assert.equal(f.nodes.rows.innerHTML, previous); assert.match(f.nodes.status.textContent, /读取失败/);
});

test('untrusted identity names and backend notes render only as escaped text', async () => {
  const f = fixture(call => { const data = response(call); data.items[0].name = '<img onerror="bad">'; data.items[0].reason = '<b>reason</b>'; data.notes = ['<script>bad</script>']; return data; });
  await f.controller.setJob(completed(JOB));
  assert.match(f.nodes.rows.innerHTML, /&lt;img/); assert.match(f.nodes.rows.innerHTML, /&lt;b&gt;reason/);
  assert.match(f.nodes.summary.innerHTML, /&lt;script&gt;/); assert.doesNotMatch(f.nodes.rows.innerHTML + f.nodes.summary.innerHTML, /<img|<script|<b>/);
});

test('clearing a session and disposing prevent stale requests from restoring previous task information', async () => {
  const wait = defer(); const f = fixture(() => wait.promise);
  const pending = f.controller.setJob(completed(JOB)); f.controller.clear(); f.controller.dispose();
  wait.resolve(response(f.calls[0])); await pending; await f.controller.setJob(completed(OTHER)); await f.controller.refresh();
  assert.equal(f.calls.length, 1); assert.equal(f.root.hidden, true); assert.equal(f.nodes.rows.innerHTML, '');
});

test('shell keeps historical review and current monitoring separate and module creates no polling timer or POST', () => {
  const html = readFileSync(new URL('../public/rebuild.html', import.meta.url), 'utf8');
  const shell = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8');
  const module = readFileSync(new URL('../public/import-monitoring.js', import.meta.url), 'utf8');
  assert.match(html, /id="importMonitoring"[^>]+hidden/); assert.match(html, /本任务当前监控接入/);
  assert.match(html, /id="importReviewList"/); assert.match(html, /历史未接入 \/ 审查原因/);
  assert.match(html, /src="\/import-monitoring\.js\?v=/);
  assert.match(shell, /state\.view = view;\s*syncImportMonitoring\(\)/);
  assert.match(shell, /isVisible: \(\) => state\.view === 'import' && !document\.hidden/);
  assert.doesNotMatch(module, /setInterval\(|setTimeout\(|method:\s*['"]POST|body:\s/);
});
