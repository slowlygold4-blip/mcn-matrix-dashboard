// Independent actual Home controller acceptance for progressive-disclosure scope.
// Uses sealed synthetic sources and the existing VM/hook harness. This is not a
// real-browser keyboard/layout test and does not claim user-retention evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {derivePublicHistoryDateIndex} from '../lib/public-history-range.mjs';

const SITE=new URL('../../mcn-public-site/',import.meta.url);
const original=await readFile(new URL('./public-global-url-phase53-peer-20261001.test.mjs',import.meta.url),'utf8');
const begin=original.indexOf('const SITE = new URL('),end=original.indexOf('\nasync function apply(h,key)');
assert.ok(begin>0&&end>begin,'existing actual-Home harness boundaries must exist');
let source=original.slice(begin,end).replace("new URL('../../mcn-public-site/', import.meta.url)",`new URL(${JSON.stringify(SITE.href)})`);
source=source.replace("document:{visibilityState:'visible',activeElement:null,createElement()", "document:{visibilityState:'visible',activeElement:null,querySelector(){return null;},createElement()");
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const {pageHarness}=await new AsyncFunction('readFile','createRequire','createHash','vm','assert','derivePublicHistoryDateIndex',source+'\nreturn {pageHarness};')(readFile,createRequire,createHash,vm,assert,derivePublicHistoryDateIndex);
const A={start:'2026-09-20',end:'2026-09-29'};
const B={compare:true,otherStart:'2026-09-12',otherEnd:'2026-09-19'};
const scoped='?board=tuantuan&theme=tuantuan&classification=slice&period=custom&start='+A.start+'&end='+A.end;
const address='https://synthetic.invalid/';
const text=n=>n==null||typeof n==='boolean'?'':Array.isArray(n)?n.map(text).join(''):typeof n==='object'?text(n.props?.children):String(n);
const flatten=n=>n==null||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(flatten):[n,...flatten(n.props?.children)];
const clone=x=>JSON.parse(JSON.stringify(x));
const hasClass=(n,key)=>typeof n.props?.className==='string'&&n.props.className.split(/\s+/).includes(key);
const nativeSelect=(h,first)=>h.element(n=>n.type==='select'&&n.props.children?.[0]?.props?.children===first);
const periodSelect=h=>h.element(n=>n.type==='select'&&n.props.children?.some?.(x=>x?.props?.value==='month'));
const advanced=h=>{
 const found=h.element(n=>n.type==='details'&&flatten(n).some(x=>hasClass(x,'filters')));
 assert.ok(found,'advanced native details must own the existing data filters');return found;
};
const primaryScope=h=>{
 const found=h.element(n=>n.props['aria-label']==='当前生效范围');
 assert.ok(found,'applied scope must always have a programmatic label');return found;
};
const growth=h=>h.element(n=>n.type==='GrowthPanel');
const metrics=h=>clone(h.element(n=>n.type==='MetricLedger').props);
const allContainersOf=(h,target)=>h.all().filter(n=>n!==target&&flatten(n.props?.children).includes(target));
const isUnconditionallyVisible=(h,target)=>allContainersOf(h,target).every(n=>n.props.hidden!==true&&!(n.type==='details'&&n.props.open!==true));
async function toggle(h,open){const node=advanced(h);assert.equal(typeof node.props.onToggle,'function','controlled native details receives toggle state');node.props.onToggle({currentTarget:{open}});await h.flush();}

test('phase71 actual first screen: advanced scope defaults closed while period action remains outside it',async()=>{
 const h=await pageHarness(address+'?period=week#overview');try{
  const detail=advanced(h);assert.equal(detail.props.open,false,'native advanced section defaults collapsed');
  const children=Array.isArray(detail.props.children)?detail.props.children:[detail.props.children];
  assert.equal(children.find(Boolean)?.type,'summary','native summary is the first details child');
  assert.match(text(children.find(Boolean)),/筛选|范围/);
  assert.ok(!flatten(detail).includes(periodSelect(h)),'daily task period selector must not be behind advanced disclosure');
  assert.ok(!flatten(detail).includes(h.button('应用周期')),'main apply action remains exposed');
  assert.ok(isUnconditionallyVisible(h,primaryScope(h)),'accepted scope is not hidden with advanced controls');
 }finally{h.close();}
});

test('phase71 saved advanced URL: default collapse never hides applied matrix/theme/classification/A scope',async()=>{
 const h=await pageHarness(address+scoped+'#overview');try{
  assert.equal(advanced(h).props.open,false);
  const actual=primaryScope(h);assert.ok(isUnconditionallyVisible(h,actual));
  for(const expected of ['团团矩阵','团团','切片',A.start,A.end])assert.ok(text(actual).includes(expected),'applied summary missing '+expected);
  assert.deepEqual(h.dates(),[A.start,A.end]);assert.equal(metrics(h).count,2);
 }finally{h.close();}
});

test('phase71 saved B: accepted comparison endpoints stay outside advanced disclosure',async()=>{
 const h=await pageHarness(address+scoped+'&compareStart='+B.otherStart+'&compareEnd='+B.otherEnd+'#overview');try{
  const actual=primaryScope(h);assert.ok(isUnconditionallyVisible(h,actual));
  assert.ok(text(actual).includes(B.otherStart),'applied B start must be visible before opening optional controls');
  assert.ok(text(actual).includes(B.otherEnd),'applied B end must be visible before opening optional controls');
  assert.deepEqual(clone(growth(h).props.comparison),B);
 }finally{h.close();}
});

test('phase71 expand/collapse is presentation only: no source reads, address, metrics or A/B state changes',async()=>{
 const h=await pageHarness(address+scoped+'&compareStart='+B.otherStart+'&compareEnd='+B.otherEnd+'#accounts');try{
  const before={href:h.window.location.href,reads:[...h.reads],fetches:h.fetches.length,metrics:metrics(h),comparison:clone(growth(h).props.comparison),dates:h.dates(),history:[...h.historyEntries]};
  for(const open of [true,false,true,false]){
   await toggle(h,open);assert.equal(advanced(h).props.open,open);
   assert.equal(h.window.location.href,before.href);assert.deepEqual(h.reads,before.reads);assert.equal(h.fetches.length,before.fetches);
   assert.deepEqual(metrics(h),before.metrics);assert.deepEqual(clone(growth(h).props.comparison),before.comparison);
   assert.deepEqual(h.dates(),before.dates);assert.deepEqual(h.historyEntries,before.history);
  }
 }finally{h.close();}
});

test('phase71 unapplied period remains a visible draft when advanced controls are closed',async()=>{
 const h=await pageHarness(address+'?period=week#overview');try{
  const before=h.window.location.href,beforeMetrics=metrics(h),beforeDates=h.dates();
  await h.change(n=>n===periodSelect(h),'month');
  await toggle(h,true);await toggle(h,false);
  const pending=h.element(n=>hasClass(n,'period-pending'));assert.ok(pending,'unapplied period needs explicit user feedback');
  assert.ok(isUnconditionallyVisible(h,pending));assert.match(text(pending),/待应用|尚未改变/);
  assert.equal(periodSelect(h).props.value,'month');assert.equal(h.window.location.href,before);
  assert.deepEqual(metrics(h),beforeMetrics);assert.deepEqual(h.dates(),beforeDates);
 }finally{h.close();}
});

test('phase71 native semantics: no custom keyboard interception or focusable nested summary action',async()=>{
 const h=await pageHarness(address+'#overview');try{
  const detail=advanced(h),summary=flatten(detail).find(n=>n.type==='summary');assert.ok(summary);
  assert.equal(summary.props.onKeyDown,undefined,'native Enter/Space interaction must not be overridden');
  assert.equal(summary.props.role,undefined,'summary retains its browser-provided role');
  assert.equal(summary.props.tabIndex,undefined,'native summary is keyboard reachable without forced tabindex');
  assert.equal(detail.props.hidden,undefined,'closed state is native details, not permanent hidden');
  assert.equal(flatten(summary.props.children).some(n=>['Button','button','input','Input','select','a'].includes(n.type)),false,'no ambiguous nested action in disclosure label');
  for(const node of flatten(detail).filter(n=>n.type==='select'||n.type==='Input')){
   assert.ok(node.props['aria-label']||allContainersOf(h,node).some(n=>n.type==='label'),'every advanced control has a native wrapping or explicit label');
  }
  const css=await readFile(new URL('app/replica.css',SITE),'utf8');
  assert.match(css,/summary:focus-visible[^}]*outline/s,'native summary must retain a visible focus style');
  assert.match(css,/@media\s*\(prefers-reduced-motion:\s*reduce\)/,'the existing reduced-motion contract must be retained');
 }finally{h.close();}
});

test('phase71 advanced selections preserve current date math and exact two-account scope after recollapse',async()=>{
 const h=await pageHarness(address+'?period=week#overview');try{
  const dates=h.dates();await toggle(h,true);
  await h.change(n=>n===nativeSelect(h,'全部矩阵'),'tuantuan');
  await h.change(n=>n===nativeSelect(h,'全部主题'),'tuantuan');
  await h.change(n=>n===nativeSelect(h,'全部分类'),'slice');
  await toggle(h,false);
  assert.deepEqual(h.dates(),dates);assert.equal(metrics(h).count,2);
  const p=new URL(h.window.location.href).searchParams;
  assert.equal(p.get('board'),'tuantuan');assert.equal(p.get('theme'),'tuantuan');assert.equal(p.get('classification'),'slice');
  assert.ok(text(primaryScope(h)).includes('切片'));
  const reopened=await pageHarness(h.window.location.href);try{assert.deepEqual(metrics(reopened),metrics(h));assert.equal(advanced(reopened).props.open,false);}finally{reopened.close();}
 }finally{h.close();}
});

test('phase71 custom dates retain exact A/B share state after disclosure and refresh',async()=>{
 const h=await pageHarness(address+scoped+'&compareStart='+B.otherStart+'&compareEnd='+B.otherEnd+'#overview');try{
  await toggle(h,true);await h.change(n=>n.type==='Input'&&n.props.type==='date'&&n.props.max,'2026-09-21');
  assert.deepEqual(h.dates(),['2026-09-21',A.end]);assert.equal(periodSelect(h).props.value,'custom');
  const before=h.window.location.href;
  await h.click('刷新已发布数据');assert.equal(advanced(h).props.open,true,'refresh is not a disclosure reset');
  await toggle(h,false);assert.equal(h.window.location.href,before);
  assert.deepEqual(clone(growth(h).props.comparison),B);assert.deepEqual(h.dates(),['2026-09-21',A.end]);
  const reloaded=await pageHarness(before);try{assert.deepEqual(reloaded.dates(),h.dates());assert.deepEqual(clone(growth(reloaded).props.comparison),B);}finally{reloaded.close();}
 }finally{h.close();}
});

test('phase71 invalid date draft stays explained outside the collapsed form and never exposes stale statistics',async()=>{
 const h=await pageHarness(address+scoped+'#overview');try{
  await toggle(h,true);const href=h.window.location.href;
  await h.change(n=>n.type==='Input'&&n.props.type==='date'&&n.props.max,'');await toggle(h,false);
  assert.equal(h.window.location.href,href,'invalid draft must not replace accepted share address');
  assert.equal(growth(h).props.ready,false);assert.ok(growth(h).props.pendingError);
  const error=h.all().find(n=>n.props.role==='status'&&text(n).includes(growth(h).props.pendingError));
  assert.ok(error,'invalid draft requires an explicit explanation');assert.ok(isUnconditionallyVisible(h,error));
  assert.ok(isUnconditionallyVisible(h,primaryScope(h)));
  assert.match(text(primaryScope(h)),/待核对|尚未应用/,'visible proposed scope must not masquerade as accepted statistics');
  const ledger=h.element(n=>n.type==='MetricLedger');assert.ok(allContainersOf(h,ledger).some(n=>n.props.hidden===true),'stale metrics remain hidden');
 }finally{h.close();}
});

test('phase71 primary three-layer navigation remains exposed and preserves accepted scope while folded',async()=>{
 const h=await pageHarness(address+scoped+'#overview');try{
  for(const [name,heading,hash] of [['账号明细','账号明细','#accounts'],['话题观察','话题观察','#topics'],['经营总览','矩阵经营总览','#overview']]){
   await h.click(name);assert.equal(h.heading(),heading);assert.equal(h.window.location.hash,hash);
   const p=new URL(h.window.location.href).searchParams;assert.equal(p.get('theme'),'tuantuan');assert.equal(p.get('classification'),'slice');assert.equal(p.get('start'),A.start);assert.equal(p.get('end'),A.end);
   const button=h.button(name);assert.ok(isUnconditionallyVisible(h,button));assert.equal(button.props['aria-current'],'page');
  }
  assert.equal(advanced(h).props.open,false);assert.equal(metrics(h).count,2);
 }finally{h.close();}
});

test('phase71 malformed saved scope never falls back to an attractive all-account view',async()=>{
 const h=await pageHarness(address+'?theme=unknown&classification=slice&period=week#overview');try{
  assert.ok(h.element(n=>n.props.role==='alert'));
  assert.ok(!h.element(n=>n.type==='MetricLedger'));
  assert.ok(h.fetches.length<=1,'a scope identity may require the catalog, but must not trigger retrying metadata');
 }finally{h.close();}
});
