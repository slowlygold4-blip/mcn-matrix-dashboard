// A small real-Home browser check. All publications are synthetic and in memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const site=fileURLToPath(new URL('../',import.meta.url));
const main=process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../douyin-monitor-workbench/',import.meta.url));
const {chromium}=createRequire(main+'package.json')('playwright-core');
const asOf='2026-10-23T05:00:00.000Z',revision='same-source-revision';
const seal=(path,body)=>({path,count:body.items.length,bytes:Buffer.byteLength(JSON.stringify(body)),sha256:createHash('sha256').update(JSON.stringify(body)).digest('hex')});
const account={id:1,label:'合成监控账号',platform:'douyin',enabled:true,boardKeys:['tuantuan'],classification:{theme:{key:'tuantuan',label:'团团'},labels:[]},latest:{}};
const catalog={accounts:[account],boards:[]};
const catalogSeal={path:'catalog.json',kind:'catalog',count:1,bytes:Buffer.byteLength(JSON.stringify(catalog)),sha256:createHash('sha256').update(JSON.stringify(catalog)).digest('hex')};
const replica={asOf,timeZone:'Asia/Shanghai',counts:{enabledAccounts:1,daily:0},files:[catalogSeal]};
const authors=edition=>({revision,items:Array.from({length:35},(_,n)=>({row:n+1,name:`作者${edition===1?'旧':'新'}${String(n+1).padStart(2,'0')}`,douyinId:`creator-${n}`,targetIds:[1],posts:1,plays:n,likes:n,slicePosts:1,creationPosts:0,aiPosts:0}))});
const works={revision,items:[]};
const source=edition=>({version:1,revision,importedAt:asOf,linkFingerprint:String(edition).repeat(64),stats:{authors:35,works:0,rawAuthorRows:35,reciprocalDuplicates:0,linkedAuthors:edition},semantics:{plays:'原表累计播放',likes:'原表累计点赞'},tracks:[{name:'切片',works:0}],files:[seal('authors.json',authors(edition)),seal('works-001.json',works)]});
const foundationNames=['authors.json','works.json','sources.json','observations.json','other-authors.json','other-works.json'];
const foundationStats=Object.fromEntries(['sourceDocuments','sourceRows','tuantuanRows','acceptedRows','unkeyedRows','ambiguousRows','invalidIdentityRows','baseAuthorEvidence','baseWorkEvidence','additionalAuthors','additionalWorks','otherAuthors','otherWorks','sourceMetricObservations','sourceMetricWorkIds','baseAuthorRows','reciprocalDuplicates','baseAuthors','baseWorks','sheets'].map(name=>[name,0]));
const foundationPart=edition=>({revision,marker:edition,items:[]});
const foundation=edition=>({version:1,revision,generatedAt:asOf,linkFingerprint:String(edition).repeat(64),stats:foundationStats,sheetCoverage:[],files:foundationNames.map(name=>seal(name,foundationPart(edition)))});
const shells={
 'account-panel':'export function AccountPanel(){return null}',
 'growth-panel':'export function GrowthPanel(){return null}',
 'group-summary':'export function GroupSummary(){return null}',
 'metric-ledger':'export function MetricLedger(){return null}',
 'endpoint-sources':'export function EndpointSources(){return null}',
 'coverage-panel':'export function CoveragePanel(){return null}',
 'daily-coverage-panel':'export function DailyCoveragePanel(){return null}',
 'topic-history':'export function TopicHistory(){return null}',
 'tuantuan-roster':'export function TuantuanRosterSummary(){return null};export function TuantuanRosterTable(){return null}',
 'other-source-catalog':'export function OtherSourceCatalog({foundation}){return <span data-testid="foundation-revision">{foundation?.index?.linkFingerprint||"—"}</span>}',
 'source-operations':'export function SourceOperations(){return null}',
};
const bundle=await build({stdin:{contents:'import React from "react";import {createRoot} from "react-dom/client";import Home from "./app/page";createRoot(document.getElementById("root")).render(<Home/>);',resolveDir:site,sourcefile:'source-edition-fixture.tsx',loader:'tsx'},absWorkingDir:site,bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',tsconfig:site+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'},plugins:[{name:'fixture-shells',setup(builder){
 builder.onLoad({filter:/components\/[^/]+\.tsx$/},args=>{const name=args.path.split('/').at(-1).replace(/\.tsx$/,'');return shells[name]?{contents:shells[name],loader:'tsx',resolveDir:site}:null;});
 builder.onLoad({filter:/lib\/replica-reader\.mjs$/},()=>({contents:`export function validateUnifiedWorksPart(items){return items;} export async function readReplicaPart({part}){if(part==='catalog.json')return ${JSON.stringify(catalog)};throw Error('Unexpected account partition '+part);}`,loader:'js'}));
 builder.onLoad({filter:/\.css$/},()=>({contents:'',loader:'empty'}));
}}]});

test('source edition adopts after bad partition and replica fetch failure, preserving filters and position',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 const context=await browser.newContext({viewport:{width:1400,height:560},reducedMotion:'reduce'}),page=await context.newPage();
 page.setDefaultTimeout(10000);
 const errors=[],controls={edition:1,broken:false,indexReads:0,replicaOffline:false,offlineRequests:0};page.on('pageerror',error=>errors.push(error.stack||error.message));
 try{
  await page.route('**/*',route=>{const path=new URL(route.request().url()).pathname;
   if(path==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><div id="root"></div>'});
   if(path==='/api/replica'){if(controls.replicaOffline){controls.offlineRequests++;return route.abort('failed');}return route.fulfill({json:{manifest:replica,publishedAt:asOf}});}
   if(path==='/creator-source/index.json'){controls.indexReads++;return route.fulfill({json:source(controls.edition)});}
   if(path==='/creator-source/authors.json')return route.fulfill({json:authors(controls.broken?1:controls.edition)});
   if(path==='/creator-source/works-001.json')return route.fulfill({json:works});
   if(path==='/table-foundation/index.json')return route.fulfill({json:foundation(controls.edition)});
   if(path.startsWith('/table-foundation/')&&foundationNames.includes(path.split('/').at(-1)))return route.fulfill({json:foundationPart(controls.edition)});
   return route.abort();
  });
  await page.goto('http://127.0.0.1:49118/#source');await page.addScriptTag({content:bundle.outputFiles[0].text});
  const ledger=page.locator('.source-ledger');
  try{await ledger.locator('tbody tr').first().waitFor();}catch(error){console.error('Synthetic source page:',(await page.locator('body').innerText()).slice(0,1200),'Page errors:',errors);throw error;}
  await ledger.getByRole('textbox',{name:'搜索来源作者或作品'}).fill('作者');
  await ledger.getByLabel(/^排序/).selectOption('row');
  await ledger.getByRole('button',{name:'下一页',exact:true}).first().click();
  await ledger.getByText('作者旧31').waitFor();
  await page.evaluate(()=>window.scrollTo(0,Math.min(260,document.documentElement.scrollHeight-window.innerHeight)));
  const scrollBefore=await page.evaluate(()=>window.scrollY);assert.ok(scrollBefore>0);
  const oldFoundation='1'.repeat(64);await page.getByTestId('foundation-revision').first().getByText(oldFoundation).waitFor();
  controls.edition=2;controls.broken=true;
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await page.getByRole('alert').filter({hasText:'新版表格来源核验失败'}).waitFor();
  assert.equal(await ledger.getByRole('textbox',{name:'搜索来源作者或作品'}).inputValue(),'作者');
  assert.match(await ledger.locator('.source-pager').first().textContent(),/第 2\/2 页/);
  assert.ok(await ledger.getByText('作者旧31').isVisible());
  assert.equal(await page.getByTestId('foundation-revision').first().textContent(),oldFoundation);
  controls.broken=false;controls.replicaOffline=true;await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await ledger.getByText('作者新31').waitFor();
  assert.match(await ledger.locator('.source-pager').first().textContent(),/第 2\/2 页/);
  assert.equal(await ledger.getByRole('textbox',{name:'搜索来源作者或作品'}).inputValue(),'作者');
  assert.equal(await page.getByTestId('foundation-revision').first().textContent(),'2'.repeat(64));
  assert.equal(await page.getByRole('alert').filter({hasText:'新版表格来源核验失败'}).count(),0);
  assert.ok(controls.offlineRequests>=1,'the account replica failed while the source edition still adopted');
  assert.equal(await page.evaluate(()=>window.scrollY),scrollBefore);
  assert.deepEqual(errors,[]);
 }finally{await context.close();await browser.close();}
});
