import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const site=fileURLToPath(new URL('../',import.meta.url));
const backend=process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../douyin-monitor-workbench/',import.meta.url));
const {chromium}=createRequire(backend+'package.json')('playwright-core');
const fixture=`import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {OverviewAccountPreview} from './components/overview-account-preview';
import {SourceOperations} from './components/source-operations';
import source from './public/creator-source/index.json';
import insights from './public/creator-source/insights.json';
function Fixture(){const [opened,setOpened]=useState(false);const accounts=[
 {id:1,enabled:true,coverage:{version:1,profileObservedAt:'2026-10-23T01:30:00.000Z',works:{status:'complete',attemptedAt:'2026-10-23T01:00:00.000Z',observedAt:'2026-10-23T01:00:00.000Z'}}},
 {id:2,enabled:true,coverage:{version:1,profileObservedAt:'2026-10-23T00:00:00.000Z',works:{status:'limited',attemptedAt:'2026-10-23T00:00:00.000Z',observedAt:'2026-10-23T00:00:00.000Z'}}},
 {id:3,enabled:true,coverage:{version:1,profileObservedAt:null,works:{status:'unavailable',attemptedAt:'2026-10-23T01:00:00.000Z',observedAt:null}}}
 ];return <div className="workspace"><main><div className="content">
 <output data-testid="opened">{String(opened)}</output>
 <SourceOperations source={source} insights={insights.items[0]} foundation={null} sourceRosterCount={null} error="" onInspect={()=>{}} onNavigateAccounts={()=>{}} accountPreview={<OverviewAccountPreview metrics={{followers:{delta:123,comparableCount:2},likes:{delta:null,comparableCount:0},posts:{delta:-2}}} accountCount={3} accounts={accounts} asOf="2026-10-23T02:00:00.000Z" rosterTotal={5068} scopeLabel="全部矩阵 · 团团 · 全部分类" start="2026-09-12" end="2026-10-23" ready={true} onOpenAccounts={()=>setOpened(true)} trendPreview={metric=><output data-testid="metric-preview">{metric}</output>} trend={<div data-testid="trend">真实逐日曲线</div>}/>}/>
 </div></main></div>;}
createRoot(document.getElementById('root')).render(<Fixture/>);`;
const bundle=await build({stdin:{contents:fixture,resolveDir:site,sourcefile:'overview-account-preview-fixture.tsx',loader:'tsx'},absWorkingDir:site,bundle:true,write:false,outfile:'overview-account-preview-fixture.js',format:'iife',platform:'browser',jsx:'automatic',tsconfig:site+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'}});
const script=bundle.outputFiles.find(file=>file.path.endsWith('.js')).text;

test('overview shows only verified account deltas and mounts the trend on demand',async()=>{
 const pageSource=readFileSync(new URL('../app/page.tsx',import.meta.url),'utf8');
 assert.match(pageSource,/tab==='overview'&&<.*<SourceOperations[^\n]*accountPreview=\{data&&\(overviewUsesFullRoster\?<AllAuthorOverview/,'full author overview must be the primary view before sampled-only details');
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{
  const page=await browser.newPage({viewport:{width:390,height:820},reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>route.request().url()==='http://127.0.0.1:49132/'?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><div id="root"></div></html>'}):route.abort());
  await page.goto('http://127.0.0.1:49132/');
  await page.addStyleTag({content:readFileSync(site+'app/source-operations.css','utf8')});
  await page.addStyleTag({content:readFileSync(site+'app/visual-theme.css','utf8')});
  await page.addScriptTag({content:script});
  const panel=page.getByRole('region',{name:'有每日采样账号的变化'});
  await panel.getByRole('heading',{name:'有每日采样账号的变化'}).waitFor();
  assert.match(await panel.innerText(),/矩阵持续更新/);
  assert.match(await panel.innerText(),/已保存的每日采样/);
  assert.match(await panel.innerText(),/最近有效主页采样：2026\/10\/23 09:30:00（北京时间）/);
  assert.match(await panel.innerText(),/公开数据截至：2026\/10\/23 10:00:00（北京时间）/);
  assert.match(await panel.innerText(),/主页三指标 2\/3；作品列表完整核验 1\/3；作品列表有限观察 1\/3/);
  assert.match(await panel.innerText(),/团团作者名册 5,068 位（含仅表格作者）/);
  assert.match(await panel.innerText(),/当前筛选 3 个启用监控账号；粉丝起止可比 2\/3 个/);
  assert.equal(await page.locator('.source-ops-archive').evaluate(node=>node.open),false);
  assert.match(await page.locator('.source-ops-archive > summary').innerText(),/原表作品日期至 2026-10-12，不是监控截止/);
  assert.match(await panel.innerText(),/当前账号变化范围\s*全部矩阵 · 团团 · 全部分类/);
  assert.match(await panel.innerText(),/粉丝净变化 · 仅限可比账号\s*\+123/);
  assert.match(await panel.innerText(),/2\/3 个账号可比（66.7%）/);
  assert.match(await panel.innerText(),/主页获赞净变化 · 仅限可比账号\s*—/);
  assert.match(await panel.innerText(),/作品存量净变化 · 仅限可比账号\s*-2/);
  assert.match(await panel.innerText(),/两端可比账号数待核/,'missing comparable count must not be rendered as 0/3');
  await panel.getByText('口径与缺测说明').click();
  assert.match(await panel.innerText(),/同一作者与作品保留一条记录；本区比较有起止快照账号的期间变化/);
  assert.equal(await page.getByTestId('metric-preview').textContent(),'followers');
  const likes=panel.getByRole('button',{name:/主页获赞净变化/});
  await likes.click();
  assert.equal(await likes.getAttribute('aria-pressed'),'true');
  assert.equal(await page.getByTestId('metric-preview').textContent(),'likes');
  const posts=panel.getByRole('button',{name:/作品存量净变化/});
  await posts.focus();
  await posts.press('Enter');
  assert.equal(await posts.getAttribute('aria-pressed'),'true');
  assert.equal(await likes.getAttribute('aria-pressed'),'false');
  assert.equal(await page.getByTestId('metric-preview').textContent(),'posts');
  assert.equal(await page.getByTestId('trend').count(),0,'closed trend should not mount a heavy chart');
  await panel.getByText('展开每日曲线与区间对比').click();
  await page.getByTestId('trend').waitFor();
  await panel.getByRole('button',{name:'查看账号和已保存作品 →'}).click();
  assert.equal(await page.getByTestId('opened').innerText(),'true');
  if(process.env.MCN_PREVIEW_SCREENSHOT)await page.screenshot({path:process.env.MCN_PREVIEW_SCREENSHOT,fullPage:true});
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
