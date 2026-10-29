import {sourcePartsIdentity} from './source-part-reader.mjs';
import {validateTableFoundationManifest} from './table-foundation-manifest.mjs';
import {validateCreatorInsights} from './creator-insights-validation.mjs';

export function validateCreatorSourceIndex(index) {
 const files=index?.files;
 if(index?.version!==1||!Array.isArray(files)||!index.stats
  ||!Number.isSafeInteger(index.stats.authors)||!Number.isSafeInteger(index.stats.works)
  ||files.find(file=>file.path==='authors.json')?.count!==index.stats.authors
  ||files.filter(file=>/^works-\d{3}\.json$/.test(file.path)).reduce((sum,file)=>sum+file.count,0)!==index.stats.works)
  throw Error('来源索引版本或条数不符');
 sourcePartsIdentity(files,String(index.revision));
 return index;
}

export function sourceEditionIdentity(index) {
 const valid=validateCreatorSourceIndex(index);
 if(valid.editionFingerprint!==undefined){
  if(!/^[a-f0-9]{64}$/.test(valid.editionFingerprint))throw Error('作者作品版本校验值无效');
  return JSON.stringify(['live-creator-v1',String(valid.revision),valid.editionFingerprint]);
 }
 return JSON.stringify([String(valid.revision),valid.linkFingerprint??'',valid.stats,
  sourcePartsIdentity(valid.files,String(valid.revision))]);
}

export function foundationEditionIdentity(index) {
 const valid=validateTableFoundationManifest(index);
 return JSON.stringify([String(valid.revision),valid.linkFingerprint??'',valid.stats,
  sourcePartsIdentity(valid.files,String(valid.revision),'/table-foundation/')]);
}

/** Read and verify every part before a newly published source edition becomes visible. */
export async function loadCreatorSourceEdition(index,readPart) {
 validateCreatorSourceIndex(index);
 const revision=String(index.revision);
 const authorFiles=index.files.filter(file=>file.path==='authors.json');
 const workFiles=index.files.filter(file=>/^works-\d{3}\.json$/.test(file.path));
 const insightFile=index.files.find(file=>file.path==='insights.json');
 const readBatch=async files=>{
  const all=[];
  for(let start=0;start<files.length;start+=4){
   const parts=await Promise.all(files.slice(start,start+4).map(file=>readPart(file,revision)));
   for(const part of parts)all.push(...part);
  }
  return all;
 };
 const [authors,works,insightItems]=await Promise.all([
  readBatch(authorFiles),readBatch(workFiles),insightFile?readPart(insightFile,revision):Promise.resolve(null),
 ]);
 if(authors.length!==index.stats.authors||works.length!==index.stats.works)throw Error('来源记录总数不符');
 return {
  authors:{identity:sourcePartsIdentity(authorFiles,revision),items:authors},
  works:{identity:sourcePartsIdentity(workFiles,revision),items:works},
  insights:insightFile?{identity:sourcePartsIdentity([insightFile],revision),items:validateCreatorInsights(insightItems,index)}:null,
 };
}

export async function loadTableFoundationEdition(index,readPart) {
 validateTableFoundationManifest(index);
 const names=['authors.json','works.json','sources.json','observations.json','other-authors.json','other-works.json'];
 if(index.files.some(item=>item.path==='pending-authors.json'))names.push('pending-authors.json');
 const parts=await Promise.all(names.map(async name=>{
  const file=index.files.find(item=>item.path===name);
  if(!file)throw Error('表格索引缺少 '+name);
  return readPart(file,String(index.revision));
 }));
 const fields=['additionalAuthors','additionalWorks','sourceDocuments','sourceMetricObservations','otherAuthors','otherWorks','pendingAuthors'];
 if(parts.some((part,i)=>part.length!==index.stats[fields[i]]))throw Error('表格索引记录数量不符');
 return {index,authors:parts[0],works:parts[1],sources:parts[2],observations:parts[3],otherAuthors:parts[4],otherWorks:parts[5],pendingAuthors:parts[6]??[]};
}
