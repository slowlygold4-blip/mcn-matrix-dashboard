import{readFileSync}from'node:fs';import test from'node:test';import assert from'node:assert/strict';
import{createHash}from'node:crypto';import{createRequire}from'node:module';import{fileURLToPath}from'node:url';import{build}from'esbuild';
import{publishingPartitions}from'../lib/replica-publishing.mjs';
const site=fileURLToPath(new URL('../',import.meta.url)),main=process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../douyin-monitor-workbench/',import.meta.url));
const{chromium}=createRequire(main+'package.json')('playwright-core');
test('actual parent scope updates work cards/chart/rows together and retains verified day reads',async()=>{
 const asOf='2026-10-30T00:00:00.000Z',scopes=[{theme:'tuantuan',boardKeys:['团团矩阵'],labels:['slice']},
  {theme:'anlan',boardKeys:['安澜矩阵'],labels:['original']},{theme:'douyin-streamers',boardKeys:['抖音主播板块'],labels:[]}];
 const row=(id,scopeId,platform='douyin')=>({contentId:platform==='bilibili'?'BV1233d6aESc':String(id),date:'2026-10-29',author:'作者'+id,title:'作品'+id,targetId:id,
  scopeId,platform,classifications:id===1?['original']:['slice'],origin:'platform',metrics:{likes:{value:id*10,origin:'platform'},plays:{value:null,origin:'unavailable'}}});
 const rows=[row(1,0),row(2,1),row(3,2),row(4,1,'bilibili')];
 const files=publishingPartitions(rows,{withMetrics:true,scopes}).map(({path,kind,count,items,...rest})=>{
  const value={version:1,asOf,timeZone:'Asia/Shanghai',...rest,...(items?{items}:{count})},content=JSON.stringify(value);
  return{content,meta:{path,kind,count:items?.length??count,bytes:Buffer.byteLength(content),sha256:createHash('sha256').update(content).digest('hex')}};
 });
 const manifest={asOf,files:files.map(f=>f.meta)};
 const bundle=await build({stdin:{contents:`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{ContinuousPublishing}from'./components/continuous-publishing';function Harness(){const[scope,setScope]=useState({theme:'anlan',tag:'all',scopeLabel:'安澜'});window.changeScope=setScope;return <div className="workspace"><main className="content" style={{gridColumn:'1 / -1'}}><ContinuousPublishing manifest={${JSON.stringify(manifest)}} startDate="2026-09-12" endDate="2026-10-30" {...scope}/></main></div>;}createRoot(document.getElementById('root')).render(<Harness/>);`,resolveDir:site,sourcefile:'publication-scope-fixture.tsx',loader:'tsx'},absWorkingDir:site,bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',tsconfig:site+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'}});
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{
  const page=await browser.newPage(),errors=[],reads=[],platformRequests=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!=='https://mcn-scope.test'){platformRequests.push(u.origin);return route.abort();}
   if(u.pathname==='/')return route.fulfill({body:'<!doctype html><meta charset="utf-8"><div id="root"></div>',contentType:'text/html'});
   const file=files.find(f=>f.meta.path===u.searchParams.get('part'));if(!file)return route.fulfill({status:404});reads.push(file.meta.path);
   return route.fulfill({body:file.content,contentType:'application/json',headers:{'X-Data-SHA256':file.meta.sha256,'X-Data-Cutoff':asOf}});
  });
  await page.goto('https://mcn-scope.test/');
  await page.addStyleTag({content:['replica.css','source-operations.css','visual-theme.css','observatory.css'].map(name=>readFileSync(site+'app/'+name,'utf8')).join('\n')});
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  await page.getByRole('heading',{name:'已收录发片记录 · 2 条',exact:true}).waitFor();
  const cards=page.getByRole('region',{name:'持续监控每日发片'}).locator('.source-ops-kpis');
  assert.equal(await cards.locator('[data-work-metric="likes"] strong').textContent(),'60');
  await page.getByRole('combobox',{name:'选择发布日'}).selectOption('2026-10-29');await page.getByRole('button',{name:'查看当天作品 →',exact:true}).click();
  const panel=page.getByRole('region',{name:'所选发布日作品'});await panel.getByRole('link',{name:'作品2',exact:true}).waitFor();
  assert.equal(await panel.locator('tbody tr').count(),2);
  assert.equal(await panel.getByRole('link',{name:'作品4',exact:true}).getAttribute('href'),'https://www.bilibili.com/video/BV1233d6aESc');
  const fetched=reads.length;
  await page.evaluate(()=>window.changeScope({theme:'tuantuan',tag:'all',scopeLabel:'团团'}));
  await panel.getByRole('link',{name:'作品1',exact:true}).waitFor();assert.equal(await panel.locator('tbody tr').count(),1);
  assert.equal(await cards.locator('[data-work-metric="likes"] strong').textContent(),'10');
  assert.equal(await page.getByRole('combobox',{name:'选择发布日'}).inputValue(),'2026-10-29');
  await page.getByRole('combobox',{name:'每日发片内容分类'}).selectOption('slice');
  await page.getByRole('heading',{name:'切片激励 · 已收录发片记录 · 0 条',exact:true}).waitFor();assert.equal(await panel.locator('tbody tr').count(),0);
  await page.getByRole('combobox',{name:'每日发片内容分类'}).selectOption('all');
  await page.evaluate(()=>window.changeScope({theme:'all',tag:'all',scopeLabel:'全部矩阵'}));
  await page.getByRole('heading',{name:'已收录发片记录 · 3 条',exact:true}).waitFor();assert.equal(await panel.locator('tbody tr').count(),3);
  assert.equal(await panel.getByRole('link',{name:'作品3',exact:true}).count(),0,'independent streamer excluded by default');
  await page.evaluate(()=>window.changeScope({theme:'douyin-streamers',tag:'all',scopeLabel:'抖音主播'}));
  await panel.getByRole('link',{name:'作品3',exact:true}).waitFor();assert.equal(await panel.locator('tbody tr').count(),1);
  assert.equal(reads.length,fetched,'scope changes reuse already verified index/day');
  for(const width of [390,320]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);}
  assert.deepEqual(errors,[]);assert.deepEqual(platformRequests,[]);
 }finally{await browser.close();}
});
