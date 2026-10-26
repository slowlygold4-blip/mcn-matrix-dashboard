// Phase73 independent actual TSX/controller/renderer and installed Vinext lazy
// state-machine contracts. Hook/JSX transport is supplied; React.lazy and the
// installed DynamicErrorBoundary are real. NOT a browser chunk/network/layout,
// CWV, accessibility, collector or retention test. Synthetic saved data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';

const SITE=new URL('../../mcn-public-site/',import.meta.url),requireSite=createRequire(new URL('package.json',SITE));
const ts=requireSite('typescript'),realReact=requireSite('react');
const compile=source=>ts.transpileModule(source,{compilerOptions:{allowJs:true,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const panelCode=compile(await readFile(new URL('components/growth-panel.tsx',SITE),'utf8'));
const rendererCode=compile(await readFile(new URL('components/growth-chart.tsx',SITE),'utf8'));
const loadingCode=compile(await readFile(new URL('components/growth-chart-loading.tsx',SITE),'utf8'));
const dynamicCode=compile(await readFile(new URL('node_modules/vinext/dist/shims/dynamic.js',SITE),'utf8'));
const stylesheet=await readFile(new URL('app/replica.css',SITE),'utf8');
const jsx=(type,props,key)=>({type,props:props||{},key});
const text=n=>n==null||typeof n==='boolean'?'':Array.isArray(n)?n.map(text).join(''):typeof n==='object'?text(n.props?.children):String(n);
const nodes=n=>n==null||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)];
const deep=n=>JSON.parse(JSON.stringify(n));
const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
const account={id:1,label:'合成监控账号',platform:'douyin',enabled:true};
const captured=date=>date+'T03:00:00.000Z';
const point=(date,followers,likes=followers,posts=0)=>({targetId:1,date,capturedAt:captured(date),followers,followersAt:followers===null?null:captured(date),likes,likesAt:likes===null?null:captured(date),posts,postsAt:posts===null?null:captured(date)});
const manifest={asOf:'2026-10-01T14:17:26.276Z',timeZone:'Asia/Shanghai',files:[{path:'daily/1.json',kind:'daily',targetId:1,count:4,sha256:'a'.repeat(64)}]};
const basic=()=>({accounts:[account],points:[point('2026-09-12',10,20),point('2026-09-14',8,18),point('2026-09-17',20,30),point('2026-09-19',20,30)],manifest,start:'2026-09-12',end:'2026-09-14',comparison:{compare:true,otherStart:'2026-09-17',otherEnd:'2026-09-19'},offset:0});

function panelHarness(overrides={}){
 let cursor=0,tree,props={...basic(),...overrides},networkCalls=0,rendererEvaluations=0,rendererExports,loadingExports;
 const hooks=[],blobs=[],anchors=[],timers=[],exports={},dynamicCalls=[],imports=[];
 const react={useId:()=>"phase114-test-reading",useState(initial){const i=cursor++;if(!(i in hooks))hooks[i]={value:typeof initial==='function'?initial():initial};return[hooks[i].value,next=>{hooks[i].value=typeof next==='function'?next(hooks[i].value):next;}];},useMemo(fn,deps){const i=cursor++;if(!same(hooks[i]?.deps,deps))hooks[i]={value:fn(),deps};return hooks[i].value;}};
 class LocalURL extends URL {static createObjectURL(blob){blobs.push(blob);return 'blob:phase73-'+blobs.length;}static revokeObjectURL(){}}
 function requireModule(spec){
  imports.push(spec);
  if(spec==='react')return react;
  if(spec==='react/jsx-runtime')return{jsx,jsxs:jsx,Fragment:'Fragment'};
  if(spec==='next/dynamic')return {__esModule:true,default(loader,options){function DeferredGrowthChart(){};dynamicCalls.push({loader,options,component:DeferredGrowthChart});return DeferredGrowthChart;}};
  if(spec==='@/components/growth-chart-loading'||spec==='./growth-chart-loading'){
   if(!loadingExports){loadingExports={};vm.runInNewContext(loadingCode,{...context,exports:loadingExports},{filename:'phase73-actual-growth-chart-loading.cjs'});}return loadingExports;
  }
  if(spec==='@/components/growth-chart'||spec==='./growth-chart'){
   if(!rendererExports){rendererEvaluations++;rendererExports={};vm.runInNewContext(rendererCode,{...context,exports:rendererExports},{filename:'phase73-actual-growth-chart.cjs'});}return rendererExports;
  }
  if(spec==='recharts'||spec.startsWith('@/components/'))return new Proxy({},{get:(_t,key)=>String(key)});
  if(spec.startsWith('@/lib/'))return requireSite(new URL(spec.slice(2),SITE).pathname);
  return requireSite(spec);
 }
 const context={exports,console,Date,Error,Map,Set,Promise,Blob,URL:LocalURL,URLSearchParams,
  document:{createElement(tag){assert.equal(tag,'a');const anchor={clicks:0,click(){this.clicks++;}};anchors.push(anchor);return anchor;}},
  setTimeout(fn,ms){timers.push({fn,ms});return timers.length;},
  fetch(){networkCalls++;throw Error('Controller/renderer must not initiate business reads');},require:requireModule};
 vm.runInNewContext(panelCode,context,{filename:'phase73-actual-growth-panel.cjs'});
 assert.equal(dynamicCalls.length,1,'actual panel configures one module-scope deferred renderer');
 const config=dynamicCalls[0],api={
  render(next={}){props={...props,...next};cursor=0;tree=exports.GrowthPanel(props);return tree;},all:()=>nodes(tree),text:()=>text(tree),
  networkCalls:()=>networkCalls,rendererEvaluations:()=>rendererEvaluations,imports,dynamicCalls,blobs,anchors,timers,
  deferred:()=>nodes(tree).find(n=>n.type===config.component),config,
  async renderer(){const el=this.deferred();assert.ok(el,'actual conditional renderer is mounted');const mod=await config.loader(),Renderer=mod.default??mod;assert.equal(typeof Renderer,'function');return Renderer(el.props);},
  fallback(extra={}){assert.equal(typeof config.options.loading,'function');return config.options.loading({error:null,isLoading:true,pastDelay:true,retry(){},timedOut:false,...extra});},
 };
 api.byType=type=>api.all().find(n=>n.type===type);
 api.button=label=>api.all().find(n=>n.type==='Button'&&text(n)===label);
 api.reading=()=>api.all().find(n=>n.props['aria-label']==='本屏真实末日读数');
 api.setMetric=value=>{api.byType('ToggleGroup').props.onValueChange(value);api.render();};
 api.render();return api;
}
const find=(tree,type)=>nodes(tree).find(n=>n.type===type);
const exportButton=h=>h.button('导出本屏曲线记录');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};

function lazyRuntime(loader,loading,{server=false}={}){
 let cursor=0;const hooks=[],effects=[],exports={};
 const hookReact={...realReact,
  useState(initial){const i=cursor++;if(!(i in hooks))hooks[i]={value:typeof initial==='function'?initial():initial};return[hooks[i].value,next=>{hooks[i].value=typeof next==='function'?next(hooks[i].value):next;}];},
  useCallback(fn,deps){const i=cursor++;if(!same(hooks[i]?.deps,deps))hooks[i]={value:fn,deps};return hooks[i].value;},
  useEffect(fn,deps){const i=cursor++;if(!same(hooks[i]?.deps,deps)){hooks[i]={deps};effects.push(fn);}},
 };
 const context={exports,console,Promise,Error,require(spec){if(spec==='react')return{...hookReact,__esModule:true,default:hookReact};if(spec==='./dynamic-preload-chunks.js')return{DynamicPreloadChunks:'DynamicPreloadChunks'};throw Error('unexpected shim import '+spec);}};
 if(!server)context.window={};
 vm.runInNewContext(dynamicCode,context,{filename:'phase73-actual-installed-vinext-dynamic.cjs'});
 const Component=exports.default(loader,{ssr:false,loading});
 return {render(props={}){cursor=0;return Component(props);},mount(){effects.splice(0).forEach(fn=>fn());},React:realReact};
}
function lazyChildren(tree){assert.equal(tree.type,realReact.Suspense);const boundary=tree.props.children;assert.equal(typeof boundary.type,'function');return {boundary,lazy:boundary.props.children};}
function initLazy(element){assert.equal(element.type.$$typeof,Symbol.for('react.lazy'));return element.type._init(element.type._payload);}

test('phase73 invalid/unverified range never imports renderer or exposes stale readouts/export',()=>{
 const h=panelHarness({ready:false,pendingError:'本范围尚未通过读取校验'});assert.equal(h.config.options.ssr,false);
 assert.equal(h.deferred(),undefined);assert.equal(h.reading(),undefined);assert.equal(h.byType('TableBody'),undefined);assert.equal(exportButton(h).props.disabled,true);
 assert.match(h.text(),/本范围尚未通过读取校验/);assert.equal(h.rendererEvaluations(),0);assert.ok(!h.imports.includes('recharts'));assert.ok(!h.imports.includes('@/components/ui/chart'));assert.equal(h.networkCalls(),0);
});
test('phase73 no endpoints preserves unknown rather than triggering zero chart/load',()=>{
 const h=panelHarness({points:[]});assert.equal(h.deferred(),undefined);assert.equal(h.rendererEvaluations(),0);assert.equal(exportButton(h).props.disabled,true);
 assert.match(h.text(),/没有同时满足起止端点/);assert.match(text(h.reading()),/缺测/);assert.equal(h.networkCalls(),0);
});
test('phase73 suspended workspace keeps genuine table/readout/CSV without renderer import',async()=>{
 const h=panelHarness({suspended:true});assert.equal(h.deferred(),undefined);assert.ok(h.byType('TableBody'));assert.match(text(h.reading()),/-2/);assert.equal(exportButton(h).props.disabled,false);
 exportButton(h).props.onClick();const csv=await h.blobs[0].text();assert.match(csv,/fixed-endpoint-cohort-net-change-null-not-zero/);assert.match(csv,/daily\/1\.json/);assert.ok(csv.includes('a'.repeat(64)));assert.match(csv,/2026-09-13/);assert.match(csv,/"-2"/);
 assert.equal(h.anchors[0].clicks,1);assert.equal(h.rendererEvaluations(),0);assert.equal(h.networkCalls(),0);assert.deepEqual(h.timers.map(x=>x.ms),[1000]);
});
test('phase73 actual deferred import loads renderer only; real zero remains [0,null,0]',async()=>{
 const h=panelHarness({comparison:{compare:false,otherStart:'',otherEnd:''},points:[point('2026-09-12',0),point('2026-09-14',0)]});
 assert.equal(h.rendererEvaluations(),0);const tree=await h.renderer();assert.equal(h.rendererEvaluations(),1);const chart=find(tree,'LineChart');assert.ok(chart);
 assert.deepEqual(deep(chart.props.data.map(x=>x.current)),[0,null,0]);assert.equal(exportButton(h).props.disabled,false);assert.doesNotMatch(h.text(),/没有同时满足起止端点/);assert.equal(h.networkCalls(),0);
});
test('phase73 actual renderer keeps negative, interior gap, A/B dates and fixed cohort',async()=>{
 const h=panelHarness(),tree=await h.renderer(),chart=find(tree,'LineChart');
 assert.deepEqual(deep(chart.props.data.map(x=>[x.current,x.comparison])),[[0,0],[null,null],[-2,0]]);assert.equal(chart.props.accessibilityLayer,false);
 const accessible=nodes(tree).find(n=>n.props?.className==='trend-point-chart');assert.ok(accessible);assert.equal(accessible.props.tabIndex,0);assert.equal(accessible.props.role,'group');assert.match(accessible.props['aria-label'],/累计净变化曲线.*左右方向键.*Home.*End/);assert.equal(accessible.props['aria-describedby'],h.deferred().props.readingId);assert.ok(accessible.props['aria-describedby']);for(const event of ['onKeyDown','onFocusCapture','onPointerUp'])assert.equal(typeof accessible.props[event],'function');
 assert.match(text(h.reading()),/当前区间.*2026-09-14-2/);assert.match(text(h.reading()),/比较区间.*2026-09-190/);assert.equal(h.deferred().props.cohortCount,1);assert.equal(h.networkCalls(),0);
});
test('phase73 renderer does not smooth, bridge nulls or animate fictional values',async()=>{
 const lines=nodes(await panelHarness().renderer()).filter(n=>n.type==='Line');assert.equal(lines.length,2);for(const line of lines){assert.equal(line.props.type,'linear');assert.equal(line.props.connectNulls,false);assert.equal(line.props.isAnimationActive,false);}
});
test('phase73 renderer keeps owner points by reference and does not mutate saved input/series',async()=>{
 const h=panelHarness(),props=h.deferred().props,before=deep(props.points),tree=await h.renderer();assert.equal(find(tree,'LineChart').props.data,props.points);assert.deepEqual(deep(props.points),before);assert.equal(find(tree,'ReferenceLine').props.y,0);
 assert.ok(h.imports.includes('recharts'));assert.ok(h.imports.includes('@/components/ui/chart'));assert.equal(h.networkCalls(),0);
});
test('phase73 both-null tooltip retains real dates and 0/1 known counts',async()=>{
 const tree=await panelHarness().renderer(),chart=find(tree,'LineChart'),tip=find(tree,'ChartTooltip'),p=chart.props.data[1];assert.equal(tip.props.filterNull,false);
 const rendered=tip.props.content({active:true,payload:[{payload:p}]});assert.match(text(rendered),/当前 · 2026-09-13 · 缺测 已采 0\/1 账号/);assert.match(text(rendered),/比较 · 2026-09-18 · 缺测 已采 0\/1 账号/);
 assert.equal(p.current,null);assert.equal(p.comparison,null);assert.equal(tip.props.content({active:false,payload:[{payload:p}]}),null);
});
test('phase73 estimated view and tooltip remain net-like change times100 not actual plays',async()=>{
 const h=panelHarness();h.setMetric('estimated');const tree=await h.renderer(),chart=find(tree,'LineChart');assert.deepEqual(deep(chart.props.data.map(x=>x.current)),[0,null,-200]);
 assert.match(text(h.reading()),/-200/);assert.match(h.text(),/获赞净变化 × 100 · 非实际播放量/);assert.match(text(find(tree,'ChartTooltip').props.content({active:true,payload:[{payload:chart.props.data[2]}]})),/获赞净变化 × 100 · 非实际播放量/);assert.equal(h.networkCalls(),0);
});
test('phase73 metric control guard and owner comparison/offset callbacks survive extraction',()=>{
 const comparisons=[],offsets=[],h=panelHarness({onComparison:x=>comparisons.push(x),onOffset:x=>offsets.push(x),offset:90});assert.equal(h.deferred(),undefined);
 for(const value of ['',null,'actualPlays','__proto__']){h.setMetric(value);assert.equal(h.byType('ToggleGroup').props.value,'followers');}
 const inputs=h.all().filter(n=>n.type==='Input'&&n.props.type==='date');assert.equal(inputs.length,2);inputs[0].props.onChange({target:{value:'2026-09-16'}});
 assert.deepEqual(deep(comparisons),[{compare:true,otherStart:'2026-09-16',otherEnd:'2026-09-19'}]);assert.deepEqual(offsets,[0]);h.button('关闭区间对比').props.onClick();assert.deepEqual(deep(comparisons.at(-1)),{compare:false,otherStart:'2026-09-17',otherEnd:'2026-09-19'});assert.deepEqual(offsets,[0,0]);assert.equal(h.networkCalls(),0);
});
test('phase73 malformed B retains controls and explanation but no import, chart or export',()=>{
 const h=panelHarness({comparison:{compare:true,otherStart:'2026-09-17',otherEnd:''}});assert.equal(h.deferred(),undefined);assert.equal(h.rendererEvaluations(),0);assert.equal(exportButton(h).props.disabled,true);assert.equal(h.reading(),undefined);assert.equal(h.all().filter(n=>n.type==='Input').length,2);assert.match(h.text(),/比较区间的两个日期/);
});
test('phase73 owner range/readiness updates cannot pair a loaded old curve with new readouts',async()=>{
 const h=panelHarness();await h.renderer();h.render({ready:false,start:'2026-09-17',end:'2026-09-19',pendingError:'新日期读取尚未核对',comparison:{compare:false,otherStart:'',otherEnd:''}});
 assert.equal(h.deferred(),undefined);assert.equal(h.reading(),undefined);assert.equal(exportButton(h).props.disabled,true);assert.match(h.text(),/新日期读取尚未核对/);
 h.render({ready:true,pendingError:''});const tree=await h.renderer();assert.deepEqual(deep(find(tree,'LineChart').props.data.map(x=>x.current)),[0,null,0]);assert.match(text(h.reading()),/当前区间.*2026-09-190/);assert.doesNotMatch(text(h.reading()),/2026-09-14/);assert.equal(h.rendererEvaluations(),1);assert.equal(h.networkCalls(),0);
});
test('phase73 loading/error fallback is real control JSX, preserves truthful table and export',async()=>{
 const h=panelHarness(),loading=h.fallback();assert.ok(nodes(loading).some(n=>n.props.role==='status'));assert.match(text(loading),/加载|读取/);assert.ok(nodes(loading).some(n=>String(n.props.className||'').split(/\s+/).includes('growth-chart')));
 let retries=0;const error=h.fallback({error:new Error('Synthetic chunk rejection'),isLoading:false,retry(){retries++;}});assert.ok(nodes(error).some(n=>n.props.role==='alert'));assert.doesNotMatch(text(error),/Synthetic chunk rejection/);assert.match(text(error),/上方读数、逐日表和导出仍可使用/);const retry=nodes(error).find(n=>n.type==='Button'&&/重试|重新加载/.test(text(n)));assert.ok(retry);retry.props.onClick();assert.equal(retries,1);
 assert.ok(h.byType('TableBody'));assert.ok(h.reading());assert.equal(exportButton(h).props.disabled,false);exportButton(h).props.onClick();assert.ok((await h.blobs[0].text()).includes('a'.repeat(64)));assert.equal(h.networkCalls(),0);
});
test('phase73 fallback and renderer share existing fixed-height class, no fake layout measurement',async()=>{
 const h=panelHarness(),fallback=h.fallback(),renderer=await h.renderer();assert.ok(nodes(fallback).some(n=>String(n.props.className||'').split(/\s+/).includes('growth-chart')));assert.ok(nodes(renderer).some(n=>String(n.props.className||'').split(/\s+/).includes('growth-chart')));
 assert.match(stylesheet,/\.growth-chart\s*\{height:320px!important/);assert.match(stylesheet,/\.growth-chart\s*\{height:250px!important/);assert.match(stylesheet,/@media\(prefers-reduced-motion:reduce\)/);
});
test('phase73 installed ssr:false path returns loading without executing chunk loader',()=>{
 const h=panelHarness();let loads=0;const runtime=lazyRuntime(async()=>{loads++;return{default(){}};},h.config.options.loading,{server:true});const tree=runtime.render({points:[]});assert.equal(loads,0);assert.equal(tree.type,h.config.options.loading);assert.equal(tree.props.error,null);assert.equal(tree.props.isLoading,true);assert.ok(nodes(tree.type(tree.props)).some(n=>n.props.role==='status'));
});
test('phase73 installed client lazy actually suspends then resolves the requested module/props',async()=>{
 const h=panelHarness(),pending=deferred();let loads=0;const renderer=await h.config.loader(),Renderer=renderer.default??renderer;const runtime=lazyRuntime(()=>{loads++;return pending.promise;},h.config.options.loading);
 const props=h.deferred().props,before=runtime.render(props);assert.equal(before.type,h.config.options.loading);assert.equal(loads,0);runtime.mount();const {lazy}=lazyChildren(runtime.render(props));let suspension;
 try{initLazy(lazy);assert.fail('actual pending React.lazy must suspend');}catch(e){suspension=e;}assert.equal(typeof suspension.then,'function');assert.equal(loads,1);assert.equal(lazy.props.points,props.points);
 pending.resolve(renderer);await suspension;assert.equal(initLazy(lazy),Renderer);assert.equal(loads,1);assert.deepEqual(deep(find(initLazy(lazy)(lazy.props),'LineChart').props.data),deep(props.points));
});
test('phase73 installed loader rejection reaches actual boundary/loading retry and creates fresh lazy',async()=>{
 const h=panelHarness(),pending=deferred(),failure=new Error('Synthetic denied chunk');let loads=0;const renderer=await h.config.loader(),Renderer=renderer.default??renderer;const runtime=lazyRuntime(()=>{loads++;return loads===1?pending.promise:Promise.resolve(renderer);},h.config.options.loading);
 runtime.render(h.deferred().props);runtime.mount();const first=lazyChildren(runtime.render(h.deferred().props));let suspension;try{initLazy(first.lazy);}catch(e){suspension=e;}pending.reject(failure);await assert.rejects(suspension,e=>e===failure);assert.throws(()=>initLazy(first.lazy),e=>e===failure);
 const boundary=new first.boundary.type(first.boundary.props);boundary.state={...boundary.state,...first.boundary.type.getDerivedStateFromError(failure)};const fallback=boundary.render();assert.equal(fallback.type,h.config.options.loading);assert.equal(fallback.props.error,failure);assert.equal(fallback.props.isLoading,false);assert.equal(typeof fallback.props.retry,'function');
 const actualFallback=fallback.type(fallback.props);const retry=nodes(actualFallback).find(n=>n.type==='Button'&&/重试|重新加载/.test(text(n)));assert.ok(retry);retry.props.onClick();const second=lazyChildren(runtime.render(h.deferred().props));assert.notEqual(second.lazy.type,first.lazy.type);assert.equal(second.boundary.props.resetKey,first.boundary.props.resetKey+1);assert.deepEqual(deep(second.boundary.type.getDerivedStateFromProps(second.boundary.props,boundary.state)),{error:null,resetKey:1});
 let again;try{initLazy(second.lazy);}catch(e){again=e;}assert.equal(typeof again.then,'function');await again;assert.equal(initLazy(second.lazy),Renderer);assert.equal(loads,2);assert.equal(h.networkCalls(),0);
});
