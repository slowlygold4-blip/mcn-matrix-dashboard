// Actual UI + actual HTTP/API/SQLite. Writes only to this run's temporary database.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const out='data/maintenance-journal/phase91ux',label=process.env.PHASE91_CHROME_RUN||'candidate-chrome-1';
assert.match(label,/^[a-z0-9-]+$/);mkdirSync(out,{recursive:true});
const source=resolve(process.env.PHASE91_SERVER_DIR||'.'),dir=mkdtempSync(join(tmpdir(),'phase91-ux-'));
const hash=x=>createHash('sha256').update(x).digest('hex');
const proof={startedAt:new Date().toISOString(),actualChrome:true,actualHttpApi:true,temporaryDatabase:true,productionPost:false,apiLogicMocking:false,credentialsRead:false,cases:[],errors:[],screens:[],sourceHashes:{}};
for(const f of ['server.mjs','lib/database.mjs','public/rebuild.html','public/rebuild.js','public/rebuild.css','public/works-settings.js'])proof.sourceHashes[f]=hash(readFileSync(join(source,f)));
let browser,server,db,context;const previousData=process.env.DATA_DIR;process.env.DATA_DIR=dir;
try{
 ({server}=await import(pathToFileURL(join(source,'server.mjs')).href));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${server.address().port}`;assert.notEqual(server.address().port,4188);
 db=new DatabaseSync(join(dir,'douyin-monitor.sqlite'));
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
 await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>proof.errors.push(e.message));
 const posts=[];page.on('request',r=>{if(new URL(r.url()).pathname==='/api/settings'&&r.method()==='POST')posts.push(JSON.parse(r.postData()));});
 const read=async()=>{const response=await context.request.get(origin+'/api/settings');assert.equal(response.status(),200);const value=await response.json();assert.deepEqual(Object.keys(value).sort(),['publicPostsPerAccount','publicWorksPageMode','publicWorksPageHardLimit','publicWorksRequestThreshold'].sort());return value;};
 const row=()=>({...db.prepare('SELECT key,value,updated_at FROM settings WHERE key=?').get('publicPostsPerAccount')});
 const image=async name=>{const file=out+'/'+label+'-'+name+'.png';await page.screenshot({path:file,fullPage:false});proof.screens.push({path:file,sha256:hash(readFileSync(file))});};
 const opener=page.locator('#worksSettingsButton'),dialog=page.locator('#worksSettingsDialog'),mode=page.locator('#worksPageMode'),save=page.locator('#worksSettingsSave'),status=page.locator('#worksSettingsStatus');
 const waitReady=async()=>{await page.waitForFunction(()=>!document.getElementById('worksPageMode').disabled);};
 const saved=async()=>{await page.waitForFunction(()=>document.getElementById('worksSettingsStatus').textContent.includes('策略已保存'));};
 await page.goto(origin+'/',{waitUntil:'domcontentloaded'});await opener.waitFor({state:'visible'});
 await opener.focus();await page.keyboard.press('Enter');await waitReady();
 const initial=await read(),originalLegacy=row();assert.equal(initial.publicWorksPageMode,'legacy');assert.equal(initial.publicPostsPerAccount,'30');assert.equal(await mode.inputValue(),'legacy');
 assert.match(await dialog.innerText(),/45 秒/);assert.match(await dialog.innerText(),/最多 3 页/);assert.match(await dialog.innerText(),/不是.*全部作品/);assert.equal(posts.length,0);
 await page.keyboard.press('Escape');assert.equal(await dialog.evaluate(x=>x.open),false);assert.equal(await opener.evaluate(x=>document.activeElement===x),true);
 proof.cases.push({name:'actual default legacy, keyboard open/Escape return, no automatic POST, explicit 45s/3pages/not-fullset',passed:true,initial});

 // A real server permission rejection exercises read failure without a fake response.
 db.prepare("UPDATE users SET role='viewer' WHERE auth_source='local-owner'").run();
 await opener.click();await page.waitForFunction(()=>document.getElementById('worksSettingsStatus').dataset.state==='error');assert.match(await status.innerText(),/读取失败/);assert.equal(posts.length,0);
 const viewerPage=await context.newPage();await viewerPage.goto(origin+'/',{waitUntil:'domcontentloaded'});await viewerPage.waitForFunction(()=>document.getElementById('connectionStatus').textContent==='快照已读取');
 assert.equal(await viewerPage.locator('#worksSettingsButton').isVisible(),false);assert.equal((await context.request.get(origin+'/api/settings')).status(),403);await viewerPage.close();
 db.prepare("UPDATE users SET role='admin' WHERE auth_source='local-owner'").run();await page.locator('#worksSettingsReload').click();await waitReady();assert.equal(await mode.inputValue(),'legacy');
 proof.cases.push({name:'actual API read failure and recovery; viewer role hides entry and GET returns 403',passed:true});

 await mode.selectOption('whole-page-v2');assert.equal(await page.locator('#worksHardLimit').inputValue(),'100');assert.equal(await page.locator('#worksThreshold').inputValue(),'30');
 assert.equal((await read()).publicWorksPageMode,'legacy','changing a draft is not persistence');
 await page.locator('#worksHardLimit').fill('20');await page.locator('#worksThreshold').fill('30');await save.click();assert.equal(posts.length,0);assert.match(await status.innerText(),/1–20/);
 await page.locator('#worksHardLimit').fill('100');await page.locator('#worksThreshold').fill('30');
 let announce,release;const dispatched=new Promise(r=>announce=r),resume=new Promise(r=>release=r);
 const hold=async route=>{if(route.request().method()!=='POST')return route.continue();announce();await resume;await route.continue();};
 await page.route('**/api/settings',hold);await save.focus();await page.keyboard.press('Enter');await dispatched;assert.equal(await save.isDisabled(),true);await page.keyboard.press('Enter');
 assert.equal(posts.length,1,'a repeated real Enter cannot dispatch another POST while pending');
 // Closing/reopening while a real request is pending must not send another write.
 await page.keyboard.press('Escape');assert.equal(await opener.evaluate(x=>document.activeElement===x),true);await opener.click();assert.equal(await save.isDisabled(),true);assert.equal(posts.length,1);
 release();await saved();await page.unroute('**/api/settings',hold);
 const whole=await read();assert.equal(whole.publicWorksPageMode,'whole-page-v2');assert.equal(whole.publicWorksPageHardLimit,'100');assert.equal(whole.publicWorksRequestThreshold,'30');assert.deepEqual(row(),originalLegacy);
 assert.deepEqual(posts[0],{publicWorksPageMode:'whole-page-v2',publicWorksPageHardLimit:100,publicWorksRequestThreshold:30});
 await image('whole-saved');proof.cases.push({name:'explicit whole-page actual save/readback; exact three-field body; old legacy row untouched; repeated Enter and pending close/reopen',passed:true,postCount:posts.length,whole});

 // Inject only a temporary SQLite write failure; production API still executes normally.
 db.exec("CREATE TRIGGER phase91_reject_settings BEFORE INSERT ON settings WHEN NEW.key LIKE 'publicWorks%' BEGIN SELECT RAISE(ABORT,'phase91 isolated storage failure'); END");
 await page.locator('#worksHardLimit').fill('90');await page.locator('#worksThreshold').fill('20');await save.click();await page.waitForFunction(()=>document.getElementById('worksSettingsStatus').dataset.state==='error');
 assert.match(await status.innerText(),/未确认保存成功/);assert.equal(await page.locator('#worksHardLimit').inputValue(),'90');assert.equal(await page.locator('#worksThreshold').inputValue(),'20');assert.deepEqual(await read(),whole);
 await image('save-failed');db.exec('DROP TRIGGER phase91_reject_settings');await page.locator('#worksSettingsReload').click();await waitReady();assert.equal(await page.locator('#worksHardLimit').inputValue(),'100');
 proof.cases.push({name:'actual SQLite failure -> actual HTTP error -> error status, draft kept, DB unchanged; reload restores actual values',passed:true});

 await mode.selectOption('legacy');assert.equal(await page.locator('#worksLegacyLimit').inputValue(),'30');await page.locator('#worksLegacyLimit').fill('29');await save.click();await saved();
 const legacy=await read();assert.equal(legacy.publicPostsPerAccount,'29');assert.equal(legacy.publicWorksPageMode,'legacy');assert.equal(legacy.publicWorksPageHardLimit,'100');
 const preserved=row();await mode.selectOption('whole-page-v2');await save.click();await saved();assert.deepEqual(row(),preserved);assert.deepEqual(posts.at(-1),{publicWorksPageMode:'whole-page-v2',publicWorksPageHardLimit:100,publicWorksRequestThreshold:30});
 await page.locator('#worksSettingsClose').click();assert.equal(await opener.evaluate(x=>document.activeElement===x),true);await opener.click();await waitReady();assert.equal(await mode.inputValue(),'whole-page-v2');
 proof.cases.push({name:'whole -> legacy edited 29 -> whole roundtrip preserves independent values/timestamp; close/reopen echoes actual server',passed:true});

 await page.setViewportSize({width:390,height:844});await image('390');
 const geometry=await dialog.evaluate(el=>{const r=el.getBoundingClientRect();return {viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,left:r.left,right:r.right,width:r.width,clientWidth:el.clientWidth,scrollWidth:el.scrollWidth,clientHeight:el.clientHeight,scrollHeight:el.scrollHeight,overflowY:getComputedStyle(el).overflowY};});
 assert.ok(geometry.left>=0&&geometry.right<=390);assert.ok(geometry.scrollWidth<=geometry.clientWidth+1,'dialog must not horizontally overflow');
 await mode.focus();await page.keyboard.press('Tab');assert.equal(await page.locator('#worksHardLimit').evaluate(x=>document.activeElement===x),true);await page.keyboard.press('Tab');assert.equal(await page.locator('#worksThreshold').evaluate(x=>document.activeElement===x),true);await page.keyboard.press('Escape');assert.equal(await opener.evaluate(x=>document.activeElement===x),true);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM runs').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM snapshots').get().n,0);assert.deepEqual(proof.errors,[]);
 proof.cases.push({name:'390 CSS px dialog geometry and native keyboard sequence, close focus; zero collection/history writes',passed:true,geometry});proof.posts=posts;
 proof.sourceHashesAfter=Object.fromEntries(Object.keys(proof.sourceHashes).map(f=>[f,hash(readFileSync(join(source,f)))]));assert.deepEqual(proof.sourceHashesAfter,proof.sourceHashes,'candidate files must remain sealed through the run');proof.passed=true;
}catch(e){proof.passed=false;proof.failure=e.stack;process.exitCode=1;}finally{
 await context?.close();await browser?.close();if(server?.listening)await new Promise(r=>server.close(r));db?.close();
 if(previousData===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previousData;
 rmSync(dir,{recursive:true,force:true});proof.closedFreshBrowser=true;proof.closedIsolatedServer=true;proof.removedTemporaryDatabase=true;proof.finishedAt=new Date().toISOString();
 writeFileSync(out+'/'+label+'.json',JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({passed:proof.passed,cases:proof.cases,errors:proof.errors,failure:proof.failure,closedFreshBrowser:proof.closedFreshBrowser}));
}
