import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {readFileSync,mkdirSync} from 'node:fs';
import {build} from 'esbuild';
const site=fileURLToPath(new URL('../',import.meta.url));
const main=process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../douyin-monitor-workbench/',import.meta.url));
const {chromium}=createRequire(resolve(main,'package.json'))('playwright-core');
const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {CollectionConsole} from './components/collection-console';createRoot(document.getElementById('root')).render(<CollectionConsole/>);`,resolveDir:site,sourcefile:'collection-client-fixture.tsx',loader:'tsx'},absWorkingDir:site,bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',tsconfig:site+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'}});
const metric=(observed,comparable)=>({observed,comparable,missingBaseline:observed-comparable,conflicting:0});
function status(){return {online:true,canControl:true,command:null,status:{observedAt:'2026-11-03T10:32:03.150Z',rolling:{total:4085,updated:4084,profiles:4080,notUpdated:1,worksComplete:0,worksLimited:1,workIssues:0,platforms:[{platform:'douyin',accounts:10,profiles:10,worksComplete:0,worksLimited:1,workIssues:0},{platform:'bilibili',accounts:1,profiles:1,worksComplete:0,worksLimited:0,workIssues:0}]},dailyProfiles:{version:1,basis:'accepted-profile-day-ends',date:'2026-11-03',since:'2026-11-02T16:00:00.000Z',previousDate:'2026-11-02',asOf:'2026-11-03T10:32:03.150Z',platforms:[{platform:'douyin',accounts:10,followers:metric(10,10),totalLikes:metric(10,10)}]},dailyWorkLikes:{date:'2026-11-03',since:'2026-11-02T16:00:00.000Z',asOf:'2026-11-03T10:32:03.150Z',basis:'stored-work-like-observations',platforms:[{platform:'douyin',storedWorks:100,observedWorks:4,observedAccounts:1},{platform:'bilibili',storedWorks:20,observedWorks:0,observedAccounts:0}],comparability:{version:1,previousDate:'2026-11-02',platforms:[{platform:'douyin',knownTodayWorks:4,comparableWorks:4,missingBaselineWorks:0,conflictingWorks:0},{platform:'bilibili',knownTodayWorks:0,comparableWorks:0,missingBaselineWorks:0,conflictingWorks:0}]}}}};}
async function fixture(handle,run){
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{
  const page=await browser.newPage({viewport:{width:1100,height:850},reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.origin!=='https://collection-client.test')return route.abort();
   if(url.pathname==='/api/collection')return handle(route,request);
   return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><div class="workspace"><main class="content"><div id="root"></div></main></div>'});
  });
  await page.goto('https://collection-client.test/');
  await page.addStyleTag({content:['replica.css','source-operations.css','visual-theme.css','collection-console.css','observatory.css'].map(name=>readFileSync(site+'app/'+name,'utf8')).join('\n')});
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  await run(page);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
}
const reply=(route,value,code=200)=>route.fulfill({status:code,contentType:'application/json',body:JSON.stringify(value)});
const tick=page=>page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));

test('hung progress read times out, recovers on next poll, and never triggers collection',{timeout:30000},async()=>{
 let gets=0,writes=0;
 await fixture((route,request)=>{if(request.method()!=='GET'){writes++;return reply(route,{error:'unexpected'},400);}gets++;if(gets===1)return;return reply(route,status());},async page=>{
  await page.getByText('进度连接暂时中断，保留上次状态',{exact:true}).waitFor({timeout:16000});
  await tick(page);await page.getByText('脚本在线 · 等待下一批',{exact:true}).waitFor();
  assert.equal(gets,2);assert.equal(writes,0);
 });
});
test('manual command replaces an older poll and mixed-platform observations remain visible on phones',{timeout:30000},async()=>{
 let gets=0,stale,commandId,pollEntered;const writes=[];const entered=new Promise(resolve=>{pollEntered=resolve;});
 await fixture((route,request)=>{
  if(request.method()==='POST'){writes.push(request.postDataJSON());commandId=writes[0].id;return reply(route,{command:{id:commandId,status:'queued'},reused:false},202);}
  gets++;if(gets===2){stale=route;pollEntered();return;}
  const value=status();if(gets>=3){value.canControl=false;value.command={id:commandId,status:'completed',createdAt:'2026-11-03T10:33:00Z'};}
  return reply(route,value);
 },async page=>{
  await page.getByText('脚本在线 · 等待下一批',{exact:true}).waitFor();
  assert.equal(await page.locator('.collection-counter b').innerText(),'99.9%');
  const notice=page.locator('.collection-sampling-notice[data-state="partial"]');
  assert.match(await notice.innerText(),/抖音 4 条/);assert.match(await notice.innerText(),/B站尚无作品点赞观测/);
  await tick(page);await entered;
  await page.getByRole('button',{name:'全量采集 ↗',exact:true}).click();
  await page.getByText('全量指令已送达，采集电脑将在下一次通信时接收（通常 15 秒内）。',{exact:true}).waitFor();
  await page.locator('.collection-more summary').click();await page.getByText(/最近指令：处理结束/).waitFor();
  assert.ok(stale);await reply(stale,status()).catch(()=>{});
  await page.getByRole('button',{name:'全量采集 ↗',exact:true}).click();
  await page.getByRole('region',{name:'开启采集管理'}).waitFor();assert.equal(writes.length,1);
  for(const width of [1100,390,320]){
   await page.setViewportSize({width,height:850});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
   assert.equal(await notice.isVisible(),true);
   if(process.env.MCN_QA_DIR){mkdirSync(process.env.MCN_QA_DIR,{recursive:true});await page.screenshot({path:resolve(process.env.MCN_QA_DIR,`collection-${width}.png`),fullPage:true});}
  }
 });
});
test('logout reports HTTP rejection and changes management state only after success',{timeout:30000},async()=>{
 let attempts=0,loggedOut=false;
 await fixture((route,request)=>{
  if(request.method()==='POST'){attempts++;if(attempts===1)return reply(route,{error:'退出未完成，请重试'},503);loggedOut=true;return reply(route,{ok:true});}
  const value=status();value.canControl=!loggedOut;return reply(route,value);
 },async page=>{
  await page.getByText('脚本在线 · 等待下一批',{exact:true}).waitFor();await page.locator('.collection-more summary').click();
  const logout=page.getByRole('button',{name:'退出本浏览器的采集管理'});await logout.click();
  await page.getByText('退出未完成，请重试',{exact:true}).waitFor();assert.equal(await logout.isVisible(),true);
  await logout.click();await page.getByText('已退出本浏览器的采集管理。',{exact:true}).waitFor();await logout.waitFor({state:'detached'});assert.equal(attempts,2);
 });
});
