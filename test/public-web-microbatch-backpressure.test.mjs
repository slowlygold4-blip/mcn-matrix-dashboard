import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicWebProvider} from '../lib/providers/public-web.mjs';
test('three distinct refusals survive one-account provider boundaries without touching profile transport',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-29T00:00:00.000Z')});const database={};
 const make=()=>new PublicWebProvider({}, {database,accountBrowserFallback:false});
 for(const key of ['a','b','c'])make().worksRequestPolicy.record('anonymous-http',{targetKey:key,errorCode:'blocked'});
 const provider=make(),wait=provider.worksRequestPolicy.decision('anonymous-http');
 assert.equal(wait.deferred,true);assert.equal(wait.errorCode,'blocked');assert.equal(wait.nextEligibleAt,'2026-10-29T00:15:00.000Z');
 const sec='MS4wLjABAAAAMicrobatchHttpFixture12345';let calls=0;
 provider.run=async(mode,args)=>{calls++;assert.equal(mode,'account');assert.deepEqual(args.slice(-2),['--works-mode','deferred']);
  return {capturedAt:new Date().toISOString(),profile:{user:{sec_uid:sec,uid:'12345678',follower_count:12,total_favorited:34,aweme_count:2}},
   worksCoverage:'unavailable',worksErrorCode:'deferred',works:{aweme_list:[],has_more:null},warnings:[]};};
 const collected=await provider.collectAccount({id:1,type:'account',provider:'public-web',locator:sec,metadata:{platform:'douyin'}});
 assert.equal(calls,1);assert.equal(collected.snapshot.followers,12);assert.equal(collected.snapshot.totalLikes,34);assert.equal(collected.posts.length,0);
 t.mock.timers.tick(15*60*1000);assert.equal(make().worksRequestPolicy.decision('anonymous-http').deferred,false);
});
test('repeated refusals for one account do not falsely close a shared endpoint',()=>{
 const database={};for(let i=0;i<5;i++)new PublicWebProvider({}, {database}).worksRequestPolicy.record('anonymous-http',{targetKey:'one',errorCode:'blocked'});
 assert.equal(new PublicWebProvider({}, {database}).worksRequestPolicy.decision('anonymous-http').deferred,false);
});
test('database stores and explicit custom policy clocks are isolated',()=>{
 const a={},b={};const first=new PublicWebProvider({}, {database:a}),second=new PublicWebProvider({}, {database:b});
 assert.notEqual(first.worksRequestPolicy,second.worksRequestPolicy);
 assert.notEqual(first.worksRequestPolicy,new PublicWebProvider({}, {database:a,worksRequestPolicyOptions:{now:()=>1}}).worksRequestPolicy);
});
