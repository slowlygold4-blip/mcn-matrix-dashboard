import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
const {chromium}=createRequire(resolve(process.env.MCN_MAIN_ROOT||resolve(root,'../douyin-monitor-workbench'),'package.json'))('playwright-core');
const fixture=`import React from 'react';import {createRoot} from 'react-dom/client';import {AuthorUnifiedWorks} from './components/author-unified-works';import {sourcePartsIdentity} from './lib/source-part-reader.mjs';
const file={path:'works-001.json',sha256:'a'.repeat(64),bytes:20,count:23};
const items=Array.from({length:23},(_,i)=>({contentId:String(7300000000000000000n+BigInt(i)),douyinId:'author',title:'作品'+i,publishDate:'2026-10-26',likes:i===22?null:i,plays:i*100}));
const author={name:'验收作者',douyinId:'author',targetIds:[]},source={revision:1,stats:{works:23},files:[file]},manifest={asOf:'2026-10-26T08:00:00.000Z',files:[]},foundation={works:[],observations:[{contentId:items[21].contentId,douyinId:'author',likes:101,plays:null,observedAt:'2026-10-25T08:00:00.000Z',sourceRow:2,timeBasis:'metric-observation'}]},preverified={identity:sourcePartsIdentity([file],'1','/creator-source/'),items};
function App(){const [open,setOpen]=React.useState(true);return open?<AuthorUnifiedWorks author={author} manifest={manifest} source={source} foundation={foundation} preverified={preverified} onClose={()=>setOpen(false)}/>:<h1>已关闭</h1>;}createRoot(document.getElementById('root')).render(<App/>);`;
const built=await build({stdin:{contents:fixture,sourcefile:'fixture.tsx',resolveDir:root,loader:'tsx'},absWorkingDir:root,bundle:true,write:false,outfile:'fixture.js',format:'iife',platform:'browser',jsx:'automatic',tsconfig:root+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'}});
test('author works modal paginates all records, sorts adopted values, searches, exports and closes',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{const page=await browser.newPage({viewport:{width:1280,height:900},acceptDownloads:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',r=>r.request().url()==='http://127.0.0.1:49134/'?r.fulfill({contentType:'text/html',body:'<html lang="zh-CN"><div id="root"></div></html>'}):r.abort());await page.goto('http://127.0.0.1:49134/');await page.addStyleTag({content:readFileSync(root+'app/replica.css','utf8')});await page.addScriptTag({content:built.outputFiles.find(x=>x.path.endsWith('.js')).text});
 await page.getByText('共 23 条 · 当前匹配 23 条').waitFor();assert.equal(await page.locator('tbody tr').count(),20);
 assert.match(await page.getByLabel('当前筛选作品指标合计').innerText(),/311.*22\/23/s);
 await page.getByRole('button',{name:'下一页',exact:true}).click();assert.equal(await page.locator('tbody tr').count(),3);
 await page.getByRole('button',{name:'点赞 ↕',exact:true}).click();assert.equal(await page.locator('tbody tr').first().locator('[data-metric="likes"] strong').innerText(),'101');
 await page.getByRole('button',{name:'点赞 ↓',exact:true}).click();assert.equal(await page.locator('tbody tr').first().locator('[data-metric="likes"] strong').innerText(),'0');
 await page.getByLabel('搜索此作者的全部作品').fill('作品22');assert.equal(await page.locator('tbody tr').count(),1);assert.equal(await page.locator('[data-metric="likes"] strong').innerText(),'—');
 assert.match(await page.getByLabel('当前筛选作品指标合计').innerText(),/已知累计点赞\s*—.*0\/1/s);
 const d=page.waitForEvent('download');await page.getByRole('button',{name:'导出全部筛选作品'}).click();const download=await d;const bytes=readFileSync(await download.path(),'utf8');assert.match(bytes,/作品22/);assert.doesNotMatch(bytes,/作品21/);
 await page.keyboard.press('Escape');await page.getByText('已关闭').waitFor();assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('network-backed modal shows verified progress, cancels closed reads and retries corruption without partial results',{timeout:30000},async()=>{
 const samples=Array.from({length:6},(_,i)=>{
  const path=`works-${String(i+1).padStart(3,'0')}.json`,body=JSON.stringify({revision:'network-fixture',items:[{contentId:String(7300000000000000100n+BigInt(i)),douyinId:'owner',title:'网络作品'+i,publishDate:'2026-10-26',likes:i===5?null:i,plays:null}]});
  return {body,file:{path,count:1,bytes:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex')}};
 });
 const app=`import React from 'react';import {createRoot} from 'react-dom/client';import {AuthorUnifiedWorks} from './components/author-unified-works';const author={name:'网络作者',douyinId:'owner',targetIds:[]},manifest={asOf:'2026-10-26T08:00:00.000Z',files:[]},source={revision:'network-fixture',stats:{works:6},files:${JSON.stringify(samples.map(x=>x.file))}},foundation={works:[],observations:[]};function App(){const [open,setOpen]=React.useState(true);return open?<AuthorUnifiedWorks author={author} manifest={manifest} source={source} foundation={foundation} onClose={()=>setOpen(false)}/>:<button onClick={()=>setOpen(true)}>重新查看作品</button>;}createRoot(document.getElementById('root')).render(<App/>);`;
 const bundle=await build({stdin:{contents:app,sourcefile:'network-works-fixture.tsx',resolveDir:root,loader:'tsx'},absWorkingDir:root,bundle:true,write:false,outfile:'network-works-fixture.js',format:'iife',platform:'browser',jsx:'automatic',tsconfig:root+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'}});
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 const releases=[],started=[],failed=[],errors=[];let hold=true,corrupt=false;
 try{const page=await browser.newPage({viewport:{width:390,height:844}});page.on('pageerror',e=>errors.push(e.message));page.on('requestfailed',q=>{if(q.url().includes('/creator-source/works-'))failed.push(q.url());});
  await page.route('**/*',async route=>{
   const pathname=new URL(route.request().url()).pathname;
   if(pathname==='/')return route.fulfill({contentType:'text/html',body:'<html lang="zh-CN"><div id="root"></div></html>'});
   const sample=samples.find(item=>pathname==='/creator-source/'+item.file.path);if(!sample)return route.abort();started.push(pathname);
   if(hold)await new Promise(resolve=>releases.push(resolve));
   await route.fulfill({contentType:'application/json',body:corrupt&&sample===samples[0]?'{}':sample.body}).catch(()=>{});
  });
  await page.goto('http://127.0.0.1:49135/');await page.addStyleTag({content:readFileSync(root+'app/replica.css','utf8')});await page.addScriptTag({content:bundle.outputFiles.find(x=>x.path.endsWith('.js')).text});
  await page.getByRole('status').filter({hasText:'来源作品分区已核验 0/6'}).waitFor();
  let deadline=Date.now()+5000;while(started.length<4&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(started.length,4);
  await page.keyboard.press('Escape');await page.getByRole('button',{name:'重新查看作品'}).waitFor();
  deadline=Date.now()+5000;while(failed.length<4&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(failed.length,4);assert.equal(started.length,4,'closing cannot start the next batch');
  hold=false;for(const release of releases)release();corrupt=true;
  await page.getByRole('button',{name:'重新查看作品'}).click();await page.getByRole('alert').filter({hasText:/长度不符/}).waitFor();
  assert.equal(await page.locator('tbody tr').count(),0);assert.equal(await page.getByRole('button',{name:'导出全部筛选作品'}).isDisabled(),true);
  corrupt=false;await page.getByRole('button',{name:'重试作品读取'}).click();await page.getByText('共 6 条 · 当前匹配 6 条').waitFor();
  assert.equal(await page.locator('tbody tr').count(),6);assert.match(await page.getByLabel('当前筛选作品指标合计').innerText(),/已知累计点赞\s*10.*5\/6/s);
  assert.deepEqual(errors,[]);
 }finally{for(const release of releases)release();await browser.close();}
});
