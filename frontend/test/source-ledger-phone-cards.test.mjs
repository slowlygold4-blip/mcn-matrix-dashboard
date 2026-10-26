import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

test('source authors and works keep every core field on a 390px phone and stay a table at 1280px', async () => {
 const root=fileURLToPath(new URL('../',import.meta.url));
 const main=process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../douyin-monitor-workbench/',import.meta.url));
 const {chromium}=createRequire(main+'package.json')('playwright-core');
 const authors=Array.from({length:31},(_,i)=>({
  row:i+1,name:`作者${i}`,douyinId:'00123',posts:12+i,slicePosts:8,creationPosts:3,aiPosts:1,
  plays:1234567890+i,likes:123456+i,targetIds:[],
 }));
 const works=Array.from({length:31},(_,i)=>({
  row:i+1,contentId:`73000000000000000${String(i).padStart(3,'0')}`,
  title:`可换行的作品标题 ${'测试长标题'.repeat(10)} ${i}`,author:'作者0',douyinId:'00123',
  publishDate:'2026-10-01',track:'切片激励',plays:1234567890+i,likes:123456+i,
  url:`https://www.douyin.com/video/73000000000000000${String(i).padStart(3,'0')}`,
 }));
 const bodies={
  'authors.json':JSON.stringify({revision:'phone-fixture',items:authors}),
  'works-001.json':JSON.stringify({revision:'phone-fixture',items:works}),
 };
 const files=Object.entries(bodies).map(([path,body])=>({
  path,bytes:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex'),
  count:JSON.parse(body).items.length,
 }));
 const source={revision:'phone-fixture',importedAt:'2026-10-23T00:00:00Z',
  stats:{authors:31,works:31,rawAuthorRows:31,reciprocalDuplicates:0},
  semantics:{plays:'作品累计播放·表格',likes:'作品累计点赞·表格'},
  tracks:[{name:'切片激励'}],files};
 const fixture=`import React from 'react';import {createRoot} from 'react-dom/client';import {CreatorSourceLedger} from './components/creator-source-panel';const source=${JSON.stringify(source)};createRoot(document.getElementById('root')).render(<CreatorSourceLedger source={source} foundation={null} accounts={[]} onOpenAccount={()=>{}}/>);`;
 const bundle=await build({stdin:{contents:fixture,resolveDir:root,sourcefile:'source-phone-fixture.tsx',loader:'tsx'},
  absWorkingDir:root,bundle:true,write:false,outfile:'source-phone-fixture.js',format:'iife',platform:'browser',
  jsx:'automatic',tsconfig:root+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'}});
 const script=bundle.outputFiles.find(file=>file.path.endsWith('.js')).text;
 const replica=await readFile(new URL('../app/replica.css',import.meta.url),'utf8');
 const visual=await readFile(new URL('../app/visual-theme.css',import.meta.url),'utf8');
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try {
  for(const width of [390,1280]) {
   const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});
   try {
    await context.route('**/*',route=>{
     const pathname=new URL(route.request().url()).pathname;
     if(pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div class="workspace"><aside class="sidebar"></aside><main><div class="content" id="root"></div></main></div><script src="/fixture.js"></script></body></html>'});
     if(pathname==='/fixture.js')return route.fulfill({contentType:'text/javascript',body:script});
     if(pathname.startsWith('/creator-source/'))return route.fulfill({contentType:'application/json',body:bodies[pathname.split('/').at(-1)]??'{}'});
     return route.abort();
    });
    const page=await context.newPage();
    await page.goto('http://127.0.0.1:9999/');
    await page.addStyleTag({content:replica});
    await page.addStyleTag({content:visual});
    await page.getByText('符合条件 31 条 · 第 1/2 页',{exact:true}).waitFor();
    const table=page.locator('.source-ledger > .table-scroll-shell .source-table');
    const wrap=page.locator('.source-ledger > .table-scroll-shell .source-table-wrap');
    const first=table.locator('tbody tr').first();
    assert.equal(await table.locator('tbody tr').count(),30);
    assert.equal(await table.locator('thead th').count(),5,'real table headings remain in the DOM');
    assert.equal(await page.getByRole('table').count(),1,'the responsive layout keeps table semantics');
    assert.equal(await page.getByRole('columnheader').count(),5,'screen readers keep all source column headings');
    if(width===390) {
     assert.equal(await table.evaluate(el=>getComputedStyle(el).display),'block');
     assert.equal(await first.locator('td').nth(2).evaluate(el=>getComputedStyle(el,'::before').content),'"累计播放 · 表格"');
     const widths=await wrap.evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth}));
     assert.ok(widths.scroll<=widths.client+1,`author table overflowed phone: ${JSON.stringify(widths)}`);
     const cell=await first.locator('td').nth(2).boundingBox();
     assert.ok(cell&&cell.x>=0&&cell.x+cell.width<=width+1,'core metric must be inside the phone viewport');
     assert.ok(await first.locator('td').nth(2).isVisible());
     assert.equal(await page.locator('.source-ledger > .table-scroll-shell .table-scroll-controls').count(),0);
    } else {
     assert.equal(await table.evaluate(el=>getComputedStyle(el).display),'table');
     assert.ok(await table.locator('thead').isVisible(),'desktop keeps the visible table headings');
     assert.ok((await wrap.evaluate(el=>el.scrollWidth))>=770);
    }
    if(process.env.MCN_VISUAL_PROOF_DIR){
     await first.scrollIntoViewIfNeeded();
     await page.screenshot({path:`${process.env.MCN_VISUAL_PROOF_DIR}/source-${width}-authors.png`});
    }
    await page.getByRole('button',{name:'查看此作者的来源作品'}).first().click();
    await page.getByText('符合条件 31 条 · 第 1/2 页',{exact:true}).waitFor();
    await page.getByRole('link',{name:/可换行的作品标题/}).first().waitFor();
    const worksTable=page.locator('.source-ledger > .table-scroll-shell .source-table');
    if(width===390) {
     assert.equal(await worksTable.locator('tbody tr').first().locator('td').nth(3).evaluate(el=>getComputedStyle(el,'::before').content),'"累计播放 · 表格"');
     const widths=await wrap.evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth}));
     assert.ok(widths.scroll<=widths.client+1,`work table overflowed phone: ${JSON.stringify(widths)}`);
     const documentWidth=await page.evaluate(()=>document.documentElement.scrollWidth);
     assert.ok(documentWidth<=width+1,`whole page overflowed phone: ${documentWidth}`);
    }
    if(process.env.MCN_VISUAL_PROOF_DIR){
     await worksTable.locator('tbody tr').first().scrollIntoViewIfNeeded();
     await page.screenshot({path:`${process.env.MCN_VISUAL_PROOF_DIR}/source-${width}-works.png`});
    }
    assert.match(await page.getByRole('link',{name:/可换行的作品标题/}).first().getAttribute('href'),/^https:\/\/www\.douyin\.com\/video\//);
    await page.getByRole('button',{name:'下一页',exact:true}).first().click();
    await page.getByText('符合条件 31 条 · 第 2/2 页',{exact:true}).waitFor();
    assert.equal(await worksTable.locator('tbody tr').count(),1,'pagination still selects the requested page');
    await page.getByRole('link',{name:/可换行的作品标题/}).first().focus();
    assert.equal(await page.evaluate(()=>document.activeElement?.tagName),'A','source link remains keyboard-focusable');
   } finally {await context.close();}
  }
 } finally {await browser.close();}
});
