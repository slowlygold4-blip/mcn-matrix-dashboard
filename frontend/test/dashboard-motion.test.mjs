// Real visual controller and production CSS; all content is synthetic.
// One browser runs sequential contexts. No network, collector or server starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const root=fileURLToPath(new URL('../',import.meta.url));
const main=process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../douyin-monitor-workbench/',import.meta.url));
const {chromium}=createRequire(main+'package.json')('playwright-core');

function installMotionProbe(){
 const liveObservers=new Map(),listeners=[],frames=new Map(),starts={};
 for(const name of ['IntersectionObserver','MutationObserver','ResizeObserver']){
  const Native=window[name];if(!Native)continue;
  window[name]=class extends Native{
   constructor(...args){super(...args);liveObservers.set(this,{type:name,stack:new Error().stack});}
   observe(...args){if(!liveObservers.has(this))liveObservers.set(this,{type:name,stack:new Error().stack});return super.observe(...args);}
   disconnect(){liveObservers.delete(this);return super.disconnect();}
  };
 }
 const add=EventTarget.prototype.addEventListener,remove=EventTarget.prototype.removeEventListener;
 const tracked=(target,type)=>target===window&&['scroll','resize'].includes(type)
  ||target===document&&['visibilitychange','focusin','keydown'].includes(type)
  ||typeof MediaQueryList!=='undefined'&&target instanceof MediaQueryList&&type==='change';
 const capture=options=>typeof options==='boolean'?options:!!options?.capture;
 EventTarget.prototype.addEventListener=function(type,callback,options){
  if(tracked(this,type)&&!listeners.some(row=>row.target===this&&row.type===type&&row.callback===callback&&row.capture===capture(options)))listeners.push({target:this,type,callback,capture:capture(options)});
  return add.call(this,type,callback,options);
 };
 EventTarget.prototype.removeEventListener=function(type,callback,options){
  const index=listeners.findIndex(row=>row.target===this&&row.type===type&&row.callback===callback&&row.capture===capture(options));
  if(index>=0)listeners.splice(index,1);return remove.call(this,type,callback,options);
 };
 const raf=window.requestAnimationFrame.bind(window),cancel=window.cancelAnimationFrame.bind(window);
 window.requestAnimationFrame=callback=>{const id=raf(time=>{frames.delete(id);callback(time);});frames.set(id,{callback:callback.name||'anonymous',stack:new Error().stack});return id;};
 window.cancelAnimationFrame=id=>{frames.delete(id);cancel(id);};
 document.addEventListener('animationstart',event=>{
  const id=event.target instanceof HTMLElement?event.target.id:'';
  if(id)starts[id]=(starts[id]||0)+1;
 });
 // Playwright installs one persistent MutationObserver to detect removal of
 // its own injected listeners. Exclude only that verified construction site,
 // not a class of observers or any resource created by the fixture/component.
 const isAutomationObserver=detail=>detail.type==='MutationObserver'&&detail.stack.includes('InjectedScript._setupGlobalListenersRemovalDetection');
 window.motionProbe={starts,snapshot:()=>({observers:[...liveObservers.values()].filter(detail=>!isAutomationObserver(detail)).length,listeners:listeners.length,frames:frames.size}),details:()=>({
  observers:[...liveObservers.values()],listeners:listeners.map(row=>({target:row.target===window?'window':row.target===document?'document':'media-query',type:row.type,callback:row.callback?.name||'anonymous',capture:row.capture})),frames:[...frames].map(([id,detail])=>({id,...detail})),
 })};
}

async function fixtureAssets(){
 const fixture=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {DashboardMotion} from './components/dashboard-motion';
 function Fixture(){const [mounted,setMounted]=useState(true);window.motionFixture={setMounted};return <>
 {mounted&&<DashboardMotion/>}<div className="workspace"><aside className="sidebar"><div className="wordmark">矩阵<span>MCN DATA</span></div></aside>
 <main><div className="content"><div className="heading" id="fixture-heading"><h1>矩阵总览</h1></div>
 <div className="source-ops"><section className="source-ops-hero"><div><p className="source-ops-kicker">已保存数据</p><h2>看清每一份创作</h2><p className="source-ops-intro">这里的数字只是固定测试文本，不得被动效改写。</p></div><div className="source-ops-hero-action"><div className="dashboard-orbits" aria-hidden="true"><span/><span/></div><small className="source-ops-hero-action-context">已收到表格 · 作品日期 2026-09-12—2026-10-12<br/>不是今天实时采集</small><strong>18,287</strong><span>条已去重的作品记录</span><button>查看全部作品 ↗</button></div></section>
 <section className="source-ops-kpis"><div id="fixture-kpi"><small>作者</small><strong data-numeric="authors">4,497</strong></div><div><small>作品</small><strong data-numeric="works">18,287</strong></div><div><small>未提供</small><strong data-numeric="missing">—</strong></div><div><small>变化</small><strong data-numeric="delta">+139</strong></div></section>
 <section className="overview-account-preview"><div className="overview-account-preview__grid"><article id="fixture-growth-card" className="overview-account-preview__card"><small>粉丝净变化</small><strong>+139</strong></article><article className="overview-account-preview__card"><small>主页获赞净变化</small><strong>—</strong></article><article className="overview-account-preview__card"><small>作品存量净变化</small><strong>-2</strong></article></div></section>
 <section className="metric-ledger"><div className="metric-grid metric-grid--stock"><article className="metric-cell" id="fixture-metric-stock"><p>粉丝总数</p><strong className="metric-cell__value" data-core-numeric="stock">8,280</strong></article><article className="metric-cell"><p>主页获赞总数</p><strong className="metric-cell__value" data-core-numeric="likes">18,287</strong></article><article className="metric-cell"><p>作品总数</p><strong className="metric-cell__value" data-core-numeric="posts">—</strong></article></div><div className="metric-grid metric-grid--change"><article className="metric-cell" id="fixture-metric-change"><p>粉丝变化</p><strong className="metric-cell__value" data-core-numeric="followers-delta">+139</strong></article><article className="metric-cell"><p>获赞变化</p><strong className="metric-cell__value" data-core-numeric="likes-delta">—</strong></article><article className="metric-cell"><p>估算播放变化（非实测）</p><strong className="metric-cell__value" data-core-numeric="estimated">—</strong></article><article className="metric-cell"><p>作品变化</p><strong className="metric-cell__value" data-core-numeric="posts-delta">+7</strong></article></div></section>
 <div className="fixture-gap" aria-hidden="true"/><section className="source-ops-panel"><div className="source-ops-panel-head" id="fixture-scroll-panel"><h3>作品表现</h3><span>真实保存的累计值</span></div><p>此面板滚入后只入场一次。</p></section>
 <div className="fixture-gap" aria-hidden="true"/><section className="source-ops-panel"><div className="source-ops-panel-head" id="fixture-keyboard-panel"><h3>账号变化</h3><button id="fixture-keyboard-target">查看账号变化</button></div><p>键盘聚焦不应被透明动画遮挡。</p></section>
 <div className="fixture-gap" aria-hidden="true"/><footer>测试页结束</footer></div></div></main></div></>;}createRoot(document.getElementById('root')).render(<Fixture/>);`;
 const bundle=await build({stdin:{contents:fixture,resolveDir:root,sourcefile:'dashboard-motion-fixture.tsx',loader:'tsx'},absWorkingDir:root,bundle:true,write:false,outfile:'dashboard-motion-fixture.js',format:'iife',platform:'browser',jsx:'automatic',tsconfig:root+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'}});
 const styles=await Promise.all(['app/replica.css','app/source-operations.css','app/visual-theme.css','app/dashboard-motion.css'].map(path=>readFile(root+path,'utf8')));
 return {script:bundle.outputFiles.find(file=>file.path.endsWith('.js')).text,css:'*{box-sizing:border-box}html,body{margin:0}button{font:inherit}'+styles.join('\n')+'\n.fixture-gap{height:1100px;pointer-events:none}'};
}

async function openFixture(browser,assets,options={}){
 const context=await browser.newContext({viewport:{width:1280,height:800},reducedMotion:'no-preference',...options});
 await context.addInitScript(installMotionProbe);const requests=[],errors=[];
 await context.route('**/*',route=>{
  const request=route.request(),path=new URL(request.url()).pathname;requests.push({method:request.method(),path});
  if(request.method()!=='GET')return route.abort();
  if(path==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>'});
  if(path==='/fixture.css')return route.fulfill({contentType:'text/css',body:assets.css});
  if(path==='/fixture.js')return route.fulfill({contentType:'text/javascript',body:assets.script});
  return route.abort();
 });
 const page=await context.newPage();page.setDefaultTimeout(7000);page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://127.0.0.1:49125/');
 await page.waitForFunction(()=>document.documentElement.dataset.dashboardMotion==='ready');
 return {context,page,requests,errors};
}
const numbers=page=>page.locator('[data-numeric]').allTextContents();
const expectedNumbers=['4,497','18,287','—','+139'];
const coreNumbers=page=>page.locator('[data-core-numeric]').allTextContents();
const expectedCoreNumbers=['8,280','18,287','—','+139','—','—','+7'];
async function noRunningMotion(page){
 await page.waitForFunction(()=>document.getAnimations().every(animation=>animation.playState!=='running'&&animation.playState!=='pending'));
 assert.equal(await page.locator('[data-dashboard-reveal]').evaluateAll(elements=>elements.every(element=>{const style=getComputedStyle(element);return style.opacity==='1'&&style.visibility!=='hidden';})),true);
 assert.equal(await page.locator('.dashboard-orbits > span').count(),2);
 assert.deepEqual(await page.locator('.dashboard-orbits > span').evaluateAll(elements=>elements.map(element=>getComputedStyle(element).animationName)),['none','none'],'reduced motion disables both decorative orbit animations');
}
const noBusinessRequests=requests=>assert.ok(requests.every(request=>request.method==='GET'&&['/','/fixture.js','/fixture.css','/favicon.ico'].includes(request.path)),'motion may not request business data or start collection');

test('dashboard motion preserves data, accessibility and cleanup with one sequential browser',async t=>{
 const assets=await fixtureAssets();
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{
  await t.test('the seven core metric cards enter once without animating or altering values',async()=>{
   const {context,page,requests,errors}=await openFixture(browser,assets);try{
    assert.equal(await page.locator('.metric-ledger .metric-grid > .metric-cell').count(),7);
    assert.equal(await page.locator('.overview-account-preview__card').count(),3);
    await page.locator('#fixture-growth-card').scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>document.getElementById('fixture-growth-card')?.dataset.dashboardReveal==='complete');
    assert.equal(await page.evaluate(()=>window.motionProbe.starts['fixture-growth-card']||0),1,'overview growth card enters once without changing its number');
    await page.evaluate(()=>{
     const original=document.getElementById('fixture-growth-card');
     const replacement=original.cloneNode(true);
     replacement.classList.remove('dashboard-entering');
     replacement.removeAttribute('data-dashboard-reveal');
     original.replaceWith(replacement);
    });
    await page.waitForFunction(()=>document.getElementById('fixture-growth-card')?.dataset.dashboardReveal==='complete');
    assert.equal(await page.evaluate(()=>window.motionProbe.starts['fixture-growth-card']||0),1,'a remounted overview card must not replay its entrance');
    assert.equal(await page.locator('#fixture-growth-card strong').innerText(),'+139');
    assert.deepEqual(await coreNumbers(page),expectedCoreNumbers);
    await page.locator('#fixture-metric-change').scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>document.getElementById('fixture-metric-change')?.dataset.dashboardReveal==='complete');
    const firstStarts=await page.evaluate(()=>window.motionProbe.starts['fixture-metric-change']||0);
    assert.equal(firstStarts,1,'core metric card enters on first view');
    assert.equal(await page.locator('.metric-cell__value[data-dashboard-reveal]').count(),0,'numeric text itself is never animated');
    await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
    await page.waitForFunction(()=>window.scrollY===0);
    await page.locator('#fixture-metric-change').scrollIntoViewIfNeeded();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(()=>window.motionProbe.starts['fixture-metric-change']||0),firstStarts,'core metric card does not replay');
    assert.deepEqual(await coreNumbers(page),expectedCoreNumbers);
    assert.deepEqual(errors,[]);noBusinessRequests(requests);
   }finally{await context.close();}
  });
  await t.test('scroll progress is decorative; entering a section twice does not replay it',async()=>{
   const {context,page,requests,errors}=await openFixture(browser,assets);try{
    assert.deepEqual(await numbers(page),expectedNumbers);
    assert.equal(await page.evaluate(()=>parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop)<innerHeight/2),true,'a full-height vertical sidebar must not become top scroll padding');
    const progress=page.locator('.dashboard-reading-progress');await progress.waitFor({state:'attached'});
    assert.equal(await progress.getAttribute('aria-hidden'),'true');
    assert.match(await progress.locator('.dashboard-reading-progress__bar').evaluate(element=>getComputedStyle(element).backgroundImage),/gradient/);
    const initial=await progress.locator('.dashboard-reading-progress__bar').evaluate(element=>new DOMMatrix(getComputedStyle(element).transform).a);
    assert.ok(initial<=0.02,'the top of a long page starts near zero');
    await page.waitForFunction(()=>document.querySelector('.dashboard-orbits')?.dataset.dashboardOrbitActive==='true');
    assert.deepEqual(await page.locator('.dashboard-orbits > span').evaluateAll(elements=>elements.map(element=>getComputedStyle(element).animationPlayState)),['running','running']);
    await page.locator('#fixture-scroll-panel').scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>document.getElementById('fixture-scroll-panel').dataset.dashboardReveal==='complete');
    await page.waitForFunction(()=>document.querySelector('.dashboard-orbits')?.dataset.dashboardOrbitActive==='false');
    assert.deepEqual(await page.locator('.dashboard-orbits > span').evaluateAll(elements=>elements.map(element=>getComputedStyle(element).animationPlayState)),['paused','paused'],'offscreen orbit animations pause instead of consuming continuous rendering work');
    const progressed=await progress.locator('.dashboard-reading-progress__bar').evaluate(element=>new DOMMatrix(getComputedStyle(element).transform).a);
    assert.ok(progressed>initial+0.1&&progressed<=1,'decorative progress follows the actual page scroll');
    const firstStarts=await page.evaluate(()=>window.motionProbe.starts['fixture-scroll-panel']||0);assert.equal(firstStarts,1,'the first visible entry plays one animation');
    await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
    await page.waitForFunction(()=>window.scrollY===0);
    await page.locator('#fixture-scroll-panel').scrollIntoViewIfNeeded();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(()=>window.motionProbe.starts['fixture-scroll-panel']||0),firstStarts,'returning to an already read section must not replay it');
    assert.equal(await page.locator('#fixture-scroll-panel').getAttribute('data-dashboard-reveal'),'complete');
    assert.deepEqual(await numbers(page),expectedNumbers);assert.deepEqual(errors,[]);noBusinessRequests(requests);
   }finally{await context.close();}
  });
  await t.test('initial reduced motion keeps every data element visible with no running animation',async()=>{
   const {context,page,requests,errors}=await openFixture(browser,assets,{reducedMotion:'reduce'});try{
    await noRunningMotion(page);assert.deepEqual(await numbers(page),expectedNumbers);assert.deepEqual(await coreNumbers(page),expectedCoreNumbers);
    assert.equal(await page.locator('.metric-ledger .metric-cell').evaluateAll(elements=>elements.every(element=>getComputedStyle(element).opacity==='1'&&getComputedStyle(element).animationName==='none')),true);
    await page.locator('#fixture-keyboard-target').focus();
    assert.equal(await page.locator('#fixture-keyboard-target').evaluate(element=>document.activeElement===element),true);
    await noRunningMotion(page);assert.deepEqual(errors,[]);noBusinessRequests(requests);
   }finally{await context.close();}
  });
  await t.test('dynamic reduced motion and keyboard focus never leave content invisible; unmount releases resources',async()=>{
   const {context,page,requests,errors}=await openFixture(browser,assets);try{
    // The hero CTA precedes this below-fold control in keyboard order.
    // Browser keyboard focus must reveal the latter without a hidden frame.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.waitForFunction(()=>document.activeElement?.id==='fixture-keyboard-target');
    const focused=await page.locator('#fixture-keyboard-target').evaluate(element=>{
     const parents=[];for(let node=element;node;node=node.parentElement){const css=getComputedStyle(node);parents.push({opacity:Number(css.opacity),visibility:css.visibility});}
     const rect=element.getBoundingClientRect();return {visible:parents.every(css=>css.opacity>0&&css.visibility!=='hidden'),inViewport:rect.bottom>0&&rect.top<innerHeight};
    });assert.equal(focused.visible,true,'focus may not leave a control transparent while native scrolling completes');
    await page.waitForFunction(()=>{const rect=document.getElementById('fixture-keyboard-target').getBoundingClientRect();return rect.bottom>0&&rect.top<innerHeight;},undefined,{polling:50});
    await page.emulateMedia({reducedMotion:'reduce'});await noRunningMotion(page);
    assert.deepEqual(await numbers(page),expectedNumbers);
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.emulateMedia({reducedMotion:'reduce'});await noRunningMotion(page);
    const mountedResources=await page.evaluate(()=>window.motionProbe.snapshot());
    assert.ok(mountedResources.observers>=2&&mountedResources.listeners>=5,'the probe must actually count the mounted component observers and listeners');
    await page.evaluate(()=>window.motionFixture.setMounted(false));
    await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-dashboard-motion'));
    assert.equal(await page.locator('.dashboard-reading-progress').count(),0);
    assert.equal(await page.locator('.dashboard-orbits > span').count(),2,'unmount may not remove the content-owned decorative markup');
    assert.equal(await page.locator('.dashboard-orbits[data-dashboard-orbit-active]').count(),0,'unmount clears orbit controller state');
    const beforeCleanupCheck=await page.evaluate(()=>({snapshot:window.motionProbe.snapshot(),details:window.motionProbe.details()}));
    try{await page.waitForFunction(()=>{const resources=window.motionProbe.snapshot();return resources.observers===0&&resources.listeners===0&&resources.frames===0;},undefined,{polling:50});}
    catch(error){
     const afterCleanupCheck=await page.evaluate(()=>({snapshot:window.motionProbe.snapshot(),details:window.motionProbe.details()}));
     const directory=root+'output/playwright/dashboard-motion';await mkdir(directory,{recursive:true});
     const diagnostic={beforeCleanupCheck,afterCleanupCheck,errors,requests,url:page.url()};
     await writeFile(directory+'/cleanup-failure.json',JSON.stringify(diagnostic,null,2));
     t.diagnostic('Motion cleanup resource details: '+JSON.stringify(diagnostic));throw error;
    }
    assert.equal(await page.locator('[data-dashboard-reveal],.dashboard-entering').count(),0,'unmount removes enhancement state from original content');
    await page.evaluate(()=>{window.scrollTo(0,0);window.dispatchEvent(new Event('resize'));});
    assert.deepEqual(await page.evaluate(()=>window.motionProbe.snapshot()),{observers:0,listeners:0,frames:0});
    const directory=root+'output/playwright/dashboard-motion';await mkdir(directory,{recursive:true});
    await writeFile(directory+'/cleanup-audit.json',JSON.stringify({mountedResources,afterUnmount:await page.evaluate(()=>({snapshot:window.motionProbe.snapshot(),details:window.motionProbe.details()})),polling:50,automationExclusion:'Only MutationObserver created by InjectedScript._setupGlobalListenersRemovalDetection'},null,2));
    assert.deepEqual(await numbers(page),expectedNumbers);assert.deepEqual(errors,[]);noBusinessRequests(requests);
   }finally{await context.close();}
  });
  await t.test('mobile figure is contextualized before long prose at 320 and 390 pixels',async()=>{
   for(const width of [320,390]){
   const {context,page,requests,errors}=await openFixture(browser,assets,{viewport:{width,height:844},reducedMotion:'reduce'});try{
    await noRunningMotion(page);
    const hierarchy=await page.locator('.source-ops-hero').evaluate(element=>{
     const metric=element.querySelector('.source-ops-hero-action strong').getBoundingClientRect();
     const explanation=element.querySelector('.source-ops-intro').getBoundingClientRect();
     const context=element.querySelector('.source-ops-hero-action-context').getBoundingClientRect();
     return {metricTop:metric.top,metricBottom:metric.bottom,explanationTop:explanation.top,contextBottom:context.bottom};
    });
    assert.ok(hierarchy.contextBottom<hierarchy.metricTop&&hierarchy.metricBottom<hierarchy.explanationTop,`${width}px readers see source caveat and figure before long explanation`);
    assert.ok(hierarchy.metricBottom<844,`${width}px readers see the complete main figure in the first viewport`);
    assert.match(await page.locator('.source-ops-hero-action-context').innerText(),/2026-09-12.*2026-10-12[\s\S]*不是今天实时采集/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,`${width}px visual layers must not create horizontal page overflow`);
    const decorative=await page.locator('.dashboard-reading-progress,.dashboard-orbits').evaluateAll(elements=>elements.every(element=>getComputedStyle(element).pointerEvents==='none'));
    assert.equal(decorative,true,'decorative layers do not swallow taps');
    assert.deepEqual(await numbers(page),expectedNumbers);assert.deepEqual(errors,[]);noBusinessRequests(requests);
   }finally{await context.close();}
   }
  });
 }finally{await browser.close();}
});
