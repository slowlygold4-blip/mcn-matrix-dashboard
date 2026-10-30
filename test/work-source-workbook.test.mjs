import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from '@e965/xlsx';
import JSZip from 'jszip';
import { sourceCounter, readWorkSourceWorkbook, reconcileWorkSourceFacts, bindWorkFactsToStoredSourceIds } from '../lib/work-source-workbook.mjs';

const id = '7684947825248082873', other = '7692714095128218918';
function book(tabs) {
  const workbook = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(tabs)) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

test('source counters preserve missing versus actual zero and unit display precision', () => {
  assert.deepEqual(sourceCounter(null), { value: null, representation: 'missing' });
  assert.deepEqual(sourceCounter('—'), { value: null, representation: 'missing' });
  assert.deepEqual(sourceCounter('0'), { value: 0, representation: 'integer' });
  assert.deepEqual(sourceCounter('145.5w'), { value: 1455000, representation: 'unit-display' });
  assert.equal(sourceCounter('86.5万').value, 865000);
  assert.equal(sourceCounter('1.001亿').value, 100100000);
  assert.equal(sourceCounter('1,234').value, 1234);
  for (const bad of [false, true, '1,2', '-1', '0.5', '1e12', Infinity, Number.MAX_SAFE_INTEGER + 1, '9007199254740992'])
    assert.throws(() => sourceCounter(bad));
});

test('public Douyin handle and stable UID remain different fields across source layouts', () => {
  const result = readWorkSourceWorkbook(book({
    '历史': [['视频id', '作者昵称', '作者id', '视频累计播放次数', '当天累积点赞数（端显值）'], [id, '同名', '2496354550303961', 100, 4]],
    '最新': [['作者抖音号', '作者昵称', '视频id', '视频累计播放次数', '视频累计获赞次数'], ['handle123', '同名', id, 120, 5]],
  }));
  assert.equal(result.facts.length, 2);
  assert.equal(result.facts[0].uid, '2496354550303961');
  assert.equal(result.facts[0].accountId, null);
  assert.equal(result.facts[1].accountId, 'handle123');
  assert.equal(result.facts[1].uid, null);
  assert.equal(result.facts[0].likes, 4);
  const comparison = reconcileWorkSourceFacts(result.facts, [{ contentId: id, plays: 120, likes: 5 }]);
  assert.equal(comparison.summary.uniqueWorks, 1);
  assert.equal(comparison.summary.repeatedWorkFacts, 1);
  assert.deepEqual(comparison.works[0].metrics.plays.sourceValues, [100, 120]);
  assert.equal(comparison.works[0].metrics.plays.status, 'multiple-source-values');
  assert.equal(comparison.works[0].metrics.plays.previous, 120);
  assert.equal(comparison.summary.dailyGrowthCalculated, false);
});

test('notes before headers retain physical rows; no date or author is inferred from content ID', () => {
  const result = readWorkSourceWorkbook(book({ '作品': [
    ['这是原始说明，不是数据'], ['抖音名', '抖音号', '视频链接', '点赞', '播放'],
    ['作者', 'handle', `https://www.douyin.com/video/${id}`, 0, '2.5万'],
    [], ['作者', 'handle', 'https://v.douyin.com/fixture/', null, null],
  ] }));
  assert.deepEqual(result.facts.map(row => row.row), [3, 5]);
  assert.equal(result.facts[0].publishedOn, null);
  assert.equal(result.facts[0].metricDate, null);
  assert.equal(result.facts[0].likes, 0);
  assert.equal(result.facts[1].likes, null);
  assert.equal(result.summary.unresolvedLinks, 1);
  assert.equal(result.summary.datedMeasurements, 0);
});

test('unsafe IDs, conflicting links and invalid counters are explicitly quarantined, not silently rounded', () => {
  const result = readWorkSourceWorkbook(book({ '作品': [
    ['视频id', '视频链接', '播放'],
    [Number(id), null, 12],
    [id, `https://www.douyin.com/video/${other}`, 20],
    [id, `https://www.douyin.com/video/${id}`, -4],
    [id, 'https://notdouyin.example/video/' + id, 5],
  ] }));
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].plays, null);
  assert.deepEqual(result.facts[0].metricIssues, [{ field: 'plays', reason: 'invalid-counter' }]);
  assert.equal(result.facts[0].rawMetricValues.plays, -4);
  assert.deepEqual(result.rejected.map(row => row.reason), [
    'unsafe-numeric-identity', 'conflicting-work-identities', 'invalid-work-url',
  ]);
  assert.equal(result.summary.populatedRows, 4);
});

test('modal links and visible short links retain both evidences without trusting self as author identity', () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([['视频链接', '点赞'], ['https://v.douyin.com/fixture/', 12]]);
  sheet.A2.l = { Target: `https://www.douyin.com/user/self?modal_id=${id}` };
  XLSX.utils.book_append_sheet(workbook, sheet, '作品');
  const result = readWorkSourceWorkbook(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  assert.equal(result.facts[0].contentId, id);
  assert.equal(result.facts[0].accountId, null);
  assert.equal(result.facts[0].evidenceUrls.length, 2);
});

test('conflicting modal IDs, including repeated query parameters, reject the work', () => {
  const result = readWorkSourceWorkbook(book({ '作品': [['视频链接', '点赞'],
    [`https://www.douyin.com/user/self?modal_id=${id}&modal_id=${other}`, 1]] }));
  assert.equal(result.facts.length, 0);
  assert.equal(result.rejected[0].reason, 'conflicting-work-identities');
});

test('ordinary share-copy text and punctuation use the existing official URL reader', () => {
  const result = readWorkSourceWorkbook(book({ '作品': [['视频链接', '点赞'],
    ['.https://v.douyin.com/fixture/ x@F.UY', 1], ['. https://v.douyin.com/other/ ', 2]] }));
  assert.equal(result.facts.length, 2);
  assert.equal(result.facts[0].url, 'https://v.douyin.com/fixture/');
});

test('multiple unbound short links, overlong evidence and misleading authorities fail closed', () => {
  const result = readWorkSourceWorkbook(book({ '作品': [['视频链接', '点赞'],
    ['https://v.douyin.com/one/ https://v.douyin.com/two/', 1],
    ['https://v.douyin.com/one/ ' + 'x'.repeat(1000) + ' https://v.douyin.com/two/', 1],
    ['https://www.douyin.com:443/video/' + id, 1],
    ['https://www.douyin.com@evil.example/video/' + id, 1]] }));
  assert.equal(result.facts.length, 0);
  assert.deepEqual(result.rejected.map(row => row.reason), ['ambiguous-work-links', 'oversized-work-link-evidence', 'invalid-work-url', 'invalid-work-url']);
});

test('an explicit metric date never substitutes for publication date', () => {
  const result = readWorkSourceWorkbook(book({ '作品': [
    ['视频id', '播放', '统计日期', '发布日期'],
    [id, 20, '2026-10-29', '2026-10-12'],
    [other, 21, '2026-02-30', '2026-10-12'],
  ] }));
  assert.equal(result.facts[0].metricDate, '2026-10-29');
  assert.equal(result.facts[0].publishedOn, '2026-10-12');
  assert.equal(result.facts[1].metricDate, null);
  assert.equal(result.facts[1].publishedOn, '2026-10-12');
  assert.deepEqual(result.facts[1].dateIssues, [{ field: 'metricDate', reason: 'invalid-source-date' }]);
  assert.equal(result.rejected.length, 0);
});

test('unsafe numeric author IDs do not erase a separately precise work ID and its counters', () => {
  const result = readWorkSourceWorkbook(book({ '作品': [
    ['视频id', '作者抖音号', '视频累计播放次数', '视频累计获赞次数'],
    [id, 24963545503039610, 37, 4],
  ] }));
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].contentId, id);
  assert.equal(result.facts[0].accountId, null);
  assert.equal(result.facts[0].plays, 37);
  assert.equal(result.summary.rowsWithIdentityIssues, 1);
  assert.deepEqual(result.facts[0].identityIssues, [{ field: 'accountId', reason: 'unsafe-numeric-identity' }]);
});

test('unsupported author summary sheets are visible in the read report and do not become works', () => {
  const result = readWorkSourceWorkbook(book({ '奖金': [['作者名', '抖音号', '获奖条数'], ['作者', 'handle', 4]] }));
  assert.equal(result.facts.length, 0);
  assert.equal(result.sheets[0].status, 'unsupported-layout');
  assert.equal(result.sheets[0].populatedRows, 2);
});

test('duplicate ambiguous headers and excessive sheet dimensions fail the batch', () => {
  const buffer = book({ '作品': [['视频id', '播放', '播放量'], [id, 1, 1]] });
  assert.throws(() => readWorkSourceWorkbook(buffer), /ambiguous-source-header/);
  assert.throws(() => readWorkSourceWorkbook(book({ '作品': [['视频id', '播放'], [id, 1]] }), { maxRows: 1 }), /range-exceeds-policy/);
});

test('canonical duplicate IDs fail rather than selecting an arbitrary owner', () => {
  assert.throws(() => reconcileWorkSourceFacts([], [{ contentId: id }, { contentId: id }]), /not-unique/);
  assert.throws(() => reconcileWorkSourceFacts([], [{ contentId: Number(id) }]), /invalid-canonical-work/);
  assert.throws(() => reconcileWorkSourceFacts([{ contentId: Number(id) }], []), /invalid-source-fact/);
});

test('a Feishu-style A1 dimension never truncates the actual worksheet cells', async () => {
  const buffer = book({ '作品': [['视频id', '播放'], [id, 30], [other, 40]] });
  const zip = await JSZip.loadAsync(buffer);
  const path = 'xl/worksheets/sheet1.xml';
  zip.file(path, (await zip.file(path).async('string')).replace(/<dimension ref="[^"]*"\s*\/>/, '<dimension ref="A1:A1"/>'));
  const result = readWorkSourceWorkbook(await zip.generateAsync({ type: 'nodebuffer' }));
  assert.equal(result.facts.length, 2);
  assert.deepEqual(result.facts.map(row => row.contentId), [id, other]);
});

test('empty-prefix rich shared strings retain the whole visible work URL', async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['视频链接', '点赞'], ['https://v.douyin.com/fixture/', 4]]), '作品');
  const zip = await JSZip.loadAsync(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', bookSST: true }));
  const path = 'xl/sharedStrings.xml', xml = await zip.file(path).async('string');
  const modified = xml.replace('<t>https://v.douyin.com/fixture/</t>', '<t></t><r><t>https://v.douyin.com/fixture/</t></r>');
  assert.notEqual(modified, xml);
  zip.file(path, modified);
  const result = readWorkSourceWorkbook(await zip.generateAsync({ type: 'nodebuffer' }));
  assert.equal(result.facts[0].url, 'https://v.douyin.com/fixture/');
});

test('stored explicit source pairs bind short links without requests or author verification', () => {
  const fact = { contentId: null, url: 'https://v.douyin.com/fixture/', plays: 20, likes: 3 };
  const provenance = { importId: 1, sheetId: '13', row: 9, rowSha256: 'a'.repeat(64) };
  const result = bindWorkFactsToStoredSourceIds([fact], [{ contentId: id, url: 'https://v.douyin.com/fixture', provenance }], new Set([id]));
  assert.equal(result.facts[0].contentId, id);
  assert.deepEqual(result.facts[0].contentIdEvidence.provenance, provenance);
  assert.equal(result.facts[0].authorIdentityVerified, false);
  assert.equal(result.summary.networkRequests, 0);
  assert.equal(fact.contentId, null, 'the source fact itself remains unchanged');
});

test('ambiguous stored mappings remain visible and never enter a metric reconciliation', () => {
  const fact = { contentId: null, url: 'https://v.douyin.com/fixture/', plays: 20, likes: 3 };
  const provenance = { importId: 1, sheetId: '13', row: 9, rowSha256: 'a'.repeat(64) };
  const result = bindWorkFactsToStoredSourceIds([fact], [id, other].map(contentId => ({ contentId, url: fact.url, provenance })), new Set([id, other]));
  assert.equal(result.facts[0].contentId, null);
  assert.equal(result.summary.conflicts, 1);
  assert.equal(reconcileWorkSourceFacts(result.facts, []).summary.uniqueWorks, 0);
});

test('unverifiable, unknown or query-different mappings cannot supply a video ID', () => {
  const fact = { contentId: null, url: 'https://v.douyin.com/fixture/?item=one' };
  const provenance = { importId: 1, sheetId: '13', row: 9, rowSha256: 'a'.repeat(64) };
  const cases = [
    { contentId: id, url: fact.url, provenance: { ...provenance, rowSha256: '' } },
    { contentId: id, url: 'https://v.douyin.com/fixture/?item=two', provenance },
    { contentId: id, url: fact.url, provenance: { ...provenance, sheetId: '08' } },
    { contentId: other, url: fact.url, provenance },
  ];
  for (const link of cases) assert.equal(bindWorkFactsToStoredSourceIds([fact], [link], new Set([id])).facts[0].contentId, null);
});
