import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {sourcePublicationDate, sourceDateRangeError, belongsToSourceDateRange, filterSourceLedgerRows, sourceLedgerCsv, sourceLedgerRowKey} from '../lib/source-ledger-filters.mjs';

test('publication filtering uses inclusive source dates, not sampling timestamps; an unrestricted view keeps undated works', () => {
  assert.equal(sourcePublicationDate('2026-02-29'), null);
  assert.equal(sourcePublicationDate('2024-02-29'), '2024-02-29');
  assert.equal(sourcePublicationDate('2026-10-01T00:00:00Z'), null);
  assert.equal(sourceDateRangeError('2026-10-03', '2026-10-02'), '开始日期不能晚于结束日期，请调整后查看。');
  assert.ok(sourceDateRangeError('2026-13-01', ''));
  assert.equal(belongsToSourceDateRange({publishDate:null, observedAt:'2026-10-01'}, '2026-10-01', '2026-10-01'), false);
  assert.equal(belongsToSourceDateRange({publishDate:null}), true);
  for (const day of ['2026-10-01','2026-10-02','2026-10-03']) assert.equal(belongsToSourceDateRange({publishDate:day}, '2026-10-01', '2026-10-03'), true);
  assert.equal(belongsToSourceDateRange({publishDate:'2026-10-01'}, '', '2026-09-30'), false);
  assert.equal(belongsToSourceDateRange({publishDate:'2026-10-01'}, '2026-10-01', ''), true);
});

test('date, query, track and exact author filters compose before paging, exporting every match with safe values', () => {
  const rows = Array.from({length:65}, (_, i) => ({row:i+1, contentId:'73000000000000000'+String(i).padStart(2,'0'), douyinId:'00123', author:'作者甲', publishDate:'2026-10-01', track:'切片激励', tracks:'切片激励 / 创作激励', plays:i===0?null:i===1?0:i, likes:null, title:i===0?' =HYPERLINK("bad")':'作品'+i}));
  const other = [{row:99, contentId:'x', author:'作者甲', douyinId:'100123', publishDate:'2026-10-01', track:'切片激励', plays:99},{...rows[2], row:100,publishDate:'2026-10-02'},{...rows[2], row:101,publishDate:null}];
  const selected = filterSourceLedgerRows([...rows,...other], {query:'作者甲', track:'创作激励', authorIds:['00123'], startDate:'2026-10-01', endDate:'2026-10-01'});
  assert.equal(selected.length, 65);
  assert.equal(selected.at(-1).plays, null);
  assert.equal(selected.at(-2).plays, 0);
  const exported = sourceLedgerCsv(selected, 'works', {revision:'1697', importedAt:'2026-10-23T00:00:00Z'});
  assert.equal(exported.split('\r\n').length, 66, 'CSV must include all filtered pages');
  assert.ok(exported.startsWith('\ufeff'));
  assert.match(exported, /"00123"/);
  assert.match(exported, /"7300000000000000064"/);
  assert.ok(exported.includes('"\' =HYPERLINK(""bad"")"'));
  assert.ok(exported.includes('"0","",'));
  assert.match(exported, /非日增长/);
  assert.equal(rows[0].plays, null, 'filter and export never mutate originals');
  const authors = filterSourceLedgerRows([{row:1,name:'作者甲',douyinId:'00123',targetIds:[],plays:null}], {view:'authors',startDate:'2026-10-01',endDate:'2026-10-02',linkage:'sourceOnly'});
  assert.equal(authors.length, 1, 'publication dates do not silently filter author identities');
});

test('the live sealed source daily work totals match the exact-day drilldown, and undated supplements stay discoverable', async () => {
  const source = new URL('../public/creator-source/', import.meta.url);
  const index = JSON.parse(await readFile(new URL('index.json', source)));
  const insights = JSON.parse(await readFile(new URL('insights.json', source))).items[0];
  const works = [];
  for (const file of index.files.filter(file => file.path.startsWith('works-'))) works.push(...JSON.parse(await readFile(new URL(file.path, source))).items);
  const supplement = JSON.parse(await readFile(new URL('../public/table-foundation/works.json',import.meta.url))).items;
  const all = [...works,...supplement.map((row,index)=>({...row, row:works.length+index+1, sourceSupplement:true}))];
  const days = insights.daily || insights.days;
  assert.ok(Array.isArray(days) && days.length > 0);
  for (const day of days) {
    assert.equal(filterSourceLedgerRows(all, {startDate:day.date,endDate:day.date,mainTableOnly:true}).length, day.works, day.date);
    for (const {name:track} of index.tracks) assert.equal(filterSourceLedgerRows(all, {startDate:day.date,endDate:day.date,mainTableOnly:true,track}).length, day.tracks[track]??0, `${day.date} ${track}`);
  }
  assert.equal(filterSourceLedgerRows(all).length, works.length+supplement.length);
  assert.equal(filterSourceLedgerRows(all, {mainTableOnly:true}).length, works.length);
  assert.equal(new Set(all.map(row=>sourceLedgerRowKey(row,'works'))).size, all.length);
  const baseAuthors=JSON.parse(await readFile(new URL('authors.json',source))).items;
  const extraAuthors=JSON.parse(await readFile(new URL('../public/table-foundation/authors.json',import.meta.url))).items;
  const allAuthors=[...baseAuthors,...extraAuthors.map((row,index)=>({...row,row:baseAuthors.length+index+1,sourceSupplement:true}))];
  assert.equal(new Set(allAuthors.map(row=>sourceLedgerRowKey(row,'authors'))).size,allAuthors.length);
  assert.equal(supplement.filter(row=>sourcePublicationDate(row.publishDate) === null).length, supplement.length);
});

test('actual source ledger retries failed reads, exports every filtered page and reloads changed revisions', async () => {
  const root=fileURLToPath(new URL('../',import.meta.url));
  const main=process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../douyin-monitor-workbench/',import.meta.url));
  const {chromium}=createRequire(main+'package.json')('playwright-core');
  const makeRows=(revision)=>Array.from({length:65},(_,i)=>({row:i+1,contentId:'73000000000000000'+String(i).padStart(2,'0'),author:'测试作者',douyinId:'00123',publishDate:i<40?'2026-10-01':'2026-10-02',track:'切片激励',plays:i===64?null:i,likes:i===64?null:0,title:`${revision}作品${i}`,url:null}));
  const bodies=Object.fromEntries(['A','B'].map(revision=>[revision,JSON.stringify({revision,items:makeRows(revision)})]));
  const source=revision=>({revision,importedAt:'2026-10-23T00:00:00Z',stats:{authors:0,works:65},tracks:[{name:'切片激励'}],semantics:{plays:'表格累计播放',likes:'表格累计点赞'},files:[{path:'works-001.json',bytes:Buffer.byteLength(bodies[revision]),sha256:createHash('sha256').update(bodies[revision]).digest('hex'),count:65}]});
  const fixture=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {CreatorSourceLedger} from './components/creator-source-panel';
  const sources=${JSON.stringify({A:source('A'),B:source('B')})};function Fixture(){const [revision,setRevision]=useState('A');window.ledgerFixture={setRevision};return <CreatorSourceLedger source={sources[revision]} foundation={null} accounts={[]} onOpenAccount={()=>{}} focus={React.useMemo(()=>({view:'works',startDate:'2026-10-01',endDate:'2026-10-01',mainTableOnly:true}),[])}/>};createRoot(document.getElementById('root')).render(<Fixture/>);`;
  const bundle=await build({stdin:{contents:fixture,resolveDir:root,sourcefile:'source-ledger-fixture.tsx',loader:'tsx'},absWorkingDir:root,bundle:true,write:false,outfile:'source-ledger-fixture.js',format:'iife',platform:'browser',jsx:'automatic',tsconfig:root+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'}});
  const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
  let requests=0,revision='A';
  try {
    const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});
    try {
      const page=await context.newPage();
      await page.route('**/*',async route=>{
        if(new URL(route.request().url()).pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="root"></div></body></html>'});
        if(route.request().url().endsWith('/creator-source/works-001.json')){requests++;return route.fulfill({status:requests===1?503:200,contentType:'application/json',body:requests===1?'unavailable':bodies[revision]});}
        return route.abort();
      });
      await page.goto('http://127.0.0.1:9999/');
      await page.evaluate(()=>{window.csvDownloads=[];URL.createObjectURL=blob=>{window.csvDownloads.push(blob);return 'blob:fixture';};HTMLAnchorElement.prototype.click=function(){};});
      await page.addScriptTag({content:bundle.outputFiles.find(file=>file.path.endsWith('.js')).text});
      await page.getByRole('alert').filter({hasText:'来源分区读取失败'}).waitFor();
      assert.equal(requests,1);
      await page.getByRole('button',{name:'重试',exact:true}).click();
      await page.getByText('符合条件 40 条 · 第 1/2 页',{exact:true}).waitFor();
      assert.equal(requests,2,'retry issues a second request instead of clearing only the error');
      await page.getByRole('button',{name:'导出全部筛选结果'}).click();
      const exported=await page.evaluate(async()=>await window.csvDownloads.at(-1).text());
      assert.equal(exported.split('\r\n').length,41,'export includes both matching pages');
      await page.getByRole('button',{name:'下一页',exact:true}).first().click();
      await page.getByText('符合条件 40 条 · 第 2/2 页',{exact:true}).waitFor();
      await page.getByRole('button',{name:'清除日期',exact:true}).click();
      await page.getByText('符合条件 65 条 · 第 1/3 页',{exact:true}).waitFor();
      assert.equal(await page.getByLabel('作品发布日期开始').inputValue(),'');
      await page.getByLabel('作品发布日期开始').fill('2026-10-02');
      await page.getByLabel('作品发布日期结束').fill('2026-10-01');
      await page.getByRole('alert').filter({hasText:'开始日期不能晚于结束日期'}).waitFor();
      assert.equal(await page.getByRole('button',{name:'导出全部筛选结果'}).isDisabled(),true);
      await page.getByRole('button',{name:'清除日期',exact:true}).click();
      revision='B';await page.evaluate(()=>window.ledgerFixture.setRevision('B'));
      await page.getByText('B作品63',{exact:true}).waitFor();
      assert.equal(requests,3,'a new index revision revalidates the source parts');
      assert.equal(await page.getByText('A作品63',{exact:true}).count(),0);
    } finally {await context.close();}
  } finally {await browser.close();}
});
