// Independent actual-component contracts, not browser, pixel, or OKX-source verification.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {rendererJsx,synchronousGrowthDynamic} from './helpers/growth-renderer-transport.mjs';
const site=new URL('../../mcn-public-site/',import.meta.url),requireSite=createRequire(new URL('package.json',site));
const ts=requireSite('typescript'),postcss=requireSite('postcss');
const files=['components/metric-ledger.tsx','components/growth-panel.tsx','components/scrollable-table.tsx','app/page.tsx'];
const source=Object.fromEntries(await Promise.all(files.map(async p=>[p,await readFile(new URL(p,site),'utf8')])));
const css=postcss.parse(await readFile(new URL('app/replica.css',site),'utf8'));
const text=x=>x==null||typeof x==='boolean'?'':Array.isArray(x)?x.map(text).join(''):typeof x==='object'?text(x.props?.children):String(x);
function nodes(x,out=[]){if(!x||typeof x!=='object')return out;if(Array.isArray(x))x.forEach(n=>nodes(n,out));else{out.push(x);nodes(x.props?.children,out);}return out;}
function component(path,name,initial,options={}){
 let cursor=0,ordinal=0,tree,props=initial,effects=[],dirty=true;const state=[],exports={},slots=new Map(),fetches=[],jsx=rendererJsx;
 const ast=ts.createSourceFile(path,source[path],ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),names=[];
 function visit(n){if(ts.isVariableDeclaration(n)&&ts.isArrayBindingPattern(n.name)&&ts.isCallExpression(n.initializer)&&n.initializer.expression.getText(ast)==='useState')names.push(n.name.elements[0].name.getText(ast));ts.forEachChild(n,visit);}visit(ast);
 const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
 const react={useId:()=>"phase114-test-reading",useState(value){const i=cursor++,key=names[ordinal++];slots.set(key,i);if(!(i in state))state[i]={value:Object.hasOwn(options.initialState||{},key)?options.initialState[key]:typeof value==='function'?value():value};return[state[i].value,next=>{next=typeof next==='function'?next(state[i].value):next;if(!Object.is(next,state[i].value)){state[i].value=next;dirty=true;}}];},useMemo(fn,deps){const i=cursor++;if(!same(state[i]?.deps,deps))state[i]={deps,value:fn()};return state[i].value;},useRef(value){const i=cursor++;return state[i]??(state[i]={current:value});},useEffect(fn,deps){const i=cursor++,old=state[i];if(!same(old?.deps,deps)){state[i]={deps,cleanup:old?.cleanup};effects.push(()=>{old?.cleanup?.();state[i].cleanup=fn();});}}};
 const location=new URL('https://phase63.invalid/#overview'),window={location,scrollY:0,scrollTo(){},addEventListener(){},removeEventListener(){},history:{replaceState(_s,_t,p){location.href=new URL(p,location.href).href;},pushState(_s,_t,p){location.href=new URL(p,location.href).href;}}};
 const output=ts.transpileModule(source[path],{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 vm.runInNewContext(output,{exports,URL,URLSearchParams,Blob,Date,Map,Set,console,AbortController,window,document:{visibilityState:'visible',activeElement:null,querySelector:()=>null},requestAnimationFrame:fn=>{fn();return 1;},setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},fetch:async(...args)=>{fetches.push(args);throw Error('No network in source-only contract');},require(spec){if(spec==='next/dynamic')return {default:synchronousGrowthDynamic};if(spec==='react')return react;if(spec==='react/jsx-runtime')return{jsx,jsxs:jsx,Fragment:'Fragment'};if(spec==='recharts'||spec==='lucide-react'||spec.startsWith('@/components/'))return new Proxy({}, {get:(_t,k)=>String(k)});if(spec.startsWith('@/lib/'))return requireSite(new URL(spec.slice(2),site).pathname);return requireSite(spec);}});
 const api={render(next={}){props={...props,...next};cursor=0;ordinal=0;dirty=false;tree=exports[name](props);return tree;},all:()=>nodes(tree),text:()=>text(tree),state:key=>state[slots.get(key)]?.value,fetches,async flush(){for(let i=0;i<25;i++){if(dirty)api.render();const due=effects;effects=[];due.forEach(fn=>fn());await Promise.resolve();if(!dirty&&!effects.length)return;}throw Error('Home did not settle');},close(){state.forEach(s=>s?.cleanup?.());}};api.render();return api;
}
const valueNode=a=>nodes(a).find(n=>n.type==='strong'&&n.props.className?.includes('metric-cell__value'));
const metricArticle=(h,label)=>h.all().find(n=>n.type==='article'&&nodes(n).some(p=>p.props.className==='metric-cell__label'&&text(p)===label));
const ledgerMetrics=()=>({followers:{value:123456789,delta:-123,knownCount:7,comparableCount:6},likes:{value:0,delta:0,knownCount:4,comparableCount:3},posts:{value:null,delta:null,knownCount:0,comparableCount:0}});

test('phase63 actual ledger keeps stock separate from changes and preserves null, zero, negative and source boundaries',()=>{
 const h=component(files[0],'MetricLedger',{metrics:ledgerMetrics(),count:8,start:'2026-09-12',end:'2026-09-30'});
 assert.equal(h.all().filter(n=>n.type==='article').length,7);
 for(const [label,expected] of [['粉丝存量','123,456,789'],['获赞存量','0'],['作品存量','—'],['粉丝净变化','-123'],['点赞净变化','0'],['估算播放变化','0'],['作品存量净变化','—']])assert.equal(text(valueNode(metricArticle(h,label))),expected,label);
 assert.match(valueNode(metricArticle(h,'粉丝净变化')).props.className,/negative/);
 assert.doesNotMatch(valueNode(metricArticle(h,'点赞净变化')).props.className,/positive|negative/);
 assert.match(text(metricArticle(h,'粉丝存量')),/已采 7\/8/);assert.match(text(metricArticle(h,'粉丝净变化')),/可比 6\/8/);
 assert.match(h.text(),/缺测不补零/);assert.match(h.text(),/作品净变化不等于新发布量/);assert.match(h.text(),/非平台实际播放量/);
});

test('phase63 estimate disclosure stays next to its own number without changing the likes-times-100 contract',()=>{
 for(const delta of [null,0,-8,9]){
  const metrics=ledgerMetrics();metrics.likes.delta=delta;metrics.likes.comparableCount=delta===null?0:3;
  const h=component(files[0],'MetricLedger',{metrics,count:8,start:'2026-09-12',end:'2026-09-30'}),card=metricArticle(h,'估算播放变化'),value=valueNode(card);
  assert.equal(card.props['data-metric-kind'],'estimated');assert.equal(text(value),delta===null?'—':delta===0?'0':delta<0?'-800':'+900');
  assert.match(text(card),/非.{0,6}实际/);assert.match(text(card),/×\s*100/);assert.match(text(card),new RegExp('可比 '+(delta===null?0:3)+'/8'));
  assert.equal(value.props.className.includes('negative'),delta!==null&&delta<0);assert.equal(value.props.className.includes('positive'),delta!==null&&delta>0);
 }
});

const point=(date,followers,likes=3)=>({targetId:1,date,capturedAt:date+'T03:00:00.000Z',followers,likes,posts:0});
const chartProps=()=>({accounts:[{id:1,label:'合成账号',enabled:true}],points:[point('2026-09-12',10),point('2026-09-14',8),point('2026-09-17',20),point('2026-09-18',20),point('2026-09-19',21),point('2026-09-20',22)],manifest:{asOf:'2026-10-01T05:44:51.113Z'},start:'2026-09-12',end:'2026-09-14',comparison:{compare:false,otherStart:'2026-09-17',otherEnd:'2026-09-20'}});
const chart=props=>component(files[1],'GrowthPanel',props||chartProps());

test('phase63 metric single-toggle keeps a valid selected metric, including a repeated empty toggle',()=>{
 const h=chart(),group=()=>h.all().find(n=>n.type==='ToggleGroup');assert.ok(group(),'existing primitive must expose the metric selection');assert.equal(group().props.type,'single');assert.equal(group().props.value,'followers');
 assert.deepEqual(h.all().filter(n=>n.type==='ToggleGroupItem').map(n=>n.props.value),['followers','likes','posts','estimated']);
 group().props.onValueChange('estimated');h.render();assert.equal(group().props.value,'estimated');assert.match(h.text(),/非实际播放量/);
 assert.deepEqual(Array.from(h.all().find(n=>n.type==='LineChart').props.data,p=>p.current),[0,null,0]);
 group().props.onValueChange('');h.render();assert.equal(group().props.value,'estimated');assert.doesNotMatch(h.text(),/无效趋势指标/);
});

test('phase63 actual chart retains null gaps, negative values, zero reference and non-animated linear paths',()=>{
 const h=chart();assert.deepEqual(Array.from(h.all().find(n=>n.type==='LineChart').props.data,p=>p.current),[0,null,-2]);
 assert.equal(h.all().find(n=>n.type==='ReferenceLine').props.y,0);
 h.render({comparison:{...chartProps().comparison,compare:true}});
 const lines=h.all().filter(n=>n.type==='Line');assert.equal(lines.length,2);for(const line of lines){assert.equal(line.props.type,'linear');assert.equal(line.props.connectNulls,false);assert.equal(line.props.isAnimationActive,false);}
 assert.ok(lines.find(n=>n.props.dataKey==='comparison').props.strokeDasharray);
 assert.match(h.text(),/固定可比 1\/1/);assert.match(h.text(),/缺日断线，未补零/);assert.ok(h.all().find(n=>n.type==='details'&&n.props.className==='trend-details'));
});

test('phase63 toggled metric and comparison survive chart suspension and restoration',()=>{
 const props=chartProps(),h=chart({...props,comparison:{...props.comparison,compare:true}});
 h.all().find(n=>n.type==='ToggleGroup').props.onValueChange('likes');h.render();
 const values=()=>Array.from(h.all().find(n=>n.type==='LineChart').props.data,p=>[p.current,p.comparison]);
 assert.deepEqual(values(),[[0,0],[null,0],[0,0],[null,0]]);
 h.render({suspended:true});assert.equal(h.all().some(n=>n.type==='ChartContainer'),false);
 h.render({suspended:false});assert.equal(h.all().find(n=>n.type==='ToggleGroup').props.value,'likes');
 assert.deepEqual(values(),[[0,0],[null,0],[0,0],[null,0]]);assert.ok(h.all().some(n=>n.type==='Input'&&n.props.value===props.comparison.otherStart));
});

test('phase63 summary uses each series last displayed calendar day, not a shared or last non-null endpoint',()=>{
 const h=chart({...chartProps(),comparison:{...chartProps().comparison,compare:true}});
 const reading=()=>h.all().find(n=>n.props.className==='trend-reading'),cards=()=>[reading().props.children].flat(Infinity).filter(n=>n?.type==='div');
 assert.match(text(cards()[0]),/2026-09-14/);assert.match(text(cards()[0]),/-2/);assert.match(text(cards()[1]),/2026-09-20/);assert.match(text(cards()[1]),/\+2/);
 const start='2026-06-01',last=new Date(Date.parse(start)+89*86400000).toISOString().slice(0,10),prior=new Date(Date.parse(start)+88*86400000).toISOString().slice(0,10);
 h.render({start,end:'2026-09-05',points:[point(start,10),point(prior,20),point('2026-09-05',30)],comparison:{compare:false,otherStart:'',otherEnd:''}});
 assert.match(text(reading()),new RegExp(last));assert.match(text(reading()),/缺测/);assert.doesNotMatch(text(reading()),/\+10|\+20/);
});

test('phase63 real Home account navigation preserves keyed chart, toggle metric, comparison, query and page',async()=>{
 const p=chartProps(),accounts=Array.from({length:45},(_,i)=>({id:i+1,label:'合成作者'+String(i+1).padStart(2,'0'),platform:'douyin',enabled:true,boardKeys:['peer'],classification:{theme:{key:'peer',label:'合成主题'},labels:[]}}));
 const data={manifest:{...p.manifest,counts:{enabledAccounts:45,daily:270},files:[]},publishedAt:p.manifest.asOf,accounts,points:accounts.flatMap(a=>p.points.map(x=>({...x,targetId:a.id}))),boards:[{key:'peer',name:'合成矩阵'}],topics:{topics:[],items:[]},summaryLoaded:true,dateIndexed:false},comparison={...p.comparison,compare:true};
 const h=component(files[3],'default',{}, {initialState:{data,loading:false,start:p.start,end:p.end,comparison}});
 const button=label=>h.all().find(n=>n.type==='Button'&&text(n)===label),snapshot=()=>{const growth=h.all().find(n=>n.type==='GrowthPanel'),table=h.all().find(n=>n.key==='workspace-accounts'),parent=h.all().find(n=>{const children=[n.props?.children].flat(Infinity);return children.includes(growth)&&children.includes(table);});assert.ok(parent);const children=[parent.props.children].flat(Infinity);return{growth,parent:parent.type,growthIndex:children.indexOf(growth),tableIndex:children.indexOf(table)};};
 try{await h.flush();h.all().find(n=>n.type==='Input'&&n.props['aria-label']==='搜索作者').props.onChange({target:{value:'合成'}});await h.flush();button('下一页').props.onClick();await h.flush();assert.equal(h.state('page'),2);
  const before=snapshot(),child=chart(before.growth.props);assert.ok(before.growthIndex<before.tableIndex);child.all().find(n=>n.type==='ToggleGroup').props.onValueChange('likes');child.render();
  button('账号明细').props.onClick();await h.flush();const after=snapshot();assert.ok(after.tableIndex<after.growthIndex);assert.equal(after.parent,before.parent);assert.equal(after.growth.key,before.growth.key);assert.equal(after.growth.props.comparison,comparison);assert.equal(h.state('page'),2);assert.equal(h.state('query'),'合成');child.render(after.growth.props);assert.equal(child.all().find(n=>n.type==='ToggleGroup').props.value,'likes');
  button('经营总览').props.onClick();await h.flush();const returned=snapshot();assert.ok(returned.growthIndex<returned.tableIndex);assert.equal(returned.growth.key,before.growth.key);assert.equal(h.state('page'),2);assert.equal(h.state('query'),'合成');assert.equal(h.fetches.length,0);child.close();
 }finally{h.close();}
});

test('phase63 single-period axis uses observation dates while comparison keeps relative-day alignment',()=>{
 const h=chart();let axis=h.all().find(n=>n.type==='XAxis');const formatted=String(axis.props.tickFormatter(0));assert.match(formatted,/(09|9)[/-]12/);assert.doesNotMatch(formatted,/天/);
 h.render({comparison:{...chartProps().comparison,compare:true}});axis=h.all().find(n=>n.type==='XAxis');assert.match(String(axis.props.tickFormatter(0)),/0.*天/);
});

test('phase63 shared tooltip states both same-position series and their real missing-data coverage',()=>{
 const h=chart({...chartProps(),comparison:{...chartProps().comparison,compare:true}}),tooltip=h.all().find(n=>n.type==='ChartTooltip');
 const content=tooltip.props.content({active:true,payload:[{dataKey:'comparison',value:0,payload:{day:1,currentDate:'2026-09-13',current:null,currentKnown:0,comparisonDate:'2026-09-18',comparison:0,comparisonKnown:1}}]});
 const label=text(content);assert.match(label,/2026-09-13/);assert.match(label,/缺测/);assert.match(label,/0\s*\/\s*1/);assert.match(label,/2026-09-18/);assert.match(label,/1\s*\/\s*1/);assert.match(label,/比较/);
});

test('phase63 a pending range still hides the chart and disables export instead of showing the previous summary',()=>{
 const h=chart();h.render({ready:false,pendingError:'所选日期尚在核对'});assert.equal(h.all().some(n=>n.type==='LineChart'),false);assert.ok(h.all().find(n=>n.type==='Button'&&text(n)==='导出本屏曲线记录').props.disabled);assert.match(h.text(),/所选日期尚在核对/);
});

test('phase63 scrollable table retains accessible keyboard movement without hijacking a child control',()=>{
 const h=component(files[2],'ScrollableTable',{}),region=h.all().find(n=>n.props.role==='region'),calls=[];
 assert.equal(region.props.tabIndex,0);assert.match(region.props['aria-label'],/左右/);
 const owner={scrollWidth:900,clientWidth:400,scrollBy:value=>calls.push(value),scrollTo:value=>calls.push(value)},target={querySelector:()=>owner};
 region.props.onKeyDown({target,currentTarget:target,key:'ArrowRight',preventDefault(){}});assert.equal(calls[0].left,120);
 region.props.onKeyDown({target:{name:'author button'},currentTarget:target,key:'ArrowRight',preventDefault(){throw Error('child key hijacked');}});assert.equal(calls.length,1);
});

test('phase63 dark semantic text and focus stay numerically distinguishable, with reduced motion preserved',()=>{
 const tokens={};css.walkRules(rule=>{if(rule.parent.type==='root'&&rule.selectors.includes(':root'))rule.walkDecls(d=>{if(d.prop.startsWith('--'))tokens[d.prop]=d.value;});});
 const luminance=hex=>{hex=hex.slice(1);if(hex.length===3)hex=[...hex].map(c=>c+c).join('');return hex.match(/../g).map(c=>parseInt(c,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);};
 const contrast=(a,b)=>(Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
 for(const key of ['--mcn-ink','--mcn-muted','--mcn-positive','--mcn-negative'])assert.ok(contrast(tokens[key],tokens['--mcn-surface'])>=4.5,key);
 assert.notEqual(tokens['--mcn-positive'],tokens['--mcn-negative']);assert.ok(contrast(tokens['--primary-foreground'],tokens['--primary'])>=4.5);assert.ok(contrast(tokens['--ring'],tokens['--mcn-surface'])>=3);
 const disabled=new Set();css.walkAtRules('media',rule=>{if(rule.params.replace(/\s/g,'')==='(prefers-reduced-motion:reduce)')rule.walkDecls(d=>{if(d.value==='none')disabled.add(d.prop);});});assert.ok(disabled.has('animation'));assert.ok(disabled.has('transition'));assert.ok(disabled.has('transform'));
});
