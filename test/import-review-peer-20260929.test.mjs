import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

const A = 'a1111111-1111-4111-8111-111111111111';
const B = 'b2222222-2222-4222-8222-222222222222';
const reply = data => ({ ok: true, status: 200, json: async () => data });
const file = name => ({ name, size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
const singlePreview = (sheet = '第一页') => ({ selectedSheet: sheet,
  rows: [{ sourceRow: 2, name: `${sheet}作者`, douyinId: 'offline-id', board: '', status: 'resolvable' }], summary: {}, boardCatalog: [] });
const batchPreview = (...sheets) => ({ uploadSha256: 'a'.repeat(64), totalAuthorRows: sheets.reduce((total, sheet) => total + sheet.rows.length, 0), maxBatchRows: 10000, boardCatalog: [],
  sheets: sheets.map(sheet => ({ name: sheet.selectedSheet, rowCount: sheet.rows.length, headerScore: 3, headerRow: 1, importable: true,
    summary: sheet.summary, sampleRows: sheet.rows.slice(0, 50), validationWarnings: [] })) });
const preview = (sheet = '第一页') => batchPreview(singlePreview(sheet));
const batchAccepted = (assignments, id = A) => ({ results: assignments.map(item => ({ sheetName: item.sheetName, status: 'accepted',
  job: { id, fileName: 'A.xlsx', sheetName: item.sheetName, status: 'queued' } })) });
const decode = text => text.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
function fixture() {
  const nodes = new Map(), calls = [];
  function node(id) {
    if (!nodes.has(id)) {
      let html = '', value = '';
      const element = { id, hidden: true, disabled: false, textContent: '', dataset: {}, files: [], options: null, writes: 0, children: [],
        contains(child) { return this.children.includes(child); },
        querySelector(selector) { return this.children.find(child => selector.includes(child.dataset.importJob)) ?? null; },
        querySelectorAll() { return this.children; },
        focus() { context.document.activeElement = this; },
        setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
        get value() { return value; }, set value(next) { value = this.options && !this.options.includes(String(next)) ? '' : String(next); },
        get innerHTML() { return html; }, set innerHTML(next) {
          html = String(next); this.writes++;
          if (id === 'importSessionJobList') {
            if (this.contains(context.document.activeElement)) context.document.activeElement = null;
            this.children = [...html.matchAll(/data-import-job="([^"]+)"/g)].map(match => ({ dataset: { importJob: decode(match[1]) },
              focus() { context.document.activeElement = this; } }));
          }
          if (id === 'importPreview') {
            for (const key of [...nodes.keys()]) if (/^(?:importBoard|importSheet|commitImport|cancelImport|importStatus|batchRetry|batch(?:Board|Include|Result)_\d+)$/.test(key)) nodes.delete(key);
            for (const match of html.matchAll(/<select\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
              const select = node(match[1]); select.options = [...match[2].matchAll(/<option\b[^>]*value="([^"]*)"/g)].map(option => decode(option[1]));
              select.value = select.options[0] ?? '';
            }
            for (const match of html.matchAll(/<input id="(batchInclude_\d+)"[^>]*>/g)) node(match[1]).checked = /\schecked(?:\s|>)/.test(match[0]);
          }
        } };
      nodes.set(id, element);
    }
    return nodes.get(id);
  }
  let serve = async () => reply(preview());
  // Match browser globals used by api() to enforce its idempotent GET deadline.
  const context = { ...model, fmt: model.formatNumber, URL, URLSearchParams, AbortController, Date, Intl, Uint8Array, setTimeout, clearTimeout,
    btoa: input => Buffer.from(input, 'binary').toString('base64'),
    document: { getElementById: node, querySelectorAll: () => [], querySelector: () => node('date-controls') }, window: {},
    location: { href: 'https://offline.test/#import' }, history: { replaceState(_s, _t, value) { context.location.href = String(value); } },
    fetch: (url, options = {}) => { calls.push({ url, options }); return serve(url, options); } };
  const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8').replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '');
  runInNewContext(`${source}\nthis.subject = { state, handleFile, openImportJob, loadImportJob, currentJob: () => currentImportJob };`, context);
  context.subject.state.session = { user: { role: 'admin' } }; context.subject.state.data = { boards: [] };
  return { ...context.subject, node, calls, nodes, location: context.location, active: () => context.document.activeElement, setFetch(fn) { serve = fn; },
    commits: () => calls.filter(call => call.url.endsWith('/auto-monitor-batch')),
    allMarkup: () => [...nodes.values()].map(el => el.innerHTML).join('\n') };
}
function delayedCommit(f) {
  let finish, assignments;
  f.setFetch(async (url, options) => {
    if (url.endsWith('/batch-preview')) return reply(preview());
    if (url.endsWith('/auto-monitor-batch')) { assignments = JSON.parse(options.body).assignments; return new Promise(resolve => { finish = resolve; }); }
    return reply({ id: url.split('/').at(-1), status: 'queued' });
  });
  return async () => { await new Promise(resolve => setImmediate(resolve)); assert.equal(typeof finish, 'function', 'batch submit reached its handler'); finish(reply(batchAccepted(assignments))); };
}
test('peer import: detached preview handler cannot submit after another file preview or cancellation', async () => {
  for (const next of ['replace', 'cancel']) {
    const f = fixture(); await f.handleFile(file('A.xlsx')); const old = f.node('commitImport').onclick;
    if (next === 'replace') await f.handleFile(file('B.xlsx')); else f.node('cancelImport').onclick();
    await old(); assert.equal(f.commits().length, 0);
  }
});
test('peer import: reentrant confirm invokes only one POST even before its response', async () => {
  const f = fixture(), finish = delayedCommit(f); await f.handleFile(file('A.xlsx'));
  const confirm = f.node('commitImport').onclick, first = confirm(), second = confirm();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.commits().length, 1); await finish(); await Promise.all([first, second]);
});
test('peer import: explicit task B selection wins over late accepted POST A, while A remains discoverable', async () => {
  const f = fixture(), finish = delayedCommit(f); await f.handleFile(file('A.xlsx'));
  const pending = f.node('commitImport').onclick(); await f.openImportJob(B);
  await finish(); await pending;
  assert.equal(f.currentJob().id, B); assert.equal(new URL(f.location.href).searchParams.get('importJob'), B);
  assert.ok(f.allMarkup().includes(A), 'accepted old task must keep a non-stealing read-only recovery entry');
});
test('peer import: canceling a submitting preview prevents late receipt takeover but retains accepted job entry', async () => {
  const f = fixture(), finish = delayedCommit(f); await f.handleFile(file('A.xlsx'));
  const pending = f.node('commitImport').onclick(); f.node('cancelImport').onclick(); await finish(); await pending;
  assert.equal(f.currentJob(), null); assert.equal(new URL(f.location.href).searchParams.has('importJob'), false);
  assert.ok(f.allMarkup().includes(A));
  assert.match(f.node('importSessionJobList').innerHTML, new RegExp(`data-import-job="${A}"`));
  await f.openImportJob(A);
  assert.equal(f.currentJob().id, A); assert.equal(f.commits().length, 1, 'recovering accepted task is GET-only');
});
test('peer import: preview strings including worksheet, board and source row are escaped', async () => {
  const f = fixture(), attack = '<img src=x onerror="alert(1)">';
  f.state.data.boards = [{ key: 'attack', name: attack }];
  f.setFetch(async () => reply(batchPreview({ ...singlePreview(), selectedSheet: attack,
    rows: [{ sourceRow: attack, name: attack, douyinId: attack, board: attack, status: attack, issues: [attack] }] })));
  await f.handleFile(file(`${attack}.xlsx`));
  assert.doesNotMatch(f.node('importPreview').innerHTML, /<img\b|<script\b/);
  assert.ok(f.node('importPreview').innerHTML.includes('&lt;img'));
});
test('peer import: name-only rows show unknown author identity instead of a guessed unique-author count', async () => {
  const f = fixture();
  f.setFetch(async () => reply(batchPreview({
    selectedSheet: '作者名单', sheets: [{ name: '作者名单', rowCount: 3, headerScore: 3 }],
    rows: [
      { sourceRow: 2, name: '同名作者', board: '板块甲', status: 'needs_locator' },
      { sourceRow: 3, name: '同名作者', board: '板块乙', status: 'needs_locator' },
    ],
    summary: { identityCountVersion: 2, knownUniqueAuthors: 0, uniqueAuthors: null, unresolvedIdentityRows: 2, autoMonitorAuthors: 0, existingRows: 0 },
    boardCatalog: [],
  })));

  await f.handleFile(file('同名作者.xlsx'));

  const markup = f.node('importPreview').innerHTML;
  assert.match(markup, /0 位主页\/平台账号 ID 线索/);
  assert.match(markup, /2 行身份待核验/);
  assert.match(markup, /昵称与作品不计为账号身份/);
  assert.doesNotMatch(markup, /[12] 位唯一作者/);

  const stale = fixture();
  stale.setFetch(async () => reply(batchPreview({
    selectedSheet: '旧服务名单', sheets: [{ name: '旧服务名单', rowCount: 3, headerScore: 3 }],
    rows: [
      { sourceRow: 2, name: '同名作者', board: '板块甲', status: 'needs_locator' },
      { sourceRow: 3, name: '同名作者', board: '板块乙', status: 'needs_locator' },
    ],
    summary: { uniqueAuthors: 1, autoMonitorAuthors: 0, existingRows: 0 },
    boardCatalog: [],
  })));
  await stale.handleFile(file('旧服务名单.xlsx'));
  assert.match(stale.node('importPreview').innerHTML, /旧版服务摘要/);
  assert.match(stale.node('importPreview').innerHTML, /0 位主页\/平台账号 ID 线索 · 2 行身份待核验/);
  assert.doesNotMatch(stale.node('importPreview').innerHTML, /1 位作者/);
});
test('peer import: stale author summary derives only explicit platform identity clues from rows', async () => {
  const f = fixture();
  f.setFetch(async () => reply(batchPreview({
    selectedSheet: '混合名单', sheets: [{ name: '混合名单', rowCount: 4, headerScore: 3 }],
    rows: [
      { sourceRow: 2, name: '抖音作者A', platform: 'douyin', locator: 'MS4wLjABAAAA1234567890abcd', status: 'ready' },
      { sourceRow: 3, name: '抖音作者B', platform: 'douyin', locator: 'MS4wLjABAAAA1234567890abcd', status: 'duplicate' },
      { sourceRow: 4, name: 'B站作者', platform: 'bilibili', bilibiliId: '123456', status: 'ready' },
      { sourceRow: 5, name: '仅昵称作者', platform: 'douyin', videoId: '1234567890123456789', status: 'needs_locator' },
    ],
    summary: { uniqueAuthors: 4, autoMonitorAuthors: 3, existingRows: 0 }, boardCatalog: [],
  })));
  await f.handleFile(file('混合名单.xlsx'));
  const markup = f.node('importPreview').innerHTML;
  assert.match(markup, /2 位主页\/平台账号 ID 线索 · 1 行身份待核验/);
  assert.match(markup, /昵称与作品不计为账号身份/);
  assert.doesNotMatch(markup, /4 位作者/);
});
test('peer import: per-sheet choices preserve manual board and explicit unassigned assignment, submitting only checked sheets', async () => {
  const f = fixture(), sourceFile = file('two-sheets.xlsx');
  f.state.board = '7jia'; f.state.data.boards = [{ key: '7jia', name: '7Jia' }, { key: 'manual', name: '手选<&>' }];
  f.setFetch(async (url, options) => url.endsWith('/batch-preview') ? reply(batchPreview(singlePreview('第一页'), singlePreview('第二页')))
    : url.endsWith('/auto-monitor-batch') ? reply(batchAccepted(JSON.parse(options.body).assignments)) : reply({ id: A, status: 'queued' }));
  await f.handleFile(sourceFile); assert.equal(f.node('batchBoard_0').value, '7Jia');
  assert.equal(f.node('batchBoard_1').value, '7Jia');
  f.node('batchBoard_0').value = '手选<&>';
  f.node('batchInclude_0').checked = false; f.node('batchInclude_0').onchange();
  assert.equal(f.node('batchBoard_0').value, '手选<&>');
  assert.ok(f.node('importPreview').innerHTML.includes('第二页作者'));
  f.node('batchBoard_0').value = '';
  f.node('batchInclude_0').checked = true; f.node('batchInclude_0').onchange();
  f.node('batchInclude_1').checked = false; f.node('batchInclude_1').onchange();
  assert.equal(f.node('batchBoard_0').value, '', 'explicit unassigned is not replaced by board filter default');
  await f.node('commitImport').onclick();
  const submitted = JSON.parse(f.commits()[0].options.body);
  assert.equal(submitted.assignments.length, 1); assert.equal(submitted.assignments[0].sheetName, '第一页'); assert.equal(submitted.assignments[0].defaultBoard, '');
  assert.equal(submitted.contentBase64, 'AQID'); assert.equal(submitted.uploadSha256, 'a'.repeat(64));
  assert.match(submitted.assignments[0].idempotencyKey, /^[0-9a-f-]{36}$/i);
});
test('peer import: late failed POST A cannot change fresh preview B controls or error message', async () => {
  const f = fixture(); let fail;
  f.setFetch(async (url, options) => url.endsWith('/batch-preview') ? reply(preview(JSON.parse(options.body).fileName))
    : new Promise((_resolve, reject) => { fail = reject; }));
  await f.handleFile(file('A.xlsx')); const pending = f.node('commitImport').onclick();
  await f.handleFile(file('B.xlsx'));
  const button = f.node('commitImport'), status = f.node('importStatus');
  const before = [button.disabled, button.textContent, status.textContent];
  await new Promise(resolve => setImmediate(resolve)); fail(new Error('offline late failure')); await pending;
  assert.deepEqual([button.disabled, button.textContent, status.textContent], before);
  assert.equal(f.currentJob(), null);
});
test('peer import: reselecting already current task also prevents pending POST receipt takeover', async () => {
  const f = fixture(), finish = delayedCommit(f); await f.openImportJob(B);
  await f.handleFile(file('A.xlsx')); const pending = f.node('commitImport').onclick();
  await f.openImportJob(B); await finish(); await pending;
  assert.equal(f.currentJob().id, B); assert.equal(new URL(f.location.href).searchParams.get('importJob'), B);
  assert.ok(f.node('importSessionJobList').innerHTML.includes(A));
});
test('peer import: permission revoked between preview and confirm prevents POST', async () => {
  const f = fixture(); await f.handleFile(file('A.xlsx')); f.state.session.user.role = 'viewer';
  await f.node('commitImport').onclick();
  assert.equal(f.commits().length, 0); assert.match(f.node('importStatus').textContent, /只读身份/);
});
test('peer import: unchanged automatic task read preserves focused session button without rebuilding it', async () => {
  const f = fixture(), finish = delayedCommit(f); await f.handleFile(file('A.xlsx'));
  const pending = f.node('commitImport').onclick(); await finish(); await pending; await f.loadImportJob();
  const list = f.node('importSessionJobList'), button = list.children[0]; button.focus();
  const writes = list.writes; await f.loadImportJob();
  assert.equal(list.writes, writes, 'unchanged task receipt must not rewrite innerHTML');
  assert.equal(f.active(), button);
});
test('peer import: changed task receipt restores only its own focused task, never steals an outside focus', async () => {
  const f = fixture(), finish = delayedCommit(f); await f.handleFile(file('A.xlsx'));
  const pending = f.node('commitImport').onclick(); await finish(); await pending; await f.loadImportJob();
  f.node('importSessionJobList').children[0].focus();
  f.setFetch(async () => reply({ id: A, status: 'completed' })); await f.loadImportJob();
  assert.equal(f.active()?.dataset.importJob, A);
  assert.match(f.node('importSessionJobList').innerHTML, /已完成/);
  const outside = f.node('fileInput'); outside.focus();
  f.setFetch(async () => reply({ id: A, status: 'failed' })); await f.loadImportJob();
  assert.equal(f.active(), outside);
});
