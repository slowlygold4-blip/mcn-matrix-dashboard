import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAuthor, classifyAuthorTheme, AUTHOR_CLASSIFICATION_RULE_VERSION } from '../lib/author-classification.mjs';

const prompt = '1. 内容类型: (1)切片剪辑。 (2)二创视频。 (3)AI 视频。 (4)AI 音乐。 (5)户外采访奶团基地相关内容。';
const keys = (input) => classifyAuthor(input).labels.map((item) => item.key);

test('real imported option menu is not an affirmative AI/remix/custom classification', () => {
  const input = { label: '迷路OvO', boards: [{ name: '一条小团团切片矩阵', category: prompt }, { name: '抖音主播板块', category: '' }] };
  const before = structuredClone(input);
  const result = classifyAuthor(input);
  assert.deepEqual(result.labels.map((item) => item.key), ['slice']);
  assert.equal(result.mode, 'inferred');
  assert.equal(result.needsReview, true);
  assert.deepEqual(result.theme, classifyAuthorTheme(input));
  assert.equal(result.theme.key, 'tuantuan');
  assert.deepEqual(result.excludedEvidence, [{ source: '表格分类', reason: 'form-option-prompt-not-answer', value: prompt, selectedAnswer: null }]);
  assert.deepEqual(input, before);
  assert.equal(AUTHOR_CLASSIFICATION_RULE_VERSION, 'rules-v10-tuantuan-matrix-primary-secondary-content');
});

test('menu without independent evidence stays unknown, not custom menu fragments', () => {
  const result = classifyAuthor({ category: prompt });
  assert.equal(result.primaryKey, 'unclassified');
  assert.deepEqual(result.labels, []);
});

test('independent explicit AI and original labels survive a separate instruction field', () => {
  const result = classifyAuthor({ category: prompt, boards: [
    { category: 'AI二创', name: '一条小团团切片矩阵' },
    { category: '原创授权', name: '一条小团团原创矩阵' },
  ] });
  assert.ok(result.labels.some((item) => item.key === 'ai-remix'));
  assert.ok(result.labels.some((item) => item.key === 'original'));
  assert.ok(!result.labels.some((item) => item.key.startsWith('custom:')));
  assert.ok(result.evidence.filter((item) => item.label === 'AI二创').every((item) => item.value === 'AI二创'));
});

test('explicit trailing answer selects only answer, not the other menu options', () => {
  assert.deepEqual(keys({ category: `${prompt} 已选: 切片剪辑` }), ['slice']);
  assert.deepEqual(keys({ category: `${prompt} 答案: AI二创` }), ['ai-remix']);
});

test('explicit leading answer is preserved separately from the menu', () => {
  assert.deepEqual(keys({ category: `已选: 原创授权；${prompt}` }), ['original']);
});

test('explicit numbered answers resolve only chosen options', () => {
  assert.deepEqual(keys({ category: `${prompt} 已选择: (3)` }), ['ai-remix']);
  const result = keys({ category: `${prompt} 已选: 1、3` });
  assert.deepEqual(new Set(result), new Set(['slice', 'ai-remix']));
  assert.deepEqual(keys({ category: `${prompt} 已选: 9` }), []);
});

test('line boundaries keep explicit answers readable before normalization', () => {
  const menu = '内容类型：(1)切片 (2)原创 (3)AI二创';
  assert.deepEqual(keys({ category: `${menu}\n已选：原创` }), ['original']);
  assert.deepEqual(keys({ category: `${menu}\n已选：2` }), ['original']);
  assert.deepEqual(keys({ category: `${menu} 已选：原创` }), ['original']);
  assert.deepEqual(keys({ category: `${menu} 已选：2` }), ['original']);
  assert.deepEqual(keys({ category: `已选：原创\n${menu}` }), ['original']);
  const unmarked = classifyAuthor({ category: `原创\n${menu}` });
  assert.equal(unmarked.needsReview, true);
  assert.deepEqual(unmarked.labels, []);
  assert.equal(unmarked.excludedEvidence[0].value, `原创\n${menu}`);
});

test('full-width punctuation and contextual menus are filtered without theme changes', () => {
  const category = '内容类型：（１）切片。（２）二创。（３）AI。';
  assert.deepEqual(keys({ category }), []);
  const input = { boards: [{ name: '一条小团团切片矩阵', note: category }] };
  assert.deepEqual(keys(input), ['slice']);
  assert.deepEqual(classifyAuthor(input).theme, classifyAuthorTheme(input));
});

test('real multi-label answers and unconstrained prose are not removed by broad heuristics', () => {
  for (const category of ['二创,Ai', '切片,AI', '直播切片,ai生成', '切片、AI', '小团团即梦二创', '切片AI动画', '直播内容切片或者日常ai二创', 'ai 制作', '直播切片,Ai二创', 'ai二创,直播切片创作', 'ai 或者切片很会剪辑可以看看我的作品', '切片二创、ai二创', '一条小团团直播切片+AI作品']) {
    assert.ok(keys({ category }).includes('ai-remix'), category);
    assert.equal(classifyAuthor({ category }).excludedEvidence, undefined, category);
  }
  for (const category of ['内容类型: (1)切片 (2)AI', '我的内容类型: (1)切片 (2)二创 (3)AI', '内容类型: (1)切片 (3)二创 (5)AI']) {
    assert.equal(classifyAuthor({ category }).excludedEvidence, undefined, category);
  }
});

test('custom affirmative answer survives, but prompt fragments never become custom labels', () => {
  const result = classifyAuthor({ category: `${prompt} 已选: 剧情故事` });
  assert.deepEqual(result.labels.map((item) => item.key), ['custom:剧情故事']);
  assert.equal(result.excludedEvidence[0].selectedAnswer, '剧情故事');
});
