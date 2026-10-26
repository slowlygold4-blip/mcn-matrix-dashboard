// Real Chrome and actual local Site code. Read-only API is fulfilled from one
// already-published generation; no collector, production database or cloud write.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright-core';
import {preparePublicReplicaPublication} from '../lib/public-replica-sync.mjs';
const directory='data/public-replica-staging/publisher-2026-10-01T19-42-52-004Z';
const manifest=JSON.parse(readFileSync(directory+'/manifest.json'));
const publication=await preparePublicReplicaPublication({manifest,files:manifest.files.map(f=>({...f,content:readFileSync(directory+'/'+f.path,'utf8')}))},{dateIndex:true});
const byPath=new Map(publication.files.map(f=>[f.path,f]));
const output='output/playwright/phase79';mkdirSync(output,{recursive:true});
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:960},reducedMotion:'reduce',serviceWorkers:'block'});
const evidence={checkedAt:new Date().toISOString(),browser:'installed Chrome',asOf:manifest.asOf,actualSiteCode:true,apiFromSavedPublicFixture:true,cloudUIAcceptance:false,databaseOpened:false,liveCollection:false,apiReads:0};
let page;
const pageErrors=[];
try{
 await context.route('**/api/replica*',route=>{
  const request=route.request(),url=new URL(request.url());assert.equal(request.method(),'GET');
  const generation=url.searchParams.get('generation');assert.ok(!generation||generation===manifest.asOf);evidence.apiReads++;
  const part=url.searchParams.get('part'),file=part&&byPath.get(part);if(part)assert.ok(file,'only declared publication part allowed');
  return route.fulfill({status:200,contentType:'application/json',headers:part?{'X-Data-SHA256':file.sha256,'X-Data-Cutoff':manifest.asOf}:{'Cache-Control':'no-store'},body:part?file.content:JSON.stringify({manifest:publication.manifest,publishedAt:'2026-10-01T19:50:12.412Z',readOnly:true,collectionRequiresLocalComputer:true})});
 });
 page=await context.newPage();page.on('pageerror',error=>pageErrors.push(error.message));await page.goto('http://127.0.0.1:4322/?theme=tuantuan&period=week&start=2026-09-24&end=2026-10-01#accounts',{waitUntil:'domcontentloaded',timeout:25000});
 const search=page.getByRole('textbox',{name:'搜索作者',exact:true});await search.waitFor({timeout:25000});await search.fill('糯米团子');
 const row=page.locator('.account-ledger tbody tr').filter({has:page.getByRole('button',{name:'糯米团子🍡',exact:true})});await row.waitFor({timeout:10000});
 assert.equal(await row.count(),1);const details=row.locator('.account-classification__more'),summary=details.locator('summary');
 assert.equal(await summary.textContent(),'其余 3 个标签');assert.equal(await details.getAttribute('open'),null);
 const beforeMetrics=await row.locator('td').evaluateAll(cells=>cells.slice(1).map(cell=>cell.textContent));
 const urlBefore=page.url();assert.equal(await row.locator('.account-classification__preview').innerText(),'搞笑\n音乐');
 assert.equal(await details.locator('li').first().isVisible(),false);
 await summary.focus();await page.keyboard.press('Enter');assert.notEqual(await details.getAttribute('open'),null);
 assert.deepEqual(await details.locator('li').allTextContents(),['游戏内容','直播热点','切片']);
 assert.deepEqual(await row.locator('td').evaluateAll(cells=>cells.slice(1).map(cell=>cell.textContent)),beforeMetrics);assert.equal(page.url(),urlBefore);
 await page.keyboard.press('Space');assert.equal(await details.getAttribute('open'),null);assert.equal(await summary.evaluate(el=>document.activeElement===el),true);
 evidence.keyboardEnterSpaceAndFocus=true;evidence.allFiveFullLabelsPreserved=true;evidence.metricsAndAddressUnchanged=beforeMetrics;
 await page.screenshot({path:output+'/desktop-collapsed.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await summary.scrollIntoViewIfNeeded();
 const narrow=await row.evaluate(el=>{const r=el.querySelector('td').getBoundingClientRect();return {authorCellWidth:r.width,authorCellHeight:r.height,documentWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth};});
 assert.ok(narrow.authorCellWidth>=150&&narrow.authorCellWidth<180);assert.ok(narrow.documentWidth<=narrow.viewportWidth+1);
 await summary.click();assert.notEqual(await details.getAttribute('open'),null);assert.equal(await details.locator('li').first().isVisible(),true);
 await page.screenshot({path:output+'/mobile-expanded.png',fullPage:true});evidence.mobile390=narrow;
 await page.setViewportSize({width:1440,height:960});await page.evaluate(()=>document.documentElement.style.fontSize='200%');await summary.scrollIntoViewIfNeeded();
 const enlarged=await summary.boundingBox();assert.ok(enlarged.height>=70);assert.equal(await details.locator('li').first().isVisible(),true);
 evidence.text200PercentSummaryHeight=enlarged.height;await page.screenshot({path:output+'/text200-expanded.png',fullPage:true});
 evidence.sourceSha256=Object.fromEntries(['app/page.tsx','app/replica.css','components/account-classification.tsx'].map(path=>[path,createHash('sha256').update(readFileSync('../mcn-public-site/'+path)).digest('hex')]));
 evidence.finishedAt=new Date().toISOString();evidence.screenshots=[output+'/desktop-collapsed.png',output+'/mobile-expanded.png',output+'/text200-expanded.png'];
 writeFileSync('data/maintenance-journal/2026-10-02-phase79-browser-root.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
}catch(error){
 evidence.error=error.message;evidence.pageErrors=pageErrors;evidence.body=page?await page.locator('body').innerText():null;
 if(page)await page.screenshot({path:output+'/failed.png',fullPage:true});
 writeFileSync('data/maintenance-journal/2026-10-02-phase79-browser-root-failure.json',JSON.stringify(evidence,null,2)+'\n');throw error;
}finally{await context.close();await browser.close();}
