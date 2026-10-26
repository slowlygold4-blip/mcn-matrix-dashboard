// Reuses Phase80's real local Site/Chrome proof pattern. Only GET on Root-owned
// localhost; replica reads come from one saved published generation. No service
// ownership, DB, platform, cloud writes, or user browser sessions.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright-core';
import {preparePublicReplicaPublication} from '../lib/public-replica-sync.mjs';
const directory='data/public-replica-staging/publisher-2026-10-01T22-44-10-262Z';
const manifest=JSON.parse(readFileSync(directory+'/manifest.json'));
const publication=await preparePublicReplicaPublication({manifest,files:manifest.files.map(f=>({...f,content:readFileSync(directory+'/'+f.path,'utf8')}))},{dateIndex:true});
const files=new Map(publication.files.map(f=>[f.path,f])),output='output/playwright/phase86';mkdirSync(output,{recursive:true});
const runLabel=process.env.PHASE86_BROWSER_RUN||'';assert.match(runLabel,/^[a-z0-9-]*$/);
const origin='http://127.0.0.1:4322';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',serviceWorkers:'block',acceptDownloads:true});
const evidence={startedAt:new Date().toISOString(),runLabel,asOf:manifest.asOf,actualSiteCode:true,apiFromAlreadyPublishedSavedGeneration:true,cloudUIAcceptance:false,liveCollection:false,apiReads:[],externalRequests:[],steps:[],downloads:[]};
let page;const errors=[];
const hash=x=>createHash('sha256').update(x).digest('hex');
const sourceHash=hash(readFileSync('../mcn-public-site/app/page.tsx'));
const save=async name=>{const path=output+'/'+(runLabel?runLabel+'-':'')+name+'.png';await page.screenshot({path,fullPage:false});evidence.steps.push({name,url:page.url(),screenshot:path});};
async function accountReady(){await page.getByRole('heading',{name:'账号经营详情',exact:true}).waitFor();await page.getByRole('heading',{name:'已保存每日统计',exact:true}).waitFor();}
async function assertComparison(){
 await accountReady();const personal=page.getByRole('region',{name:'独立账号数据',exact:true});
 assert.equal(await personal.getByLabel('个人基准观察日',{exact:true}).inputValue(),'2026-09-24');
 assert.equal(await personal.getByLabel('个人截止观察日',{exact:true}).inputValue(),'2026-10-01');
 assert.equal(await personal.getByLabel('比较起点',{exact:true}).inputValue(),'2026-09-14');
 assert.equal(await personal.getByLabel('比较终点',{exact:true}).inputValue(),'2026-09-28');
 assert.equal(await personal.getByRole('button',{name:'关闭区间对比',exact:true}).getAttribute('aria-pressed'),'true');
 const p=new URL(page.url()).searchParams;assert.equal(p.get('account'),'241');assert.equal(p.get('generation'),manifest.asOf);assert.equal(p.get('compareStart'),'2026-09-14');assert.equal(p.get('compareEnd'),'2026-09-28');
 return personal;
}
async function download(button,label){const event=page.waitForEvent('download');await button.click();const d=await event,bytes=readFileSync(await d.path());evidence.downloads.push({label,name:d.suggestedFilename(),bytes:bytes.length,sha256:hash(bytes)});return bytes;}
try{
 await context.route('**/*',route=>{
  const req=route.request(),url=new URL(req.url());assert.equal(req.method(),'GET');
  if(url.origin!==origin){evidence.externalRequests.push(req.url());return route.abort();}
  if(url.pathname!=='/api/replica')return route.continue();
  const generation=url.searchParams.get('generation');assert.ok(!generation||generation===manifest.asOf);
  const part=url.searchParams.get('part'),file=part&&files.get(part);if(part)assert.ok(file);
  evidence.apiReads.push({part:part||'manifest',generation});
  return route.fulfill({status:200,contentType:'application/json',headers:part?{'X-Data-SHA256':file.sha256,'X-Data-Cutoff':manifest.asOf}:{'Cache-Control':'no-store'},body:part?file.content:JSON.stringify({manifest:publication.manifest,publishedAt:manifest.asOf,readOnly:true,collectionRequiresLocalComputer:true})});
 });
 page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
 await page.goto(origin+'/?theme=tuantuan&period=week&start=2026-09-24&end=2026-10-01&compareStart=2026-09-14&compareEnd=2026-09-28#accounts',{waitUntil:'domcontentloaded',timeout:25000});
 const search=page.getByRole('textbox',{name:'搜索作者',exact:true});await search.waitFor({timeout:25000});await search.fill('糯米团子');
 const row=page.locator('.account-ledger tbody tr').filter({has:page.getByRole('button',{name:'糯米团子🍡',exact:true})});await row.waitFor();assert.equal(await row.count(),1);
 await page.waitForFunction(()=>new URL(location.href).searchParams.get('query')==='糯米团子');
 const beforeUrl=page.url(),columns=await row.locator('td').evaluateAll(cells=>cells.slice(1).map(cell=>cell.textContent));
 evidence.baseline={url:beforeUrl,accountId:241,columns};await save('01-matrix-comparison');
 const baselineCsv=await download(page.getByRole('button',{name:'导出全部结果',exact:true}),'matrix-before');
 const detail=row.getByRole('button',{name:'查看糯米团子🍡的经营详情',exact:true});await detail.click();const personal=await assertComparison();
 await personal.locator('.growth-panel').scrollIntoViewIfNeeded();await save('02-direct-account-comparison');
 await personal.getByRole('button',{name:'返回原核对页',exact:true}).click();await row.waitFor();
 assert.equal(page.url(),beforeUrl);assert.deepEqual(await row.locator('td').evaluateAll(cells=>cells.slice(1).map(cell=>cell.textContent)),columns);assert.equal(await detail.evaluate(el=>document.activeElement===el),true);
 assert.deepEqual(await download(page.getByRole('button',{name:'导出全部结果',exact:true}),'matrix-after-return'),baselineCsv);
 await save('03-return-same-matrix');
 await row.getByRole('button',{name:'查看糯米团子🍡的历史',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'导出全部历史',exact:true}).waitFor();await save('04-history');
 await dialog.getByRole('button',{name:'打开独立账号页面',exact:true}).click();await assertComparison();
 const personalAfter=page.getByRole('region',{name:'独立账号数据',exact:true});
 await personalAfter.getByRole('button',{name:'复制账号分享链接',exact:true}).click();const shared=await personalAfter.getByRole('textbox',{name:'账号分享地址',exact:true}).inputValue();
 assert.equal(new URL(shared).search,page.url().slice(page.url().indexOf('?')));evidence.shareUrl=shared;
 const priorReads=evidence.apiReads.length;await page.getByRole('button',{name:'刷新已发布数据',exact:true}).click();await page.getByRole('button',{name:'刷新已发布数据',exact:true}).waitFor();await assertComparison();assert.ok(evidence.apiReads.slice(priorReads).some(x=>x.part==='manifest'&&x.generation===manifest.asOf));
 await page.reload({waitUntil:'domcontentloaded'});await assertComparison();await personalAfter.locator('.growth-panel .recharts-surface').waitFor({state:'visible'});await personalAfter.locator('.growth-panel').scrollIntoViewIfNeeded();await save('05-share-refresh-pinned-comparison');
 await page.goBack({waitUntil:'domcontentloaded'});await row.waitFor();assert.equal(page.url(),beforeUrl);assert.deepEqual(await row.locator('td').evaluateAll(cells=>cells.slice(1).map(cell=>cell.textContent)),columns);
 await save('06-browser-back-matrix');
 await page.locator('.account-ledger select').selectOption('paused');await search.fill('橙子味');
 const paused=page.locator('.account-ledger tbody tr').filter({has:page.getByRole('button',{name:'橙子味🍊',exact:true})});await paused.waitFor();
 await paused.getByRole('button',{name:'查看橙子味🍊的经营详情',exact:true}).click();await accountReady();
 const pausedQuery=new URL(page.url()).searchParams;assert.equal(pausedQuery.get('account'),'348');assert.equal(pausedQuery.get('generation'),manifest.asOf);for(const k of ['start','end','compareStart','compareEnd'])assert.equal(pausedQuery.has(k),false);
 assert.equal(await page.getByRole('region',{name:'独立账号数据',exact:true}).getByRole('button',{name:'比较另一段日期',exact:true}).count(),1);await save('07-paused-personal-default');
 assert.deepEqual(errors,[]);assert.deepEqual(evidence.externalRequests,[]);assert.equal(hash(readFileSync('../mcn-public-site/app/page.tsx')),sourceHash);
 evidence.sourceSha256=sourceHash;evidence.pageErrors=errors;evidence.completed={directComparison:true,historyToStandaloneComparison:true,copyShareDates:true,refreshSameGeneration:true,reloadSameGeneration:true,browserBackExactUrlAndColumns:true,returnFocus:true,csvByteEquality:true,pausedDoesNotInherit:true};
 evidence.finishedAt=new Date().toISOString();writeFileSync('data/maintenance-journal/2026-10-02-phase86-browser-peer'+(runLabel?'-'+runLabel:'')+'.json',JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(evidence));
}catch(error){evidence.error=error.message;evidence.pageErrors=errors;if(page){evidence.body=await page.locator('body').innerText();await page.screenshot({path:output+'/failed.png',fullPage:true});}writeFileSync('data/maintenance-journal/2026-10-02-phase86-browser-peer-failure-'+Date.now()+'.json',JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});throw error;
}finally{await context.close();await browser.close();}
