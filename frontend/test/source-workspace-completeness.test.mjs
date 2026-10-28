// Real Home + CreatorSourceLedger with synthetic, integrity-checked table files.
// Browser tests run serially in one Chrome; no production requests or writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {validateTableFoundationManifest} from '../lib/table-foundation-manifest.mjs';

const site=fileURLToPath(new URL('../',import.meta.url));
const main=process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../douyin-monitor-workbench/',import.meta.url));
const {chromium}=createRequire(main+'package.json')('playwright-core');
const asOf='2026-10-01T05:44:51.113Z',revision='completeness-fixture';
const hash=value=>createHash('sha256').update(value).digest('hex');
const descriptor=(path,body,extra={})=>({path,...extra,bytes:Buffer.byteLength(JSON.stringify(body)),sha256:hash(JSON.stringify(body))});
const latest=Object.fromEntries(['followers','likes','posts'].map((field,index)=>[field,{value:[103,203,3][index],date:'2026-09-30',observedAt:'2026-09-30T03:00:00.000Z',sourceChecksum:'a'.repeat(64)}]));
const account={id:1,label:'监控账号甲',platform:'douyin',enabled:true,boardKeys:['tuantuan'],classification:{theme:{key:'tuantuan',label:'团团'},labels:[{key:'slice',label:'切片'}]},latest};
const parts={'catalog.json':{accounts:[account],boards:[{key:'tuantuan',name:'团团'}]},'topics.json':{topics:[],items:[]}};
const manifest={asOf,timeZone:'Asia/Shanghai',counts:{enabledAccounts:1,daily:0},files:[descriptor('catalog.json',parts['catalog.json'],{kind:'catalog',count:1}),descriptor('topics.json',parts['topics.json'],{kind:'topics',count:0})]};

const author=(name,id,index)=>({row:index+1,name,douyinId:id,targetIds:index===0?[1]:[],posts:1,plays:index+1,likes:index,slicePosts:1,creationPosts:0,aiPosts:0,cupPosts:0});
const authors=Array.from({length:65},(_,index)=>author('合成作者'+String(index+1).padStart(3,'0'),'creator-'+index,index));
const revisedAuthors=authors.map((row,index)=>index===31?{...row,name:'合成作者032修订',plays:888}:row);
const works=[{row:1,contentId:'fixture-main-1',title:'总表作品甲',author:authors[0].name,douyinId:authors[0].douyinId,publishDate:'2026-09-20',track:'切片',plays:100,likes:5},{row:2,contentId:'fixture-main-2',title:'总表作品乙',author:authors[1].name,douyinId:authors[1].douyinId,publishDate:'2026-09-21',track:'切片',plays:null,likes:null}];
const sourceParts={original:{revision,items:authors},revised:{revision,items:revisedAuthors}};
const sourceWorks={revision,items:works};
const makeSourceIndex=variant=>({version:1,revision,importedAt:asOf,stats:{authors:65,works:2,rawAuthorRows:65,reciprocalDuplicates:0},semantics:{plays:'原表累计播放',likes:'原表累计点赞'},tracks:[{name:'切片',works:2}],files:[descriptor('authors.json',sourceParts[variant],{count:65}),descriptor('works-001.json',sourceWorks,{count:2})]});
const additionalAuthors=[{...author('补表专属作者甲','supplement-a',65),evidenceRows:1,sourceTitles:['合成补表']},{...author('跨表新增作者乙','supplement-b',66),evidenceRows:1,sourceTitles:['合成补表']}];
const additionalWorks=[{row:1,contentId:'fixture-supplement-1',title:'补表专属作品甲',author:additionalAuthors[0].name,douyinId:'supplement-a',publishDate:'2026-09-22',track:'切片',plays:300,likes:15,evidenceRows:1,sourceTitles:['合成补表']}];
const foundationNames=['authors.json','works.json','sources.json','observations.json','other-authors.json','other-works.json'];
const foundationParts=Object.fromEntries(foundationNames.map(name=>[name,{revision,items:name==='authors.json'?additionalAuthors:name==='works.json'?additionalWorks:[]}]));
const countFields=['sourceDocuments','sourceRows','tuantuanRows','acceptedRows','unkeyedRows','ambiguousRows','invalidIdentityRows','baseAuthorEvidence','baseWorkEvidence','additionalAuthors','additionalWorks','otherAuthors','otherWorks','sourceMetricObservations','sourceMetricWorkIds','baseAuthorRows','reciprocalDuplicates','baseAuthors','baseWorks','sheets'];
const foundationIndex={version:1,revision,generatedAt:asOf,stats:{...Object.fromEntries(countFields.map(key=>[key,0])),sheets:1,additionalAuthors:2,additionalWorks:1,baseAuthors:65,baseWorks:2,baseAuthorRows:65},sheetCoverage:[{id:'fixture-sheet',name:'合成补表',rows:3,restricted:false}],files:foundationNames.map(name=>descriptor(name,foundationParts[name],{count:foundationParts[name].items.length}))};
// Keep the harness honest: a bad manifest must not masquerade as a simulated
// transport failure and accidentally pass incomplete-data assertions.
validateTableFoundationManifest(foundationIndex);

const shells={
 'account-panel':'export function AccountPanel({onReturn,returnLabel}){return <section data-testid="account-detail"><button onClick={onReturn}>{returnLabel}</button></section>}',
 'growth-panel':'export function GrowthPanel(){return null}',
 'group-summary':'export function GroupSummary(){return null}',
 'metric-ledger':'export function MetricLedger(){return null}',
 'endpoint-sources':'export function EndpointSources(){return null}',
 'coverage-panel':'export function CoveragePanel(){return null}',
 'daily-coverage-panel':'export function DailyCoveragePanel(){return null}',
 'topic-history':'export function TopicHistory(){return null}',
 'tuantuan-roster':'export function TuantuanRosterSummary(){return null};export function TuantuanRosterTable(){return null}',
 'other-source-catalog':'export function OtherSourceCatalog(){return null}',
 'source-operations':'export function SourceOperations(){return null}',
};
const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import Home from './app/page';window.fixture={reads:[],exports:[],parts:${JSON.stringify(parts)}};URL.createObjectURL=blob=>{window.fixture.exports.push(blob);return 'blob:http://127.0.0.1:49118/test-export'};URL.revokeObjectURL=()=>{};HTMLAnchorElement.prototype.click=function(){if(!this.download)throw Error('Unexpected fixture anchor navigation')};createRoot(document.getElementById('root')).render(<Home/>);`,resolveDir:site,sourcefile:'source-workspace-completeness-fixture.tsx',loader:'tsx'},absWorkingDir:site,bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',tsconfig:site+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'},plugins:[{name:'completeness-browser-fixture',setup(build){
 build.onLoad({filter:/components\/[^/]+\.tsx$/},args=>{const name=args.path.split('/').at(-1).replace(/\.tsx$/,'');return shells[name]?{contents:shells[name],loader:'tsx',resolveDir:site}:null;});
 build.onLoad({filter:/lib\/replica-reader\.mjs$/},()=>({contents:`export function validateUnifiedWorksPart(items){return items;} export async function readReplicaPart({part,signal}){window.fixture.reads.push(part);signal?.throwIfAborted();if(!(part in window.fixture.parts))throw Error('Unexpected account history request '+part);return structuredClone(window.fixture.parts[part]);}`,loader:'js'}));
 build.onLoad({filter:/\.css$/},()=>({contents:'',loader:'empty'}));
}}]});

function deferred(){let release;const promise=new Promise(resolve=>release=resolve);return {promise,release};}
async function openFixture(browser,{path='#source',mode='ready',failedPart='works.json'}={}){
 const context=await browser.newContext({viewport:{width:1400,height:950},reducedMotion:'reduce'}),page=await context.newPage();
 const controls={mode,failedPart,variant:'original',requests:[],errors:[],gate:deferred()};
 page.setDefaultTimeout(8000);
 page.on('pageerror',error=>controls.errors.push(error.message));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());controls.requests.push({path:url.pathname,method:request.method()});
  if(url.origin!=='http://127.0.0.1:49118'||request.method()!=='GET')return route.abort();
  if(url.pathname==='/api/replica')return route.fulfill({json:{manifest,publishedAt:asOf}});
  if(url.pathname==='/creator-source/index.json')return route.fulfill({json:makeSourceIndex(controls.variant)});
  if(url.pathname==='/creator-source/authors.json')return route.fulfill({json:sourceParts[controls.variant]});
  if(url.pathname==='/creator-source/works-001.json')return route.fulfill({json:sourceWorks});
  if(url.pathname==='/table-foundation/index.json')return route.fulfill({json:foundationIndex});
  if(url.pathname.startsWith('/table-foundation/')){
   const name=url.pathname.split('/').at(-1),part=foundationParts[name];if(!part)return route.abort();
   if(name===controls.failedPart){
    if(controls.mode==='delay')await controls.gate.promise;
    if(controls.mode==='503')return route.fulfill({status:503,body:'synthetic unavailable partition'});
    if(controls.mode==='corrupt')return route.fulfill({json:{...part,items:[]}});
   }
   return route.fulfill({json:part}).catch(()=>{});
  }
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><div id="root"></div>'});
  return route.abort();
 });
 await page.goto('http://127.0.0.1:49118/'+path);
 await page.addScriptTag({content:bundle.outputFiles[0].text});
 return {page,controls,close:async()=>{controls.gate.release();await context.close();}};
}
const ledger=page=>page.locator('.source-ledger');
const exportButton=page=>ledger(page).getByRole('button',{name:/^导出(?:全部|总表)筛选结果$/});
const completeness=page=>ledger(page).getByLabel('补充表读取状态',{exact:true});
const search=page=>ledger(page).getByRole('textbox',{name:'搜索来源作者或作品'});
const refresh=page=>page.getByRole('button',{name:'重新读取已保存数据',exact:true});
const requestCount=(controls,path)=>controls.requests.filter(request=>request.path===path).length;
async function settle(page){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function expectNoCollectionOrGlobalHistory(page,controls){
 assert.ok(controls.requests.every(request=>request.method==='GET'),'table reading must not start a collection or mutate data');
 assert.deepEqual(await page.evaluate(()=>[...new Set(window.fixture.reads)]),['catalog.json'],'source operations must not load global account history or topics');
 assert.deepEqual(controls.errors,[]);
}
async function exportText(page){await exportButton(page).click();return page.evaluate(()=>window.fixture.exports.at(-1).text());}

test('source workspace exposes completeness and retries without losing the source task',{timeout:90000},async t=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{
  await t.test('slow supplement retains searchable main rows but cannot export them as the full result',async()=>{
   const fixture=await openFixture(browser,{mode:'delay'}),{page,controls}=fixture;
   try{
    await ledger(page).locator('tbody tr').first().waitFor();
    assert.equal(await exportButton(page).isDisabled(),true);
    assert.match(await completeness(page).innerText(),/补充表正在读取，目前仅显示已验证的总表/);
    await search(page).fill('作者');await ledger(page).getByLabel(/^排序/).selectOption('row');
    await ledger(page).getByRole('button',{name:'下一页',exact:true}).first().click();
    assert.match(await ledger(page).locator('.source-pager').first().innerText(),/第 2\/3 页/);
    await ledger(page).evaluate(element=>window.fixture.ledger=element);
    controls.gate.release();
    await page.waitForFunction(()=>!document.querySelector('.source-actions button')?.disabled);
    await settle(page);
    assert.match(await ledger(page).locator('.source-pager').first().innerText(),/67 条.*第 2\/3 页/);
    assert.equal(await search(page).inputValue(),'作者');
    assert.equal(new URL(page.url()).searchParams.get('sourcePage'),'2');
    assert.equal(await page.evaluate(()=>window.fixture.ledger===document.querySelector('.source-ledger')),true);
    const csv=await exportText(page);
    assert.equal(csv.trim().split(/\r?\n/).length,68,'CSV must include every filtered page plus its header');
    assert.match(csv,/补表专属作者甲/);assert.match(csv,/跨表新增作者乙/);
    await expectNoCollectionOrGlobalHistory(page,controls);
   }finally{await fixture.close();}
  });

  await t.test('failed supplement has an explicit retry that restores all rows and does not reset the query',async()=>{
   const fixture=await openFixture(browser,{mode:'503'}),{page,controls}=fixture;
   try{
    const retry=page.getByRole('button',{name:'重新读取补充表',exact:true});await retry.waitFor();
    await ledger(page).locator('tbody tr').first().waitFor();
    assert.equal(await exportButton(page).isDisabled(),true);
    await search(page).fill('补表专属');
    assert.match(await completeness(page).innerText(),/补充表暂未读到，目前仅显示已验证的总表/);
    assert.equal(await ledger(page).getByText('没有符合当前条件的记录。可清除日期、调整赛道或搜索内容后再试。',{exact:true}).count(),0,'an unread supplement cannot support a definitive no-match conclusion');
    const indexReads=requestCount(controls,'/table-foundation/index.json'),catalogReads=await page.evaluate(()=>window.fixture.reads.length);
    controls.mode='ready';await retry.click();
    await ledger(page).locator('tbody tr').filter({hasText:'补表专属作者甲'}).waitFor();
    assert.ok(requestCount(controls,'/table-foundation/index.json')>indexReads);
    assert.equal(await search(page).inputValue(),'补表专属');
    assert.equal(new URL(page.url()).searchParams.get('sourceQuery'),'补表专属');
    assert.equal(await exportButton(page).isEnabled(),true);
    assert.equal(await page.evaluate(()=>window.fixture.reads.length),catalogReads,'the supplement retry must not reload unrelated account metadata');
    assert.equal(await retry.count(),0);
    assert.equal((await exportText(page)).trim().split(/\r?\n/).length,2);
    await expectNoCollectionOrGlobalHistory(page,controls);
   }finally{await fixture.close();}
  });

  await t.test('a supplement-only match is not declared absent while pending; explicit main-table works may export',async()=>{
   const fixture=await openFixture(browser,{mode:'delay',path:'?sourceView=works&sourceMainOnly=1#source'}),{page,controls}=fixture;
   try{
    await ledger(page).locator('tbody tr').first().waitFor();
    await ledger(page).getByRole('button',{name:'仅总表作品 ×',exact:true}).waitFor();
    assert.equal(await ledger(page).getByRole('button',{name:'导出总表筛选结果',exact:true}).count(),1);
    assert.equal(await exportButton(page).isEnabled(),true,'the clearly selected main-table scope is independently complete');
    const mainCsv=await exportText(page);assert.equal(mainCsv.trim().split(/\r?\n/).length,3);assert.doesNotMatch(mainCsv,/补表专属作品甲/);
    await ledger(page).getByRole('button',{name:'仅总表作品 ×',exact:true}).click();
    assert.equal(await exportButton(page).isDisabled(),true,'including supplements returns to incomplete status');
    await search(page).fill('补表专属作品');
    assert.equal(await ledger(page).getByText('没有符合当前条件的记录。可清除日期、调整赛道或搜索内容后再试。',{exact:true}).count(),0);
    assert.match(await completeness(page).innerText(),/补充表正在读取/);
    controls.gate.release();
    await ledger(page).locator('tbody tr').filter({hasText:'补表专属作品甲'}).waitFor();
    assert.equal(await search(page).inputValue(),'补表专属作品');
    assert.equal(await exportButton(page).isEnabled(),true);
    assert.equal(new URL(page.url()).searchParams.get('sourceQuery'),'补表专属作品');
    assert.equal((await exportText(page)).trim().split(/\r?\n/).length,2);
    await expectNoCollectionOrGlobalHistory(page,controls);
   }finally{await fixture.close();}
  });

  await t.test('refresh invalidates old supplement completeness and rereads changed author hashes within the same revision',async()=>{
   const fixture=await openFixture(browser),{page,controls}=fixture;
   try{
    await ledger(page).locator('.source-pager').first().getByText(/67 条/).waitFor();
    await search(page).fill('合成作者032');
    await ledger(page).locator('tbody tr').filter({hasText:'合成作者032'}).waitFor();
    assert.equal(await exportButton(page).isEnabled(),true);
    const mainReads=requestCount(controls,'/creator-source/authors.json'),supplementReads=requestCount(controls,'/table-foundation/index.json');
    controls.variant='revised';controls.mode='corrupt';
    await refresh(page).click();
    await page.getByRole('button',{name:'重新读取补充表',exact:true}).waitFor();
    await ledger(page).locator('tbody tr').filter({hasText:'合成作者032修订'}).waitFor();
    assert.ok(requestCount(controls,'/creator-source/authors.json')>mainReads,'revision text is not sufficient to cache a changed author file');
    assert.ok(requestCount(controls,'/table-foundation/index.json')>supplementReads,'top-level refresh must reload table indices too');
    assert.equal(await search(page).inputValue(),'合成作者032');
    assert.equal(await exportButton(page).isDisabled(),true,'previous successful supplement load cannot make this failed refresh look complete');
    await search(page).fill('补表专属作者甲');
    assert.equal(await ledger(page).locator('tbody tr').filter({hasText:'补表专属作者甲'}).count(),0,'a failed new manifest must not silently reuse old supplement rows');
    assert.match(await completeness(page).innerText(),/补充表暂未读到/);
    controls.mode='ready';await page.getByRole('button',{name:'重新读取补充表',exact:true}).click();
    await ledger(page).locator('tbody tr').filter({hasText:'补表专属作者甲'}).waitFor();
    assert.equal(await exportButton(page).isEnabled(),true);
    await expectNoCollectionOrGlobalHistory(page,controls);
   }finally{await fixture.close();}
  });

  await t.test('refresh inside account detail restores the same source workspace instead of leaving its index pending',async()=>{
   const fixture=await openFixture(browser),{page,controls}=fixture;
   try{
    await ledger(page).locator('.source-pager').first().getByText(/67 条/).waitFor();
    await search(page).fill('合成作者001');
    await ledger(page).getByRole('button',{name:'监控账号甲 · 主页采样',exact:true}).click();
    await page.getByTestId('account-detail').waitFor();
    const indexReads=requestCount(controls,'/creator-source/index.json');
    await refresh(page).click();await refresh(page).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('account'),'1');
    assert.equal(requestCount(controls,'/creator-source/index.json'),indexReads,'the private-account route must not fetch the unrelated source index');
    await page.getByRole('button',{name:'返回原核对页',exact:true}).click();
    await ledger(page).locator('tbody tr').filter({hasText:'合成作者001'}).waitFor();
    assert.ok(requestCount(controls,'/creator-source/index.json')>indexReads,'returning to the same source tab must reload its cleared index');
    assert.equal(await search(page).inputValue(),'合成作者001');
    assert.equal(new URL(page.url()).searchParams.get('sourceQuery'),'合成作者001');
    assert.match(page.url(),/#source$/);
    assert.equal(await exportButton(page).isEnabled(),true);
    assert.ok(controls.requests.every(request=>request.method==='GET'));
    assert.equal(await page.evaluate(()=>window.fixture.reads.some(part=>part==='summary.json'||part.startsWith('date-summary'))),false);
    assert.deepEqual(controls.errors,[]);
   }finally{await fixture.close();}
  });
 }finally{await browser.close();}
});
