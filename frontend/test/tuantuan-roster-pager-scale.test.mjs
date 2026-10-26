import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const site=fileURLToPath(new URL('../',import.meta.url));
const main=process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../douyin-monitor-workbench/',import.meta.url));
const {chromium}=createRequire(main+'package.json')('playwright-core');

// Exercise the actual roster component with the published-sized directory, without
// fetching a production dataset or running a collector.
const fixture=`import React from 'react';import {createRoot} from 'react-dom/client';import {TuantuanRosterTable} from './components/tuantuan-roster';
const rows=Array.from({length:4782},(_,index)=>({key:'fixture-'+index,source:{name:'合成作者'+String(index+1).padStart(4,'0'),douyinId:'id-'+index,posts:1,slicePosts:1,plays:index,likes:index*2,sourceTitles:['合成总表']},accounts:[]}));
const roster={rows,counts:{all:4782,monitoredEnabled:0,monitoredPaused:0,source:4782,baseSource:4782,supplementSource:0,reconciledAliases:0,monitored:0,linkedTargets:0}};
createRoot(document.getElementById('root')).render(<TuantuanRosterTable roster={roster} classification="all" addressMode onOpenAccount={()=>{}} onOpenSourceWorks={()=>{}}/>);`;

test('4782-author roster retains direct page access without duplicated 160-option menus',{timeout:45000},async()=>{
 const bundle=await build({stdin:{contents:fixture,resolveDir:site,sourcefile:'roster-pager-scale-fixture.tsx',loader:'tsx'},absWorkingDir:site,bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',tsconfig:site+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'}});
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});try{
  await context.addInitScript(()=>{window.exports=[];URL.createObjectURL=blob=>{window.exports.push(blob);return 'blob:fixture'};URL.revokeObjectURL=()=>{};HTMLAnchorElement.prototype.click=function(){};});
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/fixture.js"></script>'});if(url.pathname==='/fixture.js')return route.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text});return route.abort();});
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(6000);
  await page.goto('http://127.0.0.1:49119/?rosterPanel=authors&rosterPage=80#accounts');
  const top=page.getByRole('navigation',{name:'团团名册上方分页'}),bottom=page.getByRole('navigation',{name:'团团名册下方分页'});
  await top.getByText(/第 80\/160 页/).waitFor();
  assert.equal(await page.locator('.tuantuan-roster-table tbody tr').count(),30);
  assert.equal(await top.locator('option').count()+await bottom.locator('option').count(),0,'two full 160-option selectors are expensive and unnecessary for direct entry');
  assert.equal(await page.getByLabel('上方页码').inputValue(),'80');
  await page.getByRole('button',{name:'导出当前筛选',exact:true}).click();
  const csv=await page.evaluate(()=>window.exports.at(-1).text());
  assert.equal(csv.trim().split(/\r?\n/).length,4783,'pagination must not truncate the full filtered export');

  await page.getByLabel('上方页码').fill('160');
  assert.equal(new URL(page.url()).searchParams.get('rosterPage'),'80','typing a draft must not navigate before submission');
  await page.getByLabel('上方页码').press('Enter');
  await top.getByText(/第 160\/160 页/).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('rosterPage'),'160');
  assert.equal(await page.getByLabel('下方页码').inputValue(),'160');
  assert.equal(await page.locator('.tuantuan-roster-table tbody tr').count(),12);

  for(const value of ['','0','161','abc','2.3']){
   await page.getByLabel('上方页码').fill(value);
   await top.getByRole('button',{name:'跳转到该页'}).click();
   assert.match(await top.getByRole('alert').innerText(),/请输入 1–160 的页码/);
   assert.equal(new URL(page.url()).searchParams.get('rosterPage'),'160');
  }
  await page.getByLabel('下方页码').fill('1');
  await bottom.getByRole('button',{name:'跳转到该页'}).click();
  await top.getByText(/第 1\/160 页/).waitFor();
  assert.equal(new URL(page.url()).searchParams.has('rosterPage'),false);
  assert.equal(await page.getByLabel('上方页码').inputValue(),'1');
  await page.getByLabel('上方页码').fill('100');
  await page.getByLabel('团团名册排序指标').selectOption('name');
  await page.waitForFunction(()=>document.querySelector('input[aria-label="上方页码"]')?.value==='1');
  assert.equal(new URL(page.url()).searchParams.has('rosterPage'),false,'sorting on page one resets the draft even if the total page count is unchanged');
  assert.deepEqual(errors,[]);
 }finally{await context.close();}}finally{await browser.close();}
});
