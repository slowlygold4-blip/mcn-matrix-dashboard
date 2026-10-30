import test from 'node:test';import assert from 'node:assert/strict';
import {projectCollectionPlatforms} from '../lib/collection-platform-view.mjs';
import {safeProgress} from '../lib/collection-control.mjs';
const at='2026-10-30T04:00:00.000Z';
const make=()=>({observedAt:at,runtimeAI:false,rolling:{platforms:[
 {platform:'douyin',accounts:10,profiles:10,worksComplete:0,worksLimited:0,workIssues:10,raw:'PRIVATE_SENTINEL'},
 {platform:'bilibili',accounts:1,profiles:1,worksComplete:0,worksLimited:1,workIssues:0}]},
 dailyWorkLikes:{date:'2026-10-30',since:'2026-10-29T16:00:00.000Z',asOf:at,basis:'stored-work-like-observations',platforms:[
 {platform:'douyin',storedWorks:100,observedWorks:0,observedAccounts:0,token:'PRIVATE_SENTINEL'},
 {platform:'bilibili',storedWorks:20,observedWorks:3,observedAccounts:1}]}});
test('platform evidence survives relay whitelisting and cannot pool another platform success',()=>{
 const x=make(),safe=safeProgress(x),p=projectCollectionPlatforms(safe);
 assert.equal(p.rolling[0].worksLimited,0);assert.equal(p.rolling[1].worksLimited,1);
 assert.equal(p.daily.platforms[0].observedWorks,0);assert.equal(p.daily.platforms[1].observedWorks,3);
 assert.equal(JSON.stringify(safe).includes('PRIVATE_SENTINEL'),false);
 assert.deepEqual(p,projectCollectionPlatforms(x));
});
test('legacy or invalid platform totals remain unavailable rather than zeros',()=>{
 assert.deepEqual(projectCollectionPlatforms({}),{rolling:null,daily:null,dailyProfiles:null});
 for(const patch of [{platform:'PRIVATE_SENTINEL'},{profiles:11},{worksLimited:11},{accounts:-1},{profiles:'10'},{profiles:null}]){
  const x=make();Object.assign(x.rolling.platforms[0],patch);assert.equal(projectCollectionPlatforms(x).rolling,null);
 }
 const dup=make();dup.rolling.platforms.push(dup.rolling.platforms[0]);assert.equal(projectCollectionPlatforms(dup).rolling,null);
});
test('daily data is bound to exact telemetry generation, Beijing day and its platform denominators',()=>{
 for(const patch of [{asOf:'2026-10-29T04:00:00.000Z'},{date:'2026-10-29'},
  {since:'2026-10-30T00:00:00.000Z'},{basis:'platform-complete'},{platforms:[]}]){
  const x=make();Object.assign(x.dailyWorkLikes,patch);assert.equal(projectCollectionPlatforms(x).daily,null);
 }
 for(const patch of [{observedWorks:101},{observedAccounts:11},{observedWorks:-1},{storedWorks:null}]){
  const x=make();Object.assign(x.dailyWorkLikes.platforms[0],patch);assert.equal(projectCollectionPlatforms(x).daily,null);
 }
 const dup=make();dup.dailyWorkLikes.platforms.push(dup.dailyWorkLikes.platforms[0]);assert.equal(projectCollectionPlatforms(dup).daily,null);
});
test('daily change readiness survives the actual safe relay with no private details',()=>{
 const x=make();x.dailyWorkLikes.comparability={version:1,previousDate:'2026-10-29',secret:'PRIVATE_SENTINEL',platforms:[
  {platform:'douyin',knownTodayWorks:0,comparableWorks:0,missingBaselineWorks:0,conflictingWorks:0},
  {platform:'bilibili',knownTodayWorks:3,comparableWorks:1,missingBaselineWorks:2,conflictingWorks:0,token:'PRIVATE_SENTINEL'}]};
 const projected=projectCollectionPlatforms(x);assert.equal(projected.daily.comparability.platforms[1].comparableWorks,1);
 const safe=safeProgress(x);assert.deepEqual(projectCollectionPlatforms(safe),projected);assert.equal(JSON.stringify(safe).includes('PRIVATE_SENTINEL'),false);
});
test('bad baselines, counterfeit completion and conflicting work denominators are unavailable rather than zero',()=>{
 const makeChange=()=>{const x=make();x.dailyWorkLikes.comparability={version:1,previousDate:'2026-10-29',platforms:[
  {platform:'douyin',knownTodayWorks:0,comparableWorks:0,missingBaselineWorks:0,conflictingWorks:0},
  {platform:'bilibili',knownTodayWorks:3,comparableWorks:1,missingBaselineWorks:2,conflictingWorks:0}]};return x;};
 for(const patch of [{version:2},{previousDate:'2026-10-28'},{platforms:[]}]){const x=makeChange();Object.assign(x.dailyWorkLikes.comparability,patch);assert.equal(projectCollectionPlatforms(x).daily.comparability,undefined);}
 for(const patch of [{knownTodayWorks:4},{comparableWorks:4},{missingBaselineWorks:-1},{comparableWorks:'1'},{conflictingWorks:18}]){const x=makeChange();Object.assign(x.dailyWorkLikes.comparability.platforms[1],patch);assert.equal(projectCollectionPlatforms(x).daily.comparability,undefined);}
});

function profiles(){
 const x=make(),metric=(observed,comparable)=>({observed,comparable,missingBaseline:observed-comparable,conflicting:0,token:'PRIVATE_SENTINEL'});
 x.dailyProfiles={version:1,basis:'accepted-profile-day-ends',date:'2026-10-30',since:'2026-10-29T16:00:00.000Z',previousDate:'2026-10-29',asOf:at,secret:'PRIVATE_SENTINEL',platforms:[
  {platform:'douyin',accounts:10,followers:metric(2,1),totalLikes:metric(1,0),private:'PRIVATE_SENTINEL'},
  {platform:'bilibili',accounts:1,followers:metric(0,0),totalLikes:metric(0,0)}]};return x;
}
test('current daily profile counters survive safe relay independently of 24h success and strip nested private fields',()=>{
 const x=profiles(),safe=safeProgress(x),p=projectCollectionPlatforms(safe);
 assert.equal(p.rolling[0].profiles,10);assert.equal(p.dailyProfiles.platforms[0].followers.observed,2);
 assert.equal(p.dailyProfiles.platforms[1].followers.observed,0);assert.equal(p.dailyProfiles.platforms[0].totalLikes.comparable,0);
 assert.deepEqual(p,projectCollectionPlatforms(x));assert.equal(JSON.stringify(safe).includes('PRIVATE_SENTINEL'),false);
});
test('stale dates, false denominators, missing counters and inconsistent comparability cannot become daily progress',()=>{
 for(const patch of [{version:2},{asOf:'2026-10-29T04:00:00.000Z'},{date:'2026-10-29'},
  {since:'2026-10-30T00:00:00.000Z'},{previousDate:'2026-10-28'},{basis:'complete'},{platforms:[]}]){
  const x=profiles();Object.assign(x.dailyProfiles,patch);assert.equal(projectCollectionPlatforms(x).dailyProfiles,null);
 }
 for(const patch of [{accounts:9},{platform:'private'},{followers:null},
  {followers:{observed:2,comparable:2,missingBaseline:1,conflicting:0}},
  {followers:{observed:10,comparable:9,missingBaseline:1,conflicting:1}},
  {followers:{observed:'2',comparable:1,missingBaseline:1,conflicting:0}}]){
  const x=profiles();Object.assign(x.dailyProfiles.platforms[0],patch);assert.equal(projectCollectionPlatforms(x).dailyProfiles,null);
 }
 const duplicate=profiles();duplicate.dailyProfiles.platforms.push(duplicate.dailyProfiles.platforms[0]);assert.equal(projectCollectionPlatforms(duplicate).dailyProfiles,null);
});
