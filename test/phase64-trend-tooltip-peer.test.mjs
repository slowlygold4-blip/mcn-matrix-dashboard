// Independent source/dependency execution. This is not a DOM, browser, hydration,
// pointer-positioning, visual-layout, or real-user accessibility acceptance test.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {rendererJsx,synchronousGrowthDynamic} from './helpers/growth-renderer-transport.mjs';

const site=new URL('../../mcn-public-site/',import.meta.url),requireSite=createRequire(new URL('package.json',site));
const ts=requireSite('typescript'),postcss=requireSite('postcss');
const {combineTooltipPayload}=requireSite(new URL('node_modules/recharts/lib/state/selectors/combiners/combineTooltipPayload.js',site).pathname);
const {arrayTooltipSearcher}=requireSite(new URL('node_modules/recharts/lib/state/optionsSlice.js',site).pathname);
const paths=['components/growth-panel.tsx','components/metric-ledger.tsx','components/ui/toggle-group.tsx','components/ui/toggle.tsx','app/page.tsx','app/replica.css'];
const sources=Object.fromEntries(await Promise.all(paths.map(async p=>[p,await readFile(new URL(p,site),'utf8')])));
const tooltipPath=new URL('node_modules/recharts/lib/component/Tooltip.js',site),boxPath=new URL('node_modules/recharts/lib/component/TooltipBoundingBox.js',site),rovingPath=new URL('node_modules/@radix-ui/react-roving-focus/dist/index.js',site);
const [tooltipSource,boxSource,rovingSource]=await Promise.all([tooltipPath,boxPath,rovingPath].map(p=>readFile(p,'utf8')));
const jsx=rendererJsx;
const text=x=>x==null||typeof x==='boolean'?'':Array.isArray(x)?x.map(text).join(''):typeof x==='object'?text(x.props?.children):String(x);
function nodes(x,out=[]){if(!x||typeof x!=='object')return out;if(Array.isArray(x))x.forEach(n=>nodes(n,out));else{out.push(x);nodes(x.props?.children,out);}return out;}
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
function component(path,name,initial){
 let cursor=0,tree,props=initial;const hooks=[],exports={};
 const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
 const react={useId:()=>"phase114-test-reading",useState(value){const i=cursor++;if(!(i in hooks))hooks[i]={value:typeof value==='function'?value():value};return[hooks[i].value,next=>hooks[i].value=typeof next==='function'?next(hooks[i].value):next];},useMemo(fn,deps){const i=cursor++;if(!same(hooks[i]?.deps,deps))hooks[i]={deps,value:fn()};return hooks[i].value;}};
 vm.runInNewContext(compile(sources[path]),{exports,URL,URLSearchParams,Blob,Date,Map,Set,console,require(spec){if(spec==='next/dynamic')return {default:synchronousGrowthDynamic};if(spec==='react')return react;if(spec==='react/jsx-runtime')return{jsx,jsxs:jsx,Fragment:'Fragment'};if(spec==='recharts'||spec.startsWith('@/components/'))return new Proxy({}, {get:(_t,k)=>String(k)});if(spec.startsWith('@/lib/'))return requireSite(new URL(spec.slice(2),site).pathname);return requireSite(spec);}});
 const api={render(next={}){props={...props,...next};cursor=0;tree=exports[name](props);return tree;},all:()=>nodes(tree),text:()=>text(tree)};api.render();return api;
}

// Execute the installed Recharts Tooltip and BoundingBox unchanged. Only hooks,
// Redux selectors, layout measurement and portal transport are supplied by the test.
// Payload filtering, default props, content forwarding and visibility remain real.
function installedTooltip(props,payload,{active=true,label=0,reducedMotion=false}={}){
 const fakeReact={createElement(type,p,...children){return jsx(type,{...p,...(children.length?{children:children.length===1?children[0]:children}:{})});},Fragment:'Fragment',isValidElement:x=>!!x&&typeof x==='object'&&'type'in x,cloneElement:(x,p)=>jsx(x.type,{...x.props,...p}),useEffect(){},useState:value=>[typeof value==='function'?value():value,()=>{}],memo:fn=>fn};
 function load(path,source,mocks){const module={exports:{}},localRequire=createRequire(path);vm.runInNewContext(source,{module,exports:module.exports,require:spec=>Object.hasOwn(mocks,spec)?mocks[spec]:localRequire(spec)});return module.exports;}
 const box=load(boxPath,boxSource,{'react':fakeReact,'../util/usePrefersReducedMotion':{usePrefersReducedMotion:()=>reducedMotion}});
 const Tooltip=load(tooltipPath,tooltipSource,{
  react:fakeReact,'react-dom':{createPortal:(children,target)=>jsx('Portal',{children,target})},'./TooltipBoundingBox':box,
  '../context/chartLayoutContext':{useViewBox:()=>({x:0,y:0,width:600,height:300})},'../context/accessibilityContext':{useAccessibilityLayer:()=>true},
  '../util/useElementOffset':{useElementOffset:()=>[{width:200,height:80},()=>{}]},'../context/tooltipPortalContext':{useTooltipPortal:()=>({syntheticPortal:true})},
  '../state/hooks':{useAppDispatch:()=>()=>{},useAppSelector:fn=>fn({})},'../state/tooltipSlice':{setTooltipSettingsState:x=>x},
  '../state/selectors/selectors':{selectIsTooltipActive:()=>({activeIndex:String(label),isActive:active}),selectTooltipPayload:()=>payload,selectActiveLabel:()=>label,selectActiveCoordinate:()=>({x:80,y:50})},
  '../synchronisation/useChartSynchronisation':{useTooltipChartSynchronisation(){}},'../state/selectors/selectTooltipEventType':{useTooltipEventType:()=> 'axis'},
 });
 const tree=Tooltip.Tooltip(props),boxNode=nodes(tree).find(n=>n.type===box.TooltipBoundingBox);assert.ok(boxNode,'real Tooltip must create its bounding box');
 const contentNode=boxNode.props.children,rendered=typeof contentNode.type==='function'?contentNode.type(contentNode.props):contentNode;
 return{defaults:Tooltip.defaultTooltipProps,contentProps:contentNode.props,rendered,box:box.TooltipBoundingBox(boxNode.props),boxProps:boxNode.props};
}

const account={id:1,label:'合成账号',enabled:true},point=(date,followers,likes=followers)=>({targetId:1,date,capturedAt:date+'T03:00:00.000Z',followers,likes,posts:0});
const basic=()=>({accounts:[account],points:[point('2026-09-12',10,20),point('2026-09-14',8,18),point('2026-09-17',20,30),point('2026-09-19',20,30)],manifest:{asOf:'2026-10-01T05:44:51.113Z'},start:'2026-09-12',end:'2026-09-14',comparison:{compare:true,otherStart:'2026-09-17',otherEnd:'2026-09-19'}});
const chart=props=>component(paths[0],'GrowthPanel',props||basic());
const byType=(h,type)=>h.all().find(n=>n.type===type),chartPoint=(h,day)=>byType(h,'LineChart').props.data.find(p=>p.day===day);
function payloadFor(h,p){
 const chartData=byType(h,'LineChart').props.data,configurations=h.all().filter(n=>n.type==='Line').map(n=>({settings:{dataKey:n.props.dataKey,name:n.props.name,hide:!!n.props.hide}}));
 return combineTooltipPayload(configurations,String(chartData.indexOf(p)),{chartData,computedData:undefined,dataStartIndex:0,dataEndIndex:chartData.length-1},'day',p.day,arrayTooltipSearcher,'axis');
}
const tooltip=(h,day,overrides={})=>installedTooltip({...byType(h,'ChartTooltip').props,...overrides},payloadFor(h,chartPoint(h,day)),{label:day});
const tooltipRows=r=>nodes(r.rendered).filter(n=>n.type==='p').map(text);

test('phase64 unchanged installed Recharts reproduces the old double-null hidden-tooltip bug as a negative control',()=>{
 const h=chart(),p=chartPoint(h,1);assert.equal(p.current,null);assert.equal(p.comparison,null);
 const old=tooltip(h,1,{filterNull:undefined});
 assert.equal(old.defaults.filterNull,true);assert.equal(old.contentProps.payload.length,0);assert.equal(old.boxProps.hasPayload,false);assert.equal(old.box.props.style.visibility,'hidden');
 assert.equal(old.rendered,null,'old callback cannot read payload[0] after actual library filtering');
});

test('phase64 current production tooltip keeps both-null dates and coverage visible without filling the curve',()=>{
 const h=chart(),r=tooltip(h,1);
 assert.equal(r.box.props.style.visibility,'visible','both missing observations must still have a readable tooltip');
 assert.equal(r.contentProps.payload.length,2);assert.equal(r.boxProps.hasPayload,true);
 assert.deepEqual(tooltipRows(r),['当前 · 2026-09-13 · 缺测 已采 0/1 账号','比较 · 2026-09-18 · 缺测 已采 0/1 账号']);
 assert.equal(chartPoint(h,1).current,null);assert.equal(chartPoint(h,1).comparison,null);
 for(const line of h.all().filter(n=>n.type==='Line')){assert.equal(line.props.connectNulls,false);assert.equal(line.props.type,'linear');assert.equal(line.props.isAnimationActive,false);}
});

test('phase64 single-series missing observation stays readable with one genuine null payload',()=>{
 const h=chart({...basic(),comparison:{compare:false,otherStart:'',otherEnd:''}}),r=tooltip(h,1);
 assert.equal(r.contentProps.payload.length,1);assert.equal(r.box.props.style.visibility,'visible');assert.deepEqual(tooltipRows(r),['当前 · 2026-09-13 · 缺测 已采 0/1 账号']);
});

test('phase64 one missing side, real zero and negative growth remain distinct in the real tooltip pipeline',()=>{
 for(const side of ['current','comparison']){
  const props=basic();props.points.push(side==='current'?point('2026-09-18',20,30):point('2026-09-13',10,20));const h=chart(props),r=tooltip(h,1),rows=tooltipRows(r);
  assert.equal(r.box.props.style.visibility,'visible');assert.match(rows[side==='current'?0:1],/缺测 已采 0\/1/);assert.match(rows[side==='current'?1:0],/ · 0 已采 1\/1/);
 }
 const h=chart(),r=tooltip(h,2);assert.deepEqual(tooltipRows(r),['当前 · 2026-09-14 · -2 已采 1/1 账号','比较 · 2026-09-19 · 0 已采 1/1 账号']);
 assert.equal(byType(h,'ReferenceLine').props.y,0);
});

test('phase64 unequal periods show out-of-range separately from missing, with each true endpoint',()=>{
 const props=basic();props.comparison.otherEnd='2026-09-20';props.points.push(point('2026-09-20',25,35));const h=chart(props),r=tooltip(h,3);
 assert.deepEqual(tooltipRows(r),['当前 · 区间外 · —','比较 · 2026-09-20 · +5 已采 1/1 账号']);
 const reading=h.all().find(n=>n.props.className==='trend-reading'),cards=nodes(reading).filter(n=>n.type==='div'&&n!==reading);
 assert.match(text(cards[0]),/2026-09-14/);assert.match(text(cards[0]),/-2/);assert.match(text(cards[1]),/2026-09-20/);assert.match(text(cards[1]),/\+5/);
 assert.equal(byType(h,'XAxis').props.tickFormatter(3),'第3天');
});

test('phase64 actual 90-day pager preserves the original baseline and real dates in the next window',()=>{
 const start='2026-06-01',end='2026-09-05',day90=new Date(Date.parse(start)+90*86400000).toISOString().slice(0,10);
 const h=chart({...basic(),start,end,comparison:{compare:false,otherStart:'',otherEnd:''},points:[point(start,100),point(day90,93),point(end,105)]});
 assert.equal(byType(h,'LineChart').props.data.length,90);assert.equal(chartPoint(h,0).current,0);
 const reading=()=>h.all().find(n=>n.props.className==='trend-reading');assert.match(text(reading()),/2026-08-29/);assert.match(text(reading()),/缺测/);
 h.all().find(n=>n.type==='Button'&&text(n)==='后90日').props.onClick();h.render();
 assert.equal(byType(h,'LineChart').props.data[0].day,90);assert.equal(chartPoint(h,90).current,-7);assert.equal(chartPoint(h,90).currentDate,day90);
 assert.equal(byType(h,'XAxis').props.tickFormatter(90),'8/30');assert.deepEqual(tooltipRows(tooltip(h,90)),['当前 · 2026-08-30 · -7 已采 1/1 账号']);
 assert.match(text(reading()),/2026-09-05/);assert.match(text(reading()),/\+5/);
 h.all().find(n=>n.type==='Button'&&text(n)==='前90日').props.onClick();h.render();assert.equal(chartPoint(h,0).current,0);assert.equal(byType(h,'LineChart').props.data.length,90);
});

test('phase64 estimated selection preserves likes-times-100, nearby disclosure and missing/zero/negative signs',()=>{
 const h=chart();byType(h,'ToggleGroup').props.onValueChange('estimated');h.render();
 assert.equal(chartPoint(h,0).current,0);assert.equal(chartPoint(h,1).current,null);assert.equal(chartPoint(h,2).current,-200);
 const r=tooltip(h,2);assert.match(text(r.rendered),/-200/);assert.match(text(r.rendered),/获赞净变化 × 100 · 非实际播放量/);assert.match(text(h.all().find(n=>n.props.className==='trend-reading')),/非实际播放量/);
 const m={followers:{value:1,delta:0,knownCount:1,comparableCount:1},likes:{value:20,delta:null,knownCount:1,comparableCount:0},posts:{value:0,delta:0,knownCount:1,comparableCount:1}};
 for(const delta of [null,0,-2,3]){m.likes.delta=delta;const ledger=component(paths[1],'MetricLedger',{metrics:m,count:1,start:'2026-09-12',end:'2026-09-14'}),cell=ledger.all().find(n=>n.props['data-metric-kind']==='estimated');assert.ok(cell);assert.match(text(cell),/获赞净变化 × 100 · 非实际播放/);assert.equal(text(nodes(cell).find(n=>n.type==='strong')),delta===null?'—':delta===0?'0':delta<0?'-200':'+300');}
});

test('phase64 controlled metric cannot be cleared or replaced by inherited or unknown values',()=>{
 const h=chart();byType(h,'ToggleGroup').props.onValueChange('likes');h.render();
 for(const value of ['',undefined,null,'bad','constructor','__proto__']){byType(h,'ToggleGroup').props.onValueChange(value);h.render();assert.equal(byType(h,'ToggleGroup').props.value,'likes');assert.ok(byType(h,'LineChart'));}
 h.render({suspended:true});assert.equal(byType(h,'ChartContainer'),undefined);h.render({suspended:false});assert.equal(byType(h,'ToggleGroup').props.value,'likes');assert.equal(h.all().filter(n=>n.type==='Line').length,2);
 h.render({ready:false,pendingError:'合成未就绪范围'});assert.equal(byType(h,'LineChart'),undefined);assert.equal(h.all().find(n=>n.props.className==='trend-reading'),undefined);assert.ok(h.all().find(n=>n.type==='Button'&&text(n)==='导出本屏曲线记录').props.disabled);
});

test('phase64 installed tooltip honors inactivity and reduced motion while retaining null payloads',()=>{
 const h=chart(),props=byType(h,'ChartTooltip').props,payload=payloadFor(h,chartPoint(h,1));
 const inactive=installedTooltip(props,payload,{active:false,label:1});assert.equal(inactive.box.props.style.visibility,'hidden');assert.equal(inactive.rendered,null);
 const reduced=installedTooltip(props,payload,{reducedMotion:true,label:1});assert.equal(reduced.box.props.style.transition,undefined);assert.equal(reduced.box.props.style.visibility,'visible');
});

// Render the real application wrappers and real installed Radix implementation on
// the server. This verifies emitted semantics, not hydration or keyboard browsing.
test('phase64 real ToggleGroup wrapper emits one checked native radio button and an accessible group',()=>{
 const React=requireSite('react'),{renderToStaticMarkup}=requireSite('react-dom/server'),cache=new Map();
 function load(path){if(cache.has(path))return cache.get(path);const exports={};vm.runInNewContext(compile(sources[path]),{exports,require(spec){if(spec==='@/lib/utils')return{cn:(...x)=>x.filter(Boolean).join(' ')};if(spec==='@/components/ui/toggle')return load('components/ui/toggle.tsx');return requireSite(spec);}});cache.set(path,exports);return exports;}
 const ui=load('components/ui/toggle-group.tsx'),h=chart(),group=byType(h,'ToggleGroup');
 const element=React.createElement(ui.ToggleGroup,{...group.props,children:undefined},h.all().filter(n=>n.type==='ToggleGroupItem').map(n=>React.createElement(ui.ToggleGroupItem,{...n.props,key:n.key,children:undefined},text(n))));
 const html=renderToStaticMarkup(element);assert.match(html,/role="radiogroup"/);assert.match(html,/aria-label="趋势指标"/);assert.equal((html.match(/role="radio"/g)||[]).length,4);assert.equal((html.match(/aria-checked="true"/g)||[]).length,1);assert.equal((html.match(/type="button"/g)||[]).length,4);assert.match(html,/aria-label="估算播放趋势"/);
});

test('phase64 real installed roving-focus key handler skips disabled items, wraps and preserves modified/child keys',()=>{
 const document={activeElement:null},queued=[],focused=[],context={currentTabStopId:'followers',dir:'ltr',loop:true,onItemFocus(){},onItemShiftTab(){context.shiftTabs++;},shiftTabs:0,onFocusableItemAdd(){},onFocusableItemRemove(){}};
 const items=['followers','likes','posts','estimated'].map((id,i)=>({id,focusable:i!==1,ref:{current:{id,focus(){document.activeElement=this;focused.push(id);}}}}));
 const fakeReact={forwardRef:fn=>fn,useEffect(){},useState:v=>[v,()=>{}],useRef:v=>({current:v}),useCallback:fn=>fn};
 const mocks={react:fakeReact,'react/jsx-runtime':{jsx,jsxs:jsx},'@radix-ui/react-collection':{createCollection:()=>[{Provider:'Provider',Slot:'Slot',ItemSlot:'ItemSlot'},()=>()=>items,()=>({})]},'@radix-ui/react-context':{createContextScope:()=>[()=>['Provider',()=>context],()=>({})]},'@radix-ui/react-id':{useId:()=> 'followers'},'@radix-ui/react-primitive':{Primitive:{span:'span',div:'div'}},'@radix-ui/react-use-layout-effect':{useLayoutEffect(){}},'@radix-ui/react-use-is-hydrated':{useIsHydrated:()=>true}};
 const module={exports:{}},localRequire=createRequire(rovingPath);vm.runInNewContext(rovingSource,{module,exports:module.exports,document,setTimeout:fn=>queued.push(fn),require:spec=>Object.hasOwn(mocks,spec)?mocks[spec]:localRequire(spec)});
 const item=module.exports.Item({tabStopId:'followers',focusable:true,active:true},null),node=nodes(item).find(n=>n.type==='span');assert.equal(node.props.tabIndex,0);
 function key(key,extra={}){document.activeElement=items[0].ref.current;let prevented=false;node.props.onKeyDown({key,target:items[0].ref.current,currentTarget:items[0].ref.current,preventDefault(){prevented=true;},...extra});while(queued.length)queued.shift()();return prevented;}
 assert.equal(key('ArrowRight'),true);assert.equal(focused.at(-1),'posts');assert.equal(key('ArrowLeft'),true);assert.equal(focused.at(-1),'estimated');assert.equal(key('End'),true);assert.equal(focused.at(-1),'estimated');assert.equal(key('Home'),true);assert.equal(document.activeElement.id,'followers');
 const count=focused.length;assert.equal(key('ArrowRight',{ctrlKey:true}),false);assert.equal(key('ArrowRight',{target:{nested:true}}),false);assert.equal(key(' '),false);assert.equal(focused.length,count);assert.equal(key('Tab',{shiftKey:true}),false);assert.equal(context.shiftTabs,1);
});

test('phase64 actual scope stays legible while unresolved metric statistics remain hidden until range-ready',()=>{
 const ast=ts.createSourceFile('page.tsx',sources['app/page.tsx'],ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let scope,ledger;
 function visit(n){if(ts.isJsxElement(n)&&n.openingElement.attributes.properties.some(a=>ts.isJsxAttribute(a)&&a.name.getText(ast)==='className'&&a.initializer?.text==='active-scope'))scope=n;if(ts.isJsxSelfClosingElement(n)&&n.tagName.getText(ast)==='MetricLedger')ledger=n;ts.forEachChild(n,visit);}visit(ast);assert.ok(scope);assert.ok(ledger);
 const wrapper=ledger.parent;assert.ok(ts.isJsxElement(wrapper));assert.notEqual(scope.parent,wrapper,'selected scope is visible independently of verified statistics');const expression='<>'+scope.getText(ast)+wrapper.getText(ast)+'</>',exports={};
 const code='export function render({board,data,theme,themes,tag,tags,start,end,rangeReady,scope,totals,periodDraft,comparison}){return ('+expression+');}';
 vm.runInNewContext(compile(code),{exports,MetricLedger:'MetricLedger',Button:'Button',scopeFocus:{current:null},clearScope(){},require:()=>({jsx,jsxs:jsx,Fragment:'Fragment'})});
 const props={board:'board-a',data:{boards:[{key:'board-a',name:'实际矩阵'}]},theme:'theme-a',themes:[['theme-a','实际主题']],tag:'tag-a',tags:[['tag-a','实际分类']],start:'2026-09-12',end:'2026-09-30',rangeReady:true,scope:[account],totals:{},periodDraft:'today',comparison:{compare:true,otherStart:'2026-09-14',otherEnd:'2026-09-17'}};
 const ready=exports.render(props),label=nodes(ready).find(n=>n.props.className==='active-scope'),metricParent=nodes(ready).find(n=>nodes(n.props.children).some(x=>x.type==='MetricLedger')&&n.type==='div');assert.equal(metricParent.props.hidden,false);const scopeText=x=>x==null||typeof x==='boolean'?'':Array.isArray(x)?x.map(scopeText).join(''):typeof x==='object'?(x.type==='Button'?'':scopeText(x.props?.children)):String(x);assert.equal(scopeText(label),'实际矩阵实际主题实际分类当前 2026-09-12 → 2026-09-30比较 2026-09-14 → 2026-09-17');assert.deepEqual(nodes(label).filter(n=>n.type==='Button').map(n=>n.props['aria-label']),['清除大主题筛选，保留其他条件','清除内容分类筛选，保留其他条件']);assert.doesNotMatch(text(label),/today|今日/);
 const pending=exports.render({...props,rangeReady:false}),pendingLabel=nodes(pending).find(n=>n.props.className==='active-scope');assert.match(text(pendingLabel),/待核对，尚未应用/);assert.equal(nodes(pending).find(n=>n.type==='div'&&nodes(n.props.children).some(x=>x.type==='MetricLedger')).props.hidden,true);assert.doesNotMatch(text(pendingLabel),/当前已应用/);
});

test('phase64 pinned identity styling stays confined to main account ledger and keeps opaque bounded cells',()=>{
 const css=postcss.parse(sources['app/replica.css']),sticky=[];css.walkDecls('position',d=>{if(d.value==='sticky')sticky.push(d.parent);});
 const identity=sticky.filter(rule=>rule.selector.includes('first-child'));assert.ok(identity.length);for(const rule of identity){for(const selector of rule.selectors)assert.ok(selector.startsWith('.account-ledger '),selector);const props=Object.fromEntries(rule.nodes.filter(n=>n.type==='decl').map(d=>[d.prop,d.value]));assert.equal(props.left,'0');assert.equal(props.background,'var(--mcn-surface)');assert.equal(props['min-width'],'150px');assert.equal(props['max-width'],'220px');assert.equal(props['white-space'],'normal');}
 const ast=ts.createSourceFile('page.tsx',sources['app/page.tsx'],ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let wrapper;
 function visit(n){if(ts.isJsxElement(n)&&n.openingElement.attributes.properties.some(a=>ts.isJsxAttribute(a)&&a.name.getText(ast)==='key'&&a.initializer?.text==='workspace-accounts'))wrapper=n;ts.forEachChild(n,visit);}visit(ast);assert.ok(wrapper);assert.ok(wrapper.openingElement.attributes.properties.some(a=>a.name?.getText(ast)==='className'&&a.initializer?.text==='account-ledger'));
});

test('phase64 mobile ledger cascade keeps intrinsic long-number width and rejects the former half-basis override',()=>{
 const valueParser=requireSite('postcss-value-parser'),css=postcss.parse(sources['app/replica.css']);
 // Deliberately scoped stylesheet-contract resolver, not a browser layout engine:
 // class descendants, width media queries, specificity, importance and source order.
 const ledger=['metric-ledger'],grid=['metric-grid','metric-grid--change'],cell=['metric-cell'],value=['metric-cell__value','positive'];
 function matches(selector,chain){
  const compounds=selector.trim().split(/\s+/);if(!compounds.every(x=>/^\.[\w-]+(?:\.[\w-]+)*$/.test(x)))return false;
  let at=chain.length-1;for(let i=compounds.length-1;i>=0;i--){const names=compounds[i].slice(1).split('.');if(i===compounds.length-1){if(!names.every(name=>chain[at].includes(name)))return false;at--;}else{while(at>=0&&!names.every(name=>chain[at].includes(name)))at--;if(at<0)return false;at--;}}return true;
 }
 function active(rule,width){for(let p=rule.parent;p&&p.type!=='root';p=p.parent){if(p.type!=='atrule')continue;if(p.name!=='media')continue;const query=p.params.replace(/\s/g,'');if(query==='print'||query.includes('prefers-reduced-motion'))return false;const m=query.match(/^\((max|min)-width:(\d+)px\)$/);assert.ok(m,'New media syntax needs an explicit contract: '+query);if(m[1]==='max'&&width>Number(m[2])||m[1]==='min'&&width<Number(m[2]))return false;}return true;}
 function resolve(root,chain,width){
  const winners={},relevant=new Set(['display','flex-wrap','flex','flex-basis','flex-shrink','max-width','font-size','white-space','overflow-wrap','overflow-x']);let order=0;
  root.walkRules(rule=>{if(!active(rule,width))return;const selectors=rule.selectors.filter(s=>matches(s,chain));if(!selectors.length)return;const specificity=Math.max(...selectors.map(s=>(s.match(/\./g)||[]).length));
   rule.walkDecls(d=>{order++;if(!relevant.has(d.prop))return;const declarations=[[d.prop,d.value]];if(d.prop==='flex'){const tokens=valueParser(d.value).nodes.filter(n=>n.type!=='space').map(n=>valueParser.stringify(n));assert.equal(tokens.length,3,'Explicit flex grow/shrink/basis must remain auditable');declarations.push(['flex-shrink',tokens[1]],['flex-basis',tokens[2]]);}
    for(const [property,val] of declarations){const next={value:val,important:!!d.important,specificity,order},old=winners[property];if(!old||Number(next.important)>Number(old.important)||next.important===old.important&&(next.specificity>old.specificity||next.specificity===old.specificity&&next.order>=old.order))winners[property]=next;}
   });
  });return Object.fromEntries(Object.entries(winners).map(([key,entry])=>[key,entry.value]));
 }
 function assertLayout(root,width){
  const gridStyle=resolve(root,[ledger,grid],width),cellStyle=resolve(root,[ledger,grid,cell],width),numberStyle=resolve(root,[ledger,grid,cell,value],width);
  assert.equal(gridStyle.display,'flex');assert.equal(gridStyle['flex-wrap'],'wrap');assert.equal(cellStyle['flex-basis'],'max-content','change cells must retain intrinsic sizing instead of a fixed half-row');assert.equal(cellStyle['flex-shrink'],'0');assert.equal(cellStyle['max-width'],'100%');
  assert.equal(numberStyle['white-space'],'nowrap');assert.equal(numberStyle['overflow-wrap'],'normal');assert.equal(numberStyle['max-width'],'100%');assert.equal(numberStyle['overflow-x'],'auto');if(width<=760)assert.equal(numberStyle['font-size'],'25px','fix must not reduce the original mobile number font');
 }
 for(const width of [320,375,390,430,760,761,1100,1440])assertLayout(css,width);
 const former=css.clone();let restored=0;former.walkDecls('flex-basis',d=>{if(d.parent.selectors?.includes('.metric-grid--change .metric-cell')&&d.parent.parent.type==='atrule'&&d.parent.parent.params.replace(/\s/g,'')==='(max-width:760px)'){d.value='calc(50% - 1px)';restored++;}});assert.equal(restored,1);assert.throws(()=>assertLayout(former,390),/intrinsic sizing/,'the old mobile override must fail even though global max-content still exists');
 const laterShorthand=css.clone();laterShorthand.append(postcss.parse('@media(max-width:760px){.metric-grid--change .metric-cell{flex:1 0 50%;}}'));assert.throws(()=>assertLayout(laterShorthand,390),/intrinsic sizing/,'a later shorthand cannot silently reintroduce the half-width basis');
 const m={followers:{value:1,delta:0},likes:{value:400778,delta:400778},posts:{value:0,delta:0}},h=component(paths[1],'MetricLedger',{metrics:m,count:1,start:'2026-09-12',end:'2026-09-30'}),estimate=h.all().find(n=>n.props['data-metric-kind']==='estimated');
 assert.equal(text(nodes(estimate).find(n=>n.type==='strong')),'+40,077,800');assert.match(text(estimate),/非实际播放/);
});
