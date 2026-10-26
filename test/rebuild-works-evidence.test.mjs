import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8');
const context = { ...model, fmt: model.formatNumber, URL, Date, Intl,
  document: { addEventListener() {} },
  location: { href: 'https://matrix.test/?period=week&theme=tuantuan&page=2#accounts' } };
runInNewContext(`${source.replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '')}
  this.subject = {renderWorksEvidence, worksEvidenceTime, safeWorkUrl};`, context);
const {renderWorksEvidence, worksEvidenceTime, safeWorkUrl} = context.subject;
const range = {start: '2026-09-22', end: '2026-09-28'};
const sample = value => ({value, basis: 'published_at', scope: 'observed-public-posts', asOfBasis: 'first_seen_at', asOf: '2026-09-28T12:35:00Z'});
const account = (value = 6, worksState = 'limited') => ({ metrics: {posts: {value:145,delta:2}}, publishedSamples:sample(value), collection:{date:range.end,worksState} });

test('real 477 case separates stock net +2, six publication samples and limited coverage', () => {
  const html = renderWorksEvidence({account:account(),recentWorks:[]},range);
  assert.match(html,/作品存量净变化.*\+2/s); assert.match(html,/本期已收录发布样本.*<strong>6<span> 条/s);
  assert.match(html,/2026-09-28 · 仅部分作品/); assert.match(html,/不等于新增发布量/);
  assert.match(html,/样本不代表全部发布量/); assert.match(html,/收录截止 2026\/09\/28 20:35/);
});
test('null, negative, noninteger, numeric string and wrong publication basis are unknown, never zero-filled', () => {
  for (const value of [null,undefined,-1,1.5,'6']) {
    const a=account();a.publishedSamples.value=value;
    const html = renderWorksEvidence({account:a},range);
    assert.match(html,/本期已收录发布样本<\/small><strong>—/);
    assert.doesNotMatch(html,/已收录 0 条/);
  }
  const a=account(6);a.publishedSamples.basis='first_seen_at';
  assert.match(renderWorksEvidence({account:a},range),/本期已收录发布样本<\/small><strong>—/);
});
test('known zero is a zero sample count, explicitly not a no-publication conclusion', () => {
  const html=renderWorksEvidence({account:account(0)},range);
  assert.match(html,/<strong>0<span> 条/); assert.match(html,/已收录 0 条不等于没有发布/);
});
test('wrong-day or missing works status stays unknown; complete never invents full history', () => {
  const a=account();a.collection.date='2026-09-27';
  assert.match(renderWorksEvidence({account:a},range),/作品范围未知/);
  assert.match(renderWorksEvidence({account:account(6,'complete')},range),/本次记录完整 · 历史范围未核验/);
  assert.doesNotMatch(renderWorksEvidence({account:account(6,'complete')},range),/全历史已完整|全量发布/);
});
test('recent works are capped, collapsed, and clearly not the selected-period total', () => {
  const recentWorks=Array.from({length:25},(_,i)=>({caption:`作品${i}`,publishedAt:'2026-08-01T00:00:00Z',lastObservedAt:'2026-09-28T10:00:00Z'}));
  const html=renderWorksEvidence({account:account(),recentWorks},range);
  assert.equal((html.match(/<li>/g)||[]).length,20); assert.match(html,/<details class="works-samples">/);
  assert.match(html,/不是本期发布全集，也不代表全部历史/); assert.match(html,/可能早于本期/);
  assert.match(html,/2026\/08\/01 08:00/);
});
test('untrusted titles are escaped and unsafe URLs are not clickable', () => {
  const urls=['javascript:alert(1)','http://douyin.com/video/1','//douyin.com/video/1','https://u:p@douyin.com/video/1'];
  for (const url of urls) assert.equal(safeWorkUrl(url),null);
  const html=renderWorksEvidence({account:account(),recentWorks:[{caption:'<img src=x onerror=alert(1)> "标题"',url:urls[0]},{caption:'安全',url:'https://www.douyin.com/video/1?a=1&b=2'}]},range);
  assert.doesNotMatch(html,/<img|href="javascript:|href="http:/); assert.match(html,/&lt;img/);
  assert.match(html,/href="https:\/\/www\.douyin\.com\/video\/1\?a=1&amp;b=2"/);
  assert.match(html,/target="_blank" rel="noopener noreferrer"/);
});
test('missing dates and no data do not throw or invent zero, and detail uses actual renderer', () => {
  assert.equal(worksEvidenceTime(null),'未知');assert.equal(worksEvidenceTime('not-a-date'),'未知');
  const html=renderWorksEvidence({account:{}},range);
  assert.match(html,/收录截止 未知/);assert.match(html,/暂无可展示.*缺采不等于没有发布/);
  assert.match(source,/\$\{renderWorksEvidence\(data, detailRange\)\}/);
  assert.match(source,/restoreAccountFocus\(\)/);
});
