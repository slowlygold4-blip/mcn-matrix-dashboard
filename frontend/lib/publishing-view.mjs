import {readReplicaPart} from './replica-reader.mjs';
import {publishingPartValid,publicationMetricSummary,publicationIdentity,publicationScopeGroups,expandPublicationScopeMetrics} from './replica-publishing.mjs';
import {matchesMatrixScope} from './matrix-scope.mjs';
const DAY_MS=86_400_000;
export const publishingTracks = Object.freeze([
 {key:'all',label:'全部内容'}, {key:'slice',label:'切片激励'}, {key:'original',label:'创作激励'},
 {key:'ai-remix',label:'即梦二创'}, {key:'contest',label:'小团团杯二创'}, {key:'unclassified',label:'未标注分类'},
]);
const validTrack = track => {
 if(!publishingTracks.some(item=>item.key===track))throw Error('发片内容分类无效');
};
export function publishingTrackCount(day,track='all'){
 validTrack(track);
 return day?.works==null?null:track==='all'?day.works:day.tracks?.[track]??0;
}
export function filterPublishingRows(rows,track='all'){
 validTrack(track);
 if(track==='all')return rows;
 return rows.filter(row=>track==='unclassified'?!row.classifications.length:row.classifications.includes(track));
}
const scopeMatches=(descriptor,scope)=>matchesMatrixScope({boardKeys:descriptor.boardKeys,
 classification:{theme:{key:descriptor.theme},labels:descriptor.labels.map(key=>({key}))}},scope);
function selectedScopeIds(index,scope){
 if(!index)return new Set();
 if(!index?.scopes){
  if((scope.board??'all')!=='all'||!['all','tuantuan'].includes(scope.theme??'all')||(scope.tag??'all')!=='all')
   throw Error('当前数据版本尚未提供此账号范围的作品索引，请等待已保存数据同步。');
  return null;
 }
 return new Set(index.scopes.flatMap((descriptor,id)=>scopeMatches(descriptor,scope)?[id]:[]));
}
export function filterPublicationScopeRows(rows,index,scope={}){
 const ids=selectedScopeIds(index,scope);return ids?rows.filter(row=>ids.has(row.scopeId)):rows;
}
function sumMetrics(parts){
 return Object.fromEntries(['all','slice','original','ai-remix','contest','unclassified'].map(track=>{
  const sets=parts.map(p=>p[track]);
  return [track,{works:sets.reduce((sum,s)=>sum+s.works,0),...Object.fromEntries(['likes','plays'].map(metric=>{
   const values=sets.map(s=>s[metric]);let sum=0n;for(const v of values)if(v.value!==null)sum+=BigInt(v.value);
   const known=values.reduce((n,v)=>n+v.known,0),overflow=values.some(v=>v.overflow)||sum>BigInt(Number.MAX_SAFE_INTEGER);
   return [metric,{value:known&&!overflow?Number(sum):null,known,missing:values.reduce((n,v)=>n+v.missing,0),
    conflicts:values.reduce((n,v)=>n+v.conflicts,0),overflow}];
  }))}];
 }));
}
/** Scope buckets are disjoint: overlapping boards/account labels never double-count.
 * Work-topic filters remain separate from the parent account-classification filter. */
export function scopedPublishingIndex(index,scope={}){
 if(!index)return null;const ids=selectedScopeIds(index,scope);if(!ids)return index;
 const days=index.days.flatMap(day=>{
  const groups=day.scopeGroups.filter(g=>ids.has(g.scopeId));if(!groups.length)return [];
  const tracks={};for(const group of groups)for(const [key,value] of Object.entries(group.tracks))tracks[key]=(tracks[key]??0)+value;
  return [{...day,works:groups.reduce((n,g)=>n+g.works,0),tracks,metrics:sumMetrics(groups.map(expandPublicationScopeMetrics))}];
 });
 return {...index,count:days.reduce((n,d)=>n+d.works,0),days,metrics:sumMetrics(days.map(d=>d.metrics))};
}
/** Missing days remain null, not inferred zero-publication days. */
export function publishingCalendar(index,asOf,start='2026-09-12',endDate='') {
 const cutoff=Date.parse(asOf),first=Date.parse(start+'T00:00:00.000Z');
 if(!Number.isFinite(cutoff)||!Number.isFinite(first)||new Date(first).toISOString().slice(0,10)!==start
  ||endDate&&(!/^\d{4}-\d{2}-\d{2}$/.test(endDate)||!Number.isFinite(Date.parse(endDate))||new Date(endDate).toISOString().slice(0,10)!==endDate||endDate<start))throw Error('每日发片日期范围无效');
 const cutoffDay=new Date(cutoff+8*3_600_000).toISOString().slice(0,10),end=endDate&&endDate<cutoffDay?endDate:cutoffDay;
 const observed=new Map((index?.days??[]).filter(d=>d.date).map(d=>[d.date,d]));
 const days=[];
 for(let at=first;at<=Date.parse(end+'T00:00:00.000Z');at+=DAY_MS){
  const date=new Date(at).toISOString().slice(0,10),entry=observed.get(date);
  days.push({date,works:entry?.works??null,tracks:entry?.tracks??{}});
 }
 return days;
}
/** A work ledger is fetched only for the selected publication day ('' = undated). */
export async function loadPublishingDay({index,manifest,day,signal,fetcher=fetch}) {
 if(index?.asOf!==manifest?.asOf)throw Error('每日发片版本不一致');
 const selected=index.days.find(d=>d.date===day);
 if(!selected)throw Error('所选日期尚无已发现作品');
 if(new Set(selected.parts).size!==selected.parts.length)throw Error('作品分区重复');
 const rows=[];
 for(const path of selected.parts){
  const meta=manifest.files.find(m=>m.path===path);
  if(!meta)throw Error('作品分区不在本轮清单');
  const value=await readReplicaPart({generation:manifest.asOf,part:path,meta,signal,fetcher});
  if(!publishingPartValid(value,meta,manifest.asOf)||value.items.some(row=>row.date!==day))throw Error('作品日期核验失败');
  rows.push(...value.items);
 }
 if(rows.length!==selected.works||new Set(rows.map(publicationIdentity)).size!==rows.length)throw Error('作品数量或去重核验失败');
 if(rows.some(row=>Object.hasOwn(row,'metrics')!==Object.hasOwn(index,'metrics')))throw Error('作品指标版本不一致');
 if(index.metrics&&JSON.stringify(publicationMetricSummary(rows))!==JSON.stringify(selected.metrics))throw Error('作品指标合计核验失败');
 if(index.scopes&&(rows.some(row=>!Number.isSafeInteger(row.scopeId)||row.scopeId>=index.scopes.length)
  ||JSON.stringify(publicationScopeGroups(rows))!==JSON.stringify(selected.scopeGroups)))throw Error('作品范围合计核验失败');
 return rows;
}

/** Publication cohorts use the same adopted values as their verified work rows.
 * A cohort's accumulated likes/plays are never a daily engagement increment. */
export function publishingSelection(index,{track='all',startDate='',endDate=''}={}){
 validTrack(track);
 const valid=value=>!value||/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
 if(!valid(startDate)||!valid(endDate)||startDate&&endDate&&startDate>endDate)throw Error('作品发布日期范围无效');
 if(!index)return {works:null,metrics:null,days:[],undatedWorks:null};
 const selected=index.days.filter(d=>(!startDate||d.date&&d.date>=startDate)&&(!endDate||d.date&&d.date<=endDate));
 const works=selected.reduce((sum,d)=>sum+(publishingTrackCount(d,track)??0),0);
 const undatedWorks=publishingTrackCount(index.days.find(d=>d.date===''),track)??0;
 if(!index.metrics)return {works,metrics:null,days:selected,undatedWorks};
 const metrics={};
 for(const key of ['likes','plays']){
  let sum=0n,known=0,missing=0,conflicts=0,overflow=false;
  for(const d of selected){
   const s=d.metrics[track][key];known+=s.known;missing+=s.missing;conflicts+=s.conflicts;
   overflow ||= s.overflow;if(s.value!==null)sum+=BigInt(s.value);
  }
  overflow ||= sum>BigInt(Number.MAX_SAFE_INTEGER);
  metrics[key]={value:known&&!overflow?Number(sum):null,known,missing,conflicts,overflow};
 }
 return {works,metrics,days:selected,undatedWorks};
}
export function sortPublicationRows(rows,key='id',direction='asc'){
 if(!['id','author','date','likes','plays'].includes(key)||!['asc','desc'].includes(direction))throw Error('作品排序无效');
 const value=r=>key==='id'?r.contentId:['likes','plays'].includes(key)?r.metrics?.[key]?.value??null:r[key]||null;
 return [...rows].sort((a,b)=>{
  const av=value(a),bv=value(b);const stable=()=>publicationIdentity(a).localeCompare(publicationIdentity(b));
  if(av===null)return bv===null?stable():1;if(bv===null)return -1;
  const order=typeof av==='number'&&typeof bv==='number'?av-bv:String(av).localeCompare(String(bv),'zh-CN');
  return (direction==='asc'?order:-order)||stable();
 });
}
