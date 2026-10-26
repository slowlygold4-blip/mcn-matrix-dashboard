// Public-only follow-up; 200% ROOT FONT, not browser zoom or a claim of WCAG conformance.
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const origin='https://mcn-matrix-observatory.slowlygold4.chatgpt.site',out='data/maintenance-journal/phase90ux';
const label=process.env.PHASE90_RESPONSIVE_RUN||'topic-responsive-green';assert.match(label,/^[a-z0-9-]+$/);mkdirSync(out,{recursive:true});
const hash=x=>createHash('sha256').update(x).digest('hex');
const proof={startedAt:new Date().toISOString(),actualPublicSite:true,responseMocking:false,browserZoomTested:false,rootFontScales:[1,2],cases:[],errors:[]};
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const context=await browser.newContext({viewport:{width:390,height:900},serviceWorkers:'block',reducedMotion:'reduce'}),page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>proof.errors.push(e.message));
try{
 const incoming=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/replica'&&new URL(r.url()).searchParams.get('part')==='topics.json');
 await page.goto(origin+'/#topics',{waitUntil:'domcontentloaded',timeout:45000});const response=await incoming,bytes=await response.body(),source=JSON.parse(bytes);proof.source={asOf:source.asOf,sha256:hash(bytes),status:response.status()};
 await page.locator('.topics h2').first().waitFor();
 const point=source.items.find(p=>p.participants===null||p.views===null);assert.ok(point);const topic=source.topics.find(t=>t.id===point.targetId),card=page.getByRole('heading',{name:topic.label,exact:true}).locator('..'),history=card.locator('.topic-days>summary');
 await history.focus();await page.keyboard.press('Enter');assert.equal(await card.locator('.topic-days').evaluate(el=>el.open),true);
 const date=card.getByLabel(`查看 ${topic.label} ${point.date} 的采样来源`,{exact:true}),row=date.locator('xpath=ancestor::tr');
 for(const scale of [1,2]){
  await page.evaluate(n=>document.documentElement.style.fontSize=n*100+'%',scale);await date.focus();await page.keyboard.press('Enter');assert.equal(await date.locator('..').evaluate(el=>el.open),true);
  const sourceBlock=row.locator('.topic-source');await sourceBlock.waitFor();const text=await sourceBlock.innerText();assert.match(text,new RegExp(point.sourceChecksum));assert.ok(text.includes(new Date(point.capturedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})));assert.equal(await sourceBlock.locator('a[href]').count(),0);assert.doesNotMatch(text,/https?:\/\/|Cookie|Bearer\s|access_token|sec_uid|raw_json/i);
  for(const [i,k] of [[1,'participants'],[2,'views']])assert.equal((await row.locator('td').nth(i).innerText()).trim(),point[k]===null?'—':point[k].toLocaleString('zh-CN'));
  await date.scrollIntoViewIfNeeded();const geometry=await page.evaluate(()=>({documentWidth:document.documentElement.scrollWidth,viewport:innerWidth,rootFont:getComputedStyle(document.documentElement).fontSize,overflowElements:[...document.querySelectorAll('.topics,.topics>div,.topic-days,.topic-source,.topic-source code,.table-scroll')].map(el=>({tag:el.tagName,class:el.className,width:Math.round(el.getBoundingClientRect().width),left:Math.round(el.getBoundingClientRect().left),scrollWidth:el.scrollWidth})).filter(x=>x.width>innerWidth||x.left<0)}));const path=out+'/'+label+'-'+scale+'x.png';await page.screenshot({path,fullPage:false});
  const containerGeometry=await card.evaluate(card=>Object.entries({card:card.closest('[data-slot="card"]'),cardContent:card,topicDays:card.querySelector('.topic-days'),tableShell:card.querySelector('.table-scroll-shell'),tableRegion:card.querySelector('.table-scroll-region'),tableContainer:card.querySelector('[data-slot="table-container"]'),table:card.querySelector('table'),source:card.querySelector('details[open] .topic-source')}).map(([name,el])=>{if(!el)return {name,missing:true};const c=getComputedStyle(el),r=el.getBoundingClientRect();return {name,left:r.left,right:r.right,width:r.width,minWidth:c.minWidth,computedWidth:c.width,maxWidth:c.maxWidth,overflowX:c.overflowX,display:c.display};}));
  proof.cases.push({scale,...geometry,containerGeometry,sourceFont:await sourceBlock.evaluate(el=>getComputedStyle(el).fontSize),keyboardOpen:true,metricsKept:true,noPrivateUrlOrCredentialFields:true,path,sha256:hash(readFileSync(path))});await date.focus();await page.keyboard.press('Space');assert.equal(await date.locator('..').evaluate(el=>el.open),false);assert.equal(await date.evaluate(el=>document.activeElement===el),true);
 }
 assert.deepEqual(proof.errors,[]);assert.ok(proof.cases.every(x=>x.documentWidth<=x.viewport+1),'Open topic source must not expand the document beyond its viewport');proof.passed=true;
}catch(e){proof.passed=false;proof.failure=e.message;process.exitCode=1;}finally{await context.close();await browser.close();proof.closedFreshContext=true;proof.finishedAt=new Date().toISOString();writeFileSync(out+'/'+label+'.json',JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(proof));}
