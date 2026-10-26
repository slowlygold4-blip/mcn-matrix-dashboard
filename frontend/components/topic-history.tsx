"use client";
import {useEffect,useRef,useState,type KeyboardEvent} from 'react';
import {Card,CardContent} from '@/components/ui/card';
import {TableBody,TableCell,TableHead,TableHeader,TableRow} from '@/components/ui/table';
import {ScrollableTable as Table} from '@/components/scrollable-table';
import {ChangeIndicator} from '@/components/change-indicator';
import {DailyChangeTrend} from '@/components/daily-change-trend';

type Point={id:number;targetId:number;date:string;capturedAt:string;participants:number|null;views:number|null;participantsDelta:number|null;viewsDelta:number|null;sourceChecksum:string|null;qualityStatus:string;metricsEvidence:string;participantsBaselineAt:string|null;participantsBaselineChecksum:string|null;viewsBaselineAt:string|null;viewsBaselineChecksum:string|null};
type Topic={id:number;label:string};
const number=(value:number|null|undefined)=>value==null?'—':value.toLocaleString('zh-CN');
const change=(value:number|null|undefined)=>value==null?'—':(value>0?'+':'')+number(value);
const time=(value:string|null|undefined)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未保存';
const fingerprint=(value:string|null|undefined)=>value&&/^[a-f0-9]{64}$/.test(value)?value:'未保存有效指纹';
const quality:Record<string,string>={validated:'已校验',warning:'有警告',partial:'部分指标',unverified:'未通过来源校验',invalid:'无效记录'};

// These are calendar labels, not invented observations. Only a verified pair of
// consecutive Beijing business dates can produce a daily play change.
const businessDate=(date:string,offset:number)=>{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return null;
 const start=new Date(`${date}T00:00:00.000Z`);
 if(!Number.isFinite(start.getTime())||start.toISOString().slice(0,10)!==date)return null;
 return new Date(start.getTime()+offset*86_400_000).toISOString().slice(0,10);
};
const verifiedSource=(point:Point|undefined)=>point?.metricsEvidence==='topic-identity-source-run-time-vector-bound'
  &&['validated','warning'].includes(point.qualityStatus)
  &&/^[a-f0-9]{64}$/.test(point.sourceChecksum??'')
  &&Number.isFinite(Date.parse(point.capturedAt));
const verifiedMetric=(point:Point|undefined,key:'participants'|'views')=>{
 const value=point?.[key];
 return verifiedSource(point)&&typeof value==='number'
  &&Number.isSafeInteger(value)&&value>=0?value:null;
};

export function recentTopicPlayDays(items:Point[],days=7,key:'participants'|'views'='views'){
 const ordered=[...items].sort((a,b)=>a.date.localeCompare(b.date)||a.capturedAt.localeCompare(b.capturedAt));
 const latest=ordered.at(-1)?.date;
 if(!latest||!businessDate(latest,0))return [];
 const byDate=new Map(ordered.map(point=>[point.date,point]));
 return Array.from({length:days},(_,index)=>{
  const date=businessDate(latest,index-days+1)!;
  const point=byDate.get(date),views=verifiedMetric(point,key),prior=verifiedMetric(byDate.get(businessDate(date,-1)!),key);
  const missing=views===null?(!point?'未采样':point[key]==null?'指标缺测':'来源未核验'):null;
  return {date,point,views,viewsDelta:views===null||prior===null?null:views-prior,missing,growthMissing:views!==null&&prior===null?'前一日缺测或未核验':null};
 }).reverse();
}

function TopicNumber({value,label,unit,signed=false}:{value:number|null|undefined;label:string;unit:string;signed?:boolean}){
 const region=useRef<HTMLDivElement>(null),[overflow,setOverflow]=useState(false);
 const text=signed?change(value):number(value);
 useEffect(()=>{
  const node=region.current;if(!node)return;
  let active=true;
  const measure=()=>{if(active)setOverflow(node.scrollWidth>node.clientWidth+1);};
  const observer=new ResizeObserver(measure);observer.observe(node);
  if(node.firstElementChild)observer.observe(node.firstElementChild);
  measure();void document.fonts.ready.then(measure);
  return()=>{active=false;observer.disconnect();};
 },[text]);
 function move(event:KeyboardEvent<HTMLDivElement>){
  const node=event.currentTarget;
  if(event.target!==node||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||node.scrollWidth<=node.clientWidth+1)return;
  if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();node.scrollBy({left:event.key==='ArrowLeft'?-120:120,behavior:'instant'});}
  else if(event.key==='Home'||event.key==='End'){event.preventDefault();node.scrollTo({left:event.key==='Home'?0:node.scrollWidth,behavior:'instant'});}
 }
 return <div className="topic-number-shell"><div className="topic-number" ref={region} tabIndex={overflow?0:undefined} role={overflow?'group':undefined} aria-label={overflow?`${label}：${text}${value==null?'（未保存）':unit}`:undefined} onKeyDown={move}><span className="topic-number-content" aria-hidden={overflow?true:undefined}><strong>{text}</strong>{value!=null&&<small className="topic-number-unit">{unit}</small>}</span></div>{overflow&&<small className="topic-number-hint">左右滚动查看完整数值 · 键盘可聚焦后按 ← →</small>}</div>;
}

function TopicSource({point}:{point:Point}){
 const verified=verifiedSource(point);
 return <div className="topic-source">
  <p>真实采样时间（北京时间）：{time(point.capturedAt)}</p>
  <p>记录状态：{quality[point.qualityStatus]??'未识别状态'} · {verified?'话题身份、来源与采样记录已绑定':'未通过当前来源校验；缺失指标不补零'}</p>
  <p>原采样来源指纹 SHA256 <code>{fingerprint(point.sourceChecksum)}</code></p>
  {(['participants','views'] as const).map(key=>point[`${key}Delta`]==null?null:<p key={key}>{key==='participants'?'参与人数':'播放量'}变化的前日采样：{time(point[`${key}BaselineAt`])}<br/>前日来源 SHA256 <code>{fingerprint(point[`${key}BaselineChecksum`])}</code></p>)}
  <p>来源指纹用于核对保存记录，不是话题链接，也不是公开历史分区的文件指纹。</p>
 </div>;
}

/** Read only the published observations: no invented URL, midnight sample, or zero-filled gap. */
export function TopicHistory({topic,items}:{topic:Topic;items:Point[]}){
 const list=items.filter(point=>point.targetId===topic.id).sort((a,b)=>a.date.localeCompare(b.date)||a.capturedAt.localeCompare(b.capturedAt)),latest=list.at(-1);
 const byDate=new Map(list.map(point=>[point.date,point]));
 const recent=recentTopicPlayDays(list);
 const [trendMetric,setTrendMetric]=useState<'participants'|'views'>('views');
 const trendDays=recentTopicPlayDays(list,7,trendMetric).reverse();
 return <Card><CardContent><h2>{topic.label}</h2>
  <div className="topic-values">{([['participants','参与人数','人'],['views','累计实际播放量','次']] as const).map(([key,label,unit])=>{
   const observed=[...list].reverse().find(point=>verifiedMetric(point,key)!==null);
   const value=verifiedMetric(observed,key);
   const previous=observed?byDate.get(businessDate(observed.date,-1)??''):undefined;
   const baseline=verifiedMetric(previous,key);
   const delta=value===null||baseline===null?null:value-baseline;
   const sign=delta==null?'missing':delta>0?'positive':delta<0?'negative':'neutral';
   return <div key={key}><small>{label}</small><TopicNumber value={value} label={label} unit={unit}/><p className="meta">{observed?`最近有效采样 ${time(observed.capturedAt)}`:'尚无有效采样'}{observed&&latest&&observed.id!==latest.id?' · 最新采样日该项缺测或未核验':''}</p><div className="topic-delta" data-sign={sign}><small>相邻日变化</small><ChangeIndicator value={delta}/><TopicNumber value={delta} label={`${label}相邻日变化`} unit={unit} signed/></div></div>;
  })}</div>
  <p className="meta">最近采样记录 {time(latest?.capturedAt)}；两项指标分别使用最近有效观察，缺测日不补零。</p>
  <div className="topic-trend-switch" role="group" aria-label={`${topic.label}变化曲线指标`}>
   <button type="button" aria-pressed={trendMetric==='views'} onClick={()=>setTrendMetric('views')}>播放量变化</button>
   <button type="button" aria-pressed={trendMetric==='participants'} onClick={()=>setTrendMetric('participants')}>参与人数变化</button>
  </div>
  <DailyChangeTrend points={trendDays.map(day=>({date:day.date,value:day.viewsDelta}))} label={trendMetric==='views'?'每日播放净变化':'每日参与人数净变化'} unit={trendMetric==='views'?'次':'人'}/>
  <p className="meta">点击曲线下方日期查看变化。仅计算相邻日可核验的采样差值，断线不代表没有增长。</p>
  <section className="topic-recent-days" aria-label={`${topic.label}近 7 天实际播放增长`}>
   <h3>近 7 天实际播放增长</h3>
   <p className="meta">{latest?`截至最近保存的采样日 ${latest.date}，向前 7 个日历日；`:'尚无已保存采样日；'}按北京时间逐日对比累计实际播放量。只有相邻两日均有可核验观察值才计算增长；缺测为 —，不是 0，也不使用点赞估算。</p>
   {recent.length>0?<Table><TableHeader><TableRow><TableHead>北京时间日期</TableHead><TableHead>累计实际播放</TableHead><TableHead>当日新增播放</TableHead></TableRow></TableHeader><TableBody>{recent.map(day=><TableRow key={day.date}><TableCell>{day.date}</TableCell><TableCell>{number(day.views)}{day.missing&&<span className="meta"> · {day.missing}</span>}</TableCell><TableCell><span className={day.viewsDelta!=null?(day.viewsDelta>0?'positive':day.viewsDelta<0?'negative':''):undefined}>{change(day.viewsDelta)}</span>{day.growthMissing&&<span className="meta"> · {day.growthMissing}</span>}</TableCell></TableRow>)}</TableBody></Table>:<p className="empty">暂无已保存的采样日。</p>}
  </section>
  <details className="topic-days"><summary>全部 {list.length} 个已保存采样日</summary>
   <p className="meta">点击日期核对当天真实采样时间与来源。— 表示该日未保存可校验的指标，不等于 0；相邻日缺测时不计算变化。</p>
   <Table><TableHeader><TableRow><TableHead>观察日 / 来源</TableHead><TableHead>参与</TableHead><TableHead>播放</TableHead></TableRow></TableHeader><TableBody>{[...list].reverse().map(point=><TableRow key={point.id}><TableCell><details><summary aria-label={`查看 ${topic.label} ${point.date} 的采样来源`}>{point.date}</summary><TopicSource point={point}/></details></TableCell><TableCell>{number(verifiedMetric(point,'participants'))}</TableCell><TableCell>{number(verifiedMetric(point,'views'))}</TableCell></TableRow>)}</TableBody></Table>
   {!list.length&&<p className="empty">暂无已保存的采样日。</p>}
  </details>
 </CardContent></Card>;
}
