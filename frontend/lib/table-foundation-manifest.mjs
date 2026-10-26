const requiredParts = Object.freeze({
 'authors.json': 'additionalAuthors',
 'works.json': 'additionalWorks',
 'sources.json': 'sourceDocuments',
 'observations.json': 'sourceMetricObservations',
 'other-authors.json': 'otherAuthors',
 'other-works.json': 'otherWorks',
});
const countFields = [
 'sourceDocuments','sourceRows','tuantuanRows','acceptedRows','unkeyedRows',
 'ambiguousRows','invalidIdentityRows','baseAuthorEvidence','baseWorkEvidence',
 'additionalAuthors','additionalWorks','otherAuthors','otherWorks',
 'sourceMetricObservations','sourceMetricWorkIds','baseAuthorRows',
 'reciprocalDuplicates','baseAuthors','baseWorks','sheets',
];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && value.trim().length > 0;
const partPath = value => typeof value === 'string' && value.endsWith('.json')
 && value.split('/').every(segment => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment));

/** Validate the declared schema and counts, not the size of one historic import. */
export function validateTableFoundationManifest(index) {
 if(!record(index)||index.version!==1)throw Error('表格索引版本无效');
 if(!text(index.revision)||!text(index.generatedAt)||!Number.isFinite(Date.parse(index.generatedAt)))throw Error('表格索引修订或生成时间无效');
 if(!record(index.stats)||countFields.some(field=>!count(index.stats[field])))throw Error('表格索引统计必须是非负整数');
 if(!Array.isArray(index.sheetCoverage)||index.sheetCoverage.length!==index.stats.sheets)throw Error('表格索引工作表实际数量与声明不符');
 const sheetIds=new Set();
 for(const sheet of index.sheetCoverage){
  if(!record(sheet)||!text(sheet.id)||sheet.id!==sheet.id.trim()||!text(sheet.name)||!count(sheet.rows)||typeof sheet.restricted!=='boolean')throw Error('表格索引工作表信息无效');
  if(sheetIds.has(sheet.id))throw Error('表格索引工作表 ID 重复');
  sheetIds.add(sheet.id);
 }
 if(!Array.isArray(index.files))throw Error('表格索引缺少分区清单');
 const files=new Map();
 for(const file of index.files){
  if(!record(file)||!partPath(file.path)||!count(file.count)||!Number.isSafeInteger(file.bytes)||file.bytes<1||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('表格索引分区路径、条数或校验信息无效');
  if(files.has(file.path))throw Error('表格索引分区路径重复');
  files.set(file.path,file);
 }
 for(const [path,field] of Object.entries(requiredParts)){
  if(!files.has(path))throw Error('表格索引缺少 '+path);
  if(files.get(path).count!==index.stats[field])throw Error('表格索引分区记录数量不符：'+path);
 }
 // Older published revisions have six parts. A revision advertising the
 // pending-author partition must always declare both its count and its seal.
 const pending=files.get('pending-authors.json');
 if(pending || Object.hasOwn(index.stats,'pendingAuthors')){
  if(!pending || !count(index.stats.pendingAuthors))throw Error('表格索引缺少待核验作者分区或统计');
  if(pending.count!==index.stats.pendingAuthors)throw Error('表格索引分区记录数量不符：pending-authors.json');
 }
 return index;
}
