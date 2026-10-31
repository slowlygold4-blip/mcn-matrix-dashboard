"use client";
import {useRef,useState} from 'react';
import {Button} from '@/components/ui/button';

type Day={date:string;works:number|null;tracks:Record<string,number>;dateCounts?:Record<string,{confirmed:number;unverified:number;missing:number}>|null};
type Focus={view:'works';track:string;startDate:string;endDate:string;mainTableOnly:true};
const number=(value:number|null)=>value==null?'待采全':value.toLocaleString('zh-CN');

/** Count dated discovered works, never measurement dates or missing-day zeros. */
export function PublishingChart({days,track,onInspect,unified=false,trackLabel}:{days:Day[];track:string;onInspect:(focus:Focus)=>void;unified?:boolean;trackLabel?:string}){
 const [selection,setSelection]=useState('');
 const buttons=useRef(new Map<string,HTMLButtonElement>());
 const selected=days.find(day=>day.date===selection)??days.at(-1);
 const count=(day:Day)=>day.works==null?null:track==='all'?day.works:day.tracks[track]??0;
 const dateCounts=(day:Day)=>day.dateCounts?.[track]??null;
 const known=days.map(count).filter((value):value is number=>value!==null);
 const maximum=known.length?Math.max(...known):null;
 const scale=Math.max(1,maximum??0),latest=days.findLast(day=>count(day)!==null);
 function move(index:number){
  const day=days[Math.max(0,Math.min(days.length-1,index))];
  if(!day)return;
  setSelection(day.date);buttons.current.get(day.date)?.focus({preventScroll:true});
  buttons.current.get(day.date)?.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
 }
 return <div className="source-ops-panel source-ops-chart">
  <div className="source-ops-panel-head"><div><p className="source-ops-kicker">按发布日期统计</p><h3>每日发布情况</h3><span>点击柱形选日期，再查看当天作品 · 当前为{trackLabel||(track==='all'?'全部内容':track)}</span></div></div>
  {!selected?<p>暂时没有带发布日期的作品。未记录日期的作品仍保留在全部作品里。</p>:<>
   <div className="source-ops-chart-selection">
    <label>选择发布日<select aria-label="选择发布日" value={selected.date} onChange={event=>setSelection(event.target.value)}>{days.map(day=><option key={day.date} value={day.date}>{day.date} · {number(count(day))} 条</option>)}</select></label>
    <div aria-live="polite" aria-atomic="true"><strong>{number(count(selected))}</strong><span>{count(selected)==null?'尚无有效记录':'条作品记录'} · {selected.date}</span></div>
    {dateCounts(selected)?<span className="meta">明确日期 {number(dateCounts(selected)!.confirmed)} 条 · 日期待核验 {number(dateCounts(selected)!.unverified)} 条</span>:<span className="meta">日期依据尚未分别核验，当前为已收录记录数</span>}
    <Button variant="outline" disabled={count(selected)==null} onClick={()=>onInspect({view:'works',track,startDate:selected.date,endDate:selected.date,mainTableOnly:true})}>查看当天作品 →</Button>
   </div>
   {count(selected)===null&&latest&&<Button variant="outline" onClick={()=>move(days.indexOf(latest))}>最近有记录：{latest.date}</Button>}
   <div className="source-ops-bars" role="group" aria-label="每日作品记录数量；左右方向键选择日期">
    {days.map((day,index)=><button type="button" className="source-ops-bar-column" key={day.date} ref={node=>{if(node)buttons.current.set(day.date,node);else buttons.current.delete(day.date);}} tabIndex={selected.date===day.date?0:-1} aria-label={`${day.date}，${number(count(day))} 条作品`} aria-pressed={selected.date===day.date} title={`${day.date}：${number(count(day))} 条${dateCounts(day)?`；明确日期 ${number(dateCounts(day)!.confirmed)} 条；日期待核验 ${number(dateCounts(day)!.unverified)} 条`:''}`} onClick={()=>setSelection(day.date)} onKeyDown={event=>{
     const next=event.key==='ArrowRight'?index+1:event.key==='ArrowLeft'?index-1:event.key==='Home'?0:event.key==='End'?days.length-1:null;
     if(next!==null){event.preventDefault();move(next);}
    }}><span className="source-ops-bar" aria-hidden="true" style={{height:count(day)==null?'8%':`${(count(day)??0)/scale*86}%`,...(count(day)==null?{background:'repeating-linear-gradient(45deg,#596575 0 2px,transparent 2px 5px)'}:{})}}/><span aria-hidden="true">{day.date.slice(8)}</span></button>)}
   </div>
   <div className="source-ops-chart-foot"><span>{days[0].date}</span><span>{maximum===null?'尚无有效发布记录':`最高 ${number(maximum)} 条 / 日`}</span><span>{days.at(-1)?.date}</span></div>
   <p className="source-ops-chart-hint">{unified?'全部记录按作品 ID 去重；明确日期用于确认发布，推算或待核验日期保留作参考。采集未全覆盖，缺记录日期不补零。':'统计已有日期的作品记录；日期可能尚待核验，不是每日播放增长。图中没有的日期未补零。'}</p>
  </>}
 </div>;
}
