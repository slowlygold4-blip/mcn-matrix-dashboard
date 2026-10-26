import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
const requireMain=createRequire('/Users/tyke/Documents/Codex/2026-08-31/bi-a/outputs/douyin-monitor-workbench/package.json');
const {chromium}=requireMain('playwright-core');
const root=new URL('../',import.meta.url).pathname;
const globals=await postcss([tailwind({base:root})]).process(await readFile(root+'app/globals.css','utf8'),{from:root+'app/globals.css'});
const baseline=process.env.PHASE108_BASELINE_DIR;
const css=globals.css+'\n'+await readFile(baseline?baseline+'/replica.css':root+'app/replica.css','utf8');
const source=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {ScrollableTable} from './components/scrollable-table';import {TableHeader,TableRow,TableHead,TableBody,TableCell} from './components/ui/table';
function Fixture(){const [page,setPage]=useState(1),[version,setVersion]=useState(1);window.fixture={setPage,setVersion};return <main><button id="before">表前</button><section className="account-ledger"><ScrollableTable bounded scrollResetKey={String(page)} scrollLabel="账号数据，方向键与 PageUp、PageDown 滚动当前页"><TableHeader><TableRow>{['作者','粉丝','粉丝变化','点赞','点赞变化','作品存量','作品变化'].map(label=><TableHead key={label}><button>{label}</button></TableHead>)}</TableRow></TableHeader><TableBody>{Array.from({length:20},(_,i)=><TableRow key={i}><TableCell><button className="author">合成作者{(page-1)*20+i+1}</button><div className="account-row-actions"><button>经营详情</button><button>历史</button></div><small>合成阅读夹具 · 版本{version}</small><div className="account-classification">主题 / 分类</div></TableCell>{Array.from({length:6},(_,j)=><TableCell key={j}>{j===1?-9:j===2?0:j===3?'—':12345+j}</TableCell>)}</TableRow>)}</TableBody></ScrollableTable></section><button id="after">表后</button><section id="legacy"><ScrollableTable><TableHeader><TableRow><TableHead>旧表</TableHead></TableRow></TableHeader><TableBody>{Array.from({length:20},(_,i)=><TableRow key={i}><TableCell>{i}</TableCell></TableRow>)}</TableBody></ScrollableTable></section></main>};createRoot(document.getElementById('root')).render(<Fixture/>);`;
const bundle=await build({stdin:{contents:source,resolveDir:root,sourcefile:'phase108-fixture.tsx',loader:'tsx'},absWorkingDir:root,bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',tsconfig:root+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'},plugins:baseline?[{name:'exact-preimage',setup(build){build.onLoad({filter:/scrollable-table\.tsx$/},async()=>({contents:await readFile(baseline+'/scrollable-table.tsx','utf8'),loader:'tsx',resolveDir:root+'components'}));}}]:[]});

test('actual React ledger remains readable while scrolling and restores only vertical position on page changes',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce',hasTouch:width===390});
  try{const page=await context.newPage();await page.route('**/*',route=>route.abort());await page.setContent('<!doctype html><html><head><style>'+css+'</style></head><body><div id="root"></div></body></html>');await page.addScriptTag({content:bundle.outputFiles[0].text});
   const region=page.locator('.account-ledger .table-scroll-region'),area=page.locator('.account-ledger [data-slot="table-container"]');await region.waitFor();
   const initial=await area.evaluate(el=>({height:el.clientHeight,total:el.scrollHeight}));
   assert.ok(initial.height<=540&&initial.total>initial.height,JSON.stringify({width,initial}));
   await region.focus();await page.keyboard.press('ArrowDown');assert.ok(await area.evaluate(el=>el.scrollTop>0));
   await page.keyboard.press('PageDown');const top=await area.evaluate(el=>el.scrollTop);assert.ok(top>100);
   await page.keyboard.press('ArrowRight');const left=await area.evaluate(el=>el.scrollLeft);if(width===390)assert.ok(left>0);
   const header=await page.locator('.account-ledger thead th').nth(1).evaluate(el=>{const r=el.getBoundingClientRect(),a=el.closest('[data-slot="table-container"]').getBoundingClientRect();return {top:r.top,area:a.top,height:r.height};});
   assert.ok(Math.abs(header.top-header.area)<2,JSON.stringify({width,header}));
   const corner=await page.locator('.account-ledger thead th').first().evaluate(el=>{const r=el.getBoundingClientRect(),a=el.closest('[data-slot="table-container"]').getBoundingClientRect();return {top:r.top,left:r.left,areaTop:a.top,areaLeft:a.left};});assert.ok(Math.abs(corner.top-corner.areaTop)<2);assert.ok(Math.abs(corner.left-corner.areaLeft)<2);
   await page.evaluate(()=>window.fixture.setVersion(2));await page.getByText('合成阅读夹具 · 版本2').first().waitFor();assert.equal(await area.evaluate(el=>el.scrollTop),top);assert.equal(await area.evaluate(el=>el.scrollLeft),left);
   await page.evaluate(()=>window.fixture.setPage(2));await page.getByText('合成作者21',{exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('.account-ledger [data-slot="table-container"]').scrollTop===0);assert.equal(await area.evaluate(el=>el.scrollLeft),left);
   await region.focus();await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.tagName),'BUTTON');
   const before=await area.evaluate(el=>el.scrollTop);await page.keyboard.press('ArrowDown');assert.equal(await area.evaluate(el=>el.scrollTop),before,'child controls must not be intercepted by region handler');
   const legacy=await page.locator('#legacy [data-slot="table-container"]').evaluate(el=>({height:el.clientHeight,total:el.scrollHeight,max:getComputedStyle(el).maxHeight}));assert.equal(legacy.max,'none');assert.equal(legacy.height,legacy.total);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await page.emulateMedia({media:'print'});const print=await area.evaluate(el=>({max:getComputedStyle(el).maxHeight,overflow:getComputedStyle(el).overflow,position:getComputedStyle(el.querySelector('th')).position}));assert.equal(print.max,'none');assert.equal(print.overflow,'visible');assert.equal(print.position,'static');
  }finally{await context.close();}
 }}finally{await browser.close();assert.equal(browser.isConnected(),false);}
});
