// Real Home, TuantuanRosterTable, CreatorSourceLedger and address transitions.
// Account internals and unrelated panels are shells; all data is synthetic and
// every browser request is intercepted. No collector or production server runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {validateDateShard} from '../lib/replica-date-range.mjs';

const site=fileURLToPath(new URL('../',import.meta.url));
const main=process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../douyin-monitor-workbench/',import.meta.url));
const {chromium}=createRequire(main+'package.json')('playwright-core');
const asOf='2026-10-01T05:44:51.113Z',revision='roster-lifecycle-fixture';
const hash=value=>createHash('sha256').update(value).digest('hex');
const descriptor=(path,body,extra={})=>({path,...extra,bytes:Buffer.byteLength(JSON.stringify(body)),sha256:hash(JSON.stringify(body))});
const dates=['2026-09-12','2026-09-23','2026-09-29','2026-09-30'];
const makePoints=targetId=>dates.map((date,index)=>({targetId,date,capturedAt:date+'T03:00:00.000Z',followers:100+index,followersAt:date+'T03:00:00.000Z',likes:200+index,likesAt:date+'T03:00:00.000Z',posts:index,postsAt:date+'T03:00:00.000Z'}));
const points=[...makePoints(1),...makePoints(2)].sort((a,b)=>a.date.localeCompare(b.date)||a.targetId-b.targetId);
const latest=Object.fromEntries(['followers','likes','posts'].map((field,index)=>[field,{value:[103,203,3][index],date:dates.at(-1),observedAt:dates.at(-1)+'T03:00:00.000Z',sourceChecksum:'a'.repeat(64)}]));
const accounts=[1,2].map(id=>({id,label:id===1?'监控账号甲':'暂停账号乙',platform:'douyin',enabled:id===1,boardKeys:['tuantuan'],classification:{theme:{key:'tuantuan',label:'团团'},labels:[{key:'slice',label:'切片'}]},latest}));
const parts={
 'catalog.json':{accounts,boards:[{key:'tuantuan',name:'团团'}]},
 'topics.json':{topics:[],items:[]},
 ...Object.fromEntries(accounts.map(account=>['daily/'+account.id+'.json',{version:1,asOf,timeZone:'Asia/Shanghai',items:makePoints(account.id)}])),
};
const base={asOf,timeZone:'Asia/Shanghai',counts:{enabledAccounts:1,daily:points.length},files:[
 descriptor('catalog.json',parts['catalog.json'],{kind:'catalog',count:accounts.length}),
 descriptor('topics.json',parts['topics.json'],{kind:'topics',count:0}),
 ...accounts.map(account=>descriptor('daily/'+account.id+'.json',parts['daily/'+account.id+'.json'],{kind:'daily',targetId:account.id,count:dates.length})),
]};
const shard=parts['date-summary/000001.json']={version:1,asOf,timeZone:'Asia/Shanghai',items:points};
const shardFile=descriptor('date-summary/000001.json',shard,{count:points.length});
const dateIndex=parts['date-summary-index.json']={version:1,asOf,timeZone:'Asia/Shanghai',format:'date-shards-v1',sourceManifestSha256:hash(JSON.stringify(base)),sourceDaily:base.files.filter(file=>file.kind==='daily').map(({kind,...file})=>file),count:points.length,firstDate:dates[0],lastDate:dates.at(-1),shards:[{...shardFile,firstDate:dates[0],lastDate:dates.at(-1)}]};
const manifest={...base,files:[...base.files,descriptor('date-summary-index.json',dateIndex,{kind:'summaryDateIndex',count:points.length}),{...shardFile,kind:'summaryDateShard'}]};
// A browser navigation assertion must not be masked by an invalid date fixture.
validateDateShard(shard,dateIndex.shards[0],manifest);
const authors=Array.from({length:65},(_,index)=>({row:index+1,name:'合成作者'+String(index+1).padStart(3,'0'),douyinId:'creator-'+index,targetIds:index===31?[1]:index===0?[2]:[],posts:1,plays:index+1,likes:index,slicePosts:1,creationPosts:0,aiPosts:0}));
const works=authors.map((author,index)=>({row:index+1,contentId:String(7300000000000000000n+BigInt(index)),douyinId:author.douyinId,author:author.name,title:'夹具作品'+String(index+1).padStart(3,'0'),publishDate:'2026-09-23',track:'切片',plays:author.plays,likes:author.likes}));
const sourceAuthors={revision,items:authors},sourceWorks={revision,items:works};
const sourceIndex={version:1,revision,importedAt:asOf,stats:{authors:65,works:65,rawAuthorRows:65,reciprocalDuplicates:0},semantics:{plays:'原表累计播放',likes:'原表累计点赞'},tracks:[{name:'切片',works:65}],files:[descriptor('authors.json',sourceAuthors,{count:65}),descriptor('works-001.json',sourceWorks,{count:65})]};
const emptyPart={revision,items:[]},foundationNames=['authors.json','works.json','sources.json','observations.json','other-authors.json','other-works.json'];
const foundationIndex={version:1,revision,generatedAt:asOf,
 stats:{sourceDocuments:0,sourceRows:0,tuantuanRows:0,acceptedRows:0,unkeyedRows:0,ambiguousRows:0,invalidIdentityRows:0,baseAuthorEvidence:0,baseWorkEvidence:0,additionalAuthors:0,additionalWorks:0,otherAuthors:0,otherWorks:0,sourceMetricObservations:0,sourceMetricWorkIds:0,baseAuthorRows:65,reciprocalDuplicates:0,baseAuthors:65,baseWorks:65,sheets:1},
 sheetCoverage:[{id:'fixture-sheet',name:'合成来源表',rows:65,restricted:false}],files:foundationNames.map(name=>descriptor(name,emptyPart,{count:0}))};
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
 'other-source-catalog':'export function OtherSourceCatalog(){return null}',
 'source-operations':'export function SourceOperations({onNavigateAccounts,accountPreview}){return <section data-testid="source-operations">{accountPreview}<div style={{height:1200}}>合成总览占位</div><button onClick={onNavigateAccounts}>查看账号变化</button></section>}',
};
const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import Home from './app/page';window.fixture={reads:[],parts:${JSON.stringify(parts)}};createRoot(document.getElementById('root')).render(<Home/>);`,resolveDir:site,sourcefile:'roster-workspace-lifecycle-fixture.tsx',loader:'tsx'},absWorkingDir:site,bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',tsconfig:site+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'},plugins:[{name:'unrelated-panel-shells',setup(build){
 build.onLoad({filter:/components\/[^/]+\.tsx$/},args=>{const name=args.path.split('/').at(-1).replace(/\.tsx$/,'');return visualShells[name]?{contents:visualShells[name],loader:'tsx',resolveDir:site}:null;});
 build.onLoad({filter:/lib\/replica-reader\.mjs$/},()=>({contents:`export function validateUnifiedWorksPart(items){return items;} export async function readReplicaPart({part,signal}){window.fixture.reads.push(part);signal?.throwIfAborted();if(!(part in window.fixture.parts))throw Error('Unexpected test partition '+part);return structuredClone(window.fixture.parts[part]);}`,loader:'js'}));
 build.onLoad({filter:/\.css$/},()=>({contents:'',loader:'empty'}));
}}]});

const launch=()=>chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
async function openFixture(browser,path,{delayFoundation=false,failSourceAuthors=0}={}){
 const context=await browser.newContext({viewport:{width:1400,height:950},reducedMotion:'reduce'}),page=await context.newPage(),errors=[],requests=[];
 let releaseFoundation;const foundationGate=new Promise(resolve=>{releaseFoundation=resolve;});
 if(!delayFoundation)releaseFoundation();
 page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());requests.push({method:request.method(),path:url.pathname});
  if(request.method()!=='GET')return route.abort();
  if(url.pathname==='/api/replica')return route.fulfill({json:{manifest,publishedAt:asOf}});
  if(url.pathname==='/creator-source/authors.json'&&failSourceAuthors>0){failSourceAuthors--;return route.fulfill({status:503,json:{error:'synthetic author directory unavailable'}});}
  if(url.pathname==='/table-foundation/index.json')await foundationGate;
  if(jsonRoutes[url.pathname])return route.fulfill({json:jsonRoutes[url.pathname]});
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><div id="root"></div>'});
  return route.abort();
 });
 await page.goto('http://127.0.0.1:49119/'+path);await page.addScriptTag({content:bundle.outputFiles[0].text});
 return {context,page,errors,requests,releaseFoundation};
}
const roster=page=>page.locator('.tuantuan-roster-table');
const ledger=page=>page.locator('.source-ledger');
const rosterParams=page=>[...new URL(page.url()).searchParams].filter(([key])=>key.startsWith('roster')&&key!=='rosterStatus').sort(([a],[b])=>a.localeCompare(b));
const noMutations=requests=>assert.ok(requests.every(request=>request.method==='GET'),'navigation and refresh must never trigger collection or another mutation');
const sidebar=page=>page.locator('.sidebar nav');
async function assertSidebar(page,label){
 const nav=sidebar(page),active=nav.locator('[aria-current="page"]');
 assert.equal(await active.count(),1,'exactly one workspace navigation item must identify the current task');
 assert.equal(await nav.getByRole('button',{name:label,exact:true}).getAttribute('aria-current'),'page');
 assert.equal((await active.innerText()).trim(),label);
}
async function historyLength(page){return page.evaluate(()=>window.history.length);}
async function settleFrame(page){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function loaded(page){await page.getByRole('button',{name:'重新读取已保存数据',exact:true}).waitFor();await roster(page).locator('tbody tr').first().waitFor();}
async function secondPage(page){
 const table=roster(page);await loaded(page);
 await table.getByRole('textbox',{name:'搜索团团全部作者'}).fill('合成作者');
 await table.getByRole('combobox',{name:'团团名册排序指标',exact:true}).selectOption('name');
 await table.getByRole('combobox',{name:'团团名册排序顺序',exact:true}).selectOption('asc');
 await table.getByRole('button',{name:'下一页',exact:true}).first().click();
 await table.getByRole('navigation',{name:'团团名册上方分页'}).getByText(/第 2\/3 页/).waitFor();
 assert.equal(new URL(page.url()).searchParams.get('rosterPage'),'2');
}
async function assertSecondPage(page,expected){
 await roster(page).waitFor({state:'visible'});await roster(page).locator('tbody tr').first().waitFor();
 await roster(page).getByRole('navigation',{name:'团团名册上方分页'}).getByText(/第 2\/3 页/).waitFor();
 assert.equal(await roster(page).getByRole('textbox',{name:'搜索团团全部作者'}).inputValue(),'合成作者');
 assert.equal(await roster(page).getByRole('combobox',{name:'团团名册排序指标',exact:true}).inputValue(),'name');
 assert.equal(await roster(page).getByRole('combobox',{name:'团团名册排序顺序',exact:true}).inputValue(),'asc');
 assert.deepEqual(rosterParams(page),expected);
}

test('main navigation marks the actual account route while author directory subtask remains selected',async()=>{
 const browser=await launch();
 try{const {context,page,errors,requests}=await openFixture(browser,'?theme=tuantuan&rosterPanel=authors#accounts');try{
  await loaded(page);
  await page.getByRole('heading',{name:/^全部作者明细/}).waitFor();
  assert.equal(new URL(page.url()).hash,'#accounts');
  await assertSidebar(page,'矩阵账号');
  assert.equal(await page.getByRole('button',{name:/^全部矩阵作者/}).getAttribute('aria-pressed'),'true');
  await sidebar(page).getByRole('button',{name:'作者与作品',exact:true}).click();
  await ledger(page).waitFor({state:'visible'});
  assert.equal(new URL(page.url()).hash,'#source');
  await assertSidebar(page,'作者与作品');
  await page.goBack();
  await roster(page).waitFor({state:'visible'});
  assert.equal(new URL(page.url()).hash,'#accounts');
  await assertSidebar(page,'矩阵账号');
  assert.equal(await page.getByRole('button',{name:/^全部矩阵作者/}).getAttribute('aria-pressed'),'true');
  assert.deepEqual(errors,[]);noMutations(requests);
 }finally{await context.close();}}finally{await browser.close();}
});

test('roster search, order and second page survive source-work and refreshed-account roundtrips',async()=>{
 const browser=await launch();
 try{const {context,page,errors,requests}=await openFixture(browser,'?theme=tuantuan&rosterPanel=authors#accounts');try{
  await secondPage(page);const expected=rosterParams(page),before=await roster(page).locator('tbody').textContent();
  await assertSidebar(page,'矩阵账号');
  await roster(page).getByRole('button',{name:'查看作品 →',exact:true}).first().click();
  const worksDialog=page.getByRole('dialog');await worksDialog.waitFor();
  await worksDialog.getByText('夹具作品031',{exact:true}).waitFor();
  assert.equal(new URL(page.url()).hash,'#accounts','works dialog preserves the roster route');
  await worksDialog.getByRole('button',{name:'Close',exact:true}).click();
  await assertSecondPage(page,expected);assert.equal(await roster(page).locator('tbody').textContent(),before);
  await roster(page).getByRole('button',{name:'监控账号甲 · 查看账号变化',exact:true}).click();
  await page.getByTestId('account-detail').waitFor();
  await assertSidebar(page,'矩阵账号');
  await page.getByRole('button',{name:'重新读取已保存数据',exact:true}).click();
  await page.getByRole('button',{name:'重新读取已保存数据',exact:true}).waitFor();
  await page.getByRole('button',{name:'返回原核对页',exact:true}).click();
  await assertSecondPage(page,expected);assert.equal(await roster(page).locator('tbody').textContent(),before);
  await assertSidebar(page,'矩阵账号');
  assert.deepEqual(errors,[]);noMutations(requests);
 }finally{await context.close();}}finally{await browser.close();}
});

test('sidebar returns to all authors; explicit change task and browser history preserve selection',async()=>{
 const browser=await launch();
 const query=new URLSearchParams({theme:'tuantuan',classification:'slice',period:'custom',start:'2026-09-12',end:'2026-09-30',query:'监控账号甲',sourceQuery:'夹具',rosterPanel:'authors',rosterMode:'source-only'});
 try{const {context,page,errors,requests}=await openFixture(browser,'?'+query+'#accounts');try{
  await secondPage(page);const expected=rosterParams(page),authorUrl=page.url();
  const unrelated=()=>[...new URL(page.url()).searchParams].filter(([key])=>!key.startsWith('roster')).sort(([a],[b])=>a.localeCompare(b));
  const preserved=unrelated(),authorHistory=await historyLength(page);
  await sidebar(page).getByRole('button',{name:'矩阵账号',exact:true}).click();await settleFrame(page);
  assert.equal(await historyLength(page),authorHistory,'reselecting the author directory adds no history');
  assert.equal(page.url(),authorUrl);
  await page.getByRole('button',{name:'只看已采集账号变化',exact:true}).click();
  await page.getByRole('heading',{name:'账号变化',exact:true}).waitFor();
  assert.equal(await roster(page).isVisible(),false);await assertSidebar(page,'矩阵账号');
  assert.equal(new URL(page.url()).searchParams.get('rosterPanel'),'changes');
  assert.deepEqual(rosterParams(page).filter(([k])=>k!=='rosterPanel'),expected.filter(([k])=>k!=='rosterPanel'));
  assert.deepEqual(unrelated(),preserved);
  const changesUrl=page.url(),changesHistory=await historyLength(page);
  assert.equal(changesHistory,authorHistory+1);
  await page.getByRole('button',{name:'只看已采集账号变化',exact:true}).click();await settleFrame(page);
  assert.equal(await historyLength(page),changesHistory);assert.equal(page.url(),changesUrl);
  await page.goBack();await assertSecondPage(page,expected);assert.equal(page.url(),authorUrl);
  await page.goForward();await page.getByRole('heading',{name:'账号变化',exact:true}).waitFor();assert.equal(page.url(),changesUrl);
  await sidebar(page).getByRole('button',{name:'话题数据',exact:true}).click();await assertSidebar(page,'话题数据');
  const topicUrl=page.url();
  await sidebar(page).getByRole('button',{name:'矩阵账号',exact:true}).click();await assertSecondPage(page,expected);
  await assertSidebar(page,'矩阵账号');
  await page.goBack();await assertSidebar(page,'话题数据');assert.equal(page.url(),topicUrl);
  await page.goBack();await page.getByRole('heading',{name:'账号变化',exact:true}).waitFor();
  await page.goBack();await assertSecondPage(page,expected);
  assert.deepEqual(errors,[]);noMutations(requests);
 }finally{await context.close();}}finally{await browser.close();}
});

test('overview account action moves to the page heading while in-page task changes keep focus on their control',async()=>{
 const browser=await launch();
 try{const {context,page,errors,requests}=await openFixture(browser,'?theme=tuantuan#overview');try{
  await page.getByRole('button',{name:'重新读取已保存数据',exact:true}).waitFor();
  const action=page.getByTestId('source-operations').getByRole('button',{name:'查看账号变化',exact:true});
  await action.scrollIntoViewIfNeeded();assert.ok(await page.evaluate(()=>window.scrollY)>0,'the real Home handler must be exercised from a scrolled overview');
  await action.click();await page.getByRole('heading',{name:'账号变化',exact:true}).waitFor();
  await page.waitForFunction(()=>window.scrollY===0&&document.activeElement===document.querySelector('h1'));
  assert.equal(new URL(page.url()).hash,'#accounts');await assertSidebar(page,'矩阵账号');
  await page.getByRole('button',{name:/^全部矩阵作者/}).click();await loaded(page);await settleFrame(page);
  assert.equal(await page.getByRole('button',{name:/^全部矩阵作者/}).evaluate(element=>document.activeElement===element),true,'changing tasks within the account page must not steal focus');
  await assertSidebar(page,'矩阵账号');
  await page.getByRole('button',{name:'只看已采集账号变化',exact:true}).click();await page.getByRole('heading',{name:'账号变化',exact:true}).waitFor();await settleFrame(page);
  assert.equal(await page.getByRole('button',{name:'只看已采集账号变化',exact:true}).evaluate(element=>document.activeElement===element),true);
  await assertSidebar(page,'矩阵账号');assert.deepEqual(errors,[]);noMutations(requests);
 }finally{await context.close();}}finally{await browser.close();}
});

test('author-directory and account-change tasks are mutually exclusive and preserve roster selection',async()=>{
 const browser=await launch();
 try{const {context,page,errors,requests}=await openFixture(browser,'?theme=tuantuan&rosterPanel=authors#accounts');try{
  await secondPage(page);const expected=rosterParams(page);
  assert.equal(await page.getByRole('heading',{name:'账号变化',exact:true}).count(),0);
  assert.equal(await page.getByLabel(/^选择周期/).count(),0,'date controls belong to account changes, not imported author identities');
  await page.getByRole('button',{name:'只看已采集账号变化',exact:true}).click();
  try{await page.getByRole('heading',{name:'账号变化',exact:true}).waitFor();}
  catch(error){
   const directory=site+'output/playwright/roster-workspace-lifecycle';await mkdir(directory,{recursive:true});
   await writeFile(directory+'/task-switch.html',await page.content());
   await writeFile(directory+'/task-switch.json',JSON.stringify({url:page.url(),errors,requests,reads:await page.evaluate(()=>window.fixture.reads),text:await page.locator('body').innerText()},null,2));
   await page.screenshot({path:directory+'/task-switch.png',fullPage:true});throw error;
  }
  assert.equal(await roster(page).isVisible(),false);
  assert.equal(new URL(page.url()).searchParams.get('rosterPanel'),'changes','changes panel remains explicit because the default is all authors');
  await page.getByRole('button',{name:/^全部矩阵作者/}).click();
  await assertSecondPage(page,expected);
  assert.equal(await page.getByRole('heading',{name:'账号变化',exact:true}).count(),0);
  assert.equal(await page.getByLabel(/^选择周期/).count(),0);
  assert.deepEqual(errors,[]);noMutations(requests);
 }finally{await context.close();}}finally{await browser.close();}
});

test('missing supplemental data never clamps a valid saved roster page to an empty page',async()=>{
 const browser=await launch();
 try{const {context,page,errors,requests,releaseFoundation}=await openFixture(browser,'?theme=tuantuan&rosterPanel=authors&rosterQuery=%E5%90%88%E6%88%90%E4%BD%9C%E8%80%85&rosterSort=name&rosterDirection=asc&rosterPage=2#accounts',{delayFoundation:true});try{
  await roster(page).getByText('正在核对团团全部作者名册…',{exact:true}).waitFor();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const expected=rosterParams(page);assert.equal(new URL(page.url()).searchParams.get('rosterPage'),'2');
  assert.equal(await page.getByRole('button',{name:'回到第一页',exact:true}).count(),0,'unknown roster size is not an out-of-range page');
  assert.equal(await roster(page).locator('tbody tr').count(),0);
  releaseFoundation();await assertSecondPage(page,expected);
  assert.deepEqual(errors,[]);noMutations(requests);
 }finally{releaseFoundation();await context.close();}}finally{await browser.close();}
});

test('invalid roster parameters show a recoverable error without silently changing unrelated filters',async()=>{
 const browser=await launch();
 try{const {context,page,errors,requests}=await openFixture(browser,'?theme=tuantuan&classification=slice&rosterPanel=authors&rosterPage=0#accounts');try{
  const table=roster(page);await table.getByRole('alert').filter({hasText:'页码无效'}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('rosterPage'),'0');
  await assertSidebar(page,'矩阵账号');const invalidUrl=page.url();
  await page.getByRole('button',{name:'只看已采集账号变化',exact:true}).click();
  await page.getByRole('heading',{name:'账号变化',exact:true}).waitFor();await assertSidebar(page,'矩阵账号');
  assert.equal(await table.isVisible(),false,'an invalid author page must not block the separate account-change task');
  assert.equal(new URL(page.url()).searchParams.get('rosterPage'),'0','changing task must not silently reset the invalid author selection');
  assert.equal(new URL(page.url()).searchParams.get('rosterPanel'),'changes');
  await page.goBack();await table.getByRole('alert').filter({hasText:'页码无效'}).waitFor();
  assert.equal(page.url(),invalidUrl);await assertSidebar(page,'矩阵账号');
  await table.getByRole('button',{name:'重置名册筛选',exact:true}).click();
  await table.locator('tbody tr').first().waitFor();
  assert.equal(new URL(page.url()).searchParams.get('theme'),'tuantuan');
  assert.equal(new URL(page.url()).searchParams.get('classification'),'slice');
  assert.equal(new URL(page.url()).searchParams.get('rosterPanel')??'authors','authors');
  assert.equal(new URL(page.url()).searchParams.has('rosterPage'),false);
  assert.equal(await table.getByRole('alert').count(),0);
  assert.deepEqual(errors,[]);noMutations(requests);
 }finally{await context.close();}}finally{await browser.close();}
});

test('cold author-work share link keeps works readable and retries only failed author associations',async()=>{
 const browser=await launch();
 const search=new URLSearchParams({theme:'tuantuan',period:'custom',start:'2026-09-12',end:'2026-09-30',sourceView:'works',sourceAuthor:'creator-31',sourceAuthorName:'合成作者032',sourceStart:'2026-09-12',sourceEnd:'2026-09-30'});
 try{const {context,page,errors,requests}=await openFixture(browser,'?'+search+'#source',{failSourceAuthors:1});try{
  const table=ledger(page),authorContext=table.locator('[aria-label="当前作者作品与主页数据"]');
  const retry=page.getByRole('button',{name:'重新读取作者关联',exact:true});
  await retry.waitFor();await table.locator('tbody tr').first().waitFor();
  await authorContext.getByText(/已归档作品 1 ·/).waitFor();
  assert.equal(await table.locator('tbody tr').count(),1);
  assert.match(await table.locator('tbody').textContent(),/夹具作品032/);
  await authorContext.getByText('作者关联信息待核',{exact:true}).waitFor();
  assert.equal(await authorContext.getByText('未关联主页账号',{exact:true}).count(),0,'a failed directory is not proof that no linked account exists');
  assert.equal(await authorContext.getByRole('button',{name:'查看粉丝、点赞变化',exact:true}).count(),0);
  const before=await table.locator('tbody').textContent(),beforeUrl=page.url(),requestStart=requests.length;
  assert.equal(requests.filter(request=>request.path==='/creator-source/authors.json').length,1,'cold work view must request the author directory even without visiting an author table');
  await retry.click();
  const accountLink=authorContext.getByRole('button',{name:'查看粉丝、点赞变化',exact:true});await accountLink.waitFor();
  assert.equal(await retry.count(),0);assert.equal(await authorContext.getByText('作者关联信息待核',{exact:true}).count(),0);
  assert.equal(await table.locator('tbody').textContent(),before,'retry must preserve verified work rows');
  assert.equal(page.url(),beforeUrl,'retry must preserve source author and both date namespaces');
  assert.deepEqual(requests.slice(requestStart).map(request=>request.path),['/creator-source/authors.json'],'association retry must not reload the source index, work partitions or account snapshots');
  await accountLink.click();await page.getByTestId('account-detail').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('account'),'1','the linked target must come from verified author IDs');
  await page.getByRole('button',{name:'返回原核对页',exact:true}).click();
  await table.locator('tbody tr').first().waitFor();assert.equal(await table.locator('tbody').textContent(),before);
  assert.equal(page.url(),beforeUrl);assert.deepEqual(errors,[]);noMutations(requests);
 }finally{await context.close();}}finally{await browser.close();}
});

// Real Home + comparison helper + overview: dates change only after explicit action.
test('missing period endpoints offer a real comparison and apply dates, net change and keyboard focus',async()=>{
 const browser=await launch();
 try{const {context,page,errors,requests}=await openFixture(browser,'?theme=tuantuan&period=custom&start=2026-09-13&end=2026-09-30#overview');try{
  const action=page.getByRole('button',{name:'查看这个可比区间',exact:true});await action.waitFor();
  const before=new URL(page.url());assert.equal(before.searchParams.get('start'),'2026-09-13');assert.equal(before.searchParams.get('end'),'2026-09-30');
  await page.getByText(/2026-09-23 → 2026-09-30 有 1 个启用账号/).waitFor();
  await action.click();await page.waitForFunction(()=>{const q=new URL(location.href).searchParams;return q.get('start')==='2026-09-23'&&q.get('end')==='2026-09-30'&&q.get('period')==='custom'});
  await page.getByRole('button',{name:/粉丝净变化.*\+2/}).waitFor();
  assert.equal(await page.evaluate(()=>document.activeElement?.id),'matrix-growth');
  assert.deepEqual(errors,[]);noMutations(requests);
 }finally{await context.close();}}finally{await browser.close();}
});
