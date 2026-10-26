"use client";
import {useEffect,useState} from 'react';
import {PublishingChart} from './publishing-chart';
import {readReplicaPart} from '@/lib/replica-reader.mjs';
import {publishingPartValid} from '@/lib/replica-publishing.mjs';
type Row=Record<string,any>;
/** A small date index first; work rows are fetched only for the chosen day. */
export function ContinuousPublishing({manifest}:{manifest:Row}){
 const [index,setIndex]=useState<Row|null>(null),[error,setError]=useState(''),[day,setDay]=useState(''),[rows,setRows]=useState<Row[]>([]),[busy,setBusy]=useState(false),[page,setPage]=useState(1);
 useEffect(()=>{const c=new AbortController();setIndex(null);setError('');setRows([]);setDay('');
  const meta=manifest.files.find((m:Row)=>m.path==='publishing.json');
  if(!meta){setError('每日发片索引正在接入本轮公开数据；不会用旧表日期冒充最新监控。');return;}
  readReplicaPart({generation:manifest.asOf,part:meta.path,meta,signal:c.signal}).then((v:Row)=>{if(!publishingPartValid(v,meta,manifest.asOf))throw Error('每日发片索引无效');if(!c.signal.aborted)setIndex(v);}).catch((e:Error)=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();
 },[manifest]);
 useEffect(()=>{if(!day||!index)return;const c=new AbortController();setRows([]);setBusy(true);setPage(1);setError('');
  (async()=>{const d=index.days.find((x:Row)=>x.date===day),all:Row[]=[];if(!d)throw Error('日期不在索引中');
   for(const path of d.parts){const meta=manifest.files.find((m:Row)=>m.path===path);const v=await readReplicaPart({generation:manifest.asOf,part:path,meta,signal:c.signal});if(!publishingPartValid(v,meta,manifest.asOf)||v.items.some((r:Row)=>r.date!==day))throw Error('作品日期核验失败');all.push(...v.items);}
   if(all.length!==d.works||new Set(all.map(r=>r.contentId)).size!==all.length)throw Error('作品数量或去重核验失败');if(!c.signal.aborted)setRows(all);
  })().catch((e:Error)=>{if(!c.signal.aborted)setError(e.message);}).finally(()=>{if(!c.signal.aborted)setBusy(false);});return()=>c.abort();
 },[day,index,manifest]);
 type Day={date:string;works:number|null;tracks:Record<string,number>};
 const observed=new Map<string,Day>((index?.days||[]).map((d:Row)=>[d.date,{date:d.date,works:d.works,tracks:d.tracks}]));
 const endDay=new Date(Date.parse(manifest.asOf)+8*3600000).toISOString().slice(0,10);
 const days:Day[]=[];
 for(let t=Date.parse('2026-09-12');t<=Date.parse(endDay);t+=86400000){const date=new Date(t).toISOString().slice(0,10);days.push(observed.get(date)||{date,works:null,tracks:{}});}
 return <section className="panel" id="source-ops-publishing" tabIndex={-1} aria-label="持续监控每日发片"><p className="eyebrow">团团全矩阵 · 9 月 12 日起 · 持续积累</p>{index&&<h2>全部已入库作品 · {index.count.toLocaleString('zh-CN')} 条</h2>}
  <p className="meta">本图覆盖团团全矩阵，不随账号列表筛选改变。所有已入库作品按 ID 去重，按发布日期计数。这里是已发现数量，作品采集尚未全覆盖；未显示的日期表示未取得记录，不等于零。数据截至 {new Date(manifest.asOf).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}（北京时间）。</p>
  {error&&<p role="alert" className="notice">{error}</p>}
  {!index&&!error?<p role="status">正在读取每日发片索引…</p>:index&&<PublishingChart days={days} track="all" unified onInspect={focus=>setDay(focus.startDate)}/>}
  {day&&<div className="panel"><h3>{day} 发布的作品 · {index?.days.find((d:Row)=>d.date===day)?.works.toLocaleString('zh-CN')} 条已入库</h3>
   {busy?<p role="status">正在核验当天作品…</p>:<><div className="table-scroll"><table className="data-table"><thead><tr><th>作者</th><th>作品</th><th>发布日</th></tr></thead><tbody>{rows.slice((page-1)*20,page*20).map(r=><tr key={r.contentId}><td>{r.author||'未署名'}</td><td><a href={'https://www.douyin.com/video/'+r.contentId} target="_blank" rel="noopener noreferrer">{r.title||r.contentId}</a><small> · ID {r.contentId}</small></td><td>{r.date}</td></tr>)}</tbody></table></div><div className="toolbar"><button disabled={page<=1} onClick={()=>setPage(p=>p-1)}>上一页</button><span>第 {page} / {Math.max(1,Math.ceil(rows.length/20))} 页</span><button disabled={page*20>=rows.length} onClick={()=>setPage(p=>p+1)}>下一页</button></div></>}
  </div>}
 </section>;
}
