import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAuthor } from '../lib/author-classification.mjs';

const keys = input => classifyAuthor(input).labels.map(item => item.key).sort();
test('theme source peer: explicit slice denial retains only original and the denied source', () => {
  const result = classifyAuthor({ category: '不是切片，只做原创' });
  assert.deepEqual(result.labels.map(x => x.key), ['original']);
  assert.equal(result.primaryKey, 'original');
  assert.ok(result.excludedEvidence.some(x => x.reason === 'explicit-content-negation' && x.term === '切片' && x.value.includes('不是切片')));
});
test('theme source peer: standalone explicit denials never become custom categories', () => {
  for (const category of ['非切片', '不是原创', '不做二创', '尚未做游戏', '暂无直播', '不是直播切片']) {
    assert.deepEqual(keys({ category }), [], category);
    assert.equal(classifyAuthor({ category }).needsReview, true);
  }
});
test('theme source peer: positive separate occurrences survive a local denial', () => {
  assert.deepEqual(keys({ category: '不是切片，只做原创；现在也做切片' }), ['original', 'slice']);
  assert.deepEqual(keys({ category: '原创、切片' }), ['original', 'slice']);
  assert.deepEqual(keys({ category: '非遗原创' }), ['original']);
  assert.deepEqual(keys({ category: '不是游戏，做直播热点' }), ['live-hotspot']);
});
test('theme source peer: AI compound and genuine double labels retain existing meaning', () => {
  assert.deepEqual(keys({ category: 'AI二创' }), ['ai-remix']);
  assert.deepEqual(keys({ category: '切片二创、AI二创' }), ['ai-remix', 'remix', 'slice']);
  assert.ok(!keys({ category: '不是AI二创，只做原创' }).includes('ai-remix'));
});
test('theme source peer: ownership requires source, not nickname or posts', () => {
  const input = { label: '团团切片', posts: [{ caption: '团团' }], metadata: { importSource: { fileName: '参与内容数据.xlsx', sheetName: '数据明细', sourceRow: 241 } } };
  assert.equal(classifyAuthor(input).theme.key, 'unassigned');
  assert.equal(classifyAuthor({ ...input, memberships: [{ board_name: '一条小团团切片矩阵' }] }).theme.key, 'tuantuan');
});
