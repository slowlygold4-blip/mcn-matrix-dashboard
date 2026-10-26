import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const site=fileURLToPath(new URL('../',import.meta.url));
const main=process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../douyin-monitor-workbench/',import.meta.url));
const {chromium}=createRequire(main+'package.json')('playwright-core');

test('actual React pager retains only its own boundary focus and cancels stale work',async()=>{
 const source=await readFile(process.env.MCN_PAGER_SOURCE||site+'app/page.tsx','utf8');
 const begin=source.indexOf('function Pager('),end=source.indexOf('export default function Home(){',begin);
 const old=source.split('\n').find(line=>line.startsWith(' const pager='));
 assert.ok(begin>=0&&end>begin||old,'use the real module-level Pager or the exact original JSX, not a replacement implementation');
 const component=begin>=0?source.slice(begin,end):`function Pager({count,page,change,scope}){const n=count,p=page;return ${old.slice(old.indexOf(')=><div')+3).trim().replace(/;$/,'')};}`;
 const fixture=`import React,{useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';import {createRoot} from 'react-dom/client';import {Button} from './components/ui/button';${component}
 function Harness(){const [page,setPage]=useState(1),[scope,setScope]=useState('A'),[visible,setVisible]=useState(true);window.harness={reset:()=>{setPage(1);setScope('A');setVisible(true);},scope:()=>setScope('B'),hide:()=>setVisible(false)};return <><input id="elsewhere"/><button id="navigate">other control</button>{visible&&<><Pager count={45} page={page} change={setPage} scope={scope}/><Pager count={45} page={page} change={setPage} scope={scope}/></>}</>;};createRoot(document.getElementById('root')).render(<Harness/>);`;
 const bundle=await build({stdin:{contents:fixture,resolveDir:site,sourcefile:'phase119-real-pager.tsx',loader:'tsx'},absWorkingDir:site,bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',tsconfig:site+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'}});
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 let checks=0;
 try{const context=await browser.newContext({viewport:{width:390,height:800},reducedMotion:'reduce'});try{
  const page=await context.newPage();await page.route('**/*',route=>route.abort());await page.setContent('<!doctype html><meta charset="utf-8"><div id="root"></div>');
  await page.evaluate(()=>{const request=window.requestAnimationFrame.bind(window),cancel=window.cancelAnimationFrame.bind(window),listeners=new Set();window.testClock={hold:false,queued:new Map(),next:100000,flush(){const list=[...this.queued.values()];this.queued.clear();for(const f of list)f(performance.now());},listeners};window.requestAnimationFrame=f=>{if(!window.testClock.hold)return request(f);const id=window.testClock.next++;window.testClock.queued.set(id,f);return id;};window.cancelAnimationFrame=id=>{window.testClock.queued.delete(id);cancel(id);};const add=document.addEventListener.bind(document),remove=document.removeEventListener.bind(document);document.addEventListener=(type,f,...args)=>{if(type==='focusin')listeners.add(f);add(type,f,...args);};document.removeEventListener=(type,f,...args)=>{if(type==='focusin')listeners.delete(f);remove(type,f,...args);};});
  await page.addScriptTag({content:bundle.outputFiles[0].text});await page.locator('.pager').first().waitFor();
  const focus=()=>page.evaluate(()=>({text:document.activeElement?.textContent,id:document.activeElement?.id,disabled:document.activeElement?.disabled}));
  const reset=async()=>{await page.evaluate(()=>{window.harness.reset();window.testClock.hold=false;});await page.waitForTimeout(30);};
  for(const index of [0,1])for(const key of ['Enter','Space']){
   await reset();const pager=page.locator('.pager').nth(index),next=pager.getByRole('button',{name:'下一页'}),prev=pager.getByRole('button',{name:'上一页'});
   await next.focus();await page.keyboard.press(key);await page.waitForTimeout(30);assert.equal((await focus()).text,'下一页');assert.equal(await next.isDisabled(),false);checks++;
   await page.keyboard.press(key);await page.waitForTimeout(30);assert.equal((await focus()).text,'上一页');assert.equal((await focus()).disabled,false);assert.equal(await next.isDisabled(),true);assert.equal(await prev.evaluate(el=>document.activeElement===el),true);checks++;
   await page.keyboard.press(key);await page.waitForTimeout(30);assert.equal((await focus()).text,'上一页');checks++;
   await page.keyboard.press(key);await page.waitForTimeout(30);assert.equal((await focus()).text,'下一页');assert.equal(await next.evaluate(el=>document.activeElement===el),true);checks++;
  }
  for(const action of ['focus','scope','hide']){
   await reset();const next=page.locator('.pager').first().getByRole('button',{name:'下一页'});await next.focus();await page.keyboard.press('Enter');await page.waitForTimeout(30);
   await page.evaluate(()=>window.testClock.hold=true);await next.focus();await page.keyboard.press('Enter');await page.waitForTimeout(20);
   assert.equal(await page.evaluate(()=>window.testClock.queued.size),1,'only one pending frame for the activated pager');
   await page.evaluate(action=>{if(action==='focus')document.getElementById('elsewhere').focus();else window.harness[action]();},action);await page.waitForTimeout(20);await page.evaluate(()=>window.testClock.flush());
   if(action==='focus')assert.equal((await focus()).id,'elsewhere');else assert.notEqual((await focus()).text,'上一页');
   assert.equal(await page.evaluate(()=>window.testClock.queued.size),0);assert.equal(await page.evaluate(()=>window.testClock.listeners.size),0);checks++;
  }
  assert.equal(checks,19);
 }finally{await context.close();}}finally{await browser.close();}
});
