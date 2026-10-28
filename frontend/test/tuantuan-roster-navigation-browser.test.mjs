import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const site=fileURLToPath(new URL('../',import.meta.url));
const main=process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../douyin-monitor-workbench/',import.meta.url));
const {chromium}=createRequire(main+'package.json')('playwright-core');
const rows=Array.from({length:65},(_,index)=>({key:'fixture-'+index,source:{name:'作者'+String(index+1).padStart(3,'0'),douyinId:'id-'+index,douyinIds:['id-'+index,'alias-'+index],posts:1,slicePosts:1,plays:index,likes:index*2,sourceTitles:['合成总表','合成补表']},accounts:index%4===3?[]:[{id:index+1,label:'监控'+(index+1),enabled:index%4<2,latest:{followers:{value:index*10,date:'2026-10-28'},likes:{value:index*20,date:'2026-10-28'}}}]}));
const roster={rows,counts:{all:65,monitoredEnabled:33,monitoredPaused:16,source:65,baseSource:65,supplementSource:0,reconciledAliases:0,monitored:49,linkedTargets:49}};
const metrics=rows.flatMap(row=>row.accounts.map(account=>({id:account.id,metrics:{followers:{delta:account.id-32,baseline:100,value:100+account.id-32},likes:{delta:32-account.id},posts:{delta:account.id%5-2}}})));
const fixture=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {TuantuanRosterTable} from './components/tuantuan-roster';const original=${JSON.stringify(roster)},initialMetrics=${JSON.stringify(metrics)};function Fixture(){const [roster,setRoster]=useState(original),[active,setActive]=useState(true),[mounted,setMounted]=useState(true),[classification,setClassification]=useState('all'),[metricRows,setMetrics]=useState(initialMetrics),[changesReady,setReady]=useState(true),[periodLabel,setPeriod]=useState('2026-10-01 -> 2026-10-28');window.fixture={original,setRoster,setActive,setMounted,setClassification,setMetrics,setReady,setPeriod};return <div data-roster-shell hidden={!active}>{mounted&&<TuantuanRosterTable roster={roster} classification={classification} addressMode active={active} metricRows={metricRows} changesReady={changesReady} periodLabel={periodLabel} onOpenAccount={(row,trigger)=>{window.lastAccount={id:row.id,connected:trigger.isConnected,button:trigger.tagName};window.accountTrigger=trigger}} onOpenSourceWorks={(row,trigger)=>{window.lastSource={id:row.douyinId,connected:trigger.isConnected,button:trigger.tagName};window.sourceTrigger=trigger}}/>}</div>}createRoot(document.getElementById('root')).render(<Fixture/>);`;

test('real roster controls preserve task state across URL navigation, loading and remounts',{timeout:45000},async t=>{
 const bundle=await build({stdin:{contents:fixture,resolveDir:site,sourcefile:'roster-navigation-fixture.tsx',loader:'tsx'},absWorkingDir:site,bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',tsconfig:site+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'}});
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{const context=await browser.newContext({viewport:{width:1300,height:900},reducedMotion:'reduce'});try{
  await context.addInitScript(()=>{window.exports=[];URL.createObjectURL=blob=>{window.exports.push(blob);return 'blob:fixture'};URL.revokeObjectURL=()=>{};HTMLAnchorElement.prototype.click=function(){};});
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/fixture.js"></script>'});if(url.pathname==='/fixture.js')return route.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text});return route.abort();});
  const page=await context.newPage(),errors=[];page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
  const initial='http://127.0.0.1:49119/?rosterPanel=authors&rosterQuery=作者&rosterSort=name&rosterDirection=asc&rosterPage=2&rosterStatus=paused&sourceView=works#accounts';
  const panel=page.getByRole('region',{name:'团团统一作者名册'}),search=page.getByLabel('搜索团团全部作者');
  const pageTwo=()=>page.getByRole('navigation',{name:'团团名册上方分页'}).getByText('显示 31–60 / 65 位 · 第 2/3 页',{exact:true}).waitFor();
  await page.goto(initial);await pageTwo();

  await t.test('address restores query, sorting and page; export keeps all pages and alias evidence',async()=>{
   assert.equal(await search.inputValue(),'作者');assert.equal(await page.getByLabel('团团名册排序指标').inputValue(),'name');assert.equal(await page.getByLabel('团团名册排序顺序').inputValue(),'asc');
   assert.match(await panel.locator('tbody tr').first().innerText(),/作者031/);
   await panel.getByRole('button',{name:'导出当前筛选',exact:true}).click();
   const csv=await page.evaluate(()=>window.exports.at(-1).text());assert.equal(csv.trim().split(/\r?\n/).length,66);assert.match(csv,/alias-64/);assert.match(csv,/合成总表 \/ 合成补表/);
   const group=page.getByRole('group',{name:'团团作者范围'});
   for(const label of ['全部作者 65','启用监控 33','暂停监控 16','未关联监控 16'])assert.equal(await group.getByRole('button',{name:label,exact:true}).count(),1);
   assert.match(await panel.innerText(),/全部作者统一展示/);
   assert.equal(await panel.getByRole('columnheader',{name:/^已登记作品/}).count(),1);
   const explanation=panel.locator('details.roster-method');assert.equal(await explanation.getAttribute('open'),null,'secondary data explanation stays collapsed for a simpler first view');
   await explanation.locator('summary').click();assert.match(await panel.innerText(),/后来补充的作品数量见作者作品页的“已归档作品”/);await explanation.locator('summary').click();
   assert.equal(await panel.locator('tbody tr').first().locator('td').nth(2).innerText(),'1','clarifying the label must not recalculate the source work count');
   assert.equal(new URL(page.url()).searchParams.get('rosterStatus'),'paused');assert.equal(new URL(page.url()).searchParams.get('sourceView'),'works');
  });

  await t.test('null during refresh and unmount/remount cannot erase the saved second page',async()=>{
   await page.evaluate(()=>window.fixture.setRoster(null));await page.getByText('正在核对团团全部作者名册…',{exact:true}).waitFor();
   assert.equal(new URL(page.url()).searchParams.get('rosterPage'),'2');
   await page.evaluate(()=>window.fixture.setRoster(window.fixture.original));await pageTwo();
   await page.evaluate(()=>window.fixture.setMounted(false));await panel.waitFor({state:'detached'});
   await page.evaluate(()=>window.fixture.setMounted(true));await pageTwo();
   assert.equal(await search.inputValue(),'作者');
   await page.reload();await pageTwo();
  });

  await t.test('hidden roster ignores foreign navigation then restores its current URL when reactivated',async()=>{
   await page.evaluate(()=>window.fixture.setActive(false));await page.locator('[data-roster-shell][hidden]').waitFor({state:'attached'});
   await page.evaluate(()=>{history.pushState(null,'','/?rosterPanel=authors&rosterQuery=作者0&rosterMode=paused&rosterSort=likes&rosterDirection=desc#source');dispatchEvent(new PopStateEvent('popstate'));dispatchEvent(new HashChangeEvent('hashchange'));});
   assert.equal(await search.inputValue(),'作者');assert.equal(await page.getByLabel('上方页码').inputValue(),'2');
   await page.evaluate(()=>window.fixture.setActive(true));
   await page.waitForFunction(()=>document.querySelector('input[aria-label="搜索团团全部作者"]')?.value==='作者0');
   assert.equal(await panel.locator('tbody tr').count(),16);assert.equal(await page.getByLabel('团团名册排序指标').inputValue(),'likes');
   assert.equal(await page.getByRole('button',{name:'暂停监控 16',exact:true}).getAttribute('aria-pressed'),'true');
   await page.goBack();await pageTwo();assert.equal(await search.inputValue(),'作者');
   await page.goForward();await page.waitForFunction(()=>document.querySelector('input[aria-label="搜索团团全部作者"]')?.value==='作者0');
   await page.goBack();await pageTwo();
  });

  await t.test('callbacks retain exact origin buttons and parent panel changes are not overwritten',async()=>{
   await panel.getByRole('button',{name:'查看作品 →',exact:true}).first().click();
   assert.deepEqual(await page.evaluate(()=>window.lastSource),{id:'id-30',connected:true,button:'BUTTON'});
   await panel.getByRole('button',{name:'监控31 · 查看账号变化',exact:true}).click();
   assert.deepEqual(await page.evaluate(()=>window.lastAccount),{id:31,connected:true,button:'BUTTON'});
   await page.evaluate(()=>{const url=new URL(location.href);url.searchParams.set('rosterPanel','changes');history.replaceState(null,'',url);});
   await search.fill('作者00');
   await page.waitForFunction(()=>!new URL(location.href).searchParams.has('rosterPage'));
   assert.equal(new URL(page.url()).searchParams.get('rosterPanel')??'changes','changes');
   assert.equal(new URL(page.url()).searchParams.has('rosterPage'),false,'changing a roster filter resets only its own page');
   assert.equal(new URL(page.url()).searchParams.get('rosterStatus'),'paused');
   const group=page.getByRole('group',{name:'团团作者范围'});assert.equal(await group.getByRole('button',{name:'全部作者 65',exact:true}).count(),1,'status counts describe the full classification, not the text search');
  });

  await t.test('invalid and out-of-range links remain visible errors with explicit safe recovery',async()=>{
   await page.goto('http://127.0.0.1:49119/?rosterPanel=authors&rosterPage=0&rosterStatus=all#accounts');
   await page.getByRole('alert').filter({hasText:'页码无效'}).waitFor();assert.equal(await panel.locator('tbody tr').count(),0);assert.equal(await panel.getByRole('button',{name:'导出当前筛选',exact:true}).isDisabled(),true);
   await page.getByRole('button',{name:'重置名册筛选',exact:true}).click();await panel.locator('tbody tr').first().waitFor();
   assert.equal(new URL(page.url()).searchParams.get('rosterPanel')??'authors','authors');assert.equal(new URL(page.url()).searchParams.get('rosterStatus'),'all');
   await page.goto('http://127.0.0.1:49119/?rosterPanel=authors&rosterPage=4#accounts');
   await page.getByRole('alert').filter({hasText:'链接请求第 4 页'}).waitFor();assert.equal(new URL(page.url()).searchParams.get('rosterPage'),'4');
   await page.getByRole('button',{name:'回到第一页',exact:true}).click();await panel.locator('tbody tr').first().waitFor();assert.equal(new URL(page.url()).searchParams.has('rosterPage'),false);
    assert.deepEqual(errors,[]);
  });
   await t.test('all profile and change headers rank both ways, preserve URL scope and export their displayed metrics',async()=>{
    await page.goto('http://127.0.0.1:49119/?rosterSort=followers.value&rosterPage=2&rosterStatus=paused#accounts');
    await panel.locator('tbody tr').first().waitFor();
    assert.equal(await page.getByLabel('上方页码').inputValue(),'2','a direct metric-rank page remains addressable');
    for(const [key,label] of [['followers.value','最新粉丝数'],['likes.value','最新主页获赞'],
      ['followers.delta','粉丝变化'],['likes.delta','主页获赞变化'],['posts.delta','作品存量变化']]){
     await page.getByLabel('团团名册排序指标').selectOption(key);
     const header=panel.getByRole('columnheader',{name:new RegExp('^'+label)}),button=header.getByRole('button');
     await button.click();const first=await header.getAttribute('aria-sort');
     assert.ok(['ascending','descending'].includes(first));assert.equal(new URL(page.url()).searchParams.has('rosterPage'),false);
     assert.equal(new URL(page.url()).searchParams.get('rosterSort'),key);
     await button.click();assert.notEqual(await header.getAttribute('aria-sort'),first);
    }
    await page.getByLabel('团团名册排序指标').selectOption('followers.delta');
    await page.getByLabel('团团名册排序顺序').selectOption('desc');
    assert.match(await panel.locator('tbody tr').first().innerText(),/作者065/);
    await page.evaluate(()=>{window.fixture.setMetrics([{id:1,metrics:{followers:{delta:100,baseline:0,value:100}}}]);window.fixture.setPeriod('2026-10-20 -> 2026-10-28');});
    await page.waitForFunction(()=>document.querySelector('.source-table tbody tr')?.textContent.includes('作者001'));
    assert.match(await panel.getByRole('columnheader',{name:/^粉丝变化/}).innerText(),/2026-10-20/);
    assert.match(await panel.locator('tbody tr').first().locator('td').nth(7).innerText(),/\+100/);
    await panel.getByRole('button',{name:'导出当前筛选',exact:true}).click();
    const output=await page.evaluate(()=>window.exports.at(-1).text());
    assert.equal(output.trim().split(/\r?\n/).length,66);assert.match(output,/最新粉丝数/);
    assert.match(output,/2026-10-20 -> 2026-10-28/);assert.match(output,/已核对/);
    assert.equal(new URL(page.url()).searchParams.get('rosterStatus'),'paused');
    await page.evaluate(()=>window.fixture.setReady(false));
    assert.equal(await panel.getByRole('columnheader',{name:/^粉丝变化/}).getByRole('button').isDisabled(),true);
    assert.match(await panel.locator('tbody tr').first().locator('td').nth(7).innerText(),/区间数据核对中/);
    assert.deepEqual(errors,[]);
   });
 }finally{await context.close();}}finally{await browser.close();}
});
