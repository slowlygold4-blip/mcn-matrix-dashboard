// Actual React component fixture; synthetic records only. Run in the cloud.
// This test deliberately has no macOS/browser executable fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
const root=fileURLToPath(new URL('../',import.meta.url));
const {chromium}=createRequire(resolve(process.env.MCN_MAIN_ROOT||resolve(root,'..'),'package.json'))('playwright-core');
async function cloudBrowser(){
 if(process.env.MCN_TEST_BROWSER_WS)return chromium.connect(process.env.MCN_TEST_BROWSER_WS);
 if(process.env.MCN_TEST_CLOUD_BROWSER==='1'&&process.platform==='linux')return chromium.launch({headless:true});
 throw Error('Run this fixture in cloud Linux with MCN_TEST_CLOUD_BROWSER=1, or supply MCN_TEST_BROWSER_WS; local browser launch is disabled.');
}
const asOf='2026-10-26T08:00:00.000Z';
const contentId=index=>String(7300000000000000000n+BigInt(index));
function partition(path,kind,targetId,items){
 const body=JSON.stringify({version:1,asOf,timeZone:'Asia/Shanghai',items});
 return {body,meta:{path,kind,targetId,count:items.length,bytes:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex')}};
}
async function fixture({mismatch=false,withoutHistory=false}={}){
 const sources=Array.from({length:23},(_,i)=>({row:i+1,contentId:contentId(i),douyinId:'author',title:'作品'+i,publishDate:'2026-10-26',dateBasis:'source-explicit-date',likes:i,plays:null}));
 const works=partition('works/2.json','works',2,[18,19,21,22].map(i=>({id:100+i,targetId:2,externalId:contentId(i),caption:'作品'+i,publishedAt:'2026-10-26T02:00:00.000Z',lastObservedAt:asOf,likes:i,plays:null})));
 const metrics=partition('work-metrics/2.json','workMetrics',2,[
  {id:1,targetId:2,workId:121,externalId:mismatch?contentId(20):contentId(21),capturedAt:'2026-10-24T04:00:00.000Z',likes:10},
  {id:2,targetId:2,workId:121,externalId:mismatch?contentId(20):contentId(21),capturedAt:'2026-10-25T04:00:00.000Z',likes:7},
  {id:3,targetId:2,workId:121,externalId:mismatch?contentId(20):contentId(21),capturedAt:'2026-10-26T04:00:00.000Z',likes:null},
  {id:4,targetId:2,workId:118,externalId:contentId(18),capturedAt:'2026-10-24T04:00:00.000Z',likes:5},
  {id:5,targetId:2,workId:118,externalId:contentId(18),capturedAt:'2026-10-26T04:00:00.000Z',likes:9},
 ]);
 const manifest={asOf,timeZone:'Asia/Shanghai',files:[works.meta,...(withoutHistory?[]:[metrics.meta])]};
 const code=`import React from 'react';import {createRoot} from 'react-dom/client';import {AuthorUnifiedWorks} from './components/author-unified-works';import {sourcePartsIdentity} from './lib/source-part-reader.mjs';
 const file={path:'works-001.json',sha256:'a'.repeat(64),bytes:20,count:23};
 const source={revision:'fixture',sourceModifiedAt:'fixed',sourceRows:23,stats:{works:23},files:[file]},items=${JSON.stringify(sources)},foundation={works:[],observations:[]};
 const author={name:'验收作者',douyinId:'author',targetIds:[1,2]},accounts=[{id:1,platform:'douyin',label:'另一关联账号'},{id:2,platform:'douyin',label:'确切发布账号'}];
 const preverified={identity:sourcePartsIdentity([file],'fixture','/creator-source/'),items},manifest=${JSON.stringify(manifest)},projection={revision:'fixture',modifiedAt:'fixed',rowCount:23,workOwners:[{workRow:20,contentId:${JSON.stringify(contentId(19))},targetId:3}]};
 function App(){const [open,setOpen]=React.useState(false),[version,setVersion]=React.useState(0),trigger=React.useRef(null);const current=React.useMemo(()=>version?{...manifest,asOf:'2026-10-27T08:00:00.000Z',files:[]}:manifest,[version]);React.useEffect(()=>{window.fixtureNextVersion=()=>setVersion(v=>v+1);},[]);return <><button ref={trigger} onClick={()=>setOpen(true)}>查看作者作品</button>{open&&<AuthorUnifiedWorks author={author} accounts={accounts} manifest={current} source={source} foundation={foundation} preverified={preverified} workOwnerProjection={projection} onOpenAccount={()=>{}} returnFocus={trigger.current} onClose={()=>setOpen(false)}/>}</>;}createRoot(document.getElementById('root')).render(<App/>);`;
 const bundle=await build({stdin:{contents:code,sourcefile:'author-history-fixture.tsx',resolveDir:root,loader:'tsx'},absWorkingDir:root,bundle:true,write:false,outfile:'fixture.js',format:'iife',platform:'browser',jsx:'automatic',tsconfig:root+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'}});
 return {works,metrics,manifest,js:bundle.outputFiles.find(file=>file.path.endsWith('.js')).text};
}
async function openFixture(browser,options={}){
 const f=await fixture(options),context=await browser.newContext({viewport:{width:1180,height:800},acceptDownloads:true}),page=await context.newPage();
 const state={requests:[],failed:[],errors:[],hold:false,corrupt:false,releases:[]};
 page.on('pageerror',error=>state.errors.push(error.message));
 page.on('requestfailed',request=>{if(request.url().includes('work-metrics'))state.failed.push(request.url());});
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<html lang="zh-CN"><div id="root"></div></html>'});
  if(url.pathname!=='/api/replica')return route.abort();
  const part=url.searchParams.get('part'),stored=[f.works,f.metrics].find(value=>value.meta.path===part);
  state.requests.push({part,generation:url.searchParams.get('generation')});
  if(!stored||url.searchParams.get('generation')!==asOf)return route.abort();
  if(part.startsWith('work-metrics/')&&state.hold)await new Promise(resolve=>state.releases.push(resolve));
  await route.fulfill({contentType:'application/json',body:state.corrupt&&part.startsWith('work-metrics/')?'{}':stored.body,
   headers:{'X-Data-SHA256':stored.meta.sha256,'X-Data-Cutoff':asOf}}).catch(()=>{});
 });
 await page.goto('http://127.0.0.1:49138/');await page.addStyleTag({content:readFileSync(root+'app/replica.css','utf8')});await page.addScriptTag({content:f.js});
 await page.getByRole('button',{name:'查看作者作品',exact:true}).click();await page.getByText('共 23 条 · 当前匹配 23 条').waitFor();
 return {page,state,context,release(){state.hold=false;for(const fn of state.releases.splice(0))fn();}};
}
const historyRegion=page=>page.getByLabel('所选作品点赞历史');
const buttonFor=(page,id)=>page.locator('[data-author-work-history="'+id+'"]');
async function until(predicate,message){const deadline=Date.now()+5000;while(!predicate()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(predicate(),message);}

test('author to exact work daily likes keeps list state, negative/missing semantics and keyboard focus; exports reuse exact catalog identity',{timeout:30000},async()=>{
 const browser=await cloudBrowser();let f;
 try{f=await openFixture(browser);const {page,state}=f;
  const claim=page.locator('tbody tr').filter({hasText:'作品19'});assert.match(await claim.innerText(),/原登记归属声明/);assert.equal(await claim.getByRole('button',{name:'查看每日点赞',exact:true}).count(),0);
  assert.equal(await page.locator('tbody tr').filter({hasText:'作品0'}).getByRole('button',{name:'查看每日点赞',exact:true}).count(),0);
  await page.getByRole('button',{name:'下一页',exact:true}).click();assert.equal(await page.locator('.source-table tbody tr').count(),3);
  const trigger=buttonFor(page,121);await trigger.focus();await page.keyboard.press('Enter');
  await historyRegion(page).getByRole('heading',{name:'单作品每日点赞变化'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'返回作者作品列表'}).evaluate(el=>el===document.activeElement),true);
  assert.match(await historyRegion(page).innerText(),/确切发布账号/);assert.match(await historyRegion(page).innerText(),/-3/);assert.match(await historyRegion(page).innerText(),/本日缺测/);
  assert.match(await historyRegion(page).innerText(),/全部点赞采样|最近一次点赞/);assert.ok(state.requests.some(q=>q.part==='work-metrics/2.json'&&q.generation===asOf));
  assert.equal(state.requests.some(q=>q.part==='work-metrics/1.json'),false,'never use the author first target instead of the selected work owner');
  const daily=page.waitForEvent('download');await page.getByRole('button',{name:'导出全部每日变化'}).click();const dailyText=readFileSync(await(await daily).path(),'utf8');assert.match(dailyText,/确切发布账号/);assert.match(dailyText,/-3/);assert.doesNotMatch(dailyText,/7300000000000000018/);
  await page.getByRole('button',{name:'原始采样',exact:true}).click();const raw=page.waitForEvent('download');await page.getByRole('button',{name:'导出全部原始采样'}).click();const rawText=readFileSync(await(await raw).path(),'utf8');assert.match(rawText,/douyin/);assert.match(rawText,/确切发布账号/);assert.match(rawText,/2026-10-25T04:00:00.000Z/);
  await page.getByRole('button',{name:'返回作者作品列表'}).click();assert.equal(await trigger.evaluate(el=>el===document.activeElement),true);assert.equal(await page.locator('.source-table tbody tr').count(),3);assert.match(await page.getByText('第 2/2 页',{exact:true}).innerText(),/2\/2/);
  await page.getByLabel('搜索此作者的全部作品').fill('作品18');await buttonFor(page,118).click();await historyRegion(page).getByText('缺前日点赞',{exact:false}).first().waitFor();assert.doesNotMatch(await historyRegion(page).innerText(),/\+4/);
  await page.getByRole('button',{name:'返回作者作品列表'}).click();assert.equal(await page.getByLabel('搜索此作者的全部作品').inputValue(),'作品18');
  await page.getByLabel('搜索此作者的全部作品').fill('作品22');await buttonFor(page,122).click();await historyRegion(page).getByText('这条作品尚无点赞采样，不能计算增长。').waitFor();assert.equal(await page.getByRole('button',{name:'导出全部每日变化'}).isDisabled(),true);
  await page.keyboard.press('Escape');await page.getByRole('button',{name:'查看作者作品',exact:true}).waitFor();assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await page.getByRole('button',{name:'查看作者作品',exact:true}).evaluate(el=>el===document.activeElement),true);assert.deepEqual(state.errors,[]);
 }finally{f?.release();await f?.context.close();await browser.close();}
});

test('history loading cancels on back/close/version switch; corrupt responses retry without showing stale data',{timeout:30000},async()=>{
 const browser=await cloudBrowser();let f;
 try{f=await openFixture(browser);const {page,state}=f;await page.getByLabel('搜索此作者的全部作品').fill('作品21');state.hold=true;await buttonFor(page,121).click();await page.getByRole('status').filter({hasText:'正在核验此作品的点赞历史'}).waitFor();await until(()=>state.releases.length===1,'history request is actually pending');
  await page.getByRole('button',{name:'返回作者作品列表'}).click();await until(()=>state.failed.length===1,'back aborts pending history fetch');f.release();await page.waitForTimeout(50);assert.equal(await historyRegion(page).count(),0);assert.equal(await buttonFor(page,121).evaluate(el=>el===document.activeElement),true);
  state.corrupt=true;await buttonFor(page,121).click();await page.getByRole('alert').filter({hasText:'保存数据校验不一致'}).waitFor();assert.equal(await historyRegion(page).getByRole('heading',{name:'单作品每日点赞变化'}).count(),0);
  state.corrupt=false;await page.getByRole('button',{name:'重试点赞历史'}).click();await historyRegion(page).getByRole('heading',{name:'单作品每日点赞变化'}).waitFor();
  await page.getByRole('button',{name:'返回作者作品列表'}).click();state.hold=true;await buttonFor(page,121).click();await page.getByRole('status').filter({hasText:'正在核验此作品的点赞历史'}).waitFor();await until(()=>state.releases.length===1,'second history request is pending');await page.keyboard.press('Escape');await until(()=>state.failed.length===2,'dialog close aborts pending history fetch');f.release();await page.waitForTimeout(50);assert.equal(await page.getByRole('dialog').count(),0);
  await page.getByRole('button',{name:'查看作者作品',exact:true}).click();await page.getByLabel('搜索此作者的全部作品').fill('作品21');await buttonFor(page,121).waitFor();state.hold=true;await buttonFor(page,121).click();await page.getByRole('status').filter({hasText:'正在核验此作品的点赞历史'}).waitFor();
  await until(()=>state.releases.length===1,'version-switch history request is pending');await page.evaluate(()=>window.fixtureNextVersion());await until(()=>state.failed.length===3,'version change aborts the preceding generation fetch');f.release();await page.getByText('共 23 条 · 当前匹配 1 条').waitFor();assert.equal(await historyRegion(page).count(),0);assert.equal(await buttonFor(page,121).count(),0);assert.deepEqual(state.errors,[]);
 }finally{f?.release();await f?.context.close();await browser.close();}
});

test('validly hashed history with a different public work identity is rejected; absent history remains an honest empty state',{timeout:30000},async()=>{
 const browser=await cloudBrowser();let f;
 try{f=await openFixture(browser,{mismatch:true});await f.page.getByLabel('搜索此作者的全部作品').fill('作品21');await buttonFor(f.page,121).click();await f.page.getByRole('alert').filter({hasText:'作品历史与所选作品身份不一致'}).waitFor();assert.equal(await historyRegion(f.page).getByRole('heading',{name:'单作品每日点赞变化'}).count(),0);await f.context.close();
  f=await openFixture(browser,{withoutHistory:true});await f.page.getByLabel('搜索此作者的全部作品').fill('作品21');await buttonFor(f.page,121).click();await historyRegion(f.page).getByText('这条作品尚无点赞采样，不能计算增长。').waitFor();assert.equal(f.state.requests.some(q=>q.part.startsWith('work-metrics/')),false);assert.deepEqual(f.state.errors,[]);
 }finally{f?.release();await f?.context.close();await browser.close();}
});
