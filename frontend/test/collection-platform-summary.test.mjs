import test from 'node:test';import assert from 'node:assert/strict';
import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
const root=fileURLToPath(new URL('../',import.meta.url));
const result=await build({entryPoints:[root+'components/collection-platform-summary.tsx'],absWorkingDir:root,bundle:true,write:false,platform:'node',format:'cjs',packages:'external',tsconfig:root+'tsconfig.json'});
const mod={exports:{}};Function('require','module','exports',result.outputFiles[0].text)(createRequire(import.meta.url),mod,mod.exports);
const {CollectionPlatformSummary,CollectionDailyNotice,CollectionProfileDailyNotice}=mod.exports;
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

function dailyStatus(){
 const observedAt='2026-10-30T04:00:00.000Z';
 return {observedAt,rolling:{platforms:[{platform:'douyin',accounts:10,profiles:10,worksComplete:0,worksLimited:0,workIssues:10},
  {platform:'bilibili',accounts:1,profiles:1,worksComplete:0,worksLimited:1,workIssues:0}]},
 dailyWorkLikes:{date:'2026-10-30',since:'2026-10-29T16:00:00.000Z',asOf:observedAt,basis:'stored-work-like-observations',platforms:[
  {platform:'douyin',storedWorks:100,observedWorks:0,observedAccounts:0},{platform:'bilibili',storedWorks:20,observedWorks:3,observedAccounts:1}]}};
}
const notice=status=>renderToStaticMarkup(React.createElement(CollectionDailyNotice,{status}));
test('compact notice keeps the Douyin work gap visible despite full profile progress and another platform success',()=>{
 const html=notice(dailyStatus());assert.match(html,/data-state="missing"/);assert.match(html,/2026-10-30 · 抖音尚无作品点赞观测/);
 assert.match(html,/单作品点赞日变化待采样/);assert.doesNotMatch(html,/已保存 3|全部成功|今日/);
});
test('missing or stale-shaped daily evidence stays unknown, and an empty inventory never proves zero publication',()=>{
 assert.match(notice({rolling:{profiles:999}}),/状态尚未上报/);
 const status=dailyStatus();status.dailyWorkLikes.asOf='2026-10-29T04:00:00.000Z';assert.match(notice(status),/data-state="unknown"/);
 const empty=dailyStatus();empty.dailyWorkLikes.platforms.forEach(row=>{row.storedWorks=0;row.observedWorks=0;row.observedAccounts=0;});
 assert.match(notice(empty),/这不代表当日没有发布/);assert.doesNotMatch(notice(empty),/发布0|发布 0/);
});
test('compact notice retains the real observation date and never fabricates missing comparability',()=>{
 const status=dailyStatus();status.dailyWorkLikes.platforms[0].observedWorks=5;status.dailyWorkLikes.platforms[0].observedAccounts=1;
 let html=notice(status);assert.match(html,/2026-10-30 · 已保存 8 条/);assert.match(html,/可比情况尚未上报/);assert.doesNotMatch(html,/0 条可计算|今日/);
 status.dailyWorkLikes.comparability={version:1,previousDate:'2026-10-29',platforms:[
  {platform:'douyin',knownTodayWorks:5,comparableWorks:4,missingBaselineWorks:1,conflictingWorks:0},
  {platform:'bilibili',knownTodayWorks:3,comparableWorks:2,missingBaselineWorks:1,conflictingWorks:0}]};
 html=notice(status);assert.match(html,/6 条可计算日变化/);assert.match(html,/尚不代表完整采集/);
});

test('visible daily profile notice and details use current daily counts rather than rolling profile success',()=>{
 const status=dailyStatus(),metric=(observed,comparable)=>({observed,comparable,missingBaseline:observed-comparable,conflicting:0});
 status.dailyProfiles={version:1,basis:'accepted-profile-day-ends',date:'2026-10-30',since:'2026-10-29T16:00:00.000Z',previousDate:'2026-10-29',asOf:status.observedAt,platforms:[
  {platform:'douyin',accounts:10,followers:metric(2,1),totalLikes:metric(1,0)},
  {platform:'bilibili',accounts:1,followers:metric(0,0),totalLikes:metric(0,0)}]};
 const html=renderToStaticMarkup(React.createElement(CollectionProfileDailyNotice,{status}));
 assert.match(html,/2026-10-30 · 当天账号观测/);assert.match(html,/粉丝 2\/10（1 可比）/);assert.match(html,/总获赞 1\/10（0 可比）/);
 assert.match(html,/B站：粉丝 0\/1/);assert.doesNotMatch(html,/粉丝 10\/10|全部成功/);
 const details=renderToStaticMarkup(React.createElement(CollectionPlatformSummary,{status}));
 assert.match(details,/日变化可比 1 · 缺前日基线 1/);assert.match(details,/当天总获赞观测 1\/10/);
 delete status.dailyProfiles;
 const legacy=renderToStaticMarkup(React.createElement(CollectionProfileDailyNotice,{status}));
 assert.match(legacy,/当天粉丝与总获赞覆盖尚未上报/);assert.doesNotMatch(legacy,/0\/|10\/10/);
});
