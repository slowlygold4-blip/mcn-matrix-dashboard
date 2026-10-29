/** Exact, user-confirmed work hashtags. No nickname or bare-keyword inference. */
const topics = new Map([
  ['一条小团团ovo切片激励计划', 'slice'],
  ['一条小团团ovo创作激励计划', 'original'],
  ['小团团即梦二创大赛', 'ai-remix'],
  ['小团团杯s1二创大赛', 'contest'],
]);

export function explicitWorkTopicEvidence(caption) {
  if (typeof caption !== 'string') return [];
  const result = [], seen = new Set();
  for (const match of caption.normalize('NFKC').matchAll(/#([\p{L}\p{N}\p{M}_]+)/gu)) {
    const key = topics.get(match[1].toLowerCase());
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push({ key, tag: '#' + match[1] });
  }
  return result;
}
