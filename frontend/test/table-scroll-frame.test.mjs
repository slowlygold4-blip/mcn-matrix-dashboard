// Real React table/frame components, synthetic rows, one sequential browser.
// All requests are intercepted; no production data, server or collector is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

const root=fileURLToPath(new URL('../',import.meta.url));
const main=process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../douyin-monitor-workbench/',import.meta.url));
const {chromium}=createRequire(main+'package.json')('playwright-core');
const labels={shared:'合成账号指标',raw:'合成原表作品',fit:'无需横移的短表',hidden:'隐藏后展示的原表',details:'折叠详情中的原表'};

function installProbe(){
 const observers=new Map(),listeners=[],frames=new Set(),calls=[],keys=[];
 for(const name of ['ResizeObserver','MutationObserver']){
  const Native=window[name];if(!Native)continue;
  window[name]=class extends Native{
   constructor(...args){super(...args);observers.set(this,{name,stack:new Error().stack});}
   observe(...args){if(!observers.has(this))observers.set(this,{name,stack:new Error().stack});return super.observe(...args);}
   disconnect(){observers.delete(this);return super.disconnect();}
  };
 }
 const add=EventTarget.prototype.addEventListener,remove=EventTarget.prototype.removeEventListener;
 const watched=(target,type)=>target===window&&type==='resize'
  ||target===document&&type==='visibilitychange'
  ||target instanceof Element&&target.matches('[data-slot="table-container"],.source-table-wrap')&&type==='scroll'
  ||typeof MediaQueryList!=='undefined'&&target instanceof MediaQueryList&&type==='change';
 const capture=options=>typeof options==='boolean'?options:!!options?.capture;
 EventTarget.prototype.addEventListener=function(type,callback,options){
  if(watched(this,type)&&!listeners.some(row=>row.target===this&&row.type===type&&row.callback===callback&&row.capture===capture(options)))listeners.push({target:this,type,callback,capture:capture(options)});
  return add.call(this,type,callback,options);
 };
 EventTarget.prototype.removeEventListener=function(type,callback,options){
  const index=listeners.findIndex(row=>row.target===this&&row.type===type&&row.callback===callback&&row.capture===capture(options));
  if(index>=0)listeners.splice(index,1);return remove.call(this,type,callback,options);
 };
 const raf=window.requestAnimationFrame.bind(window),cancel=window.cancelAnimationFrame.bind(window);
 window.requestAnimationFrame=callback=>{const id=raf(time=>{frames.delete(id);callback(time);});frames.add(id);return id;};
 window.cancelAnimationFrame=id=>{frames.delete(id);cancel(id);};
 for(const method of ['scrollBy','scrollTo']){
  const native=Element.prototype[method];
  Element.prototype[method]=function(...args){
   const fixture=this.closest('[data-fixture-table]');
   if(fixture)calls.push({id:fixture.id,method,options:typeof args[0]==='object'?{...args[0]}:args});
   return native.apply(this,args);
  };
 }
 document.addEventListener('keydown',event=>keys.push({key:event.key,prevented:event.defaultPrevented,target:event.target?.id||event.target?.tagName}));
 // Playwright owns an observer that lives for the entire page. Exclude only
 // that verified construction site, never observers made by the component.
 const ownObservers=()=>[...observers.values()].filter(row=>!row.stack.includes('InjectedScript._setupGlobalListenersRemovalDetection'));
 window.tableProbe={calls,keys,snapshot:()=>({observers:ownObservers().length,listeners:listeners.length,frames:frames.size})};
}

async function fixtureAssets(){
 const fixture=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
 import {ScrollableTable} from './components/scrollable-table';import {TableScrollFrame} from './components/table-scroll-frame';
 import {TableHeader,TableRow,TableHead,TableBody,TableCell} from './components/ui/table';
 const labels=${JSON.stringify(labels)},headers=['作者','粉丝','粉丝变化','点赞','点赞变化','作品','发布时间','数据来源'];
 function Cells({page=1}){return <>{Array.from({length:30},(_,i)=><TableRow key={i}><TableCell><input id={i===0?'shared-input':undefined} aria-label={'备注'+i} defaultValue={'作者'+((page-1)*30+i+1)}/><button id={i===0?'shared-child':undefined}>查看</button></TableCell>{headers.slice(1).map((label,j)=><TableCell key={label}>{j===0?12345+i:j===1?'+139':j===2?'—':label+' '+i}</TableCell>)}</TableRow>)}</>}
 function Raw({name}){return <TableScrollFrame scrollLabel={labels[name]} scrollSelector=".source-table-wrap"><div className="source-table-wrap"><table style={{width:1200,minWidth:1200,tableLayout:'fixed'}}><thead><tr>{headers.map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{Array.from({length:4},(_,i)=><tr key={i}>{headers.map((label,j)=><td key={label}>{j===0?<button id={name+'-child-'+i}>合成作者 {i+1}</button>:j===1?'—':label+' '+i}</td>)}</tr>)}</tbody></table></div></TableScrollFrame>}
 function Fixture(){const [mounted,setMounted]=useState(true),[width,setWidth]=useState(480),[hidden,setHidden]=useState(true),[page,setPage]=useState(1),[version,setVersion]=useState(1);window.tableFixture={setMounted,setWidth,setHidden,setPage,setVersion};return <main className="fixture-main"><p id="version">版本 {version}</p><button id="outside-control">表格外部操作</button>{mounted&&<>
 <section id="shared" className="account-ledger" data-fixture-table style={{width,maxWidth:'100%'}}><ScrollableTable bounded scrollResetKey={String(page)} scrollLabel={labels.shared} style={{width:1200,minWidth:1200,tableLayout:'fixed'}}><TableHeader><TableRow>{headers.map(label=><TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader><TableBody><Cells page={page}/></TableBody></ScrollableTable><output id="page">第 {page} 页</output></section>
 <section id="raw" data-fixture-table style={{width:480,maxWidth:'100%'}}><Raw name="raw"/></section>
 <section id="fit" data-fixture-table style={{width:480,maxWidth:'100%'}}><ScrollableTable scrollLabel={labels.fit} style={{width:'100%',minWidth:0,tableLayout:'fixed'}}><TableHeader><TableRow><TableHead>作者</TableHead><TableHead>点赞</TableHead></TableRow></TableHeader><TableBody><TableRow><TableCell>甲</TableCell><TableCell>—</TableCell></TableRow></TableBody></ScrollableTable></section>
 <section id="hidden" hidden={hidden} data-fixture-table style={{width:480,maxWidth:'100%'}}><Raw name="hidden"/></section>
 <details id="fixture-details"><summary>展开合成详情</summary><section id="details" data-fixture-table style={{width:480,maxWidth:'100%'}}><Raw name="details"/></section></details>
 </>}</main>};createRoot(document.getElementById('root')).render(<Fixture/>);`;
 const bundle=await build({stdin:{contents:fixture,resolveDir:root,sourcefile:'table-scroll-frame-fixture.tsx',loader:'tsx'},absWorkingDir:root,bundle:true,write:false,outfile:'table-scroll-frame-fixture.js',format:'iife',platform:'browser',jsx:'automatic',tsconfig:root+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'}});
 const globals=await postcss([tailwind({base:root})]).process(await readFile(root+'app/globals.css','utf8'),{from:root+'app/globals.css'});
 const styles=await Promise.all(['app/replica.css','app/visual-theme.css','components/table-scroll-frame.css'].map(path=>readFile(root+path,'utf8')));
 const css=globals.css+'\n'+styles.join('\n')+'\nhtml,body{margin:0}.fixture-main{display:block;min-width:0;padding:16px}.fixture-main>section,.fixture-main>details{margin-bottom:24px}.fixture-main td,.fixture-main th{height:48px;padding:10px;white-space:nowrap}.fixture-main input{width:90px}.fixture-main button{font:inherit}';
 return {script:bundle.outputFiles.find(file=>file.path.endsWith('.js')).text,css};
}

async function openFixture(browser,assets,width=1440,reducedMotion='reduce'){
 const context=await browser.newContext({viewport:{width,height:900},reducedMotion,hasTouch:width===390}),errors=[],requests=[];
 await context.addInitScript(installProbe);
 await context.route('**/*',route=>{
  const request=route.request(),path=new URL(request.url()).pathname;requests.push({method:request.method(),path});
  if(request.method()!=='GET')return route.abort();
  if(path==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>'});
  if(path==='/fixture.css')return route.fulfill({contentType:'text/css',body:assets.css});
  if(path==='/fixture.js')return route.fulfill({contentType:'text/javascript',body:assets.script});
  return route.abort();
 });
 const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://127.0.0.1:49129/');await page.getByRole('region',{name:labels.shared,exact:true}).waitFor();
 return {context,page,errors,requests};
}
const area=(page,id)=>page.locator('#'+id+' [data-slot="table-container"],#'+id+' .source-table-wrap');
const region=(page,id)=>page.getByRole('region',{name:labels[id],exact:true});
const control=(page,id,direction)=>page.getByRole('button',{name:labels[id]+'：向'+direction+'查看',exact:true});
const position=locator=>locator.evaluate(element=>({left:element.scrollLeft,top:element.scrollTop,maxLeft:element.scrollWidth-element.clientWidth,maxTop:element.scrollHeight-element.clientHeight}));
async function settled(page){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function assertNoMutation(page,requests,errors){
 assert.deepEqual(errors,[]);
 assert.ok(requests.every(row=>row.method==='GET'&&['/','/fixture.css','/fixture.js','/favicon.ico'].includes(row.path)),'table navigation never loads or mutates business data');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'wide tables must scroll locally, never widen the document');
}

test('table scroll affordances use real overflow and preserve keyboard, data and component lifecycle',async t=>{
 const assets=await fixtureAssets();
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{
  for(const width of [1440,390])await t.test('shared and raw table overflow controls work at '+width+'px',async()=>{
   const {context,page,errors,requests}=await openFixture(browser,assets,width);try{
    for(const id of ['shared','raw']){
     const scroll=area(page,id),before=await page.locator('#'+id+' tbody').innerText();
     await control(page,id,'右').waitFor();assert.ok((await position(scroll)).maxLeft>0,'the fixture must really overflow even inside a narrow desktop container');
     assert.equal(await control(page,id,'左').isDisabled(),true);assert.equal(await control(page,id,'右').isDisabled(),false);
     await control(page,id,'右').click();assert.ok((await position(scroll)).left>0);
     const call=await page.evaluate(id=>window.tableProbe.calls.filter(row=>row.id===id).at(-1),id);assert.equal(call.options.behavior,'instant','reduced-motion buttons must not animate scrolling');
     await settled(page);
     assert.equal(await control(page,id,'左').isDisabled(),false);
     await region(page,id).focus();await page.keyboard.press('End');
     await page.waitForFunction(id=>{const area=document.querySelector('#'+id+' [data-slot="table-container"],#'+id+' .source-table-wrap');return Math.abs(area.scrollLeft-(area.scrollWidth-area.clientWidth))<=1;},id);
     await settled(page);assert.equal(await control(page,id,'右').isDisabled(),true);
     await page.keyboard.press('Home');await settled(page);assert.equal((await position(scroll)).left,0);assert.equal(await control(page,id,'左').isDisabled(),true);
     await page.keyboard.press('ArrowRight');const moved=(await position(scroll)).left;assert.ok(moved>0&&moved<=121);
     await page.keyboard.press('ArrowLeft');assert.equal((await position(scroll)).left,0);
     assert.equal(await page.locator('#'+id+' tbody').innerText(),before,'moving the viewport must not sort, recalculate or replace any row');
    }
    assert.equal((await position(area(page,'fit'))).maxLeft,0);
    assert.equal(await control(page,'fit','左').count(),0);assert.equal(await control(page,'fit','右').count(),0,'controls are absent when the entire short table fits');
    await assertNoMutation(page,requests,errors);
   }finally{await context.close();}
  });

  await t.test('nested inputs and buttons keep their keyboard behavior instead of triggering table navigation',async()=>{
   const {context,page,errors,requests}=await openFixture(browser,assets);try{
    await control(page,'shared','右').waitFor();
    const input=page.locator('#shared-input');await input.focus();await input.evaluate(element=>element.setSelectionRange(1,1));
    const before=await page.evaluate(()=>window.tableProbe.calls.length);
    await page.keyboard.press('ArrowRight');assert.equal(await input.evaluate(element=>element.selectionStart),2);
    assert.equal(await page.evaluate(()=>window.tableProbe.keys.at(-1).prevented),false);
    await page.keyboard.press('Home');assert.equal(await input.evaluate(element=>element.selectionStart),0);
    assert.equal(await page.evaluate(()=>window.tableProbe.keys.at(-1).prevented),false);
    await page.locator('#shared-child').focus();await page.keyboard.press('End');
    assert.equal(await page.evaluate(()=>window.tableProbe.keys.at(-1).prevented),false);
    await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>window.tableProbe.keys.at(-1).prevented),false);
    await page.locator('#raw-child-0').focus();await page.keyboard.press('End');
    assert.equal(await page.evaluate(()=>window.tableProbe.keys.at(-1).prevented),false,'raw source-table child controls also keep native keyboard commands');
    assert.equal(await page.evaluate(()=>window.tableProbe.calls.length),before,'descendant control keys must not call the table scroll helpers');
    await region(page,'shared').focus();await page.keyboard.press('Shift+ArrowRight');
    assert.equal(await page.evaluate(()=>window.tableProbe.keys.at(-1).prevented),false,'modified keyboard commands remain native');
    await assertNoMutation(page,requests,errors);
   }finally{await context.close();}
  });

  await t.test('hidden, disclosure and resized containers recompute overflow without a window resize event',async()=>{
   const {context,page,errors,requests}=await openFixture(browser,assets);try{
    await control(page,'shared','右').waitFor();
    assert.equal(await control(page,'hidden','右').isVisible(),false);
    assert.equal(await control(page,'details','右').isVisible(),false);
    await page.evaluate(()=>window.tableFixture.setHidden(false));await control(page,'hidden','右').waitFor();
    assert.ok((await position(area(page,'hidden'))).maxLeft>0);
    await page.locator('#fixture-details summary').click();await control(page,'details','右').waitFor();
    assert.ok((await position(area(page,'details'))).maxLeft>0);
    await page.evaluate(()=>window.tableFixture.setWidth(1300));
    await control(page,'shared','右').waitFor({state:'detached'});assert.equal((await position(area(page,'shared'))).maxLeft,0);
    await page.evaluate(()=>window.tableFixture.setWidth(420));await control(page,'shared','右').waitFor();
    assert.ok((await position(area(page,'shared'))).maxLeft>0);assert.equal(await control(page,'shared','左').isDisabled(),true);
    await page.evaluate(()=>window.tableFixture.setHidden(true));await settled(page);assert.equal(await control(page,'hidden','右').isVisible(),false);
    await page.locator('#fixture-details summary').click();await settled(page);assert.equal(await control(page,'details','右').isVisible(),false);
    await assertNoMutation(page,requests,errors);
   }finally{await context.close();}
  });

  await t.test('bounded pagination resets only vertical position and never moves a different table',async()=>{
   const {context,page,errors,requests}=await openFixture(browser,assets);try{
    await control(page,'shared','右').waitFor();await control(page,'raw','右').click();
    const rawBefore=await position(area(page,'raw'));
    await region(page,'shared').focus();await page.keyboard.press('ArrowRight');await page.keyboard.press('PageDown');
    const before=await position(area(page,'shared'));assert.ok(before.left>0&&before.top>100&&before.maxTop>0);
    await page.keyboard.press('ArrowUp');assert.ok((await position(area(page,'shared'))).top<before.top);
    await page.keyboard.press('PageUp');assert.equal((await position(area(page,'shared'))).top,0);
    await page.keyboard.press('PageDown');const resetBefore=await position(area(page,'shared'));
    await page.evaluate(()=>window.tableFixture.setVersion(2));await page.locator('#version').getByText('版本 2',{exact:true}).waitFor();
    assert.deepEqual(await position(area(page,'shared')),resetBefore,'an ordinary data rerender must not reset the viewport');
    await page.evaluate(()=>window.tableFixture.setPage(2));await page.locator('#page').getByText('第 2 页',{exact:true}).waitFor();
    await page.waitForFunction(()=>document.querySelector('#shared [data-slot="table-container"]').scrollTop===0);
    assert.equal((await position(area(page,'shared'))).left,resetBefore.left,'the selected metric columns remain in view on pagination');
    assert.deepEqual(await position(area(page,'raw')),rawBefore,'another table keeps its independent horizontal position');
    await assertNoMutation(page,requests,errors);
   }finally{await context.close();}
  });

  await t.test('keyboard boundary controls retain focus and disappearing controls restore only their own focus',async()=>{
   const {context,page,errors,requests}=await openFixture(browser,assets);try{
    const scroll=area(page,'shared');await control(page,'shared','右').waitFor();
    for(const [direction,boundary]of [['右','end'],['左','start']]){
     const button=control(page,'shared',direction);await button.focus();
     for(let attempt=0;attempt<20;attempt++){
      const state=await position(scroll);if(boundary==='end'?state.maxLeft-state.left<=1:state.left<=1)break;
      await page.keyboard.press('Enter');await settled(page);
     }
     const boundaryPosition=await position(scroll);
     assert.ok(boundary==='end'?boundaryPosition.maxLeft-boundaryPosition.left<=1:boundaryPosition.left<=1,'repeated Enter must reach the '+boundary+' boundary');
     assert.equal(await button.getAttribute('aria-disabled'),'true','a boundary is announced as unavailable without removing the control from keyboard focus');
     assert.equal(await button.evaluate(element=>document.activeElement===element),true,'the focused '+direction+' control must retain focus at its boundary');
     const calls=await page.evaluate(()=>window.tableProbe.calls.length);
     await page.keyboard.press('Enter');await page.keyboard.press('Enter');await settled(page);
     assert.deepEqual(await position(scroll),boundaryPosition,'Enter on an unavailable boundary is a no-op');
     assert.equal(await page.evaluate(()=>window.tableProbe.calls.length),calls,'an unavailable boundary must not even schedule another smooth scroll');
     assert.equal(await button.evaluate(element=>document.activeElement===element),true);
    }
    await control(page,'shared','右').focus();
    await page.evaluate(()=>window.tableFixture.setWidth(1300));
    await control(page,'shared','右').waitFor({state:'detached'});
    await page.waitForFunction(()=>document.activeElement===document.querySelector('#shared .table-scroll-region'));
    assert.equal((await position(scroll)).maxLeft,0,'the control disappearance must be caused by the table actually fitting');

    await page.evaluate(()=>window.tableFixture.setWidth(480));await control(page,'shared','右').waitFor();
    await page.locator('#outside-control').focus();
    await page.evaluate(()=>window.tableFixture.setWidth(1300));await control(page,'shared','右').waitFor({state:'detached'});await settled(page);
    assert.equal(await page.locator('#outside-control').evaluate(element=>document.activeElement===element),true,'a table resize may not steal focus from an unrelated control');
    await assertNoMutation(page,requests,errors);
   }finally{await context.close();}
  });

  await t.test('motion preferences are checked at interaction time and unmount releases observers and listeners',async()=>{
   const {context,page,errors,requests}=await openFixture(browser,assets,1440,'no-preference');try{
    await control(page,'raw','右').waitFor();await control(page,'raw','右').click();
    assert.equal(await page.evaluate(()=>window.tableProbe.calls.filter(row=>row.id==='raw').at(-1).options.behavior),'smooth');
    await page.emulateMedia({reducedMotion:'reduce'});await region(page,'raw').focus();await page.keyboard.press('Home');await settled(page);
    await control(page,'raw','右').click();
    assert.equal(await page.evaluate(()=>window.tableProbe.calls.filter(row=>row.id==='raw').at(-1).options.behavior),'instant');
    const mounted=await page.evaluate(()=>window.tableProbe.snapshot());assert.ok(mounted.observers>0&&mounted.listeners>0,'cleanup probe must observe resources actually registered by mounted tables');
    await page.evaluate(()=>window.tableFixture.setMounted(false));await page.locator('.table-scroll-shell').first().waitFor({state:'detached'});
    await page.waitForFunction(()=>{const state=window.tableProbe.snapshot();return state.observers===0&&state.listeners===0&&state.frames===0;},undefined,{polling:50});
    const before=await page.evaluate(()=>window.tableProbe.calls.length);await page.evaluate(()=>window.dispatchEvent(new Event('resize')));await settled(page);
    assert.deepEqual(await page.evaluate(()=>window.tableProbe.snapshot()),{observers:0,listeners:0,frames:0});
    assert.equal(await page.evaluate(()=>window.tableProbe.calls.length),before);await assertNoMutation(page,requests,errors);
   }finally{await context.close();}
  });
 }finally{await browser.close();}
});
