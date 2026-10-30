import {presentUnifiedWorkMetric} from './unified-work-presentation.mjs';
import {workPublicationDay} from './replica-work-publication.mjs';
import {indexWorkObservations,observationsForWork,workOwnerKey} from './work-metric-adoption.mjs';
import {validateSourceWorkOwners,validateFoundationWorkOwners} from './source-work-owner-contract.mjs';
const known=v=>Number.isSafeInteger(v)&&v>=0?v:null;
/** Same content ID is one work. Sources are evidence, never independent addends. */
/** @param {{author:any,sourceWorks:any[],platformWorks:any[],sourceObservations?:any[],workOwners?:Array<{workRow:number,contentId:string,targetId:number,sourceClaimMatches?:true}>,foundationWorkOwners?:Array<{contentId:string,targetId:number,sourceClaimMatches?:true}>,asOf?:string}} options */
export function mergeAuthorWorks({author,sourceWorks,platformWorks,sourceObservations=[],workOwners=[],foundationWorkOwners=[],asOf}){
 const ids=new Set([author.douyinId,...(author.douyinIds||[])].map(workOwnerKey).filter(Boolean));
 const targets=new Set(author.targetIds||[]), works=new Map();
 const ownerById=new Map(validateSourceWorkOwners(workOwners,{sourceRows:new Map(sourceWorks.map(row=>[row.row,row]))}).map(owner=>[owner.contentId,owner]));
 for(const owner of validateFoundationWorkOwners(foundationWorkOwners,{sourceWorks:new Map(sourceWorks.filter(row=>row.row==null).map(row=>[row.contentId,row]))})){
  if(ownerById.has(owner.contentId))throw Error('作品归属来源命名空间冲突');
  ownerById.set(owner.contentId,owner);
 }
 for(const [index,row] of sourceWorks.entries()){
  const owner=ownerById.get(row.contentId),claimed=ids.has(workOwnerKey(row.douyinId)),owned=owner&&targets.has(owner.targetId);
  if(!claimed&&!owned)continue;
  const key=String(row.contentId||'');
  if(!/^\d{15,25}$/.test(key))throw Error('作者作品 ID 无效，停止合并');
  if(works.has(key))throw Error('原始作品索引存在重复 ID，需核对');
  works.set(key,{id:`creator-source:1:${index+1}`,externalId:key,source:'creator-source',caption:row.title||'',url:row.url||`https://www.douyin.com/video/${key}`,publishedOn:row.publishDate||null,publicationDateBasis:'creator-source-date-only',likes:known(row.likes),plays:known(row.plays),sourceCumulativeLikes:known(row.likes),sourceCumulativePlays:known(row.plays),sourcePublishedOn:row.publishDate||null,
   ...(owner?{canonicalOwnerTargetId:owner.targetId,sourceOwnershipConflict:owner.sourceClaimMatches!==true,ownershipClaimOnly:!owned,
    sourceClaimedCumulativeLikes:known(row.likes),sourceClaimedCumulativePlays:known(row.plays)}:{})});
 }
 const samples=new Map();
 for(const row of platformWorks){
  if(!targets.has(row.targetId))throw Error('作品账号身份不匹配，停止合并');
  const key=String(row.externalId||'');
  if(!/^\d{15,25}$/.test(key))throw Error('采样作品 ID 无效，停止合并');
  const previous=samples.get(key);
  if(!previous||(Date.parse(row.lastObservedAt)||0)>(Date.parse(previous.lastObservedAt)||0))samples.set(key,row);
 }
 for(const [key,row] of samples){
  const saved=works.get(key);
  if(!saved){works.set(key,row);continue;}
  const numeric=Number.isSafeInteger(row.id)&&row.id>0;
  works.set(key,{...row,source:numeric?'platform-and-creator-source':'creator-source',caption:row.caption||saved.caption,url:row.url||saved.url,
   ...(saved.canonicalOwnerTargetId?{canonicalOwnerTargetId:saved.canonicalOwnerTargetId,sourceOwnershipConflict:saved.sourceOwnershipConflict,ownershipClaimOnly:saved.ownershipClaimOnly,
    sourceClaimedCumulativeLikes:saved.sourceClaimedCumulativeLikes,sourceClaimedCumulativePlays:saved.sourceClaimedCumulativePlays}:{}),
   sourceCumulativeLikes:saved.sourceCumulativeLikes??row.sourceCumulativeLikes??null,
   sourceCumulativePlays:saved.sourceCumulativePlays??row.sourceCumulativePlays??null,
   sourcePublishedOn:saved.sourcePublishedOn||row.sourcePublishedOn||null,
   ...(!workPublicationDay(row)&&saved.publishedOn?{publishedOn:saved.publishedOn,publicationDateBasis:'creator-source-date-only'}:{})});
 }
 const observations=indexWorkObservations(sourceObservations,asOf);
 return [...works.values()].map(row=>{
  const merged={...row,sourceObservations:observationsForWork(observations,row.externalId,[...ids]),metricAsOf:asOf};
  const likes=presentUnifiedWorkMetric(merged,'likes'),plays=presentUnifiedWorkMetric(merged,'plays');
  return {...merged,publicationDay:workPublicationDay(row),adoptedLikes:likes.value,adoptedPlays:plays.value,
   likesObservedAt:likes.observedAt,playsObservedAt:plays.observedAt,likesOrigin:likes.origin,playsOrigin:plays.origin};
 });
}
export function orderAuthorWorks(rows,field='publicationDay',direction='desc',query=''){
 if(!['publicationDay','adoptedLikes','adoptedPlays'].includes(field)||!['asc','desc'].includes(direction))throw Error('作品排序无效');
 const q=query.normalize('NFKC').toLocaleLowerCase().trim();
 return rows.filter(row=>!q||[row.caption,row.externalId].some(v=>String(v||'').normalize('NFKC').toLocaleLowerCase().includes(q))).sort((a,b)=>{
  const av=a[field],bv=b[field];if(av==null&&bv!=null)return 1;if(bv==null&&av!=null)return -1;
  const cmp=av==null?0:typeof av==='number'?av-bv:String(av).localeCompare(String(bv));
  return cmp*(direction==='asc'?1:-1)||String(a.externalId).localeCompare(String(b.externalId));
 });
}

/** Preserve the submitted counters even when they are withheld from adoption. */
export function authorWorkExportRows(rows){
 const header=['作品ID','标题','发布日期','点赞','播放字段','点赞观察时间','播放观察时间','归属状态','已核验发布者账号编号','原登记冲突点赞','原登记冲突播放字段','来源记录点赞','来源记录播放字段','来源记录时间依据','来源记录时间'];
 return [header,...rows.map(row=>{
  const likes=presentUnifiedWorkMetric(row,'likes'),plays=presentUnifiedWorkMetric(row,'plays');
  return [row.externalId,row.caption,row.publicationDay,row.adoptedLikes,row.adoptedPlays,row.likesObservedAt||'',row.playsObservedAt||'',
   row.ownershipClaimOnly?'原登记声明，未计入此作者统计':row.canonicalOwnerTargetId?'已核验作品发布者':'已有归属记录',row.canonicalOwnerTargetId??'',row.sourceClaimedCumulativeLikes??'',row.sourceClaimedCumulativePlays??'',
   likes.sourceRecordValue,plays.sourceRecordValue,likes.sourceRecordCount||plays.sourceRecordCount?likes.sourceTimeBasis||plays.sourceTimeBasis:'',likes.sourceRecordedAt||plays.sourceRecordedAt||''];
 })];
}
