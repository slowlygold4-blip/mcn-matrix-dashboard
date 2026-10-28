// The real Home state machine with synthetic publications; no production data,
// collector requests, or mutations are involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const site=fileURLToPath(new URL('../',import.meta.url));
const main=process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../douyin-monitor-workbench/',import.meta.url));
const {chromium}=createRequire(main+'package.json')('playwright-core');
const generations=['2026-10-23T05:00:00.000Z','2026-10-24T05:00:00.000Z','2026-10-25T05:00:00.000Z'];
const observedAt='2026-10-23T03:00:00.000Z';
const latest=Object.fromEntries(['followers','likes','posts'].map((field,index)=>[field,{
 value:[110,210,11][index],date:'2026-10-23',observedAt,sourceChecksum:'a'.repeat(64),
}]));
const account={id:1,label:'合成账号甲',platform:'douyin',enabled:true,boardKeys:['tuantuan'],classification:{theme:{key:'tuantuan',label:'团团'},labels:[{key:'slice',label:'切片'}]},latest};
const point=(date,followers,likes,posts)=>({targetId:1,date,capturedAt:date+'T03:00:00.000Z',followers,followersAt:date+'T03:00:00.000Z',likes,likesAt:date+'T03:00:00.000Z',posts,postsAt:date+'T03:00:00.000Z'});
const shells={
 'account-panel':'export function AccountPanel({request,onReturn,returnLabel}){return <section data-testid="account-detail"><p>锁定版本 {request.generation}</p><button onClick={onReturn}>{returnLabel}</button></section>}',
 'growth-panel':'export function GrowthPanel(){return null}',
 'group-summary':'export function GroupSummary(){return null}',
 'metric-ledger':'export function MetricLedger({metrics}){return <section data-testid="metric-ledger">粉丝总数 {metrics.followers?.value ?? "—"}</section>}',
 'endpoint-sources':'export function EndpointSources(){return null}',
 'coverage-panel':'export function CoveragePanel(){return null}',
 'daily-coverage-panel':'export function DailyCoveragePanel(){return null}',
 'topic-history':'export function TopicHistory(){return null}',
 'tuantuan-roster':'export function TuantuanRosterSummary(){return null};export function TuantuanRosterTable(){return null}',
 'other-source-catalog':'export function OtherSourceCatalog(){return null}',
 'source-operations':'export function SourceOperations(){return null}',
 'creator-source-panel':'import {useState} from "react";export function CreatorSourceLedger({accounts,onOpenAccount,active}){const [query,setQuery]=useState("");return <section data-testid="source-ledger" hidden={!active}><input aria-label="来源检索" value={query} onChange={event=>setQuery(event.target.value)}/>{accounts[0]&&<button onClick={event=>onOpenAccount(accounts[0],event.currentTarget)}>打开关联账号</button>}</section>};export async function readCreatorSourcePart(){throw Error("fixture source unavailable")}',
};
const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import Home from './app/page';window.fixture={viewMode:'complete',viewReads:[]};createRoot(document.getElementById('root')).render(<Home/>);`,resolveDir:site,sourcefile:'auto-adopt-publication-fixture.tsx',loader:'tsx'},absWorkingDir:site,bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',tsconfig:site+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'},plugins:[{name:'publication-fixture',setup(bundle){
 bundle.onLoad({filter:/components\/[^/]+\.tsx$/},args=>{const name=args.path.split('/').at(-1).replace(/\.tsx$/,'');return shells[name]?{contents:shells[name],loader:'tsx',resolveDir:site}:null;});
 bundle.onLoad({filter:/lib\/replica-view\.mjs$/},()=>({contents:`export async function loadReplicaView({manifest,personal,topicsOnly,directoryOnly,signal}){const f=window.fixture;f.viewReads.push(manifest.asOf);signal?.throwIfAborted();if(f.viewMode==='throw')throw Error('synthetic partition failure');const complete=f.viewMode!=='incomplete';return {accounts:[${JSON.stringify(account)}],boards:[{key:'tuantuan',name:'团团'}],topics:{topics:[],items:[]},points:personal||topicsOnly||directoryOnly||!complete?[]:[${JSON.stringify(point('2026-09-12',100,200,10))},{...${JSON.stringify(point('2026-10-23',110,210,11))},followers:manifest.asOf===${JSON.stringify(generations[0])}?110:126}],summaryLoaded:!personal&&!topicsOnly&&!directoryOnly&&complete,summaryError:complete?'':'synthetic incomplete history',dateIndexed:false,topicsLoaded:!directoryOnly};}`,loader:'js'}));
 bundle.onLoad({filter:/lib\/source-part-reader\.mjs$/},()=>({contents:'export async function readSourcePart(){throw Error("fixture source unavailable")};export async function readSourceIndex(){throw Error("fixture source unavailable")};export function sourcePartsIdentity(){return "fixture"}',loader:'js'}));
 bundle.onLoad({filter:/\.css$/},()=>({contents:'',loader:'empty'}));
}}]});

async function openFixture(browser,path){
 const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'}),page=await context.newPage();
 await page.clock.install({time:new Date('2026-10-26T00:00:00.000Z')});
 const controls={published:0,globalResponses:[],apiReads:[],errors:[]};page.setDefaultTimeout(8000);
 page.on('pageerror',error=>controls.errors.push(error.message));
 await page.route('**/*',route=>{const request=route.request(),url=new URL(request.url());if(request.method()!=='GET')return route.abort();
  if(url.pathname==='/api/replica'){const generation=url.searchParams.get('generation'),index=generation?generations.indexOf(generation):controls.globalResponses.length?controls.globalResponses.shift():controls.published;controls.apiReads.push({generation,index});return route.fulfill({json:{manifest:{asOf:generations[index],counts:{enabledAccounts:1},files:[]},publishedAt:generations[index]}});}
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><div id="root"></div>'});return route.abort();
 });
 await page.goto('http://127.0.0.1:49124/'+path);await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.locator('.topbar time').waitFor();return {page,controls,close:()=>context.close()};
}
const waitVersion=async(page,index)=>page.locator('.topbar time[datetime="'+generations[index]+'"]').waitFor();
const nextCheck=async page=>page.clock.fastForward(61_000);

test('new publication is adopted without a click and preserves selected scope and applied dates',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{const fixture=await openFixture(browser,'?board=tuantuan&theme=tuantuan&classification=slice&period=custom&start=2026-09-12&end=2026-10-23#accounts');try{
  const {page,controls}=fixture;await page.getByTestId('metric-ledger').waitFor();controls.published=1;await nextCheck(page);await waitVersion(page,1);
  const url=new URL(page.url());for(const [key,value] of Object.entries({board:'tuantuan',theme:'tuantuan',classification:'slice',period:'custom',start:'2026-09-12',end:'2026-10-23'}))assert.equal(url.searchParams.get(key),value,key);
  assert.match(await page.getByTestId('metric-ledger').innerText(),/126/);assert.equal(await page.getByText(/新的保存数据已发布/).count(),0);
  assert.deepEqual(controls.errors,[]);
 }finally{await fixture.close();}}finally{await browser.close();}
});

test('incomplete publication leaves the previous data and retries only on a later check',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{const fixture=await openFixture(browser,'?rosterPanel=changes&period=custom&start=2026-09-12&end=2026-10-23#accounts');try{
  const {page,controls}=fixture;await page.getByTestId('metric-ledger').waitFor();await page.evaluate(()=>window.fixture.viewMode='incomplete');controls.published=1;await nextCheck(page);
  await page.getByRole('alert').filter({hasText:'保留上次已加载的数据'}).waitFor();assert.equal(await page.locator('.topbar time').getAttribute('datetime'),generations[0]);
  assert.match(await page.getByTestId('metric-ledger').innerText(),/110/);await page.evaluate(()=>window.fixture.viewMode='complete');await nextCheck(page);await waitVersion(page,1);
  assert.match(await page.getByTestId('metric-ledger').innerText(),/126/);assert.deepEqual(controls.errors,[]);
 }finally{await fixture.close();}}finally{await browser.close();}
});

test('a lagging replica response cannot clear the newer announcement or regress the verified edition',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{const fixture=await openFixture(browser,'?rosterPanel=changes&period=custom&start=2026-09-12&end=2026-10-23#accounts');try{
  const {page,controls}=fixture;await page.getByTestId('metric-ledger').waitFor();controls.published=1;controls.globalResponses.push(1,0);await nextCheck(page);
  await page.getByRole('alert').filter({hasText:'新版清单尚未同步'}).waitFor();
  assert.equal(await page.locator('.topbar time').getAttribute('datetime'),generations[0]);
  assert.equal(await page.getByText(/新的保存数据已发布/).count(),1,'the stale response must not dismiss the newer version');
  await nextCheck(page);await waitVersion(page,1);
  assert.match(await page.getByTestId('metric-ledger').innerText(),/126/);assert.deepEqual(controls.errors,[]);
 }finally{await fixture.close();}}finally{await browser.close();}
});

test('a pinned account stays on its share version; returning to source adopts latest without losing source input',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{const fixture=await openFixture(browser,'#source');try{
  const {page,controls}=fixture;await page.getByTestId('source-ledger').waitFor();await page.getByRole('textbox',{name:'来源检索'}).fill('切片作者');
  await page.getByRole('button',{name:'打开关联账号'}).click();await page.getByTestId('account-detail').waitFor();
  controls.published=1;await nextCheck(page);assert.match(await page.getByTestId('account-detail').innerText(),/锁定版本 2026-10-23/);assert.equal(await page.locator('.topbar time').getAttribute('datetime'),generations[0]);
  await page.getByRole('button',{name:'返回原核对页'}).click();await waitVersion(page,1);
  assert.equal(await page.getByRole('textbox',{name:'来源检索'}).inputValue(),'切片作者');assert.match(page.url(),/#source$/);assert.deepEqual(controls.errors,[]);
 }finally{await fixture.close();}}finally{await browser.close();}
});
