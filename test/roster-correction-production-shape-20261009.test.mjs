import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import { normalizeBoardKey, normalizeBoardName } from '../lib/database.mjs';
import { normalizePlatform, normalizeAccountLocator, validateSubmittedAccountId } from '../lib/author-spreadsheet.mjs';
import { prepareAuthorBoardImport } from '../lib/author-board-import.mjs';
import { buildMasterRosterSnapshot, installMasterRoster } from '../lib/master-roster.mjs';
import { prepareMasterRosterSupplement, masterRosterSupplementRequestSha256, assertMasterRosterSupplementJob } from '../lib/master-roster-supplement.mjs';

const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const span = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const context = vm.createContext({ URL, normalizeBoardKey, normalizeBoardName, normalizePlatform, normalizeAccountLocator, validateSubmittedAccountId });
vm.runInContext(span('function sourceBoards(', 'function rowHasOwnershipEvidence(')
  + span('const AUTHOR_PUBLIC_EVIDENCE_HOSTS', 'function safeBlockedAuthorEvidence(')
  + ';globalThis.sanitize = sanitizeAuthorJobRow;', context);
function fixture(t, boards) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE targets(id INTEGER PRIMARY KEY,type TEXT,provider TEXT,metadata_json TEXT,locator TEXT,label TEXT,enabled INTEGER);
    CREATE TABLE author_resolution_jobs(id TEXT PRIMARY KEY,status TEXT,request_json TEXT,result_json TEXT,created_at TEXT,finished_at TEXT,error TEXT);`);
  const snapshot = buildMasterRosterSnapshot({ exportedAt: '2026-10-02T17:17:32.047Z', entities: [{
    key: 'source-row85', platform: 'douyin', names: ['51058454595'], ids: ['没有后悔药'], sources: [{ file: 'fixture.xlsx', rows: ['85'] }], boards,
  }] }, { sha256: 'a'.repeat(64), fileName: 'fixture.xlsx' });
  installMasterRoster(db, snapshot);
  return { db, input: { workbookSha256: snapshot.workbook.sha256, entryKey: snapshot.items[0].key,
    evidence: 'https://v.douyin.com/xglrKXGaNFU/', correctedAccountId: '51058454595' } };
}
const productionBoards = [{ name: '一条小团团切片矩阵', category: '原创(手书、漫画、3d等)', tier: '', organization: '' },
  { name: '一条小团团切片矩阵', category: '', tier: '', organization: '' }];
function requestFor(prepared) {
  return { fileName: prepared.fileName, sheetName: prepared.sheetName, masterRosterSupplement: prepared.masterRosterSupplement,
    rows: prepareAuthorBoardImport(prepared.rows, prepared).rows.map(context.sanitize) };
}

test('production row85 shape: duplicate same-name empty board survives actual server sanitizer before worker assertion', async t => {
  const f = fixture(t, productionBoards), frozen = f.db.prepare('SELECT * FROM master_roster_entries').all();
  const p = await prepareMasterRosterSupplement(f.db, f.input), request = requestFor(p);
  assert.equal(p.rows[0].boards.length, 1);
  assert.equal(p.rows[0].boards[0].category, productionBoards[0].category);
  assert.equal(masterRosterSupplementRequestSha256(request), p.masterRosterSupplement.requestSha256);
  assert.doesNotThrow(() => assertMasterRosterSupplementJob(f.db, { id: 'corrected-new-job', request }));
  assert.deepEqual(f.db.prepare('SELECT * FROM master_roster_entries').all(), frozen);
  const tampered = structuredClone(request); tampered.rows[0].boards[0].category = '未授权变更';
  assert.throws(() => assertMasterRosterSupplementJob(f.db, { id: 'tampered', request: tampered }));
});

test('duplicate complementary metadata coalesces without dropping nonempty fields or changing source records', async t => {
  const f = fixture(t, [{ name: '矩阵Ａ', category: '', tier: 'A' }, { name: '矩阵A', category: '切片', organization: '机构甲' }]);
  const p = await prepareMasterRosterSupplement(f.db, f.input), request = requestFor(p);
  assert.equal(p.rows[0].boards.length, 1);
  assert.equal(p.rows[0].boards[0].category, '切片'); assert.equal(p.rows[0].boards[0].tier, 'A');
  assert.equal(p.rows[0].boards[0].organization, '机构甲');
  assert.equal(masterRosterSupplementRequestSha256(request), p.masterRosterSupplement.requestSha256);
});

test('conflicting duplicate classifications are rejected, not silently merged to make a checksum pass', async t => {
  const f = fixture(t, [{ name: '团团矩阵', category: '原创' }, { name: '团团矩阵', category: '切片' }]);
  await assert.rejects(prepareMasterRosterSupplement(f.db, f.input), /板块.*冲突/);
});

test('old failed request with the former duplicate-board signature is still invalid and is not repaired on read', async t => {
  const f = fixture(t, productionBoards), p = await prepareMasterRosterSupplement(f.db, f.input);
  const oldUnsigned = structuredClone(p.rows);
  oldUnsigned[0].boards.push({ ...oldUnsigned[0].boards[0], category: '' });
  const oldRequest = requestFor(p);
  oldRequest.masterRosterSupplement = { ...p.masterRosterSupplement, requestSha256: masterRosterSupplementRequestSha256(oldUnsigned) };
  const before = JSON.stringify(oldRequest);
  assert.throws(() => assertMasterRosterSupplementJob(f.db, { id: 'old-failed', request: oldRequest }), /凭证/);
  assert.equal(JSON.stringify(oldRequest), before);
});
