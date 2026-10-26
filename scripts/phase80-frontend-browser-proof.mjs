// Actual local Site/React in installed Chrome, using one already-published
// saved generation. No production DB, platform request or mutation is allowed.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright-core';
import {preparePublicReplicaPublication} from '../lib/public-replica-sync.mjs';
const directory='data/public-replica-staging/publisher-2026-10-01T20-13-51-158Z';
const manifest=JSON.parse(readFileSync(directory+'/manifest.json'));
const publication=await preparePublicReplicaPublication({manifest,files:manifest.files.map(f=>({...f,content:readFileSync(directory+'/'+f.path,'utf8')}))},{dateIndex:true});
const files=new Map(publication.files.map(f=>[f.path,f])),output='output/playwright/phase80';mkdirSync(output,{recursive:true});
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce',serviceWorkers:'block',acceptDownloads:true});
const evidence={startedAt:new Date().toISOString(),asOf:manifest.asOf,actualSiteCode:true,apiFromAlreadyPublishedSavedGeneration:true,cloudUIAcceptance:false,liveCollection:false,apiReads:0,externalRequests:0};
let page;const errors=[];
try{
 await context.route('**/*',route=>{
  const req=route.request(),url=new URL(req.url());assert.equal(req.method(),'GET');
  if(url.origin!=='http://127.0.0.1:4322'){evidence.externalRequests++;return route.abort();}
  if(url.pathname!=='/api/replica')return route.continue();
  const generation=url.searchParams.get('generation');assert.ok(!generation||generation===manifest.asOf);evidence.apiReads++;
  const part=url.searchParams.get('part'),file=part&&files.get(part);if(part)assert.ok(file);
  return route.fulfill({status:200,contentType:'application/json',headers:part?{'X-Data-SHA256':file.sha256,'X-Data-Cutoff':manifest.asOf}:{'Cache-Control':'no-store'},
   body:part?file.content:JSON.stringify({manifest:publication.manifest,publishedAt:'2026-10-01T20:21:15.900Z',readOnly:true,collectionRequiresLocalComputer:true})});
 });
 page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://127.0.0.1:4322/?theme=tuantuan&period=week&start=2026-09-24&end=2026-10-01#accounts',{waitUntil:'domcontentloaded',timeout:25000});
 const search=page.getByRole('textbox',{name:'搜索作者',exact:true});await search.waitFor({timeout:25000});
 const geometry=()=>search.evaluate(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el),canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');ctx.font=s.font;return {width:r.width,height:r.height,textSpace:el.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight),placeholderWidth:ctx.measureText(el.placeholder).width,documentWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth};});
 evidence.geometry=[];
 for(const [width,scale]of [[390,1],[390,2],[1440,1],[1440,2]]){
  await page.setViewportSize({width,height:900});await page.evaluate(scale=>document.documentElement.style.fontSize=scale*100+'%',scale);
  const status=page.locator('.account-ledger select');await status.focus();await page.keyboard.press('Tab');assert.equal(await search.evaluate(el=>document.activeElement===el),true);
  const result=await geometry();assert.ok(result.width>=44&&result.height>=36);assert.ok(result.textSpace>=result.placeholderWidth);assert.ok(result.documentWidth<=result.viewportWidth+1);evidence.geometry.push({width,scale,...result});
  await search.scrollIntoViewIfNeeded();await page.screenshot({path:output+'/toolbar-'+width+'-'+scale+'x.png',fullPage:true});
  await page.locator('.account-ledger .panel-head').screenshot({path:output+'/toolbar-focused-'+width+'-'+scale+'x.png'});
 }
 await page.setViewportSize({width:390,height:844});await page.evaluate(()=>document.documentElement.style.fontSize='100%');await search.fill('糯米团子');
 const row=page.locator('.account-ledger tbody tr').filter({has:page.getByRole('button',{name:'糯米团子🍡',exact:true})});await row.waitFor({timeout:10000});assert.equal(await row.count(),1);
 const beforeUrl=page.url(),metrics=await row.locator('td').evaluateAll(cells=>cells.slice(1).map(cell=>cell.textContent));
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出全部结果',exact:true}).click();const downloaded=await download;
 assert.match(downloaded.suggestedFilename(),/矩阵账号.*\.csv$/);assert.ok((await readFileSync(await downloaded.path(),'utf8')).includes('糯米团子'));
 await row.getByRole('button',{name:'查看糯米团子🍡的经营详情',exact:true}).click();
 await page.getByRole('heading',{name:'账号经营详情',exact:true}).waitFor();await page.getByRole('heading',{name:'已保存每日统计',exact:true}).waitFor();
 await page.getByRole('button',{name:'返回原核对页',exact:true}).click();await search.waitFor();assert.equal(await search.inputValue(),'糯米团子');assert.equal(page.url(),beforeUrl);
 assert.deepEqual(await row.locator('td').evaluateAll(cells=>cells.slice(1).map(cell=>cell.textContent)),metrics);
 assert.equal(await row.getByRole('button',{name:'查看糯米团子🍡的经营详情',exact:true}).evaluate(el=>document.activeElement===el),true);
 assert.deepEqual(errors,[]);assert.equal(evidence.externalRequests,0);
 evidence.keyboardStatusToSearch=true;evidence.searchExportDetailReturn=true;evidence.metricsAndUrlUnchanged=true;evidence.pageErrors=errors;
 evidence.sourceSha256=Object.fromEntries(['app/page.tsx','app/replica.css'].map(path=>[path,createHash('sha256').update(readFileSync('../mcn-public-site/'+path)).digest('hex')]));
 evidence.finishedAt=new Date().toISOString();writeFileSync('data/maintenance-journal/2026-10-02-phase80-browser-root.json',JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(evidence));
}catch(error){evidence.error=error.message;evidence.pageErrors=errors;if(page)await page.screenshot({path:output+'/failed-retry.png',fullPage:true});writeFileSync('data/maintenance-journal/2026-10-02-phase80-browser-root-failure-retry.json',JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});throw error;
}finally{await context.close();await browser.close();}
