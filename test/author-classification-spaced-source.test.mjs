import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAuthor } from '../lib/author-classification.mjs';

const keys = input => classifyAuthor(input).labels.map(label => label.key);

test('explicit spaced category tokens support the real slice plus AI source', () => {
  for (const category of ['切 片+A I', '切　片＋Ａ　Ｉ', '切 片 / A I', '切\t片+A\tI']) {
    const result = classifyAuthor({ category });
    assert.deepEqual(result.labels.map(label => label.key).sort(), ['ai-remix', 'slice']);
    assert.ok(result.evidence.every(evidence => evidence.source === '表格分类'));
    assert.equal(result.theme.key, 'unassigned');
  }
});

test('matching normalization preserves source text instead of replacing it with compact evidence', () => {
  for (const category of ['切 片+A I', '切　片＋Ａ　Ｉ']) {
    const result = classifyAuthor({ memberships: [{ category }] });
    assert.ok(result.evidence.some(evidence => evidence.label === 'AI二创'));
    assert.ok(result.evidence.every(evidence => evidence.value === category));
    assert.ok(!result.labels.some(label => label.key.startsWith('custom:')));
  }
});

test('account tier is not a content classification and source names or nicknames are not newly inferred', () => {
  assert.ok(!keys({ tier: 'A I' }).includes('ai-remix'));
  assert.ok(!keys({ boards: [{ tier: '超头部' }] }).some(key => key.startsWith('custom:')));
  assert.ok(keys({ category: 'A I' }).includes('ai-remix'));
  assert.ok(!keys({ label: '切 片+A I' }).includes('ai-remix'));
  assert.ok(!keys({ metadata: { importSource: { fileName: 'A I' } } }).includes('ai-remix'));
  assert.ok(!keys({ boards: [{ name: 'A I' }] }).includes('ai-remix'));
});

test('negation, future plans and English text cannot become affirmative AI evidence', () => {
  for (const category of ['非 A I', '非A I', '未来 A I', '未来A I', '没有做 A I', '后续可能 A I',
    '切片+非 A I', '切片+未来 A I', 'daily', 'email', 'chair', 'd a i l y', 'e m a i l', 'A I D', 'AI daily']) {
    const expected = category === 'AI daily';
    assert.equal(keys({ category }).includes('ai-remix'), expected, category);
  }
});

test('only whole known segments normalize and existing ordinary categories remain available', () => {
  assert.ok(!keys({ category: 'A I 学习计划' }).includes('ai-remix'));
  assert.ok(!keys({ category: '教程A I' }).includes('ai-remix'));
  assert.ok(keys({ category: 'BGM' }).includes('custom:bgm'));
  assert.deepEqual(keys({ category: '切片+AI' }).sort(), ['ai-remix', 'slice']);
});
