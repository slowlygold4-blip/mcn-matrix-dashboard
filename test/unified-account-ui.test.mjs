import test from 'node:test';
import assert from 'node:assert/strict';
import { accountStateLabel, unifiedRosterCaption, sourceMetricCell, sourceFactsMarkup, sourceWorksMarkup } from '../public/unified-account-ui.js';
import { readNavigationState, writeNavigationState, sortAccounts } from '../public/console-model.js';

test('default accounts include source records and source filter/sort survive a reload', () => {
  assert.equal(readNavigationState('http://localhost/').enabled, 'all');
  for (const enabled of ['all', 'active', 'paused', 'source']) {
    const state = readNavigationState(`http://localhost/?enabled=${enabled}&sort=sourceSummary.cumulativeLikes`);
    assert.equal(readNavigationState(writeNavigationState('http://localhost/', state)).enabled, enabled);
    assert.equal(state.sort, 'sourceSummary.cumulativeLikes');
  }
});
test('source records are neither paused nor observed, and union caption partitions accurately', () => {
  const rows = [{enabled:true}, {enabled:false}, {enabled:false,sourceOnly:true}];
  assert.match(unifiedRosterCaption(rows), /名册记录 3 条 · 监控启用 1 · 暂停 1 · 表格资料 1/);
  assert.equal(accountStateLabel(rows[2]), '表格资料 · 未接通实时采样');
});
test('source sort supports both directions with unknown last and stable string identities', () => {
  const rows = [{id:'roster:a', sourceSummary:{works:null}}, {id:1,sourceSummary:{works:0}}, {id:'roster:b', sourceSummary:{works:5}}];
  assert.deepEqual(sortAccounts(rows,'sourceSummary.works','desc').map(a=>a.id), ['roster:b',1,'roster:a']);
  assert.deepEqual(sortAccounts(rows,'sourceSummary.works','asc').map(a=>a.id), [1,'roster:b','roster:a']);
});
test('table values preserve null, actual zero and source cumulative labels', () => {
  assert.match(sourceMetricCell({}, 'sourceSummary.works'), /—/);
  assert.match(sourceMetricCell({sourceSummary:{works:0}}, 'sourceSummary.works'), />0</);
  assert.match(sourceMetricCell({sourceSummary:{works:3}}, 'sourceSummary.works'), /非日增/);
});
test('source account details show own works with pagination and escape all imported text', () => {
  const html = sourceFactsMarkup({sourceSummary:{works:2,cumulativePlays:100,cumulativeLikes:1,authorKeys:['source-author:1:2','<script>'],sourceRevision:'<script>'}});
  assert.match(html,/source-author:1:2/); assert.doesNotMatch(html,/<script>/); assert.match(html,/不是日增长/);
  const work = sourceWorksMarkup({page:1,pages:2,total:31,items:[{title:'<img src=x onerror=alert(1)>', contentId:'123',publishedOn:null,cumulativePlays:null,cumulativeLikes:0}]},'source-author:1:2');
  assert.doesNotMatch(work,/<img/); assert.match(work,/data-source-works-page="2"/); assert.match(work,/>—</); assert.match(work,/>0</);
});
