import {createHash} from 'node:crypto';

export const clean = (value, limit=160) => String(value ?? '').normalize('NFKC')
 .replace(/[\u0000-\u001f\u007f]/g,' ').replace(/<[^>]*>/g,'').trim().slice(0,limit);
export const identity = value => clean(value,120).toLocaleLowerCase();
export const douyinIdentity = value => /^[A-Za-z0-9_.-]{1,40}$/.test(clean(value,120)) ? identity(value) : '';
export const contentId = value => /^\d{16,22}$/.test(clean(value,40)) ? clean(value,40) : '';
export const digest = value => createHash('sha256').update(value).digest('hex');
export function sourceKey(request){
 if(request.sourceUrl){try{const u=new URL(request.sourceUrl);return `${u.hostname}${u.pathname}?sheet=${u.searchParams.get('sheet')||''}`;}catch{}}
 return clean(request.fileName,300).toLocaleLowerCase()
  .replace(/[-_ ]?rev\d+/g,'').replace(/[-_ ]?修订\d+/g,'')
  .replace(/[-_ ]?20\d{6}(?=\.)/g,'').replace(/\.(xlsx|xls|csv|json|tsv)$/,'');
}
export function latestSources(jobs){
 const selected=new Map();
 for(const job of jobs){
  let request;try{request=JSON.parse(job.request_json||'{}');}catch{continue;}
  if(!Array.isArray(request.rows))continue;
  const key=sourceKey(request),prior=selected.get(key);
  const revision=Number(request.sourceRevision??request.revision??0);
  if(!prior||revision>prior.revision||revision===prior.revision&&String(job.created_at)>String(prior.job.created_at))
   selected.set(key,{key,request,revision,job});
 }
 return [...selected.values()].sort((a,b)=>a.key.localeCompare(b.key));
}

// The frozen master roster and later live submissions predate the creator-source
// export. Keep their unmonitored identities in a separate, evidence-only part:
// authors.json requires a valid Douyin ID, while an old roster row may not have
// one. Never infer an identity from a nickname, or promote a row to a target.
export function pendingSourceAuthors({rosterAccounts,baseAuthors=[],supplementAuthors=[]}){
 const represented=new Set([...baseAuthors,...supplementAuthors]
  .map(row=>douyinIdentity(row.douyinId)).filter(Boolean));
 const rows=[],seenKeys=new Set();
 for(const account of rosterAccounts||[]){
  if(account?.platform!=='douyin'||account?.sourceOnly!==true||account?.classification?.theme?.key!=='tuantuan')continue;
  const keys=Array.isArray(account.rosterKeys)?account.rosterKeys.filter(value=>typeof value==='string'&&value.trim()):[];
  // Reciprocal name/ID rows from creator-source are already represented by the
  // canonical author partition. Do not re-create those 92 folded aliases.
  if(keys.length&&keys.every(value=>value.startsWith('creator-source:')))continue;
  const submittedId=clean(account.submittedAccountId||account.publicId,120);
  const validId=douyinIdentity(submittedId);
  if(validId&&represented.has(validId))continue;
  const sourceRows=(Array.isArray(account.sourceProvenance)?account.sourceProvenance:[]).map(source=>{
   const title=clean(source?.title,160),sheetName=clean(source?.sheetName,100);
   const safeTitle=/https?:\/\/|\b(?:cookie|token|password|authorization)\b/i.test(title)?'历史来源':title||'历史来源';
   const rowNumbers=(Array.isArray(source?.rows)?source.rows:[]).map(value=>clean(value,30))
    .filter(value=>/^\d+$/.test(value));
   const sourceKey=digest(JSON.stringify([clean(source?.url,400),safeTitle,sheetName]));
   return {sourceKey,title:safeTitle,sheetName,rows:[...new Set(rowNumbers)]};
  });
  const rowKey=clean(account.rosterKey,180)||keys[0]||`roster:${digest(JSON.stringify([submittedId,account.label,sourceRows]))}`;
  if(seenKeys.has(rowKey))continue;
  seenKeys.add(rowKey);
  const name=clean(account.submittedName||account.label,160)||'未命名作者';
  rows.push({rowKey,name,douyinId:validId?submittedId:null,submittedAccountId:submittedId||null,
   identifierStatus:validId?'format-valid':submittedId?'unusable':'missing',platform:'douyin',theme:'tuantuan',
   targetIds:[],sourceTitles:[...new Set(sourceRows.map(source=>source.title))],sourceRows,
   sourceSupplement:true,sourceOnly:true,posts:null,plays:null,likes:null,followers:null});
 }
 return rows.sort((a,b)=>a.rowKey.localeCompare(b.rowKey));
}
export function tableFoundation({sources,baseAuthors,baseWorks,targetIds}){
 const baseAuthorIds=new Set(baseAuthors.map(a=>douyinIdentity(a.douyinId)).filter(Boolean));
 const baseWorkIds=new Set(baseWorks.map(w=>contentId(w.contentId)).filter(Boolean));
 const extraAuthors=new Map(),extraWorks=new Map(),otherAuthors=new Map(),otherWorks=new Map();
 const sourceStats=[];
 let acceptedRows=0,unkeyedRows=0,ambiguousRows=0,invalidIdentityRows=0,baseAuthorEvidence=0,baseWorkEvidence=0;
 for(const source of sources){
  const rowStats={title:clean(source.request.sourceTitle||source.request.fileName||source.key,180),revision:source.revision||null,
   importedAt:source.job.finished_at||source.job.created_at,rows:source.request.rows.length,tuantuanRows:0,otherRows:0,unkeyedRows:0};
  for(const row of source.request.rows){
   const board=clean(row.board,100),isTuantuan=board==='一条小团团切片矩阵';
   if(!isTuantuan){
    rowStats.otherRows++;
    const otherBoard=board||'未分板块',platform=clean(row.platform,40);
    const platformId=platform==='douyin'?douyinIdentity(row.douyinId):platform==='bilibili'?identity(row.bilibiliId):platform==='xiaohongshu'?identity(row.xiaohongshuId):'';
    if(platformId){const key=`${otherBoard}\u0000${platform}\u0000${platformId}`,prior=otherAuthors.get(key);
     if(!prior)otherAuthors.set(key,{board:otherBoard,platform,platformId,name:clean(row.name,160),targetIds:platform==='douyin'?targetIds.get(platformId)||[]:[],evidenceRows:1,sourceTitles:[rowStats.title]});
     else {prior.evidenceRows++;if(!prior.sourceTitles.includes(rowStats.title))prior.sourceTitles.push(rowStats.title);}
    }
    const work=platform==='douyin'?(contentId(row.videoId)||contentId(row.contentId)):'';
    if(work){const key=`${otherBoard}\u0000${work}`,prior=otherWorks.get(key);
     if(!prior)otherWorks.set(key,{board:otherBoard,contentId:work,author:clean(row.name,160),platformId:platformId||'',evidenceRows:1,sourceTitles:[rowStats.title]});
     else {prior.evidenceRows++;if(!prior.sourceTitles.includes(rowStats.title))prior.sourceTitles.push(rowStats.title);}
    }
    continue;
   }
   rowStats.tuantuanRows++;
   if(clean(row.platform,40)!=='douyin'){ambiguousRows++;continue;}
   const id=douyinIdentity(row.douyinId),work=contentId(row.videoId)||contentId(row.contentId);
   if(!id&&clean(row.douyinId))invalidIdentityRows++;
   if(!id&&!work){unkeyedRows++;rowStats.unkeyedRows++;continue;}
   acceptedRows++;
   if(id){
    if(baseAuthorIds.has(id))baseAuthorEvidence++;
    else {
     const prior=extraAuthors.get(id),name=clean(row.name,160);
     if(!prior)extraAuthors.set(id,{douyinId:clean(row.douyinId,120),name,posts:null,slicePosts:null,creationPosts:null,aiPosts:null,cupPosts:null,plays:null,likes:null,followers:null,targetIds:targetIds.get(id)||[],evidenceRows:1,sourceTitles:[rowStats.title]});
     else {prior.evidenceRows++;if(!prior.sourceTitles.includes(rowStats.title))prior.sourceTitles.push(rowStats.title);if(!prior.name&&name)prior.name=name;}
    }
   }
   if(work){
    if(baseWorkIds.has(work))baseWorkEvidence++;
    else {
     const prior=extraWorks.get(work);
     if(!prior)extraWorks.set(work,{contentId:work,author:clean(row.name,160),douyinId:id?clean(row.douyinId,120):'',publishDate:null,type:null,track:null,tracks:null,plays:null,likes:null,title:null,url:null,evidenceRows:1,sourceTitles:[rowStats.title]});
     else {prior.evidenceRows++;if(!prior.sourceTitles.includes(rowStats.title))prior.sourceTitles.push(rowStats.title);}
    }
   }
  }
  sourceStats.push(rowStats);
 }
 return {authors:[...extraAuthors.values()].sort((a,b)=>identity(a.douyinId).localeCompare(identity(b.douyinId))),
  works:[...extraWorks.values()].sort((a,b)=>a.contentId.localeCompare(b.contentId)),
  otherAuthors:[...otherAuthors.values()].sort((a,b)=>a.board.localeCompare(b.board)||a.platformId.localeCompare(b.platformId)),
  otherWorks:[...otherWorks.values()].sort((a,b)=>a.board.localeCompare(b.board)||a.contentId.localeCompare(b.contentId)),sources:sourceStats,
  stats:{sourceDocuments:sources.length,sourceRows:sourceStats.reduce((sum,x)=>sum+x.rows,0),tuantuanRows:sourceStats.reduce((sum,x)=>sum+x.tuantuanRows,0),acceptedRows,unkeyedRows,ambiguousRows,invalidIdentityRows,baseAuthorEvidence,baseWorkEvidence,additionalAuthors:extraAuthors.size,additionalWorks:extraWorks.size,otherAuthors:otherAuthors.size,otherWorks:otherWorks.size}};
}
