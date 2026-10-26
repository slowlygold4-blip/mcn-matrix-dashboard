/** A verified replica replaces the frozen target bindings, never author identity or metrics. */
export function applyLiveAuthorLinks(authors, projection, sourceIndex) {
 if (!projection) return authors; // Backward compatibility with sealed older generations.
 if (!Array.isArray(authors) || !Array.isArray(projection.links)
  || String(projection.revision)!==String(sourceIndex?.revision)
  || projection.modifiedAt!==sourceIndex?.sourceModifiedAt || projection.rowCount!==sourceIndex?.sourceRows)
  throw Error('作者关联与名册版本不一致，请刷新数据');
 const byRow=new Map(),targets=new Set();
 for (const link of projection.links) {
  if(!Number.isSafeInteger(link.authorRow)||link.authorRow<1||!Number.isSafeInteger(link.targetId)||link.targetId<1
   ||byRow.has(link.authorRow)||targets.has(link.targetId))throw Error('作者监控关联重复或无效');
  byRow.set(link.authorRow,link.targetId);targets.add(link.targetId);
 }
 // Some reciprocal alias rows were already deduplicated in the sealed directory.
 // Only directory rows participate; an unknown source row never invents an author.
 return authors.map(author=>({...author,targetIds:byRow.has(author.row)?[byRow.get(author.row)]:[]}));
}
