import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const site = fileURLToPath(new URL('../', import.meta.url));
const main = process.env.MCN_MAIN_ROOT || fileURLToPath(new URL('../../douyin-monitor-workbench/', import.meta.url));
const {chromium} = createRequire(main + 'package.json')('playwright-core');
const fixture = `
 import React,{useState} from 'react';
 import {createRoot} from 'react-dom/client';
 import {PublishingChart} from './components/publishing-chart';
 const original=[
  {date:'2026-09-12',works:1200,tracks:{'切片':1100,'AI二创':100}},
  {date:'2026-09-14',works:2,tracks:{'切片':2}},
  {date:'2026-09-21',works:7,tracks:{'切片':4,'AI二创':3}},
 ];
 function Harness(){
  const [days,setDays]=useState(original),[track,setTrack]=useState('all');
  window.fixture={setDays,setTrack,original};
  window.inspections=window.inspections||[];
  return <PublishingChart days={days} track={track} onInspect={focus=>window.inspections.push(focus)}/>;
 }
 createRoot(document.getElementById('root')).render(<Harness/>);
`;

test('publishing chart renders real React controls and keeps dated work drilldowns exact', async t => {
 const bundle = await build({stdin:{contents:fixture,resolveDir:site,sourcefile:'publishing-chart-fixture.tsx',loader:'tsx'},absWorkingDir:site,bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',tsconfig:site+'tsconfig.json',define:{'process.env.NODE_ENV':'"test"'}});
 const browser = await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try {
  const context = await browser.newContext({viewport:{width:1100,height:800},reducedMotion:'reduce'});
  try {
   const page = await context.newPage(), errors = [];
   page.on('pageerror', error => errors.push(error.message));
   await page.route('**/*', route => route.abort());
   await page.setContent('<!doctype html><meta charset="utf-8"><div id="root"></div>');
   await page.addScriptTag({content:bundle.outputFiles[0].text});
   const selector = page.getByRole('combobox',{name:'选择发布日'});
   await selector.waitFor();
   const bars = page.locator('.source-ops-bars > button');
   const selection = page.locator('.source-ops-chart-selection');
   const choose = async date => {
    await selector.selectOption(date);
    await page.waitForFunction(date => document.querySelector('.source-ops-chart-selection select')?.value === date && document.querySelector('.source-ops-bar-column[aria-pressed="true"]')?.getAttribute('aria-label')?.startsWith(date), date);
   };
   const assertDay = async (date, count) => {
    assert.equal(await selector.inputValue(), date);
    assert.equal(await selection.locator('strong').textContent(), count.toLocaleString('zh-CN'));
    assert.equal(await bars.filter({hasText:date.slice(8)}).count(), 1);
    const active = page.locator('.source-ops-bar-column[aria-pressed="true"]');
    assert.equal(await active.count(), 1);
    assert.equal(await active.getAttribute('aria-label'), `${date}，${count.toLocaleString('zh-CN')} 条作品`);
    assert.equal(await page.locator('.source-ops-bar-column[tabindex="0"]').count(), 1);
   };

   await t.test('dates and formatted counts match the supplied cohort without filling absent dates', async () => {
    assert.equal(await bars.count(), 3);
    assert.deepEqual(await selector.locator('option').allTextContents(), ['2026-09-12 · 1,200 条','2026-09-14 · 2 条','2026-09-21 · 7 条']);
    await assertDay('2026-09-21',7);
    assert.match(await page.locator('.source-ops-chart-foot').textContent(), /最高 1,200 条/);
    assert.match(await page.locator('.source-ops-chart-hint').textContent(), /不是每日播放增长/);
   });

   await t.test('dropdown and column selection update the same exact date and drilldown', async () => {
    await choose('2026-09-12');
    await assertDay('2026-09-12',1200);
    await page.getByRole('button',{name:'查看当天作品 →',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.inspections.at(-1)), {view:'works',track:'all',startDate:'2026-09-12',endDate:'2026-09-12',mainTableOnly:true});
    await bars.nth(1).click();
    await assertDay('2026-09-14',2);
   });

   await t.test('Left, Right, Home, End move both selection and keyboard focus within bounds', async () => {
    await bars.nth(1).focus();
    for (const [key,date,count] of [
     ['ArrowLeft','2026-09-12',1200], ['ArrowLeft','2026-09-12',1200],
     ['ArrowRight','2026-09-14',2], ['End','2026-09-21',7],
     ['ArrowRight','2026-09-21',7], ['Home','2026-09-12',1200],
    ]) {
     await page.keyboard.press(key);
     await assertDay(date,count);
     assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')), `${date}，${count.toLocaleString('zh-CN')} 条作品`);
    }
   });

   await t.test('category changes preserve chosen dates and send the precise category and source restriction', async () => {
    await page.evaluate(()=>window.fixture.setTrack('AI二创'));
    await page.waitForFunction(()=>document.querySelector('.source-ops-chart-selection strong')?.textContent==='100');
    await assertDay('2026-09-12',100);
    assert.deepEqual(await selector.locator('option').allTextContents(), ['2026-09-12 · 100 条','2026-09-14 · 0 条','2026-09-21 · 3 条']);
    await choose('2026-09-21');
    await page.getByRole('button',{name:'查看当天作品 →',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.inspections.at(-1)), {view:'works',track:'AI二创',startDate:'2026-09-21',endDate:'2026-09-21',mainTableOnly:true});
    await choose('2026-09-14');
    await assertDay('2026-09-14',0);
   });

   await t.test('removed selection and empty days render safely, then recover with real data', async () => {
    await page.evaluate(()=>window.fixture.setDays([window.fixture.original[0]]));
    await page.waitForFunction(()=>document.querySelector('.source-ops-chart-selection select')?.value==='2026-09-12');
    await assertDay('2026-09-12',100);
    await page.evaluate(()=>window.fixture.setDays([]));
    await page.getByText('暂时没有带发布日期的作品。未记录日期的作品仍保留在全部作品里。',{exact:true}).waitFor();
    assert.equal(await selector.count(),0);
    assert.equal(await bars.count(),0);
    assert.equal(await page.getByRole('button',{name:'查看当天作品 →',exact:true}).count(),0);
    await page.evaluate(()=>{window.fixture.setTrack('all');window.fixture.setDays(window.fixture.original);});
    await selector.waitFor();
    await assertDay('2026-09-14',2);
    assert.deepEqual(errors,[]);
   });

   await t.test('missing and genuine-zero days never fabricate a peak of one', async()=>{
    await page.evaluate(()=>window.fixture.setDays([{date:'2026-10-27',works:null,tracks:{}}]));
    await page.waitForFunction(()=>document.querySelector('.source-ops-chart-selection select')?.value==='2026-10-27');
    assert.match(await page.locator('.source-ops-chart-foot').textContent(),/尚无有效发布记录/);
    assert.equal(await page.getByRole('button',{name:'查看当天作品 →',exact:true}).isDisabled(),true);
    await page.evaluate(()=>window.fixture.setDays([{date:'2026-10-27',works:0,tracks:{}}]));
    await page.waitForFunction(()=>document.querySelector('.source-ops-chart-selection strong')?.textContent==='0');
    assert.match(await page.locator('.source-ops-chart-foot').textContent(),/最高 0 条/);
   });

   await t.test('latest-known shortcut leaves a missing day explicit and opens only the chosen real date',async()=>{
    await page.evaluate(()=>window.fixture.setDays([{date:'2026-10-27',works:31,tracks:{}},{date:'2026-10-28',works:null,tracks:{}}]));
    await page.waitForFunction(()=>document.querySelector('.source-ops-chart-selection select')?.value==='2026-10-28');
    const latest=page.getByRole('button',{name:'最近有记录：2026-10-27'});
    await latest.click();await assertDay('2026-10-27',31);
    assert.equal(await latest.count(),0);
    await page.getByRole('button',{name:'查看当天作品 →',exact:true}).click();
    assert.equal((await page.evaluate(()=>window.inspections.at(-1))).startDate,'2026-10-27');
   });
  } finally { await context.close(); }
 } finally { await browser.close(); }
});
