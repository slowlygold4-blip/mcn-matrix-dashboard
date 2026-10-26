import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { File } from 'node:buffer';
import * as model from '../public/console-model.js';
import { parseAuthorSpreadsheet } from '../lib/author-spreadsheet.mjs';

const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/rebuild.html', import.meta.url), 'utf8');
const JOB_A = 'a1111111-1111-4111-8111-111111111111';
const JOB_B = 'b2222222-2222-4222-8222-222222222222';
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const preview = () => ({ selectedSheet: 'CSV', uploadSha256: 'a'.repeat(64), sheets: [{ name: 'CSV', headerScore: 3 }],
  rows: [{ sourceRow: 2, name: '作者甲', douyinId: 'author-a', status: 'resolvable' }], summary: {}, boardCatalog: [] });
const job = (id = JOB_A) => ({ id, status: 'queued', fileName: '名单.csv', sheetName: 'CSV', createdAt: '2026-10-09T10:00:00.000Z' });
function fixture() {
  const nodes = new Map(), calls = [], sessionValues = new Map();
  const document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
  const node = id => {
    if (!nodes.has(id)) {
      const item = { id, hidden: true, disabled: false, value: '', textContent: '', innerHTML: '', attrs: {}, dataset: {}, files: [],
        setAttribute(key, value) { this.attrs[key] = value; }, removeAttribute(key) { delete this.attrs[key]; },
        focus() { document.activeElement = this; }, contains() { return false; }, querySelector() { return null; }, scrollIntoView() {} };
      nodes.set(id, item);
    }
    return nodes.get(id);
  };
  Object.assign(document, { body: node('body'), getElementById: node, querySelectorAll: () => [], querySelector: () => node('date-controls') });
  document.activeElement = document.body;
  const context = { ...model, fmt: model.formatNumber, URL, URLSearchParams, AbortController, Intl, Date, Uint8Array, File,
    setTimeout, clearTimeout, btoa: binary => Buffer.from(binary, 'binary').toString('base64'), document, window: {},
    sessionStorage: { getItem: key => sessionValues.get(key) ?? null, setItem: (key, value) => sessionValues.set(key, value) },
    location: { href: 'https://example.test/?theme=tuantuan#import' },
    history: { replaceState(_state, _unused, url) { context.location.href = String(url); } },
    fetch: async (url, options) => { calls.push({ url, options }); return response(preview()); } };
  runInNewContext(`${source.replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '')}
    this.subject = { state, importPreviewIdentityCaption, importRowReviewMarkup, pastedAuthorFile, handlePastedAuthors, invalidatePastedPreview,
    loadRecentImportJobs, showSubmittedImportJob, openImportJob, handleFile, setView, loadMonitoringStatus,
    acceptedJobs: () => [...acceptedImportJobs.values()], currentJob: () => currentImportJob };`, context);
  context.subject.state.session = { user: { id: 'current-user', role: 'admin' } };
  context.subject.state.data = { boards: [] };
  node('pasteAuthorsMode').value = 'names'; node('pasteAuthorsPlatform').value = 'douyin';
  return { ...context.subject, node, calls, document, location: context.location, sessionValues,
    setFetch(fn) { context.fetch = (url, options) => { calls.push({ url, options }); return fn(url, options); }; } };
}

test('1000-row worksheet uses full identity summary, not its 50-row sample', () => {
  const f = fixture();
  const rows = Array.from({ length: 50 }, (_, index) => ({ name: `昵称${index}` }));
  const caption = f.importPreviewIdentityCaption({ identityCountVersion: 2, totalRows: 1000, knownUniqueAuthors: 800, unresolvedIdentityRows: 200, uniqueAuthors: null }, rows, { totalRows: 1000 });
  assert.match(caption, /800 位主页\/平台账号 ID 线索 · 200 行身份待核验/);
  assert.doesNotMatch(caption, /旧版|样例|50 行身份/);
});

test('1000-row batch preview passes the complete worksheet row count to its summary renderer', async () => {
  const f = fixture();
  f.setFetch(async () => response({ uploadSha256: 'a'.repeat(64), totalAuthorRows: 1000, boardCatalog: [], sheets: [{ name: '作者名单', rowCount: 1000, importable: true, headerRow: 1,
    summary: { identityCountVersion: 2, totalRows: 1000, knownUniqueAuthors: 800, unresolvedIdentityRows: 200, uniqueAuthors: null },
    sampleRows: Array.from({ length: 50 }, (_, index) => ({ name: `昵称${index}` })) }] }));
  await f.handleFile(new File(['fixture'], '大名单.xlsx'));
  assert.match(f.node('importPreview').innerHTML, /800 位主页\/平台账号 ID 线索 · 200 行身份待核验/);
  assert.match(f.node('importPreview').innerHTML, /前 50 行 \/ 共 1,000 行/);
  assert.equal(f.calls.length, 1);
});

test('batch preview surfaces a source-row 999 problem even when the first 50 samples are healthy', async () => {
  const f = fixture();
  const healthy = Array.from({ length: 50 }, (_, index) => ({
    sourceRow: index + 2, name: `正常作者${index + 1}`, locator: `MS4wLjABAAAA${String(index).padStart(20, '0')}`, status: 'ready',
  }));
  f.setFetch(async () => response({ uploadSha256: 'b'.repeat(64), totalAuthorRows: 998, boardCatalog: [], sheets: [{
    name: '作者名单', rowCount: 998, importable: true, headerRow: 1,
    summary: { identityCountVersion: 2, totalRows: 998, knownUniqueAuthors: 997, unresolvedIdentityRows: 1, uniqueAuthors: null,
      importableRows: 997, resolvableRows: 0, needsLocatorRows: 1, identityConflictRows: 0, skippedRows: 0, duplicateRows: 0, existingRows: 0, autoMonitorAuthors: 997 },
    sampleRows: healthy,
    problemRowCount: 1, problemRowsTruncated: 0,
    problemRows: [{ sourceRow: 999, name: '第999行缺身份', status: 'needs_locator', reason: '缺少平台账号主页、账号 ID 和可核验公开证据' }],
  }] }));

  await f.handleFile(new File(['fixture'], '后段问题.xlsx'));
  const markup = f.node('importPreview').innerHTML;
  assert.match(markup, /问题定位/);
  assert.match(markup, /第999行缺身份/);
  assert.match(markup, /缺少平台账号主页、账号 ID 和可核验公开证据/);
  assert.match(markup, />999</);
  assert.equal(f.calls.filter(call => call.url.includes('/auto-monitor')).length, 0, 'preview must not submit the workbook');
});

test('batch preview states bounded problem-row truncation instead of implying every issue is visible', async () => {
  const f = fixture();
  const problemRows = Array.from({ length: 200 }, (_, index) => ({
    sourceRow: index + 52, name: `问题作者${index + 1}`, status: 'needs_locator', reason: '缺少公开身份',
  }));
  f.setFetch(async () => response({ uploadSha256: 'c'.repeat(64), totalAuthorRows: 310, boardCatalog: [], sheets: [{
    name: '作者名单', rowCount: 310, importable: true, headerRow: 1,
    summary: { identityCountVersion: 2, totalRows: 310, knownUniqueAuthors: 50, unresolvedIdentityRows: 260, uniqueAuthors: null,
      importableRows: 50, resolvableRows: 0, needsLocatorRows: 260, identityConflictRows: 0, skippedRows: 0, duplicateRows: 0, existingRows: 0, autoMonitorAuthors: 50 },
    sampleRows: Array.from({ length: 50 }, (_, index) => ({ sourceRow: index + 2, name: `正常作者${index + 1}`, status: 'ready' })),
    problemRowCount: 260, problemRowsTruncated: 60, problemRows,
  }] }));

  await f.handleFile(new File(['fixture'], '大量问题.xlsx'));
  const markup = f.node('importPreview').innerHTML;
  assert.match(markup, /问题定位/);
  assert.match(markup, /已定位 100 \/ 260 行/);
  assert.match(markup, /另有 160 行未展开/);
  assert.match(markup, /问题作者100/);
  assert.doesNotMatch(markup, /问题作者101/);
  assert.equal(f.calls.filter(call => call.url.includes('/auto-monitor')).length, 0);
});

test('CSV preview prioritizes a problem at source row 999 over an all-healthy first-50 sample', async () => {
  const f = fixture();
  const rows = Array.from({ length: 998 }, (_, index) => ({
    sourceRow: index + 2, name: `正常作者${index + 1}`, locator: `MS4wLjABAAAA${String(index).padStart(20, '0')}`, status: 'ready', reason: '账号身份可直接定位，可加入监控',
  }));
  rows[997] = { sourceRow: 999, name: 'CSV后段缺身份', status: 'needs_locator', reason: '缺少可验证的作者主页或公开视频证据' };
  f.setFetch(async () => response({ selectedSheet: 'CSV', uploadSha256: 'd'.repeat(64), sheets: [{ name: 'CSV', headerScore: 3 }], rows, boardCatalog: [],
    summary: { identityCountVersion: 2, totalRows: 998, knownUniqueAuthors: 997, unresolvedIdentityRows: 1, uniqueAuthors: null,
      importableRows: 997, resolvableRows: 0, needsLocatorRows: 1, identityConflictRows: 0, skippedRows: 0, duplicateRows: 0, existingRows: 0, autoMonitorAuthors: 997 } }));

  await f.handleFile(new File(['作者名称,sec_uid\n'], '后段问题.csv'));
  const markup = f.node('importPreview').innerHTML;
  assert.match(markup, /CSV后段缺身份/);
  assert.match(markup, /待补充账号身份/);
  assert.match(markup, />999</);
  assert.equal(f.calls.filter(call => call.url.includes('/auto-monitor')).length, 0);
});

test('missing or inconsistent whole-sheet summary labels sample-only counts explicitly', () => {
  const f = fixture(), rows = Array.from({ length: 50 }, (_, index) => ({ name: `昵称${index}` }));
  assert.match(f.importPreviewIdentityCaption({}, rows, { totalRows: 1000 }), /仅样例前 50 行（非全表统计）.*50 行身份待核验/);
  assert.match(f.importPreviewIdentityCaption({ identityCountVersion: 2, totalRows: 1000, knownUniqueAuthors: 1001, unresolvedIdentityRows: 0, uniqueAuthors: 1001 }, rows, { totalRows: 1000 }), /统计摘要待核对.*非全表统计/);
});

test('a valid all-identified whole-sheet summary is not limited to 50 sample identities', () => {
  const f = fixture();
  const rows = Array.from({ length: 50 }, (_, index) => ({ douyinId: `id${index}` }));
  assert.match(f.importPreviewIdentityCaption({ identityCountVersion: 2, totalRows: 1000, knownUniqueAuthors: 1000, unresolvedIdentityRows: 0, uniqueAuthors: 1000 }, rows, { totalRows: 1000 }), /1,000 位作者/);
});

test('entering import reads bounded own history once without replacing draft, current receipt, or selected filters', async () => {
  const f = fixture(); f.state.theme = 'tuantuan'; f.state.page = 4; f.node('importPreview').innerHTML = 'draft';
  f.showSubmittedImportJob(job(JOB_B));
  let resolve;
  f.setFetch(() => new Promise(done => { resolve = done; }));
  f.setView('import', { renderData: false });
  const read = f.loadRecentImportJobs();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, '/api/author-spreadsheet/jobs/recent?limit=8&scope=mine');
  assert.equal(f.calls[0].options.method, undefined);
  resolve(response({ scope: 'mine', jobs: [job()] })); await read;
  assert.equal(f.acceptedJobs().length, 1); assert.equal(f.currentJob().id, JOB_B);
  assert.equal(f.node('importPreview').innerHTML, 'draft'); assert.equal(f.state.theme, 'tuantuan'); assert.equal(f.state.page, 4);
  await f.loadRecentImportJobs({ automatic: true }); assert.equal(f.calls.length, 1);
  assert.match(f.node('importHistoryStatus').textContent, /最近 1 条任务/);
});

test('own-history failures preserve prior receipts and never submit or fall back to bootstrap', async () => {
  const f = fixture(); f.setFetch(async () => response({ scope: 'mine', jobs: [job()] }));
  await f.loadRecentImportJobs(); const before = f.node('importSessionJobList').innerHTML;
  f.setFetch(async () => response({ error: '网络忙' }, 503)); await f.loadRecentImportJobs();
  assert.equal(f.node('importSessionJobList').innerHTML, before);
  assert.match(f.node('importHistoryStatus').textContent, /保留已有回执和导入草稿/);
  assert.ok(f.calls.every(call => !call.options.method && !call.url.includes('bootstrap')));
});

test('old server without own-scope confirmation cannot populate a misleading own-history list', async () => {
  const f = fixture(); f.setFetch(async () => response({ jobs: [job()] }));
  await f.loadRecentImportJobs(); assert.equal(f.acceptedJobs().length, 0);
  assert.match(f.node('importHistoryStatus').textContent, /尚未确认本人任务范围/);
});

test('read-only user cannot read editor history or preview pasted input', async () => {
  const f = fixture(); f.state.session.user.role = 'viewer'; f.node('pasteAuthorsText').value = '昵称';
  await f.loadRecentImportJobs(); await f.handlePastedAuthors();
  assert.equal(f.calls.length, 0); assert.match(f.node('pasteAuthorsStatus').textContent, /只读身份/);
});

test('late own-history result after session change is discarded', async () => {
  const f = fixture(); let resolve;
  f.setFetch(() => new Promise(done => { resolve = done; }));
  const pending = f.loadRecentImportJobs(); f.state.session = { user: { id: 'other', role: 'editor' } };
  resolve(response({ scope: 'mine', jobs: [job()] })); await pending;
  assert.equal(f.acceptedJobs().length, 0);
});

test('pasted names retain spaces, punctuation, and exact source text without invented identity', async () => {
  const f = fixture(); const file = f.pastedAuthorFile('一条 小团团\n逗号,作者\n引号"作者', 'names', 'douyin');
  const parsed = await parseAuthorSpreadsheet({ buffer: Buffer.from(await file.arrayBuffer()), fileName: file.name });
  assert.deepEqual(parsed.rows.map(row => row.name), ['一条 小团团', '逗号,作者', '引号"作者']);
  assert.equal(parsed.summary.knownUniqueAuthors, 0); assert.equal(parsed.summary.unresolvedIdentityRows, 3);
  assert.ok(parsed.rows.every(row => !row.douyinId && !row.locator));
});

for (const [platform, value, key] of [['douyin', 'author_001', 'douyinId'], ['bilibili', '12345678', 'bilibiliId'], ['xiaohongshu', 'abcdef1234567890abcdef12', 'xiaohongshuId']]) {
  test(`pasted ${platform} IDs round-trip through existing parser as ID fields`, async () => {
    const f = fixture(); const file = f.pastedAuthorFile(value, 'ids', platform);
    const parsed = await parseAuthorSpreadsheet({ buffer: Buffer.from(await file.arrayBuffer()), fileName: file.name });
    assert.equal(parsed.rows.length, 1); assert.equal(parsed.rows[0][key], value); assert.equal(parsed.rows[0].platform, platform);
  });
}

test('pasted TSV retains explicit platform and board, and quoted CSV remains unmodified', async () => {
  const f = fixture();
  for (const content of ['平台\t作者名称\t抖音号\t板块\n抖音\t作者甲\tid-a\t团团矩阵', '平台,作者名称,抖音号,板块\n抖音,"甲,乙",id-b,团团矩阵']) {
    const file = f.pastedAuthorFile(content, 'table');
    assert.equal((await file.text()).replace(/^\uFEFF/, ''), content);
    const parsed = await parseAuthorSpreadsheet({ buffer: Buffer.from(await file.arrayBuffer()), fileName: file.name });
    assert.equal(parsed.rows[0].board, '团团矩阵'); assert.equal(parsed.rows[0].platform, 'douyin');
  }
});

test('table pasting preserves blank boundary columns and CSV tabs inside a quoted author value', async () => {
  const f = fixture();
  const content = '\t作者名称\t抖音号\t\n\t作者甲\tidentity-a\t';
  const tsv = f.pastedAuthorFile(content, 'table');
  assert.equal(await tsv.text(), content);
  const parsed = await parseAuthorSpreadsheet({ buffer: Buffer.from(await tsv.arrayBuffer()), fileName: tsv.name });
  assert.equal(parsed.rows[0].name, '作者甲'); assert.equal(parsed.rows[0].douyinId, 'identity-a');
  const csv = f.pastedAuthorFile('作者名称,抖音号\n"昵称\t带制表符",identity-b', 'table');
  assert.match(csv.name, /\.csv$/);
  const parsedCsv = await parseAuthorSpreadsheet({ buffer: Buffer.from(await csv.arrayBuffer()), fileName: csv.name });
  assert.equal(parsedCsv.rows[0].douyinId, 'identity-b');
});

test('pasted public profile links remain evidence for the selected platform', async () => {
  const f = fixture(), file = f.pastedAuthorFile('https://space.bilibili.com/12345678', 'links', 'bilibili');
  const parsed = await parseAuthorSpreadsheet({ buffer: Buffer.from(await file.arrayBuffer()), fileName: file.name });
  assert.equal(parsed.rows.length, 1); assert.equal(parsed.rows[0].platform, 'bilibili'); assert.equal(parsed.rows[0].locator, '12345678');
});

test('list modes reject multi-column input and invalid or excessive input without a request', () => {
  const f = fixture();
  assert.throws(() => f.pastedAuthorFile('  \n '), /先粘贴/);
  assert.throws(() => f.pastedAuthorFile('昵称\t账号', 'names'), /多列表格/);
  assert.throws(() => f.pastedAuthorFile('昵称', 'unknown'), /格式/);
  assert.throws(() => f.pastedAuthorFile('昵称', 'names', 'not-platform'), /所属平台/);
  assert.throws(() => f.pastedAuthorFile('a'.repeat(1_000_001), 'table'), /100 万/);
  assert.throws(() => f.pastedAuthorFile(Array(10_001).fill('作者').join('\n'), 'names'), /10,000/);
  assert.equal(f.calls.length, 0);
});

test('pasted preview never submits until separate confirmation and keeps entered text', async () => {
  const f = fixture(); f.node('pasteAuthorsText').value = '作者甲\n作者乙';
  await f.handlePastedAuthors();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, '/api/author-spreadsheet/preview');
  assert.equal(f.node('pasteAuthorsText').value, '作者甲\n作者乙');
  assert.match(f.node('pasteAuthorsStatus').textContent, /没有提交名单.*单独确认/);
  assert.ok(f.node('commitImport').onclick); assert.equal(f.currentJob(), null);
});

test('changing pasted text invalidates old preview and prevents an old confirm from submitting', async () => {
  const f = fixture(); f.node('pasteAuthorsText').value = '作者甲';
  await f.handlePastedAuthors(); const oldConfirm = f.node('commitImport').onclick;
  f.node('pasteAuthorsText').value = '作者乙'; f.invalidatePastedPreview();
  await oldConfirm(); assert.equal(f.calls.length, 1); assert.equal(f.node('importPreview').hidden, true);
  assert.match(f.node('pasteAuthorsStatus').textContent, /已更改，请重新预览/);
});

test('double preview activation has one request and edited drafts ignore late old content', async () => {
  const f = fixture(); f.node('pasteAuthorsText').value = '作者甲'; let resolve;
  f.setFetch(() => new Promise(done => { resolve = done; }));
  const pending = f.handlePastedAuthors(); await f.handlePastedAuthors(); await new Promise(done => setImmediate(done));
  assert.equal(f.calls.length, 1);
  f.node('pasteAuthorsText').value = '作者乙'; f.invalidatePastedPreview();
  resolve(response(preview())); await pending;
  assert.equal(f.node('importPreview').hidden, true); assert.equal(f.node('pasteAuthorsText').value, '作者乙');
  assert.match(f.node('pasteAuthorsStatus').textContent, /请重新预览/); assert.equal(f.node('previewPastedAuthors').disabled, false);
});

test('a late pasted preview cannot replace a newer file preview', async () => {
  const f = fixture(); f.node('pasteAuthorsText').value = '作者甲'; let resolve;
  f.setFetch((_url, options) => JSON.parse(options.body).fileName.startsWith('粘贴') ? new Promise(done => { resolve = done; }) : Promise.resolve(response(preview())));
  const pending = f.handlePastedAuthors(); await new Promise(done => setImmediate(done));
  await f.handleFile(new File(['作者名称\n另一位'], '新文件.csv'));
  resolve(response(preview())); await pending;
  assert.match(f.node('importPreview').innerHTML, /新文件.csv/); assert.doesNotMatch(f.node('importPreview').innerHTML, /粘贴作者名称/);
});

test('re-previewing identical pasted content keeps the existing uncertain-submission idempotency key', async () => {
  const f = fixture(); f.node('pasteAuthorsText').value = '作者甲'; let posts = 0, previous;
  f.setFetch(async (url, options) => {
    if (url.endsWith('/preview')) return response(preview());
    if (url.endsWith('/auto-monitor')) {
      posts++; const key = options.headers['Idempotency-Key'];
      if (posts === 1) { previous = key; throw new TypeError('response lost'); }
      assert.equal(key, previous); return response({ ...job(), idempotencyReplay: true });
    }
    return response(job());
  });
  await f.handlePastedAuthors(); await f.node('commitImport').onclick();
  await f.handlePastedAuthors(); await f.node('commitImport').onclick();
  assert.equal(posts, 2); assert.ok(previous); assert.match(f.node('importStatus').textContent, /没有重复创建/);
});

test('visible pasted controls have labels, error descriptions, permission setup and a separate confirmation', () => {
  assert.match(html, /for="pasteAuthorsText"/); assert.match(html, /aria-describedby="pasteAuthorsHelp pasteAuthorsStatus"/);
  assert.match(html, /id="previewPastedAuthors"[^>]*type="button"/);
  assert.match(html, /id="importHistoryStatus"[^>]*role="status"/);
  assert.match(source, /\['pasteAuthorsMode', 'pasteAuthorsPlatform', 'pasteAuthorsText', 'previewPastedAuthors', 'clearPastedAuthors', 'loadRecentImportJobs'\].*disabled = !canEdit\(\)/);
});

test('locked works process is a visible interruption, not ordinary waiting, with safe reason labels', async () => {
  const f = fixture();
  f.setFetch(async () => response({ browserLane: { locked: true, reason: 'BROWSER_CLEANUP_UNCERTAIN', recoveryEligible: true, lockedAt: '2026-10-09T10:00:00Z' }, scheduler: { running: false, worksOnlyRetry: { deferred: true } }, sourcePoller: {} }));
  await f.loadMonitoringStatus();
  assert.match(f.node('monitoringBrief').textContent, /^作品采集进程暂停（安全检查未通过）/);
  assert.equal(f.node('monitoringBrief').attrs['data-state'], 'error');
  const markup = f.node('monitoringStatus').innerHTML;
  assert.match(markup, /旧采集进程退出尚未确认/); assert.match(markup, /等待旧进程退出后自动复核/);
  assert.match(markup, /主页和话题独立调度/); assert.doesNotMatch(markup, /等待计划时点|最早.*后自动复查/);
});

test('unknown lane reason is never rendered and ineligible recovery is not called automatic', async () => {
  const f = fixture(); const secret = 'private-cookie=<script>danger</script>';
  f.setFetch(async () => response({ browserLane: { locked: true, reason: secret, recoveryEligible: false }, scheduler: { running: false }, sourcePoller: {} }));
  await f.loadMonitoringStatus(); const markup = f.node('monitoringStatus').innerHTML;
  assert.doesNotMatch(markup, /private-cookie|<script>|自动复核/); assert.match(markup, /需服务安全恢复/);
});

test('missing or unlocked browser lane keeps the existing scheduler display without claiming recovery', async () => {
  const f = fixture();
  for (const browserLane of [undefined, { locked: false, reason: null, lastRecoveredAt: '2026-10-09T10:00:00Z' }]) {
    f.setFetch(async () => response({ browserLane, scheduler: { running: false }, sourcePoller: {} })); await f.loadMonitoringStatus();
    assert.match(f.node('monitoringStatus').innerHTML, /等待计划时点/);
    assert.doesNotMatch(f.node('monitoringBrief').textContent, /进程暂停|已恢复/);
  }
});

test('import review states have human labels and identity-ready never claims monitoring success', () => {
  const f = fixture();
  for (const [status, label] of Object.entries({ needs_locator: '待补充账号身份', identity_conflict: '身份信息冲突', existing: '已有账号', ready: '身份线索齐全（非已核验）', resolvable: '待识别账号', duplicate: '表内重复', unresolved: '暂未确认', skipped: '暂不接入' })) {
    assert.ok(f.importRowReviewMarkup({ status }).includes(`>${label}</span>`));
    assert.ok(f.importRowReviewMarkup({ status }).includes(`title="原始状态：${status}"`));
  }
  assert.doesNotMatch(f.importRowReviewMarkup({ status: 'ready', statusLabel: '已监控成功' }), /已监控|已采集|核验成功/);
});

test('unknown review status stays human-readable with escaped original code and full escaped reasons', () => {
  const f = fixture(); const value = f.importRowReviewMarkup({ status: '<img onerror="x">', reason: '原始 <script>reason</script>', issues: ['错误 & 细节'], warnings: ['提醒'] });
  assert.match(value, />状态待确认<\/span>/); assert.match(value, /title="原始状态：&lt;img onerror=&quot;x&quot;&gt;"/);
  assert.match(value, /原始 &lt;script&gt;reason&lt;\/script&gt;；错误 &amp; 细节；提醒/);
  assert.doesNotMatch(value, /<img|<script/);
});

test('single-table and workbook sample previews share the same readable review renderer', async () => {
  const f = fixture(), row = { sourceRow: 2, name: '只填昵称', status: 'needs_locator', reason: '请补充主页链接' };
  f.setFetch(async () => response({ ...preview(), rows: [row] }));
  await f.handleFile(new File(['fixture'], '名单.csv'));
  assert.match(f.node('importPreview').innerHTML, />待补充账号身份<\/span><small>请补充主页链接<\/small>/);
  f.setFetch(async () => response({ uploadSha256: 'a'.repeat(64), totalAuthorRows: 1, boardCatalog: [], sheets: [{ name: '作者名单', rowCount: 1, importable: true, headerRow: 1, summary: {}, sampleRows: [row] }] }));
  await f.handleFile(new File(['fixture'], '名单.xlsx'));
  assert.match(f.node('importPreview').innerHTML, />待补充账号身份<\/span><small>请补充主页链接<\/small>/);
});
