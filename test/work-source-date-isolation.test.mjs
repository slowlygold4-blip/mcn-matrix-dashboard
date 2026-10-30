import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from '@e965/xlsx';
import { DatabaseSync } from 'node:sqlite';
import { readWorkSourceWorkbook, reconcileWorkSourceFacts } from '../lib/work-source-workbook.mjs';
import { commitWorkSourceEdition, verifyWorkSourceEdition, readKnownWorkSourceFacts } from '../lib/work-source-store.mjs';
const id = '7684947825248082873';
function input(publication, measurement, { format, date1904 = false } = {}) {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['视频id', '作者抖音号', '播放', '点赞', '发布日期', '统计日期'],
    [id, 'exact-handle', 20, 0, publication, measurement],
  ]);
  if (format) for (const cell of ['E2', 'F2']) if (sheet[cell]) sheet[cell].z = format;
  if (date1904) book.Workbook = { WBProps: { date1904: true } };
  XLSX.utils.book_append_sheet(book, sheet, '作品');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

test('an invalid publication date cannot erase a precise work ID, zero likes or valid measurement date', () => {
  const buffer = input('2026-02-30', '2026-10-29'), before = Buffer.from(buffer);
  const result = readWorkSourceWorkbook(buffer);
  assert.equal(result.facts.length, 1);
  const row = result.facts[0];
  assert.equal(row.contentId, id); assert.equal(row.accountId, 'exact-handle');
  assert.equal(row.likes, 0); assert.equal(row.plays, 20);
  assert.equal(row.publishedOn, null); assert.equal(row.metricDate, '2026-10-29');
  assert.deepEqual(row.dateIssues, [{ field: 'publishedOn', reason: 'invalid-source-date' }]);
  assert.equal(row.rawDateValues.publishedOn, '2026-02-30');
  assert.equal(result.rejected.length, 0); assert.equal(result.summary.rowsWithDateIssues, 1);
  assert.equal(result.summary.datedMeasurements, 1);
  assert.equal(buffer.equals(before), true);
  assert.equal(reconcileWorkSourceFacts(result.facts, []).summary.newWorks, 1);
});

test('an invalid measurement date does not erase the valid publication date or invent a sample date', () => {
  const result = readWorkSourceWorkbook(input('2026-09-12', 'yesterday'));
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].publishedOn, '2026-09-12');
  assert.equal(result.facts[0].metricDate, null);
  assert.equal(result.summary.datedMeasurements, 0);
  assert.deepEqual(result.facts[0].dateIssues, [{ field: 'metricDate', reason: 'invalid-source-date' }]);
});

test('both bad clocks retain work evidence and explicitly quarantine each date, never borrow publication or import time', () => {
  const result = readWorkSourceWorkbook(input('10/12/26', '2026-13-01'));
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].publishedOn, null); assert.equal(result.facts[0].metricDate, null);
  assert.equal(result.facts[0].dateIssues.length, 2);
  assert.equal(result.facts[0].likes, 0);
});

test('explicit year-first calendars and zoned timestamps use Beijing dates without inventing an observation instant', () => {
  const result = readWorkSourceWorkbook(input('2026/9/12', '2026-10-28T16:00:00Z'));
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].publishedOn, '2026-09-12');
  assert.equal(result.facts[0].metricDate, '2026-10-29');
  assert.equal(result.facts[0].observedAt, undefined);
  const offset = readWorkSourceWorkbook(input('2026-09-12T01:00:00+08:00', '2026-10-29T00:00:00+09:00'));
  assert.equal(offset.facts[0].publishedOn, '2026-09-12');
  assert.equal(offset.facts[0].metricDate, '2026-10-28');
});

test('typed Excel dates honor 1900/1904 calendar systems and do not depend on display locale or host timezone', () => {
  const serial = 46308, date = '2026-10-13';
  for (const date1904 of [false, true]) {
    const result = readWorkSourceWorkbook(input(serial - (date1904 ? 1462 : 0), serial - (date1904 ? 1462 : 0), { format: 'm/d/yy', date1904 }));
    assert.equal(result.facts.length, 1);
    assert.equal(result.facts[0].publishedOn, date); assert.equal(result.facts[0].metricDate, date);
  }
});

test('bare serials, impossible calendars, ambiguous dates and zoneless clocks remain unknown without losing counters', () => {
  for (const date of [46308, '2026/02/30', '12/10/2026', '2026-10-29T24:00:00Z', '2026-10-29 12:00:00', '2026-02-30T00:00:00Z']) {
    const result = readWorkSourceWorkbook(input(date, null));
    assert.equal(result.facts.length, 1, String(date));
    assert.equal(result.facts[0].publishedOn, null, String(date));
    assert.equal(result.facts[0].dateIssues.length, 1);
    assert.equal(result.facts[0].likes, 0);
  }
  const phantom = readWorkSourceWorkbook(input(60, null, { format: 'yyyy-mm-dd' }));
  assert.equal(phantom.facts[0].publishedOn, null, 'Excel 1900 leap-year fiction must not become a real date');
  for (const format of ['h:mm', '[h]:mm', 'h:mm "day"']) {
    const clockOnly = readWorkSourceWorkbook(input(46308, null, { format }));
    assert.equal(clockOnly.facts[0].publishedOn, null, 'time-only format does not establish a calendar date');
  }
});

test('already supported calendars and missing dates preserve their existing fact shape and do not create spurious issues', () => {
  const result = readWorkSourceWorkbook(input('2026-09-12', null));
  assert.equal(result.facts[0].publishedOn, '2026-09-12');
  assert.equal(result.facts[0].metricDate, null);
  assert.equal(Object.hasOwn(result.facts[0], 'dateIssues'), false);
  assert.equal(Object.hasOwn(result.facts[0], 'rawDateValues'), false);
  assert.equal(Object.hasOwn(result.summary, 'rowsWithDateIssues'), false);
});

test('field-isolated evidence survives an atomic edition commit and idempotent replay without changing platform samples', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE post_metrics(id INTEGER PRIMARY KEY,likes INTEGER,captured_at TEXT); INSERT INTO post_metrics VALUES(1,17,\'2026-10-28T00:00:00.000Z\')');
  const existing = db.prepare('SELECT * FROM post_metrics').all();
  const metadata = { url: 'https://fixture.feishu.cn/sheets/FixtureWorkbook123456', revision: 1,
    modifiedAt: '2026-10-29T00:00:00.000Z', title: '作品', sheets: [{ id: 'test1', name: '作品', region: 'A1:F2' }] };
  const buffer = input('bad date', '2026-10-29');
  const request = { buffer, before: metadata, after: metadata, readAt: '2026-10-30T00:00:00.000Z' };
  const now = () => Date.parse(request.readAt);
  const saved = commitWorkSourceEdition(db, request, { now });
  assert.equal(saved.status, 'imported'); assert.equal(saved.factCount, 1);
  assert.equal(verifyWorkSourceEdition(db, saved.versionId).validated, true);
  const recovered = readKnownWorkSourceFacts(db, { asOf: request.readAt });
  assert.equal(recovered.facts[0].likes, 0); assert.equal(recovered.facts[0].publishedOn, null);
  assert.equal(recovered.facts[0].metricDate, '2026-10-29');
  assert.equal(recovered.facts[0].rawDateValues.publishedOn, 'bad date');
  assert.equal(recovered.versions[0].report.summary.rowsWithDateIssues, 1);
  const replay = commitWorkSourceEdition(db, request, { now });
  assert.equal(replay.status, 'unchanged');
  assert.equal(db.prepare('SELECT count(*) n FROM work_source_versions').get().n, 1);
  assert.deepEqual(db.prepare('SELECT * FROM post_metrics').all(), existing);
  assert.equal(Buffer.from(db.prepare('SELECT content FROM work_source_artifacts').get().content).equals(buffer), true);
});
