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
const files=new Map(publication.files.map(f=>[f.path,f])),output='output/playwright/phase88';mkdirSync(output,{recursive:true});
const runLabel=process.env.PHASE88_BROWSER_RUN||'';assert.match(runLabel,/^[a-z0-9-]*$/);
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
 const row=page.locator('.account-ledger tbody tr').filter({has:page.locator('button.author').filter({hasText:'糯米团子🍡'})});await row.waitFor();assert.equal(await row.count(),1);
 await page.waitForFunction(()=>new URL(location.href).searchParams.get('query')==='糯米团子');
 const beforeUrl=page.url(),columns=await row.locator('td').evaluateAll(cells=>cells.slice(1).map(cell=>cell.textContent));
 evidence.baseline={url:beforeUrl,accountId:241,columns};await save('01-matrix-comparison');
 const baselineCsv=await download(page.getByRole('button',{name:'导出全部结果',exact:true}),'matrix-before');
 const detail=row.locator('button.author');await detail.click();const personal=await assertComparison();assert.equal(await page.getByRole('heading',{name:'账号经营详情',exact:true}).evaluate(el=>document.activeElement===el),true);
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
 const paused=page.locator('.account-ledger tbody tr').filter({has:page.locator('button.author').filter({hasText:'橙子味🍊'})});await paused.waitFor();
 await paused.locator('button.author').click();await accountReady();
 const pausedQuery=new URL(page.url()).searchParams;assert.equal(pausedQuery.get('account'),'348');assert.equal(pausedQuery.get('generation'),manifest.asOf);for(const k of ['start','end','compareStart','compareEnd'])assert.equal(pausedQuery.has(k),false);
 assert.equal(await page.getByRole('region',{name:'独立账号数据',exact:true}).getByRole('button',{name:'比较另一段日期',exact:true}).count(),1);await save('07-paused-personal-default');

 // Real hydrated current-source scope control. Saved API is unchanged; no new sample.
 await page.goto(origin+'/?theme=tuantuan&classification=slice&period=week&start=2026-09-24&end=2026-10-01&compareStart=2026-09-14&compareEnd=2026-09-28&sort=label&order=asc&query=团&rosterStatus=all#accounts',{waitUntil:'domcontentloaded'});
 const scope=page.getByLabel('当前生效范围',{exact:true});await scope.waitFor();
 await page.locator('.period-toolbar select').selectOption('month');
 const keep=['period','start','end','compareStart','compareEnd','sort','order','query','rosterStatus'];
 const savedParams=new URL(page.url()).searchParams;
 const assertKeep=()=>{const next=new URL(page.url()).searchParams;for(const key of keep)assert.equal(next.get(key),savedParams.get(key),key+' must survive independent clearing');};
 const clearTheme=page.getByRole('button',{name:'清除大主题筛选，保留其他条件',exact:true});await clearTheme.focus();await page.keyboard.press('Enter');
 await page.waitForFunction(()=>!new URL(location.href).searchParams.has('theme'));assertKeep();assert.equal(new URL(page.url()).searchParams.get('classification'),'slice');
 assert.equal(await scope.evaluate(el=>document.activeElement===el),true);assert.equal(await page.locator('.period-toolbar select').inputValue(),'month');
 const clearTag=page.getByRole('button',{name:'清除内容分类筛选，保留其他条件',exact:true});await clearTag.focus();await page.keyboard.press('Space');
 await page.waitForFunction(()=>!new URL(location.href).searchParams.has('classification'));assertKeep();assert.equal(await scope.evaluate(el=>document.activeElement===el),true);
 assert.equal(await page.locator('.period-pending').isVisible(),true);assert.equal(await clearTheme.count(),0);assert.equal(await clearTag.count(),0);
 const coverage=page.getByLabel('采样覆盖与新鲜度',{exact:true});await coverage.locator(':scope>summary').focus();await page.keyboard.press('Enter');
 assert.equal(await coverage.locator('.coverage-gaps').isVisible(),true);assert.equal(await coverage.locator('.coverage-method').evaluate(el=>el.open),false);
 assert.equal(await coverage.locator('.coverage-account').count(),20);assert.match(await coverage.locator('.coverage-gaps h3').innerText(),/需核对 \d+ 个账号 · 当前显示前 20 个/);
 evidence.geometry=[];
 for(const [width,scale] of [[390,1],[390,2],[1440,1],[1440,2]]){
  await page.setViewportSize({width,height:900});await page.evaluate(scale=>document.documentElement.style.fontSize=scale*100+'%',scale);
  const geometry=await page.evaluate(()=>({documentWidth:document.documentElement.scrollWidth,viewport:innerWidth}));assert.ok(geometry.documentWidth<=geometry.viewport+1);
  const button=coverage.locator('.coverage-account').first(),size=await button.boundingBox();assert.ok(size.height>=44);assert.ok(size.width>0);evidence.geometry.push({width,scale,...geometry,accountControlHeight:size.height});
  await scope.scrollIntoViewIfNeeded();await save('scope-'+width+'-'+scale+'x');
 }
 await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>document.documentElement.style.fontSize='100%');
 // Account name from page2 returns to exactly the existing page, URL and focus.
 await page.goto(origin+'/?theme=tuantuan&period=week&start=2026-09-24&end=2026-10-01&compareStart=2026-09-14&compareEnd=2026-09-28&sort=label&order=asc#accounts',{waitUntil:'domcontentloaded'});
 await page.locator('.account-ledger tbody tr').first().waitFor();await page.locator('.account-ledger .pager').first().getByRole('button',{name:'下一页',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.account-ledger .pager')?.textContent.includes('第 2/'));
 const primary=page.locator('.account-ledger button.author').first(),beforePage2=page.url(),name=await primary.innerText();
 const page2Csv=await download(page.getByRole('button',{name:'导出全部结果',exact:true}),'page2-before');
 await primary.focus();await page.keyboard.press('Enter');await accountReady();assert.equal(await page.getByRole('heading',{name:'账号经营详情',exact:true}).evaluate(el=>document.activeElement===el),true);assert.equal(new URL(page.url()).searchParams.get('compareStart'),'2026-09-14');
 await page.getByRole('button',{name:'返回原核对页',exact:true}).click();await primary.waitFor();assert.equal(page.url(),beforePage2);assert.match(await page.locator('.account-ledger .pager').first().innerText(),/第 2\//);
 assert.equal(await primary.innerText(),name);assert.equal(await primary.evaluate(el=>document.activeElement===el),true);
 assert.deepEqual(await download(page.getByRole('button',{name:'导出全部结果',exact:true}),'page2-after'),page2Csv);
 const historyButton=page.locator('.account-ledger tbody tr').first().getByRole('button',{name:'查看'+name+'的历史',exact:true});await historyButton.click();await page.getByRole('dialog').getByRole('button',{name:'导出全部历史',exact:true}).waitFor();await page.keyboard.press('Escape');
 assert.equal(await historyButton.evaluate(el=>document.activeElement===el),true);await save('page2-return-history-focus');
 evidence.scopeProof={themeClearKeepsClassification:true,classificationClearKeepsOtherScope:true,datesComparisonListAndDraftKept:true,keyboardFocus:true,oneExpansion20RealGaps:true,page2PrimaryNameExactReturn:true,page2CsvBytesUnchanged:true,historyEscapeFocus:true};
 assert.deepEqual(errors,[]);assert.deepEqual(evidence.externalRequests,[]);assert.equal(hash(readFileSync('../mcn-public-site/app/page.tsx')),sourceHash);
 evidence.sourceSha256=sourceHash;evidence.pageErrors=errors;evidence.completed={directComparison:true,historyToStandaloneComparison:true,copyShareDates:true,refreshSameGeneration:true,reloadSameGeneration:true,browserBackExactUrlAndColumns:true,returnFocus:true,csvByteEquality:true,pausedDoesNotInherit:true};
 evidence.finishedAt=new Date().toISOString();writeFileSync('data/maintenance-journal/2026-10-02-phase88-browser-peer'+(runLabel?'-'+runLabel:'')+'.json',JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(evidence));
}catch(error){evidence.error=error.message;evidence.pageErrors=errors;if(page){evidence.body=await page.locator('body').innerText();await page.screenshot({path:output+'/failed.png',fullPage:true});}writeFileSync('data/maintenance-journal/2026-10-02-phase88-browser-peer-failure-'+Date.now()+'.json',JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});throw error;
}finally{await context.close();await browser.close();}
