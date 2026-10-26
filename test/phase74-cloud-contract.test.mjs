// Phase74 diagnostic contracts for the CURRENT fetch-only Site execution
// boundary. Runs actual Worker adapter and AsyncLocalStorage capability owner,
// with a supplied HTTP handler only. No deployment/cloud event/secret/network,
// resource creation, process, database file, or browser operations. A future
// authorized clock implementation must explicitly revise this current boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';

const SITE=new URL('../../mcn-public-site/',import.meta.url),requireSite=createRequire(new URL('package.json',SITE));
const ts=requireSite('typescript');
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const source=await readFile(new URL('build/sites-worker.ts',SITE),'utf8');
const connectorCode=compile(await readFile(new URL('lib/connector-context.ts',SITE),'utf8'));
// Exact Vite build-time transport flag: choose its production false branch.
// This does not edit the actual source or erase/rewrite any business handler.
assert.equal(source.match(/import\.meta\.env\.DEV/g)?.length,1);
const workerCode=compile(source.replace('import.meta.env.DEV','false'));
const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};

function workerHarness(handle){
 const owner={},worker={},calls=[];
 vm.runInNewContext(connectorCode,{exports:owner,require:requireSite},{filename:'phase74-actual-connector-context.cjs'});
 const handler={async fetch(request,env,ctx){calls.push({request,env,ctx});return handle?handle({request,env,ctx,binding:owner.getConnectorBinding()}):new Response('saved response only');}};
 vm.runInNewContext(workerCode,{exports:worker,Date,Error,require(name){
  if(name==='vinext/server/fetch-handler')return{__esModule:true,default:handler};
  if(name==='../lib/connector-context')return owner;
  throw Error('unexpected actual adapter dependency '+name);
 }},{filename:'phase74-actual-sites-worker.production.cjs'});
 return{worker:worker.default,owner,calls};
}

test('phase74 actual exported Site adapter has HTTP fetch but no currently executable clock handler',()=>{
 const h=workerHarness();assert.equal(typeof h.worker.fetch,'function');assert.equal(h.worker.scheduled,undefined);assert.equal(h.worker.queue,undefined);assert.equal(h.worker.alarm,undefined);assert.deepEqual(Object.keys(h.worker),['fetch']);assert.equal(h.calls.length,0);assert.equal(h.owner.getConnectorBinding(),undefined);
});
test('phase74 ordinary HTTP read reaches handler once and does not create background execution',async()=>{
 const h=workerHarness(),request=new Request('https://phase74.invalid/api/replica');let waits=0;const env={DB:{synthetic:true},BUCKET:{synthetic:true}},ctx={waitUntil(){waits++;}};
 const response=await h.worker.fetch(request,env,ctx);assert.equal(response.status,200);assert.equal(await response.text(),'saved response only');assert.equal(h.calls.length,1);assert.equal(h.calls[0].request,request);assert.equal(h.calls[0].env,env);assert.equal(h.calls[0].ctx,ctx);assert.equal(waits,0);assert.equal(h.owner.getConnectorBinding(),undefined);
});
test('phase74 production cannot promote env preview CONNECTORS into unattended authority',async()=>{
 const preview={getContext(){throw Error('Production must not use synthetic preview authority');},invoke(){throw Error('Production must not use synthetic preview authority');}};
 const h=workerHarness(async({binding})=>{assert.equal(binding,undefined);return new Response('no request authority');});
 const response=await h.worker.fetch(new Request('https://phase74.invalid/api/replica'),{CONNECTORS:preview},{});assert.equal(await response.text(),'no request authority');assert.equal(h.owner.getConnectorBinding(),undefined);
});
test('phase74 actual request-scoped connector owner isolates concurrent capabilities',async()=>{
 const firstGate=gate(),secondGate=gate(),seen=[];
 const first={async getContext(){return{syntheticIdentity:'first'};},async invoke(){return{synthetic:true};}},second={async getContext(){return{syntheticIdentity:'second'};},async invoke(){return{synthetic:true};}};
 const h=workerHarness(async({request,binding})=>{const tag=new URL(request.url).pathname;seen.push([tag,'before',binding]);await(tag==='/first'?firstGate.promise:secondGate.promise);assert.equal(h.owner.getConnectorBinding(),binding);seen.push([tag,'after',h.owner.getConnectorBinding()]);return new Response((await binding.getContext()).syntheticIdentity);});
 const a=h.worker.fetch(new Request('https://phase74.invalid/first'),{},{props:{CONNECTORS:first}}),b=h.worker.fetch(new Request('https://phase74.invalid/second'),{},{props:{CONNECTORS:second}});
 assert.equal(h.owner.getConnectorBinding(),undefined);secondGate.resolve();assert.equal(await(await b).text(),'second');firstGate.resolve();assert.equal(await(await a).text(),'first');
 assert.equal(seen.length,4);assert.ok(seen.filter(x=>x[0]==='/first').every(x=>x[2]===first));assert.ok(seen.filter(x=>x[0]==='/second').every(x=>x[2]===second));assert.equal(h.owner.getConnectorBinding(),undefined);
});
test('phase74 failed request releases capability and cannot grant a later no-context read',async()=>{
 const authorized={async getContext(){return{syntheticIdentity:'request-only'};}};let seen=0;
 const h=workerHarness(async({binding})=>{seen++;if(seen===1){assert.equal(binding,authorized);throw Error('synthetic request failure');}assert.equal(binding,undefined);return new Response('unattended identity absent');});
 await assert.rejects(h.worker.fetch(new Request('https://phase74.invalid/failing'),{},{props:{CONNECTORS:authorized}}),/synthetic request failure/);assert.equal(h.owner.getConnectorBinding(),undefined);
 assert.equal(await(await h.worker.fetch(new Request('https://phase74.invalid/later'),{},{})).text(),'unattended identity absent');assert.equal(h.owner.getConnectorBinding(),undefined);
});
