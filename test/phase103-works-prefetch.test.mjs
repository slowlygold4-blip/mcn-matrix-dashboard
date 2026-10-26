import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { collectOne } from '../scripts/douyin_browser_collector.mjs';
const SEC='MS4wLjABAAAAabcdefghijklmnopqrstuvwx';
const OTHER='MS4wLjABBBBBzyxwvutsrqponmlkjihgfedcba';
const profile=`https://www.douyin.com/user/${SEC}`;
const url=(cursor,sec=SEC)=>`https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${sec}&max_cursor=${cursor}&count=30`;
const body=(id,next,more,sec=SEC)=>({status_code:0,aweme_list:[{aweme_id:String(7200000000000000000n+BigInt(id)),author:{sec_uid:sec},statistics:{digg_count:id}}],max_cursor:next,has_more:more});
class Page extends EventEmitter {
  constructor(scenario){super();this.scenario=scenario;this.current='about:blank';this.frame={url:()=>this.current};this.reads=0;this.mouse={move:async()=>{},wheel:async()=>{}};}
  mainFrame(){return this.frame;}url(){return this.current;}
  req(value,navigation=false){return{url:()=>value,frame:()=>this.frame,method:()=> 'GET',isNavigationRequest:()=>navigation};}
  response(request,json,status=200){this.emit('response',{request:()=>request,url:request.url,status:()=>status,json:()=>{this.reads++;return json();}});}
  async goto(value){const d=this.req(value,true);this.emit('request',d);this.current=value;this.emit('framenavigated',this.frame);this.response(d,async()=>({}));await this.scenario(this);}
}
async function sample({prefetch=false,nextCursor=100,sec=SEC,status=200,headMore=true,headError=false}={}){
  let resolve;const pending=new Promise(r=>resolve=r);
  const page=new Page(async p=>{
    const first=p.req(url(0));p.emit('request',first);p.response(first,()=>pending);
    if(!prefetch){resolve(headError?{status_code:8}:body(1,100,headMore));for(let i=0;i<30;i++)await Promise.resolve();}
    const second=p.req(url(nextCursor,sec));p.emit('request',second);p.response(second,async()=>body(2,0,false,sec),status);
    resolve(headError?{status_code:8}:body(1,100,headMore));
  });
  const result=await collectOne(page,{key:'phase103',secUid:SEC,limit:30},{timeoutMs:300,bodyTimeoutMs:150,pageWaitMs:30});
  for(const event of ['request','response','framenavigated'])assert.equal(page.listenerCount(event),0);
  return{result,reads:page.reads};
}
test('serial current-document cursor chain yields both pages',async()=>{const {result}=await sample();assert.equal(result.posts.length,2);assert.equal(result.pagination.stopReason,'end-of-list');});
test('prefetched exact next cursor must wait for predecessor then retain both pages',async()=>{const {result}=await sample({prefetch:true});assert.equal(result.posts.length,2);assert.equal(result.pagination.stopReason,'end-of-list');});
test('prefetched wrong cursor and other identity remain untrusted',async()=>{for(const args of [{nextCursor:999},{sec:OTHER}]){const {result,reads}=await sample({prefetch:true,...args});assert.equal(reads,1);assert.equal(result.posts.length,1);assert.notEqual(result.pagination.stopReason,'end-of-list');}});
test('no continuation can override predecessor business failure or end-of-list',async()=>{const bad=await sample({prefetch:true,headError:true});assert.equal(bad.reads,1);assert.equal(bad.result.status,'unavailable');assert.equal(bad.result.posts.length,0);const end=await sample({prefetch:true,headMore:false});assert.equal(end.reads,1);assert.equal(end.result.posts.length,1);assert.equal(end.result.pagination.stopReason,'end-of-list');});
test('a promoted exact-cursor 401/403/429 remains a refusal, not success',async()=>{for(const status of [401,403,429]){const {result,reads}=await sample({prefetch:true,status});assert.equal(reads,1);assert.equal(result.posts.length,1);assert.equal(result.errorCode,{401:'login_required',403:'blocked',429:'rate_limited'}[status]);assert.equal(result.pagination.stopReason,'http-rejection');}});
test('predecessor timeout owns original bound; no provisional JSON is read late',async()=>{
  let resolve;const pending=new Promise(r=>resolve=r);const page=new Page(p=>{const a=p.req(url(0));p.emit('request',a);p.response(a,()=>pending);const b=p.req(url(100));p.emit('request',b);p.response(b,async()=>body(2,0,false));});
  const result=await collectOne(page,{key:'phase103',secUid:SEC,limit:30},{timeoutMs:80,bodyTimeoutMs:40,failureGraceMs:1});
  assert.equal(page.reads,1);assert.equal(result.status,'unavailable');const frozen=JSON.stringify(result);resolve(body(1,100,true));for(let i=0;i<30;i++)await Promise.resolve();assert.equal(page.reads,1);assert.equal(JSON.stringify(result),frozen);assert.ok(result.failureDiagnostics.elapsedMs<200);
});
test('replacement navigation retires provisional handles with the predecessor',async()=>{
  let resolve;const pending=new Promise(r=>resolve=r);const page=new Page(p=>{const a=p.req(url(0));p.emit('request',a);p.response(a,()=>pending);const b=p.req(url(100));p.emit('request',b);p.response(b,async()=>body(2,0,false));const n=p.req(profile,true);p.emit('request',n);p.emit('framenavigated',p.frame);const c=p.req(url(0));p.emit('request',c);p.response(c,async()=>body(3,0,false));resolve(body(1,100,true));});
  const result=await collectOne(page,{key:'phase103',secUid:SEC,limit:30},{timeoutMs:150});assert.deepEqual(result.posts.map(p=>p.aweme_id),[String(7200000000000000003n)]);assert.equal(page.reads,2);
});
test('at most three future handles are retained, and unadmitted fourth is not read',async()=>{
  let resolve;const pending=new Promise(r=>resolve=r);const page=new Page(p=>{const a=p.req(url(0));p.emit('request',a);p.response(a,()=>pending);for(const cursor of [100,200,300,400]){const b=p.req(url(cursor));p.emit('request',b);p.response(b,async()=>body(cursor,0,false));}resolve(body(1,400,true));});
  const result=await collectOne(page,{key:'phase103',secUid:SEC,limit:30},{timeoutMs:150,pageWaitMs:30});assert.equal(page.reads,1);assert.equal(result.posts.length,1);assert.notEqual(result.pagination.stopReason,'end-of-list');
});
test('same-document route retirement clears capacity before a fresh legitimate chain',async()=>{
  let resolve;const old=new Promise(r=>resolve=r);const page=new Page(p=>{
    const a=p.req(url(0));p.emit('request',a);p.response(a,()=>old);for(const cursor of [100,200,300]){const b=p.req(url(cursor));p.emit('request',b);p.response(b,async()=>body(cursor,0,false));}
    p.current='https://www.douyin.com/search/other';p.emit('framenavigated',p.frame);p.current=profile;p.emit('framenavigated',p.frame);
    let next;const pending=new Promise(r=>next=r);const h=p.req(url(0));p.emit('request',h);p.response(h,()=>pending);const b=p.req(url(100));p.emit('request',b);p.response(b,async()=>body(4,0,false));next(body(3,100,true));resolve(body(1,100,true));
  });
  const result=await collectOne(page,{key:'phase103',secUid:SEC,limit:30},{timeoutMs:150,pageWaitMs:30});assert.deepEqual(result.posts.map(p=>p.aweme_id),[String(7200000000000000003n),String(7200000000000000004n)]);assert.equal(page.reads,3);
});
test('promotion cannot exceed the original 32 admitted request cap',async()=>{
  let resolve;const pending=new Promise(r=>resolve=r);const page=new Page(p=>{
    const a=p.req(url(0));p.emit('request',a);p.response(a,()=>pending);const b=p.req(url(100));p.emit('request',b);p.response(b,async()=>body(2,0,false));
    for(let i=0;i<31;i++)p.emit('request',p.req(url(0)));resolve(body(1,100,true));
  });
  const result=await collectOne(page,{key:'phase103',secUid:SEC,limit:30},{timeoutMs:150,pageWaitMs:30});assert.equal(result.failureDiagnostics.requests.matched,32);assert.equal(result.posts.length,1);assert.equal(page.reads,1);
});
