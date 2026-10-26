import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ExcelJS from 'exceljs';
import * as model from '../public/console-model.js';
import { parseAuthorSpreadsheet } from '../lib/author-spreadsheet.mjs';
import { prepareAuthorBoardImport } from '../lib/author-board-import.mjs';
import { classifyAuthor } from '../lib/author-classification.mjs';

const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8');
const JOB_A = 'a1111111-1111-4111-8111-111111111111';
const JOB_B = 'b2222222-2222-4222-8222-222222222222';
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const preview = (name = '作者') => ({ selectedSheet: '作者名单', uploadSha256: 'a'.repeat(64), sheets: [{ name: '作者名单', rowCount: 2, headerScore: 3 }],
  rows: [{ sourceRow: 2, name, douyinId: 'submitted-name', board: '', boards: [], status: 'resolvable' }], summary: {}, boardCatalog: [] });
const batchPreview = (sheets = ['团团切片', '杨齐家原创'], uploadSha256 = 'b'.repeat(64)) => ({
  uploadSha256, totalAuthorRows: sheets.length, maxBatchRows: 10000, boardCatalog: [],
  sheets: sheets.map((name, index) => ({ name, rowCount: 1, worksheetRows: 2, headerScore: 3, importable: true, issue: '', headerRow: 1,
    summary: {}, sampleRows: [{ sourceRow: 2, name: `作者${index + 1}`, douyinId: `account-${index + 1}`, board: '', status: 'resolvable', reason: '' }] })),
});
const file = name => ({ name, size: 8, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });

function fixture() {
  const nodes = new Map(), calls = [];
  const sessionValues = new Map();
  const focusListeners = new Set();
  const document = { activeElement: null, addEventListener(type, fn) { if (type === 'focusin') focusListeners.add(fn); }, removeEventListener(type, fn) { if (type === 'focusin') focusListeners.delete(fn); } };
  const node = id => {
    if (!nodes.has(id)) {
      let html = '', value = '';
      const item = { id, hidden: true, disabled: false, textContent: '', attrs: {}, dataset: {}, options: null,
        focus() { document.activeElement = this; for (const fn of focusListeners) fn(); },
        setAttribute(k, v) { this.attrs[k] = v; },
        get value() { return value; },
        set value(next) { value = this.options && !this.options.includes(String(next)) ? '' : String(next); },
        get innerHTML() { return html; },
        set innerHTML(next) {
          html = next;
          if (id === 'importPreview') {
            // Replacing preview creates fresh controls, as a real DOM does.
            if (['importBoard', 'importSheet', 'commitImport', 'cancelImport'].includes(document.activeElement?.id)) document.activeElement = document.body;
            for (const key of [...nodes.keys()]) if (/^(?:importBoard|importSheet|commitImport|cancelImport|importStatus|batchRetry|recentImportStatus|batch(?:Board|Include|Result)_\d+)$/.test(key)) nodes.delete(key);
            for (const select of next.matchAll(/<select id="((?:importBoard|importSheet|batchBoard_\d+))"[^>]*>([\s\S]*?)<\/select>/g)) {
              const control = node(select[1]);
              control.options = [...select[2].matchAll(/<option value="([^"]*)"/g)].map(match => match[1]);
            }
            for (const input of next.matchAll(/<input id="(batchInclude_\d+)"[^>]*>/g)) node(input[1]).checked = /\schecked(?:\s|>)/.test(input[0]);
          }
        } };
      nodes.set(id, item);
    }
    return nodes.get(id);
  };
  Object.assign(document, { body: node('body'), getElementById: node, querySelectorAll: () => [], querySelector: () => node('date-controls') });
  document.activeElement = document.body;
  const context = { ...model, fmt: model.formatNumber, URL, URLSearchParams, AbortController, Intl, Date, Uint8Array, setTimeout, clearTimeout,
    btoa: binary => Buffer.from(binary, 'binary').toString('base64'),
    document, window: {}, sessionStorage: { getItem(key) { return sessionValues.get(key) ?? null; }, setItem(key, value) { sessionValues.set(key, String(value)); } },
    location: { href: 'https://example.test/?theme=tuantuan#import' },
    history: { replaceState(_state, _unused, url) { context.location.href = String(url); } },
    fetch: async (url, options) => { calls.push({ url, options }); return response(preview()); } };
  runInNewContext(`${source.replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '')}
    this.subject = { state, handleFile, openImportJob, currentJob: () => currentImportJob, importResultCommitted: () => importResultCommitted };`, context);
  context.subject.state.session = { user: { role: 'admin' } };
  context.subject.state.data = { boards: [] };
  return { ...context.subject, node, calls, document, location: context.location, sessionValues, setFetch(fn) { context.fetch = (url, options) => { calls.push({ url, options }); return fn(url, options); }; } };
}

test('review: one batch preview parses every author sheet and exposes per-sheet samples before submit', async () => {
  const workbook = new ExcelJS.Workbook();
  for (const [name, author, locator] of [['团团切片名单', '作者甲', 'MS4wLjABAAAAabcdefghijklmnopqrstuvwx'], ['杨齐家原创名单', '作者乙', 'MS4wLjABBBBBzyxwvutsrqponmlkjihgfedcba']]) {
    const sheet = workbook.addWorksheet(name); sheet.addRow(['作者名称', 'sec_uid']); sheet.addRow([author, locator]);
  }
  const parsed = await parseAuthorSpreadsheet({ buffer: Buffer.from(await workbook.xlsx.writeBuffer()), fileName: '全部作者.xlsx', includeAllSheets: true });
  assert.equal(parsed.sheets.length, 2); assert.equal(parsed.rows.length, 1, 'legacy single-sheet parser output remains stable');
  assert.equal(parsed.sheetPreviews.length, 2); assert.deepEqual(parsed.sheetPreviews.map(sheet => sheet.rows.length), [1, 1]);
  const f = fixture(); f.setFetch(async () => response(batchPreview(['团团切片名单', '杨齐家原创名单']))); await f.handleFile(file('全部作者.xlsx'));
  const markup = f.node('importPreview').innerHTML;
  assert.match(markup, /逐表核对后可统一提交/);
  assert.ok(markup.includes('团团切片名单')); assert.ok(markup.includes('杨齐家原创名单'));
  assert.equal(f.calls.filter(call => call.url.endsWith('/batch-preview')).length, 1);
});

test('review: default board resolves its normalized key back to the displayed board name', async () => {
  const f = fixture(); f.state.board = '7jia原创矩阵'; f.state.data.boards = [{ key: '7jia原创矩阵', name: '7Jia原创矩阵' }];
  await f.handleFile(file('名单.csv'));
  assert.equal(f.node('importBoard').value, '7Jia原创矩阵', 'a real select rejects lowercase key when options use case-preserved names');
});

test('review: failed preview can retry the same file or cancel and choose another', async () => {
  const f = fixture(); let attempts = 0;
  f.setFetch(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary network error');
    return response(preview());
  });
  const sameFile = file('名单.csv');
  await f.handleFile(sameFile);
  assert.match(f.node('importPreview').innerHTML, /重试读取此文件/);
  assert.match(f.node('importPreview').innerHTML, /取消，改选文件/);
  await f.node('retryImportPreview').onclick();
  assert.equal(attempts, 2);
  assert.match(f.node('importPreview').innerHTML, /当前工作表/);
  f.node('cancelImport').onclick();
  assert.equal(f.node('importPreview').hidden, true);
  assert.equal(f.node('fileInput').value, '');
});

test('review: a late submission A cannot replace newer submitted job B or its recovery URL', async () => {
  const f = fixture(); let finishA;
  f.setFetch((url, options) => {
    if (url.endsWith('/preview')) return Promise.resolve(response(preview(JSON.parse(options.body).fileName)));
    if (url.endsWith('/auto-monitor')) {
      const name = JSON.parse(options.body).fileName;
      return name === 'A.csv' ? new Promise(resolve => { finishA = resolve; })
        : Promise.resolve(response({ id: JOB_B, fileName: 'B.csv', status: 'queued' }, 202));
    }
    return Promise.resolve(response({ id: url.split('/').at(-1), status: 'queued' }));
  });
  await f.handleFile(file('A.csv')); const pendingA = f.node('commitImport').onclick();
  await f.handleFile(file('B.csv')); await f.node('commitImport').onclick();
  assert.equal(f.currentJob().id, JOB_B);
  finishA(response({ id: JOB_A, fileName: 'A.csv', status: 'queued' }, 202)); await pendingA;
  assert.equal(f.currentJob().id, JOB_B, 'old POST acceptance must not steal the current receipt');
  assert.equal(new URL(f.location.href).searchParams.get('importJob'), JOB_B);
});

test('review baseline: source evidence determines theme and explicit content labels survive board fallback', async () => {
  const parsed = await parseAuthorSpreadsheet({ buffer: Buffer.from('作者名称,抖音号,内容赛道,板块\n作者甲,user-a,原创,杨齐家矩阵\n作者乙,user-b,AI二创,\n'), fileName: '团团名单.csv' });
  const prepared = prepareAuthorBoardImport(parsed.rows, { defaultBoard: '团团矩阵' });
  const classes = prepared.rows.map(row => classifyAuthor({ ...row, metadata: { importSource: { fileName: '团团名单.csv', sheetName: parsed.selectedSheet } } }));
  assert.equal(classes[0].theme.key, 'yangqijia', 'explicit ownership wins over the mixed file title');
  assert.equal(classes[1].theme.key, 'tuantuan');
  assert.ok(classes[0].labels.some(label => label.key === 'original'));
  assert.ok(classes[1].labels.some(label => label.key === 'ai-remix'));
});

test('review baseline: read-only upload is blocked before preview and closing preview never submits', async () => {
  const f = fixture(); f.state.session.user.role = 'viewer'; await f.handleFile(file('名单.csv'));
  assert.equal(f.calls.length, 0); assert.match(f.node('notice').textContent, /只读身份/);
  f.state.session.user.role = 'editor'; await f.handleFile(file('名单.csv'));
  f.node('cancelImport').onclick();
  assert.equal(f.node('importPreview').hidden, true); assert.equal(f.node('fileInput').value, '');
  assert.equal(f.calls.filter(call => call.url.endsWith('/auto-monitor')).length, 0);
});

test('review baseline: empty file parsing and permission denial cannot be shown as a submitted job', async () => {
  await assert.rejects(parseAuthorSpreadsheet({ buffer: Buffer.alloc(0), fileName: 'empty.csv' }), /上传文件为空/);
  const f = fixture(); f.setFetch(async () => response({ error: '权限已撤销' }, 403));
  await f.handleFile(file('名单.csv'));
  assert.match(f.node('importPreview').innerHTML, /权限已撤销/); assert.equal(f.currentJob(), null);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, '/api/author-spreadsheet/preview');
});

for (const humanBoard of ['团团矩阵', '']) test(`batch review preserves explicit ${humanBoard || 'unassigned'} choice and submits only checked sheets`, async () => {
  const f = fixture(); f.state.board = '7jia原创矩阵';
  f.state.data.boards = [{ key: '7jia原创矩阵', name: '7Jia原创矩阵' }, { key: '团团矩阵', name: '团团矩阵' }];
  const sheets = [{ name: '团团切片', headerScore: 3 }, { name: '杨齐家原创', headerScore: 3 }];
  f.setFetch(async (url, options) => {
    if (url.endsWith('/batch-preview')) return response(batchPreview(sheets.map(sheet => sheet.name), 'c'.repeat(64)));
    if (url.endsWith('/auto-monitor-batch')) {
      const assignments = JSON.parse(options.body).assignments;
      return response({ results: assignments.map(item => ({ sheetName: item.sheetName, status: 'accepted', job: { id: JOB_B, fileName: '全部作者.xlsx', sheetName: item.sheetName, status: 'queued' } })) });
    }
    return response({ id: JOB_B, status: 'queued' });
  });
  await f.handleFile(file('全部作者.xlsx'));
  f.node('batchInclude_0').checked = false;
  f.node('batchBoard_1').value = humanBoard;
  assert.equal(f.node('batchBoard_1').value, humanBoard);
  await f.node('commitImport').onclick();
  const call = f.calls.find(call => call.url.endsWith('/auto-monitor-batch'));
  assert.ok(call); const submitted = JSON.parse(call.options.body);
  assert.equal(submitted.assignments.length, 1); assert.equal(submitted.assignments[0].sheetName, sheets[1].name);
  assert.equal(submitted.assignments[0].defaultBoard, humanBoard);
  assert.match(submitted.assignments[0].idempotencyKey, /^[0-9a-f-]{36}$/i);
  assert.equal(submitted.uploadSha256, 'c'.repeat(64));
});

test('batch review submits each checked worksheet as a separate job', async () => {
  const f = fixture(); let posts = 0;
  const sheets = ['团团切片', '杨齐家原创'];
  f.setFetch(async (url, options) => {
    if (url.endsWith('/batch-preview')) return response(batchPreview(sheets, 'd'.repeat(64)));
    if (url.endsWith('/auto-monitor-batch')) {
      posts++;
      const assignments = JSON.parse(options.body).assignments;
      return response({ results: assignments.map((item, index) => ({ sheetName: item.sheetName, status: 'accepted', job: { id: index ? JOB_B : JOB_A, fileName: '全部作者.xlsx', sheetName: item.sheetName, status: 'queued' } })) });
    }
    return response({ id: JOB_B, status: 'queued' });
  });
  await f.handleFile(file('全部作者.xlsx'));
  await f.node('commitImport').onclick();
  assert.equal(posts, 1);
  assert.match(f.node('importStatus').textContent, /2 张新建任务/);
  assert.match(f.node('importSessionJobList').innerHTML, new RegExp(JOB_A));
  assert.match(f.node('importSessionJobList').innerHTML, new RegExp(JOB_B));
  assert.equal(f.node('batchInclude_0').disabled, true);
  assert.equal(f.node('batchInclude_1').disabled, true);
});

test('late accepted workbook batch stays in task list without changing a newer preview', async () => {
  const f = fixture(); let finishA;
  f.setFetch((url, options) => {
    if (url.endsWith('/batch-preview')) {
      const fileName = JSON.parse(options.body).fileName;
      return Promise.resolve(response(batchPreview(['作者名单'], fileName === 'A.xlsx' ? 'a'.repeat(64) : 'b'.repeat(64))));
    }
    if (url.endsWith('/auto-monitor-batch')) return new Promise(resolve => { finishA = resolve; });
    return Promise.resolve(response({ id: url.split('/').at(-1), status: 'queued' }));
  });

  await f.handleFile(file('A.xlsx'));
  const pendingA = f.node('commitImport').onclick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof finishA, 'function', 'A batch request is pending');
  f.node('cancelImport').onclick();

  await f.handleFile(file('B.xlsx'));
  f.node('fileInput').value = 'B.xlsx';
  f.node('batchResult_0').textContent = '待提交';
  const previewB = f.node('importPreview').innerHTML;
  const statusB = f.node('importStatus').textContent;
  assert.match(previewB, /B\.xlsx/);

  finishA(response({ results: [{ sheetName: '作者名单', status: 'accepted', job: { id: JOB_A, fileName: 'A.xlsx', sheetName: '作者名单', status: 'queued' } }] }));
  await pendingA;

  assert.match(f.node('importPreview').innerHTML, /B\.xlsx/, 'new preview remains visible');
  assert.equal(f.node('importStatus').textContent, statusB, 'old receipt does not replace B status');
  assert.equal(f.node('batchResult_0').textContent, '待提交', 'old receipt does not rewrite B row status');
  assert.equal(f.node('batchInclude_0').disabled, false, 'old receipt does not lock B checkbox');
  assert.equal(f.node('fileInput').value, 'B.xlsx', 'old receipt does not clear B selection');
  assert.equal(f.importResultCommitted(), false, 'old receipt does not mark B preview committed');
  assert.equal(f.currentJob(), null, 'old receipt does not take over the active task');
  assert.equal(new URL(f.location.href).searchParams.has('importJob'), false, 'old receipt does not replace the recovery URL');
  assert.match(f.node('importSessionJobList').innerHTML, new RegExp(`data-import-job="${JOB_A}"`), 'accepted A task remains reachable');
});

test('batch acceptance without a valid task id stays locked for idempotent reconciliation', async () => {
  const f = fixture(); let posts = 0, firstAssignments;
  f.setFetch(async (url, options) => {
    if (url.endsWith('/batch-preview')) return response(batchPreview(['作者名单'], 'f'.repeat(64)));
    if (url.endsWith('/auto-monitor-batch')) {
      posts++;
      const payload = JSON.parse(options.body);
      if (posts === 1) {
        firstAssignments = payload.assignments;
        return response({ results: [{ sheetName: '作者名单', status: 'accepted' }] }, 202);
      }
      assert.deepEqual(payload.assignments, firstAssignments, 'safe reconciliation reuses the original idempotency key');
      return response({ results: [{ sheetName: '作者名单', status: 'replayed', job: { id: JOB_A, fileName: 'A.xlsx', sheetName: '作者名单', status: 'queued' } }] });
    }
    return response({ id: JOB_A, status: 'queued' });
  });

  await f.handleFile(file('A.xlsx'));
  await f.node('commitImport').onclick();
  assert.equal(posts, 1);
  assert.equal(f.node('batchRetry').hidden, false, 'malformed acceptance must offer reconciliation, not another fresh submission');
  assert.equal(f.node('batchInclude_0').disabled, true, 'uncertain result locks the row');
  assert.match(f.node('importStatus').textContent, /暂时无法确认/);
  assert.equal(f.importResultCommitted(), false);

  await f.node('batchRetry').onclick();
  assert.equal(posts, 2);
  assert.match(f.node('importStatus').textContent, /1 张复用已有任务/);
  assert.match(f.node('importSessionJobList').innerHTML, new RegExp(`data-import-job="${JOB_A}"`));
});

test('uncertain batch submission locks edits and safe retry reuses every worksheet idempotency key', async () => {
  const f = fixture(); let posts = 0, firstAssignments = null;
  const sheets = ['团团切片', '杨齐家原创'];
  f.setFetch(async (url, options) => {
    if (url.endsWith('/batch-preview')) return response(batchPreview(sheets, 'e'.repeat(64)));
    if (url.endsWith('/auto-monitor-batch')) {
      posts++;
      const payload = JSON.parse(options.body);
      if (posts === 1) { firstAssignments = payload.assignments; throw new TypeError('connection reset after server accepted'); }
      assert.deepEqual(payload.assignments, firstAssignments);
      return response({ results: payload.assignments.map((item, index) => ({ sheetName: item.sheetName, status: 'replayed', job: { id: index ? JOB_B : JOB_A, fileName: '全部作者.xlsx', sheetName: item.sheetName, status: 'queued' } })) });
    }
    return response({ id: JOB_B, status: 'queued' });
  });
  await f.handleFile(file('全部作者.xlsx'));
  await f.node('commitImport').onclick();
  assert.equal(posts, 1); assert.equal(f.node('commitImport').disabled, true);
  assert.equal(f.node('batchRetry').hidden, false);
  assert.equal(f.node('batchInclude_0').disabled, true);
  await f.node('batchRetry').onclick();
  assert.equal(posts, 2);
  assert.match(f.node('importStatus').textContent, /2 张复用已有任务/);
  assert.ok(firstAssignments.every(assignment => /^[0-9a-f-]{36}$/i.test(assignment.idempotencyKey)));
});

test('late accepted old submission stays reachable without another POST when explicitly selected', async () => {
  const f = fixture(); let finishA;
  f.setFetch((url, options) => {
    if (url.endsWith('/preview')) return Promise.resolve(response(preview()));
    if (url.endsWith('/auto-monitor')) return new Promise(resolve => { finishA = resolve; });
    return Promise.resolve(response({ id: url.split('/').at(-1), status: 'queued' }));
  });
  await f.handleFile(file('A.csv')); const pending = f.node('commitImport').onclick();
  f.node('cancelImport').onclick(); finishA(response({ id: JOB_A, status: 'queued' }, 202)); await pending;
  assert.equal(f.currentJob(), null);
  assert.match(f.node('importSessionJobList').innerHTML, new RegExp(`data-import-job="${JOB_A}"`));
  assert.equal(f.node('importSessionJobs').hidden, false);
  const posts = f.calls.filter(call => call.url.endsWith('/auto-monitor')).length;
  await f.openImportJob(JOB_A);
  assert.equal(f.currentJob().id, JOB_A);
  assert.equal(new URL(f.location.href).searchParams.get('importJob'), JOB_A);
  assert.equal(f.calls.filter(call => call.url.endsWith('/auto-monitor')).length, posts);
});

test('rejected submission is retryable but pending and accepted duplicate clicks never send another POST', async () => {
  const f = fixture(); let attempts = 0, finish;
  f.setFetch((url) => {
    if (url.endsWith('/preview')) return Promise.resolve(response(preview()));
    if (url.endsWith('/auto-monitor')) {
      attempts++;
      return attempts === 1 ? Promise.resolve(response({ error: '权限暂不可用' }, 403)) : new Promise(resolve => { finish = resolve; });
    }
    return Promise.resolve(response({ id: JOB_A, status: 'queued' }));
  });
  await f.handleFile(file('A.csv'));
  const click = f.node('commitImport').onclick;
  await click(); assert.equal(attempts, 1); assert.equal(f.node('commitImport').disabled, false);
  assert.match(f.node('importStatus').textContent, /服务器明确拒绝/); assert.equal(f.currentJob(), null);
  const pending = click(); await click(); assert.equal(attempts, 2);
  finish(response({ id: JOB_A, status: 'queued' }, 202)); await pending; await click();
  assert.equal(attempts, 2); assert.equal(f.node('commitImport').disabled, true);
  assert.equal(f.currentJob().id, JOB_A);
});

test('network, server, and malformed acceptance outcomes lock the current preview instead of offering a duplicate retry', async () => {
  const cases = [
    ['network loss', async () => { throw new TypeError('connection reset'); }],
    ['server error', async () => response({ error: 'temporary server failure' }, 500)],
    ['malformed acceptance', async () => response({ status: 'queued' }, 202)],
  ];
  for (const [label, outcome] of cases) {
    const f = fixture(); let posts = 0;
    f.setFetch(async url => {
      if (url.endsWith('/preview')) return response(preview());
      if (url.endsWith('/auto-monitor')) { posts += 1; return outcome(); }
      return response({ jobs: [] });
    });
    await f.handleFile(file(`${label}.csv`));
    const commit = f.node('commitImport');
    await commit.onclick(); await commit.onclick();
    assert.equal(posts, 1, `${label}: uncertain submission must not be sent again from this preview`);
    assert.equal(commit.disabled, true, `${label}: retry control stays locked`);
    assert.match(commit.textContent, /待核对/);
    assert.equal(f.node('checkRecentImportJobs').hidden, false);
    assert.match(f.node('importStatus').textContent, /提交结果不确定/);
  }
});

test('uncertain import can inspect the current user recent-job list and read a candidate receipt without resubmitting', async () => {
  const f = fixture(); let posts = 0, recentReads = 0;
  f.setFetch(async (url, options) => {
    if (url.endsWith('/preview')) return response(preview());
    if (url.endsWith('/auto-monitor')) { posts += 1; throw new TypeError('connection reset after request'); }
    if (url.startsWith('/api/author-spreadsheet/jobs/recent')) {
      recentReads += 1;
      assert.equal(new URL(url, 'https://example.test').searchParams.get('scope'), 'mine');
      return response({ scope: 'mine', jobs: [{ id: JOB_A, fileName: 'A.csv', sheetName: '作者名单', status: 'queued', createdAt: new Date().toISOString() }] });
    }
    if (url.endsWith(`/jobs/${JOB_A}`)) return response({ id: JOB_A, fileName: 'A.csv', sheetName: '作者名单', status: 'queued' });
    return response({});
  });
  await f.handleFile(file('A.csv'));
  await f.node('commitImport').onclick();
  await f.node('checkRecentImportJobs').onclick();
  assert.equal(recentReads, 1);
  assert.match(f.node('recentImportStatus').textContent, /仅按文件名、工作表和时间列为候选/);
  assert.match(f.node('importSessionJobList').innerHTML, new RegExp(`data-import-job="${JOB_A}"`));
  assert.match(f.node('importSessionJobList').innerHTML, /候选/);
  await f.openImportJob(JOB_A);
  assert.equal(f.currentJob().id, JOB_A);
  assert.equal(posts, 1, 'reading a possible receipt must never resend the imported rows');
});

test('old running service reports unavailable readback without calling the heavier bootstrap or unlocking submission', async () => {
  const f = fixture(); let posts = 0;
  f.setFetch(async url => {
    if (url.endsWith('/preview')) return response(preview());
    if (url.endsWith('/auto-monitor')) { posts += 1; throw new TypeError('connection reset'); }
    if (url.startsWith('/api/author-spreadsheet/jobs/recent')) return response({ error: 'API 不存在' }, 404);
    return response({ error: 'unexpected request' }, 500);
  });
  await f.handleFile(file('A.csv'));
  await f.node('commitImport').onclick();
  await f.node('checkRecentImportJobs').onclick();
  assert.match(f.node('recentImportStatus').textContent, /尚未加载最近任务回查接口/);
  assert.equal(f.calls.some(call => call.url === '/api/bootstrap'), false, 'avoid a broad, expensive fallback read');
  assert.equal(f.node('commitImport').disabled, true);
  await f.node('commitImport').onclick();
  assert.equal(posts, 1);
});

test('uncertain upload reuses a persisted idempotency key after a fresh preview and clears it on confirmed receipt', async () => {
  const f = fixture(); let posts = 0, firstKey = '';
  f.setFetch(async (url, options) => {
    if (url.endsWith('/preview')) return response(preview());
    if (url.endsWith('/auto-monitor')) {
      posts += 1;
      const key = options.headers['Idempotency-Key'];
      if (posts === 1) { firstKey = key; throw new TypeError('response lost'); }
      assert.equal(key, firstKey, 'fresh preview of the same source must reuse the persisted key');
      const submitted = JSON.parse(options.body);
      assert.equal(submitted.uploadSha256, 'a'.repeat(64));
      assert.equal(submitted.contentBase64, 'AQID', 'single-sheet commit resubmits the exact preview bytes for server-side parsing');
      assert.equal(Object.hasOwn(submitted, 'rows'), false, 'browser preview rows are not a commit authority');
      assert.equal(Object.hasOwn(submitted, 'boardCatalog'), false, 'browser preview board catalog is not a commit authority');
      return response({ id: JOB_A, fileName: 'A.csv', sheetName: '作者名单', status: 'queued', idempotencyReplay: true }, 200);
    }
    return response({ id: JOB_A, fileName: 'A.csv', sheetName: '作者名单', status: 'queued' });
  });
  const sameFile = file('A.csv');
  await f.handleFile(sameFile); await f.node('commitImport').onclick();
  assert.match(f.node('importStatus').textContent, /提交结果不确定/);
  assert.ok(firstKey); assert.equal(f.node('commitImport').disabled, true);
  await f.handleFile(sameFile);
  await f.node('commitImport').onclick();
  assert.equal(posts, 2);
  assert.match(f.node('importStatus').textContent, /没有重复创建/);
  assert.equal(f.sessionValues.get('mcnImportIdempotencyKeysV1'), '{}', 'a valid accepted receipt clears the retry token');
});

for (const movedFocus of [false, true]) test(`sheet keyboard focus ${movedFocus ? 'does not override a later user focus change' : 'returns to the refreshed sheet selector'}`, async () => {
  const f = fixture(); let finish;
  const sheets = [{ name: '作者名单', headerScore: 3 }, { name: '第二页', headerScore: 3 }];
  f.setFetch(async (_url, options) => {
    const selectedSheet = JSON.parse(options.body).sheetName;
    return selectedSheet ? new Promise(resolve => { finish = () => resolve(response({ ...preview(), sheets, selectedSheet })); }) : response({ ...preview(), sheets });
  });
  f.node('fileInput').focus(); await f.handleFile(file('名单.csv'));
  assert.equal(f.document.activeElement.id, 'fileInput', 'ordinary upload must not steal focus');
  f.node('importSheet').focus(); f.node('importSheet').value = '第二页';
  const pending = f.node('importSheet').onchange();
  await new Promise(resolve => setImmediate(resolve));
  if (movedFocus) { f.node('accountSearch').focus(); f.document.body.focus(); }
  finish(); await pending;
  assert.equal(f.document.activeElement, movedFocus ? f.document.body : f.node('importSheet'));
});
