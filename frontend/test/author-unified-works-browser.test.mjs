import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
const root=fileURLToPath(new URL('../',import.meta.url));
const {chromium}=createRequire(root+'../douyin-monitor-workbench/package.json')('playwright-core');
const fixture=`import React from 'react';import {createRoot} from 'react-dom/client';import {AuthorUnifiedWorks} from './components/author-unified-works';import {sourcePartsIdentity} from './lib/source-part-reader.mjs';
const file={path:'works-001.json',sha256:'a'.repeat(64),bytes:20,count:23};
const items=Array.from({length:23},(_,i)=>({contentId:String(7300000000000000000n+BigInt(i)),douyinId:'author',title:'作品'+i,publishDate:'2026-10-26',likes:i===22?null:i,plays:i*100}));
const author={name:'验收作者',douyinId:'author',targetIds:[]},source={revision:1,stats:{works:23},files:[file]},manifest={asOf:'2026-10-26T08:00:00.000Z',files:[]},foundation={works:[]},preverified={identity:sourcePartsIdentity([file],'1','/creator-source/'),items};
function App(){const [open,setOpen]=React.useState(true);return open?<AuthorUnifiedWorks author={author} manifest={manifest} source={source} foundation={foundation} preverified={preverified} onClose={()=>setOpen(false)}/>:<h1>已关闭</h1>;}createRoot(document.getElementById('root')).render(<App/>);`;
const built=await build({stdin:{contents:fixture,sourcefile:'fixture.tsx',resolveDir:root,loader:'tsx'},absWorkingDir:root,bundle:true,write:false,outfile:'fixture.js',format:'iife',platform:'browser',jsx:'automatic',tsconfig:root+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'}});
test('author works modal paginates all records, sorts adopted values, searches, exports and closes',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{const page=await browser.newPage({viewport:{width:1280,height:900},acceptDownloads:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',r=>r.request().url()==='http://127.0.0.1:49134/'?r.fulfill({contentType:'text/html',body:'<html lang="zh-CN"><div id="root"></div></html>'}):r.abort());await page.goto('http://127.0.0.1:49134/');await page.addStyleTag({content:readFileSync(root+'app/replica.css','utf8')});await page.addScriptTag({content:built.outputFiles.find(x=>x.path.endsWith('.js')).text});
 await page.getByText('共 23 条 · 当前匹配 23 条').waitFor();assert.equal(await page.locator('tbody tr').count(),20);
 await page.getByRole('button',{name:'下一页',exact:true}).click();assert.equal(await page.locator('tbody tr').count(),3);
 await page.getByRole('button',{name:'点赞 ↕',exact:true}).click();assert.equal(await page.locator('tbody tr').first().locator('[data-metric="likes"] strong').innerText(),'21');
 await page.getByRole('button',{name:'点赞 ↓',exact:true}).click();assert.equal(await page.locator('tbody tr').first().locator('[data-metric="likes"] strong').innerText(),'0');
 await page.getByLabel('搜索此作者的全部作品').fill('作品22');assert.equal(await page.locator('tbody tr').count(),1);assert.equal(await page.locator('[data-metric="likes"] strong').innerText(),'—');
 const d=page.waitForEvent('download');await page.getByRole('button',{name:'导出全部筛选作品'}).click();const download=await d;const bytes=readFileSync(await download.path(),'utf8');assert.match(bytes,/作品22/);assert.doesNotMatch(bytes,/作品21/);
 await page.keyboard.press('Escape');await page.getByText('已关闭').waitFor();assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
