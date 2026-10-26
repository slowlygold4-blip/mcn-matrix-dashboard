import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { collectOne, normalizeBrowserCollectorInput } from '../scripts/douyin_browser_collector.mjs';
const SEC='MS4wLjABAAAAPhase92OwnerAccount123456';
const PROFILE=`https://www.douyin.com/user/${SEC}`;
const endpoint=cursor=>`https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${SEC}&max_cursor=${cursor}`;
const flush=async()=>{for(let i=0;i<80;i++) await Promise.resolve();};
class Page extends EventEmitter {
  constructor(config={}) {super();this.config=config;this.address='about:blank';this.frame={url:()=>this.address};this.gets=[];this.handles=[];this.reads=0;
    this.mouse={move:async()=>{},wheel:async()=>{}};}
  mainFrame(){return this.frame;} url(){return this.address;}
  request(url,navigation=false){return{url:()=>url,isNavigationRequest:()=>navigation,frame:()=>this.frame,method:()=> 'GET',resourceType:()=>navigation?'document':'fetch',redirectedFrom:()=>null};}
  async goto(){const req=this.request(PROFILE,true);this.emit('request',req);this.address=PROFILE;
    this.document={readyState:'interactive',body:{childElementCount:1},querySelectorAll:()=>[]};
    this.emit('response',{request:()=>req,url:req.url,status:()=>200});this.emit('framenavigated',this.frame);}
  deliver(cursor,status=200,code=0,delay=0){const req=this.request(endpoint(cursor));this.emit('request',req);
    this.emit('response',{request:()=>req,url:req.url,status:()=>status,json:async()=>{this.reads++;if(delay)await new Promise(resolve=>setTimeout(resolve,delay));return{status_code:code,has_more:false,max_cursor:0,
      aweme_list:[{aweme_id:'7200000000000000092',author:{sec_uid:SEC,uid:'12345678'},statistics:{digg_count:92}}]};}});}
  async evaluateHandle(){const handle={value:this.document,disposed:false,async dispose(){this.disposed=true;}};this.handles.push(handle);this.config.beforeHandle?.();return handle;}
  async evaluate(fn,args){if(fn.name==='observeBrowserFirstScreen')return{observation:'observed',readyState:'interactive',bodyPresent:true};
    if(fn.name==='readTerminalStructure')return{readyState:'interactive',bodyPresent:true,bodyChildCount:1,scriptCount:0};
    if(fn.name==='observeFirstPageActivation')return{eligible:false,reason:'list-not-found'};
    assert.equal(fn.name,'requestBrowserFirstPage');
    args={...args,expectedDocument:args.expectedDocument?.value};
    return vm.runInNewContext(`(${fn.toString()})(args)`,{args,URL,URLSearchParams,Date,AbortController,setTimeout,clearTimeout,
      document:this.document,location:new URL(this.address),getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'}),
      window:{innerWidth:1280,innerHeight:720,fetch:(url,init)=>{assert.equal(init.redirect,'error');assert.equal(init.credentials,'same-origin');
        const cursor=Number(new URL(url,this.address).searchParams.get('max_cursor'));this.gets.push({cursor,at:Date.now()});
        if(this.config.racingHead)this.deliver(0,this.config.racingHead.status??200,this.config.racingHead.code??0,this.config.racingHead.delay??0);
        this.deliver(cursor,this.config.status??200,this.config.code??0);return Promise.resolve({});}}});}
}
async function run(t,config={},events={}){t.mock.timers.enable({apis:['Date','setTimeout'],now:0});const page=new Page(config);let done=false;
  const promise=collectOne(page,{key:'92',secUid:SEC,limit:30,startCursor:123},{timeoutMs:45000,signal:config.signal});
  promise.then(()=>{done=true;});await flush();for(let time=100;!done&&time<=45000;time+=100){t.mock.timers.tick(100);events[time]?.(page);await flush();}
  assert.equal(done,true);const result=await promise;assert.ok(Date.now()<=45000);
  for(const name of ['request','response','framenavigated','requestfailed','pageerror'])assert.equal(page.listenerCount(name),0);
  assert.ok(page.handles.every(h=>h.disposed));return{page,result};}

test('actual collector continuation transports trusted positive cursor after full natural window and keeps limited evidence',async t=>{
  const {page,result}=await run(t);assert.deepEqual(page.gets,[{cursor:123,at:25000}]);assert.equal(result.status,'ok');
  assert.equal(result.pagination.version,3);assert.equal(result.pagination.startCursor,123);assert.equal(result.pagination.pages[0].requestCursor,123);
  assert.notEqual(result.worksCoverage,'complete');assert.equal(result.posts.length,1);
});
test('actual collector continuation retains HTTP and business refusal barriers',async t=>{
  for(const config of [{status:403},{code:2483}]) await t.test(JSON.stringify(config),async child=>{
    const {page,result}=await run(child,config);assert.equal(page.gets.length,1);assert.equal(result.status,'unavailable');assert.equal(result.posts.length,0);
  });
});
test('natural cursor0 explicitly abandons this continuation and preserves original independent head success',async t=>{
  const {page,result}=await run(t,{}, {24000:p=>p.deliver(0)});assert.equal(page.gets.length,0);assert.equal(page.reads,1);assert.equal(result.status,'ok');
  assert.equal(result.continuationReset,'natural-head');assert.equal(result.pagination.version,1);
  assert.equal(result.pagination.pages[0].requestCursor,0);assert.equal(result.posts.length,1);
});
test('natural head refusal after abandoning checkpoint still forbids continuation and data',async t=>{
  const {page,result}=await run(t,{}, {24000:p=>p.deliver(0,403)});assert.equal(page.gets.length,0);assert.equal(page.reads,0);assert.equal(result.status,'unavailable');
  assert.equal(result.errorCode,'blocked');
});
test('natural head refusal after continuation dispatch still prevents a later positive cursor response',async t=>{
  for(const racingHead of [{status:403},{code:2483},{code:2483,delay:500}])await t.test(JSON.stringify(racingHead),async child=>{
    const {page,result}=await run(child,{racingHead});assert.equal(page.gets.length,1);assert.equal(result.status,'unavailable');assert.equal(result.posts.length,0);
    assert.equal(result.errorCode,racingHead.status?'blocked':'login_required');
  });
});
test('racing natural head success contributes no rows to the nonzero current chain',async t=>{
  const {page,result}=await run(t,{racingHead:{}});assert.equal(page.gets.length,1);assert.equal(result.status,'ok');
  assert.equal(result.posts.length,1);assert.equal(result.pagination.pages.length,1);assert.equal(result.pagination.pages[0].requestCursor,123);
});
test('pending natural refusal at the absolute deadline cannot become success via faster continuation',async t=>{
  for(const delay of [20000,21000])await t.test(String(delay),async child=>{
    const {page,result}=await run(child,{racingHead:{code:2483,delay}});assert.equal(page.gets.length,1);
    assert.equal(result.status,'unavailable');assert.equal(result.posts.length,0);assert.ok(Date.now()<=45000);
  });
});
test('cancel before continuation dispatch prevents request',async t=>{
  const controller=new AbortController();const {page,result}=await run(t,{signal:controller.signal,beforeHandle:()=>controller.abort()});
  assert.equal(page.gets.length,0);assert.equal(result.status,'unavailable');
});
test('collector input strictly bounds continuation cursor without a signed URL or source injection',()=>{
  for(const startCursor of [-1,1.5,'123',Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>normalizeBrowserCollectorInput({items:[{secUid:SEC,startCursor}]}));
  assert.deepEqual(normalizeBrowserCollectorInput({items:[{key:'92',secUid:SEC,limit:30,startCursor:123,headers:{Cookie:'secret'}}]}),[{key:'92',secUid:SEC,limit:30,startCursor:123}]);
});
