import test from 'node:test';
import assert from 'node:assert/strict';
import { readBitable } from '../scripts/source-poller.mjs';
import { mapBitableAuthorRows } from '../lib/source-bitable-mapping.mjs';
import { applyAuthorEvidence, buildAuthorEvidenceRequests } from '../lib/author-resolution.mjs';
import { MonitorDatabase, normalizeBoardKey, normalizeBoardName } from '../lib/database.mjs';
import { AUTHOR_UPLOAD_LIMITS, canonicalAccountLocator, normalizeAccountLocator, normalizePlatform, validateSubmittedAccountId } from '../lib/author-spreadsheet.mjs';
import { normalizeBitableAuthorSource } from '../lib/author-source-provenance.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import vm from 'node:vm';

async function readFixture(value) {
  const result = await readBitable({ sourceTitle: '隔离测试', sourceUrl: 'https://x.feishu.cn/base/test',
    defaultBoard: '团团', baseToken: 'dummy', tableId: 'dummy' }, { command: '/fake',
    commandRunner: async () => ({ stdout: JSON.stringify({ ok: true, data: {
      fields: ['抖音昵称', '抖音号', '作品链接'], data: [['作者', 'user123', value]],
      record_id_list: ['recRecord1'], rev: 1, has_more: false,
    } }) }) });
  return result.rows[0];
}

test('bitable retains full official video identity instead of needs_locator', async () => {
  const row = await readFixture('https://www.douyin.com/video/7684675001341005096');
  assert.equal(row.videoId, '7684675001341005096');
  assert.equal(row.status, 'resolvable');
});

test('bitable retains official profile identity', async () => {
  const row = await readFixture('https://www.douyin.com/user/MS4wLjABAAAATestCanonical111');
  assert.equal(row.locator, 'MS4wLjABAAAATestCanonical111');
});

test('bitable retains official link hidden behind descriptive rich text', async () => {
  const row = await readFixture([{ text: '点击查看作品', link: 'https://v.douyin.com/test123/' }]);
  assert.equal(row.shareUrl, 'https://v.douyin.com/test123/');
});

const table = (fields, values, options = {}) => mapBitableAuthorRows({ fields,
  rows: values.map((value, i) => ({ values: value, recordId: `recRecord${i + 1}` })), defaultBoard: '团团', ...options });

test('adapter preserves Bilibili and Xiaohongshu platforms instead of forcing Douyin', async () => {
  const rows = await table(['作者', '平台', '主页链接'], [
    ['B站作者', 'B站', 'https://space.bilibili.com/123456'],
    ['小红书作者', '小红书', 'https://www.xiaohongshu.com/user/profile/5abcdef123456789abcdef12'],
  ]);
  assert.deepEqual(rows.map(r => [r.platform, r.locator, r.status]), [
    ['bilibili', '123456', 'ready'], ['xiaohongshu', 'https://www.xiaohongshu.com/user/profile/5abcdef123456789abcdef12', 'ready'],
  ]);
});

test('Bilibili works infer platform and retain case-sensitive BV identity', async () => {
  const [row] = await table(['作者', '视频链接'], [['作者', { text: '作品', url: 'https://www.bilibili.com/video/BV1xx411c7mD' }]]);
  assert.equal(row.platform, 'bilibili'); assert.equal(row.videoId, 'BV1xx411c7mD'); assert.equal(row.status, 'resolvable');
});

test('explicit unsupported and cross-platform declarations remain blocked', async () => {
  const rows = await table(['作者', '平台', '抖音号', '主页链接'], [
    ['作者', '快手', 'someone', 'https://www.douyin.com/user/MS4wLjABAAAATestCanonical111'],
    ['作者', 'B站', 'someone', 'https://space.bilibili.com/123456'],
  ]);
  assert.ok(rows.every(r => r.status === 'identity_conflict'));
  assert.deepEqual(buildAuthorEvidenceRequests(rows), []);
});

for (const url of ['http://www.douyin.com/video/7684675001341005096',
  'https://user:password@www.douyin.com/video/7684675001341005096',
  'https://www.douyin.com:8080/video/7684675001341005096',
  'https://www.douyin.com.evil.test/video/7684675001341005096']) {
  test(`untrusted work URL is not evidence: ${new URL(url).host}`, async () => {
    const [row] = await table(['作者', '作品链接'], [['作者', { text: '作品', url }]]);
    assert.equal(row.videoId, null); assert.equal(row.shareUrl, ''); assert.equal(row.locator, null);
    assert.equal(row.status, 'needs_locator');
  });
}

test('unrelated captions, notes and author display-name hyperlinks cannot select another account', async () => {
  const [row] = await table(['作者', '抖音号', '作品正文', '备注'], [[
    { text: '本人', link: 'https://www.douyin.com/user/MS4wLjABAAAAOtherCanonical111' }, 'mine',
    '合作： https://www.douyin.com/video/7684675001341005096',
    { text: '请看备注', url: 'https://v.douyin.com/other/' },
  ]]);
  assert.equal(row.name, '本人'); assert.equal(row.status, 'needs_locator');
  assert.equal(row.notes, '请看备注'); assert.equal(row.videoId, null); assert.equal(row.shareUrl, '');
});

test('multiple different links and canonical identities fail closed without choosing the first', async () => {
  const [shares] = await table(['作者', '作品链接'], [['作者', [
    { text: '第一条', link: 'https://v.douyin.com/first/' }, { text: '第二条', link: 'https://v.douyin.com/second/' },
  ]]]);
  assert.equal(shares.status, 'needs_locator'); assert.match(shares.reason, /2 条不同/);
  const [profiles] = await table(['作者', '主页链接'], [['作者', [
    { url: 'https://www.douyin.com/user/MS4wLjABAAAAFirstCanonical111' },
    { url: 'https://www.douyin.com/user/MS4wLjABAAAAOtherCanonical111' },
  ]]]);
  assert.equal(profiles.status, 'identity_conflict');
});

test('scalar and rich-text shapes never turn null or objects into fabricated identifiers', async () => {
  const rows = await table(['作者', '抖音号', '作品链接'], [
    ['作者一', null, null], ['作者二', { unknown: 'fake-id' }, [{ junk: 'https://v.douyin.com/hidden/' }]],
    ['作者三', { value: 'valid-id' }, { text: '作品', hyperlink: 'https://v.douyin.com/actual/' }],
  ]);
  assert.equal(rows[0].douyinId, ''); assert.equal(rows[1].douyinId, '');
  assert.equal(rows[1].status, 'needs_locator'); assert.equal(rows[2].douyinId, 'valid-id');
  assert.equal(rows[2].shareUrl, 'https://v.douyin.com/actual/');
});

test('field aliases preserve existing categories and human notes without machine provenance noise', async () => {
  const [row] = await table(['抖音名称', '抖音号/ID', '视频链接', '内容类型选项', '备注', '负责人'], [[
    '作者', 'id123', 'https://v.douyin.com/actual/', [{ name: 'ai二创' }, { name: '切片' }], '保留原人工备注', '运营',
  ]]);
  assert.equal(row.name, '作者'); assert.equal(row.douyinId, 'id123');
  assert.equal(row.category, 'ai二创、切片'); assert.equal(row.boards[0].category, 'ai二创、切片');
  assert.equal(row.notes, '保留原人工备注'); assert.equal(row.boards[0].note, row.notes);
  assert.equal(row.sourceRecordId, 'recRecord1'); assert.equal(row.sourceRow, 1); assert.equal(row.owner, '运营');
  assert.doesNotMatch(row.notes, /revision=|record_id=|源行=/);
});

test('blank rows preserve subsequent physical row / record correspondence', async () => {
  const rows = await table(['作者', '抖音号'], [['首行', 'one'], [null, null], ['第三行', 'three']]);
  assert.deepEqual(rows.map(r => [r.sourceRow, r.sourceRecordId]), [[1, 'recRecord1'], [3, 'recRecord3']]);
});

test('malformed rows and oversized collections fail rather than claiming partial import', async () => {
  await assert.rejects(table(['作者'], [['author', 'extra']]), /结构与字段不一致/);
  await assert.rejects(mapBitableAuthorRows({ fields: ['作者'], rows: [{ values: null }] }), /结构/);
  await assert.rejects(table(['作者', '作品链接'], [['作者', Array(101).fill('url')]]), /上限/);
  await assert.rejects(table(['作者'], Array.from({ length: 5001 }, () => ['作者'])), /未只导入/);
  await assert.rejects(table(['作者', '抖音号'], [['作者', 7684675001341005096]]), /无法精确表示/);
  await assert.rejects(table(['作者', '抖音号'], [['作者', { value: 7684675001341005096 }]]), /无法精确表示/);
  await assert.rejects(table(['作者', '作品链接'], [['作者', `${'说明'.repeat(501)} https://v.douyin.com/one/ https://v.douyin.com/two/`]]), /未截断/);
  assert.deepEqual(await mapBitableAuthorRows({ fields: ['作者'], rows: [] }), []);
});

test('malformed or incomplete pagination cannot masquerade as a successful complete table', async () => {
  const source = { baseToken: 'dummy', tableId: 'dummy' };
  const read = pages => { let index = 0; return readBitable(source, { command: '/fake',
    commandRunner: async () => ({ stdout: JSON.stringify({ ok: true, data: pages[index++] }) }) }); };
  await assert.rejects(read([{ fields: ['作者'], data: null }]), /错误响应视为空表/);
  await assert.rejects(read([{ fields: ['作者'], data: [['本人']], record_id_list: ['recRecord1'], rev: 10, has_more: true },
    { fields: ['作者'], data: [], record_id_list: [], rev: 10, has_more: true }]), /不完整读取/);
  await assert.rejects(read([{ fields: ['作者', '抖音号'], data: [['本人', 'mine']], record_id_list: ['recRecord1'], rev: 10, has_more: true },
    { fields: ['抖音号', '作者'], data: [['mine', '本人']], record_id_list: ['recRecord2'], rev: 10, has_more: false }]), /分页字段发生变化/);
  await assert.rejects(read([{ fields: ['作者'], data: [['本人']], record_id_list: ['recRecord1'], rev: 10, has_more: true },
    { fields: ['作者'], data: [['其他人']], record_id_list: ['recRecord2'], rev: 11, has_more: false }]), /修订号发生变化/);
  await assert.rejects(read([{ fields: ['作者'], data: [['本人']], record_id_list: [], rev: 10, has_more: false }]), /记录 ID/);
  await assert.rejects(read([{ fields: ['作者'], data: [['本人'], ['其他人']], record_id_list: ['recRecord1', 'recRecord1'], rev: 10, has_more: false }]), /记录 ID/);
});

test('reader preserves complete raw source checksum and uses provenance without editable notes', async () => {
  const fields = ['作者', '作品链接'], data = [['本人', { text: '作品', link: 'https://v.douyin.com/actual/' }]];
  const recordId = 'recRecordOriginal';
  const source = { sourceTitle: '原始来源', sourceUrl: 'https://x.feishu.cn/base/test', defaultBoard: '团团', baseToken: 'dummy', tableId: 'dummy' };
  const read = revision => readBitable(source, { command: '/fake', commandRunner: async () => ({ stdout: JSON.stringify({ ok: true,
    data: { fields, data, record_id_list: [recordId], rev: revision, has_more: false } }) }) });
  const first = await read(1), second = await read(2);
  const hash = createHash('sha256').update(JSON.stringify({ fields, rows: [{ values: data[0], recordId }] })).digest('hex');
  assert.equal(first.sourceSha256, hash); assert.equal(second.sourceSha256, hash);
  assert.equal(first.rows[0].notes, ''); assert.equal(second.rows[0].boards[0].note, '');
  assert.deepEqual(first.rows, second.rows, 'revision changes alone do not become user-note changes');
});

test('immutable queue source receipts preserve each record association without changing identity or old source', async t => {
  const db = new MonitorDatabase(':memory:'); t.after(() => db.close());
  const rows = await table(['作者', '抖音号', '作品链接'], [
    ['作者', 'id123', 'https://v.douyin.com/actual/'], ['作者', 'id123', 'https://v.douyin.com/actual/'],
  ]);
  const requests = buildAuthorEvidenceRequests(rows);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].sourceRecords, [{ sourceRow: 1, sourceRecordId: 'recRecord1' }, { sourceRow: 2, sourceRecordId: 'recRecord2' }]);
  db.enqueueAuthorResolutions(requests, { fileName: 'source.json', sheetName: '数据表' });
  const before = db.db.prepare('SELECT * FROM author_resolution_import_sources ORDER BY id').all();
  assert.deepEqual(JSON.parse(before[0].payload_json).sourceRecords, requests[0].sourceRecords);
  const claim = db.claimDueAuthorResolutions(1, { owner: 'record-worker' })[0];
  const beforeQueue = db.db.prepare('SELECT * FROM author_resolution_queue WHERE id=?').get(claim.id);
  const changed = buildAuthorEvidenceRequests([{ ...rows[0], sourceRecordId: 'recAnotherRecord' }]);
  assert.equal(changed[0].key, requests[0].key, 'record IDs are provenance, never new author identity');
  db.enqueueAuthorResolutions(changed, { fileName: 'source-new.json', sheetName: '数据表' });
  const after = db.db.prepare('SELECT * FROM author_resolution_import_sources ORDER BY id').all();
  assert.deepEqual(after[0], before[0]); assert.equal(after.length, 2);
  assert.equal(JSON.parse(after[1].payload_json).sourceRecords[0].sourceRecordId, 'recAnotherRecord');
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM author_resolution_queue').get().n, 1);
  const afterQueue = db.db.prepare('SELECT * FROM author_resolution_queue WHERE id=?').get(claim.id);
  assert.equal(afterQueue.lease_owner, beforeQueue.lease_owner);
  assert.equal(afterQueue.evidence_version, beforeQueue.evidence_version);
  assert.equal(afterQueue.source_rows_json, beforeQueue.source_rows_json);
});

test('invalid or unrelated record references are not retained as source associations', async t => {
  const db = new MonitorDatabase(':memory:'); t.after(() => db.close());
  const [row] = await table(['作者', '作品链接'], [['作者', 'https://v.douyin.com/actual/']]);
  const [request] = buildAuthorEvidenceRequests([{ ...row, sourceRecordId: 'https://evil.test' }]);
  assert.equal(request.sourceRecords, undefined);
  request.sourceRecords = [{ sourceRow: 2, sourceRecordId: 'recOtherRow' }, { sourceRow: 1, sourceRecordId: 'invalid' }];
  db.enqueueAuthorResolutions([request], { fileName: 'source.json', sheetName: '数据表' });
  const payload = JSON.parse(db.db.prepare('SELECT payload_json FROM author_resolution_import_sources').get().payload_json);
  assert.equal(payload.sourceRecords, undefined);
});

test('actual server sanitize, deferred evidence and direct import preserve explicit record provenance', async () => {
  const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const start = server.indexOf('function sourceBoards('), end = server.indexOf('function hydratePreviouslyVerifiedAuthors(');
  assert.ok(start >= 0 && end > start);
  const scope = vm.createContext({ URL, Date, Buffer, basename, normalizeBoardName, normalizeBoardKey,
    AUTHOR_UPLOAD_LIMITS, normalizeAccountLocator, normalizePlatform, canonicalAccountLocator, validateSubmittedAccountId, normalizeBitableAuthorSource,
    buildAuthorEvidenceRequests });
  vm.runInContext(`${server.slice(start, end)}\nthis.sanitize=sanitizeAuthorJobRow;this.importRows=importableAuthorTargets;`, scope);
  const [raw] = await table(['作者', '作品链接'], [['作者', 'https://v.douyin.com/actual/']]);
  const sanitized = scope.sanitize(raw);
  assert.equal(sanitized.sourceRecordId, 'recRecord1');
  const requests = buildAuthorEvidenceRequests([sanitized]);
  const deferred = applyAuthorEvidence([sanitized], { items: requests.map(item => ({ key: item.key, status: 'deferred', networkAttempted: false, candidates: [], errors: [] })) });
  assert.equal(deferred.rows[0].sourceRecordId, 'recRecord1');
  assert.equal(buildAuthorEvidenceRequests(deferred.rows)[0].sourceRecords[0].sourceRecordId, 'recRecord1');
  const [direct] = await table(['作者', '主页链接'], [['作者', 'https://www.douyin.com/user/MS4wLjABAAAATestCanonical111']]);
  const result = scope.importRows({ rows: [scope.sanitize(direct)], fileName: 'source.json', sheetName: '数据表',
    sourceType: 'lark-bitable', sourceUrl: 'https://x.feishu.cn/base/TableId12345', sourceTitle: '测试', sourceRevision: 1,
    sourceSheetId: 'tblRecordTable123', sourceSha256: 'a'.repeat(64), sourceReadAt: new Date().toISOString() }, []);
  assert.equal(result.inputs.length, 1);
  assert.equal(result.inputs[0].metadata.importSource.sourceRecordId, 'recRecord1');
  assert.equal(result.inputs[0].metadata.importSource.sourceRow, 1);
});
