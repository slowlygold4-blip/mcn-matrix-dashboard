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

test('publication register headers retain work counters and identities without inventing dates', () => {
  const result = readWorkSourceWorkbook(book({ '开播后': [
    ['抖音名字', '账号ID', '发布链接', '点赞', '播放量', '截图', '运营人'],
    ['作者甲', 'handle-a', `https://www.douyin.com/video/${id}`, 72, 6368, '', '运营甲'],
    ['作者乙', 'handle-b', 'https://v.douyin.com/register/', 0, 0, '', '运营乙'],
    ['作者丙', 'handle-c', 'https://v.douyin.com/missing/', '', '', '', '运营丙'],
  ] }));
  assert.equal(result.facts.length, 3);
  assert.equal(result.rejected.length, 0);
  const [direct, short, missing] = result.facts;
  assert.equal(direct.authorName, '作者甲');
  assert.equal(direct.accountId, 'handle-a');
  assert.equal(direct.contentId, id);
  assert.equal(direct.likes, 72);
  assert.equal(direct.plays, 6368);
  assert.equal(short.contentId, null);
  assert.equal(short.likes, 0);
  assert.equal(short.plays, 0);
  assert.equal(missing.likes, null);
  assert.equal(missing.plays, null);
  assert.ok(result.facts.every(fact => fact.publishedOn === null && fact.metricDate === null));
  assert.equal(result.summary.unresolvedLinks, 2);
  assert.equal(result.summary.datedMeasurements, 0);
});

test('actual creator registration headers retain nickname, work publication date and likes independently of the source refresh',()=>{
 const result=readWorkSourceWorkbook(book({'登记':[
  ['AI作者视频申报数据登记表(激励计划)'],['建议发布作品后先填基本信息，后续再填数据（9.12-10.12内需填写完整）'],
  ['抖音昵称','抖音号','作品链接','作品发布时间','点赞量','播放量','作品数据截图','审核结果'],
  ['作者甲','handle-a',`https://www.douyin.com/video/${id}`,'2026-09-12',0,'1.2万','',''],
  ['作者乙','handle-b','https://v.douyin.com/register/','2026-09-13','15','','',''],
 ]}));
 assert.equal(result.facts.length,2);const [first,second]=result.facts;
 assert.equal(first.authorName,'作者甲');assert.equal(first.accountId,'handle-a');assert.equal(first.contentId,id);
 assert.equal(first.publishedOn,'2026-09-12');assert.equal(first.likes,0);assert.equal(first.plays,12000);
 assert.equal(second.authorName,'作者乙');assert.equal(second.publishedOn,'2026-09-13');assert.equal(second.likes,15);assert.equal(second.plays,null);
 assert.ok(result.facts.every(f=>f.metricDate===null));assert.equal(result.summary.datedMeasurements,0);
 assert.equal(result.facts[0].row,4);assert.equal(result.facts[1].row,5);
});
test('like-only registration headers are data while colliding like aliases remain ambiguous',()=>{
 const result=readWorkSourceWorkbook(book({'登记':[['抖音昵称','抖音号','作品链接','作品发布时间','点赞量'],['作者','handle',`https://www.douyin.com/video/${id}`,'2026-09-12',7]]}));
 assert.equal(result.facts.length,1);assert.equal(result.facts[0].likes,7);assert.equal(result.facts[0].plays,null);
 assert.throws(()=>readWorkSourceWorkbook(book({'重复':[['作品链接','点赞量','点赞'],[`https://www.douyin.com/video/${id}`,1,2]]})),/ambiguous-source-header/);
});
test('registration month/day uses its declared period and the same-sheet calendar year, with one shared proof rather than a made-up sampling day',()=>{
 const result=readWorkSourceWorkbook(book({'登记':[
  ['登记表2027不是发布日期年份'],['9.12-10.12内需填写完整'],
  ['作品链接','作品发布时间','点赞量','数据日期'],
  [`https://www.douyin.com/video/${id}`,'2026-09-12',0,''],
  [`https://www.douyin.com/video/${other}`,'9月13',8,'9月13'],
  ['https://v.douyin.com/decimal/',9.14,4,''],
  ['https://v.douyin.com/ambiguous/',9.3,7,''],
 ]}));
 assert.deepEqual(result.facts.map(f=>f.publishedOn),['2026-09-12','2026-09-13','2026-09-14',null]);
 const context=result.sheets[0].publicationCalendar;assert.equal(context.start,'2026-09-12');assert.equal(context.end,'2026-10-12');assert.equal(context.anchors.length,1);
 assert.equal(result.facts[1].publicationDateResolution.contextSha256,context.sha256);assert.equal(result.facts[1].publicationDateResolution.originalValue,'9月13');
 assert.equal(result.facts[2].publicationDateResolution.originalValue,9.14);assert.equal(Object.hasOwn(result.facts[0],'publicationDateResolution'),false);
 assert.ok(result.facts.every(f=>f.metricDate===null));assert.equal(result.facts[3].rawDateValues.publishedOn,'9.3');assert.equal(result.summary.datedMeasurements,0);
});
test('missing calendar anchors, conflicting years, absent or ambiguous period and outside-period month/day remain unguessed',()=>{
 for(const variant of ['no-anchor','multiple-years','no-period','two-periods','outside-period']){
  const notes=variant==='no-period'?'普通登记说明':variant==='two-periods'?'9.12-10.12 或 10.15-11.15':'9.12-10.12';
  const rows=[[notes],['作品链接','作品发布时间','点赞量']];
  if(variant!=='no-anchor')rows.push([`https://www.douyin.com/video/${id}`,'2026-09-12',0]);
  if(variant==='multiple-years')rows.push([`https://www.douyin.com/video/${other}`,'2025-09-12',0]);
  rows.push(['https://v.douyin.com/month/',variant==='outside-period'?'10月13日':'9月13',5]);
  const result=readWorkSourceWorkbook(book({'登记':rows})),last=result.facts.at(-1);
  assert.equal(last.publishedOn,null,variant);assert.equal(last.likes,5);assert.equal(last.dateIssues[0].field,'publishedOn');assert.equal(Object.hasOwn(last,'publicationDateResolution'),false);
 }
});
test('real read cutoff excludes future typos from both date fields and calendar anchors, without replacing raw cells or using the clock as a year',()=>{
 const input=book({'登记':[['9.12-10.12'],['作品链接','作品发布时间','点赞量','数据日期'],
  [`https://www.douyin.com/video/${id}`,'2026-09-12',0,''],
  ['https://v.douyin.com/future/','2029-09-13',5,'2029-09-13'],
  ['https://v.douyin.com/month/','9月13',6,''],
 ]});
 const raw=Buffer.from(input),result=readWorkSourceWorkbook(input,{asOf:'2026-10-31T00:00:00.000Z'});
 assert.equal(result.facts[1].publishedOn,null);assert.equal(result.facts[1].metricDate,null);assert.equal(result.facts[1].likes,5);
 assert.equal(result.facts[1].rawDateValues.publishedOn,'2029-09-13');assert.ok(result.facts[1].dateIssues.every(issue=>issue.reason==='future-source-date'));
 assert.equal(result.facts[2].publishedOn,'2026-09-13');assert.equal(result.sheets[0].publicationCalendar.anchors.length,1);assert.ok(input.equals(raw),'the original workbook bytes are preserved');
 const after2029=readWorkSourceWorkbook(input,{asOf:'2030-10-31T00:00:00.000Z'});assert.equal(after2029.facts[2].publishedOn,null,'two now-past source years remain ambiguous; the current year supplies neither');
 const early=readWorkSourceWorkbook(input,{asOf:'2026-09-12T00:00:00.000Z'});assert.equal(early.facts[2].publishedOn,null);assert.equal(early.facts[2].dateIssues[0].reason,'future-source-date');
 assert.throws(()=>readWorkSourceWorkbook(input,{asOf:'invalid'}),/invalid-source-asof/);
});
test('register aliases still reject ambiguous headers and do not turn an author-only roster into works', () => {
  assert.throws(() => readWorkSourceWorkbook(book({ '重复表头': [
    ['账号ID', '抖音号', '发布链接', '点赞'], ['handle', 'handle', `https://www.douyin.com/video/${id}`, 1],
  ] })), /ambiguous-source-header/);
  const roster = readWorkSourceWorkbook(book({ '作者名册': [
    ['抖音名字', '账号ID', '发布链接'], ['作者', 'handle', `https://www.douyin.com/video/${id}`],
  ] }));
  assert.equal(roster.facts.length, 0);
  assert.equal(roster.sheets[0].status, 'unsupported-layout');
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
