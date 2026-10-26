import test from 'node:test';
import assert from 'node:assert/strict';
import {rosterDefaults,rosterSelection,rosterSelectionPath,rosterPanelSelection,rosterPanelPath,preserveRosterSelection} from '../lib/tuantuan-roster-navigation.mjs';

test('roster selection persists independently of account and source filters',()=>{
 const selection={panel:'authors',query:'团团 / 别名',mode:'paused',sort:'likes',direction:'asc',page:3};
 const path=rosterSelectionPath('/?theme=tuantuan&classification=slice&query=全局&rosterStatus=all&sourceQuery=来源&sourcePage=2#accounts',selection);
 const url=new URL(path,'https://dashboard.invalid');
 assert.deepEqual(rosterSelection(url.search),selection);
 assert.equal(url.searchParams.get('query'),'全局');
 assert.equal(url.searchParams.get('rosterStatus'),'all');
 assert.equal(url.searchParams.get('sourceQuery'),'来源');
 assert.equal(url.searchParams.get('sourcePage'),'2');
 const moved=new URL(preserveRosterSelection('/?period=week&rosterStatus=paused#source',url.search),'https://dashboard.invalid');
 assert.deepEqual(rosterSelection(moved.search),selection);
 assert.equal(moved.searchParams.get('rosterStatus'),'paused');
 assert.equal(moved.searchParams.get('period'),'week');
 assert.equal(moved.hash,'#source');
});

test('roster defaults omit only owned defaults and preserve unrelated query values',()=>{
 assert.deepEqual(rosterSelection('?rosterStatus=all'),rosterDefaults);
 const reset=rosterSelectionPath('/?rosterPanel=authors&rosterPage=4&rosterQuery=团团&rosterStatus=paused&sourceView=works#accounts',rosterDefaults);
 assert.equal(reset,'/?rosterStatus=paused&sourceView=works#accounts');
 for(const mode of ['all','monitored','paused','source-only'])assert.equal(rosterSelection('?rosterMode='+mode).mode,mode);
 assert.equal(rosterSelection('?rosterPage=999999').page,999999,'range membership is checked only after the real roster has loaded');
});

test('malformed roster state stays explicit instead of silently widening the result',()=>{
 for(const query of ['?rosterPanel=bad','?rosterMode=enabled','?rosterDirection=up','?rosterSort=followers','?rosterPage=0','?rosterPage=01','?rosterPage=1.5','?rosterPage=-1','?rosterPage=1000000','?rosterPage=2&rosterPage=3','?rosterQuery=%00bad','?rosterFoo=bad','?rosterQuery='+'x'.repeat(201)])assert.throws(()=>rosterSelection(query),/团团名册/);
 assert.match(preserveRosterSelection('/#accounts','?rosterPage=2&rosterPage=3'),/rosterPage=2&rosterPage=3/);
 assert.throws(()=>rosterSelection('?rosterQuery='+'x'.repeat(3001)),/过长/);
 for(const path of ['//evil.invalid/','https://evil.invalid/','/\\evil','/\n'])assert.throws(()=>rosterSelectionPath(path,rosterDefaults),/地址无效/);
});

test('panel navigation changes only the panel and preserves all independent selections',()=>{
 const path='/?theme=tuantuan&classification=slice&period=custom&start=2026-09-12&end=2026-09-30&query=监控账号&rosterStatus=paused&sourceQuery=来源&sourcePage=2&rosterPanel=authors&rosterQuery=团团%20%2F%20别名&rosterMode=paused&rosterSort=likes&rosterDirection=asc&rosterPage=3#accounts';
 const before=new URL(path,'https://dashboard.invalid');
 const others=url=>[...url.searchParams].filter(([key])=>key!=='rosterPanel');
 const changes=new URL(rosterPanelPath(path,'changes'),'https://dashboard.invalid');
 assert.deepEqual(changes.searchParams.getAll('rosterPanel'),['changes']);
 assert.deepEqual(others(changes),others(before));
 assert.equal(changes.hash,'#accounts');
 const authors=new URL(rosterPanelPath(changes.pathname+changes.search+changes.hash,'authors'),'https://dashboard.invalid');
 assert.deepEqual(authors.searchParams.getAll('rosterPanel'),[]);
 assert.deepEqual(others(authors),others(before));
 assert.deepEqual(rosterSelection(authors.search),rosterSelection(before.search));
 assert.equal(rosterPanelPath(authors.pathname+authors.search+authors.hash,'authors'),authors.pathname+authors.search+authors.hash,'reselecting authors is path-idempotent');
 assert.equal(rosterPanelPath(changes.pathname+changes.search+changes.hash,'changes'),changes.pathname+changes.search+changes.hash,'reselecting changes is path-idempotent');
});

test('panel-only navigation preserves malformed fields for explicit recovery instead of resetting the roster',()=>{
 for(const invalid of ['rosterPage=0','rosterPage=2&rosterPage=3','rosterMode=unknown','rosterQuery=%00bad','rosterFoo=bad','rosterSort=likes&rosterSort=posts']){
  const path='/?theme=tuantuan&query=甲&query=乙&sourcePage=2&rosterPanel=authors&'+invalid+'#accounts';
  const before=new URL(path,'https://dashboard.invalid');
  for(const panel of ['changes','authors']){
   const next=new URL(rosterPanelPath(path,panel),'https://dashboard.invalid');
   assert.deepEqual([...next.searchParams].filter(([key])=>key!=='rosterPanel'),[...before.searchParams].filter(([key])=>key!=='rosterPanel'));
   assert.throws(()=>rosterSelection(next.search),/团团名册/,'panel selection must not silently repair an unrelated invalid field');
  }
 }
 const duplicated=new URL(rosterPanelPath('/?rosterPanel=bad&rosterPage=2&rosterPanel=changes&sourceQuery=甲&sourceQuery=乙#source','authors'),'https://dashboard.invalid');
 assert.deepEqual(duplicated.searchParams.getAll('rosterPanel'),[],'the explicitly selected panel replaces stale or duplicate panel values');
 assert.deepEqual(duplicated.searchParams.getAll('sourceQuery'),['甲','乙']);
 assert.equal(duplicated.searchParams.get('rosterPage'),'2');
 assert.equal(duplicated.hash,'#source','panel helper does not choose the workspace route');
});

test('panel-only navigation rejects unknown panels and nonlocal addresses',()=>{
 for(const panel of ['',null,undefined,'source','changes#source','AUTHORS',1])assert.throws(()=>rosterPanelPath('/?theme=tuantuan#accounts',panel),/面板|panel/);
 for(const path of ['//evil.invalid/','https://evil.invalid/','javascript:alert(1)','/\\evil','/\n',null,undefined])assert.throws(()=>rosterPanelPath(path,'authors'),/地址无效/);
});

test('panel selection is independent of recoverable errors in the author filters',()=>{
 assert.equal(rosterPanelSelection(''),'authors');
 for(const invalid of ['rosterPage=0','rosterPage=2&rosterPage=3','rosterMode=unknown','rosterQuery=%00bad','rosterFoo=bad']){
  assert.equal(rosterPanelSelection('?'+invalid),'authors');
  assert.equal(rosterPanelSelection('?rosterPanel=changes&'+invalid),'changes');
  assert.equal(rosterPanelSelection('?rosterPanel=authors&'+invalid),'authors');
  assert.throws(()=>rosterSelection('?rosterPanel=authors&'+invalid),/团团名册/,'independent panel selection must not hide the original validation error');
 }
 for(const search of ['?rosterPanel=','?rosterPanel=bad','?rosterPanel=authors&rosterPanel=changes','?rosterPanel=authors&rosterPanel=authors'])assert.throws(()=>rosterPanelSelection(search),/团团名册/);
});
