/** A per-work publisher projection, never a relationship between author identities. */
export function validateSourceWorkOwners(value,{sourceRows,accountIds}={}){
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>50_000)throw Error('作品归属映射无效');
 const rows=new Set(),ids=new Set();
 for(const item of value){
  if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).length!==3
   ||!['workRow','contentId','targetId'].every(key=>Object.hasOwn(item,key))
   ||!Number.isSafeInteger(item.workRow)||item.workRow<1
   ||typeof item.contentId!=='string'||!/^\d{16,22}$/.test(item.contentId)
   ||!Number.isSafeInteger(item.targetId)||item.targetId<1||rows.has(item.workRow)||ids.has(item.contentId)
   ||accountIds&&!accountIds.has(item.targetId)
   ||sourceRows&&sourceRows.get(item.workRow)?.contentId!==item.contentId)throw Error('作品归属映射与来源或账号不一致');
  rows.add(item.workRow);ids.add(item.contentId);
 }
 return value;
}

export function readLiveSourceWorkOwners(projection,sourceIndex,sourceWorks){
 if(projection?.workOwners===undefined)return [];
 if(String(projection.revision)!==String(sourceIndex?.revision)||projection.modifiedAt!==sourceIndex?.sourceModifiedAt
  ||projection.rowCount!==sourceIndex?.sourceRows||!Array.isArray(sourceWorks))throw Error('作品归属与来源版本不一致，请刷新数据');
 return validateSourceWorkOwners(projection.workOwners,{sourceRows:new Map(sourceWorks.map(row=>[row.row,row]))});
}

/** Supplementary works have their own sealed namespace, never fabricated sheet rows. */
export function validateFoundationWorkOwners(value,{sourceWorks,accountIds}={}){
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>50_000)throw Error('补充作品归属映射无效');
 const ids=new Set();
 for(const item of value){
  if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).length!==2
   ||!['contentId','targetId'].every(key=>Object.hasOwn(item,key))
   ||typeof item.contentId!=='string'||!/^\d{16,22}$/.test(item.contentId)||ids.has(item.contentId)
   ||!Number.isSafeInteger(item.targetId)||item.targetId<1||accountIds&&!accountIds.has(item.targetId)
   ||sourceWorks&&!sourceWorks.has(item.contentId))throw Error('补充作品归属与来源或账号不一致');
  ids.add(item.contentId);
 }
 return value;
}

export function readLiveFoundationWorkOwners(projection,foundation,asOf){
 if(projection?.foundationWorkOwners===undefined)return [];
 if(foundation?.index?.asOf!==asOf||!Array.isArray(foundation.works))throw Error('补充作品归属与来源版本不一致，请刷新数据');
 return validateFoundationWorkOwners(projection.foundationWorkOwners,{sourceWorks:new Map(foundation.works.map(row=>[row.contentId,row]))});
}

/** Both source namespaces require the same genuine native publisher evidence. */
export async function auditWorkOwnerNativeEvidence({manifest,owners,readPart}){
 const parts=new Map();
 for(const owner of owners){
  if(!parts.has(owner.targetId)){
   const path=`works/${owner.targetId}.json`,meta=manifest.files.find(file=>file.path===path&&file.kind==='works'&&file.targetId===owner.targetId);
   if(!meta)throw Error('work-owner-part-missing');
   const part=await readPart(path);if(part?.version!==1||part.asOf!==manifest.asOf||!Array.isArray(part.items))throw Error('work-owner-part-invalid');
   parts.set(owner.targetId,part.items);
  }
  const matched=parts.get(owner.targetId).filter(work=>work.targetId===owner.targetId&&work.externalId===owner.contentId
   &&Number.isSafeInteger(work.id)&&work.id>0&&work.source!=='creator-source');
  if(matched.length!==1)throw Error('work-owner-native-evidence-missing');
 }
}
