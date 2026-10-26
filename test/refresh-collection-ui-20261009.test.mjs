import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

function fixture(role = 'admin') {
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, { textContent: '', hidden: true, disabled: false,
    attrs: {}, setAttribute(k,v) { this.attrs[k] = v; } }); return nodes.get(id); };
  let requests = 0, reads = 0;
  const context = { ...model, fmt:model.formatNumber, URL, URLSearchParams, Intl, Date,
    location:new URL('http://fixture.test/?theme=tuantuan&period=30d#overview'),
    document:{getElementById:node}, window:{}, performRead:async()=>{reads++;} };
  const source = readFileSync(new URL('../public/rebuild.js',import.meta.url),'utf8')
    .replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '');
  runInNewContext(`${source}\nreadSavedSnapshot=performRead; this.subject={state,refreshSnapshot,refreshAfterCollection,renderCollectionRefresh,isReadPending:()=>collectionReadPending,setController(c){collectionRefresh=c;}};`,context);
  const subject = context.subject;
  subject.state.session = {authenticated:true,user:{role}};
  let status = {job:null,submitting:false,checking:false,error:''};
  subject.setController({getState:()=>status,request:async()=>{requests++;}});
  return {...subject,node,requests:()=>requests,reads:()=>reads,setStatus:s=>{status={...status,...s};}};
}
test('admin and editor manual refresh submit collection, not merely read existing insights',async()=>{
  for(const role of ['admin','editor']){const f=fixture(role);await f.refreshSnapshot();assert.equal(f.requests(),1);assert.equal(f.reads(),0);}
});
test('viewer refresh remains a separately labelled read with no collection privilege',async()=>{
  const f=fixture('viewer');f.setController(null);f.renderCollectionRefresh();await f.refreshSnapshot();
  assert.equal(f.requests(),0);assert.equal(f.reads(),1);assert.equal(f.node('refreshBtn').textContent,'读取已保存数据');
});
test('an unready admin entry never silently degrades into a read-only refresh',async()=>{
  const f=fixture();f.setController(null);await f.refreshSnapshot();assert.equal(f.requests(),0);assert.equal(f.reads(),0);
  assert.match(f.node('notice').textContent,/本次未提交采集/);
});
test('queued/running/checking disable repeated clicks without hiding saved data',()=>{
  const f=fixture();for(const status of ['queued','running']){
    f.setStatus({job:{id:'job',status,progress:{targetCount:701,processedCount:20,successCount:18,errorCount:2,warningCount:3}}});
    f.renderCollectionRefresh();assert.equal(f.node('refreshBtn').disabled,true);assert.equal(f.node('collectionRefreshStatus').hidden,false);
  }
  assert.match(f.node('collectionRefreshMessage').textContent,/20\/701/);
  f.setStatus({job:null,checking:true});f.renderCollectionRefresh();assert.equal(f.node('refreshBtn').disabled,true);
});
test('partial completion keeps failures and separates profile and topic availability',()=>{
  const f=fixture();f.setStatus({job:{id:'job',status:'completed',progress:{targetCount:705},result:{successCount:700,errorCount:5,warningCount:696,skippedCount:0,profileUsableCount:696,topicMetricsUsableCount:4}}});
  f.renderCollectionRefresh();const text=f.node('collectionRefreshMessage').textContent;
  assert.match(text,/失败 5/);assert.match(text,/主页指标可用 696/);assert.match(text,/话题双指标可用 4/);assert.match(text,/作品明细另行分批采集/);assert.doesNotMatch(text,/全部成功/);
  assert.equal(f.node('refreshBtn').disabled,false);
});
test('read-only automatic paths and collection callback remain distinct',()=>{
  const source=readFileSync(new URL('../public/rebuild.js',import.meta.url),'utf8');
  assert.match(source,/onComplete: refreshAfterCollection/);
  assert.match(source,/if \(!value && collectionReadPending\) void Promise.resolve\(\).then\(refreshAfterCollection\)/);
  const automatic=source.slice(source.indexOf('async function automaticRead'),source.indexOf('function automaticApply'));
  assert.doesNotMatch(automatic,/refreshSnapshot\(|collectionRefresh\.request/);
});
test('completion during an in-flight scope read queues one follow-up rather than losing it',async()=>{
  const f=fixture();f.state.busy=true;await f.refreshAfterCollection();
  assert.equal(f.reads(),0);assert.equal(f.isReadPending(),true);
  f.state.busy=false;await f.refreshAfterCollection();
  assert.equal(f.reads(),1);assert.equal(f.isReadPending(),false);
});
