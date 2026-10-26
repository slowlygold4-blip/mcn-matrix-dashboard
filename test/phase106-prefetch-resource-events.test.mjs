import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
const { collectOne } = await import(process.env.PHASE106_COLLECTOR_FILE ? pathToFileURL(process.env.PHASE106_COLLECTOR_FILE).href : '../scripts/douyin_browser_collector.mjs');
const SEC='MS4wLjABAAAAPhase106RealEventBoundary', profile=`https://www.douyin.com/user/${SEC}`;
const url=cursor=>`https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${SEC}&max_cursor=${cursor}`;
const body=(id,next=100,more=true)=>({status_code:0,aweme_list:[{aweme_id:String(7300000000000000000n+BigInt(id)),author:{sec_uid:SEC},statistics:{digg_count:id}}],max_cursor:next,has_more:more});
class Page extends EventEmitter {
  constructor(scenario){super();this.scenario=scenario;this.current='about:blank';this.frame={url:()=>this.current};this.reads=[];this.actions=[];this.mouse={move:async()=>this.actions.push('move'),wheel:async()=>this.actions.push('wheel')};}
  url(){return this.current;}mainFrame(){return this.frame;}
  request(value,nav=false){return{url:()=>value,frame:()=>this.frame,method:()=> 'GET',isNavigationRequest:()=>nav,resourceType:()=>nav?'document':'fetch',redirectedFrom:()=>null};}
  response(request,json,label,status=200){this.emit('response',{request:()=>request,url:request.url,status:()=>status,json:()=>{this.reads.push(label);return json();}});}
  async goto(value){const document=this.request(value,true);this.emit('request',document);this.current=value;this.emit('framenavigated',this.frame);this.response(document,async()=>({}),'document');await this.scenario(this);}
}
async function sample({finish='before',duplicate=false,orphan=false,status=200,cancel=false,challenge=false,navigate=false}={}) {
  let resolve;const predecessor=new Promise(r=>resolve=r),controller=new AbortController();
  const page=new Page(async p=>{
    const head=p.request(url(0));p.emit('request',head);p.response(head,()=>predecessor,'head');
    const future=p.request(url(100));p.emit('request',future);p.response(future,async()=>body(2,0,false),'future',status);
    if(finish==='before')p.emit('requestfinished',future);
    if(duplicate)p.response(future,async()=>body(9,0,false),'duplicate',status);
    if(orphan)p.response(p.request(url(900)),async()=>body(8,0,false),'orphan');
    for(let i=0;i<10;i++)await Promise.resolve();assert.deepEqual(p.reads,['head'],'no provisional body read before predecessor confirmation');
    if(cancel)controller.abort();
    if(navigate){const next=p.request(profile,true);p.emit('request',next);p.emit('framenavigated',p.frame);const newHead=p.request(url(0));p.emit('request',newHead);p.response(newHead,async()=>body(3,0,false),'new-head');}
    resolve(challenge?{...body(1),captcha_required:true}:body(1));
    for(let i=0;i<30;i++)await Promise.resolve();
    if(finish==='after')p.emit('requestfinished',future);
  });
  const result=await collectOne(page,{key:'phase106',secUid:SEC,limit:30},{timeoutMs:250,bodyTimeoutMs:120,pageWaitMs:30,signal:controller.signal});
  assert.deepEqual(page.actions,[]);assert.deepEqual(page.eventNames(),[],'all attempt listeners removed');
  const frozen=JSON.stringify(result);await Promise.resolve();assert.equal(JSON.stringify(result),frozen,'late microtasks do not mutate returned evidence');
  return {result,reads:page.reads,resource:result.failureDiagnostics.resourceObservation};
}
for(const finish of ['before','after','never'])test(`internal promotion is not another response event (${finish} requestfinished)`,async()=>{
  const {result,reads,resource}=await sample({finish});
  assert.equal(result.posts.length,2);assert.deepEqual(reads,['head','future']);assert.equal(result.pagination.stopReason,'end-of-list');
  assert.equal(resource.discarded.untrackedEvents,0,'a replay is not a real untracked browser event');
  assert.deepEqual(resource.resources.fetch.statusCounts,[{status:200,count:2}]);
  assert.equal(resource.resources.fetch.requested,2);assert.equal(resource.resources.fetch.finished,finish==='never'?0:1);
});
test('real duplicate response after finish still counts exactly once; internal promotion never hides or adds events',async()=>{
  const {result,reads,resource}=await sample({duplicate:true});assert.equal(result.posts.length,2);assert.deepEqual(reads,['head','future']);
  assert.equal(resource.discarded.untrackedEvents,1);assert.deepEqual(resource.resources.fetch.statusCounts,[{status:200,count:2}]);
});
test('a genuine untracked response remains diagnosed independently of a legitimate promotion',async()=>{
  const {result,reads,resource}=await sample({orphan:true});assert.equal(result.posts.length,2);assert.deepEqual(reads,['head','future']);assert.equal(resource.discarded.untrackedEvents,1);
});
for(const status of [401,403,429])test(`finished provisional ${status} retains refusal classification without passive replay`,async()=>{
  const {result,reads,resource}=await sample({status});assert.deepEqual(reads,['head']);assert.equal(result.posts.length,1);
  assert.equal(result.errorCode,{401:'login_required',403:'blocked',429:'rate_limited'}[status]);assert.equal(result.pagination.stopReason,'http-rejection');
  assert.equal(resource.discarded.untrackedEvents,0);assert.deepEqual(resource.resources.fetch.statusCounts,[{status:200,count:1},{status,count:1}]);
});
for(const reason of ['cancel','challenge','navigate'])test(`retired provisional response does not get a body or synthetic event after ${reason}`,async()=>{
  const {result,reads,resource}=await sample({[reason]:true});assert.ok(!reads.includes('future'));assert.equal(resource.discarded.untrackedEvents,0);
  if(reason==='navigate'){assert.deepEqual(reads,['head','new-head']);assert.deepEqual(result.posts.map(p=>p.aweme_id),[String(7300000000000000003n)]);}
  else{assert.equal(result.status,'unavailable');assert.equal(result.posts.length,0);}
});
