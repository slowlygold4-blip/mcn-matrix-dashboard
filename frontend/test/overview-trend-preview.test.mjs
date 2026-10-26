import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {buildOverviewTrendPreview,overviewTrendGeometry} from '../lib/overview-trend-preview.mjs';

const account=id=>({id,enabled:true});
const date=day=>new Date(Date.UTC(2026,8,12+day)).toISOString().slice(0,10);
const point=(id,day,followers)=>({targetId:id,date:date(day),capturedAt:date(day)+'T02:00:00.000Z',followers,likes:null,posts:null});

test('trailing 14-day preview keeps the selected start as baseline and its fixed endpoint cohort',()=>{
 const accounts=[account(1),account(2)];
 const points=[point(1,0,100),point(2,0,200),point(1,1,110),point(2,1,190),point(1,2,105),point(2,2,190),point(1,15,120),point(2,15,210)];
 const result=buildOverviewTrendPreview(accounts,points,{start:date(0),end:date(15)});
 assert.equal(result.state,'ready');
 assert.equal(result.baselineDate,date(0));
 assert.equal(result.firstVisibleDate,date(2));
 assert.equal(result.lastVisibleDate,date(15));
 assert.equal(result.cohortCount,2);
 assert.equal(result.samples.length,14);
 assert.deepEqual(result.samples.map(x=>x.value),[-5,...Array(12).fill(null),30]);
 assert.equal(result.completeDays,2);
 assert.equal(result.endpointValue,30,'visible tail still compares to day zero, not to its own first day');
});

test('missing member days break lines, while actual zero and negative values remain observed',()=>{
 const accounts=[account(1),account(2)];
 const points=[point(1,0,100),point(2,0,200),point(1,1,101),point(2,1,199),point(1,2,99),point(1,3,98),point(2,3,200)];
 const result=buildOverviewTrendPreview(accounts,points,{start:date(0),end:date(3)});
 assert.deepEqual(result.samples.map(x=>x.value),[0,0,null,-2]);
 assert.deepEqual(result.samples.map(x=>x.known),[2,2,1,2]);
 const geometry=overviewTrendGeometry(result.samples);
 assert.equal(geometry.paths.length,2);
 assert.match(geometry.paths[0],/^M.* L/);
 assert.match(geometry.paths[1],/^M/);
 assert.doesNotMatch(geometry.paths[1],/ L/,'the endpoint after a missing day must not be connected');
 assert.equal(geometry.dots.length,3);
 assert.deepEqual([geometry.min,geometry.max],[-2,0]);
});

test('switching the miniature trend uses each metric real fixed cohort and never borrows follower values',()=>{
 const accounts=[account(1),account(2)];
 const points=[
  {...point(1,0,100),likes:10,posts:2},
  {...point(2,0,200),likes:20,posts:4},
  {...point(1,1,105),likes:15,posts:3},
  {...point(2,1,201),likes:null,posts:4},
  {...point(1,2,110),likes:19,posts:5},
  {...point(2,2,202),likes:23,posts:6},
 ];
 const options={start:date(0),end:date(2)};
 const followers=buildOverviewTrendPreview(accounts,points,{...options,metric:'followers'});
 const likes=buildOverviewTrendPreview(accounts,points,{...options,metric:'likes'});
 const posts=buildOverviewTrendPreview(accounts,points,{...options,metric:'posts'});
 assert.deepEqual(followers.samples.map(sample=>sample.value),[0,6,12]);
 assert.deepEqual(likes.samples.map(sample=>sample.value),[0,null,12],'an interior missing like sample breaks the line');
 assert.deepEqual(posts.samples.map(sample=>sample.value),[0,1,5]);
 assert.equal(likes.cohortCount,2);
 assert.equal(buildOverviewTrendPreview(accounts,points,{...options,metric:'unknown'}).state,'error');
});

test('partial endpoint excludes only that account; no paired account is unavailable, never zero',()=>{
 const accounts=[account(1),account(2)];
 const points=[point(1,0,10),point(2,0,20),point(1,1,12),point(2,1,null)];
 const result=buildOverviewTrendPreview(accounts,points,{start:date(0),end:date(1)});
 assert.equal(result.cohortCount,1);
 assert.equal(result.totalCount,2);
 assert.equal(result.endpointValue,2);
 const none=buildOverviewTrendPreview(accounts,[],{start:date(0),end:date(1)});
 assert.equal(none.state,'empty');
 assert.equal(none.endpointValue,null);
 assert.equal(overviewTrendGeometry(none.samples).paths.length,0);
});

test('not-ready and malformed source points do not render stale or invented values',()=>{
 const accounts=[account(1)];
 const points=[point(1,0,10),point(1,1,20)];
 const loading=buildOverviewTrendPreview(accounts,points,{start:date(0),end:date(1),ready:false});
 assert.equal(loading.state,'loading');
 assert.deepEqual(loading.samples,[]);
 assert.equal(buildOverviewTrendPreview(accounts,[...points,points[0]],{start:date(0),end:date(1)}).state,'error');
 assert.equal(buildOverviewTrendPreview(accounts,points,{start:'2026-09-99',end:date(1)}).state,'error');
});

test('compact component renders real scope and accessible textual missing-day status',async()=>{
 const root=fileURLToPath(new URL('../',import.meta.url));
 const result=await build({entryPoints:[root+'components/overview-trend-preview.tsx'],bundle:true,write:false,outfile:'overview-trend-preview.cjs',format:'cjs',platform:'node',packages:'external',tsconfig:root+'tsconfig.json'});
 const previewModule={exports:{}};
 const require=createRequire(import.meta.url);
 new Function('require','module','exports',result.outputFiles[0].text)(require,previewModule,previewModule.exports);
 const React=require('react');
 const {renderToStaticMarkup}=require('react-dom/server');
 const points=[point(1,0,100),point(1,1,100),point(1,3,102)];
 const html=renderToStaticMarkup(React.createElement(previewModule.exports.OverviewTrendPreview,{accounts:[account(1)],points,start:date(0),end:date(3),ready:true,initialMode:'cumulative'}));
 assert.match(html,/粉丝累计净变化/);
 assert.match(html,/固定可比 1\/1 个账号/);
 assert.match(html,/完整采样 3\/4 日；缺测处断线/);
 assert.match(html,/\+2/);
 assert.match(html,/<svg[^>]*role="group"[^>]*aria-label=/);
 assert.match(html,/class="overview-trend-preview__line" pathLength="1"/);
 assert.equal((html.match(/class="overview-trend-preview__point"/g)||[]).length,3,'only real observed days expose focusable points');
 assert.equal((html.match(/tabindex="0"/gi)||[]).length,1,'only the endpoint enters the initial Tab order');
 assert.match(html,/终点 2026-09-15 · 相对 2026-09-12：\+2/);
 assert.doesNotMatch(html,/class="overview-trend-preview__point"[^>]*2026-09-14/,'missing days cannot become clickable observations');
 const loading=renderToStaticMarkup(React.createElement(previewModule.exports.OverviewTrendPreview,{accounts:[account(1)],points,start:date(0),end:date(3),ready:false}));
 assert.match(loading,/正在核对所选区间/);
 assert.doesNotMatch(loading,/<svg/);
 const metricPoints=[{...point(1,0,100),likes:8,posts:2},{...point(1,1,100),likes:15,posts:3}];
 const likes=renderToStaticMarkup(React.createElement(previewModule.exports.OverviewTrendPreview,{accounts:[account(1)],points:metricPoints,start:date(0),end:date(1),ready:true,initialMode:'cumulative',metric:'likes'}));
 const posts=renderToStaticMarkup(React.createElement(previewModule.exports.OverviewTrendPreview,{accounts:[account(1)],points:metricPoints,start:date(0),end:date(1),ready:true,initialMode:'cumulative',metric:'posts'}));
 assert.match(likes,/主页获赞累计净变化/);
 assert.match(likes,/data-metric="likes"/);
 assert.match(likes,/相对所选起点的主页获赞净变化 \+7/);
 assert.doesNotMatch(likes,/相对所选起点的粉丝净变化/);
 assert.match(likes,/终点 2026-09-13 · 相对 2026-09-12：\+7/);
 assert.match(posts,/作品存量累计净变化/);
 assert.match(posts,/相对所选起点的作品存量净变化 \+1/);
 assert.match(posts,/终点 2026-09-13 · 相对 2026-09-12：\+1/);
});

test('observed points reveal their date and net change by pointer and keyboard, without filling gaps',async()=>{
 const root=fileURLToPath(new URL('../',import.meta.url));
 const backend=process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../douyin-monitor-workbench/',import.meta.url));
 const {chromium}=createRequire(backend+'package.json')('playwright-core');
 const result=await build({
  stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {OverviewTrendPreview} from './components/overview-trend-preview.tsx';const root=createRoot(document.getElementById('app'));window.mountTrend=props=>root.render(React.createElement(OverviewTrendPreview,props));`,resolveDir:root,sourcefile:'trend-interaction-entry.tsx',loader:'tsx'},
  bundle:true,write:false,outfile:'trend-interaction.iife.js',format:'iife',platform:'browser',tsconfig:root+'tsconfig.json',define:{'process.env.NODE_ENV':'"production"'},
 });
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{
  const page=await browser.newPage({reducedMotion:'reduce'});
  await page.setContent('<!doctype html><html lang="zh-CN"><body><div id="app"></div></body></html>');
  await page.addScriptTag({content:result.outputFiles[0].text});
  const props={accounts:[account(1)],points:[{...point(1,0,100),likes:20},{...point(1,1,103),likes:24},{...point(1,3,105),likes:29}],start:date(0),end:date(3),ready:true,initialMode:'cumulative'};
  await page.evaluate(value=>window.mountTrend(value),props);
  const points=page.locator('.overview-trend-preview__point');
  const tabOrder=()=>points.evaluateAll(nodes=>nodes.map(node=>node.getAttribute('tabindex')));
  await points.first().waitFor();
  assert.equal(await points.count(),3,'missing day must not expose an interactive target');
  assert.deepEqual(await tabOrder(),['-1','-1','0'],'only the endpoint is initially tabbable');
  assert.equal(await page.locator('.overview-trend-preview__plot strong').textContent(),'+5');
  assert.match(await page.locator('.overview-trend-preview__current small').textContent(),new RegExp(`区间终点.*${date(3)}`));
  await points.first().hover();
  assert.equal(await page.locator('.overview-trend-preview__plot strong').textContent(),'0','hover previews an observed day');
  assert.match(await page.locator('.overview-trend-preview__current small').textContent(),new RegExp(`指向采样日.*${date(0)}`));
  assert.equal(await page.locator('.overview-trend-preview__guide').count(),1,'selected observed point gets a visual guide');
  await page.mouse.move(0,0);
  assert.equal(await page.locator('.overview-trend-preview__plot strong').textContent(),'+5','leaving a hover restores the endpoint');
  await points.nth(1).click();
  assert.equal(await page.locator('.overview-trend-preview__plot strong').textContent(),'+3');
  assert.deepEqual(await tabOrder(),['-1','0','-1'],'a selected date becomes the single Tab stop');
  assert.match(await page.locator('.overview-trend-preview__reading').textContent(),new RegExp(`${date(1)}.*\\+3`));
  assert.equal(await points.nth(1).getAttribute('data-selected'),'true');
  await points.first().focus();
  assert.deepEqual(await tabOrder(),['0','-1','-1'],'direct focus also updates the roving Tab stop');
  await points.first().press('Enter');
  assert.equal(await page.locator('.overview-trend-preview__plot strong').textContent(),'0');
  assert.match(await page.locator('.overview-trend-preview__reading').textContent(),new RegExp(`${date(0)}.*：0`));
  await points.first().press('ArrowRight');
  assert.equal(await page.locator('.overview-trend-preview__plot strong').textContent(),'+3');
  assert.deepEqual(await tabOrder(),['-1','0','-1']);
  assert.equal(await points.nth(1).evaluate(node=>document.activeElement===node),true,'arrow movement keeps focus on the selected point');
  await points.nth(1).press('ArrowRight');
  assert.equal(await page.locator('.overview-trend-preview__plot strong').textContent(),'+5','arrow keys skip missing days');
  assert.deepEqual(await tabOrder(),['-1','-1','0']);
  await points.last().press('Home');
  assert.equal(await page.locator('.overview-trend-preview__plot strong').textContent(),'0');
  assert.deepEqual(await tabOrder(),['0','-1','-1']);
  await page.locator('.overview-trend-preview__date-picker select').selectOption(date(3));
  assert.equal(await page.locator('.overview-trend-preview__plot strong').textContent(),'+5');
  assert.equal(await page.locator('.overview-trend-preview__date-picker select').inputValue(),date(3));
  assert.deepEqual(await tabOrder(),['-1','-1','0'],'the date picker and chart keep one shared selected date');
  await page.evaluate(value=>window.mountTrend({...value,metric:'likes'}),props);
  await page.locator('.overview-trend-preview[data-metric="likes"]').waitFor();
  await page.setViewportSize({width:610,height:800});
  await page.waitForFunction(()=>{const svg=document.querySelector('.overview-trend-preview__svg');return svg&&Math.abs(svg.viewBox.baseVal.width-svg.getBoundingClientRect().width)<2;});
  assert.match(await page.locator('.overview-trend-preview__head strong').textContent(),/主页获赞累计净变化/);
  await page.close();
 }finally{await browser.close();}
});

test('phone touch scrubs the chart across observed dates without creating a missing-day point',async()=>{
 const root=fileURLToPath(new URL('../',import.meta.url));
 const backend=process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../douyin-monitor-workbench/',import.meta.url));
 const {chromium}=createRequire(backend+'package.json')('playwright-core');
 const bundle=await build({
  stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {OverviewTrendPreview} from './components/overview-trend-preview.tsx';createRoot(document.getElementById('app')).render(React.createElement(OverviewTrendPreview,{accounts:[{id:1,enabled:true}],points:[{targetId:1,date:'2026-09-12',capturedAt:'2026-09-12T02:00:00Z',followers:100},{targetId:1,date:'2026-09-13',capturedAt:'2026-09-13T02:00:00Z',followers:103},{targetId:1,date:'2026-09-15',capturedAt:'2026-09-15T02:00:00Z',followers:105}],start:'2026-09-12',end:'2026-09-15',ready:true,initialMode:'cumulative'}));`,resolveDir:root,sourcefile:'trend-touch-entry.tsx',loader:'tsx'},
  bundle:true,write:false,outfile:'trend-touch.iife.js',format:'iife',platform:'browser',tsconfig:root+'tsconfig.json',define:{'process.env.NODE_ENV':'"production"'},
 });
 const css=readFileSync(root+'app/visual-theme.css','utf8');
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{
  const page=await browser.newPage({viewport:{width:390,height:820},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
  await page.setContent(`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}html,body{margin:0}.workspace{padding:10px}${css}</style></head><body><main class="workspace"><section class="overview-account-preview"><div id="app"></div></section></main></body></html>`);
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  const dots=page.locator('.overview-trend-preview__point');
  await dots.first().waitFor();
  assert.equal(await page.evaluate(()=>matchMedia('(pointer: coarse)').matches),true);
  assert.equal(await dots.count(),3,'the missing date is never a selectable dot');
  const first=await dots.first().boundingBox();
  const last=await dots.last().boundingBox();
  const y=first.y+first.height/2;
  await page.touchscreen.tap(first.x+first.width/2,y);
  assert.match(await page.locator('.overview-trend-preview__reading').textContent(),/2026-09-12.*：0/);
  const client=await page.context().newCDPSession(page);
  await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:first.x+first.width/2,y}]});
  await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:last.x+last.width/2,y}]});
  await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.waitForFunction(()=>document.querySelector('.overview-trend-preview__reading')?.textContent?.includes('2026-09-15'));
  assert.match(await page.locator('.overview-trend-preview__reading').textContent(),/2026-09-15.*\+5/);
  assert.equal(await page.locator('.overview-trend-preview__point[data-selected="true"]').count(),1);
  assert.equal(await page.locator('.overview-trend-preview__plot').evaluate(node=>getComputedStyle(node).animationName),'none','reduced-motion removes metric transition');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await page.close();
 }finally{await browser.close();}
});

test('responsive chart keeps point targets round instead of stretching circles into ellipses',async()=>{
 const root=fileURLToPath(new URL('../',import.meta.url));
 const backend=process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../douyin-monitor-workbench/',import.meta.url));
 const {chromium}=createRequire(backend+'package.json')('playwright-core');
 const bundle=await build({
  stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {OverviewTrendPreview} from './components/overview-trend-preview.tsx';createRoot(document.getElementById('app')).render(React.createElement(OverviewTrendPreview,{accounts:[{id:1,enabled:true}],points:[{targetId:1,date:'2026-09-12',capturedAt:'2026-09-12T02:00:00Z',followers:100},{targetId:1,date:'2026-09-13',capturedAt:'2026-09-13T02:00:00Z',followers:105}],start:'2026-09-12',end:'2026-09-13',ready:true}));`,resolveDir:root,sourcefile:'trend-round-points.tsx',loader:'tsx'},
  bundle:true,write:false,outfile:'trend-round-points.iife.js',format:'iife',platform:'browser',tsconfig:root+'tsconfig.json',define:{'process.env.NODE_ENV':'"production"'},
 });
 const css=readFileSync(root+'app/visual-theme.css','utf8');
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{
  for(const width of [320,390,1280]){
   const page=await browser.newPage({viewport:{width,height:800},reducedMotion:'reduce'});
   await page.setContent(`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}html,body{margin:0}.workspace{padding:10px}${css}</style></head><body><main class="workspace"><section class="overview-account-preview"><div id="app"></div></section></main></body></html>`);
   await page.addScriptTag({content:bundle.outputFiles[0].text});
   await page.waitForFunction(()=>{const svg=document.querySelector('.overview-trend-preview__svg');return svg&&Math.abs(svg.viewBox.baseVal.width-svg.getBoundingClientRect().width)<2;});
   const reading=await page.evaluate(()=>{const dot=document.querySelector('.overview-trend-preview__point');const box=dot.getBoundingClientRect();return {ratio:box.width/box.height,overflow:document.documentElement.scrollWidth>innerWidth+1};});
   assert.ok(Math.abs(reading.ratio-1)<.12,`${width}px target must stay round (ratio=${reading.ratio})`);
   assert.equal(reading.overflow,false,`${width}px must not overflow`);
   await page.close();
  }
 }finally{await browser.close();}
});

test('real preview styles stay legible without sideways overflow on phones',async()=>{
 const root=fileURLToPath(new URL('../',import.meta.url));
 const backend=process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../douyin-monitor-workbench/',import.meta.url));
 const {chromium}=createRequire(backend+'package.json')('playwright-core');
 const result=await build({entryPoints:[root+'components/overview-trend-preview.tsx'],bundle:true,write:false,outfile:'overview-trend-preview.cjs',format:'cjs',platform:'node',packages:'external',tsconfig:root+'tsconfig.json'});
 const previewModule={exports:{}};
 const require=createRequire(import.meta.url);
 new Function('require','module','exports',result.outputFiles[0].text)(require,previewModule,previewModule.exports);
 const React=require('react');
 const {renderToStaticMarkup}=require('react-dom/server');
 const points=[point(1,0,100),point(1,1,101),point(1,3,105)];
 const markup=renderToStaticMarkup(React.createElement(previewModule.exports.OverviewTrendPreview,{accounts:[account(1)],points,start:date(0),end:date(3),ready:true,initialMode:'cumulative'}));
 const theme=readFileSync(root+'app/visual-theme.css','utf8');
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{
  for(const width of [320,390,1280]){
   const page=await browser.newPage({viewport:{width,height:800},reducedMotion:'reduce'});
   await page.setContent(`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}html,body{margin:0}.workspace{padding:10px}${theme}</style></head><body><main class="workspace"><section class="overview-account-preview">${markup}</section></main></body></html>`);
   const layout=await page.evaluate(()=>{
    const figure=document.querySelector('.overview-trend-preview');
    const svg=figure.querySelector('svg');
    const number=figure.querySelector('.overview-trend-preview__plot strong');
    const guide=figure.querySelector('.overview-trend-preview__guide');
    return {overflow:document.documentElement.scrollWidth>innerWidth+1,right:figure.getBoundingClientRect().right,svgWidth:svg.getBoundingClientRect().width,number:number.textContent,animation:getComputedStyle(number).animationName,guideAnimation:guide?getComputedStyle(guide).animationName:null};
   });
   assert.equal(layout.overflow,false,`${width}px must not scroll horizontally`);
   assert.ok(layout.right<=width+1&&layout.svgWidth>0,`${width}px chart must fit`);
   assert.equal(layout.number,'+5');
   assert.equal(layout.animation,'none','real numeric readout must not animate');
   assert.equal(layout.guideAnimation,'none','reduced-motion disables the visual guide entrance');
   await page.close();
  }
 }finally{await browser.close();}
});
