import{readFileSync}from'node:fs';import test from'node:test';import assert from'node:assert/strict';import{createRequire}from'node:module';import{fileURLToPath}from'node:url';import{resolve}from'node:path';import{build}from'esbuild';
const site=fileURLToPath(new URL('../',import.meta.url)),main=process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../douyin-monitor-workbench/',import.meta.url));const{chromium}=createRequire(resolve(main,'package.json'))('playwright-core');
test('actual collection console distinguishes homepage coverage, refused works and cooldown without issuing collection',async()=>{
 const bundle=await build({stdin:{contents:`import React from'react';import{createRoot}from'react-dom/client';import{CollectionConsole}from'./components/collection-console';createRoot(document.getElementById('root')).render(<CollectionConsole/>);`,resolveDir:site,sourcefile:'collection-console-fixture.tsx',loader:'tsx'},absWorkingDir:site,bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',tsconfig:site+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'}});
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{const context=await browser.newContext({viewport:{width:1100,height:850},reducedMotion:'reduce'});try{const page=await context.newPage(),errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));
 const status={online:true,canControl:false,status:{observedAt:'2026-10-29T08:50:00Z',accounts:4081,topics:4,queue:{pending:5,rejected:2},rolling:{total:4085,updated:4076,profiles:4072,notUpdated:9,worksComplete:0,worksLimited:692,workIssues:4058,reasons:[{code:'transport-cooldown',count:3969},{code:'blocked',count:89},{code:'UNTRUSTED_RAW_REASON',count:1}]},run:{id:26125,kind:'scheduled',status:'success',total:1,processed:1,success:1,failed:0,warnings:1}}};
 await page.route('**/*',async route=>{const req=route.request(),u=new URL(req.url());if(u.origin!=='https://mcn-console.test')return route.abort();if(req.method()!=='GET')writes.push({url:u.pathname,method:req.method()});if(u.pathname==='/api/collection')return route.fulfill({contentType:'application/json',body:JSON.stringify(status)});return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><div class="workspace"><main class="content"><div id="root"></div></main></div>'});});
 await page.goto('https://mcn-console.test/');await page.addStyleTag({content:['replica.css','source-operations.css','visual-theme.css','collection-console.css','observatory.css'].map(n=>readFileSync(site+'app/'+n,'utf8')).join('\n')});await page.addScriptTag({content:bundle.outputFiles[0].text});
 const panel=page.getByRole('region',{name:'脚本采集进度'});await panel.getByText('脚本在线 · 等待下一批',{exact:true}).waitFor();assert.match(await panel.textContent(),/作品完整\s*0/);assert.match(await panel.textContent(),/作品部分取得\s*692/);
 assert.match(await page.getByRole('progressbar').getAttribute('aria-label'),/不代表作品采集完整/);assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'),String(4076/4085*100));
 const counts=page.getByRole('group',{name:'近24小时采样明细'});assert.equal(await counts.isVisible(),false);
 await page.locator('.collection-more summary').focus();await page.keyboard.press('Enter');assert.equal(await counts.isVisible(),true);const detail=await page.locator('.collection-more').textContent();assert.match(detail,/4,058 个作品采样提示/);assert.match(detail,/接口冷却中，作品请求暂缓（非本次请求失败） 3,969 个/);assert.match(detail,/作品接口拒绝访问（401\/403） 89 个/);assert.match(detail,/作品采集原因待核验 1 个/);assert.equal(detail.includes('UNTRUSTED_RAW_REASON'),false);
 await page.getByRole('button',{name:'全量采集 ↗',exact:true}).click();await page.getByRole('region',{name:'开启采集管理'}).waitFor();assert.deepEqual(writes,[],'public visitors never start a collector');
 for(const width of [390,320]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);}
 assert.deepEqual(errors,[]);
 }finally{await context.close();}}finally{await browser.close();}
});

test('daily profile coverage stays visible, updates from script receipts, rejects stale days and fits phones',{timeout:30000},async()=>{
 const bundle=await build({stdin:{contents:`import React from'react';import{createRoot}from'react-dom/client';import{CollectionConsole}from'./components/collection-console';createRoot(document.getElementById('root')).render(<CollectionConsole/>);`,resolveDir:site,sourcefile:'daily-console-fixture.tsx',loader:'tsx'},absWorkingDir:site,bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',tsconfig:site+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'}});
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{
  const page=await browser.newPage({viewport:{width:1100,height:850},reducedMotion:'reduce'}),errors=[],writes=[];
  page.on('pageerror',e=>errors.push(e.message));
  const metric=(observed,comparable)=>({observed,comparable,missingBaseline:observed-comparable,conflicting:0});
  const status={online:true,canControl:false,status:{runtimeAI:false,observedAt:'2026-10-30T20:00:00.000Z',rolling:{total:10,updated:10,profiles:10,notUpdated:0,worksComplete:0,worksLimited:0,workIssues:10,platforms:[{platform:'douyin',accounts:10,profiles:10,worksComplete:0,worksLimited:0,workIssues:10}]},dailyProfiles:{version:1,basis:'accepted-profile-day-ends',date:'2026-10-31',since:'2026-10-30T16:00:00.000Z',previousDate:'2026-10-30',asOf:'2026-10-30T20:00:00.000Z',platforms:[{platform:'douyin',accounts:10,followers:metric(2,1),totalLikes:metric(1,0)}]}}};
  await page.route('**/*',route=>{
   const req=route.request(),u=new URL(req.url());if(u.origin!=='https://daily-console.test')return route.abort();
   if(req.method()!=='GET')writes.push(req.method());
   return route.fulfill(u.pathname==='/api/collection'?{contentType:'application/json',body:JSON.stringify(status)}:{contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><div class="workspace"><main class="content"><div id="root"></div></main></div>'});
  });
  await page.goto('https://daily-console.test/');await page.addStyleTag({content:['replica.css','source-operations.css','visual-theme.css','observatory.css','collection-console.css'].map(n=>readFileSync(site+'app/'+n,'utf8')).join('\n')});
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  const daily=page.getByLabel('当天粉丝和总获赞采样覆盖');await daily.waitFor();
  assert.equal(await daily.isVisible(),true);assert.match(await daily.innerText(),/粉丝 2\/10（1 可比）.*总获赞 1\/10（0 可比）/);
  assert.match(await page.locator('.collection-sampling-notice').last().innerText(),/作品点赞采样状态尚未上报/);
  for(const width of [390,320]){
   await page.setViewportSize({width,height:844});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
   assert.equal(await daily.isVisible(),true);
   const height=await page.locator('.collection-console').evaluate(el=>el.getBoundingClientRect().height);
   assert.ok(height<=(width===390?310:350),`The closed collection panel at ${width}px occupies ${height}px and hides the management content`);
  }
  status.status.dailyProfiles.platforms[0].followers=metric(3,2);
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await page.getByText(/粉丝 3\/10（2 可比）/).waitFor();
  status.status.dailyProfiles.date='2026-10-30';
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await page.locator('.collection-sampling-notice').getByText('当天粉丝与总获赞覆盖尚未上报',{exact:true}).waitFor();assert.equal(await daily.count(),0);
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
 }finally{await browser.close();}
});
