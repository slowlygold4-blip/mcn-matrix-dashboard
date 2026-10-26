import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

const js = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/rebuild.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/rebuild.css', import.meta.url), 'utf8');
function fixture() {
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, { innerHTML:'', textContent:'', value:'', dataset:{}, setAttribute(){}, focus(){}, querySelector(){return null;} }); return nodes.get(id); };
  let blob;
  const document = {getElementById:node, querySelectorAll:()=>[], createElement:()=>({click(){}})};
  class FixtureURL extends URL { static createObjectURL(value) { blob=value; return 'blob:fixture'; } static revokeObjectURL(){} }
  const context = {...model,fmt:model.formatNumber,document,URL:FixtureURL,URLSearchParams,Intl,Date,Blob,setTimeout:()=>0,
    location:new URL('http://fixture.invalid/?theme=tuantuan&classification=slice'),history:{replaceState(){}}};
  runInNewContext(js.replace(/^import[^\n]+\n/,'').replace(/void init\(\);\s*$/,'')+'\nthis.subject={state,renderAccounts,rows,downloadCsv,columns};',context);
  const subject=context.subject;
  Object.assign(subject.state,{view:'accounts',period:'custom',start:'2026-09-25',end:'2026-10-01',data:{period:'custom',range:{startDate:'2026-09-25',endDate:'2026-10-01'},accounts:[12,0,-9,null].map((value,i)=>({id:i+1,label:['甲','乙','丙','丁'][i],enabled:true,platform:'douyin',boards:[],status:{},collection:{},metrics:Object.fromEntries(Object.keys(model.METRICS).map(key=>[key,{value,delta:value,deltaReliable:true}]))}))}});
  return {...subject,node,blob:()=>blob};
}
test('all eight column labels and both directions drive the persistent reading summary and actual row order',()=>{
  const f=fixture();
  for(const [key,label] of f.columns) for(const direction of ['asc','desc']) {
    Object.assign(f.state,{sort:key,direction}); f.renderAccounts();
    const summary=f.node('accountCount').textContent;
    assert.ok(summary.includes(`当前按${label} · `),summary);
    assert.ok(summary.includes(key==='label' ? (direction==='asc'?'名称升序':'名称降序') : (direction==='asc'?'从低到高':'从高到低')),summary);
    if(key!=='label') {
      assert.match(summary,/缺测最后/);
      assert.deepEqual(Array.from(f.rows(),a=>a.id),direction==='asc'?[3,2,1,4]:[1,2,3,4]);
    }
    assert.equal(f.state.theme,'tuantuan');assert.equal(f.state.classification,'slice');
  }
  f.state.query='不存在';f.renderAccounts();assert.match(f.node('accountCount').textContent,/筛选结果 0 个.*当前按作品净变化/);
});
test('actual CSV and table preserve negative, zero, missing and exact values under net-change labels',async()=>{
  const f=fixture();Object.assign(f.state,{sort:'followers.delta',direction:'asc'});f.renderAccounts();f.downloadCsv();
  const csv=await f.blob().text(), lines=csv.replace(/^\ufeff/,'').split('\r\n').map(row=>row.split(',').map(cell=>cell.replace(/^"|"$/g,'')));
  assert.deepEqual(lines[0].slice(5,12),['粉丝数','粉丝净变化','获赞数','获赞净变化','估算播放变化(获赞净变化×100)','作品数','作品净变化']);
  assert.deepEqual(lines.slice(1).map(row=>row.slice(5,12)),[['-9','-9','-9','-9','-9','-9','-9'],['0','0','0','0','0','0','0'],['12','12','12','12','12','12','12'],['','','','','','','']]);
  assert.match(f.node('accountsTable').innerHTML,/粉丝净变化/);assert.match(f.node('accountsTable').innerHTML,/获赞净变化/);
  assert.match(f.node('accountsTable').innerHTML,/>-9<\/span>/);assert.match(f.node('accountsTable').innerHTML,/>0<\/span>/);assert.match(f.node('accountsTable').innerHTML,/>—<\/span>/);
});
test('day non-comparable deltas do not acquire a false missing-last promise',()=>{
  const f=fixture();f.state.data.period='day';Object.assign(f.state,{sort:'followers.delta',direction:'desc'});
  f.state.data.accounts[0].metrics.followers={value:100,delta:12345,dailyComparable:false};
  f.renderAccounts();
  assert.deepEqual(Array.from(f.rows(),a=>a.id),[2,3,1,4],'visible daily changes rank first; hidden and missing changes tie by stable ID');
  assert.match(f.node('accountsTable').innerHTML,/class="flat">—<\/span>/);
  assert.match(f.node('accountCount').textContent,/缺测最后/);
  assert.match(f.node('accountCount').textContent,/非日可比变化显示— · 缺测最后/);
  f.state.sort='followers.value';f.renderAccounts();assert.match(f.node('accountCount').textContent,/缺测最后/);
});
test('detail and formula copy describe net change without relabeling historical stock estimates',()=>{
  assert.doesNotMatch(js,/涨粉|新增赞/);assert.doesNotMatch(html,/涨粉|新增赞/);
  assert.match(js,/<th>粉丝净变化<\/th><th>获赞<\/th><th>获赞净变化<\/th>/);
  assert.match(html,/估算播放 = 获赞净变化 × 100/);
  assert.match(js,/估算播放（获赞×100）/,'historical stock remains stock, not delta');
});
test('auxiliary text reuses approved semantic colors without inventing another palette',()=>{
  assert.match(css,/#overviewView > \.metric-boundary\s*\{[^}]*color: var\(--muted\)/);
  assert.match(css,/\.load-feedback\[data-state="warning"\]\s*\{[^}]*color: var\(--orange\)/);
  assert.match(css,/\.topic-stat \.topic-missing\s*\{[^}]*color: var\(--orange\)/);
});
