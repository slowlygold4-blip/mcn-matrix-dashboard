import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

const js = readFileSync(process.env.PHASE107_JS_SOURCE || new URL('../public/rebuild.js', import.meta.url), 'utf8');
function fixture() {
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, { id, innerHTML:'', textContent:'', value:'', dataset:{}, setAttribute(){}, focus(){}, querySelector(){return null;}, querySelectorAll(){return [];} }); return nodes.get(id); };
  let blob;
  const document = {getElementById:node, querySelectorAll:()=>[], createElement:()=>({click(){}})};
  class FixtureURL extends URL { static createObjectURL(value) { blob=value; return 'blob:fixture'; } static revokeObjectURL(){} }
  const context = {...model,fmt:model.formatNumber,document,URL:FixtureURL,URLSearchParams,Intl,Date,Blob,setTimeout:()=>0,
    location:new URL('http://fixture.invalid/'),history:{replaceState(){}}};
  runInNewContext(js.replace(/^import[^\n]+\n/,'').replace(/void init\(\);\s*$/,'')+'\nthis.subject={state,accountTable,renderAccounts,rows,downloadCsv,columns};',context);
  const subject=context.subject;
  Object.assign(subject.state,{view:'accounts',period:'custom',start:'2026-09-25',end:'2026-10-01',data:{period:'custom',range:{startDate:'2026-09-25',endDate:'2026-10-01'},accounts:[]}});
  const account = (value,reason='',id=1) => ({id,label:'作者'+id,enabled:true,platform:'douyin',boards:[],status:{},collection:{},metrics:Object.fromEntries(Object.keys(model.METRICS).map(key=>[key,{value,delta:-9,reason,deltaReliable:true}]))});
  return {...subject,node,account,blob:()=>blob};
}
function cells(html) {return [...html.matchAll(/<td\b[^>]*>[\s\S]*?<\/td>/g)].map(match=>match[0]);}

test('stock compact primary retains visible exact integers and title includes exact plus reason',()=>{
  const f=fixture(),html=f.accountTable([f.account(12345,'历史端点缺失')]),td=cells(html)[1];
  assert.match(td,/<span class="metric">1\.23万<\/span>/);
  assert.match(td,/<small class="metric-exact muted">记录 12,345<\/small>/);
  assert.match(td,/title="12,345 · 历史端点缺失"/);
  assert.match(td,/<details[^>]+class="account-metric-reason"[^>]*><summary[^>]*>粉丝数说明<\/summary><p>历史端点缺失<\/p><\/details>/);
});
test('zero, null and already exact stocks do not add redundant lines or reasonless tab stops',()=>{
  const f=fixture();
  for(const [value,display] of [[0,'0'],[null,'—'],[9999,'9,999']]) {
    const html=f.accountTable([f.account(value)]);
    assert.ok(cells(html)[1].includes(`<span class="metric">${display}</span>`));
    assert.doesNotMatch(html,/metric-exact|account-metric-reason|<summary/);
  }
});
test('large and negative stock values are exact without deriving a replacement value',()=>{
  const f=fixture();
  for(const value of [10000,10001,123456789,-12345,Number.MAX_SAFE_INTEGER]) {
    const td=cells(f.accountTable([f.account(value)]))[1];
    assert.ok(td.includes(`<span class="metric">${model.formatNumber(value)}</span>`));
    assert.ok(td.includes(`<small class="metric-exact muted">记录 ${model.formatNumber(value,true)}</small>`));
  }
});
test('history sampling line remains beside precise stock and daily noncomparable reason is expandable',()=>{
  const f=fixture(),a=f.account(12345,'非相邻日，不能当作日变化');
  Object.assign(a.metrics.followers,{dailyComparable:false,recordedStockOutsideWindow:true,currentAt:'2026-09-23T02:00:00Z'});
  f.state.data.period='day';const row=cells(f.accountTable([a]));
  assert.match(row[1],/历史值 · /);assert.match(row[1],/记录 12,345/);
  assert.match(row[2],/<span class="flat">—<\/span>/);
  assert.match(row[2],/>粉丝净变化说明<\/summary><p>非相邻日，不能当作日变化<\/p>/);
});
test('reason text and disclosure identifiers are escaped with stable root-specific ids',()=>{
  const f=fixture(),a=f.account(12345,'<img src=x onerror="alert(1)"> & \'说明\'','author"<1');
  const ledger=f.accountTable([a],'accountsTable'),overview=f.accountTable([a],'overviewTable');
  assert.doesNotMatch(ledger,/<img|onerror="alert/);
  assert.match(ledger,/&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp;/);
  const ids=html=>[...html.matchAll(/<details id="([^"]+)"/g)].map(x=>x[1]);
  assert.equal(ids(ledger).length,7);assert.equal(new Set([...ids(ledger),...ids(overview)]).size,14);
  assert.deepEqual(ids(f.accountTable([f.account(0,'other',2),a],'accountsTable')).slice(7),ids(ledger));
});
test('actual table rendering does not mutate values, sort order, CSV stock, negatives or missing fields',async()=>{
  const f=fixture();f.state.data.accounts=[12345,0,null,-9].map((v,i)=>f.account(v,i===0?'缺少基准':'',i+1));
  const before=JSON.stringify(f.state.data);
  for(const direction of ['asc','desc']) {
    Object.assign(f.state,{sort:'followers.value',direction});f.renderAccounts();f.downloadCsv();
    const csv=(await f.blob().text()).replace(/^\ufeff/,'').split('\r\n').slice(1).map(row=>row.split(',')[5].replaceAll('"',''));
    assert.deepEqual(csv,direction==='asc'?['-9','0','12345','']:['12345','0','-9','']);
    assert.deepEqual(Array.from(f.rows(),a=>a.id),direction==='asc'?[4,2,1,3]:[1,2,4,3]);
    assert.equal(JSON.stringify(f.state.data),before);
  }
});
