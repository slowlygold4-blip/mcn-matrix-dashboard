import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { observeBrowserAccessGate } from '../lib/browser-access-gate.mjs';
import { observeFirstPageActivation } from '../lib/browser-first-page-activation.mjs';
import { requestBrowserFirstPage } from '../lib/browser-first-works-request.mjs';

const SEC = 'MS4wLjABAAAABoundedGeometryFixture';
const rect = (left, top, width, height) => ({ left, top, width, height, right:left+width, bottom:top+height });
const normalStyle = { display:'block', visibility:'visible', opacity:'1', overflowY:'visible' };
function fixture(options = {}) {
  const hits=[], requests=[], reads=[], child={}, stranger={};
  const viewport={left:0,top:0,right:1280,bottom:720};
  const area=options.scrollerRect || rect(100,220,1000,80);
  const list=options.listRect || rect(100,220,1000,1000);
  const inBox=(x,y,r)=>x>=Math.max(0,r.left)&&x<Math.min(viewport.right,r.right)
    &&y>=Math.max(0,r.top)&&y<Math.min(viewport.bottom,r.bottom);
  const scroller={id:'scroller',style:{...normalStyle,overflowY:'auto'},parentElement:null,
    scrollHeight:1000,clientHeight:area.height,scrollTop:0,
    getBoundingClientRect:()=>{reads.push('rect:scroller'); return options.invalidScrollerRect ? {...area,left:NaN}:area;} };
  const root={id:'root',style:{...normalStyle,overflowY:'auto'},scrollHeight:2000,clientHeight:720,scrollTop:0,
    getBoundingClientRect:()=>{assert.fail('document scrolling owner must use viewport bounds');} };
  const region={id:'region',style:{...normalStyle},parentElement:options.documentScroller||options.noScroller?null:scroller,
    scrollHeight:list.height,clientHeight:list.height,
    getBoundingClientRect:()=>{reads.push('rect:region');return list;},contains:n=>n===region||n===child};
  if(options.selfScroller){region.parentElement=null;region.style.overflowY='auto';region.clientHeight=80;}
  if(options.deepChain){
    let ancestor=region;
    for(let i=0;i<14;i++) {
      const next={id:`ancestor-${i}`,style:{...normalStyle},scrollHeight:1000,clientHeight:1000,parentElement:null};
      ancestor.parentElement=next;ancestor=next;
    }
    ancestor.parentElement=scroller;
  }
  const navigation={id:'navigation',style:{...normalStyle},getBoundingClientRect:()=>rect(0,0,1280,100)};
  const gate={id:'gate',style:{...normalStyle},getBoundingClientRect:()=>rect(1120,20,80,32),
    matches:selector=>selector.split(',').some(s=>s==='button'
      || (options.modal&&(s==='[role="dialog"]'||s==='[aria-modal="true"]'))
      || (options.captcha&&s.includes('captcha'))
      || (options.credential&&(s.startsWith('input[')||s.startsWith('form[')))),
    closest:selector=>selector.startsWith('header')&&!options.noNavigation?navigation:null,
    querySelectorAll:()=>[],getAttribute:key=>key==='aria-label'?'登录':null};
  const gates=options.laterModal?[gate,{...gate,matches:selector=>selector.includes('[role="dialog"]')}]:[gate];
  const document={readyState:'complete',scrollingElement:options.documentScroller?root:null,
    querySelectorAll:selector=>selector.includes('user-post-list')?[region]:gates,
    elementFromPoint:(x,y)=>{
      hits.push({x,y});
      if(options.overlay||options.floatingLayer||options.unknownClip)return stranger;
      const inside=inBox(x,y,list)&&(options.documentScroller||options.selfScroller||options.noScroller||options.deepChain||inBox(x,y,area));
      return inside?(options.hitSelf?region:child):stranger;
    },createTreeWalker:()=>({nextNode:()=>null})};
  for(const n of [document,region,scroller,gate])for(const key of ['cookie','innerHTML','innerText','textContent','value'])
    Object.defineProperty(n,key,{get(){assert.fail(`sensitive read ${key}`);}});
  const context=vm.createContext({document,URL,URLSearchParams,Date,AbortController,location:new URL(`https://www.douyin.com/user/${SEC}`),
    window:{innerWidth:1280,innerHeight:720,fetch:(...args)=>{requests.push(args);return Promise.resolve({});}},
    getComputedStyle:n=>{reads.push(`style:${n.id}`);return n.style;},setTimeout:()=>1,clearTimeout:()=>{}});
  return {hits,requests,reads,evaluate(fn){context.args={secUid:SEC,expiresAt:Date.now()+5000};
    return JSON.parse(JSON.stringify(vm.runInContext(`(${fn.toString()})(args)`,context)));}};
}

test('independent old-center counterexample: viewport point misses a clear narrow works container',()=>{
  // Frozen pre-fix geometry only, independent of the current gate. This local
  // counterexample is not a claim about any unobserved production DOM.
  function oldViewportHit() {
    const candidate=document.querySelectorAll('[data-e2e="user-post-list"],[data-e2e="user-post-item-list"]')[0];
    const r=candidate.getBoundingClientRect();
    const left=Math.max(0,r.left),right=Math.min(window.innerWidth,r.right);
    const top=Math.max(0,r.top),bottom=Math.min(window.innerHeight,r.bottom);
    const hit=document.elementFromPoint((left+right)/2,(top+bottom)/2);
    return Boolean(hit&&(hit===candidate||candidate.contains(hit)));
  }
  const before=fixture(),after=fixture();
  assert.equal(before.evaluate(oldViewportHit),false);
  assert.deepEqual(before.hits,[{x:600,y:470}]);
  assert.equal(after.evaluate(observeBrowserAccessGate).blocked,false);
  assert.deepEqual(after.hits,[{x:600,y:260}]);
});

for(const [name,options,point] of [
  ['narrow ancestor scroller',{}, {x:600,y:260}],
  ['partly offscreen horizontal ancestor',{scrollerRect:rect(-100,220,300,80),listRect:rect(-100,220,1000,1000)},{x:100,y:260}],
  ['bottom viewport clipped ancestor',{scrollerRect:rect(100,680,1000,100),listRect:rect(100,680,1000,1000)},{x:600,y:700}],
  ['odd-sized clip uses the same integer point',{scrollerRect:rect(100,221,999,81),listRect:rect(100,221,999,1000)},{x:599,y:261}],
  ['self scrolling list',{selfScroller:true,listRect:rect(100,220,1000,480)}, {x:600,y:460}],
  ['document scroller',{documentScroller:true},{x:600,y:470}],
  ['ordinary tall visible list',{scrollerRect:rect(100,220,1000,480)}, {x:600,y:460}],
  ['direct list hit',{hitSelf:true},{x:600,y:260}],
]) test(`visible works geometry: ${name}`,()=>{
  const f=fixture(options),gate=f.evaluate(observeBrowserAccessGate),projection=f.evaluate(observeFirstPageActivation);
  assert.equal(gate.blocked,false);
  assert.equal(projection.eligible,true);
  assert.deepEqual({x:projection.x,y:projection.y},point);
  assert.ok(f.hits.length>=3);
  for(const hit of f.hits)assert.deepEqual(hit,point,'gate and action qualification use the same visible intersection');
  assert.equal(f.evaluate(requestBrowserFirstPage).state,'issued');
  assert.equal(f.requests.length,1);
});

for(const [name,options,decision,reason] of [
  ['modal',{modal:true},'modal',null], ['captcha',{captcha:true},'challenge',null],
  ['later modal after legitimate navigation',{laterModal:true},'modal',null],
  ['credentials',{credential:true},'credential-form',null],
  ['foreign overlay on visible works',{overlay:true},'unknown','works-region-unavailable'],
  ['floating unrelated video layer',{floatingLayer:true},'unknown','works-region-unavailable'],
  ['unknown intermediate clipping',{unknownClip:true},'unknown','works-region-unavailable'],
  ['non-navigation candidate',{noNavigation:true},'unknown','navigation-absent'],
  ['non-navigation and occlusion',{noNavigation:true,overlay:true},'unknown','navigation-absent'],
  ['tiny visible intersection',{scrollerRect:rect(100,220,1000,4)},'unknown','works-region-unavailable'],
  ['non-finite owner rectangle',{invalidScrollerRect:true},'unknown','projection-error'],
]) test(`geometry cannot waive ${name}`,()=>{
  const f=fixture(options),gate=f.evaluate(observeBrowserAccessGate);
  assert.equal(gate.blocked,true);assert.equal(gate.observation.decision,decision);
  if(reason)assert.equal(gate.observation.detail.reason,reason);
  assert.equal(f.evaluate(observeFirstPageActivation).eligible,false);
  assert.equal(f.evaluate(requestBrowserFirstPage).state,'blocked');
  assert.equal(f.requests.length,0);
});

test('without an identified scrolling owner the previous viewport-only gate behavior remains',()=>{
  const f=fixture({noScroller:true});
  assert.equal(f.evaluate(observeBrowserAccessGate).blocked,false);
  const projection=f.evaluate(observeFirstPageActivation);
  assert.equal(projection.eligible,false);assert.equal(projection.structure.reason,'not-scrollable');
});

test('ancestor inspection is bounded to the same twelve nodes as activation',()=>{
  const f=fixture({deepChain:true});
  assert.equal(f.evaluate(observeBrowserAccessGate).blocked,false);
  assert.ok(f.reads.includes('style:ancestor-10'));
  assert.equal(f.reads.includes('style:ancestor-11'),false);
  assert.equal(f.reads.includes('style:scroller'),false);
});
