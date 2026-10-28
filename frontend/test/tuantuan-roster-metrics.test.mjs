import test from 'node:test';
import assert from 'node:assert/strict';
import {sortTuantuanRoster} from '../lib/tuantuan-roster-view.mjs';
import {rosterSortFields,rosterProfileEntries,rosterProfileMetric} from '../lib/tuantuan-roster-metrics.mjs';
import {rosterSelection,rosterSelectionPath} from '../lib/tuantuan-roster-navigation.mjs';
import {tuantuanRosterExport} from '../lib/tuantuan-roster.mjs';

const row=(key,id,followers,likes)=>({key,source:null,accounts:id==null?[]:[{id,label:key,latest:{
 followers:{value:followers,date:'2026-10-28'},likes:{value:likes,date:'2026-10-28'}}}]});
const rows=[row('zero',1,0,0),row('high',2,500,900),row('missing',3,null,null),row('source-only',null)];
const metricById=new Map([[1,{metrics:{followers:{delta:0,baseline:0,value:0},likes:{delta:-4},posts:{delta:0}}}],
 [2,{metrics:{followers:{delta:20},likes:{delta:9},posts:{delta:-2}}}],
 [3,{metrics:{followers:{delta:-8},likes:{delta:0},posts:{delta:7}}}]]);
const context={metricById,changesReady:true,periodLabel:'2026-10-01 → 2026-10-28'};
const keys=items=>items.map(item=>item.key);

for(const [field,ascending] of [
 ['followers.value',['zero','high','missing','source-only']],['likes.value',['zero','high','missing','source-only']],
 ['followers.delta',['missing','zero','high','source-only']],['likes.delta',['zero','missing','high','source-only']],
 ['posts.delta',['high','zero','missing','source-only']],
])test(`${field} ranks the actual displayed values including zero, reductions and missing`,()=>{
 assert.deepEqual(keys(sortTuantuanRoster(rows,field,'asc',context)),ascending);
 const known=ascending.filter(key=>rosterProfileMetric(rows.find(row=>row.key===key),field,context)!==null);
 const absent=ascending.filter(key=>!known.includes(key));
 assert.deepEqual(keys(sortTuantuanRoster(rows,field,'desc',context)),[...known.reverse(),...absent]);
 assert.deepEqual(keys(rows),['zero','high','missing','source-only']);
});

test('every rank field survives direct links, tab changes and page links',()=>{
 for(const {key} of rosterSortFields){
  const path=rosterSelectionPath('/?theme=tuantuan&period=week&classification=slice#accounts',
   {sort:key,direction:'asc',page:2});
  const url=new URL(path,'https://fixture.invalid');assert.equal(rosterSelection(url.search).sort,key);
  assert.equal(url.searchParams.get('period'),'week');assert.equal(rosterSelection(url.search).page,2);
 }
});

test('multiple associated targets rank by a displayed maximum and never invent an author total',()=>{
 const multiple={key:'multi',source:{followers:9999},accounts:[...row('one',1,8,1).accounts,...row('two',2,12,2).accounts]};
 assert.deepEqual(rosterProfileEntries(multiple,'followers').map(entry=>entry.value),[8,12]);
 assert.equal(rosterProfileMetric(multiple,'followers.value',context),12);
 assert.equal(rosterProfileMetric(multiple,'likes.delta',context),9);
 const exported=tuantuanRosterExport([multiple],context);
 assert.equal(exported[1][9],'1: 8 / 2: 12');assert.equal(exported[1][15],'1: -4 / 2: 9');
});

test('source followers fallback matches the visible undated value without mixing work likes into homepage likes',()=>{
 const source={key:'source',source:{followers:13,likes:9000,posts:2},accounts:[]};
 assert.equal(rosterProfileMetric(source,'followers.value',context),13);
 assert.equal(rosterProfileMetric(source,'likes.value',context),null);
 assert.equal(rosterProfileMetric(source,'followers.delta',context),null);
 const csv=tuantuanRosterExport([source],context);assert.equal(csv[1][9],13);assert.equal(csv[1][10],null);
 assert.equal(csv[1][11],null);assert.equal(csv[1][14],null);
});

test('pending or malformed changes remain missing; date recomputation changes ranks without mutating rows',()=>{
 assert.equal(rosterProfileMetric(rows[1],'followers.delta',{...context,changesReady:false}),null);
 const next={...context,metricById:new Map([[1,{metrics:{followers:{delta:30}}}],[2,{metrics:{followers:{delta:-5}}}]])};
 assert.deepEqual(keys(sortTuantuanRoster(rows,'followers.delta','desc',next)),['zero','high','missing','source-only']);
 for(const bad of ['20',NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){
  const badContext={metricById:new Map([[2,{metrics:{followers:{delta:bad}}}]]),changesReady:true};
  assert.equal(rosterProfileMetric(rows[1],'followers.delta',badContext),null);
 }
});

test('CSV contains all filtered authors and matches profile/date/change values in the current range',()=>{
 const exported=tuantuanRosterExport(rows,context);const header=exported[0];
 assert.equal(exported.length,5);assert.equal(header.length,exported[1].length);
 const cell=(key,label)=>exported[key+1][header.indexOf(label)];
 assert.equal(cell(0,'最新粉丝数'),0);assert.equal(cell(0,'主页获赞变化'),-4);
 assert.equal(cell(1,'粉丝采样日期'),'2026-10-28');assert.equal(cell(3,'粉丝变化'),null);
 assert.equal(cell(2,'对比区间'),context.periodLabel);
 assert.equal(tuantuanRosterExport(rows,{...context,changesReady:false})[1][14],null);
});
