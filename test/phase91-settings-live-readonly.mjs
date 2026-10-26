// Read-only production UI inspection. All non-read requests are blocked before dispatch.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const out='data/maintenance-journal/phase91ux';
const label=process.env.PHASE91_LIVE_RUN||'live-before';
assert.match(label,/^[a-z0-9-]+$/);mkdirSync(out,{recursive:true});
const hash=x=>createHash('sha256').update(x).digest('hex');
const proof={startedAt:new Date().toISOString(),scope:'actual local live read-only UI plus actual public read-only UI; no save',credentialsRead:false,platformCollection:false,blockedMutations:[],pageErrors:[],pages:[]};
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 for(const [name,url] of [['local-root','http://127.0.0.1:4188/'],['local-index','http://127.0.0.1:4188/index.html'],['public','https://mcn-matrix-observatory.slowlygold4.chatgpt.site/']]){
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  await context.route('**/*',route=>{const r=route.request();if(!['GET','HEAD','OPTIONS'].includes(r.method())){const path=new URL(r.url()).pathname;proof.blockedMutations.push({name,method:r.method(),kind:path.startsWith('/cdn-cgi/')?'edge-background':'application'});return route.abort();}return route.continue();});
  const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>proof.pageErrors.push({name,message:e.message}));
  try{
   const response=await page.goto(url,{waitUntil:'networkidle',timeout:45000});
   const html=await response.body();const buttons=await page.getByRole('button').allTextContents();
   const item={name,status:response.status(),htmlSha256:hash(html),usesRebuildScript:html.toString().includes('/rebuild.js'),title:await page.title(),settingsButtonCount:await page.getByRole('button',{name:/采集设置|数据源与定时设置/}).count(),visibleSettingsButtonCount:await page.getByRole('button',{name:/采集设置|数据源与定时设置/}).filter({visible:true}).count(),settingsForms:await page.locator('form#settingsForm,form#collectionSettingsForm,form#worksSettingsForm').count(),writeControlLabels:buttons.map(x=>x.trim()).filter(x=>/采集设置|保存设置|立即采集|数据源与定时设置/.test(x))};
   const header=page.locator('header').first();const file=out+'/'+label+'-'+name+'.png';if(await header.count())await header.screenshot({path:file});else await page.screenshot({path:file,fullPage:false});item.screenshot={path:file,sha256:hash(readFileSync(file))};proof.pages.push(item);
  }finally{await context.close();}
 }
 assert.equal(proof.blockedMutations.filter(x=>x.kind==='application').length,0);assert.deepEqual(proof.pageErrors,[]);
 const local=proof.pages.filter(x=>x.name.startsWith('local'));assert.equal(local[0].htmlSha256,local[1].htmlSha256,'/index.html must resolve to the same actual default shell');
 assert.equal(proof.pages.find(x=>x.name==='public').writeControlLabels.length,0,'public read-only end must not expose configuration writes');proof.passed=true;
}catch(e){proof.passed=false;proof.failure=e.message;process.exitCode=1;}finally{await browser.close();proof.closedFreshContexts=true;proof.finishedAt=new Date().toISOString();writeFileSync(out+'/'+label+'.json',JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(proof));}
