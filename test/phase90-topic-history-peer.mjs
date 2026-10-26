// Actual anonymous public UI + its own response bytes. No mocks or local server.
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const origin='https://mcn-matrix-observatory.slowlygold4.chatgpt.site',out='data/maintenance-journal/phase90ux';
const label=process.env.PHASE90_TOPIC_RUN||'topic-current-red';assert.match(label,/^[a-z0-9-]+$/);mkdirSync(out,{recursive:true});
const hash=x=>createHash('sha256').update(x).digest('hex');
const proof={startedAt:new Date().toISOString(),actualPublicSite:true,managedCloudPreview:false,responseMocking:false,platformCollection:false,errors:[]};
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block',reducedMotion:'reduce'});
const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>proof.errors.push(e.message));
const bj=x=>new Date(x).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
try{
 const raw=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/replica'&&new URL(r.url()).searchParams.get('part')==='topics.json');
 await page.goto(origin+'/#topics',{waitUntil:'domcontentloaded',timeout:45000});
 const response=await raw,bytes=await response.body(),source=JSON.parse(bytes);proof.source={asOf:source.asOf,sha256:hash(bytes),status:response.status(),itemCount:source.items.length};
 await page.locator('.topics h2').first().waitFor();
 proof.rows=[];let nullCount=0,zeroCount=0,metricCells=0,traceRows=0;
 for(const topic of source.topics){const card=page.getByRole('heading',{name:topic.label,exact:true}).locator('..');await card.locator('details>summary').first().click();const rows=card.locator('tbody tr');
  const expected=source.items.filter(x=>x.targetId===topic.id).sort((a,b)=>b.date.localeCompare(a.date));assert.equal(await rows.count(),expected.length);
  for(let n=0;n<expected.length;n++){const x=expected[n],row=rows.nth(n),cells=row.locator('td');assert.match(await cells.first().innerText(),new RegExp(x.date));
   for(const [i,k] of [[1,'participants'],[2,'views']]){const text=(await cells.nth(i).innerText()).trim();assert.equal(text,x[k]===null?'—':x[k].toLocaleString('zh-CN'));metricCells++;if(x[k]===null)nullCount++;if(x[k]===0)zeroCount++;}
   const disclosure=row.locator('details>summary');if(await disclosure.count())await disclosure.first().click();const text=await row.innerText(),hasTime=text.includes(bj(x.capturedAt)),hasHash=typeof x.sourceChecksum==='string'&&text.includes(x.sourceChecksum);if(hasTime&&hasHash)traceRows++;
   proof.rows.push({targetId:topic.id,date:x.date,metricsMatch:true,sourceExists:!!x.sourceChecksum,timeShown:hasTime,sourceShown:hasHash});
  }
 }
 proof.result={metricCells,nullCount,zeroCount,traceRows,totalRows:proof.rows.length,topicExportControls:await page.locator('.topics').getByRole('button',{name:/导出/}).count()};
 await page.locator('.topics').first().evaluate(el=>el.scrollIntoView({block:'start'}));const image=out+'/'+label+'.png';await page.screenshot({path:image,fullPage:false});proof.screenshot={path:image,sha256:hash(readFileSync(image))};
 assert.deepEqual(proof.errors,[]);
 assert.equal(traceRows,proof.rows.length,'Each saved topic day must expose its existing true observation time and source fingerprint; do not fabricate absent evidence.');
 proof.passed=true;
}catch(e){proof.failure=e.message;proof.passed=false;process.exitCode=1;}finally{await context.close();await browser.close();proof.closedFreshContext=true;proof.finishedAt=new Date().toISOString();writeFileSync(out+'/'+label+'.json',JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({source:proof.source,result:proof.result,passed:proof.passed,failure:proof.failure,closedFreshContext:proof.closedFreshContext}));}
