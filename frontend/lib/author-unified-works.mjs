import {presentUnifiedWorkMetric} from './unified-work-presentation.mjs';
import {workPublicationDay} from './replica-work-publication.mjs';
import {indexWorkObservations,observationsForWork,workOwnerKey} from './work-metric-adoption.mjs';
const known=v=>Number.isSafeInteger(v)&&v>=0?v:null;
/** Same content ID is one work. Sources are evidence, never independent addends. */
export function mergeAuthorWorks({author,sourceWorks,platformWorks,sourceObservations=[],asOf}){
 const ids=new Set([author.douyinId,...(author.douyinIds||[])].map(workOwnerKey).filter(Boolean));
 const targets=new Set(author.targetIds||[]), works=new Map();
 for(const [index,row] of sourceWorks.entries()){
  if(!ids.has(workOwnerKey(row.douyinId)))continue;
  const key=String(row.contentId||'');
  if(!/^\d{15,25}$/.test(key))throw Error('作者作品 ID 无效，停止合并');
  if(works.has(key))throw Error('原始作品索引存在重复 ID，需核对');
  works.set(key,{id:`creator-source:1:${index+1}`,externalId:key,source:'creator-source',caption:row.title||'',url:row.url||`https://www.douyin.com/video/${key}`,publishedOn:row.publishDate||null,publicationDateBasis:'creator-source-date-only',likes:known(row.likes),plays:known(row.plays),sourceCumulativeLikes:known(row.likes),sourceCumulativePlays:known(row.plays),sourcePublishedOn:row.publishDate||null});
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
