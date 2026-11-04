// Actual collection console and Radix dialog, synthetic HTTP only. Cloud browser required.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {build} from 'esbuild';
const root=fileURLToPath(new URL('../',import.meta.url));
const {chromium}=createRequire(resolve(process.env.MCN_MAIN_ROOT||resolve(root,'..'),'package.json'))('playwright-core');
async function browser(){
 if(process.env.MCN_TEST_BROWSER_WS)return chromium.connect(process.env.MCN_TEST_BROWSER_WS);
 if(process.env.MCN_TEST_CLOUD_BROWSER==='1'&&process.platform==='linux')return chromium.launch({headless:true});
 throw Error('Cloud browser required; local browser launch is disabled.');
}
let compiled;
function styles(){return compiled??=(async()=>{
 const [{default:postcss},{default:config}]=await Promise.all([import('postcss'),import('../postcss.config.mjs')]);
 const plugins=await Promise.all(Object.entries(config.plugins).map(async([name,options])=>{const {default:plugin}=await import(name);return plugin({...options,base:root});}));
 const from=resolve(root,'app/globals.css'),globals=await postcss(plugins).process(readFileSync(from,'utf8'),{from,map:false});
 assert.match(globals.css,/box-sizing:\s*border-box/);
 return [globals.css,...['replica.css','source-operations.css','visual-theme.css','dashboard-motion.css','collection-console.css','matrix-pulse.css','observatory.css'].map(name=>readFileSync(root+'app/'+name,'utf8'))].join('\n');
})();}
const asOf='2026-11-04T12:00:00.000Z',since='2026-11-03T12:00:00.000Z';
function payload(){return {online:true,canControl:false,status:{observedAt:asOf,runtimeAI:false,accounts:50,topics:2,
 rolling:{since,total:52,profileTotal:50,profiles:5,topics:1,updated:6,notUpdated:46,workIssues:26,worksComplete:0,worksLimited:0,
  issues:{version:1,asOf,since,missingProfileTargetIds:Array.from({length:45},(_,i)=>i+1),missingTopicTargetIds:[90],
   workIssueGroups:[{code:'blocked',targetIds:Array.from({length:25},(_,i)=>i+1)},{code:'unknown',targetIds:[999]}]}},
 run:{id:1,kind:'scheduled',status:'success',total:1,processed:1,success:1,failed:0,warnings:1}}};}
async function fixture(b,{legacy=false}={}){
 const context=await b.newContext({viewport:{width:1180,height:850},reducedMotion:'reduce'}),page=await context.newPage();
 const state={payload:payload(),writes:[],errors:[]};if(legacy)delete state.payload.status.rolling.issues;
 page.on('pageerror',error=>state.errors.push(error.message));
 await page.route('**/*',route=>{const request=route.request(),url=new URL(request.url());if(url.origin!=='https://collection-issues.test')return route.abort();
  if(request.method()!=='GET')state.writes.push(request.method());
  if(url.pathname==='/api/collection')return route.fulfill({contentType:'application/json',body:JSON.stringify(state.payload)});
  return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>'});
 });
 const code=`import React from 'react';import {createRoot} from 'react-dom/client';import {CollectionConsole} from './components/collection-console';import {Dialog,DialogContent,DialogTitle,DialogDescription,DialogClose} from './components/ui/dialog';
 const accounts=Array.from({length:50},(_,i)=>({id:i+1,label:'合成作者'+(i+1),platform:'douyin',enabled:true})),topics=[{id:90,label:'#合成话题'}];
 function App(){const [account,setAccount]=React.useState(null),trigger=React.useRef(null);return <div className='workspace'><main><CollectionConsole accounts={accounts} topics={topics} onOpenAccount={(account,button)=>{trigger.current=button;setAccount(account);}}/><Dialog open={!!account} onOpenChange={open=>{if(!open)setAccount(null);}}><DialogContent className='history-dialog' onCloseAutoFocus={event=>{event.preventDefault();trigger.current?.focus();}}><DialogTitle>{account?.label}经营详情</DialogTitle><DialogDescription>合成账号详情，未发起采集</DialogDescription><output aria-label='所选精确账号'>{account?.id}</output><DialogClose>返回问题名单</DialogClose></DialogContent></Dialog></main></div>;}createRoot(document.getElementById('root')).render(<App/>);`;
 const bundle=await build({stdin:{contents:code,resolveDir:root,sourcefile:'collection-issues-fixture.tsx',loader:'tsx'},absWorkingDir:root,bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',tsconfig:root+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'}});
 await page.goto('https://collection-issues.test/?theme=tuantuan#accounts');await page.addStyleTag({content:await styles()});await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.getByText('脚本在线 · 等待下一批',{exact:true}).waitFor();await page.locator('.collection-more summary').click();
 return {page,context,state};
}

test('24-hour issues preserve snapshot, search/page and exact account dialog; late receipts cannot silently replace membership',{timeout:60000},async()=>{
 const b=await browser();let f;
 try{f=await fixture(b);const {page,state}=f,button=page.getByRole('button',{name:'查看尚未更新目标 46 个',exact:true});
  await button.focus();await page.keyboard.press('Enter');const list=page.getByRole('region',{name:'近24小时采集问题名单'});await list.waitFor();
  assert.match(await list.innerText(),/尚未更新目标 46 个（账号 45 · 话题 1）/);assert.equal(await list.getByRole('listitem').count(),20);
  await list.getByRole('button',{name:'下一页',exact:true}).click();assert.equal(await list.getByLabel('采集问题名单页码').inputValue(),'2');
  const target=list.getByRole('button',{name:'查看合成作者21的账号详情',exact:true});await target.focus();await page.keyboard.press('Enter');
  const dialog=page.getByRole('dialog');await dialog.waitFor();assert.equal(await dialog.getByLabel('所选精确账号').innerText(),'21');
  await dialog.getByRole('button',{name:'返回问题名单',exact:true}).click();await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='查看合成作者21的账号详情');
  assert.equal(await list.getByLabel('采集问题名单页码').inputValue(),'2');assert.equal(new URL(page.url()).searchParams.get('theme'),'tuantuan');
  await list.getByRole('searchbox',{name:'查找问题目标'}).fill('合成作者21');assert.equal(await list.getByRole('listitem').count(),1);
  state.payload.status.rolling.issues.missingProfileTargetIds=state.payload.status.rolling.issues.missingProfileTargetIds.filter(id=>id!==21);
  state.payload.status.rolling.notUpdated--;state.payload.status.rolling.updated++;state.payload.status.rolling.profiles++;
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await list.getByText('已有新的问题名单上报，当前名单未自动替换。',{exact:true}).waitFor();
  assert.equal(await list.getByRole('button',{name:'查看合成作者21的账号详情',exact:true}).count(),1);
  await list.getByRole('button',{name:'载入最新问题名单',exact:true}).click();assert.equal(await list.getByRole('searchbox').inputValue(),'合成作者21');assert.equal(await list.getByRole('listitem').count(),0);
  await list.getByRole('searchbox').fill('合成话题');assert.equal(await list.getByRole('listitem').count(),1);assert.match(await list.innerText(),/话题独立统计/);assert.equal(await list.getByRole('button',{name:/的账号详情/}).count(),0);
  await list.getByRole('searchbox').fill('999');await list.getByLabel('问题类型').selectOption('works');assert.match(await list.innerText(),/尚未发布账号详情/);assert.equal(await list.getByRole('button',{name:/的账号详情/}).count(),0);
  await list.getByRole('searchbox').fill('');
  for(const width of [390,320]){await page.setViewportSize({width,height:844});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const geometry=await list.evaluate(el=>{const rect=el.getBoundingClientRect();return {left:rect.left,right:rect.right,scroll:el.scrollWidth,client:el.clientWidth,viewport:innerWidth,body:document.documentElement.scrollWidth};});
   assert.ok(geometry.left>=-1&&geometry.right<=geometry.viewport+1,JSON.stringify(geometry));assert.ok(geometry.scroll<=geometry.client+1,JSON.stringify(geometry));assert.ok(geometry.body<=geometry.viewport+1,JSON.stringify(geometry));
  }
  await list.getByRole('searchbox').focus();await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#collection-issue-list')&&document.activeElement?.textContent?.includes('查看尚未更新目标'));
  assert.deepEqual(state.writes,[]);assert.deepEqual(state.errors,[]);
 }finally{await f?.context.close();await b.close();}
});

test('legacy telemetry explains missing membership instead of showing an invented empty list',{timeout:60000},async()=>{
 const b=await browser();let f;try{f=await fixture(b,{legacy:true});const {page,state}=f;
  await page.getByRole('button',{name:'查看尚未更新目标 46 个',exact:true}).click();const list=page.getByRole('region',{name:'近24小时采集问题名单'});
  await list.getByText('这次上报尚未包含问题名单；不能用其他时间窗口的名单代替。',{exact:true}).waitFor();assert.equal(await list.getByRole('listitem').count(),0);assert.equal(await list.getByRole('searchbox').count(),0);
  assert.deepEqual(state.writes,[]);assert.deepEqual(state.errors,[]);
 }finally{await f?.context.close();await b.close();}
});
