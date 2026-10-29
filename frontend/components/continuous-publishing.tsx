"use client";
import {useEffect,useMemo,useState} from 'react';
import {Button} from '@/components/ui/button';
import {PublishingChart} from './publishing-chart';
import {readReplicaPart} from '@/lib/replica-reader.mjs';
import {publishingPartValid} from '@/lib/replica-publishing.mjs';
import {loadPublishingDay,publishingCalendar,publishingTracks,publishingTrackCount,filterPublishingRows,publishingSelection,sortPublicationRows} from '@/lib/publishing-view.mjs';
type Row=Record<string,any>;
type DayLoad={generation:string;day:string;items:Row[];busy:boolean;error:string};
/** A small index first; fetch only the selected day's bounded work partitions. */
export function ContinuousPublishing({manifest,startDate='',endDate=''}:{manifest:Row;startDate?:string;endDate?:string}){
 const meta=manifest.files.find((m:Row)=>m.path==='publishing.json');
 const edition=[manifest.asOf,meta?.sha256,meta?.bytes,meta?.count,meta?.kind].join('|');
 const [saved,setSaved]=useState<{edition:string;index:Row}|null>(null);
 const index=saved?.edition===edition?saved.index:null;
 const [indexRetry,retryIndex]=useState(0),[dayRetry,retryDay]=useState(0);
 const [track,setTrack]=useState('all'),[sort,setSort]=useState('id'),[direction,setDirection]=useState('asc');
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
 const selection:Row=useMemo(()=>{try{return {...publishingSelection(index,{track,startDate,endDate}),error:''};}catch(error){return {works:null,metrics:null,days:[],undatedWorks:null,error:(error as Error).message};}},[index,track,startDate,endDate]);
 const rows:Row[]=useMemo(()=>sortPublicationRows(filterPublishingRows(current?.items??[],track),sort,direction),[current?.items,track,sort,direction]);
 const days=selection.error?[]:publishingCalendar(index,manifest.asOf,startDate||'2026-09-12',endDate);
 useEffect(()=>{setDay(value=>value&&((startDate&&value<startDate)||(endDate&&value>endDate))?null:value);},[startDate,endDate]);
 useEffect(()=>{if(current&&!current.busy&&!current.error)setPage(value=>Math.max(1,Math.min(value,Math.ceil(rows.length/20))));},[current,rows.length]);
 const knownDays=days.filter((d:Row)=>d.works!==null),latest=knownDays.at(-1),undated=index?.days.find((d:Row)=>d.date==='');
 const selected=index?.days.find((d:Row)=>d.date===day);
 const label=publishingTracks.find((item:Row)=>item.key===track)!.label;
 const total=selection.works;
 const undatedCount=publishingTrackCount(undated,track),selectedCount=publishingTrackCount(selected,track);
 const chooseDay=(date:string)=>{if(date!==day)setPage(1);setDay(date);};
 const rank=(key:string)=>{if(key===sort)setDirection(value=>value==='asc'?'desc':'asc');else{setSort(key);setDirection(['likes','plays'].includes(key)?'desc':'asc');}setPage(1);};
 const number=(value:number|null|undefined)=>value==null?'—':value.toLocaleString('zh-CN');
 return <section className="panel source-ops" id="source-ops-publishing" tabIndex={-1} aria-label="持续监控每日发片">
  <p className="eyebrow">团团全矩阵 · 9 月 12 日起 · 持续积累</p>
  {index&&!selection.error&&<h2>{track==='all'?'':label+' · '}已收录发片记录 · {number(total)} 条</h2>}
  <p className="meta">同一作品按 ID 去重，按发布日期统计已发现数量。作品尚未全覆盖，无记录日期不等于没有发布。数据截至 {new Date(manifest.asOf).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}（北京时间）；本图覆盖团团全矩阵{startDate||endDate?` · 作品发布日 ${startDate||'最早'} 至 ${endDate||'最新'}`:''}。</p>
  {selection.error&&<div role="alert" className="notice">{selection.error}</div>}
  {indexError&&<div role="alert" className="notice">{indexError} <Button variant="outline" onClick={()=>retryIndex(value=>value+1)}>重新读取发片索引</Button></div>}
  {!index&&!indexError?<p role="status">正在读取每日发片索引…</p>:index&&!selection.error&&<>
   <div className="source-controls"><label>内容分类 <select aria-label="每日发片内容分类" value={track} onChange={event=>{setTrack(event.target.value);setPage(1);}}>{publishingTracks.map((item:Row)=><option key={item.key} value={item.key}>{item.label}</option>)}</select></label><span className="meta">按作品明确标签筛选；一条作品在全部中只计一次。</span></div>
   <section className="source-ops-kpis" aria-label="合并作品指标概览">
    <div><small>当前筛选已收录作品</small><strong>{number(total)}</strong><span>同一作品 ID 只计一次；日期按作品发布日筛选</span></div>
    {(['likes','plays'] as const).map(metric=>{const value=selection.metrics?.[metric];return <div key={metric} data-work-metric={metric}><small>{metric==='likes'?'作品累计点赞合计':'作品累计播放合计'}</small><strong>{number(value?.value)}</strong><span>{value?`${number(value.known)} / ${number(total)} 条有值 · ${number(value.missing)} 条未取得`: '当前版本尚未提供合并后的指标'}</span>{value?.conflicts>0&&<small>{number(value.conflicts)} 条数值冲突，未计入合计</small>}{value?.overflow&&<small>合计超出安全数值范围，请核对明细</small>}</div>;})}
    <div><small>未记录发布日期</small><strong>{number(selection.undatedWorks)}</strong><span>{startDate||endDate?'保留在作品库，未计入当前日期区间':'保留在全部作品合计，不放入日期曲线'}</span></div>
   </section>
   <p className="meta">同一作品合并已有来源后逐项采用有效值，不重复相加。以上是这些作品的累计字段，<strong>不是这段日期新增的点赞或播放</strong>；播放字段未经逐条平台核验。缺测、冲突与数值溢出不补零。</p>
   <div className="period-toolbar" aria-label="发布记录完整情况"><span>有记录 {knownDays.length} 天 · 无记录 {days.length-knownDays.length} 天</span><span>最近有记录 {latest?.date??'—'}</span>{undatedCount!=null&&undatedCount>0&&<Button variant="outline" onClick={()=>chooseDay('')}>查看未记录日期的作品 · {undatedCount.toLocaleString('zh-CN')} 条</Button>}</div>
  </>}
  <div hidden={!index||!!selection.error}><PublishingChart days={days} track={track} trackLabel={label} unified onInspect={focus=>chooseDay(focus.startDate)}/></div>
  {day!==null&&index&&!selection.error&&<div className="panel" role="region" aria-label="所选发布日作品"><h3>{day||'未记录发布日期'} · {selectedCount?.toLocaleString('zh-CN')??'—'} 条已入库 · {label}</h3>
   {!current||current.busy?<p role="status">正在核验所选作品…</p>:current.error?<div role="alert" className="notice">{current.error} <Button variant="outline" onClick={()=>retryDay(value=>value+1)}>重新读取所选作品</Button></div>:<>
    <div className="table-scroll"><table className="data-table"><thead><tr>{[['author','作者'],['id','作品'],['date','发布日'],['likes','累计点赞'],['plays','累计播放']].map(([key,label])=><th key={key} aria-sort={sort===key?(direction==='asc'?'ascending':'descending'):'none'}><button type="button" onClick={()=>rank(key)}>{label}{sort===key?(direction==='asc'?' ↑':' ↓'):''}</button></th>)}<th>内容分类</th></tr></thead><tbody>{rows.slice((page-1)*20,page*20).map(row=><tr key={row.contentId}><td>{row.author||'未署名'}</td><td><a href={'https://www.douyin.com/video/'+row.contentId} target="_blank" rel="noopener noreferrer">{row.title||row.contentId}</a><small> · ID {row.contentId}</small></td><td>{row.date||'未记录'}</td>{(['likes','plays'] as const).map(metric=><td key={metric}>{number(row.metrics?.[metric]?.value)}{row.metrics?.[metric]?.origin==='conflict'&&<small>数值冲突待核</small>}</td>)}<td>{row.classifications.length?row.classifications.map((key:string)=>publishingTracks.find((item:Row)=>item.key===key)?.label||key).join(' / '):'未标注分类'}</td></tr>)}</tbody></table></div>
    {!rows.length&&<p>当前日期没有符合此分类的已收录作品。</p>}
    <div className="toolbar" role="navigation" aria-label="发布作品分页"><button type="button" disabled={page<=1} onClick={()=>setPage(value=>value-1)}>上一页</button><span aria-live="polite">第 {page} / {Math.max(1,Math.ceil(rows.length/20))} 页</span><button type="button" disabled={page*20>=rows.length} onClick={()=>setPage(value=>value+1)}>下一页</button></div>
   </>}
  </div>}
 </section>;
}
