import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
// Independent synthetic browser contract. Never contacts production or platform APIs.
const root=process.env.PHASE111_BROWSER_ROOT||fileURLToPath(new URL('../',import.meta.url));
const {chromium}=createRequire(root+'/package.json')('playwright-core');
test('compact native ledger: click sorting, auto resize, print restoration and close owner isolation', {timeout:30000}, async()=>{
 const read=name=>fs.readFileSync(root+'/public/'+name,'utf8');
 const html=read('rebuild.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,'').replace('</head>','<style>'+read('rebuild.css')+'</style></head>');
 const accounts=Array.from({length:25},(_,i)=>({id:i+1,label:`独立合成账号${i+1}`,publicId:`fixture_${i+1}`,platform:'douyin',enabled:true,boards:[],collection:{},status:{lastSuccessAt:'2026-10-02T02:00:00.000Z'},metrics:Object.fromEntries(['followers','likes','posts','estimatedPlays'].map(key=>[key,{value:i,delta:i+1,dailyComparable:i!==0,currentAt:'2026-10-02T02:00:00.000Z'}])),trend:[{date:'2026-10-02',followersDelta:0,likesDelta:-5,postsDelta:null}]}));
 const data={period:'day',range:{startDate:'2026-10-02',endDate:'2026-10-02'},summary:{enabledCount:25,metrics:{},trend:[]},accounts,boards:[]};
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!=='http://fixture.invalid')return route.abort();if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:html});const m=/^\/api\/rebuild\/accounts\/(\d+)\/insights$/.exec(u.pathname);if(m)return route.fulfill({json:{account:accounts.find(a=>a.id===Number(m[1])),recentWorks:[]}});return route.abort();});
  await page.goto('http://fixture.invalid/');
  await page.addScriptTag({type:'module',content:read('rebuild.js').replace("'./console-model.js'",JSON.stringify('data:text/javascript;base64,'+Buffer.from(read('console-model.js')).toString('base64'))).replace(/void init\(\);\s*$/,'')+'\nwindow.subject={state,enhanceShell,setupDates,renderAccounts,setView,busy,bind,rows,openAccount,closeAccount};'});
  await page.waitForFunction(()=>window.subject);
  await page.evaluate(data=>{subject.enhanceShell();Object.assign(subject.state,{view:'accounts',period:'day',sort:'followers.delta',direction:'desc',data});subject.setupDates();subject.renderAccounts();subject.setView('accounts',{renderData:false});subject.busy(false);subject.bind();},data);
  assert.equal(await page.locator('#ledgerMode').inputValue(),'auto');assert.equal(await page.locator('#accountsTable th').count(),2);
  assert.ok(await page.locator('#accountsTable').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
  const descending=[...Array(24)].map((_,i)=>25-i).concat(1),ascending=[...Array(24)].map((_,i)=>i+2).concat(1);
  assert.deepEqual(await page.evaluate(()=>subject.rows().map(a=>a.id)),descending);
  await page.locator('#accountsTable [data-sort="followers.delta"]').click();assert.deepEqual(await page.evaluate(()=>subject.rows().map(a=>a.id)),ascending);
  await page.locator('#accountsTable [data-sort="followers.delta"]').click();assert.deepEqual(await page.evaluate(()=>subject.rows().map(a=>a.id)),descending);
  await page.setViewportSize({width:1440,height:900});await page.waitForFunction(()=>document.querySelectorAll('#accountsTable th').length===11);
  await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>document.querySelectorAll('#accountsTable th').length===2);
  await page.locator('#accountsPagerTop [data-page="next"]').click();const ids=await page.locator('#accountsTable [data-account-id]').evaluateAll(es=>es.map(e=>e.dataset.accountId));
  await page.evaluate(()=>window.dispatchEvent(new Event('beforeprint')));assert.equal(await page.locator('#accountsTable th').count(),11);
  await page.evaluate(()=>window.dispatchEvent(new Event('afterprint')));assert.equal(await page.locator('#accountsTable th').count(),2);assert.equal(await page.locator('#ledgerMode').inputValue(),'auto');assert.equal(await page.evaluate(()=>subject.state.page),2);assert.deepEqual(await page.locator('#accountsTable [data-account-id]').evaluateAll(es=>es.map(e=>e.dataset.accountId)),ids);
  await page.evaluate(()=>subject.openAccount(1));await page.evaluate(()=>{subject.closeAccount();void subject.openAccount(2);});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(()=>subject.state.detailId),2,'an old queued close must not clear the new account owner');assert.equal(await page.locator('#accountDialog').evaluate(e=>e.open),true);await page.waitForFunction(()=>document.querySelector('#dialogBody').getAttribute('aria-busy')==='false');assert.match(await page.locator('#dialogMeta').innerText(),/fixture_2/);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();assert.equal(browser.isConnected(),false);}
});
