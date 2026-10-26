import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {sourceLedgerDefaults,sourceLedgerSelection,sourceLedgerSelectionPath,preserveSourceSelection,sourceLedgerShareLink} from '../lib/source-ledger-navigation.mjs';

test('source state round trips independently of account dates, preserving all identity aliases and return pagination',()=>{
  const authors={...sourceLedgerDefaults,query:'团团',page:3,sort:'row',linkage:'sourceOnly'};
  const selected={...sourceLedgerDefaults,view:'works',track:'创作激励',startDate:'2026-10-01',endDate:'2026-10-02',mainTableOnly:true,authorFocus:{name:'作者 A',douyinId:'0012',douyinIds:['0012','0013']},returnSelection:authors};
  const path=sourceLedgerSelectionPath('/?start=2026-09-12&end=2026-10-23&query=全局#source',selected);
  const url=new URL(path,'https://example.com');
  assert.equal(url.searchParams.get('start'),'2026-09-12');assert.equal(url.searchParams.get('query'),'全局');
  assert.deepEqual(sourceLedgerSelection(url.search),selected);
  const moved=new URL(preserveSourceSelection('/?period=week#overview',url.search),'https://example.com');
  assert.equal(moved.hash,'#overview');assert.equal(moved.searchParams.get('period'),'week');
  assert.deepEqual(sourceLedgerSelection(moved.search),selected);
  assert.equal(sourceLedgerSelection('?sourceStart=2026-10-01').endDate,'','an open end is preserved for editing and date filtering');
  assert.equal(sourceLedgerSelection('?sourceStart=2026-10-02&sourceEnd=2026-10-01').startDate,'2026-10-02','a reversed range stays available for explicit date validation');
});

test('malformed source links stay errors and sharing removes credentials without widening source selection',()=>{
  for(const search of ['?sourceView=wrong','?sourceView=works&sourceView=authors','?sourcePage=0','?sourcePage=1e2','?sourceStart=2026-02-30','?sourceMainOnly=true','?sourceQuery=%00bad','?sourceTrack=','?sourceAuthor=one','?sourceView=works&sourceAuthor=one&sourceAuthorIds=%5B%22two%22%5D','?sourcePassword=secret','?sourceView=works&sourceAuthor=one&sourceReturn=token%3Dsecret'])assert.throws(()=>sourceLedgerSelection(search),/来源列表/);
  assert.match(preserveSourceSelection('/#source','?sourceView=works&sourceView=authors'),/sourceView=works&sourceView=authors/);
  assert.throws(()=>sourceLedgerSelection('?sourceQuery='+ 'x'.repeat(10001)),/过长/);
  assert.throws(()=>sourceLedgerSelectionPath('//evil.invalid/',sourceLedgerDefaults),/地址无效/);
  const link=sourceLedgerShareLink('https://user:pass@example.com/?access_token=[REDACTED]&code=auth&importJob=internal&board=团团&theme=tuantuan&classification=slice&period=week&start=2026-09-12&end=2026-10-23&query=账号搜索&sort=likes.delta#overview',{...sourceLedgerDefaults,view:'works',query:'团团',page:2});
  assert.ok(!/secret|pass|user:|auth|internal/.test(link));
  const url=new URL(link);assert.equal(url.hash,'#source');assert.deepEqual([...url.searchParams.keys()],['sourceView','sourceQuery','sourcePage']);
  assert.equal(sourceLedgerSelection(url.search).page,2);
  assert.equal(sourceLedgerSelection(url.search).track,'all','an account classification is not a proven source-table track');
});

test('source share retains explicit source track and source-only author return without carrying account workspace state',()=>{
  const selection={...sourceLedgerDefaults,view:'works',track:'切片激励',authorFocus:{name:'作者 A',douyinId:'0012'},returnSelection:{...sourceLedgerDefaults,query:'作者',page:3}};
  const href=sourceLedgerShareLink('https://example.com/?board=其他矩阵&theme=tuantuan&classification=ai-remix&period=month&compareStart=2026-09-12&compareEnd=2026-10-23#source',selection);
  const url=new URL(href);
  assert.ok([...url.searchParams.keys()].every(key=>key.startsWith('source')));
  assert.equal(url.searchParams.get('sourceTrack'),'切片激励');
  assert.deepEqual(sourceLedgerSelection(url.search),selection);
  assert.equal(url.searchParams.get('sourceReturn').includes('theme'),false,'author return is scoped to source selections only');
});

test('actual React source navigation restores filters, reloads, back/forward, author return, date drafts and safe share fallback',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url)),main=process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../douyin-monitor-workbench/',import.meta.url));
  const {chromium}=createRequire(main+'package.json')('playwright-core');
  const authors=Array.from({length:65},(_,i)=>({row:i+1,name:`作者${i+1}`,douyinId:'id'+(i+1),posts:2,slicePosts:2,creationPosts:0,aiPosts:0,targetIds:[],plays:i,likes:0}));
  const works=authors.flatMap((row,i)=>[1,2].map(day=>({row:i*2+day,contentId:'73000000000000000'+String(i*2+day).padStart(3,'0'),author:row.name,douyinId:row.douyinId,publishDate:`2026-10-0${day}`,track:'切片激励',plays:i,likes:null,title:`${row.name}作品${day}`,url:null})));
  authors[31].douyinId='id33'; // Two source rows can share an ID; restore the exact row, not the first ID match.
  const bodies={'authors.json':JSON.stringify({revision:'A',items:authors}),'works-001.json':JSON.stringify({revision:'A',items:works})};
  const source={revision:'A',importedAt:'2026-10-23T00:00:00Z',stats:{authors:65,works:130},tracks:[{name:'切片激励'}],semantics:{plays:'表格累计播放',likes:'表格累计点赞'},files:Object.entries(bodies).map(([path,body])=>({path,bytes:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex'),count:path==='authors.json'?65:130}))};
  const fixture=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {CreatorSourceLedger} from './components/creator-source-panel';const source=${JSON.stringify(source)};function Fixture(){const [focus,setFocus]=useState(null),[active,setActive]=useState(true);window.fixture={setFocus,setActive};return <section data-source-fixture hidden={!active}><CreatorSourceLedger addressMode active={active} source={source} foundation={null} accounts={[]} focus={focus} onOpenAccount={()=>{}}/></section>};createRoot(document.getElementById('root')).render(<Fixture/>);`;
  const bundle=await build({stdin:{contents:fixture,resolveDir:root,sourcefile:'source-navigation-fixture.tsx',loader:'tsx'},absWorkingDir:root,bundle:true,write:false,outfile:'source-navigation-fixture.js',format:'iife',platform:'browser',jsx:'automatic',tsconfig:root+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'}});
  const script=bundle.outputFiles.find(file=>file.path.endsWith('.js')).text;
  let authorsGate=null,releaseAuthors=null;
  const delayAuthors=()=>{authorsGate=new Promise(resolve=>{releaseAuthors=()=>{authorsGate=null;resolve();};});};
  const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
  try{const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});try{
    await context.addInitScript(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('denied');}}});window.exported=[];URL.createObjectURL=blob=>{window.exported.push(blob);return 'blob:fixture';};HTMLAnchorElement.prototype.click=function(){};});
    await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><div id="root"></div><script src="/fixture.js"></script>'});if(url.pathname==='/fixture.js')return route.fulfill({contentType:'text/javascript',body:script});const body=bodies[url.pathname.replace('/creator-source/','')];if(url.pathname==='/creator-source/authors.json'&&authorsGate)await authorsGate;return body?route.fulfill({contentType:'application/json',body}):route.abort();});
    const page=await context.newPage();
    await page.goto('http://127.0.0.1:9999/?period=custom&start=2026-09-12&end=2026-10-23&sourceQuery=%E4%BD%9C%E8%80%85&sourceSort=row&sourcePage=2#source');
    const count=text=>page.getByText(text,{exact:true}).waitFor();
    await count('符合条件 65 条 · 第 2/3 页');
    await page.evaluate(()=>window.fixture.setActive(false));await page.waitForFunction(()=>document.querySelector('[data-source-fixture]').hidden);
    await page.evaluate(()=>{history.replaceState(history.state,'','/?period=custom&start=2026-09-12&end=2026-10-23&sourceQuery=作者3&sourceSort=row#overview');window.dispatchEvent(new PopStateEvent('popstate'));window.dispatchEvent(new HashChangeEvent('hashchange'));});
    assert.match(await page.locator('[data-source-fixture]').textContent(),/符合条件 65 条 · 第 2\/3 页/,'hidden source workspace does not consume another view address');
    await page.evaluate(()=>{history.replaceState(history.state,'',location.href.replace('#overview','#source'));window.fixture.setActive(true);});await count('符合条件 11 条 · 第 1/1 页');assert.equal(await page.getByLabel('搜索来源作者或作品').inputValue(),'作者3');
    await page.getByLabel('搜索来源作者或作品').fill('作者');await page.getByRole('button',{name:'下一页',exact:true}).first().click();await count('符合条件 65 条 · 第 2/3 页');
    const origin=page.locator('[data-source-author="id31"]');
    assert.equal(await page.getByRole('region',{name:'来源作者数据表',exact:true}).count(),1,'the actual author table exposes its named keyboard scroll region');
    await origin.scrollIntoViewIfNeeded();await origin.focus();const authorScroll=await page.evaluate(()=>({x:scrollX,y:scrollY}));
    await origin.press('Enter');
    await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='当前作者作品与主页数据');
    await page.getByRole('region',{name:'来源作品数据表',exact:true}).waitFor();
    await page.getByRole('button',{name:'返回作者记录',exact:true}).press('Enter');
    await page.waitForFunction(()=>document.activeElement?.getAttribute('data-source-author')==='id31');
    assert.deepEqual(await page.evaluate(()=>({x:scrollX,y:scrollY})),authorScroll,'explicit author return restores the exact original page position');
    const duplicateOrigin=page.locator('[data-source-author="id33"]').nth(1);
    const duplicateKey=await duplicateOrigin.getAttribute('data-source-author-row');
    await duplicateOrigin.press('Enter');await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='当前作者作品与主页数据');
    await page.getByRole('button',{name:'返回作者记录',exact:true}).press('Enter');
    await page.waitForFunction(key=>document.activeElement?.getAttribute('data-source-author-row')===key,duplicateKey);
    await origin.press('Enter');
    await count('符合条件 2 条 · 第 1/1 页');assert.equal(new URL(page.url()).searchParams.get('sourceAuthor'),'id31');
    assert.equal(new URL(page.url()).searchParams.get('start'),'2026-09-12');
    await page.goBack();await count('符合条件 65 条 · 第 2/3 页');assert.equal(await page.getByLabel('搜索来源作者或作品').inputValue(),'作者');
    await page.goForward();await count('符合条件 2 条 · 第 1/1 页');
    await page.reload();await count('符合条件 2 条 · 第 1/1 页');
    delayAuthors();await page.getByRole('button',{name:'返回作者记录',exact:true}).click();
    await page.getByText('正在校验并读取 作者记录…',{exact:true}).waitFor();releaseAuthors();
    await count('符合条件 65 条 · 第 2/3 页');
    await page.waitForFunction(()=>document.activeElement?.getAttribute('data-source-author')==='id31');
    // A freshly loaded works link has no author cache. A later user focus must win.
    await page.goBack();await count('符合条件 2 条 · 第 1/1 页');await page.reload();await count('符合条件 2 条 · 第 1/1 页');
    delayAuthors();await page.getByRole('button',{name:'返回作者记录',exact:true}).click();
    await page.getByText('正在校验并读取 作者记录…',{exact:true}).waitFor();
    const sourceSearch=page.getByLabel('搜索来源作者或作品');await sourceSearch.focus();
    const focusScroll=await page.evaluate(()=>scrollY);releaseAuthors();await count('符合条件 65 条 · 第 2/3 页');
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await sourceSearch.evaluate(element=>document.activeElement===element),true,'late author fetch does not steal the user new focus');
    assert.equal(await page.evaluate(()=>scrollY),focusScroll,'late author fetch does not jump away from the user new location');
    const historyCount=await page.evaluate(()=>history.length);
    await page.getByLabel('搜索来源作者或作品').fill('作者1');await count('符合条件 11 条 · 第 1/1 页');assert.equal(await page.evaluate(()=>history.length),historyCount);
    await page.reload();await count('符合条件 11 条 · 第 1/1 页');
    await page.evaluate(()=>window.fixture.setFocus({view:'works',startDate:'2026-10-01',endDate:'2026-10-01',mainTableOnly:true}));await count('符合条件 65 条 · 第 1/3 页');
    assert.equal(new URL(page.url()).searchParams.get('sourceStart'),'2026-10-01');assert.equal(new URL(page.url()).searchParams.get('end'),'2026-10-23');
    await page.getByRole('button',{name:'下一页',exact:true}).first().click();await count('符合条件 65 条 · 第 2/3 页');
    await page.reload();await count('符合条件 65 条 · 第 2/3 页');
    await page.getByLabel('作品发布日期结束').fill('');assert.equal(await page.getByLabel('作品发布日期开始').inputValue(),'2026-10-01');assert.equal(new URL(page.url()).searchParams.has('sourceEnd'),false);
    await page.getByLabel('作品发布日期结束').fill('2026-09-30');await page.getByRole('alert').filter({hasText:'开始日期不能晚于结束日期'}).waitFor();assert.equal(await page.getByRole('button',{name:'导出全部筛选结果'}).isDisabled(),true);
    await page.getByLabel('作品发布日期结束').fill('2026-10-01');await page.getByRole('button',{name:'导出全部筛选结果'}).click();
    assert.equal((await page.evaluate(async()=>window.exported.at(-1).text())).split('\r\n').length,66);
    await page.evaluate(()=>history.replaceState(history.state,'',location.href.replace('#source','&access_token=[REDACTED]#source')));
    await page.getByRole('button',{name:'复制当前筛选链接'}).click();const link=await page.getByLabel('当前筛选分享链接').inputValue();assert.ok(!link.includes('secret'));assert.equal(new URL(link).searchParams.get('sourceStart'),'2026-10-01');
    await page.goto('http://127.0.0.1:9999/?sourcePage=0#source');await page.getByRole('alert').filter({hasText:'页码无效'}).waitFor();assert.equal(await page.locator('tbody tr').count(),0);
    await page.getByRole('button',{name:'重置来源筛选'}).click();await count('符合条件 65 条 · 第 1/3 页');
    await page.goto('http://127.0.0.1:9999/?sourcePage=500#source');await page.getByRole('alert').filter({hasText:'链接请求第 500 页'}).waitFor();await page.getByRole('button',{name:'回到第一页'}).click();await count('符合条件 65 条 · 第 1/3 页');
    await page.goto('http://127.0.0.1:9999/?sourceView=works&sourceView=authors#source');await page.getByRole('alert').filter({hasText:'重复参数'}).waitFor();assert.equal(await page.locator('tbody tr').count(),0);
    await page.evaluate(()=>window.fixture.setActive(false));await page.waitForFunction(()=>document.querySelector('[data-source-fixture]').hidden);
    await page.evaluate(()=>{history.replaceState(history.state,'','/?sourceQuery=作者2&sourcePage=2#source');window.fixture.setActive(true);window.fixture.setFocus({view:'works',startDate:'2026-10-01',endDate:'2026-10-01',mainTableOnly:true});});
    await count('符合条件 65 条 · 第 1/3 页');assert.equal(new URL(page.url()).searchParams.get('sourceView'),'works');assert.equal(new URL(page.url()).searchParams.has('sourceQuery'),false,'fresh explicit drilldown wins the same-render restored address');
    // Hiding the workspace for an account/page navigation also cancels an in-flight return.
    const focusedLink=sourceLedgerSelectionPath('/?theme=tuantuan#source',{...sourceLedgerDefaults,view:'works',authorFocus:{name:'作者31',douyinId:'id31'},returnSelection:{...sourceLedgerDefaults,sort:'row',page:2}});
    for(const eventName of ['wheel','touchstart']){
      await page.goto('http://127.0.0.1:9999'+focusedLink);await count('符合条件 2 条 · 第 1/1 页');
      delayAuthors();await page.getByRole('button',{name:'返回作者记录',exact:true}).click();
      await page.getByText('正在校验并读取 作者记录…',{exact:true}).waitFor();
      await page.evaluate(name=>document.dispatchEvent(new Event(name,{bubbles:true})),eventName);
      releaseAuthors();await count('符合条件 65 条 · 第 2/3 页');
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert.equal(await page.evaluate(()=>document.activeElement===document.body),true,eventName+' cancels pending author focus');
    }
    await page.goto('http://127.0.0.1:9999'+focusedLink);await count('符合条件 2 条 · 第 1/1 页');
    delayAuthors();await page.getByRole('button',{name:'返回作者记录',exact:true}).click();
    await page.getByText('正在校验并读取 作者记录…',{exact:true}).waitFor();
    await page.evaluate(()=>{window.fixture.setActive(false);history.replaceState(history.state,'','/?account=7');});
    await page.waitForFunction(()=>document.querySelector('[data-source-fixture]').hidden);const hiddenScroll=await page.evaluate(()=>scrollY);
    releaseAuthors();await page.waitForFunction(()=>document.querySelector('[data-source-author="id31"]'));
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(()=>document.activeElement===document.body),true,'account navigation prevents hidden source focus');
    assert.equal(await page.evaluate(()=>scrollY),hiddenScroll,'hidden source completion does not move the account page');
  }finally{releaseAuthors?.();await context.close();}}finally{await browser.close();}
});
