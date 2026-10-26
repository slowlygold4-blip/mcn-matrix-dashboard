"use client";

import {useEffect,useRef} from 'react';

// Deliberately exclude tables, rows, chart bars, and nested card contents.
const revealSelectors=[
 '.content > .heading',
 '.matrix-pulse__metric',
 '.all-author-overview__head',
 '.source-ops-hero > div:first-child:not(.dashboard-orbits)',
 '.source-ops-hero-action',
 '.source-ops-kpis > div',
 '.overview-account-preview__card',
 '.overview-trend-preview',
 '.metric-ledger .metric-grid > .metric-cell',
 '.source-ops-wayfinder',
 '.source-ops-panel-head',
 '.source-ops-achievement > div',
 '.source-stat-grid > div',
 '.topics > [data-slot="card"]',
 '.content .panel-head',
 '.account-heading',
];
const revealSelector=revealSelectors.join(',');

/** Decorative only: no data reads, business state, or per-frame React renders. */
export function DashboardMotion(){
 const progressRef=useRef<HTMLSpanElement>(null);

 useEffect(()=>{
  const progress=progressRef.current;
  if(!progress)return;
  const root=document.documentElement;
  const previousReady=root.getAttribute('data-dashboard-motion');
  const previousPage=root.getAttribute('data-dashboard-motion-page');
  const previousOffset=root.style.getPropertyValue('--dashboard-sticky-offset');
  const previousOffsetPriority=root.style.getPropertyPriority('--dashboard-sticky-offset');
  const preference=window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduced=preference.matches||root.dataset.effects==='off',disposed=false,progressFrame=0,scanFrame=0;
  let stickyBar:HTMLElement|null=null;
  const revealed=new WeakSet<HTMLElement>();
  // React can replace a whole view while this controller stays mounted.
  // Remember a section's place as well as its transient DOM node.
  const playedKeys=new Set<string>(),targetKeys=new WeakMap<HTMLElement,string>();
  const targets=new Set<HTMLElement>(),orbits=new Set<HTMLElement>();
  const finishTimers=new Map<HTMLElement,ReturnType<typeof setTimeout>>();

  function finish(element:HTMLElement,retain=true){
   const timer=finishTimers.get(element);
   if(timer!==undefined){clearTimeout(timer);finishTimers.delete(element);}
   if(retain){const key=targetKeys.get(element);if(key)playedKeys.add(key);}
   element.classList.remove('dashboard-entering');
   element.style.removeProperty('--dashboard-stagger');
   element.setAttribute('data-dashboard-reveal','complete');
   revealed.add(element);
   observer?.unobserve(element);
  }

  function play(element:HTMLElement,index:number){
   if(revealed.has(element))return;
   const key=targetKeys.get(element);
   if(key&&playedKeys.has(key)){finish(element);return;}
   if(reduced||document.hidden||element.contains(document.activeElement)){
    finish(element);return;
   }
   // Visibility is never withheld while waiting for the observer or this delay.
   revealed.add(element);
   if(key)playedKeys.add(key);
   observer?.unobserve(element);
   element.style.setProperty('--dashboard-stagger',`${Math.min(index,4)*80}ms`);
   element.setAttribute('data-dashboard-reveal','playing');
   element.classList.add('dashboard-entering');
   // Also clean up when CSS is unavailable or animationend is interrupted.
   finishTimers.set(element,setTimeout(()=>finish(element),1250));
  }

  const observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{
   let order=0;
   for(const entry of entries){
    const element=entry.target as HTMLElement;
    if(orbits.has(element)){
     element.setAttribute('data-dashboard-orbit-active',String(entry.isIntersecting&&!reduced&&!document.hidden));
     continue;
    }
    if(entry.isIntersecting&&!document.hidden&&!element.closest('[hidden]'))play(element,order++);
   }
  },{threshold:0.08}):null;

  function updateProgress(){
   progressFrame=0;
   if(disposed||document.hidden)return;
   const extent=Math.max(0,root.scrollHeight-window.innerHeight);
   const position=Math.max(0,window.scrollY||root.scrollTop);
   const ratio=extent>0?Math.min(1,position/extent):0;
   progress!.style.transform=`scaleX(${ratio.toFixed(4)})`;
  }

  function requestProgress(){
   if(!disposed&&!document.hidden&&!progressFrame)progressFrame=requestAnimationFrame(updateProgress);
  }

  function updateStickyOffset(){
   if(disposed||document.hidden)return;
   const height=stickyBar?.isConnected?stickyBar.getBoundingClientRect().height:72;
   const value=`${Math.ceil(height)+16}px`;
   if(root.style.getPropertyValue('--dashboard-sticky-offset')!==value)root.style.setProperty('--dashboard-sticky-offset',value);
  }

  function bindStickyBar(){
   if(disposed||document.hidden)return false;
   // The theme decides which bar sticks at each breakpoint; do not duplicate
   // its media-query width or count the mobile static topbar a second time.
   const nextBar=['.workspace .topbar','.workspace .sidebar']
    .map(selector=>document.querySelector<HTMLElement>(selector))
    .find((element,index)=>{
     if(!element)return false;
     const style=getComputedStyle(element);
     if(!['sticky','fixed'].includes(style.position))return false;
     // A desktop side rail is vertical, not an obstruction above the content.
     // Its full viewport height must never become the anchor's top padding.
     return index===0||['row','row-reverse'].includes(style.flexDirection);
    })??null;
   if(nextBar===stickyBar)return false;
   if(stickyBar)resize?.unobserve(stickyBar);
   stickyBar=nextBar;
   if(stickyBar)resize?.observe(stickyBar);
   return true;
  }

  function onResize(){bindStickyBar();updateStickyOffset();requestProgress();}

  function scan(){
   scanFrame=0;
   if(disposed||document.hidden)return;
   if(bindStickyBar())updateStickyOffset();
   for(const element of targets)if(!element.isConnected){
    finish(element,false);element.removeAttribute('data-dashboard-reveal');targets.delete(element);
   }
   for(const element of orbits)if(!element.isConnected){
    observer?.unobserve(element);element.removeAttribute('data-dashboard-orbit-active');orbits.delete(element);
   }
   const content=document.querySelector<HTMLElement>('.workspace main')??document.querySelector<HTMLElement>('.workspace')??document;
   const scope=window.location.hash.slice(1)||'overview';
   const selectorCounts=new Map<string,number>();
   for(const element of content.querySelectorAll<HTMLElement>(revealSelector)){
    const selector=revealSelectors.find(item=>element.matches(item))??'section';
    const index=selectorCounts.get(selector)??0;
    selectorCounts.set(selector,index+1);
    if(!targetKeys.has(element))targetKeys.set(element,element.dataset.dashboardRevealKey||`${scope}|${selector}|${index}`);
    if(targets.has(element)||element.closest('table,[role="dialog"]'))continue;
    // A parent and its descendants should not animate over each other.
    if(element.parentElement?.closest(revealSelector))continue;
    targets.add(element);
    if(reduced||!observer||revealed.has(element)||playedKeys.has(targetKeys.get(element)??'')||element.contains(document.activeElement))finish(element);
    else{element.setAttribute('data-dashboard-reveal','pending');observer.observe(element);}
   }
   for(const element of content.querySelectorAll<HTMLElement>('.dashboard-orbits')){
    if(orbits.has(element))continue;
    orbits.add(element);element.setAttribute('data-dashboard-orbit-active','false');observer?.observe(element);
   }
   requestProgress();
  }

  function requestScan(){
   if(!disposed&&!document.hidden&&!scanFrame)scanFrame=requestAnimationFrame(scan);
  }

  function finishFocused(event:FocusEvent){
   if(!(event.target instanceof Element))return;
   const element=event.target.closest<HTMLElement>('[data-dashboard-reveal]');
   if(element&&targets.has(element))finish(element);
  }

  function animationFinished(event:AnimationEvent){
   if(['dashboard-enter','dashboard-enter-mobile'].includes(event.animationName)&&event.target instanceof HTMLElement&&targets.has(event.target))finish(event.target);
  }

  function resetObservation(){
   observer?.disconnect();
   for(const element of targets)if(!revealed.has(element))observer?.observe(element);
   for(const element of orbits)observer?.observe(element);
  }

  function onPreferenceChange(){
   reduced=preference.matches||root.dataset.effects==='off';
   if(reduced){
    for(const element of targets)finish(element);
    for(const element of orbits)element.setAttribute('data-dashboard-orbit-active','false');
   }else if(!document.hidden)resetObservation();
   requestScan();
  }

  function onVisibilityChange(){
   root.setAttribute('data-dashboard-motion-page',document.hidden?'hidden':'visible');
   if(document.hidden){
    if(progressFrame)cancelAnimationFrame(progressFrame);
    if(scanFrame)cancelAnimationFrame(scanFrame);
    progressFrame=0;scanFrame=0;
    for(const element of finishTimers.keys())finish(element);
    for(const element of orbits)element.setAttribute('data-dashboard-orbit-active','false');
    observer?.disconnect();
   }else{resetObservation();bindStickyBar();updateStickyOffset();requestScan();requestProgress();}
  }

  root.setAttribute('data-dashboard-motion','ready');
  root.setAttribute('data-dashboard-motion-page',document.hidden?'hidden':'visible');
  const mutations=new MutationObserver(records=>{
   // Large account/source tables rerender often; no reveal target lives inside a table.
   if(records.every(record=>record.target instanceof Element&&record.target.closest('table,[role="grid"],[data-slot="table-container"]')))return;
   requestScan();
  });
  mutations.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden']});
  const resize=typeof ResizeObserver==='function'?new ResizeObserver(entries=>{
   if(entries.some(entry=>entry.target===stickyBar))updateStickyOffset();
   requestProgress();
  }):null;
  resize?.observe(document.body);
  window.addEventListener('scroll',requestProgress,{passive:true});
  window.addEventListener('resize',onResize,{passive:true});
  document.addEventListener('visibilitychange',onVisibilityChange);
  document.addEventListener('focusin',finishFocused);
  document.addEventListener('animationend',animationFinished);
  preference.addEventListener('change',onPreferenceChange);
  document.addEventListener('mcn-effects-change',onPreferenceChange);
  scan();requestProgress();

  return()=>{
   disposed=true;
   mutations.disconnect();resize?.disconnect();observer?.disconnect();
   if(progressFrame)cancelAnimationFrame(progressFrame);
   if(scanFrame)cancelAnimationFrame(scanFrame);
   for(const timer of finishTimers.values())clearTimeout(timer);
   finishTimers.clear();
   window.removeEventListener('scroll',requestProgress);
   window.removeEventListener('resize',onResize);
   document.removeEventListener('visibilitychange',onVisibilityChange);
   document.removeEventListener('focusin',finishFocused);
   document.removeEventListener('animationend',animationFinished);
   preference.removeEventListener('change',onPreferenceChange);
   document.removeEventListener('mcn-effects-change',onPreferenceChange);
   for(const element of targets){element.classList.remove('dashboard-entering');element.style.removeProperty('--dashboard-stagger');element.removeAttribute('data-dashboard-reveal');}
   for(const element of orbits)element.removeAttribute('data-dashboard-orbit-active');
   targets.clear();orbits.clear();progress.style.removeProperty('transform');
   if(previousReady===null)root.removeAttribute('data-dashboard-motion');else root.setAttribute('data-dashboard-motion',previousReady);
   if(previousPage===null)root.removeAttribute('data-dashboard-motion-page');else root.setAttribute('data-dashboard-motion-page',previousPage);
   if(previousOffset)root.style.setProperty('--dashboard-sticky-offset',previousOffset,previousOffsetPriority);else root.style.removeProperty('--dashboard-sticky-offset');
  };
 },[]);

 return <div className="dashboard-reading-progress" aria-hidden="true"><span ref={progressRef} className="dashboard-reading-progress__bar"/></div>;
}
