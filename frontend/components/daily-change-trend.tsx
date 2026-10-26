"use client";
import {useState} from 'react';
import {ChangeIndicator,ChangeLegend,changeState} from '@/components/change-indicator';

type Point={date:string;value:number|null};
const valid=(value:number|null)=>typeof value==='number'&&Number.isFinite(value);
export function changeGeometry(points:Point[]){
 const max=Math.max(1,...points.map(p=>valid(p.value)?Math.abs(p.value!):0));
 return points.map((p,i)=>({...p,x:28+i*544/Math.max(1,points.length-1),y:valid(p.value)?80-(p.value!/max)*58:null}));
}
const format=(value:number|null)=>value===null?'—':`${value>0?'+':''}${value.toLocaleString('zh-CN')}`;
export function DailyChangeTrend({points,label,unit}:{points:Point[];label:string;unit:string}){
 const [selected,setSelected]=useState<string|null>(null);
 const active=points.find(p=>p.date===selected)??points.at(-1);
 const geometry=changeGeometry(points);
 if(!active)return null;
 return <section className="daily-change-trend" aria-label={label}>
  <div className="daily-change-trend__readout" aria-live="polite"><span>{active.date} · {label}</span><b>{format(active.value)}{active.value!==null&&<small> {unit}</small>}</b><ChangeIndicator value={active.value}/></div>
  <svg viewBox="0 0 600 160" role="img" aria-label={`${label}：${points.map(p=>`${p.date} ${format(p.value)}`).join('；')}。断线表示缺少相邻日数据。`}>
   <line x1="28" y1="80" x2="572" y2="80" className="daily-change-trend__zero"/><text x="6" y="84">0</text>
   {geometry.map((p,i)=>{const prev=geometry[i-1],kind=changeState(p.value).kind;return <g key={p.date} data-change={kind}>
    {p.y!==null&&prev?.y!=null&&<line x1={prev.x} y1={prev.y} x2={p.x} y2={p.y} className="daily-change-trend__line"/>}
    {p.y!==null?<circle cx={p.x} cy={p.y} r={active.date===p.date?6:4} className="daily-change-trend__point"/>:<path d={`M ${p.x-4} 76 l 8 8 m -8 0 l 8 -8`} className="daily-change-trend__missing"/>}
   </g>;})}
  </svg>
  <div className="daily-change-trend__days" role="group" aria-label={`选择${label}日期`}>{points.map(p=><button key={p.date} type="button" aria-pressed={active.date===p.date} aria-label={`${p.date}，${format(p.value)}，${changeState(p.value).label}`} onClick={()=>setSelected(p.date)}>{p.date.slice(5).replace('-','/')}</button>)}</div>
  <ChangeLegend/>
 </section>;
}
