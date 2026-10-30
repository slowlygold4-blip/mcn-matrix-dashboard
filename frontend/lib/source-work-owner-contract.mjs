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
