import test from 'node:test';
import assert from 'node:assert/strict';
import{requireHostedRunner,readPublicResponse}from'../scripts/ci/remote-public-work-smoke.mjs';
const SEC='MS4wLjABAAAAPublicSmokeFixture12345',ID='7300000000000000001',AT='2026-11-02T15:00:00.000Z';
const item=()=>({aweme_id:ID,create_time:1793610000,author:{sec_uid:SEC},statistics:{digg_count:0,play_count:987654}});
test('cannot launch on this Mac or a self-hosted machine even with CI environment flags',()=>{
 const env={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'slowlygold4-blip/mcn-matrix-dashboard'};
 assert.throws(()=>requireHostedRunner(env,'darwin'),{code:'hosted-runner-required'});
 assert.throws(()=>requireHostedRunner({...env,RUNNER_ENVIRONMENT:'self-hosted'},'linux'),{code:'hosted-runner-required'});
 assert.doesNotThrow(()=>requireHostedRunner(env,'linux'));
});
test('exact public work ID, real zero and publication time are required; plays stay unknown',()=>{
 const p=readPublicResponse({status_code:0,aweme_detail:item()},{kind:'detail',contentId:ID,observedAt:AT});
 assert.equal(p.contentId,ID);assert.equal(p.likes,0);assert.equal(p.plays,null);assert.ok(p.publishedAt<AT);
 assert.equal(readPublicResponse({status_code:0,aweme_detail:item()},{kind:'detail',contentId:'7300000000000000002',observedAt:AT}),null);
 const noStats=item();delete noStats.statistics;
 assert.equal(readPublicResponse({status_code:0,aweme_detail:noStats},{kind:'detail',contentId:ID,observedAt:AT}),null);
 assert.throws(()=>readPublicResponse({status_code:0,aweme_detail:item()},{kind:'detail',contentId:ID,observedAt:'invalid'}));
 const privateWork=item();privateWork.status={private_status:1};
 assert.equal(readPublicResponse({status_code:0,aweme_detail:privateWork},{kind:'detail',contentId:ID,observedAt:AT}),null);
});
test('HTTP200 refusal flags and missing pagination cannot become a successful list',()=>{
 for(const body of [{status_code:0,need_login:true,aweme_list:[item()],has_more:0},{status_code:0,aweme_list:[item()]}]){
  assert.throws(()=>readPublicResponse(body,{kind:'list',secUid:SEC,observedAt:AT}));
 }
});
test('foreign authors and conflicting duplicates reject a page; first-page success never proves all-author coverage',()=>{
 const args={kind:'list',secUid:SEC,observedAt:AT};const one=item();
 assert.throws(()=>readPublicResponse({status_code:0,aweme_list:[{...one,author:{sec_uid:SEC+'foreign'}}],has_more:0},args));
 assert.throws(()=>readPublicResponse({status_code:0,aweme_list:[one,{...one,statistics:{digg_count:9}}],has_more:0},args));
 const r=readPublicResponse({status_code:0,aweme_list:[one,one],has_more:1},args);
 assert.equal(r.items.length,1);assert.equal(r.hasMore,true);assert.equal(r.completeAuthor,false);
});
