// Independent source evidence; no network, browser, Site write or cloud registration.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';

const site=new URL('../../mcn-public-site/',import.meta.url),requireSite=createRequire(new URL('package.json',site));
const {readReplicaPart}=await import(new URL('lib/replica-reader.mjs',site));
const {withReplicaReadDeadline}=await import(new URL('lib/replica-read-deadline.mjs',site));
const generation='2026-10-01T14:30:00.000Z',part='catalog.json';
const value={version:1,asOf:generation,timeZone:'Asia/Shanghai',accounts:[]};
const text=JSON.stringify(value),sha256=createHash('sha256').update(text).digest('hex');
const meta={path:part,bytes:Buffer.byteLength(text),sha256};
const response=body=>({ok:true,headers:new Headers({'X-Data-SHA256':sha256,'X-Data-Cutoff':generation}),text:()=>body});
const never=()=>new Promise(()=>{});
const turns=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};

test('phase67 part deadline aborts actual in-flight transport even when caller provides its own signal',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const parent=new AbortController();let seenSignal,requests=0,aborts=0;
 const pending=readReplicaPart({generation,part,meta,signal:parent.signal,fetcher:async(_url,options)=>{requests++;seenSignal=options.signal;seenSignal.addEventListener('abort',()=>aborts++);return never();}});
 const rejected=assert.rejects(pending,{name:'TimeoutError',message:'读取已保存数据超时，请重试。'});
 t.mock.timers.tick(20_000);await rejected;
 assert.equal(requests,1);assert.equal(parent.signal.aborted,false,'one part deadline must not abort unrelated sibling reads through the caller controller');
 assert.equal(seenSignal.aborted,true,'part timeout must reach the signal actually passed to fetch, not just a disconnected internal controller');
 assert.equal(aborts,1);
});

test('phase67 deadline covers body stall after HTTP headers and cancels that same request',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const parent=new AbortController();let seenSignal,bodyReads=0;
 const pending=readReplicaPart({generation,part,meta,signal:parent.signal,fetcher:async(_url,options)=>{seenSignal=options.signal;return {...response(never()),text(){bodyReads++;return never();}};}});
 const rejected=assert.rejects(pending,{name:'TimeoutError'});await turns();assert.equal(bodyReads,1);
 t.mock.timers.tick(20_000);await rejected;assert.equal(seenSignal.aborted,true);assert.equal(parent.signal.aborted,false);
});

test('phase67 external abort still cancels an active part immediately with its original reason',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const parent=new AbortController(),reason=Object.assign(new Error('left-author-page'),{name:'AbortError'});let seenSignal;
 const pending=readReplicaPart({generation,part,meta,signal:parent.signal,fetcher:async(_url,options)=>{seenSignal=options.signal;return never();}}),rejected=assert.rejects(pending,error=>error===reason);
 parent.abort(reason);await rejected;assert.equal(seenSignal.aborted,true);t.mock.timers.tick(20_000);assert.equal(parent.signal.reason,reason);
});

test('phase67 already-canceled caller never starts any part request',async()=>{
 const parent=new AbortController();parent.abort();let requests=0;
 await assert.rejects(readReplicaPart({generation,part,meta,signal:parent.signal,fetcher:async()=>{requests++;return response(Promise.resolve(text));}}),{name:'AbortError'});
 assert.equal(requests,0);
});

test('phase67 successful verified part keeps bytes/version contract and clears its own deadline',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const parent=new AbortController();let seenSignal,requests=0;
 const result=await readReplicaPart({generation,part,meta,signal:parent.signal,fetcher:async(_url,options)=>{requests++;seenSignal=options.signal;return response(Promise.resolve(text));}});
 assert.deepEqual(result,value);t.mock.timers.tick(20_000);assert.equal(seenSignal.aborted,false);assert.equal(parent.signal.aborted,false);assert.equal(requests,1);
});

test('phase67 completing late cannot turn a timed-out deadline into success',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const controller=new AbortController();let release,successes=0;
 const pending=withReplicaReadDeadline({controller,operation:()=>new Promise(resolve=>{release=resolve;})}).then(value=>{successes++;return value;});
 const rejected=assert.rejects(pending,{name:'TimeoutError'});t.mock.timers.tick(20_000);await rejected;release('late');await turns();assert.equal(successes,0);assert.equal(controller.signal.aborted,true);
});

test('phase67 actual Home server render starts no data request or client deadline before hydration',async()=>{
 const ts=requireSite('typescript'),react=requireSite('react'),jsx=requireSite('react/jsx-runtime'),{renderToString}=requireSite('react-dom/server');
 const source=await readFile(new URL('app/page.tsx',site),'utf8'),compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const exports={};let requests=0,timers=0;
 vm.runInNewContext(compiled,{exports,console,URL,URLSearchParams,Date,Map,Set,Promise,AbortController,Blob,setTimeout(){timers++;throw Error('server render must not start client deadline');},clearTimeout(){},setInterval(){throw Error('server render must not poll');},clearInterval(){},fetch(){requests++;throw Error('server render must not fetch replica');},require(specifier){if(specifier==='react')return react;if(specifier==='react/jsx-runtime')return jsx;if(specifier.startsWith('@/components/')||specifier==='recharts'||specifier==='lucide-react')return new Proxy({}, {get:()=>({children,...props})=>react.createElement('div',{'data-peer-shell':true},children)});if(specifier.startsWith('@/lib/'))return requireSite(new URL(specifier.slice(2),site).pathname);return requireSite(specifier);}},{filename:'phase67-actual-Home.tsx'});
 const html=renderToString(react.createElement(exports.default));
 assert.match(html,/连接公开数据/);assert.match(html,/读取中/);assert.equal(requests,0);assert.equal(timers,0);
});

test('phase67 hydrated actual Home exits loading after metadata transport or body stall, with one request and retry available',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const ts=requireSite('typescript'),source=await readFile(new URL('app/page.tsx',site),'utf8'),tree=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),names=[];
 function visit(n){if(ts.isVariableDeclaration(n)&&ts.isArrayBindingPattern(n.name)&&ts.isCallExpression(n.initializer)&&n.initializer.expression.getText(tree)==='useState')names.push(n.name.elements[0].name.getText(tree));ts.forEachChild(n,visit);}visit(tree);
 const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 for(const headersArrive of [false,true]){
  let cursor=0,ordinal=0,dirty=true,effects=[],output,fetches=0,bodyReads=0;const hooks=[],slots=new Map(),exports={};
  const react={useState(value){const i=cursor++,name=names[ordinal++];slots.set(name,i);if(!hooks[i])hooks[i]={value:typeof value==='function'?value():value};return [hooks[i].value,next=>{next=typeof next==='function'?next(hooks[i].value):next;if(!Object.is(next,hooks[i].value)){hooks[i].value=next;dirty=true;}}];},useRef(value){const i=cursor++;return hooks[i]??(hooks[i]={current:value});},useMemo(fn){cursor++;return fn();},useEffect(fn,deps){const i=cursor++,old=hooks[i];if(!old||deps.some((v,j)=>!Object.is(v,old.deps[j]))){hooks[i]={deps,cleanup:old?.cleanup};effects.push(()=>{old?.cleanup?.();hooks[i].cleanup=fn();});}}};
  const location=new URL('https://phase67.invalid/#overview'),window={location,scrollY:0,scrollTo(){},addEventListener(){},removeEventListener(){},history:{replaceState(_s,_t,next){location.href=new URL(next,location).href;},pushState(_s,_t,next){location.href=new URL(next,location).href;}}},document={visibilityState:'visible',activeElement:null,querySelector:()=>null};
  const jsx=(type,props)=>({type,props:props||{}});
  vm.runInNewContext(compiled,{exports,console,URL,URLSearchParams,Date,Map,Set,Promise,AbortController,Blob,window,document,setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},requestAnimationFrame:()=>1,cancelAnimationFrame(){},fetch:async()=>{fetches++;return headersArrive?{ok:true,json(){bodyReads++;return never();}}:never();},require(specifier){if(specifier==='react')return react;if(specifier==='react/jsx-runtime')return {jsx,jsxs:jsx,Fragment:'Fragment'};if(specifier.startsWith('@/components/')||specifier==='recharts'||specifier==='lucide-react')return new Proxy({}, {get:(_t,k)=>String(k)});if(specifier.startsWith('@/lib/'))return requireSite(new URL(specifier.slice(2),site).pathname);return requireSite(specifier);}},{filename:'phase67-hydrated-Home.tsx'});
  const state=name=>hooks[slots.get(name)]?.value;
  const flush=async()=>{for(let i=0;i<30;i++){if(dirty){cursor=0;ordinal=0;dirty=false;output=exports.default();}const due=effects;effects=[];due.forEach(fn=>fn());await turns();if(!dirty&&!effects.length)return;}throw Error('Home failed to settle');};
  try{await flush();assert.equal(fetches,1);assert.equal(bodyReads,headersArrive?1:0);assert.equal(state('loading'),true);
   t.mock.timers.tick(19_999);await flush();assert.equal(state('loading'),true);t.mock.timers.tick(1);await flush();assert.equal(state('loading'),false);assert.match(state('error'),/读取已保存数据超时/);assert.equal(fetches,1);assert.equal(state('data'),null);
   const list=[];const walk=n=>{if(!n||typeof n!=='object')return;if(Array.isArray(n))n.forEach(walk);else{list.push(n);walk(n.props.children);}};walk(output);
   assert.ok(list.some(n=>n.type==='Button'&&n.props.children==='刷新已发布数据'&&n.props.disabled===false));
  }finally{hooks.forEach(h=>h?.cleanup?.());}
 }
});

test('phase67 actual worker does not retain a request connector binding for another request or out-of-request use',async()=>{
 const ts=requireSite('typescript'),compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const contextExports={},contextSource=await readFile(new URL('lib/connector-context.ts',site),'utf8');
 vm.runInNewContext(compile(contextSource),{exports:contextExports,require:requireSite},{filename:'phase67-actual-connector-context.ts'});
 const workerSource=await readFile(new URL('build/sites-worker.ts',site),'utf8'),tree=ts.createSourceFile('sites-worker.ts',workerSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 // Simulate the production build's compile-time DEV=false, not the local preview branch.
 const transformed=ts.transform(tree,[context=>{const visit=node=>ts.isPropertyAccessExpression(node)&&node.getText(tree)==='import.meta.env.DEV'?ts.factory.createFalse():ts.visitEachChild(node,visit,context);return node=>ts.visitNode(node,visit);}]);
 const workerExports={},observed=[];
 vm.runInNewContext(compile(ts.createPrinter().printFile(transformed.transformed[0])),{exports:workerExports,require(specifier){if(specifier==='vinext/server/fetch-handler')return {default:{fetch(){const binding=contextExports.getConnectorBinding();observed.push(binding);return binding;}}};if(specifier==='../lib/connector-context')return contextExports;throw Error('Unexpected import: '+specifier);}},{filename:'phase67-actual-sites-worker.ts'});transformed.dispose();
 const binding={invoke:async()=>({status:'success',result:{content:[]}})},worker=workerExports.default;
 assert.equal(contextExports.getConnectorBinding(),undefined);
 assert.equal(worker.fetch({}, {}, {props:{CONNECTORS:binding}}),binding);
 assert.equal(contextExports.getConnectorBinding(),undefined,'request context must not become a globally reusable executor capability');
 assert.equal(worker.fetch({}, {}, {}),undefined);assert.deepEqual(observed,[binding,undefined]);
});

test('phase67 actual connector contract rejects absent authority instead of inventing an executor',async()=>{
 const ts=requireSite('typescript'),source=await readFile(new URL('lib/connector-contract.mts',site),'utf8'),exports={};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports},{filename:'phase67-actual-connector-contract.mts'});
 const connector=exports.createConnectors(undefined);
 assert.equal((await connector.getContext()).status,'binding_unavailable');
 const outcome=await connector.invoke('synthetic-peer','synthetic-zero-ai-clock',{});
 assert.equal(outcome.status,'binding_unavailable');assert.match(outcome.message,/does not provide connected apps for this request/);
});

test('phase67 existing Main scheduler clock is process-owned and stop removes later timer ticks',async t=>{
 const {MonitorScheduler}=await import('../lib/scheduler.mjs');
 t.mock.timers.enable({apis:['setInterval']});
 const scheduler=new MonitorScheduler({}, {scheduleTimeZone:'Asia/Shanghai'});let ticks=0;
 t.mock.method(scheduler,'tick',async()=>{ticks++;});
 scheduler.start();assert.equal(ticks,1);scheduler.start();assert.equal(ticks,1,'starting again must not create a second process timer');
 t.mock.timers.tick(30_000);await turns();assert.equal(ticks,2);
 scheduler.stop();t.mock.timers.tick(300_000);await turns();assert.equal(ticks,2);assert.equal(scheduler.timer,null);
});
