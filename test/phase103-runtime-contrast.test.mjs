import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { chromium } from 'playwright-core';
import * as model from '../public/console-model.js';

const root = new URL('../', import.meta.url);
const css = readFileSync(new URL('public/rebuild.css', root), 'utf8');
const js = readFileSync(new URL('public/rebuild.js', root), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const baseline = css.replace(/\.metric\{color:var\(--ink\);/, '.metric{color:#293a54;');
const candidate = css;
const recordEvidence=process.env.PHASE103_RUNTIME_RECORD==='1';
const report = { startedAt: new Date().toISOString(), scope: 'isolated owned Chromium; no production/browser profile/CDP/network; actual accountTable and model code, synthetic data', cssSha256:sha(css), jsSha256:sha(js), checks:[] };
function markup() {
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id,{value:'',innerHTML:'',textContent:''}); return nodes.get(id); };
  const context = { ...model, fmt:model.formatNumber, URL, URLSearchParams, Intl, Date, location:{href:'http://fixture.invalid/'}, document:{getElementById:node,querySelector:node,querySelectorAll:()=>[]}, history:{replaceState(){}} };
  runInNewContext(js.replace(/^import[^\n]+\n/,'').replace(/void init\(\);\s*$/,'')+'\nthis.subject={state,accountTable,signed};',context);
  context.subject.state.data={period:'custom'};
  context.subject.state.sort='followers.value';
  const accounts=[12345,0,-42,null].map((value,index)=>({id:index+1,label:['正值','零','负值','缺测'][index],enabled:true,platform:'douyin',boards:[],status:{},collection:{},metrics:Object.fromEntries(Object.keys(model.METRICS).map(key=>[key,{value,delta:value,deltaReliable:true}]))}));
  return '<main><div class="table-card" id="accountsTable">'+context.subject.accountTable(accounts)+'</div><div class="table-card" id="overviewTable">'+context.subject.accountTable(accounts.slice(0,1))+'</div><div class="history-table"><table class="table"><tr><td id="historyStock">12,345</td></tr></table></div><div class="detail-kpi"><strong id="detailStock">12,345</strong></div><div class="pager"><button disabled>上一页</button><button id="nextPage">下一页</button></div><button class="secondary-btn" id="exportButton">导出</button></main>';
}
const html=markup();
function processTree(){return execFileSync('/bin/ps',['-axo','pid=,ppid=,command='],{encoding:'utf8'}).trim().split('\n').map(line=>{const m=/^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);return m?{pid:Number(m[1]),ppid:Number(m[2]),command:m[3]}:null;}).filter(Boolean);}
const secondaryHtml='<section id="overviewView"><p class="metric-boundary">口径说明：不是实际播放量</p></section><div class="topic-stat"><span class="topic-missing">暂无有效观测 · 当前显示历史观测</span></div><div class="load-feedback">加载状态说明</div><div class="load-feedback" data-state="warning">读取尚未完成</div><div class="monitoring-state is-running">正在运行</div><div class="upload-drop"><strong>选择导入文件</strong></div>';
function contrast(a,b) {
  const lum = rgb => rgb.slice(0,3).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((n,x,i)=>n+x*[.2126,.7152,.0722][i],0);
  const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
}
async function reading(page,selector) {
  const style=await page.locator(selector).first().evaluate(el=>{const rgb=x=>(x.match(/[\d.]+/g)||[]).map(Number); const own=getComputedStyle(el);let parent=el,bg;while(parent){const value=rgb(getComputedStyle(parent).backgroundColor);if(value.length===3||value[3]===1){bg=value;break;}parent=parent.parentElement;}return{text:el.textContent,color:own.color,rgb:rgb(own.color),background:bg??[255,255,255],font:own.fontSize,outline:own.outline,visible:el.getBoundingClientRect().width>0};});
  return {...style,contrast:contrast(style.rgb,style.background)};
}
test('actual account-table CSS: baseline counterexample; candidate screen/hover/focus/print and unchanged text',async()=>{
  assert.match(css,/\.metric\{color:var\(--ink\);font-size:12px;font-weight:650\}/,'test actual installed CSS, never silently repair it in fixture');
  const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
  const tree=processTree(),owned=new Set(tree.filter(p=>p.ppid===process.pid&&p.command.includes('Google Chrome')).map(p=>p.pid));
  for(let n=0;n<tree.length;n++)for(const p of tree)if(owned.has(p.ppid))owned.add(p.pid);
  report.privateBrowserProcesses=tree.filter(p=>owned.has(p.pid));assert.ok(report.privateBrowserProcesses.length>0);
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    await page.route('**/*',route=>route.abort());
    await page.setContent('<style>'+baseline+'</style>'+html);
    const before=await reading(page,'#accountsTable .metric');
    assert.ok(before.contrast<2,'original #293a54 remains objectively dark on actual dark panel');
    const initialText=await page.locator('main').innerText();
    const initialDomText=await page.locator('main').textContent();
    report.baseline=before;
    await page.setContent('<style>'+candidate+'</style>'+html);
    assert.equal(await page.locator('main').innerText(),initialText);
    const metrics=await page.locator('#accountsTable tbody tr').evaluateAll(rows=>rows.map(row=>row.querySelector('.metric').textContent));
    assert.deepEqual(metrics,['1.23万','0','-42','—']);
    assert.deepEqual(await page.locator('#accountsTable tbody tr').evaluateAll(rows=>rows.map(row=>row.children[2].textContent)),['+1.23万','0','-42','—']);
    assert.equal(await page.locator('#accountsTable tbody tr').first().locator('td').nth(1).getAttribute('title'),'12,345');
    for(const selector of ['#accountsTable .metric','#overviewTable .metric','#accountsTable .up','#accountsTable tbody tr:nth-child(3) td:nth-child(3) .down','#accountsTable .flat','#accountsTable .sort-button','#accountsTable th[aria-sort="descending"] button','#historyStock','#detailStock','#nextPage','#exportButton']) {
      const value=await reading(page,selector);assert.ok(value.contrast>=4.5,selector+': '+value.contrast);report.checks.push({state:'screen',selector,...value});
    }
    await page.locator('#accountsTable tbody tr').first().hover();
    const hover=await reading(page,'#accountsTable .metric');assert.ok(hover.contrast>=4.5);report.checks.push({state:'hover',...hover});
    await page.locator('#accountsTable .row-btn').first().focus();
    const focus=await reading(page,'#accountsTable .metric');assert.ok(focus.contrast>=4.5);report.checks.push({state:'row-focus',...focus});
    await page.locator('#accountsTable .sort-button').first().focus();
    const button=await reading(page,'#accountsTable .sort-button');assert.match(button.outline,/2px/);report.checks.push({state:'sort-focus',...button});
    await page.keyboard.press('Tab');
    assert.ok(await page.locator('#accountsTable .sort-button').nth(1).evaluate(el=>el===document.activeElement),'native keyboard tab remains reachable');
    if(recordEvidence)await page.screenshot({path:new URL('docs/phase103-runtime-contrast-screen.png',root).pathname,fullPage:true});
    await page.emulateMedia({media:'print'});
    report.printHoverExisting=await reading(page,'#accountsTable .metric');
    await page.mouse.move(0,0);await page.locator('#exportButton').focus();
    const print=await reading(page,'#accountsTable .metric');assert.equal(print.color,'rgb(17, 17, 17)');assert.ok(print.contrast>=4.5);report.checks.push({state:'print-stock-neutral',...print});
    report.printSignedExisting={up:await reading(page,'#accountsTable .up'),down:await reading(page,'#accountsTable tbody tr:nth-child(3) td:nth-child(3) .down')};
    assert.equal(await page.locator('main').textContent(),initialDomText,'print may intentionally hide pager; data DOM remains unchanged');
    await page.emulateMedia({media:'screen'});
    await page.setContent('<style>'+candidate+'</style>'+html+secondaryHtml);
    report.secondaryReadability=[];
    for(const selector of ['#overviewView > .metric-boundary','.topic-stat .topic-missing','.load-feedback','.load-feedback[data-state="warning"]','.monitoring-state.is-running','.upload-drop strong'])report.secondaryReadability.push({selector,...await reading(page,selector)});
    await page.setViewportSize({width:390,height:844});
    const mobile=await page.locator('#accountsTable').evaluate(el=>({overflow:getComputedStyle(el).overflowX,width:el.clientWidth,scrollWidth:el.scrollWidth}));
    assert.equal(mobile.overflow,'auto');assert.ok(mobile.scrollWidth>mobile.width);report.mobileTable=mobile;
    const mobileMetric=await reading(page,'#accountsTable .metric');assert.ok(mobileMetric.contrast>=4.5);report.checks.push({state:'390px-stock',...mobileMetric});
    await page.addStyleTag({content:':root{--bg:#fff;--panel:#fff;--ink:#111;--muted:#444}'});
    const light=await reading(page,'#accountsTable .metric');assert.equal(light.color,'rgb(17, 17, 17)');assert.ok(light.contrast>=4.5);report.checks.push({state:'light-token-fixture',...light});
    report.passed=true;
  } finally {
    await browser.close();assert.equal(browser.isConnected(),false);report.browserClosedAt=new Date().toISOString();report.browserConnectedAfterClose=browser.isConnected();
    report.privateBrowserSurvivors=processTree().filter(p=>owned.has(p.pid));assert.deepEqual(report.privateBrowserSurvivors,[],'all observed owned browser processes exited naturally');
    if(recordEvidence)writeFileSync(new URL('docs/phase103-runtime-contrast-results.json',root),JSON.stringify(report,null,2)+'\n');
  }
});
