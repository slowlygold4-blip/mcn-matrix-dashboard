import test from 'node:test';
import assert from 'node:assert/strict';
import {douyinBrowserDisabled} from '../lib/douyin-browser-policy.mjs';
import {PublicWebProvider} from '../lib/providers/public-web.mjs';

test('browser policy recognizes explicit deployment disable values only',()=>{
 for(const value of ['1','true','on',' TRUE '])assert.equal(douyinBrowserDisabled({DOUYIN_BROWSER_DISABLED:value}),true);
 for(const value of [undefined,'','0','false','off'])assert.equal(douyinBrowserDisabled({DOUYIN_BROWSER_DISABLED:value}),false);
});
function disabled(t){
 const previous=process.env.DOUYIN_BROWSER_DISABLED;process.env.DOUYIN_BROWSER_DISABLED='1';
 t.after(()=>{if(previous===undefined)delete process.env.DOUYIN_BROWSER_DISABLED;else process.env.DOUYIN_BROWSER_DISABLED=previous;});
 let executions=0;
 const provider=new PublicWebProvider({}, {accountBrowserFallback:true,authorResolverMode:'browser-first',
  topicResolverMode:'browser-first',authorisedDetailEnabled:true,workAuthorCandidateEnabled:true,
  topicBrowserBatch:new Map([['offline',{}]]),execFileImpl:()=>{executions++;throw Error('unexpected process');}});
 return {provider,executions:()=>executions};
}
test('deployment opt-out overrides every legacy browser opt-in',t=>{
 const {provider:p}=disabled(t);assert.equal(p.browserDisabled,true);assert.equal(p.accountBrowserFallback,false);
 assert.equal(p.authorResolverMode,'signed-only');assert.equal(p.topicResolverMode,'public');
 assert.equal(p.authorisedDetailEnabled,false);assert.equal(p.workAuthorCandidateEnabled,false);assert.equal(p.topicBrowserBatch,null);
});
test('direct browser methods reject before spawning, parsing targets or loading sessions',async t=>{
 const {provider:p,executions}=disabled(t);
 await assert.rejects(p.runBrowserWorks({}),{code:'DOUYIN_BROWSER_DISABLED'});
 await assert.rejects(p.runTopicBrowser(['offline']),{code:'DOUYIN_BROWSER_DISABLED'});
 await assert.rejects(p.collectWorksOnly(null,null),{code:'WORKS_ONLY_DISABLED'});
 await assert.rejects(p.resolveAuthorisedDetail({}),{code:'AUTHORISED_DETAIL_DISABLED'});
 await assert.rejects(p.resolveWorkAuthorCandidate({}),{code:'WORK_AUTHOR_CANDIDATE_DISABLED'});
 await assert.rejects(p.searchPublicId({}),/尚未启用/);assert.equal(executions(),0);
});
test('ordinary author resolution retains the non-browser HTTP collector path',async t=>{
 const {provider:p,executions}=disabled(t);const modes=[];
 p.run=async(mode,args,input)=>{modes.push(mode);return {items:[{key:'offline',candidates:[],errors:[]}]};};
 const result=await p.resolveDouyinAuthors([{key:'offline',name:'offline'}]);
 assert.deepEqual(modes,['resolve-authors']);assert.equal(result.items[0].key,'offline');assert.equal(executions(),0);
});
