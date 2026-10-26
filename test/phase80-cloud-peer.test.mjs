// Phase80: real production adapter + real replica route, with only external
// storage and the Vinext routing hop replaced by observable test doubles.
// These tests prove HTTP/event/auth boundaries, not cloud scheduling success.
// No live token, network, database-file, Site operation or deployment is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';

const site=new URL('../../mcn-public-site/',import.meta.url);
const requireSite=createRequire(new URL('package.json',site));
const ts=requireSite('typescript');
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const adapterSource=await readFile(new URL('build/sites-worker.ts',site),'utf8');
assert.equal(adapterSource.match(/import\.meta\.env\.DEV/g)?.length,1);
const adapterCode=compile(adapterSource.replace('import.meta.env.DEV','false'));
const ownerCode=compile(await readFile(new URL('lib/connector-context.ts',site),'utf8'));
const routeCode=compile(await readFile(new URL('app/api/replica/route.ts',site),'utf8'));
const savedAt='2026-09-30T02:00:00.000Z';
const syntheticProducer='phase80-synthetic-only-never-a-real-credential-'.repeat(2);
const eventHeaders={
  'x-github-event':'repository_dispatch',
  'x-cloudflare-event':'scheduled',
  'x-cron-schedule':'0 2,10,18 * * *',
  'oai-authenticated-user-id':'untrusted-header-fixture',
  'x-connectors-context':'untrusted-header-fixture',
};

function harness({databaseFailure=false}={}) {
  const calls={http:0,bodyReads:0,dbReads:0,dbWrites:0,bucket:0,outbound:0,waitUntil:0,preview:0};
  const manifest={asOf:savedAt,files:[]};
  const latest={generation:savedAt,manifest:JSON.stringify(manifest),published_at:savedAt};
  const db={prepare(){return{
    bind(){return this;},
    async first(){calls.dbReads++;if(databaseFailure)throw Error('Synthetic database outage');return latest;},
    async all(){calls.dbReads++;return{results:[]};},
    async run(){calls.dbWrites++;throw Error('Unexpected write');},
  };}};
  const bucket={async get(){calls.bucket++;throw Error('Unexpected bucket read');},async put(){calls.bucket++;throw Error('Unexpected bucket write');}};
  const env={DB:db,BUCKET:bucket,REPLICA_INGEST_SECRET:syntheticProducer,CONNECTORS:{
    async getContext(){calls.preview++;throw Error('Preview cannot grant production authority');},
    async invoke(){calls.preview++;throw Error('Preview cannot grant production authority');},
  }};
  const owner={},route={},adapter={},bindings=[];
  vm.runInNewContext(ownerCode,{exports:owner,require:requireSite},{filename:'phase80-real-connector-context.cjs'});
  vm.runInNewContext(routeCode,{
    exports:route,URL,Response,Date,TextEncoder,crypto:webcrypto,
    fetch(){calls.outbound++;throw Error('No source sampling is expected');},
    require(name){
      if(name==='cloudflare:workers')return{env};
      if(name.startsWith('@/lib/'))return requireSite(new URL(name.slice(2),site).pathname);
      throw Error('Unexpected route dependency '+name);
    },
  },{filename:'phase80-real-replica-route.cjs'});
  const http={fetch(request){calls.http++;bindings.push(owner.getConnectorBinding());return request.method==='POST'?route.POST(request):route.GET(request);}};
  vm.runInNewContext(adapterCode,{exports:adapter,Date,Error,require(name){
    if(name==='vinext/server/fetch-handler')return{__esModule:true,default:http};
    if(name==='../lib/connector-context')return owner;
    throw Error('Unexpected adapter dependency '+name);
  }},{filename:'phase80-real-production-adapter.cjs'});
  const send=(request,props)=>adapter.default.fetch(request,env,{props,waitUntil(){calls.waitUntil++;}});
  const post=(body,{authorized=false,props}={})=>send({
    method:'POST',url:'https://phase80.invalid/api/replica',
    headers:new Headers({...eventHeaders,...(authorized?{Authorization:`Bearer ${syntheticProducer}`}:{})}),
    async text(){calls.bodyReads++;return typeof body==='string'?body:JSON.stringify(body);},
  },props);
  const assertNoExecution=()=>{
    assert.equal(calls.dbWrites,0);assert.equal(calls.bucket,0);
    assert.equal(calls.outbound,0);assert.equal(calls.waitUntil,0);assert.equal(calls.preview,0);
    assert.equal(owner.getConnectorBinding(),undefined);
  };
  return{calls,manifest,bindings,send,post,assertNoExecution};
}

test('phase80 HTTP clock query and event headers traverse real adapter but cannot turn saved GET into sampling',async()=>{
  const h=harness();
  for(const hour of ['02','10','18']){
    const response=await h.send(new Request(`https://phase80.invalid/api/replica?action=collect&scheduledTime=2026-10-01T${hour}:00:00.000Z`,{headers:eventHeaders}));
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{manifest:h.manifest,publishedAt:savedAt,readOnly:true,collectionRequiresLocalComputer:true});
  }
  assert.equal(h.calls.http,3);assert.equal(h.calls.dbReads,3);
  assert.deepEqual(h.bindings,[undefined,undefined,undefined]);h.assertNoExecution();
});

test('phase80 R2 lifecycle, GitHub dispatch and clock payloads without producer authority are rejected before parsing',async()=>{
  const h=harness();
  for(const body of [
    {action:'LifecycleDeletion',eventTime:savedAt,bucket:'synthetic',object:{key:'clock-fixture'}},
    {event_type:'sample-mcn',client_payload:{slot:savedAt}},
    {type:'scheduled',cron:'0 2,10,18 * * *',scheduledTime:Date.parse(savedAt)},
    '{malformed-not-json',
  ])assert.equal((await h.post(body)).status,403);
  assert.equal(h.calls.bodyReads,0);assert.equal(h.calls.dbReads,0);
  assert.deepEqual(h.bindings,[undefined,undefined,undefined,undefined]);h.assertNoExecution();
});

test('phase80 a synthetic valid publisher identity grants no event-to-collector operation',async()=>{
  const h=harness();
  for(const action of ['collect','scheduled','queue','alarm','LifecycleDeletion']){
    const response=await h.post({asOf:savedAt,action,cron:'0 2,10,18 * * *'},{authorized:true});
    assert.equal(response.status,400);assert.deepEqual(await response.json(),{error:'无效发布清单'});
  }
  assert.equal(h.calls.bodyReads,5);assert.equal(h.calls.dbReads,0);h.assertNoExecution();
});

test('phase80 an actual trusted request connector binding does not replace separate producer authorization',async()=>{
  const h=harness();let invokes=0;
  const connector={async getContext(){invokes++;return{status:'ready'};},async invoke(){invokes++;return{status:'success'};}};
  const response=await h.post({asOf:savedAt,action:'collect'},{props:{CONNECTORS:connector}});
  assert.equal(response.status,403);assert.equal(h.bindings[0],connector);
  assert.equal(h.calls.bodyReads,0);assert.equal(h.calls.dbReads,0);assert.equal(invokes,0);h.assertNoExecution();
});

test('phase80 a failed anonymous read neither invokes collection nor promotes the preview fallback',async()=>{
  const h=harness({databaseFailure:true});
  const response=await h.send(new Request('https://phase80.invalid/api/replica?refresh=true',{headers:eventHeaders}));
  assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'云端数据暂不可用，请稍后重试'});
  assert.equal(h.calls.http,1);assert.equal(h.calls.dbReads,1);assert.deepEqual(h.bindings,[undefined]);h.assertNoExecution();
});
