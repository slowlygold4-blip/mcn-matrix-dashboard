// Independent source/controller tests. No browser, server, network, cloud write or production fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {rendererJsx,synchronousGrowthDynamic} from './helpers/growth-renderer-transport.mjs';

const site=new URL('../../mcn-public-site/',import.meta.url);
const requireSite=createRequire(new URL('package.json',site));
const ts=requireSite('typescript');
const paths=['app/page.tsx','components/growth-panel.tsx','components/ui/table.tsx','app/api/replica/route.ts','components/scrollable-table.tsx','components/metric-ledger.tsx','components/coverage-panel.tsx','components/group-summary.tsx'];
// One snapshot per test process: a root edit cannot mix controller versions within one run.
const sources=Object.fromEntries(await Promise.all(paths.map(async path=>[path,await readFile(new URL(path,site),'utf8')])));
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const textOf=x=>x==null||typeof x==='boolean'?'':Array.isArray(x)?x.map(textOf).join(''):typeof x==='object'?textOf(x.props?.children):String(x);
function nodes(x,out=[]){if(!x||typeof x!=='object')return out;if(Array.isArray(x))x.forEach(value=>nodes(value,out));else{out.push(x);nodes(x.props?.children,out);}return out;}
function harness(path,name,props={},address='https://source-review.invalid/#overview',options={}){
 let currentProps=props,cursor=0,stateOrdinal=0,dirty=true,tree,effects=[];
 const hooks=[],fetches=[],exports={},stateNames=[],stateSlots=new Map();
 const sourceTree=ast(path);
 function stateName(node){if(ts.isVariableDeclaration(node)&&ts.isArrayBindingPattern(node.name)&&ts.isCallExpression(node.initializer)&&node.initializer.expression.getText(sourceTree)==='useState')stateNames.push(node.name.elements[0].name.getText(sourceTree));ts.forEachChild(node,stateName);}stateName(sourceTree);
 const react={useId:()=>"phase114-test-reading",
  useState(initial){const index=cursor++,stateName=stateNames[stateOrdinal++];stateSlots.set(stateName,index);if(!hooks[index])hooks[index]={value:Object.hasOwn(options.initialState||{},stateName)?options.initialState[stateName]:typeof initial==='function'?initial():initial};return [hooks[index].value,value=>{const next=typeof value==='function'?value(hooks[index].value):value;if(!Object.is(next,hooks[index].value)){hooks[index].value=next;dirty=true;}}];},
  useRef(initial){const index=cursor++;return hooks[index]??(hooks[index]={current:initial});},
  useMemo(fn){cursor++;return fn();},
  useEffect(fn,deps){const index=cursor++,old=hooks[index];if(!old||deps.some((value,i)=>!Object.is(value,old.deps[i]))){hooks[index]={deps,cleanup:old?.cleanup};effects.push(()=>{old?.cleanup?.();hooks[index].cleanup=fn();});}},
 };
 const jsx=rendererJsx;
 const location=new URL(address);
 const context={exports,URL,URLSearchParams,AbortController,Blob,Date,Map,Set,Promise,console,
  window:{location,scrollY:0,scrollTo(){},addEventListener(){},removeEventListener(){},history:{replaceState(_state,_title,next){location.href=new URL(next,location.href).href;},pushState(_state,_title,next){location.href=new URL(next,location.href).href;}}},
  document:{visibilityState:'visible',activeElement:null,querySelector:()=>null},
  requestAnimationFrame:fn=>{fn();return 1;},setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},
  fetch:async(...args)=>{fetches.push(args);if(options.fetcher)return options.fetcher(...args);throw Error('network unavailable in independent test');},
  require(specifier){
   if(specifier==='react')return react;
   if(specifier==='next/dynamic')return {default:synchronousGrowthDynamic};
   if(specifier==='react/jsx-runtime')return {jsx,jsxs:jsx,Fragment:'Fragment'};
   if(specifier==='recharts'||specifier==='lucide-react'||specifier.startsWith('@/components/'))return new Proxy({}, {get:(_target,key)=>String(key)});
   if(specifier==='@/lib/utils')return {cn:(...parts)=>parts.filter(Boolean).join(' ')};
   if(specifier.startsWith('@/lib/'))return requireSite(new URL(specifier.slice(2),site).pathname);
   return requireSite(specifier);
  },
 };
 vm.runInNewContext(compile(sources[path]),context,{filename:'phase60-'+path});
 function render(next={}){currentProps={...currentProps,...next};cursor=0;stateOrdinal=0;dirty=false;tree=exports[name](currentProps);return tree;}
 return {render,fetches,all:()=>nodes(tree),text:()=>textOf(tree),state:name=>hooks[stateSlots.get(name)]?.value,
  async flush(){for(let pass=0;pass<20;pass++){if(dirty)render();const queue=effects;effects=[];queue.forEach(fn=>fn());await new Promise(resolve=>setTimeout(resolve,0));if(!dirty&&!effects.length)return tree;}throw Error('controller did not settle');},
  close(){hooks.forEach(hook=>hook?.cleanup?.());},
 };
}

const account={id:91,label:'独立合成账号',platform:'douyin',enabled:true,boardKeys:['peer'],classification:{theme:{key:'peer',label:'独立合成主题'},labels:[]}};
const sample=(date,followers,likes=followers)=>({targetId:91,date,capturedAt:date+'T03:00:00.000Z',followers,likes,posts:0});
const points=[sample('2026-09-12',10,20),sample('2026-09-13',10,0),sample('2026-09-14',8,5)];
const curveProps={accounts:[account],points,manifest:{asOf:'2026-10-01T07:00:00.000Z'},start:'2026-09-12',end:'2026-09-14',comparison:{compare:false,otherStart:'',otherEnd:''},offset:0};
const exportButton=h=>{const button=h.all().find(node=>node.type==='Button'&&textOf(node)==='导出本屏曲线记录');assert.ok(button,'the real curve export control must exist');return button;};

test('phase60 pending or failed date receipts never render stale curve values or enable export',()=>{
 for(const pendingError of ['', '日期分区校验失败']){
  const h=harness('components/growth-panel.tsx','GrowthPanel',{...curveProps,ready:false,pendingError});h.render();
  assert.equal(h.all().filter(node=>node.type==='ChartContainer').length,0);
  assert.equal(exportButton(h).props.disabled,true);
  assert.match(h.text(),pendingError?new RegExp(pendingError):/正在|核对|读取/);
 }
});

test('phase60 real rendered line retains zero, negative changes and unsmoothed missing days',()=>{
 const h=harness('components/growth-panel.tsx','GrowthPanel',curveProps);h.render();
 const chart=h.all().find(node=>node.type==='LineChart');assert.ok(chart);
 assert.deepEqual(Array.from(chart.props.data,point=>point.current),[0,0,-2]);
 assert.equal(exportButton(h).props.disabled,false);
 for(const line of h.all().filter(node=>node.type==='Line')){assert.equal(line.props.connectNulls,false);assert.equal(line.props.isAnimationActive,false);}
 h.render({points:points.filter(point=>point.date!=='2026-09-13')});
 assert.deepEqual(Array.from(h.all().find(node=>node.type==='LineChart').props.data,point=>point.current),[0,null,-2]);
});

test('phase60 incomplete comparison and empty endpoint cohort stay explicit and non-exportable',()=>{
 for(const update of [{comparison:{compare:true,otherStart:'2026-09-12',otherEnd:''}},{points:[]},{start:'2026-09-14',end:'2026-09-12'}]){
  const h=harness('components/growth-panel.tsx','GrowthPanel',{...curveProps,...update});h.render();
  assert.equal(h.all().filter(node=>node.type==='ChartContainer').length,0);
  assert.equal(exportButton(h).props.disabled,true);
  assert.match(h.text(),/比较区间|没有同时满足|无效/);
 }
});

test('phase60 hiding and restoring a valid chart preserves its selected metric and comparison state',()=>{
 const comparison={compare:true,otherStart:'2026-09-12',otherEnd:'2026-09-14'};
 const h=harness('components/growth-panel.tsx','GrowthPanel',{...curveProps,comparison,suspended:false});h.render();
 const select=h.all().find(node=>node.type==='ToggleGroup'&&node.props.value==='followers');assert.ok(select);
 select.props.onValueChange('likes');h.render();
 const before=h.all().find(node=>node.type==='LineChart');assert.ok(before);
 assert.deepEqual(Array.from(before.props.data,point=>point.current),[0,-20,-15]);
 h.render({suspended:true});
 assert.equal(h.all().filter(node=>node.type==='ChartContainer').length,0,'hidden workspace must not retain a measuring chart');
 h.render({suspended:false});
 const after=h.all().find(node=>node.type==='LineChart');assert.ok(after);
 assert.deepEqual(Array.from(after.props.data,point=>[point.current,point.comparison]),[[0,0],[-20,-20],[-15,-15]]);
 assert.ok(h.all().some(node=>node.type==='ToggleGroup'&&node.props.value==='likes'));
 assert.ok(h.all().some(node=>node.type==='Input'&&node.props.value===comparison.otherStart));
});

function ast(path){return ts.createSourceFile(path,sources[path],ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);}
function findNode(root,predicate){let found;function visit(node){if(!found&&predicate(node))found=node;if(!found)ts.forEachChild(node,visit);}visit(root);assert.ok(found,'actual source expression was not found');return found;}
function variable(path,name){const root=ast(path);return findNode(root,node=>ts.isVariableDeclaration(node)&&node.name.getText(root)===name).initializer.getText(root);}
function evaluate(expression,context){const code=compile('exports.value=('+expression+');'),exports={};vm.runInNewContext(code,{...context,exports});return exports.value;}

test('phase60 indexed dates become ready only for the exact completed request receipt',()=>{
 const expression=variable('app/page.tsx','rangeReady');
 const cases=[
  {data:{dateIndexed:true,receipt:{requestKey:'A'}},requestedRange:{key:'A'},dateValidationError:'',expected:true},
  {data:{dateIndexed:true,receipt:{requestKey:'A'}},requestedRange:{key:'B'},dateValidationError:'',expected:false},
  {data:{dateIndexed:true},requestedRange:{key:'A'},dateValidationError:'',expected:false},
  {data:{dateIndexed:true,receipt:{requestKey:'A'}},requestedRange:null,dateValidationError:'',expected:false},
  {data:{dateIndexed:true,receipt:{requestKey:'A'}},requestedRange:{key:'A'},dateValidationError:'日期无效',expected:false},
  {data:{dateIndexed:false},requestedRange:null,dateValidationError:'日期无效',expected:false},
 ];
 for(const {expected,...context} of cases)assert.equal(evaluate(expression,context),expected);
});

test('phase60 changing a period draft alone never changes true endpoints or committed data',()=>{
 const root=ast('app/page.tsx');
 const select=findNode(root,node=>(ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node))&&node.tagName.getText(root)==='select'&&node.attributes.properties.some(p=>ts.isJsxAttribute(p)&&p.name.getText(root)==='value'&&p.initializer?.getText(root)==='{periodDraft}'));
 const handler=select.attributes.properties.find(p=>ts.isJsxAttribute(p)&&p.name.getText(root)==='onChange').initializer.expression.getText(root);
 const calls=[];const context=Object.fromEntries(['setPeriodDraft','setStart','setEnd','setData'].map(name=>[name,value=>calls.push([name,value])]));
 evaluate(handler,context)({target:{value:'week'}});
 assert.deepEqual(calls,[['setPeriodDraft','week']]);
});

test('phase60 invalid initial link finishes routing without a phantom loading state',async()=>{
 const h=harness('app/page.tsx','default',{},'https://source-review.invalid/?period=custom&start=2026-09-31&end=2026-10-01#overview');
 try{await h.flush();assert.equal(h.fetches.length,0,'invalid links must fail before source requests');assert.match(h.text(),/链接日期|日期不完整|日期.*无效/);assert.doesNotMatch(h.text(),/正在读取真实保存记录|正在读取已保存数据/);}finally{h.close();}
});

test('phase60 initial source loading and failure have distinct honest retry states',async()=>{
 let rejectRead;const pending=new Promise((_resolve,reject)=>{rejectRead=reject;});
 const h=harness('app/page.tsx','default',{},'https://source-review.invalid/#overview',{fetcher:()=>pending});
 try{
  await h.flush();assert.equal(h.fetches.length,1);assert.equal(h.state('loading'),true);
  const busy=h.all().find(node=>node.type==='Button'&&/读取中/.test(textOf(node)));assert.ok(busy);assert.equal(busy.props.disabled,true);
  rejectRead(new Error('synthetic initial source failure'));await h.flush();
  assert.equal(h.state('loading'),false);assert.match(h.state('error'),/synthetic initial source failure/);
  const retry=h.all().find(node=>node.type==='Button'&&textOf(node)==='刷新已发布数据');assert.ok(retry);assert.equal(retry.props.disabled,false);
  assert.doesNotMatch(h.text(),/正在读取真实保存记录|正在读取已保存数据/);
 }finally{h.close();}
});

const generation='2026-10-01T07:00:00.000Z';
const personalRequest={id:91,start:curveProps.start,end:curveProps.end,generation};
function published(asOf=generation){return {manifest:{asOf,counts:{enabledAccounts:1,daily:3},files:[]},publishedAt:asOf,accounts:[account],boards:[{key:'peer',name:'独立合成矩阵'}],points,topics:{topics:[],items:[]},summaryLoaded:true,dateIndexed:false};}
const personalAddress='https://source-review.invalid/?'+new URLSearchParams({account:'91',start:curveProps.start,end:curveProps.end,generation});

test('phase60 same-publication refresh failure retains the verified personal component identity and dates',async()=>{
 const data=published(),h=harness('app/page.tsx','default',{},personalAddress,{initialState:{data,loading:false,personal:personalRequest,start:curveProps.start,end:curveProps.end}});
 try{
  await h.flush();const before=h.all().find(node=>node.type==='AccountPanel');assert.ok(before);
  const refresh=h.all().find(node=>node.type==='Button'&&textOf(node)==='刷新已发布数据');assert.ok(refresh);refresh.props.onClick();await h.flush();
  assert.equal(h.fetches.length,1);assert.equal(h.fetches[0][1].method??'GET','GET');assert.equal(new Headers(h.fetches[0][1].headers).has('Authorization'),false);assert.match(h.state('error'),/network unavailable/);assert.equal(h.state('loading'),false);assert.equal(h.state('data'),data);
  const after=h.all().find(node=>node.type==='AccountPanel');assert.ok(after,'refresh failure must not unmount the verified personal workspace');
  assert.equal(after.key,before.key);assert.equal(after.props.manifest,before.props.manifest);assert.deepEqual({...after.props.request},{...before.props.request});
  assert.match(h.text(),/保留|已加载|已核验/);
 }finally{h.close();}
});

test('phase60 failed fixed-publication lookup never reuses an account panel from another publication',async()=>{
 const data=published('2026-10-01T06:00:00.000Z'),h=harness('app/page.tsx','default',{},personalAddress,{initialState:{data,loading:false,personal:personalRequest,start:curveProps.start,end:curveProps.end}});
 try{await h.flush();assert.ok(h.fetches.length>=1);assert.equal(h.all().filter(node=>node.type==='AccountPanel').length,0);assert.equal(h.state('data').manifest.asOf,'2026-10-01T06:00:00.000Z');}finally{h.close();}
});

test('phase60 Home keeps global state mounted but suspends its measuring chart for personal and invalid routes',async()=>{
 for(const [address,expected] of [['https://source-review.invalid/#overview',false],[personalAddress,true],['https://source-review.invalid/?period=custom&start=2026-09-31&end=2026-10-01',true]]){
  const h=harness('app/page.tsx','default',{},address,{initialState:{data:published(),loading:false,start:curveProps.start,end:curveProps.end}});
  try{await h.flush();const growth=h.all().find(node=>node.type==='GrowthPanel');assert.ok(growth,'preserved global controller must keep its local choices mounted');assert.equal(growth.props.suspended,expected);}finally{h.close();}
 }
});

test('phase60 account navigation changes actual sibling order while preserving chart key, comparison, filters and page',async()=>{
 const data=published();data.accounts=Array.from({length:45},(_,index)=>({...account,id:91+index,label:'合成作者'+index}));data.points=data.accounts.flatMap(a=>points.map(point=>({...point,targetId:a.id})));data.manifest.counts={enabledAccounts:45,daily:135};
 const comparison={compare:true,otherStart:curveProps.start,otherEnd:curveProps.end};
 const h=harness('app/page.tsx','default',{},'https://source-review.invalid/#overview',{initialState:{data,loading:false,start:curveProps.start,end:curveProps.end,comparison}});
 const snapshot=()=>{
  const growth=h.all().find(node=>node.type==='GrowthPanel'),table=h.all().find(node=>node.key==='workspace-accounts');assert.ok(growth);assert.ok(table);
  const parent=h.all().find(node=>{const direct=[node.props?.children].flat(Infinity);return direct.includes(growth)&&direct.includes(table);});assert.ok(parent,'chart and table must remain keyed siblings of the same parent');
  const siblings=[parent.props.children].flat(Infinity);return {growth,parentType:parent.type,growthIndex:siblings.indexOf(growth),tableIndex:siblings.indexOf(table)};
 };
 try{
  await h.flush();const search=h.all().find(node=>node.type==='Input'&&node.props['aria-label']==='搜索作者');search.props.onChange({target:{value:'合成'}});await h.flush();
  h.all().find(node=>node.type==='Button'&&textOf(node)==='下一页').props.onClick();await h.flush();assert.equal(h.state('page'),2);
  const overview=snapshot();assert.ok(overview.growthIndex<overview.tableIndex);assert.equal(overview.growth.key,'workspace-growth');
  const child=harness('components/growth-panel.tsx','GrowthPanel',overview.growth.props);child.render();child.all().find(node=>node.type==='ToggleGroup').props.onValueChange('likes');child.render();
  h.all().find(node=>node.type==='Button'&&textOf(node)==='账号明细').props.onClick();await h.flush();
  const accounts=snapshot();assert.ok(accounts.tableIndex<accounts.growthIndex);assert.equal(accounts.parentType,overview.parentType);assert.equal(accounts.growth.key,overview.growth.key);assert.equal(accounts.growth.props.comparison,comparison);assert.equal(h.state('query'),'合成');assert.equal(h.state('page'),2);
  child.render(accounts.growth.props);assert.ok(child.all().some(node=>node.type==='ToggleGroup'&&node.props.value==='likes'));
  h.all().find(node=>node.type==='Button'&&textOf(node)==='经营总览').props.onClick();await h.flush();const returned=snapshot();assert.ok(returned.growthIndex<returned.tableIndex);assert.equal(returned.growth.key,overview.growth.key);assert.equal(h.state('page'),2);assert.equal(h.state('query'),'合成');assert.equal(h.fetches.length,0);child.close();
 }finally{h.close();}
});

test('phase60 scrollable data table names its focusable region and moves the actual inner overflow owner',()=>{
 const h=harness('components/scrollable-table.tsx','ScrollableTable',{scrollLabel:'账号全部指标',className:'peer-table','aria-label':'账号数据',children:'synthetic table rows'});h.render();
 const region=h.all().find(node=>node.props?.role==='region');assert.ok(region);assert.equal(region.props.tabIndex,0);assert.equal(region.props['aria-label'],'账号全部指标');
 assert.match(h.text(),/左右滑动|横向/);assert.match(h.text(),/键盘/);
 const table=h.all().find(node=>node.type==='Table');assert.ok(table);assert.match(table.props.className,/peer-table/);assert.equal(table.props['aria-label'],'账号数据');assert.equal(table.props.children,'synthetic table rows');
 for(const [key,method,left] of [['ArrowLeft','scrollBy',-120],['ArrowRight','scrollBy',120],['Home','scrollTo',0],['End','scrollTo',850]]){
  let prevented=0,queried=0;const calls=[];
  const area={scrollWidth:850,clientWidth:350,scrollBy:options=>calls.push(['scrollBy',options.left]),scrollTo:options=>calls.push(['scrollTo',options.left])};
  const outer={querySelector:selector=>{assert.equal(selector,'[data-slot="table-container"]');queried++;return area;},scrollBy:()=>assert.fail('outer shell must not receive scroll'),scrollTo:()=>assert.fail('outer shell must not receive scroll')};
  region.props.onKeyDown({key,currentTarget:outer,target:outer,preventDefault:()=>prevented++});
  assert.equal(queried,1);assert.equal(prevented,1);assert.deepEqual(calls,[[method,left]]);
 }
});

test('phase60 table keyboard handling leaves child controls, modifiers, vertical keys and fitting tables alone',()=>{
 const h=harness('components/scrollable-table.tsx','ScrollableTable');h.render();const keyDown=h.all().find(node=>node.props?.role==='region').props.onKeyDown;
 const cases=[{child:true},{ctrlKey:true},{metaKey:true},{altKey:true},{shiftKey:true},{key:'ArrowDown'},{key:'PageDown'},{key:'Tab'},{clientWidth:850},{clientWidth:1000},{missing:true}];
 for(const value of cases){
  let prevented=0,moved=0;const area={scrollWidth:850,clientWidth:value.clientWidth??350,scrollBy:()=>moved++,scrollTo:()=>moved++};
  const outer={querySelector:()=>value.missing?null:area};
  keyDown({key:'ArrowRight',currentTarget:outer,target:value.child?{}:outer,...value,preventDefault:()=>prevented++});
  assert.equal(prevented,0,JSON.stringify(value));assert.equal(moved,0,JSON.stringify(value));
 }
});

function metricCells(h){return Object.fromEntries(h.all().filter(node=>node.type==='article').map(article=>{const descendants=nodes(article);return [textOf(descendants.find(node=>node.props?.className==='metric-cell__label')),{value:textOf(descendants.find(node=>node.type==='strong')),note:textOf(descendants.find(node=>node.props?.className==='metric-cell__note')),tone:descendants.find(node=>node.type==='strong').props.className}];}));}

test('phase60 ledger separates stock from changes and preserves null, zero, negative and metric-specific denominators',()=>{
 const metrics={followers:{value:0,delta:-12,knownCount:1,comparableCount:1},likes:{value:null,delta:null,knownCount:0,comparableCount:0},posts:{value:2,delta:0,knownCount:2,comparableCount:1}};
 const h=harness('components/metric-ledger.tsx','MetricLedger',{metrics,count:3,start:curveProps.start,end:curveProps.end});h.render();
 assert.deepEqual(h.all().filter(node=>node.type==='h2').map(textOf),['终点已采合计','区间净变化']);
 const cells=metricCells(h);assert.equal(Object.keys(cells).length,7);
 assert.deepEqual(Object.fromEntries(Object.entries(cells).map(([label,cell])=>[label,cell.value])),{'粉丝存量':'0','获赞存量':'—','作品存量':'2','粉丝净变化':'-12','点赞净变化':'—','估算播放变化':'—','作品存量净变化':'0'});
 assert.equal(cells['粉丝存量'].note,'已采 1/3 账号');assert.equal(cells['作品存量'].note,'已采 2/3 账号');assert.equal(cells['作品存量净变化'].note,'可比 1/3 账号');assert.equal(cells['估算播放变化'].note,'可比 0/3 账号');
 assert.match(cells['粉丝净变化'].tone,/negative/);assert.doesNotMatch(cells['作品存量净变化'].tone,/negative|positive/);
 h.render({metrics:{...metrics,likes:{value:101,delta:-1,knownCount:2,comparableCount:1}}});
 assert.equal(metricCells(h)['估算播放变化'].value,'-100');assert.equal(metricCells(h)['估算播放变化'].note,'可比 1/3 账号');assert.match(h.text(),/非平台实际播放量/);assert.match(h.text(),/作品净变化不等于新发布量/);
});

test('phase60 single-account fallback counts still recognise observed zeros while empty scope stays unknown',()=>{
 const h=harness('components/metric-ledger.tsx','MetricLedger',{metrics:{followers:{value:0,delta:0},likes:{value:3,delta:1},posts:{value:null,delta:null}},count:1,start:curveProps.start,end:curveProps.end});h.render();
 const cells=metricCells(h);assert.equal(cells['粉丝存量'].note,'已采 1/1 账号');assert.equal(cells['粉丝净变化'].note,'可比 1/1 账号');assert.equal(cells['作品存量'].note,'已采 0/1 账号');assert.equal(cells['估算播放变化'].value,'+100');
 h.render({metrics:{},count:0});assert.ok(Object.values(metricCells(h)).every(cell=>cell.value==='—'&&/0\/0/.test(cell.note)));assert.doesNotMatch(h.text(),/NaN|Infinity/);
});

test('phase60 compressed coverage keeps profile, complete works and topic denominators separate as evidence ages',()=>{
 const old='2026-09-30T22:00:00.000Z',coverage=(profileObservedAt,status,observedAt)=>({version:1,profileObservedAt,works:{status,attemptedAt:observedAt,observedAt}});
 const accounts=[{...account,coverage:coverage(generation,'complete',generation)},{...account,id:92,label:'有限作品',coverage:coverage(null,'limited',generation)},{...account,id:93,label:'超时旧采样',coverage:coverage(old,'complete',old)},{...account,id:94,enabled:false,coverage:coverage(generation,'complete',generation)}];
 const topics={topics:[{id:1,enabled:true},{id:2,enabled:true},{id:3,enabled:false}],items:[1,2,3].map(targetId=>({targetId,capturedAt:generation,metricsEvidence:'topic-identity-source-run-time-vector-bound',qualityStatus:'validated',participants:targetId===2?null:0,views:0,sourceChecksum:'a'.repeat(64)}))};
 const selected=[],h=harness('components/coverage-panel.tsx','CoveragePanel',{accounts,topics,asOf:generation,onAccount:a=>selected.push(a.id)},undefined,{initialState:{now:Date.parse(generation)+3600000}});h.render();
 const summary=textOf(h.all().find(node=>node.type==='summary'));assert.match(summary,/主页三指标 1\/3/);assert.match(summary,/作品完整 1\/3/);assert.match(summary,/话题双指标 1\/2/);
 h.all().find(node=>node.type==='Button'&&textOf(node)==='有限作品').props.onClick();assert.deepEqual(selected,[92]);
 const later=harness('components/coverage-panel.tsx','CoveragePanel',{accounts,topics,asOf:generation,onAccount(){}},undefined,{initialState:{now:Date.parse(generation)+9*3600000}});later.render();
 const staleSummary=textOf(later.all().find(node=>node.type==='summary'));assert.match(staleSummary,/主页三指标 0\/3/);assert.match(staleSummary,/作品完整 0\/3/);assert.match(staleSummary,/话题双指标 0\/2/);
 assert.match(later.text(),/主页 1\/3 · 作品完整 1\/3 · 话题双指标 1\/2/);assert.match(later.text(),/刚发布不代表刚采样/);
});

test('phase60 author and category name sorting expose the actual ascending and descending state',async()=>{
 for(const [path,name,props,address,options,label] of [
  ['app/page.tsx','default',{},'https://source-review.invalid/#accounts',{initialState:{data:published(),loading:false,start:curveProps.start,end:curveProps.end}},'作者'],
  ['components/group-summary.tsx','GroupSummary',{rows:[],start:curveProps.start,end:curveProps.end,onSelect(){}},undefined,{},'分类'],
 ]){
  const h=harness(path,name,props,address,options);
  try{await h.flush();for(const [direction,arrow] of [['descending','↓'],['ascending','↑']]){
   const button=h.all().find(node=>node.type==='Button'&&textOf(node).startsWith(label));assert.ok(button);button.props.onClick();await h.flush();
   const head=h.all().find(node=>node.type==='TableHead'&&textOf(node).startsWith(label));assert.ok(head);assert.equal(head.props['aria-sort'],direction);assert.ok(textOf(head).includes(arrow));
  }}finally{h.close();}
 }
});

test('phase60 anonymous and malformed producer authority are rejected before body or storage access',async()=>{
 for(const producer of [undefined,null,false,17,{},'', 'p'.repeat(47),'p'.repeat(48)]){
  for(const authorization of [null,'Bearer other',producer===undefined?'Bearer undefined':'Bearer '+String(producer)]){
   if(typeof producer==='string'&&producer.length>=48&&authorization==='Bearer '+producer)continue;
   let bodyReads=0,storageReads=0;const exports={};
   const env={REPLICA_INGEST_SECRET:producer};
   Object.defineProperties(env,{DB:{get(){storageReads++;throw Error('storage must not be touched');}},BUCKET:{get(){storageReads++;throw Error('storage must not be touched');}}});
   vm.runInNewContext(compile(sources['app/api/replica/route.ts']),{exports,Response,URL,Date,TextEncoder,crypto,
    require(specifier){if(specifier==='cloudflare:workers')return {env};if(specifier.startsWith('@/lib/'))return requireSite(new URL(specifier.slice(2),site).pathname);throw Error('unexpected import '+specifier);},
   });
   const response=await exports.POST({headers:{get:name=>{assert.equal(name,'Authorization');return authorization;}},text:async()=>{bodyReads++;throw Error('body must not be read');}});
   assert.equal(response.status,403);assert.deepEqual(await response.json(),{error:'只读访问'});assert.equal(bodyReads,0);assert.equal(storageReads,0);
  }
 }
});
