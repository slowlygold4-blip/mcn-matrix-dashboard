// Real Home response handling with synthetic account observations. Every request
// is intercepted; this test never contacts the collector or production data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const site=fileURLToPath(new URL('../',import.meta.url));
const main=process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../douyin-monitor-workbench/',import.meta.url));
const {chromium}=createRequire(main+'package.json')('playwright-core');
const asOf='2026-10-23T05:00:00.000Z';
const observedAt='2026-10-23T03:00:00.000Z';
const latest=Object.fromEntries(['followers','likes','posts'].map((field,index)=>[field,{
 value:[110,210,11][index],date:'2026-10-23',observedAt,sourceChecksum:'a'.repeat(64),
}]));
const account={id:1,label:'合成账号甲',platform:'douyin',enabled:true,boardKeys:['tuantuan'],classification:{theme:{key:'tuantuan',label:'团团'},labels:[]},latest};
const point=(date,followers,likes,posts)=>({targetId:1,date,capturedAt:date+'T03:00:00.000Z',followers,followersAt:date+'T03:00:00.000Z',likes,likesAt:date+'T03:00:00.000Z',posts,postsAt:date+'T03:00:00.000Z'});
const loaded={accounts:[account],boards:[{key:'tuantuan',name:'团团'}],topics:{topics:[],items:[]},points:[point('2026-09-12',100,200,10),point('2026-10-23',110,210,11)],summaryLoaded:true,summaryError:'',dateIndexed:false,topicsLoaded:true};
const shells={
 'account-panel':'export function AccountPanel(){return null}',
 'growth-panel':'export function GrowthPanel(){return null}',
 'group-summary':'export function GroupSummary(){return null}',
 'endpoint-sources':'export function EndpointSources(){return null}',
 'coverage-panel':'export function CoveragePanel(){return null}',
 'daily-coverage-panel':'export function DailyCoveragePanel(){return null}',
 'topic-history':'export function TopicHistory(){return null}',
 'tuantuan-roster':'export function TuantuanRosterSummary(){return null};export function TuantuanRosterTable(){return null}',
 'other-source-catalog':'export function OtherSourceCatalog(){return null}',
 'source-operations':'export function SourceOperations(){return null}',
 'creator-source-panel':'export function CreatorSourceLedger(){return null};export async function readCreatorSourcePart(){throw Error("fixture source unavailable")}',
};
const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import Home from './app/page';window.fixture={data:${JSON.stringify(loaded)}};createRoot(document.getElementById('root')).render(<Home/>);`,resolveDir:site,sourcefile:'overview-read-failure-fixture.tsx',loader:'tsx'},absWorkingDir:site,bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',tsconfig:site+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'},plugins:[{name:'unrelated-source-shells',setup(build){
 build.onLoad({filter:/components\/[^/]+\.tsx$/},args=>{const name=args.path.split('/').at(-1).replace(/\.tsx$/,'');return shells[name]?{contents:shells[name],loader:'tsx',resolveDir:site}:null;});
 build.onLoad({filter:/lib\/replica-view\.mjs$/},()=>({contents:'export async function loadReplicaView(){return structuredClone(window.fixture.data)}',loader:'js'}));
 build.onLoad({filter:/lib\/source-part-reader\.mjs$/},()=>({contents:'export async function readSourceIndex(){throw Error("fixture source unavailable")};export function sourcePartsIdentity(){return "fixture"}',loader:'js'}));
 build.onLoad({filter:/\.css$/},()=>({contents:'',loader:'empty'}));
}}]});

test('overview discloses initial read failure, retry, and failed refresh without presenting the retained account snapshot as current',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{
  const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});
  try{
   const page=await context.newPage(),errors=[],requests=[];
   let apiStatus=500;
   page.setDefaultTimeout(8000);
   page.on('pageerror',error=>errors.push(error.message));
   await page.route('**/*',route=>{
    const request=route.request(),url=new URL(request.url());requests.push({method:request.method(),path:url.pathname});
    if(request.method()!=='GET')return route.abort();
    if(url.pathname==='/api/replica')return apiStatus===200
     ?route.fulfill({json:{manifest:{asOf,counts:{enabledAccounts:1},files:[]},publishedAt:asOf}})
     :route.fulfill({status:500,json:{error:'synthetic service failure'}});
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><meta charset="utf-8"><div id="root"></div></html>'});
    return route.abort();
   });
   await page.goto('http://127.0.0.1:49123/#overview');
   await page.addScriptTag({content:bundle.outputFiles[0].text});

   const failure=page.getByRole('alert').filter({hasText:'本次读取已保存数据失败'});
   await failure.waitFor();
   assert.match(await failure.innerText(),/尚无可展示的账号快照/);
   assert.equal(await failure.getByRole('button',{name:'重新读取数据'}).count(),1);
   assert.match(await page.locator('.topbar').innerText(),/连接公开数据/,'first-load failure must not invent a current account version');

   apiStatus=200;
   await failure.getByRole('button',{name:'重新读取数据'}).click();
   await page.getByText(/最近账号采样/).waitFor();
   assert.match(await page.locator('.topbar').innerText(),/最近账号采样/);
   assert.equal(await page.getByRole('alert').filter({hasText:'本次读取已保存数据失败'}).count(),0);
   await page.locator('.sidebar').getByRole('button',{name:'账号变化',exact:true}).click();
   await page.getByText('粉丝总数',{exact:true}).waitFor();
   assert.match(await page.locator('.metric-ledger').innerText(),/110/);
   await page.locator('.sidebar').getByRole('button',{name:'总览',exact:true}).click();

   apiStatus=500;
   await page.getByRole('button',{name:'重新读取已保存数据',exact:true}).click();
   await failure.waitFor();
   assert.match(await failure.innerText(),/仍显示上次成功读取的.*版本，不能视为最新数据/);
   assert.match(await page.locator('.topbar').innerText(),/最近账号采样/);
   await page.locator('.sidebar').getByRole('button',{name:'账号变化',exact:true}).click();
   assert.match(await page.locator('.metric-ledger').innerText(),/110/,'a failed read must retain, not zero-fill, the last verified snapshot');
   assert.equal(requests.filter(request=>request.path==='/api/replica').length,4,'a verified edition gets one immediate background publication check');
   assert.ok(requests.every(request=>request.method==='GET'),'read retry must not trigger collection');
   assert.deepEqual(errors,[]);
  }finally{await context.close();}
 }finally{await browser.close();}
});
