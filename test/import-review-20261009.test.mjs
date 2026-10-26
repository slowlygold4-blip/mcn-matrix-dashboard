import test from 'node:test';
import assert from 'node:assert/strict';
import { projectImportReview } from '../lib/import-review.mjs';
import { createImportReview } from '../public/import-review.js';
const ID = 'b8888888-8888-4888-8888-888888888888', OTHER = 'c9999999-9999-4999-9999-999999999999';
const rows = Array.from({ length: 45 }, (_, i) => ({ sourceRow: i + 2, name: `作者${i}`, platform: 'douyin', douyinId: `ID${i}`, board: '团团', status: i % 2 ? 'needs_locator' : 'unresolved', reason: i % 2 ? '缺少完整主页' : 'HTTP 403', sourceRecordId: `recRecord${i}` }));
const job = { id: ID, status: 'completed', finishedAt: '2026-10-09T00:00:00Z', result: { skipped: rows } };
test('review searches all historical items and paginates without mutating them', () => {
  const before = JSON.stringify(job);
  const page = projectImportReview(job, { offset: 20, limit: 20 });
  assert.equal(page.items[0].name, '作者20'); assert.equal(page.total, 45); assert.equal(page.originalTotal, 45);
  assert.equal(projectImportReview(job, { query: 'ｉｄ４４' }).items[0].name, '作者44');
  assert.equal(projectImportReview(job, { query: '403', status: 'needs_locator' }).total, 0);
  assert.equal(projectImportReview(job, { query: 'recRecord44' }).total, 1);
  assert.equal(projectImportReview(job, { status: 'unresolved' }).total, 23);
  assert.equal(JSON.stringify(job), before);
});
test('review invalid bounds stay finite, missing is not fabricated, and out of range falls back', () => {
  for (const value of ['Infinity', 'NaN', null, '', 'bad']) {
    const page = projectImportReview(job, { offset: value, limit: value }); assert.equal(page.offset, 0); assert.equal(page.limit, 20);
  }
  assert.equal(projectImportReview(job, { offset: 99999 }).offset, 40);
  assert.equal(projectImportReview(job, { query: 'x'.repeat(1000) }).query.length, 200);
  const empty = projectImportReview({ id: ID, result: { skipped: [null, [], ...rows] } });
  assert.equal(empty.originalTotal, 47); assert.equal(empty.validTotal, 45);
  assert.equal(projectImportReview({ id: ID }).total, 0);
});
function fixture(api) {
  const nodes = new Map(['rows', 'status', 'form', 'query', 'filter', 'previous', 'next'].map(key => [key, { innerHTML: '', textContent: '', value: '', disabled: false }]));
  const root = { hidden: true, attrs: {}, setAttribute(key, value) { this.attrs[key] = value; }, querySelector(selector) { return nodes.get(/"(\w+)"/.exec(selector)[1]); } };
  let allowed = true;
  return { root, nodes, access(value) { allowed = value; }, controller: createImportReview({ root, api, canRead: () => allowed }) };
}
test('review UI is GET-only, uses search/pagination and escapes stored content', async () => {
  const calls = [];
  const f = fixture(async (path, opts) => { calls.push([path, opts]); const u = new URL(path, 'http://fixture'); return projectImportReview(job, { offset: u.searchParams.get('offset'), query: u.searchParams.get('q'), status: u.searchParams.get('status') }); });
  await f.controller.setJob(job); assert.equal(f.root.hidden, false); assert.equal(calls.length, 1);
  await f.controller.load(20); assert.match(f.nodes.get('rows').innerHTML, /作者20/);
  f.nodes.get('query').value = 'ID44'; await f.controller.load(); assert.match(f.nodes.get('rows').innerHTML, /作者44/); assert.equal(f.nodes.get('next').disabled, true);
  assert.ok(calls.every(([, options]) => options.method === undefined && options.body === undefined));
  const x = fixture(async () => ({ ...projectImportReview(job), items: [{ name: '<img src=x onerror=alert(1)>', reason: '<script>bad</script>' }] }));
  await x.controller.setJob(job); assert.doesNotMatch(x.nodes.get('rows').innerHTML, /<img|<script/); assert.match(x.nodes.get('rows').innerHTML, /&lt;img/);
});
test('delayed old job and stale searches cannot overwrite a newer result', async () => {
  const pending = [];
  const f = fixture((path, options) => new Promise(resolve => pending.push({ path, options, resolve })));
  const first = f.controller.setJob(job), second = f.controller.setJob({ ...job, id: OTHER });
  assert.equal(pending[0].options.signal.aborted, true);
  pending[1].resolve(projectImportReview({ ...job, id: OTHER }, { query: 'ID44' })); await second;
  pending[0].resolve(projectImportReview(job)); await first;
  assert.match(f.nodes.get('rows').innerHTML, /作者44/); assert.doesNotMatch(f.nodes.get('rows').innerHTML, /作者0</);
});
test('same completed job preserves search without another request, permission loss clears names', async () => {
  let calls = 0; const f = fixture(async () => { calls++; return projectImportReview(job); });
  await f.controller.setJob(job); f.nodes.get('query').value = 'draft'; await f.controller.setJob(job);
  assert.equal(calls, 1); assert.equal(f.nodes.get('query').value, 'draft');
  f.access(false); await f.controller.load(); assert.equal(f.root.hidden, true); assert.equal(f.nodes.get('rows').innerHTML, '');
});
test('network failure keeps last page and offers read retry; forbidden clears', async () => {
  let error;
  const f = fixture(async () => { if (error) throw error; return projectImportReview(job); });
  await f.controller.setJob(job); const before = f.nodes.get('rows').innerHTML;
  error = new Error('offline'); await f.controller.load(20); assert.equal(f.nodes.get('rows').innerHTML, before); assert.match(f.nodes.get('status').textContent, /读取失败.*未提交/);
  error.status = 403; await f.controller.load(); assert.equal(f.root.hidden, true); assert.equal(f.nodes.get('rows').innerHTML, '');
});
