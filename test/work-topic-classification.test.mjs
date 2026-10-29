import test from 'node:test';
import assert from 'node:assert/strict';
import { explicitWorkTopicEvidence } from '../lib/work-topic-classification.mjs';

test('correct explicit topics tolerate display punctuation, fullwidth hash and case', () => {
  const hits = explicitWorkTopicEvidence('作品 ＃一条小团团OvO切片激励计划🔥，#一条小团团OVO创作激励计划！#小团团即梦二创大赛 #小团团杯S1二创大赛');
  assert.deepEqual(hits.map(hit => hit.key), ['slice', 'original', 'ai-remix', 'contest']);
});

test('generic topic, prose, nickname-like text and extended or outdated tags do not guess a category', () => {
  for (const value of ['#一条小团团OvO', '切片激励计划', '一条小团团OvO切片激励计划', 'AI作者', '#小团团即梦AI二创大赛',
    '#一条小团团OvO切片激励计划预告', '#一条小团团OvO创作激励计划2', '#小团团即梦二创大赛_extra', '', null]) {
    assert.deepEqual(explicitWorkTopicEvidence(value), [], String(value));
  }
});

test('duplicates collapse only the same work-category evidence, preserving multiple explicit categories', () => {
  const hits = explicitWorkTopicEvidence('#一条小团团OvO切片激励计划 #一条小团团ovo切片激励计划 #小团团即梦二创大赛[话题]#');
  assert.deepEqual(hits.map(hit => hit.key), ['slice', 'ai-remix']);
});
