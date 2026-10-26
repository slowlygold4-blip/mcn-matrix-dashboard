// Actual production UI, GET only. Never reads authentication payloads/headers/cookies.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const origin='http://127.0.0.1:4188',out='data/maintenance-journal/phase91ux',label=process.env.PHASE91_ECHO_RUN||'live-echo-final';
assert.match(label,/^[a-z0-9-]+$/);mkdirSync(out,{recursive:true});const hash=x=>createHash('sha256').update(x).digest('hex');
const proof={startedAt:new Date().toISOString(),actualLocalLive:true,publicDeploymentClaim:false,productionPost:false,credentialsRead:false,sourceHashes:{},blockedRequests:0,pageErrors:[]};
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});const page=await context.newPage();page.setDefaultTimeout(20000);
await context.route('**/*',route=>{const r=route.request();if(!['GET','HEAD','OPTIONS'].includes(r.method())||new URL(r.url()).origin!==origin){proof.blockedRequests++;return route.abort();}return route.continue();});
const reads=[];page.on('response',r=>{const path=new URL(r.url()).pathname;if(['/','/rebuild.js','/works-settings.js','/rebuild.css'].includes(path))reads.push(r.body().then(x=>proof.sourceHashes[path]=hash(x)));});page.on('pageerror',e=>proof.pageErrors.push(e.message));
try{
 await page.goto(origin+'/',{waitUntil:'domcontentloaded'});const opener=page.locator('#worksSettingsButton');await opener.waitFor({state:'visible'});
 const responsePromise=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/settings'&&r.request().method()==='GET');
 await opener.focus();await page.keyboard.press('Enter');const response=await responsePromise;assert.equal(response.status(),200);const settings=await response.json();
 assert.deepEqual(Object.keys(settings).sort(),['publicPostsPerAccount','publicWorksPageMode','publicWorksPageHardLimit','publicWorksRequestThreshold'].sort());
 await page.waitForFunction(()=>!document.getElementById('worksPageMode').disabled);proof.settings=settings;
 for(const [id,key] of [['worksPageMode','publicWorksPageMode'],['worksLegacyLimit','publicPostsPerAccount'],['worksHardLimit','publicWorksPageHardLimit'],['worksThreshold','publicWorksRequestThreshold']])assert.equal(await page.locator('#'+id).inputValue(),String(settings[key]));
 proof.savedCaption=await page.locator('#worksSettingsSaved').innerText();proof.statusCaption=await page.locator('#worksSettingsStatus').innerText();
 assert.match(proof.statusCaption,/已读取/);assert.match(proof.savedCaption,/已保存/);
 const file=out+'/'+label+'.png';await page.locator('#worksSettingsDialog').screenshot({path:file});proof.screenshot={path:file,sha256:hash(readFileSync(file))};
 await page.keyboard.press('Escape');proof.returnFocus=await opener.evaluate(x=>document.activeElement===x);assert.equal(proof.returnFocus,true);
 await Promise.all(reads);assert.equal(proof.blockedRequests,0);assert.deepEqual(proof.pageErrors,[]);proof.passed=true;
}catch(e){proof.passed=false;proof.failure=e.message;process.exitCode=1;}finally{await context.close();await browser.close();proof.closedFreshBrowser=true;proof.finishedAt=new Date().toISOString();writeFileSync(out+'/'+label+'.json',JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(proof));}
