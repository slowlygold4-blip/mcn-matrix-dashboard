"use client";
import {useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
import {PublishingChart} from './publishing-chart';
import {readReplicaPart} from '@/lib/replica-reader.mjs';
import {publishingPartValid} from '@/lib/replica-publishing.mjs';
import {loadPublishingDay,publishingCalendar} from '@/lib/publishing-view.mjs';
type Row=Record<string,any>;
type DayLoad={generation:string;day:string;items:Row[];busy:boolean;error:string};
/** A small index first; fetch only the selected day's bounded work partitions. */
export function ContinuousPublishing({manifest}:{manifest:Row}){
 const meta=manifest.files.find((m:Row)=>m.path==='publishing.json');
 const edition=[manifest.asOf,meta?.sha256,meta?.bytes,meta?.count,meta?.kind].join('|');
 const [saved,setSaved]=useState<{edition:string;index:Row}|null>(null);
 const index=saved?.edition===edition?saved.index:null;
 const [indexRetry,retryIndex]=useState(0),[dayRetry,retryDay]=useState(0);
 const [indexError,setIndexError]=useState(''),[day,setDay]=useState<string|null>(null),[loaded,setLoaded]=useState<DayLoad|null>(null),[page,setPage]=useState(1);
 useEffect(()=>{
  const controller=new AbortController();setIndexError('');
  if(!meta){setIndexError('每日发片索引尚未发布到当前版本。');return;}
  readReplicaPart({generation:manifest.asOf,part:meta.path,meta,signal:controller.signal}).then((value:Row)=>{
   if(!publishingPartValid(value,meta,manifest.asOf))throw Error('每日发片索引无效');
   if(controller.signal.aborted)return;
   setSaved({edition,index:value});
   setDay(selected=>selected!==null&&!value.days.some((d:Row)=>d.date===selected)?null:selected);
  }).catch((error:Error)=>{if(!controller.signal.aborted)setIndexError(error.message);});
  return()=>controller.abort();
 },[edition,indexRetry]);
 useEffect(()=>{
  if(day===null||!index)return;
  const controller=new AbortController(),generation=manifest.asOf;
  setLoaded({generation,day,items:[],busy:true,error:''});
  loadPublishingDay({index,manifest,day,signal:controller.signal}).then((items:Row[])=>{
   if(controller.signal.aborted)return;
   setLoaded({generation,day,items,busy:false,error:''});
   setPage(current=>Math.max(1,Math.min(current,Math.ceil(items.length/20))));
  }).catch((error:Error)=>{if(!controller.signal.aborted)setLoaded({generation,day,items:[],busy:false,error:error.message});});
  return()=>controller.abort();
 },[day,index,manifest.asOf,dayRetry]);
 const current=loaded&&loaded.generation===manifest.asOf&&loaded.day===day?loaded:null;
 const rows=current?.items??[],days=publishingCalendar(index,manifest.asOf);
 const knownDays=days.filter((d:Row)=>d.works!==null),latest=knownDays.at(-1),undated=index?.days.find((d:Row)=>d.date==='');
 const selected=index?.days.find((d:Row)=>d.date===day);
 const chooseDay=(date:string)=>{if(date!==day)setPage(1);setDay(date);};
 return <section className="panel source-ops" id="source-ops-publishing" tabIndex={-1} aria-label="持续监控每日发片">
  <p className="eyebrow">团团全矩阵 · 9 月 12 日起 · 持续积累</p>
  {index&&<h2>已收录发片记录 · {index.count.toLocaleString('zh-CN')} 条</h2>}
  <p className="meta">同一作品按 ID 去重，按发布日期统计已发现数量。作品尚未全覆盖，无记录日期不等于没有发布。数据截至 {new Date(manifest.asOf).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}（北京时间）；本图覆盖团团全矩阵。</p>
  {indexError&&<div role="alert" className="notice">{indexError} <Button variant="outline" onClick={()=>retryIndex(value=>value+1)}>重新读取发片索引</Button></div>}
  {!index&&!indexError?<p role="status">正在读取每日发片索引…</p>:index&&<>
   <div className="period-toolbar" aria-label="发布记录完整情况"><span>有记录 {knownDays.length} 天 · 无记录 {days.length-knownDays.length} 天</span><span>最近有记录 {latest?.date??'—'}</span>{undated&&<Button variant="outline" onClick={()=>chooseDay('')}>查看未记录日期的作品 · {undated.works.toLocaleString('zh-CN')} 条</Button>}</div>
  </>}
  <div hidden={!index}><PublishingChart days={days} track="all" unified onInspect={focus=>chooseDay(focus.startDate)}/></div>
  {day!==null&&index&&<div className="panel" aria-label="所选发布日作品"><h3>{day||'未记录发布日期'} · {selected?.works.toLocaleString('zh-CN')??'—'} 条已入库</h3>
   {!current||current.busy?<p role="status">正在核验所选作品…</p>:current.error?<div role="alert" className="notice">{current.error} <Button variant="outline" onClick={()=>retryDay(value=>value+1)}>重新读取所选作品</Button></div>:<>
    <div className="table-scroll"><table className="data-table"><thead><tr><th>作者</th><th>作品</th><th>发布日</th></tr></thead><tbody>{rows.slice((page-1)*20,page*20).map(row=><tr key={row.contentId}><td>{row.author||'未署名'}</td><td><a href={'https://www.douyin.com/video/'+row.contentId} target="_blank" rel="noopener noreferrer">{row.title||row.contentId}</a><small> · ID {row.contentId}</small></td><td>{row.date||'未记录'}</td></tr>)}</tbody></table></div>
    <div className="toolbar" role="navigation" aria-label="发布作品分页"><button type="button" disabled={page<=1} onClick={()=>setPage(value=>value-1)}>上一页</button><span aria-live="polite">第 {page} / {Math.max(1,Math.ceil(rows.length/20))} 页</span><button type="button" disabled={page*20>=rows.length} onClick={()=>setPage(value=>value+1)}>下一页</button></div>
   </>}
  </div>}
 </section>;
}
