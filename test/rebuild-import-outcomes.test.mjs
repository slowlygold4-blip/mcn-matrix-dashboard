import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';
import { createLiveSync } from '../public/live-sync.js';

const js = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/rebuild.html', import.meta.url), 'utf8');
const JOB = 'b8888888-8888-4888-8888-888888888888';
const SECOND = 'c9999999-9999-4999-9999-999999999999';
function fixture() {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, textContent: '', innerHTML: '', hidden: true, disabled: false, attrs: {}, dataset: {},
      setAttribute(key, value) { this.attrs[key] = value; } });
    return nodes.get(id);
  };
  const calls = [];
  const context = { ...model, fmt: model.formatNumber, URL, URLSearchParams, AbortController, Intl, Date,
    setTimeout, clearTimeout,
    document: { getElementById: node, querySelectorAll: () => [], querySelector: () => node('date-controls') }, window: {}, location: { href: 'https://matrix.example.test/?board=tuantuan&sort=likes.delta&page=3#import' },
    history: { replaceState(_state, _unused, url) { context.location.href = String(url); } },
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ id: JOB, status: 'completed', result: {} }) }; } };
  runInNewContext(`${js.replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '')}
    this.subject = { state, importCount, importOutcomeMetrics, renderImportJob, showSubmittedImportJob, loadImportJob, openImportJob, renderSourceImportResults, loadMonitoringStatus, syncBlockedReason, automaticScopeKey, renderLiveStatus, setView, setLiveSync(value) { liveSync = value; } };`, context);
  return { ...context.subject, node, calls, document: context.document, location: context.location, setFetch(fn) { context.fetch = fn; } };
}

test('import counters reject missing, coerced and invalid values instead of filling zeros', () => {
  const f = fixture();
  for (const value of [undefined, null, '', '0', false, -1, NaN, Infinity, 1.5]) assert.equal(f.importCount(value), '—');
  assert.equal(f.importCount(0), '0'); assert.equal(f.importCount(48), '48');
});

test('completed job leads with source rows and all submitted identities, then labels the evidence queue as a subset', () => {
  const f = fixture();
  f.renderImportJob({ id: JOB, status: 'completed', fileName: '<名单>',
    inputAccountIdentitySummary: { inputItemCount: 3988, knownDistinctSubmittedIdentityCount: 388, unknownIdentityItemCount: 6 }, result: {
    createdCount: 0, reusedExistingCount: 48, queuedEvidenceRequestCount: 64, reviewRequiredCount: 66,
    submittedEvidenceRequestCount: 338, evidenceReusedEvidenceRequestCount: 274, alreadyResolvedEvidenceRequestCount: 3, verifiedExistingEvidenceRequestCount: 2,
    queuedAccountIdentitySummary: { knownDistinctSubmittedIdentityCount: 183, unknownIdentityItemCount: 2, ambiguousIdentityItemCount: 1, distinctAccountCount: null },
    resolution: { deferredEvidenceRequestCount: 338, fetchFailedEvidenceRequestCount: 0 },
  } });
  const body = f.node('importJobBody').innerHTML;
  assert.match(body, /本任务读取 3,988 行，识别 388 个明确提交账号身份/);
  assert.match(body, /另有 6 行缺少唯一身份或存在冲突/);
  assert.match(body, /证据请求、审查记录和来源行都是处理工作量，不是作者人数/);
  assert.match(body, /复用既有账号记录<\/dt><dd>48<small>行来源记录/);
  assert.match(body, /待核验证据<\/dt><dd>64<small>项证据请求/);
  assert.match(body, /证据队列覆盖身份：已知提交标识 183 个.*全部 388 个明确提交身份中的证据队列子集/);
  assert.match(body, /2 项缺少唯一身份，其中冲突 1 项；队列内可完整计数身份 —/);
  assert.match(body, /复用历史核验凭证 274 项/); assert.match(body, /历史凭证复用不是新采样/);
  assert.match(body, /已有成功请求 3 项，其中本次复核既有成功凭证 2 项/);
  assert.match(body, /复核也不更新原验证时间/);
  assert.match(body, /初阶段主动延后 338 项证据请求（未发起网络请求）/);
  assert.match(body, /返回抓取错误 0 项证据请求/);
  assert.match(body, /不是实时队列余额/); assert.match(body, /既有暂停账号不会因此开启/);
  assert.equal(f.node('importJobHeading').textContent, '任务处理完成');
});

test('legacy queuedAuthors and fetchFailedAuthors cannot become modern queue or network failure counts', () => {
  const f = fixture();
  f.renderImportJob({ id: JOB, status: 'completed', result: { queuedAuthors: 466, resolution: { fetchFailedAuthors: 466 } } });
  const body = f.node('importJobBody').innerHTML;
  assert.match(body, /未记录原始行与去重提交身份.*不能从证据请求数倒推作者人数/);
  assert.match(body, /待核验证据<\/dt><dd>—/);
  assert.match(body, /此历史任务未记录提交标识去重、证据状态和网络阶段统计，无法补算/);
  assert.doesNotMatch(body, /返回抓取错误 —|初阶段主动延后 —|送交处理 —/);
  assert.doesNotMatch(body, /本次复核既有成功凭证/);
  assert.doesNotMatch(body, /466/);
});

test('checking a submitted result uses only one deduplicated GET and leaves app scope and drafts untouched', async () => {
  const f = fixture(); f.state.board = '团团'; f.state.page = 3; f.state.sortKey = 'likes.delta';
  f.node('importPreview').innerHTML = 'draft';
  let resolve; const calls = [];
  f.setFetch((url, options) => { calls.push({ url, options }); return new Promise(done => { resolve = done; }); });
  f.showSubmittedImportJob({ id: JOB, status: 'queued' });
  const one = f.loadImportJob(), two = f.loadImportJob();
  assert.equal(one, two); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `/api/author-spreadsheet/jobs/${JOB}`);
  assert.equal(calls[0].options.method, undefined);
  resolve({ ok: true, json: async () => ({ id: JOB, status: 'completed', result: { createdCount: 2 } }) });
  await one;
  assert.equal(f.node('checkImportJob').disabled, false);
  assert.equal(f.state.board, '团团'); assert.equal(f.state.page, 3); assert.equal(f.state.sortKey, 'likes.delta');
  assert.equal(f.node('importPreview').innerHTML, 'draft');
});

test('failed result read preserves previous receipt and never triggers another submission', async () => {
  const f = fixture(); f.showSubmittedImportJob({ id: JOB, status: 'completed', result: { createdCount: 2 } });
  const oldBody = f.node('importJobBody').innerHTML;
  let calls = 0; f.setFetch(async () => { calls++; return { ok: false, status: 403, json: async () => ({ error: '不能查看此任务' }) }; });
  await f.loadImportJob();
  assert.equal(f.node('importJobBody').innerHTML, oldBody); assert.equal(calls, 1);
  assert.match(f.node('importJobReadStatus').textContent, /结果读取失败.*保留上次回执，不重新提交/);
  assert.equal(f.node('checkImportJob').disabled, false);
});

test('a delayed old receipt cannot replace the current submitted job', async () => {
  const f = fixture(); let resolve;
  f.setFetch(() => new Promise(done => { resolve = done; }));
  f.showSubmittedImportJob({ id: JOB, status: 'queued' }); const pending = f.loadImportJob();
  f.showSubmittedImportJob({ id: SECOND, status: 'running', fileName: '第二份' });
  resolve({ ok: true, json: async () => ({ id: JOB, status: 'completed', result: { createdCount: 999 } }) });
  await pending;
  assert.match(f.node('importJobMeta').textContent, /第二份/);
  assert.equal(f.node('importJobHeading').textContent, '后台处理中');
  assert.doesNotMatch(f.node('importJobBody').innerHTML, /999/);
});

test('source receipts remain global historical business summaries, not metadata success or live backlog', () => {
  const f = fixture();
  f.renderSourceImportResults({ sources: [{ title: '仅元数据', readMode: 'workbook-metadata' }] });
  assert.match(f.node('sourceImportResults').innerHTML, /未提供来源任务的业务结果/);
  f.renderSourceImportResults({ sources: [{ title: '<来源>', sourceJobSummary: { version: 1, jobStatus: 'completed', createdAccountCount: 0, reusedExistingRowCount: 48, queuedEvidenceRequestCount: null, reviewRequiredItemCount: 66 } }] });
  assert.match(f.node('sourceImportResults').innerHTML, /&lt;来源&gt;/);
  assert.match(f.node('sourceImportResults').innerHTML, /复用既有账号记录<\/dt><dd>48/);
  assert.match(f.node('sourceImportResults').innerHTML, /待核验证据<\/dt><dd>—/);
  assert.match(f.node('sourceImportFreshness').textContent, /不受当前板块筛选影响.*不是实时.*元数据检查不等于名单导入/);
  assert.match(html, /id="checkImportJob">检查处理结果/);
});

test('read-only receipt deep links preserve existing URL scope and cannot accept a malformed id', async () => {
  const f = fixture(); await f.openImportJob('not-a-job'); assert.equal(f.calls.length, 0);
  await f.openImportJob(JOB);
  const url = new URL(f.location.href);
  assert.equal(url.searchParams.get('importJob'), JOB); assert.equal(url.searchParams.get('board'), 'tuantuan');
  assert.equal(url.searchParams.get('sort'), 'likes.delta'); assert.equal(url.searchParams.get('page'), '3');
  assert.equal(url.hash, '#import');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.method, undefined);
});

test('background source receipt changes do not replace a focused source control', () => {
  const f = fixture(); const source = { sources: [{ title: '名单', sourceJobSummary: { version: 1, jobStatus: 'completed', createdAccountCount: 1 } }] };
  f.renderSourceImportResults(source); const before = f.node('sourceImportResults').innerHTML;
  f.node('sourceImportResults').contains = () => true;
  source.sources[0].sourceJobSummary.createdAccountCount = 2;
  f.renderSourceImportResults(source); assert.equal(f.node('sourceImportResults').innerHTML, before);
  f.node('sourceImportResults').contains = () => false;
  f.renderSourceImportResults(source); assert.notEqual(f.node('sourceImportResults').innerHTML, before);
});

test('read-only import receipt view never asks the user to cancel a nonexistent draft', () => {
  const f = fixture(); f.state.view = 'import'; f.node('importPreview').hidden = true; f.node('fileInput').files = [];
  assert.equal(f.syncBlockedReason(), '正在查看导入页，返回看板后同步');
  f.showSubmittedImportJob({ id: JOB, status: 'completed', result: {} });
  assert.equal(f.syncBlockedReason(), '正在查看导入结果，返回看板后同步');
  f.node('importPreview').hidden = false;
  assert.equal(f.syncBlockedReason(), '保留导入草稿，完成或取消后同步');
});

test('ordinary status checks observe only pending jobs on the visible import page without another POST', async () => {
  const f = fixture(); const calls = [];
  f.state.view = 'import'; f.document.hidden = false;
  f.setFetch(async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => url.includes('/jobs/')
    ? { id: JOB, status: 'queued' } : { scheduler: {}, sourcePoller: { sources: [] } } }; });
  f.showSubmittedImportJob({ id: JOB, status: 'queued' });
  await f.loadMonitoringStatus(); await new Promise(setImmediate);
  assert.equal(calls.filter(call => call.url.includes('/jobs/')).length, 1);
  f.state.view = 'overview'; await f.loadMonitoringStatus();
  f.state.view = 'import'; f.document.hidden = true; await f.loadMonitoringStatus();
  f.document.hidden = false; f.showSubmittedImportJob({ id: JOB, status: 'completed', result: {} }); await f.loadMonitoringStatus();
  assert.equal(calls.filter(call => call.url.includes('/jobs/')).length, 1);
  assert.ok(calls.every(call => !call.options.method));
});

test('actual view navigation clears an obsolete import pending banner immediately without claiming data was updated', async () => {
  const f = fixture(); f.state.view = 'import'; f.node('importPreview').hidden = true; f.node('fileInput').files = [];
  f.showSubmittedImportJob({ id: JOB, status: 'completed', result: {} });
  let applied = 0;
  const sync = createLiveSync({ context: () => ({ scopeKey: f.automaticScopeKey(), blocked: f.syncBlockedReason(), visible: true, online: true }),
    readStatus: async () => ({}), readData: async () => ({}), applyData: () => { applied++; }, notify: f.renderLiveStatus });
  f.setLiveSync(sync); await sync.tick({ force: true });
  assert.match(f.node('liveSyncMessage').textContent, /正在查看导入结果，返回看板后同步/);
  assert.equal(f.node('applyLiveUpdate').hidden, false);
  f.setView('overview');
  assert.equal(sync.snapshot().pending, false); assert.equal(applied, 0);
  assert.equal(f.node('applyLiveUpdate').hidden, true);
  assert.equal(f.node('liveSyncMessage').textContent, '自动同步已开启 · 可见时每 30 秒检查');
  assert.doesNotMatch(f.node('liveSyncMessage').textContent, /返回看板|已同步新快照|已核对更新/);
});
