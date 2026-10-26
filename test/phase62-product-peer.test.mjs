// Independent evidence from the actual Home TSX and model. UI shells/DOM/frame queue are
// simulated; these tests do not establish public hydration, browser layout or user INP.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {performance} from 'node:perf_hooks';

const site=new URL('../../mcn-public-site/',import.meta.url),requireSite=createRequire(new URL('package.json',site));
const ts=requireSite('typescript'),source=await readFile(new URL('app/page.tsx',site),'utf8');
const model=requireSite(new URL('lib/replica-model.mjs',site).pathname);
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const stateNames=[],ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function visit(node){if(ts.isVariableDeclaration(node)&&ts.isArrayBindingPattern(node.name)&&ts.isCallExpression(node.initializer)&&node.initializer.expression.getText(ast)==='useState')stateNames.push(node.name.elements[0].name.getText(ast));ts.forEachChild(node,visit);}visit(ast);
const textOf=x=>x==null||typeof x==='boolean'?'':Array.isArray(x)?x.map(textOf).join(''):typeof x==='object'?textOf(x.props?.children):String(x);
function nodes(x,out=[]){if(!x||typeof x!=='object')return out;if(Array.isArray(x))x.forEach(n=>nodes(n,out));else{out.push(x);nodes(x.props?.children,out);}return out;}
const sameDeps=(a,b)=>a&&b&&a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]));

function home(data,address='https://phase62.invalid/#overview'){
 let cursor=0,stateOrdinal=0,dirty=true,tree,effects=[],frames=[],mountedRefs=new Set();
 const hooks=[],slots=new Map(),listeners=new Map(),scans=[],scrolls=[],focuses=[],downloads=[],blobs=[],exports={};
 const initial={data,loading:false,start:'2026-09-12',end:'2026-09-30'};
 const react={
  useState(value){const i=cursor++,name=stateNames[stateOrdinal++];slots.set(name,i);if(!hooks[i])hooks[i]={value:Object.hasOwn(initial,name)?initial[name]:typeof value==='function'?value():value};return [hooks[i].value,next=>{next=typeof next==='function'?next(hooks[i].value):next;if(!Object.is(next,hooks[i].value)){hooks[i].value=next;dirty=true;}}];},
  useRef(value){const i=cursor++;return hooks[i]??(hooks[i]={current:value});},
  useMemo(fn,deps){const i=cursor++;if(!sameDeps(hooks[i]?.deps,deps))hooks[i]={deps,value:fn()};return hooks[i].value;},
  useEffect(fn,deps){const i=cursor++,old=hooks[i];if(!sameDeps(old?.deps,deps)){hooks[i]={deps,cleanup:old?.cleanup};effects.push(()=>{old?.cleanup?.();hooks[i].cleanup=fn();});}},
 };
 const location=new URL(address),entries=[location.href];let entry=0;
 const document={activeElement:{tagName:'BODY'},visibilityState:'visible',querySelector:()=>null,createElement(){return {click(){downloads.push({name:this.download,blob:blobs.at(-1)});}};}};
 const window={location,scrollY:0,scrollTo(value){this.scrollY=value.top;scrolls.push({kind:'top',top:value.top});},addEventListener:(k,fn)=>listeners.set(k,fn),removeEventListener:k=>listeners.delete(k),history:{scrollRestoration:'auto',pushState(_s,_t,next){location.href=new URL(next,location.href).href;entries.splice(++entry);entries.push(location.href);},replaceState(_s,_t,next){location.href=new URL(next,location.href).href;entries[entry]=location.href;}}};
 class DownloadURL extends URL{static createObjectURL(blob){blobs.push(blob);return 'blob:phase62';}static revokeObjectURL(){}}
 const jsx=(type,props,key)=>({type,props:props||{},key});
 vm.runInNewContext(compiled,{exports,URL:DownloadURL,URLSearchParams,Date,Map,Set,Promise,AbortController,Blob,console,window,document,
  requestAnimationFrame:fn=>{frames.push(fn);return frames.length;},cancelAnimationFrame(){},setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},fetch:async()=>{throw Error('No network in independent controller test');},navigator:{clipboard:{writeText:async()=>{}}},
  require(specifier){if(specifier==='react')return react;if(specifier==='react/jsx-runtime')return {jsx,jsxs:jsx,Fragment:'Fragment'};
   if(specifier==='@/lib/replica-model.mjs')return {...model,rowsFor(...args){const before=performance.now();try{return model.rowsFor(...args);}finally{scans.push({accounts:args[0].length,points:args[1].length,start:args[2],end:args[3],ms:performance.now()-before});}}};
   if(specifier==='@/lib/replica-reader.mjs')return {readReplicaPart:async()=>{throw Error('No network in independent controller test');}};
   if(specifier.startsWith('@/components/')||specifier==='recharts'||specifier==='lucide-react')return new Proxy({}, {get:(_t,k)=>String(k)});
   if(specifier.startsWith('@/lib/'))return requireSite(new URL(specifier.slice(2),site).pathname);return requireSite(specifier);
  },
 },{filename:'phase62-actual-page.tsx'});
 function commit(node,hidden=false,seen=new Set()){
  if(!node||typeof node!=='object')return seen;if(Array.isArray(node)){node.forEach(n=>commit(n,hidden,seen));return seen;}
  hidden=hidden||!!node.props.hidden;const ref=node.props.ref;
  if(ref&&typeof ref==='object'){seen.add(ref);if(!ref.current)ref.current={isConnected:true,focus(options){if(this.isConnected&&!this.hidden){document.activeElement=this;focuses.push({element:this,options});}},scrollIntoView(options){if(this.isConnected&&!this.hidden){scrolls.push({kind:'into-view',element:this,options});window.scrollY=999;}},getClientRects(){return this.isConnected&&!this.hidden?[{}]:[];}};ref.current.hidden=hidden;ref.current.isConnected=true;ref.current.label=node.props['aria-label']||node.type;}
  commit(node.props.children,hidden,seen);return seen;
 }
 function render(){cursor=0;stateOrdinal=0;dirty=false;tree=exports.default();const seen=commit(tree);for(const ref of mountedRefs)if(!seen.has(ref)){if(ref.current)ref.current.isConnected=false;ref.current=null;}mountedRefs=seen;}
 return {scans,scrolls,focuses,downloads,window,document,all:()=>nodes(tree),state:name=>hooks[slots.get(name)]?.value,
  set(name,value){hooks[slots.get(name)].value=value;dirty=true;},
  back(){assert.ok(entry>0);location.href=entries[--entry];listeners.get('popstate')?.();},
  async flush({runFrames=true}={}){for(let pass=0;pass<25;pass++){if(dirty)render();const due=effects;effects=[];due.forEach(fn=>fn());await Promise.resolve();if(dirty)continue;if(runFrames){const callbacks=frames;frames=[];callbacks.forEach(fn=>fn());}if(!dirty&&!effects.length)return;}throw Error('Home did not settle');},
  close(){hooks.forEach(h=>h?.cleanup?.());},
 };
}

const asOf='2026-10-01T05:44:51.113Z';
function fixture(count=45,pointCount=count*22){
 const accounts=Array.from({length:count},(_,i)=>({id:i+1,label:'合成作者'+String(i+1).padStart(3,'0'),platform:'douyin',enabled:i<Math.min(count,701),boardKeys:['peer'],classification:{theme:{key:'peer',label:'合成主题'},labels:[]}}));
 const points=Array.from({length:pointCount},(_,i)=>{const day=Math.floor(i/count),id=i%count+1,date=new Date(Date.UTC(2026,8,9+day)).toISOString().slice(0,10),capturedAt=date+'T03:00:00.000Z';return {targetId:id,date,capturedAt,followers:100000+id-day,likes:id+day,posts:0,followersAt:capturedAt,likesAt:capturedAt,postsAt:capturedAt};});
 return {manifest:{asOf,timeZone:'Asia/Shanghai',files:accounts.map(a=>({path:'daily/'+a.id+'.json',kind:'daily',targetId:a.id,count:22,sha256:'a'.repeat(64)})),counts:{enabledAccounts:accounts.filter(a=>a.enabled).length,daily:points.length}},publishedAt:asOf,accounts,points,boards:[{key:'peer',name:'合成矩阵'}],topics:{topics:[],items:[]},summaryLoaded:true,dateIndexed:false};
}
const button=(h,label)=>{const node=h.all().find(n=>n.type==='Button'&&textOf(n)===label);assert.ok(node,'Actual control missing: '+label);return node;};
const search=h=>h.all().find(n=>n.type==='Input'&&n.props['aria-label']==='搜索作者');
const group=h=>h.all().find(n=>n.type==='GroupSummary');
const tableIds=h=>h.all().filter(n=>n.type==='Button'&&n.props.className==='author').map(n=>textOf(n));

test('phase62 stale group drilldown frame must not refocus accounts after browser Back',async()=>{
 const h=home(fixture());try{await h.flush();h.window.scrollY=1400;const before=h.scrolls.length;group(h).props.onSelect('theme','peer');await h.flush({runFrames:false});h.back();await h.flush();
  assert.equal(h.state('tab'),'overview');assert.equal(h.scrolls.slice(before).filter(x=>x.kind==='into-view').length,0,'obsolete group jump must not scroll the restored overview to its account search');assert.equal(h.window.scrollY,1400);
 }finally{h.close();}
});

test('phase62 current group drilldown still selects its classification and focuses account search',async()=>{
 const h=home(fixture());try{await h.flush();group(h).props.onSelect('theme','peer');await h.flush();assert.equal(h.state('theme'),'peer');assert.equal(h.state('tab'),'accounts');assert.equal(h.document.activeElement,search(h).props.ref.current);assert.equal(h.scrolls.filter(x=>x.kind==='into-view').length,1);
 }finally{h.close();}
});

test('phase62 a query and sort should reuse same-publication endpoint rows instead of revalidating all history',async t=>{
 const data=fixture(761,16327),h=home(data);try{await h.flush();h.scans.length=0;
  search(h).props.onChange({target:{value:'合成作者001'}});await h.flush();button(h,'作者').props.onClick();await h.flush();
  t.diagnostic(JSON.stringify({scope:'Node controller, not browser INP',records:data.points.length,repeatScans:h.scans}));
  assert.equal(h.scans.length,0,'a name query or sort only changes list selection/order, not validated point data or endpoints');assert.deepEqual(tableIds(h),['合成作者001']);
 }finally{h.close();}
});

test('phase62 cached list projection keeps enabled totals independent of query and paused-account status',async()=>{
 const data=fixture(704),h=home(data);try{await h.flush();const totals=h.all().find(n=>n.type==='MetricLedger').props.metrics;search(h).props.onChange({target:{value:'704'}});h.set('rosterStatus','paused');await h.flush();
  assert.deepEqual(tableIds(h),['合成作者704']);assert.equal(h.all().find(n=>n.type==='MetricLedger').props.count,701);assert.deepEqual(h.all().find(n=>n.type==='MetricLedger').props.metrics,totals);
  button(h,'导出全部结果').props.onClick();const csv=await h.downloads[0].blob.text();assert.equal(csv.trimEnd().split(/\r?\n/).length,2);assert.ok(csv.includes('"'+asOf+'","704","douyin"'));assert.ok(csv.includes('暂停（仅历史）'));assert.ok(csv.includes('"2026-09-12","2026-09-30"'));
 }finally{h.close();}
});

test('phase62 a genuine date change invalidates cached metrics and preserves negative/zero endpoints',async()=>{
 const data=fixture(),h=home(data);try{await h.flush();h.scans.length=0;const dateInputs=h.all().filter(n=>n.type==='Input'&&n.props.type==='date');dateInputs[0].props.onChange({target:{value:'2026-09-29'}});await h.flush();assert.ok(h.scans.some(s=>s.start==='2026-09-29'));const totals=h.all().find(n=>n.type==='MetricLedger').props.metrics;assert.equal(totals.followers.delta,-45);assert.equal(totals.posts.delta,0);assert.equal(h.state('periodDraft'),'custom');
 }finally{h.close();}
});

test('phase62 adopted data invalidates memoized endpoints, while malformed new points remain rejected',async()=>{
 const data=fixture(),h=home(data);try{await h.flush();h.scans.length=0;const newer={...data,points:data.points.map(p=>p.date==='2026-09-30'?{...p,likes:p.likes+4}:p)};h.set('data',newer);await h.flush();assert.ok(h.scans.length>0);assert.equal(h.all().find(n=>n.type==='MetricLedger').props.metrics.likes.delta,45*22);
  h.set('data',{...newer,points:[...newer.points,{...newer.points[0]}]});await assert.rejects(h.flush(),/重复账号采样日/);
 }finally{h.close();}
});

test('phase62 search clear preserves null-last ranking and all-result export beyond the visible page',async()=>{
 const data=fixture(45);data.points=data.points.filter(p=>!(p.targetId===1&&p.date==='2026-09-30'));const h=home(data);try{await h.flush();search(h).props.onChange({target:{value:'002'}});await h.flush();search(h).props.onChange({target:{value:''}});await h.flush();assert.equal(tableIds(h).length,20);assert.equal(tableIds(h)[0],'合成作者002');button(h,'导出全部结果').props.onClick();const lines=(await h.downloads[0].blob.text()).trimEnd().split(/\r?\n/);assert.equal(lines.length,46);assert.ok(lines.at(-1).includes('合成作者001'));assert.ok(lines.at(-1).includes('"99998","",""'));
 }finally{h.close();}
});
