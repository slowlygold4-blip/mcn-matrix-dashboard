import {readReplicaPart} from './replica-reader.mjs';
import {publishingPartValid,publicationMetricSummary} from './replica-publishing.mjs';
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
 if(rows.length!==selected.works||new Set(rows.map(row=>row.contentId)).size!==rows.length)throw Error('作品数量或去重核验失败');
 if(rows.some(row=>Object.hasOwn(row,'metrics')!==Object.hasOwn(index,'metrics')))throw Error('作品指标版本不一致');
 if(index.metrics&&JSON.stringify(publicationMetricSummary(rows))!==JSON.stringify(selected.metrics))throw Error('作品指标合计核验失败');
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
  const av=value(a),bv=value(b);const stable=()=>a.contentId.localeCompare(b.contentId);
  if(av===null)return bv===null?stable():1;if(bv===null)return -1;
  const order=typeof av==='number'&&typeof bv==='number'?av-bv:String(av).localeCompare(String(bv),'zh-CN');
  return (direction==='asc'?order:-order)||stable();
 });
}
