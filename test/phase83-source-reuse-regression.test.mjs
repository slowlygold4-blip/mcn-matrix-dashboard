// Independent event-owner negatives. All pages, bodies and clocks are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { collectOne } from '../scripts/douyin_browser_collector.mjs';
const SEC='MS4wLjABAAAAphase83SourceReuseNegative';
const OTHER='MS4wLjABAAAAphase83SourceReuseOther';
const url=sec=>`https://www.douyin.com/user/${sec}`;
const endpoint=(sec=SEC,cursor=0)=>`https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${sec}&max_cursor=${cursor}`;
const drain=async()=>{for(let n=0;n<50;n++)await Promise.resolve();};
const absent={eligible:false,reason:'no-container',structure:{reason:'region-absent',regionCount:0,visibleRegionCount:0,leafRegionCount:0,ancestorCount:null}};
const point={eligible:true,x:400,y:300,deltaY:400,structure:{reason:'eligible',regionCount:1,visibleRegionCount:1,leafRegionCount:1,ancestorCount:2}};
class Page extends EventEmitter{
 constructor(){super();this.address='about:blank';this.frame={url:()=>this.address};this.doc=0;this.region=false;this.moves=0;this.wheels=0;this.reads=0;this.qualifications=[];
  this.mouse={move:async()=>{this.moves++;this.onMove?.();},wheel:async()=>{this.wheels++;this.onWheel?.();}};}
 url(){return this.address;}mainFrame(){return this.frame;}
 request(address,{navigation=false,method='GET',frame=this.frame}={}){return{url:()=>address,isNavigationRequest:()=>navigation,method:()=>method,frame:()=>frame,resourceType:()=>navigation?'document':'fetch',redirectedFrom:()=>null};}
 commit({sec=SEC,status=200,method='GET',region=this.region}={}){this.doc++;this.region=region;const request=this.request(url(sec),{navigation:true,method});this.emit('request',request);this.address=url(sec);this.emit('response',{request:()=>request,url:request.url,status:()=>status});this.emit('framenavigated',this.frame);return request;}
 async goto(){this.commit();}async close(){}
 async evaluate(fn){if(fn.name==='observeBrowserFirstScreen')return{observation:'observed',readyState:'interactive',bodyPresent:true};
  if(fn.name==='readTerminalStructure')return{readyState:'interactive',bodyPresent:true,bodyChildCount:1,scriptCount:1};
  assert.equal(fn.name,'observeFirstPageActivation');const current={doc:this.doc,at:Date.now()};this.qualifications.push(current);
  const answer=this.region?point:absent; if(this.holdQualification?.(current))await new Promise(resolve=>{this.releaseQualification=resolve;});return structuredClone(answer);}
 deliver({request,sec=SEC,cursor=0,status=200,delay=0,responseUrl,bodyAuthor=SEC}={}){const r=request??this.request(endpoint(sec,cursor));if(!request)this.emit('request',r);
  const response={request:()=>r,url:()=>responseUrl??r.url(),status:()=>status,json:async()=>{this.reads++;if(delay)await new Promise(resolve=>setTimeout(resolve,delay));return{status_code:0,has_more:false,max_cursor:0,aweme_list:[{aweme_id:'7234567890123400983',author:{sec_uid:bodyAuthor,uid:'1234567890'},statistics:{digg_count:1}}]};}};
  this.emit('response',response);return{request:r,response};}
}
async function run(t,page,{events={},options={}}={}){
 t.mock.timers.enable({apis:['Date','setTimeout'],now:0});let done=false;
 const task=collectOne(page,{key:'source-reuse-offline',secUid:SEC,limit:30},{timeoutMs:45000,...options});void task.then(()=>done=true);await drain();
 for(let at=50;!done&&at<=46000;at+=50){t.mock.timers.tick(50);events[at]?.(page);await drain();}
 assert.equal(done,true);const result=await task;assert.ok(result.failureDiagnostics.elapsedMs<=45000);
 for(const name of ['request','response','framenavigated','requestfailed','requestfinished','pageerror','domcontentloaded','load'])assert.equal(page.listenerCount(name),0);
 const frozen=JSON.stringify(result);page.releaseQualification?.();page.deliver();t.mock.timers.tick(60000);await drain();assert.equal(JSON.stringify(result),frozen,'late work cannot mutate returned evidence');
 return result;
}

test('phase83 independent: 2xx exactly at response deadline cannot renew or read its body',async t=>{
 const page=new Page();const result=await run(t,page,{events:{25000:p=>p.deliver()}});
 assert.equal(result.status,'unavailable');assert.equal(result.failureDiagnostics.elapsedMs,25000);assert.equal(page.reads,0);
});

for(const [name,args]of [['other-author response URL',{responseUrl:endpoint(OTHER)}],['nonzero response cursor',{responseUrl:endpoint(SEC,99)}]])
 test(`phase83 independent: ${name} for an otherwise bound request cannot extend25`,async t=>{
  const page=new Page();const result=await run(t,page,{events:{24900:p=>p.deliver(args)}});
  assert.equal(result.status,'unavailable');assert.equal(result.failureDiagnostics.elapsedMs,25000);assert.equal(page.reads,0);
 });

test('phase83 independent: duplicate 2xx notification cannot restart a1000ms body deadline',async t=>{
 const page=new Page();let response;
 const result=await run(t,page,{options:{bodyTimeoutMs:1000},events:{24000:p=>{response=p.deliver({delay:2000}).response;},24800:p=>p.emit('response',response)}});
 assert.equal(result.status,'unavailable');assert.equal(page.reads,1);assert.equal(result.failureDiagnostics.responses.bodyTimeouts,1);
 assert.ok(result.failureDiagnostics.elapsedMs<=25550);
});

test('phase83 independent: current403 beats two in-flight successful-looking bodies and no rebind follows',async t=>{
 const page=new Page();const result=await run(t,page,{events:{
  24000:p=>p.deliver({delay:5000}),24500:p=>p.deliver({delay:5000}),25000:p=>p.deliver({status:403}),25100:p=>p.commit({region:true})}});
 assert.equal(result.status,'unavailable');assert.deepEqual(result.posts,[]);assert.equal(result.errorCode,'blocked');assert.equal(page.wheels,0);assert.equal(page.reads,2);
});

test('phase83 independent: document403 at26s retires the extended first-body opportunity',async t=>{
 const page=new Page();const result=await run(t,page,{events:{24000:p=>p.deliver({delay:4000}),26000:p=>p.commit({status:403,region:true})}});
 assert.equal(result.status,'unavailable');assert.deepEqual(result.posts,[]);assert.equal(result.errorCode,'blocked');assert.equal(page.moves,0);
});

test('phase83 independent: nine replacement documents share eight qualifications globally',async t=>{
 const page=new Page(),events={};for(const at of [1500,3000,4500,6000,7500,9000,10500,12000])events[at]=p=>p.commit();events[13500]=p=>p.commit({region:true});
 const result=await run(t,page,{events});assert.equal(result.status,'unavailable');assert.equal(page.qualifications.length,8);assert.equal(page.moves,0);assert.equal(page.wheels,0);
 assert.equal(result.failureDiagnostics.lifecycle.generation,10);
});

test('phase83 independent: rebind cannot authorize a POST replacement document',async t=>{
 const page=new Page();const result=await run(t,page,{events:{1500:p=>p.commit({method:'POST',region:true})}});
 assert.equal(result.status,'unavailable');assert.equal(page.moves,0);assert.equal(page.wheels,0);
});

test('phase83 independent: timed-out old qualification point cannot act after a new document commits',async t=>{
 const page=new Page();page.region=true;page.holdQualification=()=>true;
 const result=await run(t,page,{events:{1500:p=>p.commit({region:true}),2500:p=>p.releaseQualification?.()}});
 assert.equal(result.status,'unavailable');assert.equal(page.moves,0);assert.equal(page.wheels,0);assert.equal(page.qualifications.length,1);
});

test('phase83 independent: expired rebind qualification cannot act when it resolves later in the same document',async t=>{
 const page=new Page();page.holdQualification=({doc})=>doc===2;
 const result=await run(t,page,{events:{1500:p=>p.commit({region:true}),5000:p=>p.releaseQualification?.()}});
 assert.equal(result.status,'unavailable');assert.equal(page.moves,0);assert.equal(page.wheels,0);assert.equal(page.qualifications.length,2);
 assert.equal(result.failureDiagnostics.firstPageActivation.state,'timeout');
});

test('phase83 independent: navigation during move spends the one action and forbids a new wheel',async t=>{
 const page=new Page();page.onMove=()=>page.commit({region:true});
 const result=await run(t,page,{events:{1500:p=>p.commit({region:true})}});
 assert.equal(result.status,'unavailable');assert.equal(page.moves,1);assert.equal(page.wheels,0);
});

test('phase83 independent: repeated valid replacements cannot overrun absolute45 seconds without requests',async t=>{
 const page=new Page();const result=await run(t,page,{events:{24000:p=>p.commit(),44000:p=>p.commit()}});
 assert.equal(result.status,'unavailable');assert.equal(result.failureDiagnostics.elapsedMs,45000);assert.equal(page.reads,0);
});
