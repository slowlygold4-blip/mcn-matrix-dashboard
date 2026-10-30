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
 assert.deepEqual(projectCollectionPlatforms({}),{rolling:null,daily:null});
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
