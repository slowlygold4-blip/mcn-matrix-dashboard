// Real Home + CreatorSourceLedger reconciliation and browser events. Account detail
// internals and unrelated visual panels are shells; the parent navigation is real.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const site=fileURLToPath(new URL('../',import.meta.url));
const main=process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../douyin-monitor-workbench/',import.meta.url));
const {chromium}=createRequire(main+'package.json')('playwright-core');
const asOf='2026-10-01T05:44:51.113Z',revision='lifecycle-fixture';
const hash=value=>createHash('sha256').update(value).digest('hex');
const descriptor=(path,body,extra={})=>({path,...extra,bytes:Buffer.byteLength(JSON.stringify(body)),sha256:hash(JSON.stringify(body))});
const dates=['2026-09-12','2026-09-23','2026-09-29','2026-09-30'];
const points=dates.map((date,index)=>({targetId:1,date,capturedAt:date+'T03:00:00.000Z',followers:100+index,followersAt:date+'T03:00:00.000Z',likes:200+index,likesAt:date+'T03:00:00.000Z',posts:index,postsAt:date+'T03:00:00.000Z'}));
const latest=Object.fromEntries(['followers','likes','posts'].map((field,index)=>[field,{value:[103,203,3][index],date:dates.at(-1),observedAt:dates.at(-1)+'T03:00:00.000Z',sourceChecksum:'a'.repeat(64)}]));
const account={id:1,label:'监控账号甲',platform:'douyin',enabled:true,boardKeys:['tuantuan'],classification:{theme:{key:'tuantuan',label:'团团'},labels:[{key:'slice',label:'切片'}]},latest};
const parts={'catalog.json':{accounts:[account],boards:[{key:'tuantuan',name:'团团'}]},'topics.json':{topics:[],items:[]},'daily/1.json':{version:1,asOf,timeZone:'Asia/Shanghai',items:points}};
const base={asOf,timeZone:'Asia/Shanghai',counts:{enabledAccounts:1,daily:points.length},files:[
 descriptor('catalog.json',parts['catalog.json'],{kind:'catalog',count:1}),
 descriptor('topics.json',parts['topics.json'],{kind:'topics',count:0}),
 descriptor('daily/1.json',parts['daily/1.json'],{kind:'daily',targetId:1,count:points.length}),
]};
const shard=parts['date-summary/000001.json']={version:1,asOf,timeZone:'Asia/Shanghai',items:points};
const shardFile=descriptor('date-summary/000001.json',shard,{count:points.length});
const dateIndex=parts['date-summary-index.json']={version:1,asOf,timeZone:'Asia/Shanghai',format:'date-shards-v1',sourceManifestSha256:hash(JSON.stringify(base)),sourceDaily:base.files.filter(f=>f.kind==='daily').map(({kind,...file})=>file),count:points.length,firstDate:dates[0],lastDate:dates.at(-1),shards:[{...shardFile,firstDate:dates[0],lastDate:dates.at(-1)}]};
const manifest={...base,files:[...base.files,descriptor('date-summary-index.json',dateIndex,{kind:'summaryDateIndex',count:points.length}),{...shardFile,kind:'summaryDateShard'}]};
const authors=Array.from({length:65},(_,index)=>({row:index+1,name:'合成作者'+String(index+1).padStart(3,'0'),douyinId:'creator-'+index,targetIds:[1],posts:1,plays:index+1,likes:index,slicePosts:1,creationPosts:0,aiPosts:0}));
const sourceAuthors={revision,items:authors},sourceWorks={revision,items:[]};
const sourceIndex={version:1,revision,importedAt:asOf,stats:{authors:65,works:0,rawAuthorRows:65,reciprocalDuplicates:0},semantics:{plays:'原表累计播放',likes:'原表累计点赞'},tracks:[{name:'切片',works:0}],files:[descriptor('authors.json',sourceAuthors,{count:65}),descriptor('works-001.json',sourceWorks,{count:0})]};
const emptyPart={revision,items:[]},foundationNames=['authors.json','works.json','sources.json','observations.json','other-authors.json','other-works.json'];
const foundationIndex={version:1,revision,stats:{sheets:20,additionalAuthors:0,additionalWorks:0,sourceDocuments:0,sourceMetricObservations:0,otherAuthors:0,otherWorks:0,unkeyedRows:0},sheetCoverage:[],files:foundationNames.map(name=>descriptor(name,emptyPart,{count:0}))};
const jsonRoutes={'/creator-source/index.json':sourceIndex,'/creator-source/authors.json':sourceAuthors,'/creator-source/works-001.json':sourceWorks,'/table-foundation/index.json':foundationIndex,...Object.fromEntries(foundationNames.map(name=>['/table-foundation/'+name,emptyPart]))};

const visualShells={
 'account-panel':'export function AccountPanel({onReturn,returnLabel}){return <section data-testid="account-detail"><button onClick={onReturn}>{returnLabel}</button></section>}',
 'growth-panel':'export function GrowthPanel(){return null}',
 'group-summary':'export function GroupSummary(){return null}',
 'metric-ledger':'export function MetricLedger(){return null}',
 'endpoint-sources':'export function EndpointSources(){return null}',
 'coverage-panel':'export function CoveragePanel(){return null}',
 'daily-coverage-panel':'export function DailyCoveragePanel(){return null}',
 'topic-history':'export function TopicHistory(){return null}',
 'tuantuan-roster':'export function TuantuanRosterSummary(){return null};export function TuantuanRosterTable(){return null}',
 'other-source-catalog':'export function OtherSourceCatalog({accounts,onOpenAccount}){return accounts?.length?<button onClick={event=>onOpenAccount(accounts[0],event.currentTarget)}>夹具补充来源账号详情</button>:null}',
 'source-operations':'export function SourceOperations(){return null}',
};
const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import Home from './app/page';window.fixture={reads:[],parts:${JSON.stringify(parts)},catalogGate:new Promise(resolve=>window.releaseCatalog=resolve)};createRoot(document.getElementById('root')).render(<Home/>);`,resolveDir:site,sourcefile:'source-workspace-lifecycle-fixture.tsx',loader:'tsx'},absWorkingDir:site,bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',tsconfig:site+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'},plugins:[{name:'unrelated-panel-shells',setup(build){
 build.onLoad({filter:/components\/[^/]+\.tsx$/},args=>{const name=args.path.split('/').at(-1).replace(/\.tsx$/,'');return visualShells[name]?{contents:visualShells[name],loader:'tsx',resolveDir:site}:null;});
 build.onLoad({filter:/lib\/replica-reader\.mjs$/},()=>({contents:`export function validateUnifiedWorksPart(items){return items;} export async function readReplicaPart({part,signal}){window.fixture.reads.push(part);if(part==='catalog.json')await window.fixture.catalogGate;signal?.throwIfAborted();if(!(part in window.fixture.parts))throw Error('Unexpected test partition '+part);return structuredClone(window.fixture.parts[part]);}`,loader:'js'}));
 build.onLoad({filter:/\.css$/},()=>({contents:'',loader:'empty'}));
}}]});

async function openFixture(browser,path){
 const context=await browser.newContext({viewport:{width:1400,height:950},reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
 page.setDefaultTimeout(8000);
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.pathname==='/api/replica')return route.fulfill({json:{manifest,publishedAt:asOf}});if(jsonRoutes[url.pathname])return route.fulfill({json:jsonRoutes[url.pathname]});if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><div id="root"></div>'});return route.abort();});
 await page.goto('http://127.0.0.1:49117/'+path);
 await page.addScriptTag({content:bundle.outputFiles[0].text});
 return {context,page,errors};
}
const savedReadCount=page=>page.evaluate(()=>window.fixture.reads.filter(part=>part==='summary.json'||part.startsWith('date-summary')).length);
const sourceLedger=page=>page.locator('.source-ledger');
const waitLoaded=page=>page.getByRole('button',{name:'重新读取已保存数据',exact:true}).waitFor();
const nextSourcePage=async page=>{await sourceLedger(page).getByRole('button',{name:'下一页',exact:true}).first().click();await sourceLedger(page).locator('.source-pager').first().getByText(/第 2\/3 页/).waitFor();};

test('source workspace survives delayed catalog, tab changes, and account roundtrips without remounting',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{const {context,page,errors}=await openFixture(browser,'?period=custom&start=2026-09-12&end=2026-09-30#source');try{
  const ledger=sourceLedger(page),search=ledger.getByRole('textbox',{name:'搜索来源作者或作品'});
  await ledger.locator('tbody tr').first().waitFor();
  await search.fill('合成作者');
  await ledger.getByLabel(/^排序/).selectOption('row');
  await nextSourcePage(page);
  const before=await ledger.locator('tbody').textContent();
  await ledger.evaluate(element=>window.ledgerBefore=element);
  await page.evaluate(()=>window.releaseCatalog());await waitLoaded(page);
  assert.equal(await page.evaluate(()=>window.ledgerBefore===document.querySelector('.source-ledger')),true,'catalog arrival must retain the mounted ledger');
  assert.equal(await ledger.count(),1,'only one ledger may be mounted');
  assert.equal(await search.inputValue(),'合成作者');
  assert.match(await ledger.locator('.source-pager').first().textContent(),/第 2\/3 页/);
  assert.equal(new URL(page.url()).searchParams.get('sourceQuery'),'合成作者');
  assert.equal(new URL(page.url()).searchParams.get('sourcePage'),'2');
  assert.equal(await savedReadCount(page),0,'opening the source ledger must not read unrelated account date history');
  // The same list gets live account links when catalog metadata arrives.
  const accountLink=ledger.getByRole('button',{name:'监控账号甲 · 主页采样',exact:true}).first();
  await accountLink.evaluate(element=>window.accountReturnTrigger=element);
  await accountLink.click();
  await page.getByTestId('account-detail').waitFor();
  assert.equal(await ledger.count(),1);assert.equal(await ledger.isVisible(),false);
  await page.getByRole('button',{name:'返回原核对页',exact:true}).click();
  await ledger.waitFor({state:'visible'});
  await page.waitForFunction(()=>document.activeElement===window.accountReturnTrigger);
  assert.equal(await page.evaluate(()=>window.ledgerBefore===document.querySelector('.source-ledger')),true);
  assert.equal(await search.inputValue(),'合成作者');
  assert.match(await ledger.locator('.source-pager').first().textContent(),/第 2\/3 页/);
  assert.equal(new URL(page.url()).searchParams.get('sourceQuery'),'合成作者');
  assert.equal(new URL(page.url()).searchParams.get('sourcePage'),'2');
  assert.match(page.url(),/#source$/);
  const reads=await savedReadCount(page);
  await page.locator('.sidebar').getByRole('button',{name:'话题数据',exact:true}).click();
  await page.getByRole('heading',{name:'话题数据',exact:true}).waitFor();
  assert.equal(await ledger.count(),1);assert.equal(await ledger.isVisible(),false);
  await page.locator('.sidebar').getByRole('button',{name:'作者与作品',exact:true}).click();
  await ledger.waitFor({state:'visible'});
  assert.equal(await page.evaluate(()=>window.ledgerBefore===document.querySelector('.source-ledger')),true);
  assert.equal(await search.inputValue(),'合成作者');
  assert.match(await ledger.locator('.source-pager').first().textContent(),/第 2\/3 页/);
  assert.equal(await ledger.locator('tbody').textContent(),before.replaceAll('已关联 #1','监控账号甲 · 主页采样'));
  assert.equal(await savedReadCount(page),reads);
  // Source-return contains its own Chinese search/page namespace. Opening an
  // account from another source component must preserve the whole nested view.
  await ledger.getByRole('button',{name:'查看此作者的来源作品 →',exact:true}).first().click();
  await ledger.getByRole('button',{name:'返回作者记录',exact:true}).waitFor();
  const nested=new URL(page.url()).searchParams.get('sourceReturn');
  assert.equal(new URLSearchParams(nested).get('sourceQuery'),'合成作者');
  assert.equal(new URLSearchParams(nested).get('sourcePage'),'2');
  const nestedSourceParams=[...new URL(page.url()).searchParams].filter(([key])=>key.startsWith('source'));
  await page.getByRole('button',{name:'夹具补充来源账号详情',exact:true}).click();
  await page.getByTestId('account-detail').waitFor();
  await page.getByRole('button',{name:'返回原核对页',exact:true}).click();
  await ledger.getByRole('button',{name:'返回作者记录',exact:true}).waitFor();
  assert.deepEqual([...new URL(page.url()).searchParams].filter(([key])=>key.startsWith('source')),nestedSourceParams);
  await ledger.getByRole('button',{name:'返回作者记录',exact:true}).click();
  await ledger.locator('.source-pager').first().getByText(/第 2\/3 页/).waitFor();
  assert.equal(await search.inputValue(),'合成作者');
  const rememberedSource=[...new URL(page.url()).searchParams].filter(([key])=>key.startsWith('source'));
  await accountLink.click();await page.getByTestId('account-detail').waitFor();
  await page.goBack();await ledger.waitFor({state:'visible'});
  assert.equal(await search.inputValue(),'合成作者');
  assert.match(await ledger.locator('.source-pager').first().textContent(),/第 2\/3 页/);
  await page.goForward();await page.getByTestId('account-detail').waitFor();
  // Leaving detail through the sidebar must keep the prior source namespace,
  // not leave stale on-screen filters behind an address that refreshes to defaults.
  await page.locator('.sidebar').getByRole('button',{name:'矩阵账号',exact:true}).click();await waitLoaded(page);
  await page.locator('.sidebar').getByRole('button',{name:'作者与作品',exact:true}).click();
  await ledger.waitFor({state:'visible'});
  assert.deepEqual([...new URL(page.url()).searchParams].filter(([key])=>key.startsWith('source')),rememberedSource,'detail sidebar navigation must preserve the exact source filter address');
  assert.equal(await search.inputValue(),'合成作者');
  assert.match(await ledger.locator('.source-pager').first().textContent(),/第 2\/3 页/);
  assert.equal(await page.evaluate(()=>window.ledgerBefore===document.querySelector('.source-ledger')),true);
  assert.deepEqual(errors,[]);
 }finally{await context.close();}}finally{await browser.close();}
});

test('directory-only source startup loads topics on first visit without requesting global history',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{const {context,page,errors}=await openFixture(browser,'#source');try{
  await page.evaluate(()=>window.releaseCatalog());await waitLoaded(page);
  await sourceLedger(page).locator('tbody tr').first().waitFor();
  assert.deepEqual(await page.evaluate(()=>window.fixture.reads),['catalog.json'],'source startup only needs account links');
  await page.locator('.sidebar').getByRole('button',{name:'话题数据',exact:true}).click();
  await page.getByRole('heading',{name:'话题数据',exact:true}).waitFor();await waitLoaded(page);
  assert.equal(await page.evaluate(()=>window.fixture.reads.filter(part=>part==='topics.json').length),1,'topics must be loaded despite an existing source catalog');
  assert.equal(await savedReadCount(page),0);
  await page.locator('.sidebar').getByRole('button',{name:'作者与作品',exact:true}).click();
  await sourceLedger(page).waitFor({state:'visible'});
  await page.locator('.sidebar').getByRole('button',{name:'话题数据',exact:true}).click();
  await page.getByRole('heading',{name:'话题数据',exact:true}).waitFor();await waitLoaded(page);
  assert.equal(await page.evaluate(()=>window.fixture.reads.filter(part=>part==='topics.json').length),1,'already-loaded topic metadata should be reused');
  assert.equal(await savedReadCount(page),0);
  assert.deepEqual(errors,[]);
 }finally{await context.close();}}finally{await browser.close();}
});

test('account day/week/month controls still load exact ranges; source navigation does not load date summaries',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{const {context,page,errors}=await openFixture(browser,'?rosterPanel=changes&period=custom&start=2026-09-12&end=2026-09-30#accounts');try{
  await page.evaluate(()=>window.releaseCatalog());await waitLoaded(page);
  const periods=page.getByLabel(/^选择周期/);await periods.waitFor();
  for(const [period,start,end] of [['day','2026-09-29','2026-09-30'],['week','2026-09-23','2026-09-30'],['month','2026-09-30','2026-10-01']]){
   await periods.selectOption(period);await page.getByRole('button',{name:'应用周期',exact:true}).click();
   await page.waitForFunction(({start,end})=>new URLSearchParams(location.search).get('start')===start&&new URLSearchParams(location.search).get('end')===end,{start,end});
   assert.ok((await savedReadCount(page))>0);
   assert.match(await page.locator('.period-state').textContent(),new RegExp(start+' → '+end));
  }
  await page.locator('.sidebar').getByRole('button',{name:'作者与作品',exact:true}).click();
  await sourceLedger(page).locator('tbody tr').first().waitFor();
  const before=await savedReadCount(page);
  await page.evaluate(()=>{const url=new URL(location.href);url.searchParams.set('period','custom');url.searchParams.set('start','2026-09-12');url.searchParams.set('end','2026-09-23');history.pushState(null,'',url);dispatchEvent(new PopStateEvent('popstate'));});
  await page.waitForFunction(()=>document.querySelector('h1')?.textContent==='作者与作品');
  // Settle effects and microtasks without starting collection or touching real data.
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await savedReadCount(page),before,'source route must suspend account-range fetching even if workspace date parameters change');
  assert.equal(await sourceLedger(page).count(),1);
  assert.deepEqual(errors,[]);
 }finally{await context.close();}}finally{await browser.close();}
});
