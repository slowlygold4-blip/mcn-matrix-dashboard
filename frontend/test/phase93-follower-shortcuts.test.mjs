// Actual Home event-owner proof; simulated hooks/DOM, not real-browser evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const site=new URL('../',import.meta.url);
const main='/Users/tyke/Documents/Codex/2026-08-31/bi-a/outputs/douyin-monitor-workbench/';
const harnessUrl=new URL('test/phase66-workspace-state-peer.test.mjs','file://'+main);
const ownerSite=process.env.PHASE93_BASELINE==='1'?new URL('../mcn-public-site/','file://'+main):site;
const harness=(await readFile(harnessUrl,'utf8')).replace(/^import[^\n]*\n/gm,'')
 .replace("new URL('../../mcn-public-site/',import.meta.url)",JSON.stringify(ownerSite.href)).replaceAll('import.meta.url',JSON.stringify(harnessUrl.href));
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const {home,nodes,button,six,asOf,textOf}=await new AsyncFunction('test','assert','readFile','createRequire','vm',harness+'\nreturn {home,nodes,button,six,asOf,textOf};')(()=>{},assert,readFile,createRequire,vm);
const nav=await import(new URL('lib/replica-navigation.mjs',site));
const deep=x=>JSON.parse(JSON.stringify(x));
const comparison={compare:true,otherStart:'2026-09-14',otherEnd:'2026-09-28'};
async function ready(){const h=home('https://phase93.invalid'+nav.workspaceSelectionPath('/','accounts',six,{sort:'likes.value',order:'asc',query:'合成作者',rosterStatus:'all'},comparison));await h.flush();return h;}
const click=async(h,label)=>{button(h,label).props.onClick();await h.flush();};
// The phase66 hook harness does not expand child components; the real Pager
// has its own focus/keyboard tests, so invoke Home's passed page callback here.
const nextPage=async h=>{const pager=h.all().find(n=>n.type?.name==='Pager'&&n.props.count>20);assert.ok(pager,'Home pager missing');pager.props.change(2);await h.flush();};
const csv=async h=>{button(h,'导出全部结果').props.onClick();return (await h.downloads.at(-1).blob.text()).trimEnd().split(/\r?\n/);};
const selected=h=>['涨粉优先','掉粉优先'].map(label=>button(h,label).props['aria-pressed']);
const ids=h=>h.all().filter(n=>n.type==='TableRow'&&typeof n.key==='number').map(n=>n.key);
test('actual Home shortcuts are direct, derived, idempotent and do not reset page on same selection',async()=>{
 const h=await ready();try{const networkBefore=h.network.length;
  assert.deepEqual(selected(h),[false,false]);await click(h,'涨粉优先');assert.equal(h.state('sort'),'followers.delta');assert.equal(h.state('order'),'desc');assert.deepEqual(selected(h),[true,false]);
  await nextPage(h);assert.equal(h.state('page'),2);const url=h.window.location.href;await click(h,'涨粉优先');assert.equal(h.state('page'),2);assert.equal(h.window.location.href,url);
  await click(h,'掉粉优先');assert.equal(h.state('page'),1);assert.equal(h.state('order'),'asc');assert.deepEqual(selected(h),[false,true]);
  await click(h,'掉粉优先');assert.equal(h.state('order'),'asc');await click(h,'点赞');assert.deepEqual(selected(h),[false,false]);
  await click(h,'粉丝变化');assert.deepEqual(selected(h),[true,false]);await click(h,'粉丝变化 ↓');assert.deepEqual(selected(h),[false,true]);
  assert.equal(h.network.length,networkBefore); // sorting never starts a new read
 }finally{h.close();}
});
test('actual Home retains positive, zero, negative, missing and tie rows, with null last in both CSV orders',async()=>{
 const h=await ready();try{
  const data=deep(h.state('data'));const deltas=[12,0,-8,null,12];
  for(const p of data.points)if(p.date===six.end){const delta=deltas[(p.targetId-1)%deltas.length];p.followers=delta===null?null:100+delta;p.followersAt=delta===null?null:p.capturedAt;}
  h.set('data',data);await h.flush();const before=await csv(h),beforeMetrics=deep(h.all().find(n=>n.type==='MetricLedger').props.metrics),networkBefore=h.network.length;
  for(const [label,first] of [['涨粉优先',1],['掉粉优先',3]]){
   await click(h,label);assert.equal(ids(h)[0],first);const output=await csv(h);assert.deepEqual(output.slice(1).sort(),before.slice(1).sort());assert.equal(output.length,26);
   for(const id of [4,9,14,19,24])assert.ok(output.slice(-5).some(line=>line.includes('合成作者'+String(id).padStart(3,'0'))));
   assert.deepEqual(deep(h.all().find(n=>n.type==='MetricLedger').props.metrics),beforeMetrics);
   assert.deepEqual(deep(h.state('data')),data);assert.equal(h.network.length,networkBefore);
  }
 }finally{h.close();}
});
test('actual Home all-negative/all-positive/all-zero/all-missing never turns shortcuts into sign filters',async()=>{
 for(const delta of [-1,1,0,null]){const h=await ready();try{
  const data=deep(h.state('data'));for(const p of data.points)if(p.date===six.end){p.followers=delta===null?null:100+delta;p.followersAt=delta===null?null:p.capturedAt;}h.set('data',data);await h.flush();
  const before=await csv(h);let first;for(const label of ['涨粉优先','掉粉优先']){await click(h,label);const output=await csv(h);assert.deepEqual(output.slice(1).sort(),before.slice(1).sort());if(first)assert.deepEqual(output,first);first=output;assert.deepEqual(ids(h),Array.from({length:20},(_,i)=>i+1));}
 }finally{h.close();}}
});
test('actual Home preserves range/comparison/draft/filter, refresh address and exact return focus/page/CSV',async()=>{
 const h=await ready();let fresh;try{
  h.set('periodDraft','week');await h.flush();await click(h,'掉粉优先');
  assert.equal(h.state('query'),'合成作者');assert.equal(h.state('rosterStatus'),'all');assert.equal(h.state('board'),six.board);assert.equal(h.state('theme'),six.theme);assert.equal(h.state('tag'),six.tag);
  assert.equal(h.state('start'),six.start);assert.equal(h.state('end'),six.end);assert.equal(h.state('periodDraft'),'week');assert.deepEqual(deep(h.state('comparison')),comparison);
  const current=h.window.location.href;fresh=home(current);await fresh.flush();assert.deepEqual(selected(fresh),[false,true]);assert.equal(fresh.state('query'),'合成作者');assert.deepEqual(deep(fresh.state('comparison')),comparison);
  const networkBefore=h.network.length;await nextPage(h);h.window.scrollY=555;const beforeCsv=await csv(h),trigger={isConnected:true,disabled:false,focus(){h.document.activeElement=this;}};
  const row=h.all().find(n=>n.type==='TableRow'&&typeof n.key==='number');nodes(row).find(n=>n.props.className==='author').props.onClick({currentTarget:trigger});await h.flush();
  h.back();await h.flush();assert.equal(h.window.location.href,current);assert.equal(h.state('page'),2);assert.equal(h.window.scrollY,555);assert.equal(h.document.activeElement,trigger);assert.deepEqual(await csv(h),beforeCsv);assert.deepEqual(selected(h),[false,true]);// Entering/leaving a pinned account rechecks publication metadata. It must
  // not reread partitions or start collection while restoring list state.
  const checks=h.network.slice(networkBefore);assert.equal(checks.length,2);assert.ok(checks.every(([url,options])=>url==='/api/replica'&&(!options.method||options.method==='GET')));
 }finally{h.close();fresh?.close();}
});
