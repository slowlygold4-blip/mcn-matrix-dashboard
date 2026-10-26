"use client";

import {useId,useLayoutEffect,useRef,useState,type KeyboardEvent,type ReactNode} from 'react';
import {Button} from '@/components/ui/button';

type ScrollState={horizontal:boolean;vertical:boolean;atStart:boolean;atEnd:boolean};
type TableScrollFrameProps={children:ReactNode;scrollLabel:string;staticLabel?:string;scrollSelector?:string;bounded?:boolean;scrollResetKey?:string};
const initialState:ScrollState={horizontal:false,vertical:false,atStart:true,atEnd:true};

/** Navigation for an existing scroll container. The frame never becomes another scroller. */
export function TableScrollFrame({children,scrollLabel,staticLabel,scrollSelector='[data-slot="table-container"]',bounded=false,scrollResetKey}:TableScrollFrameProps){
 const region=useRef<HTMLDivElement>(null),controls=useRef<HTMLDivElement>(null),areaRef=useRef<HTMLElement|null>(null);
 const [position,setPosition]=useState<ScrollState>(initialState);
 const helpId=useId();

 useLayoutEffect(()=>{
  const area=region.current?.querySelector<HTMLElement>(scrollSelector)??null;
  areaRef.current=area;
  if(!area){setPosition(initialState);return;}
  let frame:number|null=null,disposed=false;
  const measure=()=>{
   frame=null;if(disposed)return;
   const horizontal=area.clientWidth>0&&area.scrollWidth>area.clientWidth+1;
   const vertical=bounded&&area.clientHeight>0&&area.scrollHeight>area.clientHeight+1;
   const next={horizontal,vertical,atStart:!horizontal||area.scrollLeft<=1,atEnd:!horizontal||area.scrollLeft>=area.scrollWidth-area.clientWidth-1};
   // Only rescue focus owned by controls that are about to disappear. Never follow
   // a delayed measurement back into the table after the user has moved elsewhere.
   if(!horizontal&&controls.current?.contains(document.activeElement)&&region.current?.getClientRects().length)region.current.focus({preventScroll:true});
   setPosition(current=>Object.keys(next).every(key=>current[key as keyof ScrollState]===next[key as keyof ScrollState])?current:next);
  };
  const schedule=()=>{if(frame===null&&!disposed)frame=requestAnimationFrame(measure);};
  const observer=typeof ResizeObserver==='function'?new ResizeObserver(schedule):null;
  observer?.observe(area);
  const table=area.querySelector('table');if(table)observer?.observe(table);
  area.addEventListener('scroll',schedule,{passive:true});window.addEventListener('resize',schedule);
  // Reserve controls before paint/focus restoration; subsequent measurements are coalesced.
  measure();
  return()=>{disposed=true;if(frame!==null)cancelAnimationFrame(frame);observer?.disconnect();area.removeEventListener('scroll',schedule);window.removeEventListener('resize',schedule);if(areaRef.current===area)areaRef.current=null;};
 },[children,scrollSelector,bounded]);

 // A page or sorting change starts at its first row, while preserving the chosen columns.
 useLayoutEffect(()=>{if(bounded&&areaRef.current)areaRef.current.scrollTop=0;},[bounded,scrollResetKey]);

 function move(event:KeyboardEvent<HTMLDivElement>){
  if(event.target!==event.currentTarget||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
  const area=areaRef.current;if(!area||area.clientWidth<=0)return;
  if(bounded&&area.scrollHeight>area.clientHeight&&['ArrowUp','ArrowDown','PageUp','PageDown'].includes(event.key)){
   event.preventDefault();const step=event.key.startsWith('Page')?Math.max(44,area.clientHeight-(area.querySelector('thead')?.getBoundingClientRect().height||44)):44;
   area.scrollBy({top:['ArrowUp','PageUp'].includes(event.key)?-step:step,behavior:'instant'});
  }else if(area.scrollWidth>area.clientWidth+1){
   if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();area.scrollBy({left:event.key==='ArrowLeft'?-120:120,behavior:'instant'});}
   else if(event.key==='Home'||event.key==='End'){event.preventDefault();area.scrollTo({left:event.key==='Home'?0:area.scrollWidth,behavior:'instant'});}
  }
 }

 function moveColumns(direction:-1|1){
  const area=areaRef.current;if(!area||area.clientWidth<=0||area.scrollWidth<=area.clientWidth+1)return;
  if(direction<0&&area.scrollLeft<=1||direction>0&&area.scrollLeft>=area.scrollWidth-area.clientWidth-1)return;
  const first=area.querySelector<HTMLElement>('thead th:first-child');
  const firstStyle=first?getComputedStyle(first):null;
  const pinnedWidth=first&&firstStyle?.position==='sticky'&&firstStyle.left!=='auto'?first.getBoundingClientRect().width:0;
  const step=Math.max(120,Math.round((area.clientWidth-pinnedWidth)*.8));
  const reduce=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  area.scrollBy({left:step*direction,behavior:reduce?'instant':'smooth'});
 }

 const showHelp=position.horizontal||position.vertical;
 return <div className={bounded?'table-scroll-shell table-scroll-shell--bounded':'table-scroll-shell'}>
  {position.horizontal?<div ref={controls} className="table-scroll-controls">
   <p id={helpId} className="table-scroll-help">左右滑动查看完整指标<span>{position.vertical?'方向键或 PageUp / PageDown 浏览表格；Tab 进入表内操作':'聚焦表格后按 ← →；Tab 进入表内操作'}</span></p>
   <div className="table-scroll-buttons">
    <Button type="button" variant="outline" aria-label={`${scrollLabel}：向左查看`} aria-disabled={position.atStart} onClick={()=>moveColumns(-1)}><span aria-hidden="true">←</span> 向左</Button>
    <Button type="button" variant="outline" aria-label={`${scrollLabel}：向右查看`} aria-disabled={position.atEnd} onClick={()=>moveColumns(1)}>向右 <span aria-hidden="true">→</span></Button>
   </div>
  </div>:position.vertical?<p id={helpId} className="table-scroll-help table-scroll-help--vertical">表内上下滚动核对当前页 · 聚焦后用方向键或 PageUp / PageDown · Tab 进入表内操作</p>:null}
  <div ref={region} className="table-scroll-region" role="region" aria-label={showHelp?scrollLabel:staticLabel??scrollLabel} aria-describedby={showHelp?helpId:undefined} tabIndex={showHelp?0:-1} onKeyDown={move}>{children}</div>
 </div>;
}
