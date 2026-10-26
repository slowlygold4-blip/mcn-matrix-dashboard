import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

test('author context distinguishes all archived works from filters and links only verified homepage identities',async()=>{
 const root=fileURLToPath(new URL('../',import.meta.url));
 const main=process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../douyin-monitor-workbench/',import.meta.url));
 const {chromium}=createRequire(main+'package.json')('playwright-core');
 const primary={row:1,name:'作者甲',douyinId:'primary-id',douyinIds:['primary-id','alias-id'],posts:145,slicePosts:144,creationPosts:1,plays:123,likes:9,targetIds:[7]};
 const unlinked={row:2,name:'同名作者',douyinId:'unlinked-id',posts:1,slicePosts:1,targetIds:[]};
 const missing={row:3,name:'目录未读作者',douyinId:'missing-id',posts:1,slicePosts:1,targetIds:[99]};
 const authors=[primary,unlinked,missing];
 const work=(index,id='primary-id')=>({row:index+1,contentId:'work-'+index,author:'作者甲',douyinId:id,publishDate:index<143?'2026-10-01':'2026-10-02',track:index===143?'创作激励':'切片激励',title:'作品'+index,plays:index,likes:null,url:null});
 const works=Array.from({length:145},(_,index)=>work(index));
 const extra=Array.from({length:8},(_,index)=>({...work(145+index,index===0?'alias-id':'primary-id'),publishDate:null}));
 const foundation={authors:[{name:'作者甲',douyinId:'alias-id',targetIds:[7]},{name:'作者甲',douyinId:'not-this-author',targetIds:[999]}],works:[...extra,{...works[0]}],observations:[],index:{stats:{}}};
 const bodies={'authors.json':JSON.stringify({revision:'author-context',items:authors}),'works-001.json':JSON.stringify({revision:'author-context',items:works})};
 const source={revision:'author-context',importedAt:'2026-10-23T00:00:00Z',stats:{authors:3,works:145},tracks:[{name:'切片激励'},{name:'创作激励'}],semantics:{plays:'表格累计播放',likes:'表格累计点赞'},files:Object.entries(bodies).map(([path,body])=>({path,count:JSON.parse(body).items.length,bytes:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex')}))};
 const fixture=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {CreatorSourceLedger} from './components/creator-source-panel';
 const source=${JSON.stringify(source)},foundation=${JSON.stringify(foundation)},directory=${JSON.stringify(authors)},primary=${JSON.stringify(primary)};
 function Fixture(){const [foundationState,setFoundationState]=useState('loading'),[focus,setFocus]=useState({view:'works',author:primary}),[returnId,setReturnId]=useState('primary-id'),[catalog,setCatalog]=useState([{id:7,label:'已核验主页'},{id:999,label:'不可误关联主页'}]),[provideDirectory,setProvideDirectory]=useState(true);window.authorFixture={setFoundationState,setFocus,setReturnId,setCatalog,setProvideDirectory};return <CreatorSourceLedger source={source} foundation={foundation} foundationState={foundationState} authorDirectory={provideDirectory==='empty'?[]:provideDirectory?directory:undefined} rosterReturn={{authorId:returnId,onReturn:()=>window.returnCount=(window.returnCount||0)+1}} accounts={catalog} focus={focus} addressMode onOpenAccount={(account,trigger)=>{window.opened={id:account.id,label:account.label,button:trigger instanceof HTMLButtonElement,connected:trigger.isConnected,text:trigger.textContent};}}/>;}createRoot(document.getElementById('root')).render(<Fixture/>);`;
 const bundle=await build({stdin:{contents:fixture,resolveDir:root,sourcefile:'source-author-context-fixture.tsx',loader:'tsx'},absWorkingDir:root,bundle:true,write:false,outfile:'source-author-context-fixture.js',format:'iife',platform:'browser',jsx:'automatic',tsconfig:root+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'}});
 const script=bundle.outputFiles.find(file=>file.path.endsWith('.js')).text;
 let releaseMain;const mainReady=new Promise(resolve=>releaseMain=resolve);
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});try{
  await context.route('**/*',async route=>{const path=new URL(route.request().url()).pathname;if(path==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><div id="root"></div><script src="/fixture.js"></script>'});if(path==='/fixture.js')return route.fulfill({contentType:'text/javascript',body:script});const key=path.replace('/creator-source/','');if(key==='works-001.json')await mainReady;if(bodies[key])return route.fulfill({contentType:'application/json',body:bodies[key]});return route.abort();});
  const page=await context.newPage();await page.goto('http://127.0.0.1:9999/#source');
  const authorContext=page.getByLabel('当前作者作品与主页数据');
  await authorContext.getByText('已归档作品数待核：请等待总表与补充表完整读取。',{exact:true}).waitFor();
  assert.equal(await authorContext.getByText(/已归档作品 0/).count(),0,'pending data is not a known zero');
  releaseMain();await page.getByText('已读总表符合条件 145 条 · 第 1/5 页',{exact:true}).waitFor();
  assert.equal(await authorContext.getByText(/已归档作品数待核/).count(),1,'main rows alone cannot stand for whole author');
  await page.evaluate(()=>window.authorFixture.setFoundationState('ready'));
  await authorContext.getByText('已归档作品 153 · 总表与补充登记按作品 ID 去重，包含全部日期与赛道。',{exact:true}).waitFor();
  assert.equal(await authorContext.getByRole('button',{name:'查看粉丝、点赞变化',exact:true}).count(),1,'same saved target across aliases is one link');
  await authorContext.getByRole('button',{name:'查看粉丝、点赞变化',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.opened),{id:7,label:'已核验主页',button:true,connected:true,text:'查看粉丝、点赞变化'});
  await authorContext.getByRole('button',{name:'返回团团名册',exact:true}).click();assert.equal(await page.evaluate(()=>window.returnCount),1);
  await page.evaluate(()=>{window.authorFixture.setProvideDirectory(false);window.authorFixture.setFocus({view:'works',author:{name:'同名作者',douyinId:'unlinked-id'}});});await authorContext.getByText('作者关联信息待核',{exact:true}).waitFor();assert.equal(await authorContext.getByText('未关联主页账号',{exact:true}).count(),0,'unread directory does not prove no association');
  await page.evaluate(()=>window.authorFixture.setProvideDirectory('empty'));await authorContext.getByText('未关联主页账号',{exact:true}).waitFor();
  await page.evaluate(()=>{window.authorFixture.setProvideDirectory(false);window.authorFixture.setFocus({view:'works',author:{name:'作者甲',douyinId:'primary-id',douyinIds:['primary-id','alias-id']}});});await authorContext.getByRole('button',{name:'查看粉丝、点赞变化',exact:true}).waitFor();
  await page.evaluate(()=>window.authorFixture.setProvideDirectory(true));
  await page.getByLabel('作品发布日期开始').fill('2026-10-02');await page.getByLabel('作品发布日期结束').fill('2026-10-02');
  await authorContext.getByText(/当前筛选 2 条/).waitFor();assert.equal(await authorContext.getByText(/已归档作品 153/).count(),1);
  await page.evaluate(()=>window.authorFixture.setFocus({view:'works',track:'创作激励',mainTableOnly:true,author:{name:'作者甲',douyinId:'primary-id',douyinIds:['primary-id','alias-id']}}));
  await authorContext.getByText(/当前筛选 1 条/).waitFor();assert.equal(await authorContext.getByText(/已归档作品 153/).count(),1,'main-only and track filters do not reduce the archived count');
  await page.evaluate(()=>window.authorFixture.setFoundationState('error'));await authorContext.getByText(/已归档作品数待核/).waitFor();assert.equal(await authorContext.getByText(/已归档作品 153/).count(),0,'previous complete totals disappear when supplement verification fails');
  await page.evaluate(()=>{window.authorFixture.setFoundationState('ready');window.authorFixture.setCatalog([]);});await authorContext.getByText('账号信息暂未读到',{exact:true}).waitFor();assert.equal(await authorContext.getByRole('button',{name:'查看粉丝、点赞变化',exact:true}).count(),0);
  await page.evaluate(()=>window.authorFixture.setFocus({view:'works',author:{name:'同名作者',douyinId:'unlinked-id'}}));await authorContext.getByText('未关联主页账号',{exact:true}).waitFor();assert.equal(await authorContext.getByRole('button',{name:'返回团团名册',exact:true}).count(),0);
  await page.evaluate(()=>window.authorFixture.setFocus({view:'works',author:{name:'目录未读作者',douyinId:'missing-id'}}));await authorContext.getByText('账号信息暂未读到',{exact:true}).waitFor();
  await page.evaluate(()=>{window.authorFixture.setCatalog([{id:7,label:'已核验主页'}]);window.authorFixture.setFocus({view:'authors',query:'作者甲'});});
  await page.getByRole('columnheader',{name:'原表登记作品',exact:true}).waitFor();
  const primaryRow=page.getByRole('row').filter({hasText:'primary-id'});assert.equal((await primaryRow.getByRole('cell').nth(1).innerText()).replaceAll('\n',''),'145切片 144 · 创作 1 · 即梦 —','source registered count must remain unchanged');
  await primaryRow.getByRole('button',{name:'查看此作者的来源作品 →',exact:true}).click();await authorContext.getByText(/已归档作品 153/).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('sourceAuthorIds'),'["primary-id","alias-id"]','internal author drilldown retains verified aliases');
  assert.equal(await authorContext.getByRole('button',{name:'返回团团名册',exact:true}).count(),0,'internal list return takes precedence over rosterReturn');
  await authorContext.getByRole('button',{name:'返回作者记录',exact:true}).click();await page.getByRole('columnheader',{name:'原表登记作品',exact:true}).waitFor();assert.equal(await page.getByLabel('搜索来源作者或作品').inputValue(),'作者甲');
  // Legacy callers without the optional directory still use current, verified
  // author rows they have already read; they never match a same-name stranger.
  await page.evaluate(()=>window.authorFixture.setProvideDirectory(false));await page.getByRole('row').filter({hasText:'primary-id'}).getByRole('button',{name:'查看此作者的来源作品 →',exact:true}).click();
  await authorContext.getByRole('button',{name:'查看粉丝、点赞变化',exact:true}).waitFor();
  assert.equal(await authorContext.getByText('不可误关联主页',{exact:true}).count(),0);
 }finally{releaseMain();await context.close();}}finally{await browser.close();}
});
