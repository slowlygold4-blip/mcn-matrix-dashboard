"use client";
import {useEffect,useRef,useState} from 'react';
import {Sparkles,Pause,ArrowUpRight} from 'lucide-react';
import {FIELD_POINTS,FRAME_INTERVAL,orbitPoint,shouldAnimate} from '@/lib/observatory-field.mjs';

export function MotionPreference(){
 const [enabled,setEnabled]=useState(true),[reduced,setReduced]=useState(false);
 useEffect(()=>{
  const media=matchMedia('(prefers-reduced-motion: reduce)');
  let saved=true;try{saved=localStorage.getItem('mcn-effects')!=='off';}catch{}
  setEnabled(saved);
  document.documentElement.dataset.effects=saved?'on':'off';
  const sync=()=>{setReduced(media.matches);document.dispatchEvent(new Event('mcn-effects-change'));};
  sync();media.addEventListener('change',sync);return()=>media.removeEventListener('change',sync);
 },[]);
 function toggle(){const next=!enabled;setEnabled(next);document.documentElement.dataset.effects=next?'on':'off';try{localStorage.setItem('mcn-effects',next?'on':'off');}catch{}document.dispatchEvent(new Event('mcn-effects-change'));}
 return <button className="motion-preference" onClick={toggle} disabled={reduced} aria-pressed={enabled&&!reduced} title={reduced?'已遵循系统的减少动态效果设置':'仅控制装饰动效，不影响采集与数据更新'}>{enabled&&!reduced?<Sparkles size={14}/>:<Pause size={14}/>}<span>{reduced?'系统静态模式':enabled?'动效已开启':'动效已关闭'}</span></button>;
}

/** One small canvas, 72 projected 3D points, <=30fps. Offscreen/hidden = zero animation frames. */
export function ObservatoryAtmosphere(){
 const canvasRef=useRef<HTMLCanvasElement>(null);
 useEffect(()=>{
  const canvas=canvasRef.current,host=canvas?.closest<HTMLElement>('.heading')??canvas?.parentElement;if(!canvas||!host)return;
  const ctx=canvas.getContext('2d');if(!ctx)return;
  const media=matchMedia('(prefers-reduced-motion: reduce)');
  let frame=0,last=0,time=0,visible=false,disposed=false,w=0,h=0,px=0,py=0;
  const active=()=>shouldAnimate({reduced:media.matches,disabled:document.documentElement.dataset.effects==='off',hidden:document.hidden,intersecting:visible});
  function paint(){
   if(!ctx||!canvas)return;ctx.clearRect(0,0,w,h);
   const radius=Math.min(w*.30,h*.39),cx=w*.56,cy=h*.49;
   const points=Array.from({length:FIELD_POINTS},(_,i)=>orbitPoint(i,time,px,py));
   const glow=ctx.createRadialGradient(cx,cy,0,cx,cy,radius*1.45);glow.addColorStop(0,'rgba(133,119,222,.10)');glow.addColorStop(1,'rgba(133,119,222,0)');ctx.fillStyle=glow;ctx.fillRect(0,0,w,h);
   for(let i=0;i<points.length;i++){
    const p=points[i],x=cx+p.x*radius,y=cy+p.y*radius;
    // Each point checks a bounded handful of neighbours, not all pairs.
    for(const j of [i+1,i+8,i+13]){const q=points[j];if(!q)continue;const distance=Math.hypot(p.x-q.x,p.y-q.y);if(distance>.55)continue;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(cx+q.x*radius,cy+q.y*radius);ctx.strokeStyle=`rgba(149,151,224,${(.55-distance)*.35})`;ctx.lineWidth=.7;ctx.stroke();}
    ctx.beginPath();ctx.arc(x,y,p.z>.3?1.9:1.1,0,Math.PI*2);ctx.fillStyle=i%5===0?`rgba(119,231,220,${p.opacity})`:`rgba(178,165,252,${p.opacity})`;ctx.fill();
   }
   ctx.save();ctx.translate(cx,cy);ctx.rotate(-.30);ctx.strokeStyle='rgba(146,158,209,.22)';ctx.lineWidth=.6;ctx.beginPath();ctx.ellipse(0,0,radius*1.37,radius*.44,0,0,Math.PI*2);ctx.stroke();ctx.restore();
  }
  function tick(now:number){frame=0;if(disposed||!active())return;if(now-last>=FRAME_INTERVAL){time+=Math.min((now-last)/1000,.06);last=now;paint();}frame=requestAnimationFrame(tick);}
  function sync(){if(frame)cancelAnimationFrame(frame);frame=0;if(disposed)return;if(active()){last=performance.now();frame=requestAnimationFrame(tick);}else if(!document.hidden)paint();}
  function resize(){const box=canvas!.getBoundingClientRect();w=box.width;h=box.height;const dpr=Math.min(devicePixelRatio||1,1.5);canvas!.width=Math.round(w*dpr);canvas!.height=Math.round(h*dpr);ctx!.setTransform(dpr,0,0,dpr,0,0);paint();}
  function point(e:PointerEvent){if(!active()||e.pointerType!=='mouse')return;const b=host!.getBoundingClientRect();px=(e.clientX-b.left-b.width/2)/b.width*.3;py=(e.clientY-b.top-b.height/2)/b.height*.2;}
  function leave(){px=0;py=0;}
  const io=new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;sync();},{threshold:.01});io.observe(canvas);
  const ro=new ResizeObserver(resize);ro.observe(canvas);resize();
  host.addEventListener('pointermove',point,{passive:true});host.addEventListener('pointerleave',leave);
  document.addEventListener('visibilitychange',sync);document.addEventListener('mcn-effects-change',sync);media.addEventListener('change',sync);
  return()=>{disposed=true;if(frame)cancelAnimationFrame(frame);io.disconnect();ro.disconnect();host.removeEventListener('pointermove',point);host.removeEventListener('pointerleave',leave);document.removeEventListener('visibilitychange',sync);document.removeEventListener('mcn-effects-change',sync);media.removeEventListener('change',sync);};
 },[]);
 return <div className="observatory-atmosphere" aria-hidden="true"><div className="observatory-grid"/><canvas ref={canvasRef}/><span className="observatory-coordinate">MCN / OBSERVATORY</span></div>;
}

export function OverviewWayfinder({ready=true,fullRoster=true}:{ready?:boolean;fullRoster?:boolean}){
 const sections=[['matrix-growth','01','增长与贡献'],['matrix-daily','02','每日趋势'],['source-ops-publishing','03','每天发片'],['matrix-authors','04','全部作者']];
 const [active,setActive]=useState('matrix-growth');
 function jump(id:string){const section=document.getElementById(id);if(!section)return;if(section instanceof HTMLDetailsElement)section.open=true;setActive(id);section.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches||document.documentElement.dataset.effects==='off'?'instant':'smooth',block:'start'});const focus=section.querySelector<HTMLElement>('summary,h2,h3')??section;focus.tabIndex=-1;focus.focus({preventScroll:true});}
 return <nav className="overview-wayfinder" aria-label="总览快速定位">{sections.map(([id,index,label])=><button key={id} disabled={!ready||(!fullRoster&&['matrix-growth','matrix-authors'].includes(id))} onClick={()=>jump(id)} data-selected={active===id}><span>{index}</span>{label}<ArrowUpRight size={14}/></button>)}</nav>;
}
