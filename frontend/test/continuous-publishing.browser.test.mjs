import{readFileSync}from'node:fs';import test from 'node:test';import assert from 'node:assert/strict';import {createHash}from'node:crypto';import{createRequire}from'node:module';import{fileURLToPath}from'node:url';import{build}from'esbuild';import{publishingPartitions}from'../lib/replica-publishing.mjs';
const site=fileURLToPath(new URL('../',import.meta.url)),main=process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../douyin-monitor-workbench/',import.meta.url));const{chromium}=createRequire(main+'package.json')('playwright-core');
function edition(asOf,n,label,withMetrics=false){const row=(id,date,title)=>({contentId:String(7300000000000000000n+BigInt(id)),date,author:'作者',title,targetId:1,classifications:id===1?['slice','ai-remix']:id===2?['original']:id===3?[]:['slice'],origin:'platform',...(withMetrics?{metrics:{likes:{value:id===2?null:id===1?0:id,origin:id===2?'unavailable':'platform'},plays:{value:id===3?null:id*10,origin:id===3?'unavailable':'source'}}}:{})});const rows=[...Array.from({length:n},(_,i)=>row(i+1,'2026-10-28',label+'作品'+(i+1))),row(1000,'2026-10-29',label+'今日作品'),row(2000,'',label+'未日期作品')];const files=publishingPartitions(rows,{withMetrics}).map(p=>{const value={version:1,asOf,timeZone:'Asia/Shanghai',...(p.items?{items:p.items}:{scope:p.scope,complete:p.complete,count:p.count,days:p.days,...(p.metrics?{metrics:p.metrics}:{})})},content=JSON.stringify(value);return{content,meta:{path:p.path,kind:p.kind,count:p.items?.length??p.count,bytes:Buffer.byteLength(content),sha256:createHash('sha256').update(content).digest('hex')}};});return{manifest:{asOf,files:files.map(f=>f.meta)},files};}
const A=edition('2026-10-29T07:00:00.000Z',41,'A'),B=edition('2026-10-29T08:00:00.000Z',25,'B'),C=edition('2026-10-29T09:00:00.000Z',5,'C'),D=edition('2026-10-29T10:00:00.000Z',5,'D');
test('actual continuous publication controls preserve selected day/page across immutable refreshes',async t=>{
 const bundle=await build({stdin:{contents:`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{ContinuousPublishing}from'./components/continuous-publishing';function Harness(){const[manifest,setManifest]=useState(${JSON.stringify(A.manifest)});window.fixture={setManifest};window.renders=(window.renders||0)+1;return <div className="workspace"><main className="content" style={{gridColumn:'1 / -1'}}><ContinuousPublishing manifest={manifest}/></main></div>;}createRoot(document.getElementById('root')).render(<Harness/>);`,resolveDir:site,sourcefile:'continuous-publishing-fixture.tsx',loader:'tsx'},absWorkingDir:site,bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',tsconfig:site+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'}});
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{const context=await browser.newContext({viewport:{width:1000,height:850},reducedMotion:'reduce'});try{const page=await context.newPage(),errors=[],reads=[];let failedInitialIndex=false,failDayPart=false;
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin!=='https://mcn-publishing.test')return route.abort();if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><div id="root"></div>'});
 const generation=u.searchParams.get('generation'),part=u.searchParams.get('part'),current=[A,B,C,D].find(e=>e.manifest.asOf===generation),file=current?.files.find(f=>f.meta.path===part);if(!file)return route.fulfill({status:404,body:'not found'});reads.push({generation,part});if(!failedInitialIndex&&part==='publishing.json'){failedInitialIndex=true;return route.fulfill({status:503,body:'temporary'});}if(failDayPart&&part!=='publishing.json'){failDayPart=false;return route.fulfill({status:503,body:'temporary'});}return route.fulfill({body:file.content,contentType:'application/json',headers:{'X-Data-SHA256':file.meta.sha256,'X-Data-Cutoff':generation}});
 });
 await page.goto('https://mcn-publishing.test/');await page.addStyleTag({content:['replica.css','source-operations.css','visual-theme.css','observatory.css'].map(name=>readFileSync(site+'app/'+name,'utf8')).join('\n')});await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.getByRole('button',{name:'重新读取发片索引',exact:true}).click();
 await page.getByRole('heading',{name:'已收录发片记录 · 43 条',exact:true}).waitFor();
 const panel=page.locator('[aria-label="所选发布日作品"]');
 await t.test('unrecorded dates stay missing and undated works have a direct verified entry',async()=>{
  assert.match(await page.locator('[aria-label="发布记录完整情况"]').textContent(),/有记录 2 天 · 无记录 46 天/);
  await page.getByRole('button',{name:'查看未记录日期的作品 · 1 条'}).click();
  await panel.getByRole('link',{name:'A未日期作品'}).waitFor();assert.match(await panel.textContent(),/未记录发布日期/);assert.equal(await panel.locator('tbody tr').count(),1);
 });
 await t.test('same-edition object refresh keeps details, pagination and avoids refetching index',async()=>{
  await page.getByRole('combobox',{name:'选择发布日'}).selectOption('2026-10-28');await page.getByRole('button',{name:'查看当天作品 →',exact:true}).click();await panel.getByRole('link',{name:'A作品1',exact:true}).waitFor();
  await panel.getByRole('button',{name:'下一页',exact:true}).click();await panel.getByRole('link',{name:'A作品21',exact:true}).waitFor();assert.match(await panel.textContent(),/第 2 \/ 3 页/);
  const count=reads.length,before=await page.evaluate(()=>window.renders);await page.evaluate(m=>window.fixture.setManifest(m),structuredClone(A.manifest));await page.waitForFunction(n=>window.renders>n,before);
  assert.equal(reads.length,count);assert.equal(await panel.getByRole('link',{name:'A作品21',exact:true}).count(),1);
 });
 await t.test('new editions retain the chosen date and page, then clamp pages when rows shrink',async()=>{
  await page.evaluate(m=>window.fixture.setManifest(m),B.manifest);await panel.getByRole('link',{name:'B作品21',exact:true}).waitFor();assert.match(await panel.textContent(),/第 2 \/ 2 页/);assert.equal(await panel.locator('tbody tr').count(),5);
  assert.equal(await page.getByRole('combobox',{name:'选择发布日'}).inputValue(),'2026-10-28');assert.equal(await panel.getByRole('link',{name:'A作品21',exact:true}).count(),0);
  await page.evaluate(m=>window.fixture.setManifest(m),C.manifest);await panel.getByRole('link',{name:'C作品1',exact:true}).waitFor();assert.match(await panel.textContent(),/第 1 \/ 1 页/);assert.equal(await panel.locator('tbody tr').count(),5);
  assert.equal(await panel.getByRole('button',{name:'下一页',exact:true}).isDisabled(),true);assert.deepEqual(errors,[]);
 });
 await t.test('category changes filter the chart and verified rows without refetching, survive refresh and keep zero distinct from missing',async()=>{
  const track=page.getByRole('combobox',{name:'每日发片内容分类'}),before=reads.length;
  await track.selectOption('ai-remix');
  await page.getByRole('heading',{name:'即梦二创 · 已收录发片记录 · 1 条',exact:true}).waitFor();
  assert.equal(await panel.locator('tbody tr').count(),1);
  assert.equal(await panel.getByRole('link',{name:'C作品1',exact:true}).count(),1);
  assert.match(await panel.textContent(),/切片激励 \/ 即梦二创/);
  await track.selectOption('original');await panel.getByRole('link',{name:'C作品2',exact:true}).waitFor();
  assert.equal(await panel.locator('tbody tr').count(),1);
  await track.selectOption('unclassified');await panel.getByRole('link',{name:'C作品3',exact:true}).waitFor();
  assert.equal(await panel.locator('tbody tr').count(),1);
  assert.equal(reads.length,before,'filtering reuses already verified day rows');
  await track.selectOption('ai-remix');await page.evaluate(m=>window.fixture.setManifest(m),D.manifest);
  await panel.getByRole('link',{name:'D作品1',exact:true}).waitFor();assert.equal(await track.inputValue(),'ai-remix');
  await page.getByRole('combobox',{name:'选择发布日'}).selectOption('2026-10-29');
  await page.getByRole('button',{name:'查看当天作品 →',exact:true}).click();
  await panel.getByText('当前日期没有符合此分类的已收录作品。',{exact:true}).waitFor();
  assert.match(await panel.locator('h3').textContent(),/0 条已入库/);
  assert.equal(await panel.locator('tbody tr').count(),0);
  await track.selectOption('all');await panel.getByRole('link',{name:'D今日作品',exact:true}).waitFor();
 });
 await t.test('a failed work read shows an actionable retry and never a false empty table',async()=>{
  failDayPart=true;await page.getByRole('button',{name:'查看未记录日期的作品 · 1 条'}).click();
  await panel.getByRole('button',{name:'重新读取所选作品',exact:true}).waitFor();assert.equal(await panel.locator('tbody').count(),0);
  await panel.getByRole('button',{name:'重新读取所选作品',exact:true}).click();await panel.getByRole('link',{name:'D未日期作品'}).waitFor();assert.equal(await panel.locator('tbody tr').count(),1);assert.deepEqual(errors,[]);
 });
 await t.test('actual component styles wrap controls on phones and keep missing dates keyboard-accessible',async()=>{
  for(const width of [390,320]){
   await page.setViewportSize({width,height:844});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
   const select=page.getByRole('combobox',{name:'选择发布日'});await select.selectOption('2026-09-12');
   assert.equal(await page.getByRole('button',{name:'查看当天作品 →',exact:true}).isDisabled(),true);
   const bar=page.locator('.source-ops-bar-column[aria-pressed="true"]');await bar.focus();await page.keyboard.press('End');
   assert.equal(await select.inputValue(),'2026-10-29');
   assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-pressed')),'true');
  }
  assert.deepEqual(errors,[]);
 });
 }finally{await context.close();}}finally{await browser.close();}
});

test('merged metric cards, publication dates, category filters, sorting and page totals agree in the actual component',async()=>{
 const E=edition('2026-10-30T01:00:00.000Z',23,'M',true);
 const bundle=await build({stdin:{contents:`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{ContinuousPublishing}from'./components/continuous-publishing';function Harness(){const[range,setRange]=useState({startDate:'2026-10-28',endDate:'2026-10-28'});window.setRange=setRange;return <ContinuousPublishing manifest={${JSON.stringify(E.manifest)}} {...range}/>;}createRoot(document.getElementById('root')).render(<Harness/>);`,resolveDir:site,sourcefile:'publishing-metrics-fixture.tsx',loader:'tsx'},absWorkingDir:site,bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',tsconfig:site+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'}});
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{const page=await browser.newPage(),errors=[],reads=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!=='https://mcn-publishing.test')return route.abort();if(u.pathname==='/')return route.fulfill({body:'<!doctype html><meta charset="utf-8"><div id="root"></div>',contentType:'text/html'});const part=u.searchParams.get('part'),f=E.files.find(f=>f.meta.path===part);if(!f)return route.fulfill({status:404});reads.push(part);return route.fulfill({body:f.content,contentType:'application/json',headers:{'X-Data-SHA256':f.meta.sha256,'X-Data-Cutoff':E.manifest.asOf}});});
  await page.goto('https://mcn-publishing.test/');await page.addScriptTag({content:bundle.outputFiles[0].text});
  await page.getByRole('heading',{name:'已收录发片记录 · 23 条',exact:true}).waitFor();
  const cards=page.getByRole('region',{name:'合并作品指标概览'}),metric=k=>cards.locator(`[data-work-metric="${k}"] strong`);
  assert.equal(await metric('likes').textContent(),'273');assert.equal(await metric('plays').textContent(),'2,730');
  assert.match(await cards.locator('[data-work-metric="likes"]').textContent(),/22 \/ 23 条有值 · 1 条未取得/);
  assert.equal(reads.length,1,'overview reads only its small index, not every account/work shard');
  const dates=page.getByRole('combobox',{name:'选择发布日'});assert.deepEqual(await dates.locator('option').evaluateAll(o=>o.map(e=>e.value)),['2026-10-28']);
  await page.getByRole('button',{name:'查看当天作品 →',exact:true}).click();const panel=page.getByRole('region',{name:'所选发布日作品'});await panel.getByRole('link',{name:'M作品1',exact:true}).waitFor();
  await panel.getByRole('button',{name:'累计点赞',exact:true}).click();assert.match(await panel.locator('tbody tr').first().textContent(),/M作品23/);
  await panel.getByRole('button',{name:'累计点赞 ↓',exact:true}).click();assert.match(await panel.locator('tbody tr').first().textContent(),/M作品1/);
  assert.equal(await panel.locator('tbody tr').first().locator('td').nth(3).textContent(),'0');
  await panel.getByRole('button',{name:'下一页',exact:true}).click();assert.match(await panel.locator('tbody tr').last().textContent(),/M作品2/);assert.equal(await panel.locator('tbody tr').last().locator('td').nth(3).textContent(),'—');
  assert.equal(await metric('likes').textContent(),'273','paging does not reduce cohort totals');
  await page.getByRole('combobox',{name:'每日发片内容分类'}).selectOption('ai-remix');await page.getByRole('heading',{name:'即梦二创 · 已收录发片记录 · 1 条',exact:true}).waitFor();assert.equal(await metric('likes').textContent(),'0');assert.equal(await panel.locator('tbody tr').count(),1);
  const count=reads.length;await page.evaluate(()=>window.setRange({startDate:'2026-10-29',endDate:'2026-10-29'}));
  await page.getByRole('heading',{name:'即梦二创 · 已收录发片记录 · 0 条',exact:true}).waitFor();assert.equal(await metric('likes').textContent(),'—');assert.equal(await page.getByRole('region',{name:'所选发布日作品'}).count(),0);
  assert.equal(reads.length,count,'date/category aggregation uses already verified index');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
