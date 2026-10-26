// Root-owned real React preview. APIs are one sealed saved generation, not live collection.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright-core';
import {preparePublicReplicaPublication} from '../lib/public-replica-sync.mjs';
const directory='data/public-replica-staging/publisher-2026-10-01T22-44-10-262Z';
const manifest=JSON.parse(readFileSync(directory+'/manifest.json'));
const publication=await preparePublicReplicaPublication({manifest,files:manifest.files.map(f=>({...f,content:readFileSync(directory+'/'+f.path,'utf8')}))},{dateIndex:true});
const files=new Map(publication.files.map(f=>[f.path,f])),origin='http://127.0.0.1:4322';
const sha=x=>createHash('sha256').update(x).digest('hex');
const sourcePath='../mcn-public-site/components/coverage-panel.tsx',sourceSha256=sha(readFileSync(sourcePath));
const evidence={startedAt:new Date().toISOString(),actualReactPreview:true,savedGeneration:manifest.asOf,cloudUIAcceptance:false,liveCollection:false,sourceSha256,steps:[],errors:[],externalRequests:0};
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',serviceWorkers:'block',acceptDownloads:true});
try {
 await context.route('**/*',route=>{
  const request=route.request(),url=new URL(request.url());assert.equal(request.method(),'GET');
  if(url.origin!==origin){evidence.externalRequests++;return route.abort();}
  if(url.pathname!=='/api/replica')return route.continue();
  const generation=url.searchParams.get('generation');assert.ok(!generation||generation===manifest.asOf);
  const part=url.searchParams.get('part'),file=part&&files.get(part);if(part)assert.ok(file);
  return route.fulfill({status:200,contentType:'application/json',headers:part?{'X-Data-SHA256':file.sha256,'X-Data-Cutoff':manifest.asOf}:{'Cache-Control':'no-store'},body:part?file.content:JSON.stringify({manifest:publication.manifest,publishedAt:manifest.asOf,readOnly:true,collectionRequiresLocalComputer:true})});
 });
 const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>evidence.errors.push(e.message));
 await page.goto(origin+'/?theme=tuantuan&period=week&start=2026-09-24&end=2026-10-01&compareStart=2026-09-14&compareEnd=2026-09-28&sort=label&order=asc#accounts',{waitUntil:'domcontentloaded'});
 await page.locator('.account-ledger tbody tr').first().waitFor();
 await page.locator('.account-ledger .pager').first().getByRole('button',{name:'下一页',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.account-ledger .pager')?.textContent.includes('第 2/'));
 const csv=async()=>{const event=page.waitForEvent('download');await page.getByRole('button',{name:'导出全部结果',exact:true}).click();const download=await event;return readFileSync(await download.path());};
 const beforeCsv=await csv(),beforeUrl=page.url();
 const coverage=page.getByLabel('采样覆盖与新鲜度',{exact:true});await coverage.locator(':scope>summary').focus();await page.keyboard.press('Enter');
 assert.equal(await coverage.locator('.coverage-gaps').isVisible(),true);
 const trigger=coverage.locator('.coverage-account').nth(3),handle=await trigger.elementHandle();assert.ok(handle);
 const label=await trigger.innerText();
 for(const [key,exit] of [['Enter','return-button'],['Space','browser-back']]){
  await trigger.focus();const beforeScroll=await page.evaluate(()=>scrollY);await page.keyboard.press(key);
  await page.getByRole('heading',{name:'账号经营详情',exact:true}).waitFor();await page.getByRole('heading',{name:'已保存每日统计',exact:true}).waitFor();
  const params=new URL(page.url()).searchParams;
  assert.equal(params.get('generation'),manifest.asOf);assert.equal(params.get('compareStart'),'2026-09-14');assert.equal(params.get('compareEnd'),'2026-09-28');
  assert.equal(params.get('start'),'2026-09-24');assert.equal(params.get('end'),'2026-10-01');
  assert.equal(await page.getByRole('heading',{name:'账号经营详情',exact:true}).evaluate(el=>document.activeElement===el),true);
  if(exit==='return-button')await page.getByRole('button',{name:'返回原核对页',exact:true}).click();else await page.goBack();
  await page.waitForFunction(el=>document.activeElement===el,handle);
  assert.equal(page.url(),beforeUrl);assert.match(await page.locator('.account-ledger .pager').first().innerText(),/第 2\//);
  assert.equal(await trigger.innerText(),label);assert.equal(await page.evaluate(()=>scrollY),beforeScroll);
  assert.equal(await coverage.evaluate(el=>el.open),true);assert.deepEqual(await csv(),beforeCsv);
  evidence.steps.push({key,exit,exactTriggerFocus:true,page2Kept:true,rangeComparisonVersionKept:true,urlKept:true,csvBytesKept:true,scrollKept:true});
 }
 mkdirSync('output/playwright/phase89',{recursive:true});await trigger.scrollIntoViewIfNeeded();await page.screenshot({path:'output/playwright/phase89/coverage-exact-return.png',fullPage:false});
 assert.deepEqual(evidence.errors,[]);assert.equal(evidence.externalRequests,0);assert.equal(sha(readFileSync(sourcePath)),sourceSha256);
 evidence.csv={bytes:beforeCsv.length,sha256:sha(beforeCsv)};evidence.finishedAt=new Date().toISOString();
 writeFileSync('data/maintenance-journal/2026-10-02-phase89-coverage-browser.json',JSON.stringify(evidence,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify(evidence));
} finally {await context.close();await browser.close();}
