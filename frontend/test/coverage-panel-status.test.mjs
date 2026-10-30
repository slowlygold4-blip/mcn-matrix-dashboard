// Real React coverage components and synthetic accounts only. No Site fetch,
// browser, collector, database or publication is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {coverageTotals} from '../lib/replica-coverage.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const bundle=await build({entryPoints:[root+'components/coverage-panel.tsx'],absWorkingDir:root,
 bundle:true,write:false,platform:'node',format:'cjs',packages:'external',tsconfig:root+'tsconfig.json'});
const componentModule={exports:{}};
Function('require','module','exports',bundle.outputFiles[0].text)(createRequire(import.meta.url),componentModule,componentModule.exports);
const {CoveragePanel,AccountCoverage,coverageHeadline}=componentModule.exports;

const asOf='2026-10-24T00:45:25.946Z';
const at=hours=>new Date(Date.parse(asOf)+hours*3600000).toISOString();
const make=(id,status,attemptedAt,observedAt)=>({id,label:'合成账号'+id,enabled:true,
 coverage:{version:1,profileObservedAt:at(-0.5),works:{status,attemptedAt,observedAt}}});
const accounts=[
 make(1,'limited',at(-9),at(-9)),
 make(10,'limited',at(-1),at(-2)),
 make(20,'unavailable',at(-0.5),at(-24)),
 make(30,'missing',null,null),
 make(40,'unavailable',at(-10),at(-24)),
 make(50,'complete',at(-8.9),at(-9)),
 make(60,'complete',at(-0.5),at(-1)),
];
const topics={topics:[],items:[]};
const render=(element)=>renderToStaticMarkup(React.createElement(element.type,element.props));

test('fresh complete, fresh limited and recent unsuccessful attempts remain separate evidence',()=>{
 const before=JSON.stringify(accounts);
 const totals=coverageTotals(accounts,topics,asOf,Date.parse(asOf));
 assert.equal(totals.denominator,7);
 assert.deepEqual([totals.profileFresh,totals.worksComplete,totals.worksLimited,totals.worksUnavailableRecent],[7,1,1,1]);
 assert.deepEqual(totals.statusCounts,{complete:2,limited:2,unavailable:2,missing:1,unknown:0});
 const headline=coverageHeadline(totals);
 assert.match(headline,/主页新数据 7\/7/);
 assert.match(headline,/作品完整核验 1\/7 · 作品有限观察 1\/7 · 最近未取得 1\/7/);
 assert.doesNotMatch(headline,/作品列表采全|已保存作品 0/);
 assert.equal(JSON.stringify(accounts),before,'coverage counting must not reorder or change the catalog');
});

test('real coverage panel prioritizes a recent miss, retains a prior observation, and does not call partial work a nonempty list',()=>{
 const before=JSON.stringify(accounts);
 const html=render({type:CoveragePanel,props:{accounts,topics,asOf,onAccount:()=>{}}});
 assert.match(html,/发布截面 .*作品完整核验 1\/7 · 作品有限观察 1\/7/);
 assert.match(html,/作品不完整不等于没有已保存作品；有限观察也不保证列表非空或平台全集/);
 assert.match(html,/最近尝试 .*最后有效列表观察 .*保留此前观察，不代表本次取得/);
 assert.doesNotMatch(html,/作品列表采全 0\/7|有限观察 2\/7/,'stale limited observations are not recent observations');
 const names=[20,30,40,1,10,50].map(id=>'合成账号'+id);
 const indices=names.map(name=>html.indexOf('查看'+name+'的经营详情'));
 assert.ok(indices.every(index=>index>0));
 assert.deepEqual([...indices].sort((a,b)=>a-b),indices,'the first six gaps follow actionable failure priority, not account ID order');
 assert.equal(html.includes('合成账号60'),false,'fresh complete accounts are not a gap');
 assert.equal(JSON.stringify(accounts),before,'gap ordering must not mutate source account order');
});

test('real account coverage shows last attempt and prior valid observation as different timestamps',()=>{
 const account=accounts.find(row=>row.id===20);
 const html=render({type:AccountCoverage,props:{account,asOf}});
 const attempt=new Date(account.coverage.works.attemptedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
 const observation=new Date(account.coverage.works.observedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
 assert.match(html,/本轮列表未取得/);
 assert.ok(html.includes('最近作品列表尝试 '+attempt));
 assert.ok(html.includes('最后有效列表观察 '+observation));
 assert.match(html,/保留此前观察，不代表本次取得/);
 assert.notEqual(attempt,observation);
});

test('real panel renders an accessible search, all issue filters and 205-page navigation for 4081 gaps',()=>{
 const all=Array.from({length:4081},(_,i)=>make(i+1,'unavailable',at(-0.5),null));
 const html=render({type:CoveragePanel,props:{accounts:all,topics,asOf,onAccount:()=>{}}});
 assert.match(html,/完整性待核 4081 个账号/);
 assert.match(html,/type="search"/);assert.match(html,/查找账号/);assert.match(html,/待核问题/);
 for(const label of ['全部待核问题','主页过时或缺测','作品尚未完整','作品最近尝试未取得','作品尚无有效观察','作品仅有限观察'])assert.ok(html.includes(label));
 assert.match(html,/符合筛选 4081 个 · 显示 1–20 个/);
 assert.match(html,/aria-label="待核账号分页"/);assert.match(html,/aria-label="待核账号页码"/);
 assert.match(html,/<option value="205">205<\/option>/);
 assert.match(html,/disabled=""[^>]*>首页/);assert.match(html,/disabled=""[^>]*>上一页/);
 assert.ok(html.includes('下一页'));assert.ok(html.includes('末页'));
 assert.equal((html.match(/的经营详情/g)||[]).length,20,'bounded rendering, full population paged by the shared helper');
 assert.doesNotMatch(html,/当前显示前|gaps\.slice/);
});
