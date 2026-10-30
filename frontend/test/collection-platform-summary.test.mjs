import test from 'node:test';import assert from 'node:assert/strict';
import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
const root=fileURLToPath(new URL('../',import.meta.url));
const result=await build({entryPoints:[root+'components/collection-platform-summary.tsx'],absWorkingDir:root,bundle:true,write:false,platform:'node',format:'cjs',packages:'external',tsconfig:root+'tsconfig.json'});
const mod={exports:{}};Function('require','module','exports',result.outputFiles[0].text)(createRequire(import.meta.url),mod,mod.exports);
const {CollectionPlatformSummary}=mod.exports;
test('actual summary shows Douyin no observations and Bilibili success as separate platform rows',()=>{
 const observedAt='2026-10-30T04:00:00.000Z',status={observedAt,rolling:{platforms:[
 {platform:'douyin',accounts:10,profiles:10,worksComplete:0,worksLimited:0,workIssues:10},
 {platform:'bilibili',accounts:1,profiles:1,worksComplete:0,worksLimited:1,workIssues:0}]},
 dailyWorkLikes:{date:'2026-10-30',since:'2026-10-29T16:00:00.000Z',asOf:observedAt,basis:'stored-work-like-observations',platforms:[
 {platform:'douyin',storedWorks:100,observedWorks:0,observedAccounts:0},{platform:'bilibili',storedWorks:20,observedWorks:3,observedAccounts:1}]}};
 const html=renderToStaticMarkup(React.createElement(CollectionPlatformSummary,{status}));
 const douyin=html.slice(html.indexOf('data-platform="douyin"'),html.indexOf('data-platform="bilibili"'));
 assert.match(douyin,/今日尚无作品点赞观测/);assert.match(douyin,/negative/);assert.doesNotMatch(douyin,/<b>3<\/b>/);
 assert.match(html,/B站/);assert.match(html,/其他平台的成功不会计为抖音成功/);assert.match(html,/0条观测不等于没有发布/);
});
test('legacy summary never substitutes an old global work count for platform-specific evidence',()=>{
 const html=renderToStaticMarkup(React.createElement(CollectionPlatformSummary,{status:{rolling:{worksLimited:999}}}));
 assert.match(html,/尚未上报/);assert.doesNotMatch(html,/999/);assert.doesNotMatch(html,/data-platform/);
});
test('rendered progress distinguishes successful like storage from computable daily changes',()=>{
 const observedAt='2026-10-30T04:00:00.000Z',status={observedAt,rolling:{platforms:[{platform:'douyin',accounts:1,profiles:1,worksComplete:0,worksLimited:1,workIssues:0}]},
 dailyWorkLikes:{date:'2026-10-30',since:'2026-10-29T16:00:00.000Z',asOf:observedAt,basis:'stored-work-like-observations',platforms:[{platform:'douyin',storedWorks:10,observedWorks:7,observedAccounts:1}],comparability:{version:1,previousDate:'2026-10-29',platforms:[{platform:'douyin',knownTodayWorks:6,comparableWorks:2,missingBaselineWorks:4,conflictingWorks:1}]}}};
 const html=renderToStaticMarkup(React.createElement(CollectionPlatformSummary,{status}));assert.match(html,/点赞日变化可计算 <b>2<\/b> 条/);assert.match(html,/缺有效前日基线 4 条/);assert.match(html,/当日末次观测冲突 1 条/);assert.match(html,/缺基线或冲突不计为0/);
 delete status.dailyWorkLikes.comparability;const old=renderToStaticMarkup(React.createElement(CollectionPlatformSummary,{status}));assert.match(old,/可比覆盖尚未上报/);assert.doesNotMatch(old,/可计算 <b>0/);
});
