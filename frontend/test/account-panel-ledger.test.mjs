// Render the actual account page and ledger with already loaded synthetic daily
// rows. Only the page's first state slot is seeded; no browser or network runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {growthSeries} from '../lib/replica-trends.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const entry=root+'components/account-panel.tsx';
const require=createRequire(import.meta.url);
const compiled=await build({entryPoints:[entry],absWorkingDir:root,bundle:true,write:false,platform:'node',format:'cjs',packages:'external',tsconfig:root+'tsconfig.json',plugins:[{
 name:'loaded-account-state',setup(build){build.onResolve({filter:/^react$/},args=>args.importer===entry?{path:'account-test-state',external:true}:undefined);},
}]});
const account={id:7,label:'合成账号',platform:'douyin',enabled:true,boardKeys:[],classification:{theme:{label:'团团'},labels:[]}};
const manifest={asOf:'2026-11-04T08:00:00.000Z',timeZone:'Asia/Shanghai',files:[]};
const start='2026-11-02',end='2026-11-03';
function point(date,followers,likes,posts){
 const capturedAt=date+'T04:00:00.000Z';
 return {id:Number(date.slice(-2)),targetId:account.id,date,capturedAt,sourceChecksum:'a'.repeat(64),followers,likes,posts,
  followersAt:followers==null?null:capturedAt,likesAt:likes==null?null:capturedAt,postsAt:posts==null?null:capturedAt};
}
function render(records,request={start,end}){
 let slot=0;
 const pageReact={...React,useState:initial=>React.useState(slot++===0?records:initial)},module={exports:{}};
 Function('require','module','exports',compiled.outputFiles[0].text)(name=>name==='account-test-state'?pageReact:require(name),module,module.exports);
 const html=renderToStaticMarkup(React.createElement(module.exports.AccountPanel,{account,manifest,boards:[],request,onReturn(){},onAddress(){},onHistory(){}}));
 const ledger=html.match(/<section class="metric-ledger"[\s\S]*?<\/section>/)?.[0];
 assert.ok(ledger,'actual account page must render its ledger after daily history loads');
 const cards=[...ledger.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/g)].map(match=>match[1].replace(/<[^>]+>/g,''));
 return {html,ledger,cards,card:label=>{const found=cards.find(card=>card.startsWith(label));assert.ok(found,label);return found;}};
}

test('actual account page supplies one-account observed/comparable counts while preserving positive, negative and zero changes',()=>{
 const records=[point(start,10,20,4),point(end,12,17,4)],original=structuredClone(records),page=render(records);
 assert.match(page.card('粉丝总数'),/粉丝总数12有数据 1\/1 个账号/);
 assert.match(page.card('粉丝变化'),/粉丝变化\+2.*两天都有数据 1\/1 个账号/);
 assert.match(page.card('主页获赞变化'),/主页获赞变化-3.*两天都有数据 1\/1 个账号/);
 assert.match(page.card('作品数变化'),/作品数变化0.*两天都有数据 1\/1 个账号/);
 assert.match(page.card('估算播放变化'),/-300.*两天都有数据 1\/1 个账号/);
 assert.doesNotMatch(page.ledger,/账号数待核/);
 assert.match(page.html,/固定可比 1\/1 账号/);
 assert.match(page.html,/查看本区间的原始端点与采样时间/);
 assert.deepEqual(records,original);
});

test('one missing metric or endpoint does not borrow another metric or a historical date for coverage',()=>{
 const records=[point('2026-11-01',100,200,10),point(start,10,20,null),point(end,12,null,0)],page=render(records);
 assert.match(page.card('主页获赞总数'),/主页获赞总数—有数据 0\/1 个账号/);
 assert.match(page.card('主页获赞变化'),/主页获赞变化—.*两天都有数据 0\/1 个账号/);
 assert.match(page.card('估算播放变化'),/估算播放变化（非实测）—.*两天都有数据 0\/1 个账号/);
 assert.match(page.card('作品总数'),/作品总数0有数据 1\/1 个账号/);
 assert.match(page.card('作品数变化'),/作品数变化—.*两天都有数据 0\/1 个账号/);
 assert.match(page.card('粉丝变化'),/粉丝变化\+2.*两天都有数据 1\/1 个账号/);
 assert.equal(growthSeries([account],records,{start,end,metric:'likes'}).cohortCount,0);
});

test('history outside the selected end date and absent histories stay missing rather than carrying forward stale stock',()=>{
 for(const records of [[point(start,10,20,4)],[]]){
  const page=render(records);
  for(const label of ['粉丝总数','主页获赞总数','作品总数'])assert.match(page.card(label),/—有数据 0\/1 个账号/);
  for(const label of ['粉丝变化','主页获赞变化','作品数变化'])assert.match(page.card(label),/—.*两天都有数据 0\/1 个账号/);
  assert.match(page.html,/固定可比 0\/1 账号/);
  assert.doesNotMatch(page.ledger,/账号数待核/);
 }
});

test('current observation without a baseline is known stock but not a comparable change; a same-day zero is observed',()=>{
 const records=[point(end,0,0,0)],page=render(records);
 for(const label of ['粉丝总数','主页获赞总数','作品总数'])assert.match(page.card(label),/0有数据 1\/1 个账号/);
 for(const label of ['粉丝变化','主页获赞变化','作品数变化'])assert.match(page.card(label),/—.*两天都有数据 0\/1 个账号/);
 const sameDay=render(records,{start:end,end});
 assert.match(sameDay.card('粉丝变化'),/粉丝变化0.*两天都有数据 1\/1 个账号/);
});
