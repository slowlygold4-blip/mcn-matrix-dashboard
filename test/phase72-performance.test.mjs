// Current production GrowthPanel dependency/conditional-renderer acceptance.
// Runs its real TSX plus real model/export modules. Hook/UI transport is supplied.
// Executes the current owner and extracted renderer synchronously for semantic
// regression. This transport is NOT chunk-load-error, browser layout or timing QA.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';

const site=new URL('../../mcn-public-site/',import.meta.url);
const requireSite=createRequire(new URL('package.json',site));
const ts=requireSite('typescript');
const source=await readFile(new URL('components/growth-panel.tsx',site),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const rendererSource=await readFile(new URL('components/growth-chart.tsx',site),'utf8');
const rendererCompiled=ts.transpileModule(rendererSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const jsx=(type,props,key)=>({type,props:props||{},key});
const text=n=>n==null||typeof n==='boolean'?'':Array.isArray(n)?n.map(text).join(''):typeof n==='object'?text(n.props?.children):String(n);
const nodes=n=>n==null||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)];
const clone=n=>JSON.parse(JSON.stringify(n));
const account={id:1,label:'合成监控账号',platform:'douyin',enabled:true};
const captured=date=>date+'T03:00:00.000Z';
const point=(date,followers,likes=followers,posts=0)=>({targetId:1,date,capturedAt:captured(date),followers,followersAt:followers===null?null:captured(date),likes,likesAt:likes===null?null:captured(date),posts,postsAt:posts===null?null:captured(date)});
const manifest={asOf:'2026-10-01T14:17:26.276Z',timeZone:'Asia/Shanghai',files:[{path:'daily/1.json',kind:'daily',targetId:1,count:4,sha256:'a'.repeat(64)}]};
const basic=()=>({accounts:[account],points:[point('2026-09-12',10,20),point('2026-09-14',8,18),point('2026-09-17',20,30),point('2026-09-19',20,30)],manifest,start:'2026-09-12',end:'2026-09-14',comparison:{compare:true,otherStart:'2026-09-17',otherEnd:'2026-09-19'},offset:0});
function harness(overrides={}){
 let cursor=0,tree,props={...basic(),...overrides},networkCalls=0;const hooks=[],blobs=[],anchors=[],timers=[],exports={},rendererExports={};
 const ownerJsx=(type,props,key)=>type===rendererExports.default?type(props):jsx(type,props,key);
 const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
 const react={useId:()=>"phase114-test-reading",useState(initial){const i=cursor++;if(!(i in hooks))hooks[i]={value:typeof initial==='function'?initial():initial};return[hooks[i].value,next=>{hooks[i].value=typeof next==='function'?next(hooks[i].value):next;}];},useMemo(fn,deps){const i=cursor++;if(!same(hooks[i]?.deps,deps))hooks[i]={value:fn(),deps};return hooks[i].value;}};
 class LocalURL extends URL {static createObjectURL(blob){blobs.push(blob);return 'blob:synthetic-'+blobs.length;}static revokeObjectURL(){}}
 const context={console,Date,Map,Set,Blob,URL:LocalURL,URLSearchParams,
  document:{createElement(tag){assert.equal(tag,'a');const anchor={clicks:0,click(){this.clicks++;}};anchors.push(anchor);return anchor;}},
  setTimeout(fn,ms){timers.push({fn,ms});return timers.length;},
  fetch(){networkCalls++;throw Error('GrowthPanel must not initiate independent business reads');},
  require(spec){if(spec==='react')return react;if(spec==='react/jsx-runtime')return{jsx:ownerJsx,jsxs:ownerJsx,Fragment:'Fragment'};if(spec==='next/dynamic')return{default:()=>rendererExports.default};if(spec==='recharts'||spec.startsWith('@/components/'))return new Proxy({},{get:(_target,key)=>String(key)});if(spec.startsWith('@/lib/'))return requireSite(new URL(spec.slice(2),site).pathname);return requireSite(spec);}};
 vm.runInNewContext(rendererCompiled,{...context,exports:rendererExports});
 vm.runInNewContext(compiled,{...context,exports});
 const api={render(next={}){props={...props,...next};cursor=0;tree=exports.GrowthPanel(props);return tree;},all:()=>nodes(tree),text:()=>text(tree),networkCalls:()=>networkCalls,blobs,anchors,timers};
 api.byType=type=>api.all().find(n=>n.type===type);
 api.button=label=>api.all().find(n=>n.type==='Button'&&text(n)===label);
 api.reading=()=>api.all().find(n=>n.props['aria-label']==='本屏真实末日读数');
 api.setMetric=value=>{api.byType('ToggleGroup').props.onValueChange(value);api.render();};
 api.render();return api;
}
const chart=h=>h.byType('LineChart');
const exportButton=h=>h.button('导出本屏曲线记录');

test('phase72 current owner: unverified range does not mount chart or expose stale reading/export',()=>{
 const h=harness({ready:false,pendingError:'当前日期尚未校验'});
 assert.equal(chart(h),undefined);assert.equal(h.reading(),undefined);assert.equal(h.byType('TableBody'),undefined);
 assert.equal(exportButton(h).props.disabled,true);assert.match(h.text(),/当前日期尚未校验/);assert.equal(h.networkCalls(),0);
});
test('phase72 missing four endpoints stays missing rather than mounting a zero-growth chart',()=>{
 const h=harness({points:[]});assert.equal(chart(h),undefined);assert.equal(exportButton(h).props.disabled,true);
 assert.match(h.text(),/没有同时满足起止端点/);assert.match(text(h.reading()),/缺测/);assert.equal(h.networkCalls(),0);
});
test('phase72 suspended hidden workspace suppresses only chart rendering, not genuine reading or table',()=>{
 const h=harness({suspended:true});assert.equal(chart(h),undefined);assert.ok(h.byType('TableBody'));assert.ok(h.reading());
 assert.match(text(h.reading()),/-2/);assert.equal(exportButton(h).props.disabled,false);assert.equal(h.networkCalls(),0);
});
test('phase72 verified genuine zero is a value, not a no-data loading state',()=>{
 const h=harness({comparison:{compare:false,otherStart:'',otherEnd:''},points:[point('2026-09-12',0),point('2026-09-14',0)]});
 assert.ok(chart(h));assert.deepEqual(clone(chart(h).props.data.map(x=>x.current)),[0,null,0]);
 assert.equal(exportButton(h).props.disabled,false);assert.doesNotMatch(h.text(),/没有同时满足起止端点/);
});
test('phase72 current chart passes real negative and interior null A/B values unchanged to renderer',()=>{
 const h=harness();assert.deepEqual(clone(chart(h).props.data.map(x=>[x.current,x.comparison])),[[0,0],[null,null],[-2,0]]);
 assert.match(text(h.reading()),/当前区间.*2026-09-14-2/);assert.match(text(h.reading()),/比较区间.*2026-09-190/);
 assert.equal(chart(h).props.accessibilityLayer,false);assert.equal(h.networkCalls(),0);
 const accessible=h.all().find(n=>n.props?.className==='trend-point-chart');assert.ok(accessible);assert.equal(accessible.props.tabIndex,0);assert.equal(accessible.props.role,'group');assert.match(accessible.props['aria-label'],/累计净变化曲线.*左右方向键.*Home.*End/);assert.ok(accessible.props['aria-describedby']);for(const event of ['onKeyDown','onFocusCapture','onPointerUp'])assert.equal(typeof accessible.props[event],'function');
});
test('phase72 current renderer does not smooth, fill gaps or animate fictional numbers',()=>{
 const lines=harness().all().filter(n=>n.type==='Line');assert.equal(lines.length,2);
 for(const line of lines){assert.equal(line.props.type,'linear');assert.equal(line.props.connectNulls,false);assert.equal(line.props.isAnimationActive,false);}
});
test('phase72 both-null day keeps real dates/known counts and missing tooltip text',()=>{
 const h=harness(),tip=h.byType('ChartTooltip'),p=chart(h).props.data[1];assert.equal(tip.props.filterNull,false);
 const rendered=tip.props.content({active:true,payload:[{payload:p}]});
 assert.match(text(rendered),/当前 · 2026-09-13 · 缺测 已采 0\/1 账号/);
 assert.match(text(rendered),/比较 · 2026-09-18 · 缺测 已采 0\/1 账号/);
 assert.equal(p.current,null);assert.equal(p.comparison,null);assert.equal(tip.props.content({active:false,payload:[{payload:p}]}),null);
});
test('phase72 estimated metric remains actual net-like change times100 and explicitly not actual plays',()=>{
 const h=harness();h.setMetric('estimated');assert.deepEqual(clone(chart(h).props.data.map(x=>x.current)),[0,null,-200]);
 assert.match(text(h.reading()),/-200/);assert.match(h.text(),/获赞净变化 × 100 · 非实际播放量/);
 const p=chart(h).props.data[2],tip=h.byType('ChartTooltip').props.content({active:true,payload:[{payload:p}]});
 assert.match(text(tip),/获赞净变化 × 100 · 非实际播放量/);assert.equal(h.networkCalls(),0);
});
test('phase72 invalid/empty metric selection does not erase a valid current chart or request new data',()=>{
 const h=harness();const before=clone(chart(h).props.data);for(const value of ['',null,'actualPlays','__proto__']){h.setMetric(value);assert.equal(h.byType('ToggleGroup').props.value,'followers');assert.deepEqual(clone(chart(h).props.data),before);}assert.equal(h.networkCalls(),0);
});
test('phase72 local comparison controls remain outside renderer and reset curve offset through owner callbacks',()=>{
 const comparisons=[],offsets=[],h=harness({onComparison:value=>comparisons.push(value),onOffset:value=>offsets.push(value),offset:90});
 assert.equal(chart(h),undefined,'out-of-window is not a filled chart');
 const inputs=h.all().filter(n=>n.type==='Input'&&n.props.type==='date');assert.equal(inputs.length,2);
 inputs[0].props.onChange({target:{value:'2026-09-16'}});assert.deepEqual(clone(comparisons),[{compare:true,otherStart:'2026-09-16',otherEnd:'2026-09-19'}]);assert.deepEqual(offsets,[0]);
 h.button('关闭区间对比').props.onClick();assert.deepEqual(clone(comparisons.at(-1)),{compare:false,otherStart:'2026-09-17',otherEnd:'2026-09-19'});assert.deepEqual(offsets,[0,0]);
});
test('phase72 malformed comparison keeps readable control/error but hides chart and disables export',()=>{
 const h=harness({comparison:{compare:true,otherStart:'2026-09-17',otherEnd:''}});assert.equal(chart(h),undefined);
 assert.equal(exportButton(h).props.disabled,true);assert.equal(h.reading(),undefined);assert.equal(h.all().filter(n=>n.type==='Input').length,2);assert.match(h.text(),/比较区间的两个日期/);
});
test('phase72 suspended renderer still exports real curve records including source identity and null cells',async()=>{
 const h=harness({suspended:true});assert.equal(chart(h),undefined);exportButton(h).props.onClick();assert.equal(h.blobs.length,1);assert.equal(h.anchors[0].clicks,1);
 assert.equal(h.anchors[0].download,'粉丝-增长曲线.csv');assert.equal(h.blobs[0].type,'text/csv;charset=utf-8');
 const csv=await h.blobs[0].text();assert.match(csv,/fixed-endpoint-cohort-net-change-null-not-zero/);assert.match(csv,/daily\/1\.json/);assert.ok(csv.includes('a'.repeat(64)));assert.match(csv,/2026-09-13/);assert.match(csv,/"-2"/);assert.equal(h.networkCalls(),0);assert.deepEqual(h.timers.map(x=>x.ms),[1000]);
});
