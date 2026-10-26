// Browser interaction regression for the real GrowthPanel. Data is synthetic;
// no production API, collector, or remote service is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const site=fileURLToPath(new URL('../',import.meta.url));
const backend=process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../douyin-monitor-workbench/',import.meta.url));
const {chromium}=createRequire(backend+'package.json')('playwright-core');
const fixture=`import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {GrowthPanel} from './components/growth-panel';
const accounts=[{id:1,label:'测试作者'}];
const sample=(date,followers)=>({targetId:1,date,capturedAt:date+'T00:00:00.000Z',followers,likes:followers,posts:followers});
const points=[sample('2026-09-12',10),sample('2026-09-13',12),sample('2026-09-20',20),sample('2026-09-21',23)];
function Fixture(){const [comparison,setComparison]=useState({compare:false,otherStart:'',otherEnd:''});
 return <><output data-testid="applied">{JSON.stringify(comparison)}</output><GrowthPanel accounts={accounts} points={points} manifest={{asOf:'2026-09-22T00:00:00.000Z'}} start="2026-09-12" end="2026-09-13" comparison={comparison} onComparison={setComparison}/></>;}
createRoot(document.getElementById('root')).render(<Fixture/>);`;
const bundle=await build({
 stdin:{contents:fixture,resolveDir:site,sourcefile:'growth-comparison-draft-fixture.tsx',loader:'tsx'},
 absWorkingDir:site,bundle:true,write:false,outfile:'growth-comparison-draft-fixture.js',format:'iife',platform:'browser',jsx:'automatic',tsconfig:site+'tsconfig.json',
 define:{'process.env.NODE_ENV':'"test"'},
 plugins:[{name:'chart-shell',setup(build){
  build.onResolve({filter:/^next\/dynamic$/},()=>({path:'dynamic-stub',namespace:'fixture'}));
  build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export default function dynamic(){return function Chart(){return null}}',loader:'js'}));
 }}],
});
const script=bundle.outputFiles.find(file=>file.path.endsWith('.js')).text;

test('comparison dates remain a draft until applied; invalid draft never hides the current curve',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:820},reducedMotion:'reduce'});
  const requests=[],errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>{
   requests.push({method:route.request().method(),pathname:new URL(route.request().url()).pathname});
   if(route.request().method()==='GET'&&new URL(route.request().url()).pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><div id="root"></div></html>'});
   return route.abort();
  });
  await page.goto('http://127.0.0.1:49131/');
  await page.addScriptTag({content:script});
  const applied=()=>page.getByTestId('applied').innerText();
  const readout=()=>page.locator('.trend-reading').innerText();
  await page.getByRole('button',{name:'比较另一段日期'}).waitFor();
  assert.match(await readout(),/\+2/);
  await page.getByRole('button',{name:'比较另一段日期'}).click();
  assert.equal(await applied(),JSON.stringify({compare:false,otherStart:'',otherEnd:''}));
  assert.match(await readout(),/\+2/,'opening comparison must preserve current reading');
  const apply=page.getByRole('button',{name:'应用比较'});
  assert.equal(await apply.isDisabled(),true);
  await page.getByLabel('比较起点').fill('2026-09-20');
  assert.equal(await apply.isDisabled(),true);
  assert.match(await readout(),/\+2/,'partial comparison must not hide the current reading');
  await page.getByLabel('比较终点').fill('2026-09-21');
  assert.equal(await apply.isEnabled(),true);
  assert.equal(await applied(),JSON.stringify({compare:false,otherStart:'',otherEnd:''}));
  await apply.click();
  assert.equal(await applied(),JSON.stringify({compare:true,otherStart:'2026-09-20',otherEnd:'2026-09-21'}));
  assert.match(await readout(),/\+2/);assert.match(await readout(),/\+3/);
  await page.getByLabel('比较终点').fill('2026-09-01');
  assert.equal(await page.getByRole('button',{name:'应用比较'}).isDisabled(),true);
  assert.equal(await applied(),JSON.stringify({compare:true,otherStart:'2026-09-20',otherEnd:'2026-09-21'}));
  assert.match(await readout(),/\+3/,'invalid modification keeps the applied comparison');
  await page.getByRole('button',{name:'取消修改'}).click();
  assert.equal(await page.getByLabel('比较终点').inputValue(),'2026-09-21');
  await page.getByRole('button',{name:'关闭区间对比'}).click();
  assert.equal(await applied(),JSON.stringify({compare:false,otherStart:'',otherEnd:''}));
  assert.match(await readout(),/\+2/);
  assert.deepEqual(errors,[]);
  assert.deepEqual(requests,[{method:'GET',pathname:'/'}]);
 }finally{await browser.close();}
});
