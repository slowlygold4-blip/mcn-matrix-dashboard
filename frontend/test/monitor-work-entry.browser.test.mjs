// Synthetic component interaction test. Cloud browser only; no local launch.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {build} from 'esbuild';
const root=fileURLToPath(new URL('../',import.meta.url));
const {chromium}=createRequire(resolve(process.env.MCN_MAIN_ROOT||resolve(root,'..'),'package.json'))('playwright-core');
async function cloudBrowser(){if(process.env.MCN_TEST_BROWSER_WS)return chromium.connect(process.env.MCN_TEST_BROWSER_WS);if(process.env.MCN_TEST_CLOUD_BROWSER==='1'&&process.platform==='linux')return chromium.launch({headless:true});throw Error('Cloud browser required; local launch disabled.');}
const fixture=`import React from 'react';import {createRoot} from 'react-dom/client';import {TuantuanRosterTable} from './components/tuantuan-roster';import {AccountPanel} from './components/account-panel';
const account=(id,platform='douyin')=>({id,label:'账号'+id,platform,enabled:true,boardKeys:[],classification:{theme:{key:'tuantuan',label:'团团'},labels:[]}}),accounts=[1,2,3,4,5].map(id=>account(id,id===2?'bilibili':'douyin'));
const source={name:'来源作者',douyinId:'source-verified',targetIds:[5]},roster={rows:[{key:'one',source:null,accounts:[accounts[0]]},{key:'bili',source:null,accounts:[accounts[1]]},{key:'multiple',source:null,accounts:[accounts[2],accounts[3]]},{key:'source',source,accounts:[accounts[4]]},{key:'pending',source:{name:'待核作者',sourceOnly:true,targetIds:[]},accounts:[]}],counts:{all:5}};
const manifest={asOf:'2026-10-26T08:00:00.000Z',timeZone:'Asia/Shanghai',files:[{path:'daily/2.json',targetId:2,kind:'daily',count:1,bytes:10,sha256:'a'.repeat(64)}]};
function App(){const [result,setResult]=React.useState('尚未选择');return <><output aria-label='已选择入口'>{result}</output><TuantuanRosterTable roster={roster} classification='all' addressMode onOpenAccount={()=>setResult('账号变化')} onOpenSourceWorks={(value,trigger)=>setResult('统一作品:'+value.douyinId+':'+(trigger===document.activeElement))} onOpenAccountWorks={(value,trigger)=>setResult('账号作品:'+value.id+':'+value.platform+':'+(trigger===document.activeElement))}/><AccountPanel account={accounts[1]} manifest={manifest} boards={[]} request={{}} onReturn={()=>{}} onAddress={()=>{}} onHistory={(value,trigger)=>setResult('独立历史:'+value.id+':'+value.platform+':'+(trigger===document.activeElement))}/></>;}createRoot(document.getElementById('root')).render(<App/>);`;
test('monitored authors choose exact target works with keyboard; source authors and failed daily history keep independent routes',{timeout:30000},async()=>{
 const bundle=await build({stdin:{contents:fixture,sourcefile:'monitor-entry-fixture.tsx',resolveDir:root,loader:'tsx'},absWorkingDir:root,bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',tsconfig:root+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'}});
 const browser=await cloudBrowser();let context;
 try{context=await browser.newContext({viewport:{width:1180,height:900}});const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<html lang="zh-CN"><div id="root"></div></html>'});if(url.pathname==='/api/replica')return route.fulfill({status:503,body:'fixture failure'});return route.abort();});
  await page.goto('http://127.0.0.1:49139/?theme=tuantuan&rosterPanel=authors#accounts');await page.addStyleTag({content:readFileSync(root+'app/replica.css','utf8')});await page.addScriptTag({content:bundle.outputFiles[0].text});
  const result=page.getByLabel('已选择入口'),panel=page.getByLabel('团团统一作者名册');await panel.getByRole('button',{name:'账号1 · 账号 1 · 查看作品',exact:true}).waitFor();
  await panel.getByRole('button',{name:'账号2 · 账号 2 · 查看作品',exact:true}).focus();await page.keyboard.press('Enter');assert.equal(await result.innerText(),'账号作品:2:bilibili:true');
  await panel.getByRole('button',{name:'账号4 · 账号 4 · 查看作品',exact:true}).click();assert.equal(await result.innerText(),'账号作品:4:douyin:true');
  await panel.getByRole('button',{name:'账号3 · 账号 3 · 查看作品',exact:true}).click();assert.equal(await result.innerText(),'账号作品:3:douyin:true');
  assert.equal(new URL(page.url()).searchParams.get('theme'),'tuantuan');assert.equal(new URL(page.url()).hash,'#accounts');
  await panel.getByLabel('搜索团团全部作者').fill('来源作者');const sourceRow=panel.locator('tbody tr');assert.equal(await sourceRow.count(),1);await sourceRow.getByRole('button',{name:'查看作品 →',exact:true}).click();assert.equal(await result.innerText(),'统一作品:source-verified:true');assert.equal(await panel.getByLabel('搜索团团全部作者').inputValue(),'来源作者');
  await panel.getByLabel('搜索团团全部作者').fill('待核作者');assert.equal(await panel.locator('tbody tr').getByRole('button',{name:/查看作品/}).count(),0);
  const accountPanel=page.getByLabel('独立账号数据');await accountPanel.getByRole('alert').filter({hasText:'数据读取暂时失败'}).waitFor();const history=accountPanel.getByRole('button',{name:'查看全部每日、作品与指标历史',exact:true});assert.equal(await history.isEnabled(),true);await history.focus();await page.keyboard.press('Enter');assert.equal(await result.innerText(),'独立历史:2:bilibili:true');assert.deepEqual(errors,[]);
 }finally{await context?.close();await browser.close();}
});
