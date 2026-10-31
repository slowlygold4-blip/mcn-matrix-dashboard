import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const site=fileURLToPath(new URL('../',import.meta.url));
const main=process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../douyin-monitor-workbench/',import.meta.url));
const {chromium}=createRequire(main+'package.json')('playwright-core');
const fixture=`import React from 'react';import {createRoot} from 'react-dom/client';
import {TuantuanRosterTable} from './components/tuantuan-roster';import {buildTuantuanRoster} from './lib/tuantuan-roster.mjs';
const authors=Array.from({length:65},(_,i)=>({row:i+2,name:'合成作者'+String(i).padStart(2,'0'),douyinId:'id-'+i,douyinIds:['id-'+i,'alias-'+i],targetIds:i<49?[i+1]:[],posts:1,slicePosts:1,plays:i*100,likes:i*2,sourceTitles:['合成原表']}));
const accounts=Array.from({length:49},(_,i)=>({id:i+1,label:'合成监控'+i,enabled:i<33,platform:'douyin',classification:{theme:{key:'tuantuan'},labels:[]},latest:{followers:{value:i,date:'2026-10-30'},likes:{value:i*3,date:'2026-10-30'}}}));
const roster=buildTuantuanRoster(authors,accounts),metrics=accounts.map(a=>({...a,metrics:{followers:{value:a.id,baseline:a.id,delta:0},likes:{value:a.id,baseline:a.id+1,delta:-1},posts:{value:1,baseline:0,delta:1}}}));
createRoot(document.getElementById('root')).render(<TuantuanRosterTable roster={roster} classification="all" addressMode metricRows={metrics} changesReady periodLabel="合成测试区间" onOpenAccount={()=>{}} onOpenSourceWorks={()=>{}}/>);`;

test('mobile disclosure preserves roster tasks, direct pages, source IDs and keyboard access',{timeout:45000},async t=>{
 const bundled=await build({stdin:{contents:fixture,resolveDir:site,sourcefile:'roster-mobile-fixture.tsx',loader:'tsx'},absWorkingDir:site,bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',tsconfig:site+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'}});
 const css=['vendor/shadcn-tailwind-4.13.0.css','app/replica.css','app/source-operations.css','app/visual-theme.css','app/observatory.css','components/table-scroll-frame.css','components/tuantuan-roster-controls.css'].map(p=>readFileSync(site+p,'utf8')).join('\n');
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});try{
  await context.addInitScript(()=>{window.exports=[];URL.createObjectURL=blob=>{window.exports.push(blob);return 'blob:fixture'};URL.revokeObjectURL=()=>{};HTMLAnchorElement.prototype.click=function(){};});
  await context.route('**/*',route=>{
   const u=new URL(route.request().url());if(u.origin!=='https://roster-mobile.test')return route.abort();
   if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div class="workspace"><main class="content"><div id="root"></div></main></div><script src="/fixture.js"></script>'});
   if(u.pathname==='/fixture.js')return route.fulfill({contentType:'text/javascript',body:bundled.outputFiles[0].text});return route.abort();
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(6000);
  await page.goto('https://roster-mobile.test/?rosterPanel=authors&rosterSort=name&rosterDirection=asc&rosterPage=2&theme=tuantuan#accounts');await page.addStyleTag({content:css});
  const panel=page.getByRole('region',{name:'团团统一作者名册'}),toggle=panel.getByRole('button',{name:'筛选与排序',exact:true}),search=page.getByLabel('搜索团团全部作者');
  const top=page.getByRole('navigation',{name:'团团名册上方分页'});
  await top.getByText(/第 2\/3 页/).waitFor();

  await t.test('search and active task summary stay visible while optional controls start closed',async()=>{
   await page.waitForFunction(()=>document.querySelector('[aria-label="筛选与排序"]')?.getAttribute('aria-expanded')==='false');
   assert.equal(await search.isVisible(),true);assert.equal(await page.getByLabel('团团名册排序指标').isVisible(),false);
   assert.match(await panel.getByLabel('当前作者筛选与排序').innerText(),/全部作者.*作者名称.*↑/);
   const measurements=[];
   for(const width of [390,320]){
    await page.setViewportSize({width,height:844});
    const bounds=await panel.evaluate(el=>({firstRow:el.querySelector('tbody tr').getBoundingClientRect().top-el.getBoundingClientRect().top,rowTop:el.querySelector('tbody tr').getBoundingClientRect().top,viewport:innerHeight,overflow:document.documentElement.scrollWidth-innerWidth}));
    measurements.push({width,...bounds});
    assert.equal(bounds.overflow,0);
   }
   assert.ok(measurements.every(x=>x.rowTop<x.viewport-80),JSON.stringify(measurements));
  });

  await t.test('keyboard opening, filtering and closing preserve the URL and move focus past hidden controls',async()=>{
   await toggle.focus();await toggle.press('Enter');assert.equal(await toggle.getAttribute('aria-expanded'),'true');
   assert.equal(new URL(page.url()).searchParams.get('rosterPage'),'2');
   await panel.getByRole('button',{name:'暂停监控 16',exact:true}).click();
   await top.getByText(/16 位.*第 1\/1 页/).waitFor();
   await page.getByLabel('团团名册排序指标').selectOption('likes.delta');await page.getByLabel('团团名册排序顺序').selectOption('asc');
   await toggle.focus();await toggle.press('Space');assert.equal(await toggle.getAttribute('aria-expanded'),'false');
   assert.match(await panel.getByLabel('当前作者筛选与排序').innerText(),/暂停监控.*主页获赞变化.*↑/);
   await toggle.press('Tab');assert.notEqual(await page.evaluate(()=>document.activeElement?.closest('.roster-filter-controls')!==null),true);
   assert.equal(new URL(page.url()).searchParams.get('rosterMode'),'paused');
  });

  await t.test('collapsed filters still apply to original-ID lookup and all-match CSV export',async()=>{
   await search.fill('alias-44');await top.getByText(/1 位.*第 1\/1 页/).waitFor();
   assert.match(await panel.locator('tbody').innerText(),/id-44 \/ alias-44/);
   await panel.getByRole('button',{name:'导出当前筛选',exact:true}).click();
   const csv=await page.evaluate(()=>window.exports.at(-1).text());assert.equal(csv.trim().split(/\r?\n/).length,2);assert.match(csv,/id-44 \/ alias-44/);
   assert.equal(await toggle.getAttribute('aria-expanded'),'false');
  });

  await t.test('address restoration, draft jump, validation and viewport changes retain their separate states',async()=>{
   await page.evaluate(()=>{history.pushState(null,'','/?rosterPanel=authors&rosterSort=name&rosterDirection=asc&rosterPage=2&theme=tuantuan#accounts');dispatchEvent(new PopStateEvent('popstate'));});
   await top.getByText(/第 2\/3 页/).waitFor();assert.equal(await search.inputValue(),'');assert.equal(await toggle.getAttribute('aria-expanded'),'false');
   const jump=page.getByLabel('上方页码');await jump.fill('3');assert.equal(new URL(page.url()).searchParams.get('rosterPage'),'2');await jump.press('Enter');
   await top.getByText(/第 3\/3 页/).waitFor();assert.equal(await panel.locator('tbody tr').count(),5);
   await jump.fill('9');await jump.press('Enter');assert.match(await top.getByRole('alert').innerText(),/请输入 1–3/);
   assert.equal(new URL(page.url()).searchParams.get('rosterPage'),'3');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await page.setViewportSize({width:1280,height:900});await page.getByLabel('团团名册排序指标').waitFor({state:'visible'});
   assert.equal(await toggle.isVisible(),false);assert.equal(await jump.inputValue(),'9','resizing must not reset a typed page draft');
   await page.setViewportSize({width:390,height:844});await toggle.waitFor();assert.equal(await toggle.getAttribute('aria-expanded'),'false');
   assert.equal(new URL(page.url()).searchParams.get('rosterPage'),'3');
  });
  assert.deepEqual(errors,[]);
 }finally{await context.close();}}finally{await browser.close();}
});
