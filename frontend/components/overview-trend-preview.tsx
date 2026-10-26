"use client";

import {useEffect,useMemo,useRef,useState} from "react";
import {buildOverviewTrendPreview,buildDailyOverviewTrend,overviewTrendGeometry} from "@/lib/overview-trend-preview.mjs";

type Row=Record<string,unknown>;
type Metric='followers'|'likes'|'posts';
type Props={accounts:Row[];points:Row[];start:string;end:string;ready:boolean;metric?:Metric;initialMode?:'daily'|'cumulative'};
const labels:Record<Metric,string>={followers:'粉丝',likes:'主页获赞',posts:'作品存量'};

const number=(value:number|null|undefined)=>value==null?"—":`${value>0?"+":""}${value.toLocaleString("zh-CN")}`;

/** Small overview cue, not a substitute for the interactive full-range chart. */
export function OverviewTrendPreview({accounts,points,start,end,ready,metric='followers',initialMode='daily'}:Props){
 const [mode,setMode]=useState(initialMode);
 const daily=mode==='daily';
 const trend=useMemo(()=>(daily?buildDailyOverviewTrend:buildOverviewTrendPreview)(accounts,points,{start,end,ready,metric}),[accounts,points,start,end,ready,metric,daily]);
 const chartRef=useRef<HTMLDivElement>(null);
 const [plotSize,setPlotSize]=useState({width:320,height:106});
 const geometry=useMemo(()=>trend.state==='ready'?overviewTrendGeometry(trend.samples,{...plotSize,padding:12}):null,[trend,plotSize]);
 useEffect(()=>{
  const chart=chartRef.current;
  if(trend.state!=='ready'||!chart||typeof ResizeObserver==='undefined')return;
  let frame=0;
  const measure=()=>{
   frame=0;
   const bounds=chart.querySelector('svg')?.getBoundingClientRect();
   if(!bounds)return;
   const width=Math.max(80,Math.round(bounds.width)),height=Math.max(60,Math.round(bounds.height));
   setPlotSize(current=>current.width===width&&current.height===height?current:{width,height});
  };
  const observer=new ResizeObserver(()=>{if(!frame)frame=requestAnimationFrame(measure);});
  observer.observe(chart);
  const svg=chart.querySelector('svg');
  if(svg)observer.observe(svg);
  measure();
  return()=>{observer.disconnect();if(frame)cancelAnimationFrame(frame);};
 },[trend.state,metric]);
 const [selectedDate,setSelectedDate]=useState<string|null>(null);
 const [hoveredDate,setHoveredDate]=useState<string|null>(null);
 const scrubbing=useRef(false);
 useEffect(()=>{setSelectedDate(null);setHoveredDate(null);},[metric,mode]);
 function selectObservedAt(clientX:number){
  const svg=chartRef.current?.querySelector('svg');
  if(!svg||!geometry?.dots.length)return;
  const bounds=svg.getBoundingClientRect();
  if(bounds.width<=0)return;
  const x=(clientX-bounds.left)/bounds.width*geometry.width;
  const nearest=geometry.dots.reduce((best,dot)=>Math.abs(dot.x-x)<Math.abs(best.x-x)?dot:best);
  setHoveredDate(null);
  setSelectedDate(previous=>previous===nearest.date?previous:nearest.date);
 }
 const selectedPoint=geometry?.dots.find(dot=>dot.date===selectedDate)??null;
 const hoveredPoint=geometry?.dots.find(dot=>dot.date===hoveredDate)??null;
 const endpointPoint=geometry?.dots.find(dot=>dot.date===trend.lastVisibleDate)??null;
 // Keep only one observed point in the Tab order; arrows still reach every dot.
 const keyboardPoint=selectedPoint??endpointPoint??geometry?.dots.at(-1)??null;
 const activePoint=hoveredPoint??selectedPoint??endpointPoint;
 const displayedValue=activePoint?.value??trend.endpointValue;
 const displayedDate=activePoint?.date??trend.lastVisibleDate;
 const displayedContext=hoveredPoint?'指向采样日':selectedPoint?'已选采样日':'区间终点';
 const title=`${labels[metric]}${daily?'每日净变化':'累计净变化'}`;
 const basis=daily?'相对前一自然日':`相对 ${trend.baselineDate}`;
 return <figure id="overview-trend-preview" className="overview-trend-preview" data-metric={metric}>
  <div className="toolbar" role="group" aria-label="曲线计算方式"><button aria-pressed={daily} onClick={()=>setMode('daily')}>每日增长</button><button aria-pressed={!daily} onClick={()=>setMode('cumulative')}>区间累计变化</button></div>
  <figcaption className="overview-trend-preview__head">
   <strong aria-live="polite">{title}</strong>
   <span className="overview-trend-preview__hint-desktop">末尾最多 14 个自然日 · 主页快照 · 指向或点击采样点，方向键逐日切换</span>
   <span className="overview-trend-preview__hint-touch">末尾最多 14 天 · 在曲线上滑动查看真实采样日</span>
  </figcaption>
  {trend.state==='loading'?<p role="status" className="overview-trend-preview__status">正在核对所选区间；暂不显示旧曲线。</p>
   :trend.state==='error'?<p role="status" className="overview-trend-preview__status">日期或快照未通过核对，曲线暂不可用。</p>
   :trend.state==='empty'?<p role="status" className="overview-trend-preview__status">{daily?'当前窗口没有相邻两天均已采样的':'所选起止日期没有两端都可比的'}{labels[metric]}数据；缺测不补零。</p>
   :<>
    <p className="overview-trend-preview__basis">{daily?`每日仅统计相邻两天均有值的账号；各日覆盖可能不同，不能直接相加冒充全矩阵累计。当前点可比 ${activePoint?.known??0}/${trend.totalCount} 个账号`:`相对所选起点 ${trend.baselineDate} · 固定可比 ${trend.cohortCount.toLocaleString('zh-CN')}/${trend.totalCount.toLocaleString('zh-CN')} 个账号`}</p>
    <div key={metric} className="overview-trend-preview__plot">
     <div className="overview-trend-preview__chart" ref={chartRef}>
      <svg className="overview-trend-preview__svg" role="group" aria-label={`${title}真实采样点，按 Tab 进入图表，再用方向键逐日查看`} viewBox={`0 0 ${geometry!.width} ${geometry!.height}`} preserveAspectRatio="none">
       <line x1="0" x2={geometry!.width} y1={geometry!.zeroY} y2={geometry!.zeroY} stroke="var(--mcn-line, #30364e)" strokeDasharray="3 5" aria-hidden="true"/>
       {activePoint&&<line className="overview-trend-preview__guide" x1={activePoint.x} x2={activePoint.x} y1="6" y2={geometry!.height-6} stroke="var(--preview-accent, #6be4e7)" strokeDasharray="3 5" pointerEvents="none" aria-hidden="true"/>}
       {geometry!.paths.map((path,index)=><path key={index} className="overview-trend-preview__line" pathLength={1} d={path} fill="none" stroke="var(--preview-accent, #6be4e7)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" aria-hidden="true"/>)}
       {geometry!.dots.map((dot,index)=><g key={`${dot.date}-${index}`}>
        {activePoint?.date===dot.date&&<circle className="overview-trend-preview__selection" cx={dot.x} cy={dot.y} r="7" fill="none" stroke="var(--preview-accent, #6be4e7)" strokeWidth="1.5" pointerEvents="none" aria-hidden="true"/>}
        <circle cx={dot.x} cy={dot.y} r={index===geometry!.dots.length-1?3.6:2.3} fill="var(--preview-accent, #6be4e7)" pointerEvents="none" aria-hidden="true"/>
        <circle className="overview-trend-preview__point" data-selected={activePoint?.date===dot.date?"true":"false"} cx={dot.x} cy={dot.y} r="12" fill="transparent" role="button" tabIndex={keyboardPoint?.date===dot.date?0:-1} aria-pressed={selectedPoint?.date===dot.date} aria-label={`${dot.date}，${daily?'相对前一自然日的':'相对所选起点的'}${labels[metric]}净变化 ${number(dot.value)}`} style={{cursor:"pointer"}} onPointerEnter={event=>{if(event.pointerType!=="touch")setHoveredDate(dot.date);}} onPointerLeave={()=>setHoveredDate(null)} onClick={()=>setSelectedDate(dot.date)} onFocus={()=>{setHoveredDate(null);setSelectedDate(dot.date);}} onKeyDown={event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();setSelectedDate(dot.date);return;}const points=Array.from(event.currentTarget.ownerSVGElement?.querySelectorAll<SVGCircleElement>('.overview-trend-preview__point')??[]);const current=points.indexOf(event.currentTarget);const next=event.key==="ArrowRight"?Math.min(current+1,points.length-1):event.key==="ArrowLeft"?Math.max(current-1,0):event.key==="Home"?0:event.key==="End"?points.length-1:-1;if(next>=0){event.preventDefault();points[next]?.focus();}}}/>
       </g>)}
       <rect className="overview-trend-preview__touch-layer" x="0" y="0" width={geometry!.width} height={geometry!.height} fill="transparent" pointerEvents="none" aria-hidden="true" onPointerDown={event=>{if(event.pointerType==='mouse')return;scrubbing.current=true;try{event.currentTarget.setPointerCapture(event.pointerId);}catch{}selectObservedAt(event.clientX);}} onPointerMove={event=>{if(scrubbing.current)selectObservedAt(event.clientX);}} onPointerUp={event=>{if(!scrubbing.current)return;selectObservedAt(event.clientX);scrubbing.current=false;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}} onPointerCancel={()=>{scrubbing.current=false;}}/>
      </svg>
     </div>
     <div className="overview-trend-preview__current"><small>{displayedContext} · {displayedDate}</small><strong className={displayedValue!==null&&displayedValue<0?'negative':'positive'}>{number(displayedValue)}</strong></div>
    </div>
    <div className="overview-trend-preview__inspection">
     <p className="overview-trend-preview__reading" role="status" aria-live="polite" aria-atomic="true">{hoveredPoint?`${hoveredPoint.date} · ${basis}：${number(hoveredPoint.value)}`:selectedPoint?`${selectedPoint.date} · ${basis}：${number(selectedPoint.value)}`:`终点 ${trend.lastVisibleDate} · ${basis}：${number(trend.endpointValue)}`}</p>
     <label className="overview-trend-preview__date-picker">选择采样日 <select value={selectedPoint?.date??""} onChange={event=>{setHoveredDate(null);setSelectedDate(event.target.value||null);}}><option value="">区间终点{trend.endpointValue===null?"（缺测）":""}</option>{geometry!.dots.map(dot=><option key={dot.date} value={dot.date}>{dot.date} · {number(dot.value)}</option>)}</select></label>
    </div>
    <p role="status" className="overview-trend-preview__note"><span>{trend.firstVisibleDate} → {trend.lastVisibleDate}</span><span>{daily?'有可比数据':'完整采样'} {trend.completeDays}/{trend.samples.length} 日；缺测处断线，不插值。</span></p>
   </>}
 </figure>;
}
