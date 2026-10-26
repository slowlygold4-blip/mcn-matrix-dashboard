// Real current Home + all production components, bundled in memory and mounted
// in a fresh Chrome. Every response is fulfilled from Phase80's saved public
// generation; no collector, DB, server, platform or production writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright-core';
import {preparePublicReplicaPublication} from '../lib/public-replica-sync.mjs';

const SITE=new URL('../../mcn-public-site/',import.meta.url),requireSite=createRequire(new URL('package.json',SITE));
const base=new URL('../data/public-replica-staging/publisher-2026-10-01T20-13-51-158Z/',import.meta.url);
const origin='http://127.0.0.1:43981';
const prefix=new URL('../data/maintenance-journal/2026-10-02-phase81-ux-',import.meta.url);
const evidenceMode=process.env.PHASE81_UX_EVIDENCE;
const candidate=process.env.PHASE81_UX_CANDIDATE==='1';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const models=await import(new URL('lib/replica-model.mjs',SITE));
const exportsModel=await import(new URL('lib/replica-export.mjs',SITE));
const personal=await import(new URL('lib/replica-account.mjs',SITE));
const trends=await import(new URL('lib/replica-trends.mjs',SITE));
const manifest=JSON.parse(await readFile(new URL('manifest.json',base),'utf8'));
const publication=await preparePublicReplicaPublication({manifest,files:await Promise.all(manifest.files.map(async f=>({...f,content:await readFile(new URL(f.path,base),'utf8')})))},{dateIndex:true});
const files=new Map(publication.files.map(f=>[f.path,f]));
const catalog=JSON.parse(files.get('catalog.json').content);
const sourcePaths=['app/page.tsx','components/account-panel.tsx','components/growth-panel.tsx','app/replica.css'];
const sourceHashes=Object.fromEntries(await Promise.all(sourcePaths.map(async path=>[path,sha(await readFile(new URL(path,SITE)))])));
const plugins=candidate?[{name:'review-only-history-focus-candidate',setup(build){
 build.onLoad({filter:/(?:app\/page|components\/account-panel)\.tsx$/},async args=>{
  let contents=await readFile(args.path,'utf8');
  if(args.path.endsWith('/app/page.tsx')){
   const old='onHistory={a=>{authorReturnFocus.current=null;';assert.ok(contents.includes(old));
   contents=contents.replace(old,'onHistory={(a,trigger)=>{authorReturnFocus.current=trigger??null;');
  }else{
   const old='onHistory:(a:Row)=>void';assert.ok(contents.includes(old));
   contents=contents.replace(old,'onHistory:(a:Row,trigger?:HTMLButtonElement)=>void');
   const click='onClick={()=>onHistory(row||account)}';assert.ok(contents.includes(click));
   contents=contents.replace(click,'onClick={event=>onHistory(row||account,event.currentTarget)}');
  }
  return {contents,loader:'tsx'};
 });
}}]:[];
const bundle=await requireSite('esbuild').build({stdin:{contents:'import React from "react";import {createRoot} from "react-dom/client";import Home from "./app/page.tsx";createRoot(document.getElementById("root")).render(React.createElement(Home));',resolveDir:SITE.pathname,loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',alias:{'@':SITE.pathname},define:{'process.env.NODE_ENV':'"production"'},plugins});
const css=(await requireSite('postcss')([requireSite('@tailwindcss/postcss')({base:SITE.pathname})]).process(await readFile(new URL('app/globals.css',SITE),'utf8'),{from:new URL('app/globals.css',SITE).pathname})).css+'\n'+await readFile(new URL('app/replica.css',SITE),'utf8');

test('phase81 actual desktop daily task, saved-source exports, comparison and return; independent personal history focus audit',async()=>{
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',serviceWorkers:'block',acceptDownloads:true});
 const evidence={startedAt:new Date().toISOString(),sourceHashes,candidateOnly:candidate,generation:manifest.asOf,realSavedFixture:true,actualHomeAndComponents:true,cloudOrUserAcceptance:false,platformReads:0,dbReads:0,externalRequests:[],resourceReads:[],apiReads:[],steps:[],downloads:[],issues:[]};
 let page;
 const errors=[];
 const save=async name=>{const state={name,url:page.url(),dom:await page.locator('body').ariaSnapshot(),focus:await page.evaluate(()=>({tag:document.activeElement?.tagName,text:document.activeElement?.tagName==='BODY'?'':document.activeElement?.textContent,aria:document.activeElement?.getAttribute('aria-label')}))};if(evidenceMode){const path=prefix.pathname+evidenceMode+'-'+name+'.png';await page.screenshot({path,fullPage:false});state.screenshot=path;}evidence.steps.push(state);return state;};
 const download=async(button,label)=>{const event=page.waitForEvent('download');await button.click();const d=await event,bytes=await readFile(await d.path());evidence.downloads.push({label,name:d.suggestedFilename(),sha256:sha(bytes),bytes:bytes.length});return bytes;};
 try{
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());evidence.resourceReads.push(url.pathname);assert.equal(request.method(),'GET');
   if(url.origin!==origin){evidence.externalRequests.push(request.url());return route.abort();}
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>'});
   if(url.pathname==='/style.css')return route.fulfill({contentType:'text/css',body:css});
   if(url.pathname==='/app.js')return route.fulfill({contentType:'text/javascript',body:Buffer.from(bundle.outputFiles[0].contents)});
   if(url.pathname!=='/api/replica')return route.fulfill({status:404,body:'No offline resource'});
   const generation=url.searchParams.get('generation');assert.ok(!generation||generation===manifest.asOf);
   const part=url.searchParams.get('part'),file=part&&files.get(part);if(part)assert.ok(file,'unknown saved part '+part);
   evidence.apiReads.push(part||'manifest');return route.fulfill({contentType:'application/json',headers:part?{'X-Data-SHA256':file.sha256,'X-Data-Cutoff':manifest.asOf}:{'Cache-Control':'no-store'},body:part?file.content:JSON.stringify({manifest:publication.manifest,publishedAt:'2026-10-01T20:21:15.900Z',readOnly:true,collectionRequiresLocalComputer:true})});
  });
  page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/#overview',{waitUntil:'domcontentloaded'});
  const groups=page.getByRole('region',{name:'大主题与内容分类数据'});
  await groups.waitFor({timeout:20000});await save('01-global');
  const tuantuan=groups.getByRole('button',{name:'团团',exact:true});await tuantuan.click();
  await page.getByRole('heading',{name:'账号明细',exact:true}).waitFor();await save('02-tuantuans');
  await page.locator('.advanced-scope summary').click();
  const tag=page.getByLabel('内容分类',{exact:false});
  const options=await tag.locator('option').evaluateAll(els=>els.map(el=>({value:el.value,text:el.textContent})));
  const slice=options.find(o=>o.text.startsWith('切片'));assert.ok(slice,JSON.stringify(options));await tag.selectOption(slice.value);
  await page.locator('.period-toolbar select').selectOption('week');await page.getByRole('button',{name:'应用周期',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.period-state strong')?.textContent?.includes('7')&&!document.querySelector('.active-scope')?.textContent?.includes('待核对'));
  await save('03-slice-week');
  const ledger=page.locator('.account-ledger');await ledger.getByRole('button',{name:'点赞变化',exact:true}).click();
  await ledger.getByRole('columnheader',{name:'点赞变化 ↓',exact:true}).waitFor();await save('04-ranking');
  const search=page.getByRole('textbox',{name:'搜索作者',exact:true});await search.fill('糯米团子');
  const account=catalog.accounts.find(a=>a.label==='糯米团子🍡');assert.ok(account);
  const row=ledger.locator('tbody tr').filter({has:page.locator('button.author').filter({hasText:account.label})});await row.waitFor();
  const beforeUrl=page.url(),beforeCells=await row.locator('td').allTextContents();
  const csvBytes=await download(page.getByRole('button',{name:'导出全部结果',exact:true}),'filtered-accounts');
  const A={start:new URL(beforeUrl).searchParams.get('start'),end:new URL(beforeUrl).searchParams.get('end')};
  const daily=JSON.parse(files.get('daily/'+account.id+'.json').content).items;
  const points=personal.personalPoints(daily,account.id,manifest.asOf);
  const exactRows=models.rowsFor([account],points,A.start,A.end);
  assert.deepEqual(csvBytes,Buffer.from(models.csv(exportsModel.accountExport(exactRows,publication.manifest,A.start,A.end))));
  const detail=row.locator('button.author');await detail.focus();await page.keyboard.press('Enter');
  await page.getByRole('heading',{name:'已保存每日统计',exact:true}).waitFor();await save('05-account-detail');
  const history=page.getByRole('button',{name:'查看全部每日、作品与指标历史',exact:true});await history.focus();await page.keyboard.press('Enter');
  const dialog=page.getByRole('dialog');await dialog.waitFor();await dialog.getByRole('button',{name:'导出全部历史',exact:true}).waitFor();await save('06-full-history');
  const historyBytes=await download(dialog.getByRole('button',{name:'导出全部历史',exact:true}),'full-daily-history');
  const historyRows=[...daily].sort((a,b)=>b.date.localeCompare(a.date)||a.id-b.id);
  assert.deepEqual(historyBytes,Buffer.from(models.csv(exportsModel.historyExport({rows:historyRows,kind:'daily',account,manifest:publication.manifest}))));
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  const focusRestored=await history.evaluate(el=>document.activeElement===el);
  const active=await page.evaluate(()=>({tag:document.activeElement?.tagName,text:document.activeElement?.textContent,rect:document.activeElement?.getBoundingClientRect().toJSON()}));
  await save('07-history-closed');
  let tabCount=0;while(tabCount<30&&!await history.evaluate(el=>document.activeElement===el)){await page.keyboard.press('Tab');tabCount++;}
  evidence.historyFocus={restored:focusRestored,active,tabCountToOriginalTrigger:tabCount};
  if(!focusRestored)evidence.issues.push({priority:'P2',description:'个人详情打开全部历史后Escape关闭，焦点落在页面h1而非原历史按钮，需要重新经过个人范围与比较控制。',minimumCandidate:'传递onHistory实际event.currentTarget并保存到authorReturnFocus；仅缺失或已断开时使用现有fallback。'});
  const growth=page.locator('.account-view .growth-panel');await growth.getByRole('button',{name:'比较另一段日期',exact:true}).click();
  await growth.getByLabel('比较起点',{exact:true}).fill('2026-09-17');await growth.getByLabel('比较终点',{exact:true}).fill('2026-09-24');
  await growth.getByLabel('估算播放趋势',{exact:true}).click();
  await growth.getByRole('button',{name:'导出本屏曲线记录',exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('.account-view .growth-panel .scope')?.textContent?.includes('2026-09-17'));
  await save('08-compare-estimated');
  const estimate=trends.growthSeries([account],points,{...A,metric:'estimated',otherStart:'2026-09-17',otherEnd:'2026-09-24',visibleOffset:0,visibleDays:90});
  const likes=trends.growthSeries([account],points,{...A,metric:'likes',otherStart:'2026-09-17',otherEnd:'2026-09-24',visibleOffset:0,visibleDays:90});
  for(let i=0;i<estimate.points.length;i++)for(const key of ['current','comparison'])assert.equal(estimate.points[i][key],likes.points[i][key]===null?null:likes.points[i][key]*100);
  evidence.estimatedNulls=estimate.points.flatMap(p=>[p.current,p.comparison]).filter(x=>x===null).length;
  const trendBytes=await download(growth.getByRole('button',{name:'导出本屏曲线记录',exact:true}),'estimated-comparison');
  assert.deepEqual(trendBytes,Buffer.from(models.csv(exportsModel.trendExport({accounts:[account],points,manifest:publication.manifest,options:{...A,metric:'estimated',otherStart:'2026-09-17',otherEnd:'2026-09-24',visibleOffset:0,visibleDays:90}}))));
  await page.getByRole('button',{name:'返回原核对页',exact:true}).click();await search.waitFor();assert.equal(page.url(),beforeUrl);assert.equal(await search.inputValue(),'糯米团子');
  assert.deepEqual(await row.locator('td').allTextContents(),beforeCells);assert.equal(await detail.evaluate(el=>document.activeElement===el),true);await save('09-return-filter-focus');
  evidence.workspaceReturnPreserved=true;evidence.verifiedExportByteEquality=true;evidence.pageErrors=errors;
  assert.deepEqual(errors,[]);assert.deepEqual(evidence.externalRequests,[]);
  assert.deepEqual(sourceHashes,Object.fromEntries(await Promise.all(sourcePaths.map(async path=>[path,sha(await readFile(new URL(path,SITE)))]))),'production source remained unchanged during peer execution');
  // Production regression contract: always required, never gated by an opt-in.
  assert.equal(focusRestored,true,'closing personal history must restore its actual trigger, not the page heading');
 }catch(error){evidence.failure=error.message;evidence.pageErrors=errors;if(page&&evidenceMode)await page.screenshot({path:prefix.pathname+evidenceMode+'-failure.png',fullPage:false});throw error;
 }finally{
  evidence.finishedAt=new Date().toISOString();if(evidenceMode)await writeFile(prefix.pathname+evidenceMode+'-evidence.json',JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
  console.info('PHASE81_UX '+JSON.stringify({...evidence,steps:evidence.steps.map(({dom,...x})=>x),apiReads:evidence.apiReads.length}));
  await context.close();await browser.close();
 }
});
