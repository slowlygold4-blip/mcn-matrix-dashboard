// Shared by the producer and HTTP receiver. No DB, network or model calls.
const FIELDS=['targetId','id','workId','externalId','capturedAt','likes','comments','shares','collects','plays','playsEvidence'];
const positive=v=>Number.isSafeInteger(v)&&v>0;
const instant=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const counter=v=>v===null||Number.isSafeInteger(v)&&v>=0;
function playsEvidenceValid(value,plays){
 const keys=['basis','actualCountVerified','mayBePlaceholder','note'];
 return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length
  &&keys.every(key=>Object.hasOwn(value,key))&&value.actualCountVerified===false&&typeof value.note==='string'
  &&(plays===null?value.basis==='missing'&&value.mayBePlaceholder===null
    :value.basis==='source-reported-unverified'&&(value.mayBePlaceholder===null||plays===0&&value.mayBePlaceholder===true));
}

/** Missing counters stay null; negative differences are calculated later from
 * valid observations. A matching file checksum alone cannot prove valid data. */
export function storedWorkMetricPartValid(part,asOf,targetId){
 if(!positive(targetId)||!instant(asOf)||!part||typeof part!=='object'||Array.isArray(part)||part.version!==1||part.asOf!==asOf
  ||part.timeZone!=='Asia/Shanghai'||!Array.isArray(part.items)
  ||Object.keys(part).length!==4||!Object.hasOwn(part,'items'))return false;
 const cutoff=Date.parse(asOf),ids=new Set();
 for(const row of part.items){
  if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).length!==FIELDS.length
   ||!FIELDS.every(key=>Object.hasOwn(row,key))||row.targetId!==targetId
   ||!positive(row.id)||ids.has(row.id)||!positive(row.workId)
   ||typeof row.externalId!=='string'||!row.externalId||row.externalId.length>128
   ||row.externalId!==row.externalId.trim()||/[\x00-\x1f\x7f]/.test(row.externalId)
   ||!instant(row.capturedAt)||Date.parse(row.capturedAt)>cutoff
   ||!['likes','comments','shares','collects','plays'].every(key=>counter(row[key]))
   ||!playsEvidenceValid(row.playsEvidence,row.plays))return false;
  ids.add(row.id);
 }
 return true;
}
