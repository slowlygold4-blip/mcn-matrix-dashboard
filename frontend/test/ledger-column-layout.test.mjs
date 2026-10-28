// Exact account-ledger JSX is extracted from Home, not copied into a lookalike.
// All rows and handlers are synthetic. Formatters intentionally retain thirteen
// digits to stress column geometry, not to claim actual account metric values.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

const root=fileURLToPath(new URL('../',import.meta.url));
const main=process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../douyin-monitor-workbench/',import.meta.url));
const {chromium}=createRequire(main+'package.json')('playwright-core');
const columns=['author','followers.value','followers.delta','likes.value','likes.delta','posts.value','posts.delta'];
const scrollLabel='账号数据，方向键与 PageUp、PageDown 滚动当前页';
const staticLabel='账号数据表';
const wideNumber=1234567890123;

async function fixtureAssets(){
 const home=await readFile(root+'app/page.tsx','utf8');
 const ledgerStart=home.indexOf('const workspaceAccounts=');
 const tableStart=home.indexOf('<Table bounded',ledgerStart),tableEnd=home.indexOf('</Table>',tableStart);
 assert.ok(ledgerStart>=0&&tableStart>ledgerStart&&tableEnd>tableStart,'fixture must resolve the actual bounded account table in Home');
 const markup=home.slice(tableStart,tableEnd+'</Table>'.length);
 assert.match(markup,/className="account-metrics-table"/,'production table must opt in to scoped metric-column layout');
 assert.match(markup,/data-column="author"/);
 assert.match(markup,/account-metric-number/);
 const fixture=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
 import {ScrollableTable as Table} from './components/scrollable-table';
 import {TableHeader,TableRow,TableHead,TableBody,TableCell} from './components/ui/table';
 import {Button} from './components/ui/button';import {AccountClassification} from './components/account-classification';import {ChangeIndicator} from './components/change-indicator';
 type Row=any;
 const magnitude=${wideNumber};
 const records=Array.from({length:20},(_,index)=>({id:index+1,label:index===0?'样本作者 OvO':'合成作者'+String(index+1).padStart(2,'0')+' · 很长的团团账号名称OVO',enabled:index!==1,classification:{theme:{label:'团团'},labels:index===1?[{key:'slice',label:'切片'},{key:'creation',label:'原创二创'},{key:'ai',label:'AI二创'}]:[{key:'slice',label:'切片'},{key:'creation',label:'原创二创'}]},metrics:Object.fromEntries(['followers','likes','posts'].map((key,offset)=>[key,{value:[magnitude,0,null,magnitude-1][(index+offset)%4],delta:[magnitude,-magnitude,0,null][(index+offset)%4]}]))}));
 const fmt=(value:number|null)=>value==null?'—':new Intl.NumberFormat('en-US',{maximumFractionDigits:0}).format(value);
 const diff=(value:number|null)=>value==null?'—':value>0?'+'+fmt(value):fmt(value);
 function Fixture(){const [sort,setSort]=useState('followers.delta'),[order,setOrder]=useState('desc'),[selected,setSelected]=useState('');
 const page=1,board='all',theme='tuantuan',tag='all',query='',rosterStatus='enabled',start='2026-09-12',end='2026-10-23';
 const sorted=[...records].sort((a,b)=>{const get=(row:Row)=>sort==='label'?row.label:row.metrics[sort.split('.')[0]][sort.split('.')[1]],av=get(a),bv=get(b);if(av==null||bv==null)return av==null?(bv==null?a.id-b.id:1):-1;const compared=typeof av==='string'?av.localeCompare(bv):av-bv;return (order==='asc'?compared:-compared)||a.id-b.id;});
 function rank(key:string){if(sort===key)setOrder(order==='asc'?'desc':'asc');else{setSort(key);setOrder('desc');}}
 function standalone(account:Row){setSelected('经营详情：'+account.label);}
 function open(account:Row){setSelected('历史：'+account.label);}
 return <div className="workspace"><aside className="sidebar"><div className="wordmark">矩阵<span>MCN DATA</span></div><nav><Button>账号变化</Button></nav></aside><main><div className="content"><h1>账号数据列布局测试</h1><div className="account-ledger"><section className="panel">${markup}</section></div><output id="fixture-sort">{sort+' '+order}</output><output id="fixture-selected">{selected}</output></div></main></div>;}
 createRoot(document.getElementById('root')).render(<Fixture/>);`;
 const bundle=await build({stdin:{contents:fixture,resolveDir:root,sourcefile:'ledger-column-layout-fixture.tsx',loader:'tsx'},absWorkingDir:root,bundle:true,write:false,outfile:'ledger-column-layout-fixture.js',format:'iife',platform:'browser',jsx:'automatic',tsconfig:root+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'}});
 const globals=await postcss([tailwind({base:root})]).process(await readFile(root+'app/globals.css','utf8'),{from:root+'app/globals.css'});
 const styles=await Promise.all(['app/replica.css','app/visual-theme.css','components/table-scroll-frame.css'].map(path=>readFile(root+path,'utf8')));
 return {script:bundle.outputFiles.find(file=>file.path.endsWith('.js')).text,css:globals.css+'\n'+styles.join('\n')};
}

async function openFixture(browser,assets,width){
 const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce',hasTouch:width<=390}),errors=[],requests=[];
 await context.route('**/*',route=>{
  const request=route.request(),path=new URL(request.url()).pathname;requests.push({method:request.method(),path});
  if(request.method()!=='GET')return route.abort();
  if(path==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>'});
  if(path==='/fixture.css')return route.fulfill({contentType:'text/css',body:assets.css});
  if(path==='/fixture.js')return route.fulfill({contentType:'text/javascript',body:assets.script});
  return route.abort();
 });
 const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://127.0.0.1:49131/');await page.locator('.account-metrics-table tbody tr').first().waitFor();
 return {context,page,errors,requests};
}

const table=page=>page.locator('.account-metrics-table');
const area=page=>page.locator('.account-ledger [data-slot="table-container"]');
const region=page=>page.getByRole('region',{name:scrollLabel,exact:true});
const cell=(page,column,row=0)=>table(page).locator('tbody tr').nth(row).locator('[data-column="'+column+'"]');
async function settle(page){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
const rectOf=element=>{const rect=element.getBoundingClientRect();return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:rect.width,height:rect.height};};
async function assertReadableText(page,width){
 const reading=await table(page).evaluate(element=>{
  const textRect=node=>{const range=document.createRange();range.selectNodeContents(node);const rect=range.getBoundingClientRect();return {left:rect.left,right:rect.right,width:rect.width,height:rect.height,lines:[...range.getClientRects()].filter(part=>part.width>0).map(part=>Math.round(part.top))};};
  return {headers:[...element.querySelectorAll('thead th')].map(th=>{const button=th.querySelector('button'),style=getComputedStyle(button);return {column:th.dataset.column,text:button.textContent,rect:textRect(button),lineHeight:parseFloat(style.lineHeight),height:button.clientHeight,padding:parseFloat(style.paddingTop)+parseFloat(style.paddingBottom)};}),numbers:[...element.querySelectorAll('tbody td:not(:first-child)')].map(td=>{const span=td.querySelector('.account-metric-number'),rect=td.getBoundingClientRect(),style=getComputedStyle(td);return {column:td.dataset.column,text:span.textContent,rect:textRect(span),cell:{left:rect.left,right:rect.right},paddingLeft:parseFloat(style.paddingLeft),paddingRight:parseFloat(style.paddingRight),lineHeight:parseFloat(getComputedStyle(span).lineHeight)};})};
 });
 assert.deepEqual(reading.headers.map(header=>header.column),columns);
 for(const header of reading.headers){
  const lines=new Set(header.rect.lines);
  assert.ok(lines.size<=2,JSON.stringify({width,header,reason:'metric headings must never turn into vertically stacked Chinese characters'}));
  assert.ok(header.rect.height<=header.lineHeight*2+2,JSON.stringify({width,header}));
 }
 assert.ok(reading.numbers.some(number=>number.text==='+1,234,567,890,123'));
 assert.ok(reading.numbers.some(number=>number.text==='-1,234,567,890,123'));
 assert.ok(reading.numbers.some(number=>number.text==='0'));
 assert.ok(reading.numbers.some(number=>number.text==='—'));
 for(const number of reading.numbers){
  assert.equal(new Set(number.rect.lines).size,1,JSON.stringify({width,number,reason:'a complete metric is one non-wrapping value'}));
  assert.ok(number.rect.left>=number.cell.left+number.paddingLeft-2&&number.rect.right<=number.cell.right-number.paddingRight+2,JSON.stringify({width,number,reason:'all thirteen digits, separators and sign must fit inside the cell'}));
 }
 for(const column of columns.slice(1)){
  const header=reading.headers.find(header=>header.column===column),number=reading.numbers.find(number=>number.column===column);
  if(width<=420)assert.ok(Math.abs(number.rect.right-(number.cell.right-number.paddingRight))<=3,JSON.stringify({width,column,number,reason:'one-column phone cards align every value to a common reading edge'}));
  else if(width<=680)assert.ok(number.rect.left>=number.cell.left+number.paddingLeft-2,JSON.stringify({width,column,number,reason:'phone cards start each value at a readable left edge'}));
  else assert.ok(Math.abs(header.rect.right-number.rect.right)<=3,JSON.stringify({width,column,headerRight:header.rect.right,numberRight:number.rect.right,reason:'header and number share the same right-aligned reading edge'}));
 }
}

test('the actual account ledger keeps seven metric columns readable across devices and print',async t=>{
 const assets=await fixtureAssets();
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{
  for(const width of [320,390,768,1440])await t.test('readable columns and keyboard actions at '+width+'px',async()=>{
   const {context,page,errors,requests}=await openFixture(browser,assets,width);try{
    await settle(page);const scroll=area(page),author=cell(page,'author'),before=await table(page).locator('tbody').innerText();
    const geometry=await author.evaluate(element=>{const area=element.closest('[data-slot="table-container"]'),rect=element.getBoundingClientRect(),style=getComputedStyle(element);return {width:rect.width,viewport:area.clientWidth,pinned:style.position==='sticky'&&style.left!=='auto'};});
    if(width<=680){
     assert.equal(geometry.pinned,false,'phone card authors are not sticky over any metric');
     assert.ok(geometry.width<=geometry.viewport+2,JSON.stringify({width,geometry,reason:'phone card fits its reading surface'}));
     const compact=await scroll.evaluate(element=>({clientWidth:element.clientWidth,scrollWidth:element.scrollWidth,clientHeight:element.clientHeight,scrollHeight:element.scrollHeight}));
     assert.ok(compact.scrollWidth<=compact.clientWidth+1,JSON.stringify({width,compact,reason:'all six phone metrics are visible without horizontal table scrolling'}));
     assert.ok(compact.scrollHeight<=compact.clientHeight+1,JSON.stringify({width,compact,reason:'card rows use page scrolling, not a nested vertical viewport'}));
     const cards=await table(page).locator('tbody tr').first().evaluate(row=>({display:getComputedStyle(row).display,columns:[...row.querySelectorAll('td')].map(cell=>cell.dataset.column),labels:[...row.querySelectorAll('td:not(:first-child)')].map(cell=>getComputedStyle(cell,'::before').content)}));
     assert.equal(cards.display,'grid');assert.deepEqual(cards.columns,columns);
     assert.deepEqual(cards.labels,['"粉丝"','"粉丝变化"','"点赞"','"点赞变化"','"作品存量"','"作品变化"']);
     assert.equal(await page.getByRole('region',{name:staticLabel,exact:true}).getAttribute('tabindex'),'-1','non-scrollable phone cards do not add a dead keyboard stop');
    }else{
     assert.equal(geometry.pinned,true,'the author identity remains pinned while reading metrics');
     assert.ok(geometry.width<=geometry.viewport*.45+2,JSON.stringify({width,geometry,reason:'the pinned identity column leaves room to read a complete metric'}));
    }
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'the page itself must not scroll sideways');
    const identity=await cell(page,'author').evaluate(element=>{const name=element.querySelector('button.author'),history=element.querySelector('.account-row-history'),row=element.closest('tr'),context=element.querySelector('.account-row-context'),labels=element.querySelector('.account-classification__preview');return {rowHeight:row.getBoundingClientRect().height,nameHeight:name.getBoundingClientRect().height,historyWidth:history.getBoundingClientRect().width,historyHeight:history.getBoundingClientRect().height,context:context.textContent,labels:labels.textContent,themeCopies:[...element.querySelectorAll('.account-classification__theme')].length};});
    assert.ok(identity.rowHeight<=(width<=680?440:150),JSON.stringify({width,identity,reason:'ordinary rows must expose authors and all metrics without clipping'}));
    assert.ok(identity.nameHeight>=44&&identity.historyWidth>=44&&identity.historyHeight>=44,JSON.stringify({width,identity,reason:'both actions stay touch-sized'}));
    assert.match(identity.context,/启用.*团团/);assert.match(identity.labels,/切片.*原创二创/);assert.equal(identity.themeCopies,0);
    assert.equal(await cell(page,'author').getByRole('button',{name:'查看样本作者 OvO的经营详情',exact:true}).count(),1,'the author name is the sole detail action');
    const paused=table(page).locator('tbody tr').filter({hasText:'合成作者02'}).first();
    assert.match(await paused.locator('.account-row-context').innerText(),/暂停[\s\S]*团团/,'a paused account remains explicit');
    const disclosure=paused.locator('.account-classification__more>summary');
    assert.equal(await disclosure.count(),1,'additional categories remain available');
    await paused.locator('.account-row-history').focus();await page.keyboard.press('Tab');
    assert.equal(await disclosure.evaluate(element=>document.activeElement===element),true,'history tabs directly to additional labels');
    const focused=await paused.evaluate(element=>({row:getComputedStyle(element).backgroundColor,pinned:getComputedStyle(element.querySelector('td:first-child')).backgroundColor,motion:getComputedStyle(element).transitionDuration}));
    assert.notEqual(focused.row,'rgba(0, 0, 0, 0)','keyboard focus visibly tracks the complete metric row');
    assert.equal(focused.pinned,width<=680?'rgb(34, 38, 61)':'rgb(29, 32, 50)','the author identity shares the row highlight');
    assert.equal(focused.motion,'0s','reduced-motion users do not wait for row animation');
    await page.keyboard.press('Enter');assert.match(await paused.locator('.account-classification__more').innerText(),/AI二创/);
    assert.equal(await paused.locator('.account-classification__more').evaluate(element=>element.open),true);
    assert.equal(await disclosure.evaluate(element=>getComputedStyle(element).color),'rgb(107, 228, 231)','expanded labels carry an explicit visual state');
    await page.keyboard.press('Enter');assert.equal(await paused.locator('.account-classification__more').evaluate(element=>element.open),false);
    await assertReadableText(page,width);

    // Wide screens retain full keyboard-horizontal inspection. Phone cards
    // expose every metric directly, so no horizontal controls should be used.
    if(width>680){
     await scroll.scrollIntoViewIfNeeded();
     for(const column of columns.slice(1)){
     await cell(page,column).evaluate(element=>{const area=element.closest('[data-slot="table-container"]'),first=element.parentElement.firstElementChild,style=getComputedStyle(first),pinned=style.position==='sticky'&&style.left!=='auto'?first.getBoundingClientRect().width:0;area.scrollTo({left:area.scrollLeft+element.getBoundingClientRect().left-area.getBoundingClientRect().left-pinned,behavior:'instant'});});
     await settle(page);
     const visible=await cell(page,column).evaluate(element=>{const area=element.closest('[data-slot="table-container"]'),first=element.parentElement.firstElementChild,style=getComputedStyle(first),rect=element.getBoundingClientRect(),frame=area.getBoundingClientRect(),pinned=style.position==='sticky'&&style.left!=='auto'?first.getBoundingClientRect().width:0;return {left:rect.left,right:rect.right,start:frame.left+pinned,end:frame.left+area.clientWidth,pinned};});
     assert.ok(visible.left>=visible.start-2&&visible.right<=visible.end+2,JSON.stringify({width,column,visible,reason:'a whole selected metric must fit without being covered by author cells'}));
    }
     await region(page).focus();await page.keyboard.press('End');await settle(page);
     const end=await scroll.evaluate(element=>({left:element.scrollLeft,max:element.scrollWidth-element.clientWidth}));assert.ok(Math.abs(end.left-end.max)<=1);
     const last=await cell(page,'posts.delta').evaluate(rectOf),frame=await scroll.evaluate(rectOf);assert.ok(last.right<=frame.right+1);
     await page.keyboard.press('Home');await settle(page);assert.equal(await scroll.evaluate(element=>element.scrollLeft),0);
     assert.equal(await table(page).locator('tbody').innerText(),before,'horizontal reading must not mutate any values or row order');
    }

    const sortButton=table(page).locator('thead [data-column="followers.delta"] button');
    await sortButton.focus();await page.keyboard.press('Enter');await page.locator('#fixture-sort').getByText('followers.delta asc',{exact:true}).waitFor();
    assert.equal(await table(page).locator('thead [data-column="followers.delta"]').getAttribute('aria-sort'),'ascending');
    assert.equal(await sortButton.evaluate(element=>document.activeElement===element),true,'sorting must preserve the keyboard control');
    assert.notEqual(await table(page).locator('tbody').innerText(),before,'the real header handler must still reorder rows');
    const authorName=await cell(page,'author').locator('.author').innerText();
    await cell(page,'author').locator('.author').focus();await page.keyboard.press('Enter');
    await page.locator('#fixture-selected').getByText('经营详情：'+authorName,{exact:true}).waitFor();
    await cell(page,'author').getByRole('button',{name:'查看'+authorName+'的历史',exact:true}).focus();await page.keyboard.press('Enter');
    await page.locator('#fixture-selected').getByText('历史：'+authorName,{exact:true}).waitFor();
    assert.deepEqual(errors,[]);assert.ok(requests.every(row=>row.method==='GET'&&['/','/fixture.css','/fixture.js','/favicon.ico'].includes(row.path)));
   }finally{await context.close();}
  });
  for(const printWidth of [704,1123])await t.test('print at '+printWidth+'px exposes complete rows and all columns',async()=>{
   const {context,page,errors}=await openFixture(browser,assets,printWidth);try{
    await page.setViewportSize({width:printWidth,height:794});await page.emulateMedia({media:'print'});await settle(page);
    const printed=await table(page).evaluate(element=>{const area=element.closest('[data-slot="table-container"]'),style=getComputedStyle(area),rect=element.getBoundingClientRect(),first=element.querySelector('tbody td:first-child'),author=first.querySelector('button.author'),context=first.querySelector('.account-row-context');return {width:rect.width,left:rect.left,right:rect.right,pageWidth:document.documentElement.clientWidth,container:{maxHeight:style.maxHeight,overflowX:style.overflowX,overflowY:style.overflowY,height:area.clientHeight,scrollHeight:area.scrollHeight},heads:[...element.querySelectorAll('thead th')].map(th=>getComputedStyle(th).position),authors:[...element.querySelectorAll('tbody td:first-child')].map(td=>getComputedStyle(td).position),colors:{cellBackground:getComputedStyle(first).backgroundColor,author:getComputedStyle(author).color,context:getComputedStyle(context).color},rows:element.querySelectorAll('tbody tr').length};});
    assert.equal(printed.container.maxHeight,'none');assert.equal(printed.container.overflowX,'visible');assert.equal(printed.container.overflowY,'visible');
    assert.ok(printed.container.height>=printed.container.scrollHeight-1,'print may not keep the fixed-height screen viewport');
    assert.ok(printed.left>=-1&&printed.right<=printed.pageWidth+1,JSON.stringify({printed,reason:'all seven columns must remain inside the printable content width'}));
    assert.ok(printed.heads.every(position=>position==='static')&&printed.authors.every(position=>position==='static'),'print removes sticky layers');
    assert.equal(printed.colors.cellBackground,'rgb(255, 255, 255)','print identity column must not retain the screen theme');
    assert.equal(printed.colors.author,'rgb(17, 17, 17)');assert.equal(printed.colors.context,'rgb(17, 17, 17)');
    assert.equal(printed.rows,20);assert.equal(await page.locator('.table-scroll-controls').isVisible(),false);
    await assertReadableText(page,printWidth);assert.deepEqual(errors,[]);
   }finally{await context.close();}
  });
 }finally{await browser.close();}
});
