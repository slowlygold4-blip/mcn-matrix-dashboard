import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { auditWorkbook, cellValue } from '../scripts/import-creator-library.mjs';
import { CreatorLibraryReader } from '../lib/creator-library.mjs';

function fixtureWorkbook() {
  const workbook = new ExcelJS.Workbook();
  const add = (name, rows) => { const sheet = workbook.addWorksheet(name); rows.forEach(row => sheet.addRow(row)); };
  add('01_总览', [
    ['指标', '数值'], ['覆盖作者账号', 1], ['去重作品', 1], ['作品累计播放', 17],
    ['播放缺失作品', 0], ['点赞缺失作品', 0], ['统计开始', '2026-09-10'], ['统计结束', '2026-10-12'],
  ]);
  add('05_赛道总览', [['赛道', '归属去重作品', '作者数', '累计播放'], ['切片激励', 1, 1, 17]]);
  add('08_作者总表', [['作者名', '主抖音号', '累计播放'], ['作者A', 'account_a', 17]]);
  // Real source positions: plays=8th column, likes=9th column, author plays=12th.
  workbook.getWorksheet('08_作者总表').getRow(2).getCell(12).value = 17;
  add('09_去重作品', [['ID'], ['123']]);
  workbook.getWorksheet('09_去重作品').getRow(2).getCell(8).value = 17;
  workbook.getWorksheet('09_去重作品').getRow(2).getCell(9).value = 2;
  add('16_账号别名合并', [['主账号', '并入账号'], ['account_a', 'account_a / alias_a']]);
  add('18_口径说明', [['主题', '说明'], ['缺测', '不填零']]);
  add('19_播放叠加查重', [['赛道', '收录作品', '收录累计播放', '归属作品', '归属累计播放', '多计作品', '多计播放'],
    ['四赛道相加', 1, 17, 1, 17, 0, 0], ['全局去重', 1, 17, 1, 17, 0, 0]]);
  return workbook;
}

test('source audit accepts balanced unique works and rejects double counting', () => {
  const workbook = fixtureWorkbook();
  assert.equal(auditWorkbook(workbook).knownCumulativePlays, 17);
  workbook.getWorksheet('09_去重作品').addRow(['123']);
  assert.throws(() => auditWorkbook(workbook), /重复作品 ID/);
});

test('formula without cached result is not silently converted to zero', () => {
  assert.equal(cellValue({ formula: 'IFERROR(A1/B1,0)' }), '=IFERROR(A1/B1,0)');
  assert.equal(cellValue(null), null);
  assert.equal(cellValue(0), 0);
});

test('reader keeps pagination, redacts restricted values and protects wildcard search', () => {
  const dir = mkdtempSync(join(tmpdir(), 'creator-library-test-'));
  const file = join(dir, 'library.sqlite');
  try {
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE source_sheets(sheet_id TEXT PRIMARY KEY,sheet_name TEXT,ordinal INTEGER,row_count INTEGER,headers_json TEXT,restricted INTEGER);
      CREATE TABLE source_rows(sheet_id TEXT,row_number INTEGER,values_json TEXT,search_text TEXT,public_search_text TEXT,PRIMARY KEY(sheet_id,row_number));
      CREATE TABLE account_links(author_row INTEGER,target_id INTEGER,matched_id TEXT,matched_at TEXT);`);
    const meta = db.prepare('INSERT INTO metadata VALUES(?,?)');
    for (const [key, value] of Object.entries({ audit: { authorCount: 1, candidateBonus: 20, announcedBonus: 10 }, sourceUrl: 'https://example.com', sourceSha256: 'abc', importedAt: '2026-10-22T00:00:00Z' })) meta.run(key, JSON.stringify(value));
    db.prepare('INSERT INTO source_sheets VALUES(?,?,?,?,?,?)').run('08', '08_作者总表', 0, 1, JSON.stringify(['作者名', '主抖音号', ...Array(14).fill('其他'), '公示奖金', '候选奖金']), 0);
    db.prepare('INSERT INTO source_sheets VALUES(?,?,?,?,?,?)').run('10', '10_原始', 1, 1, JSON.stringify(['微信号']), 1);
    db.prepare('INSERT INTO source_rows VALUES(?,?,?,?,?)').run('08', 2, JSON.stringify(['作者%', 'account_a', ...Array(14).fill(null), 10, 20]), '作者% account_a 10 20', '作者% account_a');
    db.prepare('INSERT INTO source_rows VALUES(?,?,?,?,?)').run('10', 2, JSON.stringify(['secret']), 'secret', 'secret');
    db.prepare('INSERT INTO account_links VALUES(?,?,?,?)').run(2, 99, 'account_a', '2026-10-22T00:00:00Z');
    db.close();
    const reader = new CreatorLibraryReader(file);
    const publicRow = reader.rows({ sheetId: '08', admin: false }).rows[0];
    assert.deepEqual(publicRow.targetIds, [99]);
    assert.equal(publicRow.values[16], null);
    assert.equal(publicRow.values[17], null);
    assert.equal(reader.rows({ sheetId: '10', admin: false }).statusCode, 403);
    assert.equal(reader.rows({ sheetId: '08', admin: true }).rows[0].values[17], 20);
    assert.equal(reader.rows({ sheetId: '08', linkStatus: 'linked' }).total, 1);
    assert.equal(reader.rows({ sheetId: '08', linkStatus: 'unlinked' }).total, 0);
    assert.equal(reader.searchAll({ query: '作者%', admin: false }).total, 1);
    assert.equal(reader.searchAll({ query: 'secret', admin: false }).total, 0);
    assert.equal(reader.searchAll({ query: 'secret', admin: true }).total, 1);
    assert.equal(reader.searchAll({ query: '20', admin: false }).total, 0);
    assert.equal(reader.searchAll({ query: '20', admin: true }).total, 1);
    assert.equal(reader.summary({ admin: false }).audit.candidateBonus, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
