import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const root = new URL('../', import.meta.url);
const css = readFileSync(new URL('public/rebuild.css', root), 'utf8');
const js = readFileSync(process.env.PHASE107_JS_SOURCE || new URL('public/rebuild.js', root), 'utf8');
const model = readFileSync(new URL('public/console-model.js', root), 'utf8');
const html = readFileSync(new URL('public/rebuild.html', root), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '').replace('</head>', `<style>${css}</style></head>`);

test('real native disclosures preserve identity, keyboard focus and anonymous reading state through rerender', async () => {
  const browser = await chromium.launch({ headless:true, executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args:['--disable-background-networking'] });
  try {
    const page = await browser.newPage({ viewport:{width:390,height:844}, hasTouch:true, reducedMotion:'reduce' });
    await page.route('**/*', route => route.request().url() === 'http://fixture.invalid/' ? route.fulfill({contentType:'text/html',body:html}) : route.abort());
    await page.goto('http://fixture.invalid/');
    await page.addScriptTag({type:'module',content:js.replace("'./console-model.js'", JSON.stringify('data:text/javascript;base64,' + Buffer.from(model).toString('base64'))).replace(/void init\(\);\s*$/, '') + '\nif(typeof ledgerMode!==\'undefined\')ledgerMode=\'full\';window.subject={state,enhanceShell,renderAccounts,setView,captureReadingPosition,restoreReadingPosition};'});
    await page.waitForFunction(() => !!window.subject);
    await page.evaluate(() => {
      const s=window.subject;s.enhanceShell();
      const accounts=[12345,0,null].map((value,index)=>({id:index+1,label:'作者'+(index+1),enabled:true,platform:'douyin',boards:[],status:{},collection:{},metrics:Object.fromEntries(['followers','likes','posts','estimatedPlays'].map(key=>[key,{value,delta:index===0?-9:value,reason:index===0?'前一日基准缺采；<img src=x onerror="window.injected=1"> & 原始说明。'.repeat(8):'',deltaReliable:true}]))}));
      Object.assign(s.state,{view:'accounts',period:'custom',start:'2026-09-25',end:'2026-10-01',sort:'followers.value',direction:'desc',data:{period:'custom',range:{startDate:'2026-09-25',endDate:'2026-10-01'},accounts}});
      s.renderAccounts();s.setView('accounts',{renderData:false});
    });
    const first=page.locator('#accountsTable tbody tr').first().locator('td').nth(1);
    assert.equal(await first.locator('.metric').innerText(),'1.23万');
    assert.equal(await first.locator('.metric-exact').count(),1,'compacted stock requires a visible exact secondary line');
    assert.equal(await first.locator('.metric-exact').innerText(),'记录 12,345');
    assert.equal(await page.locator('#accountsTable tbody tr').nth(1).locator('.account-metric-reason').count(),0);
    assert.equal(await page.locator('#accountsTable tbody tr').nth(2).locator('.metric-exact').count(),0);
    assert.equal(await page.locator('#accountsTable img').count(),0);
    const summary=first.locator('summary'),id=await summary.getAttribute('id');
    assert.ok(id);assert.equal(await summary.innerText(),'粉丝数说明');
    assert.ok((await summary.boundingBox()).height>=44);
    await summary.focus();await page.keyboard.press('Enter');
    assert.equal(await first.locator('details').getAttribute('open'),'');
    assert.match(await first.locator('p').innerText(),/<img src=x/);
    assert.equal(await page.evaluate(()=>window.injected),undefined);
    await page.evaluate(()=>{window.subject.state.direction='asc';window.subject.renderAccounts();});
    assert.equal(await page.evaluate(()=>document.activeElement.id),id);
    assert.equal(await page.evaluate(id=>document.getElementById(id).parentElement.open,id),true);
    assert.equal(await page.evaluate(id=>document.getElementById(id).closest('tr').querySelector('[data-account-id]').dataset.accountId,id),'1');
    await page.keyboard.press('Space');
    assert.equal(await page.evaluate(id=>document.getElementById(id).parentElement.open,id),false);
    await page.evaluate(id=>document.getElementById(id).scrollIntoView({block:'center'}),id);
    await page.locator('summary').filter({hasText:'粉丝数说明'}).last().tap();
    assert.equal(await page.evaluate(id=>document.getElementById(id).parentElement.open,id),true);
    assert.equal(await first.count(),1);
    const anonymous=await page.evaluate(()=>{
      const s=window.subject,marker=document.createElement('details');marker.innerHTML='<summary>独立旧说明</summary><p>旧内容</p>';marker.open=true;document.body.append(marker);
      document.querySelector('#pageTitle').focus();const snapshot=s.captureReadingPosition();
      s.state.data.accounts[1].metrics.followers.reason='新出现的说明';s.renderAccounts();marker.open=false;s.restoreReadingPosition(snapshot);
      const owner=[...document.querySelectorAll('#accountsTable .account-metric-reason')].find(el=>el.closest('tr').querySelector('[data-account-id]').dataset.accountId==='1');
      return {anonymous:marker.open,owner:owner.open,distinctIds:new Set([...document.querySelectorAll('.account-metric-reason')].map(el=>el.id)).size,count:document.querySelectorAll('.account-metric-reason').length};
    });
    assert.equal(anonymous.anonymous,true);assert.equal(anonymous.owner,true);assert.equal(anonymous.distinctIds,anonymous.count);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    const reasonBox=await page.evaluate(id=>{const p=document.getElementById(id).nextElementSibling,r=p.getBoundingClientRect();return {width:r.width,scroll:p.scrollWidth,client:p.clientWidth};},id);
    assert.ok(reasonBox.width<300);assert.ok(reasonBox.scroll<=reasonBox.client+1);
  } finally { await browser.close();assert.equal(browser.isConnected(),false); }
});
