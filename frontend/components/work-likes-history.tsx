"use client";
import {useMemo,useState} from 'react';
import {Button} from '@/components/ui/button';
import {TableBody,TableCell,TableHead,TableHeader,TableRow} from '@/components/ui/table';
import {ScrollableTable as Table} from '@/components/scrollable-table';
import {buildWorkDailyLikes,dailyWorkLikesExport} from '@/lib/work-daily-likes.mjs';
import {historyExport} from '@/lib/replica-export.mjs';
import {csv} from '@/lib/replica-model.mjs';
type Row=Record<string,any>;
const fmt=(n:number|null)=>n===null?'—':n.toLocaleString('zh-CN');
const signed=(n:number|null)=>n===null?'—':(n>0?'+':'')+fmt(n);
const time=(s:string|null)=>s?new Date(s).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'缺测';
const reasons:Record<string,string>={'missing-current':'本日缺测','missing-baseline':'缺前日点赞','comparable':'相邻日可比'};

export function WorkLikesHistory({records,account,manifest,workId}:{records:Row[];account:Row;manifest:Row;workId:number}){
 const [view,setView]=useState<'daily'|'raw'>('daily'),[page,setPage]=useState(1),[sort,setSort]=useState('date'),[order,setOrder]=useState<'asc'|'desc'>('desc'),[note,setNote]=useState('');
 const result=useMemo(()=>{try{return {model:buildWorkDailyLikes(records,{targetId:account.id,workId,asOf:manifest.asOf}),error:''};}catch(e){return {model:null,error:(e as Error).message};}},[records,account.id,workId,manifest.asOf]);
 const model=result.model;
 const rows=useMemo(()=>[...(view==='daily'?model?.rows??[]:model?.samples??[])].sort((a:Row,b:Row)=>{
  const x=a[sort],y=b[sort];if(x==null||y==null)return x==null&&y==null?String(b.date??b.capturedAt).localeCompare(String(a.date??a.capturedAt)):x==null?1:-1;
  return (typeof x==='number'?x-y:String(x).localeCompare(String(y)))*(order==='asc'?1:-1);
 }),[model,view,sort,order]);
 if(!model)return <p className="error" role="alert">{result.error}</p>;
 const pages=Math.max(1,Math.ceil(rows.length/20));
 function choose(next:'daily'|'raw'){setView(next);setSort(next==='daily'?'date':'capturedAt');setOrder('desc');setPage(1);setNote('');}
 function rank(key:string){setOrder(sort===key&&order==='desc'?'asc':'desc');setSort(key);setPage(1);}
 function exportRows(){if(!model)return;try{
  const data=view==='daily'?dailyWorkLikesExport(model,{account,manifest}):historyExport({rows:model.samples,kind:'workMetrics',account,manifest});
  const url=URL.createObjectURL(new Blob([csv(data)],{type:'text/csv;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download=`${account.id}-${workId}-${view}-likes.csv`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setNote('已请求下载全部记录及真实采样时间。');
 }catch(e){setNote((e as Error).message);}}
 const pager=()=> <div className="pager"><span>{rows.length} 条 · 第 {page}/{pages} 页</span><Button variant="outline" disabled={page<=1} onClick={()=>setPage(x=>x-1)}>上一页</Button><Button variant="outline" disabled={page>=pages} onClick={()=>setPage(x=>x+1)}>下一页</Button></div>;
 return <section aria-label="单作品每日点赞变化"><div className="panel-head"><h3>单作品每日点赞变化</h3><Button variant={view==='daily'?'secondary':'outline'} aria-pressed={view==='daily'} onClick={()=>choose('daily')}>每日变化</Button><Button variant={view==='raw'?'secondary':'outline'} aria-pressed={view==='raw'} onClick={()=>choose('raw')}>原始采样</Button><Button variant="outline" disabled={!model.samples.length} onClick={exportRows}>导出全部{view==='daily'?'每日变化':'原始采样'}</Button></div>
 <p className="meta">作品 {model.externalId??workId} · 每个北京日采用最后一次有效点赞观测，与前一日观测作差；缺日不跨日凑数。</p>
 <div className="scope"><span>最近一次点赞 <strong>{fmt(model.latest?.likes??null)}</strong> · {time(model.latest?.likesAt??null)}</span><span>截止日 {model.end} 净变化 <strong className={model.current.likesDelta<0?'negative':model.current.likesDelta>0?'positive':''}>{signed(model.current.likesDelta)}</strong> · {reasons[model.current.reason]}</span></div>
 <p className="meta">{model.observedDays} 日有点赞观测 · {model.missingDays} 日缺测。日变化是两次观测的净差；今日未结束，不表示最终全天新增点赞。</p>
 {!!model.gaps.length&&<details><summary>查看缺测日期</summary>{model.gaps.map((gap:Row)=><p key={gap.start}>{gap.start}{gap.end!==gap.start?` 至 ${gap.end}`:''} · {gap.days} 日，未计为零</p>)}</details>}
 {note&&<p role="status">{note}</p>}{!model.samples.length&&<p className="empty">这条作品尚无点赞采样，不能计算增长。</p>}
 {pager()}<Table><TableHeader><TableRow>{(view==='daily'?[['date','北京日期'],['likes','作品点赞'],['likesDelta','日净变化'],['likesAt','指标采样时间']]:[['capturedAt','采样时间'],['likes','作品点赞']]).map(([key,label])=><TableHead key={key} aria-sort={sort===key?(order==='asc'?'ascending':'descending'):'none'}><Button variant="ghost" onClick={()=>rank(key)}>{label}{sort===key?(order==='asc'?' ↑':' ↓'):''}</Button></TableHead>)}{view==='daily'&&<TableHead>情况</TableHead>}</TableRow></TableHeader><TableBody>{rows.slice((page-1)*20,page*20).map((row:Row)=>view==='daily'?<TableRow key={row.date}><TableCell>{row.date}</TableCell><TableCell>{fmt(row.likes)}</TableCell><TableCell className={row.likesDelta<0?'negative':row.likesDelta>0?'positive':''}>{signed(row.likesDelta)}</TableCell><TableCell>{time(row.likesAt)}{row.baselineAt&&<small>前日 {time(row.baselineAt)}</small>}</TableCell><TableCell>{reasons[row.reason]}<small>{row.sampleCount} 次保存采样</small></TableCell></TableRow>:<TableRow key={row.id}><TableCell>{time(row.capturedAt)}</TableCell><TableCell>{fmt(row.likes)}</TableCell></TableRow>)}</TableBody></Table>{pager()}
 </section>;
}
