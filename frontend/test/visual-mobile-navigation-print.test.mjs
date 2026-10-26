// Production CSS, synthetic text only. One browser checks the real responsive
// rules without fetching accounts, changing saved data, or starting a collector.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const main=process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../douyin-monitor-workbench/',import.meta.url));
const {chromium}=createRequire(main+'package.json')('playwright-core');
const navLabels=['总览','账号变化','作者与作品','话题数据'];

const markup=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body>
<div class="workspace"><aside class="sidebar"><a class="wordmark" href="#">矩阵<span>MCN DATA</span></a><nav>
${navLabels.map((label,index)=>`<button aria-current="${index===3?'page':'false'}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 2h16v16H2z"/></svg>${label}</button>`).join('')}
</nav></aside><main><header class="topbar"><span class="sample-status"><span>最近账号采样</span> <time datetime="2026-10-24T00:15:14Z">2026/10/24 08:15:14</time><span> · 北京时间</span></span><button>重新读取已保存数据</button></header>
<div class="content"><h1>话题数据</h1><div class="topics"><article data-slot="card"><div data-slot="card-content"><h2>#示例话题</h2><div class="topic-values">
${[['positive','+12'],['negative','-9'],['neutral','0'],['missing','—']].map(([sign,value])=>`<div><small>参与人数</small><div class="topic-delta" data-sign="${sign}"><small>相邻日变化</small><div class="topic-number"><span class="topic-number-content"><strong>${value}</strong></span></div></div></div>`).join('')}
</div></div></article></div>
<div class="period-toolbar"><button type="button">应用日期</button></div>
<div class="source-ops"><div class="source-ops-bars"><button class="source-ops-bar-column" aria-pressed="false"><span class="source-ops-bar" style="height:20px"></span><span>10月</span></button></div>
<div class="source-ops-track-list"><button type="button">轨迹</button></div><div class="source-ops-rank-list"><button type="button">排名</button></div>
<div class="source-ops-observation-grid"><button type="button">观察</button></div></div>
</div></main></div></body></html>`;

test('mobile navigation, sampling time and topic sign are legible on real CSS',async()=>{
 const styles=await Promise.all(['app/replica.css','app/source-operations.css','app/visual-theme.css','app/dashboard-motion.css'].map(path=>readFile(root+path,'utf8')));
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{
  for(const width of [320,390,1440]){
   const context=await browser.newContext({viewport:{width,height:844},reducedMotion:'reduce',hasTouch:width<760});
   await context.route('**/*',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/')return route.fulfill({contentType:'text/html',body:markup});
    if(path==='/fixture.css')return route.fulfill({contentType:'text/css',body:styles.join('\n')});
    return route.abort();
   });
   const page=await context.newPage();
   try{
    await page.goto('http://127.0.0.1:49137/');
    const layout=await page.evaluate(()=>{
     const nav=[...document.querySelectorAll('.sidebar nav button')].map(button=>{
      const text=[...button.childNodes].find(node=>node.nodeType===Node.TEXT_NODE),range=document.createRange();
      range.selectNodeContents(text);
      return {text:button.textContent,lines:[...range.getClientRects()].filter(rect=>rect.width>0).length,fontSize:parseFloat(getComputedStyle(button).fontSize),button:button.getBoundingClientRect().toJSON()};
     });
     const status=document.querySelector('.sample-status'),name=status.querySelector('span:first-child'),time=status.querySelector('time'),zone=status.querySelector('span:last-child');
     const signed=[...document.querySelectorAll('.topic-delta')].map(row=>({sign:row.dataset.sign,text:row.querySelector('strong').textContent,color:getComputedStyle(row.querySelector('strong')).color}));
     const topicMetrics=[...document.querySelectorAll('.topic-values > div')].slice(0,2).map(item=>item.getBoundingClientRect().toJSON());
     return {pageWidth:document.documentElement.scrollWidth,viewport:innerWidth,nav,topicMetrics,barLabelFont:parseFloat(getComputedStyle(document.querySelector('.source-ops-bar-column > span:last-child')).fontSize),status:{name:name.getBoundingClientRect().toJSON(),time:time.getBoundingClientRect().toJSON(),zone:zone.getBoundingClientRect().toJSON()},signed,cardTransition:getComputedStyle(document.querySelector('.topics [data-slot="card"]')).transitionDuration};
    });
    assert.ok(layout.pageWidth<=width+1,JSON.stringify({width,layout,reason:'no page-wide horizontal scrolling'}));
    assert.deepEqual(layout.nav.map(item=>item.text),navLabels);
    assert.equal(layout.nav.every(item=>item.lines===1),true,JSON.stringify({width,nav:layout.nav,reason:'mobile navigation labels never split into vertical characters'}));
    assert.deepEqual(layout.signed.map(item=>[item.sign,item.text]),[['positive','+12'],['negative','-9'],['neutral','0'],['missing','—']]);
    assert.notEqual(layout.signed[0].color,layout.signed[1].color,'growth and decline must not share the same visual signal');
    assert.notEqual(layout.signed[2].color,layout.signed[0].color,'zero must not imply growth');
    assert.notEqual(layout.signed[3].color,layout.signed[0].color,'missing must not imply growth');
    assert.equal(layout.cardTransition,'0s','reduced motion disables card transitions');
    if(width<=520)assert.ok(layout.topicMetrics[1].top>layout.topicMetrics[0].bottom,`${width}px topic figures must stack rather than squeeze into half-width cells`);
    else assert.ok(Math.abs(layout.topicMetrics[1].top-layout.topicMetrics[0].top)<2,'desktop topic figures stay side-by-side');
    if(width<760){
     assert.ok(layout.nav.every(item=>item.fontSize>=12),`${width}px navigation text must be at least 12px`);
     assert.ok(layout.barLabelFont>=11,`${width}px publishing chart labels must be readable without zoom`);
     assert.ok(layout.status.time.top>layout.status.name.top+3,JSON.stringify({width,status:layout.status,reason:'sample date gets its own readable line'}));
     assert.ok(Math.abs(layout.status.name.top-layout.status.zone.top)<3,JSON.stringify({width,status:layout.status,reason:'timezone stays with the label'}));
     const touchCases=[
      ['.period-toolbar > button','backgroundColor'],
      ['.source-ops-bar-column .source-ops-bar','backgroundImage'],
      ['.source-ops-track-list button','backgroundColor'],
      ['.source-ops-rank-list > button','backgroundColor'],
      ['.source-ops-observation-grid > button','backgroundImage'],
     ];
     for(const [selector,property] of touchCases){
      const target=selector.includes('.source-ops-bar')?'.source-ops-bar-column':selector;
      const before=await page.locator(selector).evaluate((element,key)=>getComputedStyle(element)[key],property);
      await page.locator(target).tap();
      const after=await page.locator(selector).evaluate((element,key)=>getComputedStyle(element)[key],property);
      assert.equal(after,before,`${selector} must not stick to legacy hover colors after a touch`);
     }
    }
    await page.emulateMedia({media:'print'});
    const print=await page.evaluate(()=>({card:getComputedStyle(document.querySelector('.topics [data-slot="card"]')).backgroundColor,
     value:getComputedStyle(document.querySelector('.topic-delta[data-sign="negative"] strong')).color,
     title:getComputedStyle(document.querySelector('h1')).color}));
    assert.equal(print.card,'rgb(255, 255, 255)','topic cards print on white');
    assert.equal(print.value,'rgb(17, 17, 17)','negative value stays visible in monochrome print');
    assert.equal(print.title,'rgb(17, 17, 17)','page heading stays visible in monochrome print');
   }finally{await context.close();}
  }
 }finally{await browser.close();}
});
