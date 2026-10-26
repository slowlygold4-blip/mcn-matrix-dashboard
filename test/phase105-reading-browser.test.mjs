import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const root=new URL('../',import.meta.url);
const css=readFileSync(new URL('public/rebuild.css',root),'utf8');
const js=readFileSync(new URL('public/rebuild.js',root),'utf8');
const model=readFileSync(new URL('public/console-model.js',root),'utf8');
const html=readFileSync(new URL('public/rebuild.html',root),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,'').replace('</head>','<style>'+css+'</style></head>');
const report={scope:'actual isolated HTML/CSS/controller/model, synthetic 45 accounts; no production/API/external requests',checks:[]};
async function fixture(run) {
  const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
    await page.route('**/*',route=>route.request().url()==='http://fixture.invalid/'?route.fulfill({contentType:'text/html',body:html}):route.abort());
    await page.goto('http://fixture.invalid/');
    await page.addScriptTag({type:'module',content:js.replace("'./console-model.js'",JSON.stringify('data:text/javascript;base64,'+Buffer.from(model).toString('base64'))).replace(/void init\(\);\s*$/,'')+'\nif(typeof ledgerMode!==\'undefined\')ledgerMode=\'full\';window.subject={state,enhanceShell,renderAccounts,setView,busy,setupDates,bind,openAccount,closeAccount,changeAccountPage};'});
    await page.waitForFunction(()=>!!window.subject);
    await page.evaluate(()=>{
      const s=window.subject;s.enhanceShell();
      const accounts=Array.from({length:45},(_,i)=>({id:i+1,label:'连续核对作者'+String(i+1).padStart(2,'0'),publicId:'author_'+(i+1),enabled:true,platform:'douyin',boards:[],collection:{},classification:{theme:{key:'tuantuan',label:'团团'},labels:[{label:'切片',color:'slate'}]},status:{lastSuccessAt:'2026-10-01T02:00:00Z'},metrics:Object.fromEntries(['followers','likes','estimatedPlays','posts'].map(key=>[key,{value:i===44?null:1000+i,delta:i===44?null:22-i,deltaReliable:true,currentAt:'2026-10-01T02:00:00Z'}])),trend:[{date:'2026-10-01',followers:1000+i,followersDelta:-9,likes:2000,likesDelta:0,posts:10,postsDelta:null}]}));
      Object.assign(s.state,{view:'accounts',sort:'posts.delta',direction:'desc',theme:'tuantuan',classification:'slice',period:'custom',start:'2026-09-25',end:'2026-10-01',data:{period:'custom',range:{startDate:'2026-09-25',endDate:'2026-10-01'},summary:{enabledCount:45},accounts}});
      // Only the read-only HTTP transport is replaced; the real detail render and dialog lifecycle execute.
      window.fetch=async path=>({ok:true,json:async()=>({account:accounts.find(a=>a.id===Number(String(path).match(/accounts\/(\d+)/)?.[1]))})});
      s.setupDates();s.renderAccounts();s.setView('accounts',{renderData:false});s.busy(false);s.bind();
      document.querySelector('#operationsDetails').hidden=true;
    });
    await run(page);
  } finally {
    await browser.close();assert.equal(browser.isConnected(),false);report.closed=true;
    if(process.env.PHASE105_BROWSER_REPORT)writeFileSync(process.env.PHASE105_BROWSER_REPORT,JSON.stringify(report,null,2)+'\n');
  }
}
async function reading(page,selector) {
  return page.locator(selector).first().evaluate(el=>{
    const rgb=s=>(s.match(/[\d.]+/g)||[]).map(Number),style=getComputedStyle(el);let p=el,bg=[255,255,255];
    while(p){const v=rgb(getComputedStyle(p).backgroundColor);if(v.length===3||v[3]===1){bg=v;break;}p=p.parentElement;}
    const lum=v=>v.slice(0,3).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((s,x,i)=>s+x*[.2126,.7152,.0722][i],0);
    const a=lum(rgb(style.color)),b=lum(bg);return{text:el.textContent,color:style.color,bg,contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
  });
}
test('actual mobile summary, keyboard sort/detail return and semantic contrast',async()=>fixture(async page=>{
  await page.setViewportSize({width:390,height:844});
  const summary=page.locator('#accountCount');assert.match(await summary.innerText(),/当前按作品净变化 · 从高到低 · 缺测最后/);
  assert.ok(await summary.evaluate(el=>el.getBoundingClientRect().right<=innerWidth));
  await page.locator('#accountsTable [data-sort="followers.delta"]').focus();await page.keyboard.press('Enter');
  assert.match(await summary.innerText(),/当前按粉丝净变化 · 从高到低/);
  await page.keyboard.press('Enter');assert.match(await summary.innerText(),/当前按粉丝净变化 · 从低到高/);
  assert.equal(await page.locator('#accountsTable tbody tr').first().locator('td').nth(2).innerText(),'-21');
  await page.evaluate(()=>document.querySelector('#accountsTable').scrollLeft=0);
  const first=page.locator('#accountsTable [data-account-id]').first();const id=await first.getAttribute('data-account-id');
  await first.focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('#dialogBody')?.textContent.includes('逐日变化明细'));
  assert.match(await page.locator('#dialogBody').innerText(),/粉丝净变化/);assert.match(await page.locator('#dialogBody').innerText(),/获赞净变化/);
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#accountDialog').open);
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.accountId),id);
  assert.match(await summary.innerText(),/当前按粉丝净变化 · 从低到高/);
  await page.evaluate(()=>{const div=document.createElement('div');div.id='contrastFixture';div.innerHTML='<div class="topic-stat"><span class="topic-missing">当前显示历史观测</span></div><div class="load-feedback" data-state="warning">筛选需要检查</div>';document.body.append(div);document.querySelector('#overviewView').hidden=false;});
  for(const selector of ['.topic-stat .topic-missing','.load-feedback[data-state="warning"]','#overviewView > .metric-boundary']){const value=await reading(page,selector);assert.ok(value.contrast>=4.5,JSON.stringify(value));report.checks.push({selector,...value});}
  await page.emulateMedia({media:'print'});
  for(const selector of ['.topic-stat .topic-missing','.load-feedback[data-state="warning"]','#overviewView > .metric-boundary']){const value=await reading(page,selector);assert.ok(value.contrast>=4.5,JSON.stringify(value));report.checks.push({media:'print',selector,...value});}
}));
test('actual bounded ledger keeps column headers on rows 1/10/20, horizontal scroll, keyboard exit, paging and refresh',async()=>fixture(async page=>{
  const table=page.locator('#accountsTable');
  assert.equal(await table.getAttribute('tabindex'),'0');assert.equal(await table.getAttribute('role'),'region');
  for(const view of [{width:1440,height:900},{width:390,height:844},{width:720,height:450}]) {
    await page.setViewportSize(view);await table.scrollIntoViewIfNeeded();
    for(const fraction of [0,.5,1]) {
      await table.evaluate((el,f)=>{el.scrollTop=(el.scrollHeight-el.clientHeight)*f;el.scrollLeft=f?250:0;},fraction);
      const rects=await table.evaluate(el=>{const t=el.getBoundingClientRect(),head=el.querySelector('th:nth-child(5)').getBoundingClientRect(),first=el.querySelector('th').getBoundingClientRect();return{top:t.top,bottom:t.bottom,height:t.height,headTop:head.top,headBottom:head.bottom,firstLeft:first.left,left:t.left,scrollTop:el.scrollTop,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight};});
      assert.ok(rects.scrollHeight>rects.clientHeight,'the table, not document, scrolls');
      assert.ok(rects.headTop>=rects.top&&rects.headBottom<=rects.bottom,JSON.stringify(rects));
      assert.ok(Math.abs(rects.firstLeft-rects.left)<=2,'sticky identity/header intersection');
      report.checks.push({view,fraction,...rects});
      if(process.env.PHASE105_SCREENSHOT_DIR && fraction===1) await page.screenshot({path:`${process.env.PHASE105_SCREENSHOT_DIR}/ledger-${view.width}.png`});
    }
    await table.focus();await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.dataset.page),'next');
    await table.focus();await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.dataset.sort),'label');
    await table.focus();await page.keyboard.press('Control+End');
    await page.locator('#pager [data-page="next"]').focus();await page.keyboard.press('Enter');
    assert.equal(await table.evaluate(el=>el.scrollTop),0,'new page begins at its first row');
    await table.evaluate(el=>{el.scrollTop=250;el.scrollLeft=150;});
    const before=await table.evaluate(el=>({top:el.scrollTop,left:el.scrollLeft}));
    await page.evaluate(()=>window.subject.renderAccounts());
    assert.deepEqual(await table.evaluate(el=>({top:el.scrollTop,left:el.scrollLeft})),before,'data rerender keeps local reading position');
    await page.evaluate(()=>{window.subject.state.page=1;window.subject.renderAccounts();});
  }
  await page.emulateMedia({media:'print'});assert.equal(await table.evaluate(el=>getComputedStyle(el).maxHeight),'none');
}));
