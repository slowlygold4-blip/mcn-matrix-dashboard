import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import vm from 'node:vm';
import { MonitorDatabase, normalizeBoardKey, normalizeBoardName } from '../lib/database.mjs';
import { AUTHOR_UPLOAD_LIMITS, authorPreviewContentSha256, canonicalAccountLocator, markExistingAuthors,
  normalizeAccountLocator, normalizePlatform, parseAuthorSpreadsheet, validateSubmittedAccountId } from '../lib/author-spreadsheet.mjs';
import { applyAuthorEvidence, buildAuthorEvidenceRequests, summarizeAuthorAccountIdentities,
  summarizeQueuedAuthorEvidence } from '../lib/author-resolution.mjs';
import { prepareAuthorBoardImport } from '../lib/author-board-import.mjs';
import { normalizeLarkSheetUrl } from '../lib/lark-sheet-source.mjs';
import { HttpError } from '../lib/access-control.mjs';
import { inspectSourcePollManifest } from '../lib/source-poller-status.mjs';
import { mapBitableAuthorRows } from '../lib/source-bitable-mapping.mjs';
import { SOURCE_POLLER_CAPABILITY_HEADER, capabilityMatches,
  isLoopbackAddress } from '../lib/internal-source-capability.mjs';

// These tests evaluate the real handler/worker-normalizer source, not a copy of
// the whitelist. Transport and authenticated principal are isolated fixtures.
// Scratch files are retained; neither the production DB nor receipts are opened.
const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const server = read('../server.mjs');
const poller = read('../scripts/source-poller.mjs');
const provenanceModule = new URL('../lib/author-source-provenance.mjs', import.meta.url);
const { normalizeBitableAuthorSource } = existsSync(provenanceModule)
  ? await import(provenanceModule) : {};
const NORMAL_NOW = new Date('2026-10-01T17:20:00.000Z');
const SOURCE_URL = 'https://fixture.feishu.cn/base/BitableObject12345?table=tblBound72';
const SOURCE = Object.freeze({ sourceType: 'lark-bitable', sourceUrl: SOURCE_URL,
  sourceSheetId: 'tblBound72', sheetName: '作者明细', defaultBoard: '一条小团团切片矩阵',
  sourceTitle: '团团已授权作者表', sourceRevision: 72, sourceSha256: 'a'.repeat(64),
  sourceReadAt: '2026-10-01T17:10:00.000Z' });
const ROW = Object.freeze({ sourceRow: 2, name: '严格来源作者', platform: 'douyin',
  locator: 'MS4wLjABAAAAphase72VerifiedOwner1234567890', douyinId: 'phase72-author',
  status: 'ready' });
const SOURCE_POLLER_CAPABILITY = '7'.repeat(64);
const RESULT = { createdCount: 0, reusedExistingCount: 108, reviewRequiredCount: 2891,
  queuedEvidenceRequestCount: 118 };
const clone = value => JSON.parse(JSON.stringify(value));
const digest = text => createHash('sha256').update(text).digest('hex');

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mcn-phase72-provenance-'));
  const database = new MonitorDatabase(join(dir, 'isolated.sqlite'));
  database.ensureLocalOwner();
  t.after(() => database.close());
  return { dir, database };
}

function span(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `actual production span missing: ${start}`);
  return source.slice(from, to);
}

function handler(t, { exporter, preview, hash = 'b'.repeat(64) } = {}) {
  const f = scratch(t);
  const observations = { exported: 0, scheduled: 0, actions: 0 };
  const actualHelpers = span(server, 'function sourceBoards(', 'async function executeAuthorResolveJob(');
  const actualEnqueue = span(server, 'function authorJobReplayPayload(', 'async function handleApi(');
  const actualDecode = span(server, 'function decodeSpreadsheetUpload(', 'function sourceBoards(');
  const actualRoute = span(server,
    '  if (request.method === "POST" && pathname === "/api/author-spreadsheet/auto-monitor") {',
    '  const authorResolveSkippedMatch =');
  const context = vm.createContext({ URL, Date, Set, Map, Number, String, Array, Object, JSON,
    Buffer, basename, randomUUID, createHash, normalizeBoardKey, normalizeBoardName,
    AUTHOR_UPLOAD_LIMITS, canonicalAccountLocator, markExistingAuthors, normalizeAccountLocator, validateSubmittedAccountId,
    normalizePlatform, buildAuthorEvidenceRequests, summarizeAuthorAccountIdentities,
    applyAuthorEvidence, summarizeQueuedAuthorEvidence,
    prepareAuthorBoardImport, normalizeLarkSheetUrl, normalizeBitableAuthorSource, HttpError,
    SOURCE_POLLER_CAPABILITY_HEADER, capabilityMatches, isLoopbackAddress,
    sourcePollerCapability: SOURCE_POLLER_CAPABILITY,
    authorPreviewContentSha256: () => hash,
    parseAuthorSpreadsheet: preview === undefined ? parseAuthorSpreadsheet : async () => preview,
    exportLarkSheetWorkbook: async (url) => { observations.exported++; return exporter(url); },
    database: f.database,
    clientIp: () => '127.0.0.1',
    access: { requireRole(request, role) { assert.equal(role, 'editor'); assert.equal(request.auth.user.id, 1); } },
    recordAction: () => { observations.actions++; },
    scheduleAuthorResolutionJobs: () => { observations.scheduled++; },
    scheduleAuthorResolutionQueue: () => {},
    authorJobWorkerId: 'phase72-isolated-worker',
    shutdownController: new AbortController(),
    PublicWebProvider: class {
      async resolveAuthors(requests) {
        return { items: requests.map(item => ({ key: item.key, status: 'deferred',
          networkAttempted: false, candidates: [], errors: [] })) };
      }
    },
    publicTarget: value => value,
    json: (_response, status, value) => ({ status, payload: clone(value) }),
    readJson: async request => clone(request.testBody),
  });
  const actualWorker = span(server, 'async function executeAuthorResolveJob(', 'async function processAuthorResolutionJobs(');
  vm.runInContext(`${actualDecode}\n${actualHelpers}\n${actualEnqueue}\n${actualWorker}\nasync function submit(request) {
    const response = {}, pathname = '/api/author-spreadsheet/auto-monitor';
    ${actualRoute}
  }
  globalThis.phase72 = { submit, normalize: importableAuthorTargets, project: publicAuthorResolveJob,
    worker: executeAuthorResolveJob };`, context);
  return { ...f, observations, context,
    submit: body => context.phase72.submit({ method: 'POST', headers: body?.sourceType === 'lark-bitable'
      ? { [SOURCE_POLLER_CAPABILITY_HEADER]: SOURCE_POLLER_CAPABILITY } : {}, testBody: body,
      auth: { user: { id: 1, displayName: '隔离来源测试', role: 'admin' } },
      socket: { remoteAddress: '127.0.0.1' } }),
    normalize: (body, targets = []) => clone(context.phase72.normalize(clone(body), targets)),
    project: job => clone(context.phase72.project(job)),
    worker: () => context.phase72.worker(f.database.claimNextAuthorResolutionJob({ owner: 'phase72-isolated-worker' })),
  };
}

async function bitableSubmission(current = SOURCE) {
  const block = span(poller, '        if (source.sourceType === "lark-bitable") {', '        const preview =');
  const from = block.indexOf('          const submitted = await apiRequest(');
  const to = block.indexOf('          await savePendingJob(', from);
  assert.ok(from >= 0 && to > from, 'actual Bitable submission missing');
  const context = vm.createContext({ current: clone(current),
    source: { ...clone(current), tableId: current.sourceSheetId, baseToken: 'PRIVATE_BASE_FIXTURE',
      accessToken: 'PRIVATE_ACCESS_FIXTURE' },
    normalizeBitableAuthorSource, bitable: { rows: [clone(ROW)] },
    currentSession: { headers: { authorization: 'PRIVATE_AUTH_FIXTURE' } },
    trustedHeaders: { authorization: 'PRIVATE_AUTH_FIXTURE',
      [SOURCE_POLLER_CAPABILITY_HEADER]: SOURCE_POLLER_CAPABILITY },
    apiRequest: async (path, headers, payload) => {
      assert.equal(path, '/api/author-spreadsheet/auto-monitor');
      assert.equal(headers[SOURCE_POLLER_CAPABILITY_HEADER], SOURCE_POLLER_CAPABILITY);
      assert.equal(headers.authorization, 'PRIVATE_AUTH_FIXTURE');
      return clone(payload);
    },
  });
  return clone(await vm.runInContext(`(async () => { ${block.slice(from, to)} return submitted; })()`, context));
}

function readthrough(f, binding, id, { request: overrideRequest } = {}) {
  const manifestPath = join(f.dir, `manifest-${randomUUID()}.json`);
  writeFileSync(manifestPath, JSON.stringify({ sources: { fixture: {
    ...binding, key: 'fixture', lastJobId: id, lastStatus: 'submitted',
    lastCheckedAt: SOURCE.sourceReadAt,
  } } }));
  const before = readFileSync(manifestPath, 'utf8');
  const rowBefore = f.database.db.prepare('SELECT request_json,result_json FROM author_resolution_jobs WHERE id=?').get(id);
  const totalBefore = f.database.db.prepare('SELECT total_changes() AS changes').get().changes;
  const status = inspectSourcePollManifest(manifestPath, { now: NORMAL_NOW,
    lookupCompletedJob: jobId => {
      const value = f.database.getAuthorResolutionJob(jobId);
      return overrideRequest ? { ...value, request: overrideRequest } : value;
    },
  });
  assert.equal(readFileSync(manifestPath, 'utf8'), before, 'read-through must not rewrite receipt');
  assert.deepEqual(f.database.db.prepare('SELECT request_json,result_json FROM author_resolution_jobs WHERE id=?').get(id), rowBefore);
  assert.equal(f.database.db.prepare('SELECT total_changes() AS changes').get().changes, totalBefore);
  return status;
}

async function completedBitable(t) {
  const f = handler(t);
  const submitted = await f.submit({ ...SOURCE, fileName: '严格作者名单.json', rows: [ROW] });
  assert.equal(submitted.status, 202);
  f.database.db.prepare("UPDATE author_resolution_jobs SET status='completed',finished_at=?,result_json=? WHERE id=?")
    .run('2026-10-01T17:15:00.000Z', JSON.stringify(RESULT), submitted.payload.id);
  return { ...f, id: submitted.payload.id };
}

test('phase72 actual Bitable submit carries bounded URL/table/type/hash/time, not credentials', async () => {
  const payload = await bitableSubmission();
  for (const [key, value] of Object.entries(SOURCE)) assert.equal(payload[key], value, key);
  assert.equal(payload.rows[0].sourceRow, 2);
  assert.doesNotMatch(JSON.stringify(payload), /PRIVATE_AUTH|authorization|baseToken|accessToken/);
});

test('phase72 producer → actual handler → SQLite → strict source read-through is lossless', async t => {
  const f = handler(t);
  const payload = await bitableSubmission();
  const response = await f.submit(payload);
  assert.equal(response.status, 202);
  const durable = f.database.getAuthorResolutionJob(response.payload.id).request;
  for (const key of ['sourceType', 'sourceUrl', 'sourceSheetId', 'sheetName', 'defaultBoard', 'sourceSha256', 'sourceReadAt'])
    assert.equal(durable[key], SOURCE[key], `durable ${key}`);
  assert.equal(f.observations.exported, 0, 'Bitable must not be rerouted through sheet exporter');
  assert.equal(f.observations.scheduled, 1);
  f.database.db.prepare("UPDATE author_resolution_jobs SET status='completed',finished_at=?,result_json=? WHERE id=?")
    .run('2026-10-01T17:15:00.000Z', JSON.stringify(RESULT), response.payload.id);
  const status = readthrough(f, SOURCE, response.payload.id);
  assert.equal(status.sources[0].sourceJobSummary.reusedExistingRowCount, 108);
  assert.equal(status.sources[0].sourceJobSummary.createdAccountCount, 0);
  assert.equal(status.sources[0].sourceJobSummary.businessStatus, 'pending');
  assert.doesNotMatch(JSON.stringify(status), /sourceUrl|sourceSheetId|"request"|PRIVATE/);
});

test('phase72 actual worker import normalizer keeps Bitable row provenance, not generic upload', t => {
  const f = handler(t);
  const normalized = f.normalize({ ...SOURCE, fileName: '严格作者名单.json', rows: [ROW] });
  assert.equal(normalized.inputs.length, 1);
  const witness = normalized.inputs[0].metadata.importSource;
  assert.equal(witness.type, 'lark-bitable');
  for (const key of ['sourceUrl', 'sourceSheetId', 'sheetName', 'sourceTitle', 'sourceRevision', 'sourceSha256', 'sourceReadAt'])
    assert.equal(witness[key], SOURCE[key], `worker source ${key}`);
  assert.equal(witness.sourceRow, 2);
  assert.doesNotMatch(JSON.stringify(witness), /authorization|baseToken|accessToken|PRIVATE/);
});

test('phase72 real worker completion preserves both direct target and queued row source witness', async t => {
  const f = handler(t);
  const queued = { sourceRow: 3, name: '等待证据作者', platform: 'douyin', douyinId: 'phase72-pending',
    videoId: '7679000000000000073', status: 'resolvable' };
  const response = await f.submit({ ...SOURCE, fileName: '严格作者名单.json', rows: [ROW, queued] });
  await f.worker();
  const job = f.database.getAuthorResolutionJob(response.payload.id);
  assert.equal(job.status, 'completed', job.error);
  assert.equal(job.result.createdCount, 1);
  assert.equal(job.result.queuedEvidenceRequestCount, 1, 'offline fixture evidence count, not newly monitored author count');
  const target = f.database.listTargets()[0];
  assert.equal(target.metadata.importSource.type, 'lark-bitable');
  assert.equal(target.metadata.importSource.sourceUrl, SOURCE_URL);
  assert.equal(target.metadata.importSource.sourceSheetId, SOURCE.sourceSheetId);
  const queue = f.database.db.prepare('SELECT source_metadata_json FROM author_resolution_queue').get();
  const queueSource = JSON.parse(queue.source_metadata_json);
  for (const key of ['sourceType', 'sourceUrl', 'sourceSheetId', 'sourceSha256', 'sourceReadAt'])
    assert.equal(queueSource[key], SOURCE[key], `actual queued ${key}`);
  assert.doesNotMatch(JSON.stringify([target.metadata.importSource, queueSource]), /PRIVATE|authorization|accessToken|baseToken/);
});

test('phase72 valid zero revision survives worker queue and subsequent real import normalizer', async t => {
  const f = handler(t);
  const zero = { ...SOURCE, sourceRevision: 0 };
  const queued = { sourceRow: 3, name: '零版本等待作者', platform: 'douyin', douyinId: 'phase72-zero',
    videoId: '7679000000000000074', status: 'resolvable' };
  const response = await f.submit({ ...zero, fileName: '零版本来源.json', rows: [ROW, queued] });
  await f.worker();
  const job = f.database.getAuthorResolutionJob(response.payload.id);
  assert.equal(job.status, 'completed', job.error);
  assert.equal(job.request.sourceRevision, 0);
  const queue = f.database.db.prepare('SELECT source_metadata_json FROM author_resolution_queue').get();
  const queueSource = JSON.parse(queue.source_metadata_json);
  assert.equal(queueSource.sourceRevision, 0, 'zero is legal source revision, not missing validation input');
  const later = f.normalize({ ...queueSource, fileName: '零版本来源.json', sheetName: SOURCE.sheetName,
    rows: [{ ...ROW, sourceRow: 3 }] });
  assert.equal(later.sourceType, 'lark-bitable');
  assert.equal(later.inputs[0].metadata.importSource.sourceRevision, 0);
  assert.equal(f.database.listTargets()[0].metadata.importSource.sourceRevision, 0);
});

test('phase72 actual Bitable reader records read completion time, never earlier batch start', async () => {
  let clock = Date.parse('2026-10-01T17:10:00.000Z');
  class FixtureDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const actualReader = span(poller, 'function parseCliJson(', 'function comparableRevision(').replace('export async function readBitable', 'async function readBitable');
  const context = vm.createContext({ JSON, String, Number, Object, Array, Map, Set, Date: FixtureDate,
    createHash, mapBitableAuthorRows, requestTimeoutMs: 1_000, process: { env: {} },
    clean: value => String(value ?? ''), cleanForSource: value => String(value ?? ''),
    resolveLarkCliCommand: async () => '/fixture/no-real-cli',
    execFileAsync: async () => {
      clock += 45_000;
      return { stdout: JSON.stringify({ ok: true, data: { fields: ['抖音昵称', '抖音号'],
        rev: 72, data: [['作者', 'phase72-author']], record_id_list: ['record72'], has_more: false } }) };
    },
  });
  vm.runInContext(`${actualReader}\nglobalThis.phase72Reader = readBitable;`, context);
  const result = clone(await context.phase72Reader({ ...SOURCE, tableId: SOURCE.sourceSheetId, baseToken: 'PRIVATE_BASE_FIXTURE' }));
  assert.equal(result.sourceReadAt ?? result.readAt, '2026-10-01T17:10:45.000Z');
  const originalRaw = { fields: ['抖音昵称', '抖音号'], rows: [{ values: ['作者', 'phase72-author'], recordId: 'record72' }] };
  assert.equal(result.sourceSha256, digest(JSON.stringify(originalRaw)), 'timestamp does not rewrite source content hash');
  const currentBlock = span(poller, '        if (source.sourceType === "lark-bitable") {', '          const baseline =');
  const currentSpan = currentBlock.slice(currentBlock.indexOf('          const current ='));
  const producerContext = vm.createContext({ key: 'fixture', source: { ...SOURCE, tableId: SOURCE.sourceSheetId }, bitable: result,
    now: new Date('2026-10-01T17:10:00.000Z'), clean: value => String(value ?? ''), sourceReadContract: () => 'fixture-contract' });
  const current = clone(vm.runInContext(`(() => { ${currentSpan}\nreturn current; })()`, producerContext));
  assert.equal(current.sourceReadAt, '2026-10-01T17:10:45.000Z');
  assert.equal(current.lastCheckedAt, '2026-10-01T17:10:00.000Z', 'poll bookkeeping remains separately labelled');
});

test('phase72 ordinary uploads reparse exact bytes and retain generic row source', async t => {
  const upload = Buffer.from('作者名称,sec_uid\n严格来源作者,MS4wLjABAAAAphase72VerifiedOwner1234567890\n', 'utf8');
  const uploadSha256 = digest(upload);
  const f = handler(t);
  const response = await f.submit({ fileName: '旧上传.csv', sheetName: 'CSV',
    contentBase64: upload.toString('base64'), uploadSha256,
    rows: [{ ...ROW, name: '客户端伪造作者' }],
    defaultBoard: '团团', cookie: 'PRIVATE_COOKIE', unknown: { token: 'PRIVATE_TOKEN' },
    sourceUrl: SOURCE_URL, sourceSheetId: SOURCE.sourceSheetId });
  const job = f.database.getAuthorResolutionJob(response.payload.id);
  assert.deepEqual(Object.keys(job.request).sort(), ['boardCatalog', 'defaultBoard', 'fileName', 'rows', 'sheetName', 'uploadSha256']);
  assert.equal(job.request.uploadSha256, uploadSha256);
  assert.equal(job.request.rows[0].name, ROW.name, 'durable row comes from the reparsed upload, not submitted preview rows');
  assert.doesNotMatch(JSON.stringify(job.request), /PRIVATE|unknown|cookie|sourceUrl|sourceSheetId/);
  const normalized = f.normalize(job.request);
  assert.equal(normalized.inputs[0].metadata.importSource.type, 'author-spreadsheet');
  assert.equal(Object.hasOwn(normalized.inputs[0].metadata.importSource, 'sourceUrl'), false);
});

test('phase72 new Bitable request allowlists known metadata, public job API still withholds request', async t => {
  const f = handler(t);
  const response = await f.submit({ ...SOURCE, fileName: '安全来源.json', rows: [ROW],
    cookie: 'PRIVATE_COOKIE', authorization: 'PRIVATE_AUTH', accessToken: 'PRIVATE_ACCESS',
    clientSecret: 'PRIVATE_SECRET', baseToken: 'PRIVATE_BASE', extra: { url: 'https://private.example/' } });
  const job = f.database.getAuthorResolutionJob(response.payload.id);
  assert.equal(job.request.sourceType, 'lark-bitable');
  assert.equal(job.request.sourceUrl, SOURCE_URL);
  assert.doesNotMatch(JSON.stringify(job.request), /PRIVATE|private\.example|clientSecret|authorization|accessToken|baseToken/);
  assert.equal(Object.hasOwn(response.payload, 'request'), false);
  assert.equal(Object.hasOwn(f.project(job), 'request'), false);
  assert.doesNotMatch(JSON.stringify(f.project(job)), /sourceUrl|sourceSheetId|sourceSha256|PRIVATE/);
});

for (const [label, patch] of [
  ['HTTP source', { sourceUrl: SOURCE_URL.replace('https:', 'http:') }],
  ['foreign host', { sourceUrl: 'https://foreign.example/base/BitableObject12345?table=tblBound72' }],
  ['deceptive official suffix', { sourceUrl: 'https://feishu.cn.foreign.example/base/BitableObject12345?table=tblBound72' }],
  ['credential URL', { sourceUrl: 'https://user:PRIVATE_PASS@fixture.feishu.cn/base/BitableObject12345?table=tblBound72' }],
  ['custom port', { sourceUrl: 'https://fixture.feishu.cn:8443/base/BitableObject12345?table=tblBound72' }],
  ['private token query', { sourceUrl: `${SOURCE_URL}&access_token=[REDACTED] }],
  ['unknown query', { sourceUrl: `${SOURCE_URL}&authorization=PRIVATE_AUTH` }],
  ['foreign source object path', { sourceUrl: 'https://fixture.feishu.cn/mail/BitableObject12345?table=tblBound72' }],
  ['invalid table ID', { sourceSheetId: '../tblBound72' }],
  ['URL/body table disagreement', { sourceSheetId: 'tblOther72' }],
  ['duplicate table locator', { sourceUrl: `${SOURCE_URL}&table=tblOther72` }],
  ['overlong table ID', { sourceSheetId: 'tbl' + 'a'.repeat(100) }],
  ['missing content hash', { sourceSha256: '' }],
  ['malformed hash', { sourceSha256: 'a'.repeat(63) }],
  ['unsafe revision', { sourceRevision: Number.MAX_SAFE_INTEGER + 1 }],
  ['fractional revision', { sourceRevision: 72.5 }],
  ['negative revision', { sourceRevision: -1 }],
  ['invalid source timestamp', { sourceReadAt: 'not-a-date' }],
  ['future source timestamp', { sourceReadAt: '2099-10-01T17:10:00.000Z' }],
]) test(`phase72 authenticated handler rejects ${label} before any board/job writes`, async t => {
  const f = handler(t);
  const changes = f.database.db.prepare('SELECT total_changes() AS count').get().count;
  await assert.rejects(f.submit({ ...SOURCE, ...patch, fileName: '危险来源.json', rows: [ROW] }),
    error => error instanceof HttpError && error.status === 400 && /来源凭证/.test(error.message),
    'invalid provenance must be rejected by the real source contract, not an unrelated VM harness error');
  assert.equal(f.database.db.prepare('SELECT COUNT(*) AS count FROM author_resolution_jobs').get().count, 0);
  assert.equal(f.database.db.prepare('SELECT COUNT(*) AS count FROM board_catalog').get().count, 0);
  assert.equal(f.database.db.prepare('SELECT total_changes() AS count').get().count, changes);
  assert.equal(f.observations.scheduled, 0);
  assert.equal(f.observations.exported, 0, 'must not run sheet export as validation fallback');
});

for (const [label, patch] of [
  ['other URL', { sourceUrl: 'https://fixture.feishu.cn/base/OtherObject12345?table=tblBound72' }],
  ['other table', { sourceSheetId: 'tblOther72' }], ['other sheet name', { sheetName: '错误工作表' }],
  ['other board', { defaultBoard: '杨齐家切片矩阵' }], ['empty board', { defaultBoard: '' }],
]) test(`phase72 strict read-through refuses ${label} without rewriting historical rows`, async t => {
  const f = await completedBitable(t);
  assert.equal(readthrough(f, { ...SOURCE, ...patch }, f.id).sources[0].sourceJobSummary, null);
});

test('phase72 old provenance-free jobs stay unknown: no inferred link from name or row note', async t => {
  const f = await completedBitable(t);
  const legacyRequest = { fileName: '同名作者表.json', sheetName: SOURCE.sheetName,
    defaultBoard: SOURCE.defaultBoard, rows: [{ ...ROW, notes: `来源=${SOURCE_URL};table=${SOURCE.sourceSheetId}` }], boardCatalog: [] };
  const legacyJson = JSON.stringify(legacyRequest);
  f.database.db.prepare('UPDATE author_resolution_jobs SET request_json=? WHERE id=?').run(legacyJson, f.id);
  const before = digest(legacyJson);
  assert.equal(readthrough(f, SOURCE, f.id).sources[0].sourceJobSummary, null);
  assert.equal(digest(f.database.db.prepare('SELECT request_json FROM author_resolution_jobs WHERE id=?').get(f.id).request_json), before);
});

test('phase72 same-job cache cannot lend Bitable outcome to a different source object', async t => {
  const f = await completedBitable(t);
  const path = join(f.dir, 'cache-manifest.json');
  const values = [SOURCE, { ...SOURCE, sourceSheetId: 'tblOther72' }, { ...SOURCE, sourceUrl: `${SOURCE_URL}&other=yes` }];
  writeFileSync(path, JSON.stringify({ sources: Object.fromEntries(values.map((source, i) => [String(i), {
    ...source, key: String(i), lastStatus: 'submitted', lastJobId: f.id, lastCheckedAt: SOURCE.sourceReadAt,
  }])) }));
  let count = 0;
  const status = inspectSourcePollManifest(path, { now: NORMAL_NOW,
    lookupCompletedJob: id => { count++; return f.database.getAuthorResolutionJob(id); } });
  assert.equal(count, 1);
  assert.ok(status.sources[0].sourceJobSummary);
  assert.ok(status.sources.slice(1).every(value => value.sourceJobSummary === null));
});

test('phase72 existing sheet fresh-read content/revision guards still reject stale submission', async t => {
  const exportedSource = { title: '新鲜飞书表', revision: 72,
    sheets: [{ id: 'sheet72', title: '作者名单' }], exportSha256: 'c'.repeat(64), readAt: SOURCE.sourceReadAt };
  const f = handler(t, { exporter: url => ({ buffer: Buffer.from('fixture'), fileName: '飞书.xlsx', source: exportedSource }),
    preview: { selectedSheet: '作者名单', dataRange: 'A1:E2', rows: [ROW], boardCatalog: [] } });
  for (const patch of [{ sourceSha256: 'd'.repeat(64) }, { sourceRevision: 71 }]) {
    await assert.rejects(f.submit({ sourceType: 'lark-sheet', sourceUrl: 'https://fixture.feishu.cn/sheets/SheetObject12345',
      sourceSha256: 'b'.repeat(64), sourceRevision: 72, ...patch }), error => error.status === 409 || /预览后发生变化/.test(error.message));
  }
  assert.equal(f.database.db.prepare('SELECT COUNT(*) AS count FROM author_resolution_jobs').get().count, 0);
  assert.equal(f.observations.exported, 2);
});

test('phase72 source work identity binding accepts typed Bitable provenance but keeps identity requirements', () => {
  const code = read('../lib/source-work-identity.mjs');
  const context = vm.createContext({ URL, Date, Set, Map, Number, String, Array, Object, JSON,
    normalizeBitableAuthorSource });
  vm.runInContext(`${span(code, 'const DETAIL_ENDPOINT', 'function currentProfile(')}\nglobalThis.phase72Binding = sourceBinding;`, context);
  const target = { id: 72, type: 'account', provider: 'public-web', platform: 'douyin', enabled: true,
    locator: ROW.locator, metadata: { platform: 'douyin', douyinId: ROW.douyinId,
      evidenceVideoId: '7679000000000000072', importSource: { ...SOURCE, type: 'lark-bitable',
        fileName: '严格作者名单.json', sourceRow: 2 } } };
  assert.ok(context.phase72Binding(target), 'Bitable is a typed source, not a foreign evidence source');
  for (const patch of [{ enabled: false }, { locator: 'not-a-sec-uid' }, { provider: 'foreign' }])
    assert.equal(context.phase72Binding({ ...target, ...patch }), null);
  assert.equal(context.phase72Binding({ ...target, metadata: { ...target.metadata,
    importSource: { ...target.metadata.importSource, type: 'foreign-upload' } } }), null);
});
