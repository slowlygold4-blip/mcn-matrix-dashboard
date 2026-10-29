import {readReplicaPart} from './replica-reader.mjs';
import {publishingPartValid} from './replica-publishing.mjs';
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
export function publishingCalendar(index,asOf,start='2026-09-12') {
 const cutoff=Date.parse(asOf),first=Date.parse(start+'T00:00:00.000Z');
 if(!Number.isFinite(cutoff)||!Number.isFinite(first))throw Error('每日发片日期范围无效');
 const end=new Date(cutoff+8*3_600_000).toISOString().slice(0,10);
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
 return rows;
}
