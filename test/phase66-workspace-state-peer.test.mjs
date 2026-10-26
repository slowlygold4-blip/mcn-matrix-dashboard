// Independent tests execute the shipped helpers and Home TSX. DOM, frames and UI
// shells are simulated: this is not evidence of a public browser acceptance run.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';

const site=new URL('../../mcn-public-site/',import.meta.url),requireSite=createRequire(new URL('package.json',site));
const nav=await import(new URL('lib/replica-navigation.mjs',site));
const returns=await import(new URL('lib/replica-return.mjs',site));
const model=await import(new URL('lib/replica-model.mjs',site));
const defaults={sort:'followers.delta',order:'desc',query:'',rosterStatus:'enabled'};
const sorts=['label','followers.value','followers.delta','likes.value','likes.delta','posts.value','posts.delta'];
const asOf='2026-10-01T05:44:51.113Z';
const six={board:'peer',theme:'peer',tag:'all',period:'custom',start:'2026-09-12',end:'2026-09-30'};
const sixQuery='?board=peer&theme=peer&period=custom&start=2026-09-12&end=2026-09-30';
const selectionOf=path=>new URL(path,'https://peer.invalid').search;

test('phase66 old six-field selection and exact three-argument serializer remain unchanged',()=>{
 assert.deepEqual(nav.workspaceSelection(sixQuery),six);
 assert.deepEqual(Object.keys(nav.workspaceSelection(sixQuery)).sort(),['board','end','period','start','tag','theme']);
 assert.equal(nav.workspaceSelectionPath('/','accounts',six),'/'+sixQuery+'#accounts');
 assert.deepEqual(nav.workspaceSelection(sixQuery+'&sort=label&order=asc&query=作者&rosterStatus=paused'),six);
 assert.equal(nav.workspaceSelection('?sort=label'),null);
 assert.deepEqual(nav.workspaceListSelection(''),defaults);
 assert.deepEqual(nav.workspaceListSelection(sixQuery),defaults);
});

test('phase66 all 42 valid sort/order/status combinations roundtrip without changing cohort',()=>{
 for(const sort of sorts)for(const order of ['asc','desc'])for(const rosterStatus of ['enabled','paused','all']){
  const list={sort,order,query:'团团 + & # = % / 🙂',rosterStatus};
  const path=nav.workspaceSelectionPath('/dash','accounts',six,list);
  assert.deepEqual(nav.workspaceListSelection(selectionOf(path)),list);
  assert.deepEqual(nav.workspaceSelection(selectionOf(path)),six);
  assert.equal(nav.workspaceNavigation(selectionOf(path),'#accounts').personal,null);
 }
 assert.deepEqual(Object.keys(nav.workspaceSortLabels).sort(),[...sorts].sort());
});

test('phase66 list-only links survive every ordinary workspace switch without inventing dates',()=>{
 const list={...defaults,sort:'likes.delta',order:'asc',query:'切片 + A',rosterStatus:'paused'};
 let path=nav.workspaceSelectionPath('/dash','accounts',null,list);
 for(const tab of ['topics','overview','accounts']){
  path=nav.workspacePath('/dash',tab,selectionOf(path));
  assert.equal(new URL(path,'https://peer.invalid').hash,'#'+tab);
  assert.equal(nav.workspaceSelection(selectionOf(path)),null);
  assert.deepEqual(nav.workspaceListSelection(selectionOf(path)),list);
 }
 assert.equal(nav.workspaceSelectionPath('/','overview',null,defaults),'/#overview');
 assert.equal(nav.workspaceSelectionPath('/','overview',six,defaults),nav.workspaceSelectionPath('/','overview',six));
});

test('phase66 duplicate list keys including encoded aliases are rejected before navigation',()=>{
 for(const [key,value] of Object.entries(defaults)){
  for(const q of ['?'+key+'='+value+'&'+key+'='+value,'?'+key+'='+value+'&'+encodeURIComponent(key[0]).replace(key[0],'%'+key.charCodeAt(0).toString(16))+key.slice(1)+'='+value]){
   assert.throws(()=>nav.workspaceListSelection(q),/重复/);
   assert.throws(()=>nav.workspaceNavigation(q,'#accounts'),/重复/);
   assert.throws(()=>nav.workspacePath('/','topics',q),/重复/);
  }
 }
});

test('phase66 invalid enums cannot silently choose default sorting or all-account status',()=>{
 for(const [key,values] of Object.entries({sort:['','followers','followers.__proto__','__proto__','constructor','LABEL',' likes.delta'],order:['','ASC','ascending',' desc'],rosterStatus:['','active','disabled','ALL',' all']}))for(const value of values){
  const q='?'+new URLSearchParams({[key]:value});
  assert.throws(()=>nav.workspaceListSelection(q));assert.throws(()=>nav.workspaceNavigation(q,'#overview'));
  assert.throws(()=>nav.workspaceSelectionPath('/','accounts',six,{...defaults,[key]:value}));
 }
});

test('phase66 query has exact UTF-16 200 limit, preserves spaces/case/Unicode and rejects controls',()=>{
 for(const query of ['', '  A团团  ', 'e\u0301 É', '🙂'.repeat(100), '中'.repeat(200), '<script>&+%#=/?']){
  const list={...defaults,query};const path=nav.workspaceSelectionPath('/','accounts',null,list);
  assert.deepEqual(nav.workspaceListSelection(selectionOf(path)),list);
 }
 for(const query of ['a'.repeat(201),'🙂'.repeat(101),'a\u0000b','a\nb','a\rb','a\tb','a\u001fb','a\u007fb']){
  assert.throws(()=>nav.workspaceListSelection('?'+new URLSearchParams({query})));
  assert.throws(()=>nav.workspaceSelectionPath('/','accounts',null,{...defaults,query}));
 }
 for(const query of [null,undefined,200,{},[]])assert.throws(()=>nav.workspaceSelectionPath('/','accounts',null,{...defaults,query}));
 assert.equal(nav.workspaceListSelection('?query=A+B').query,'A B');
 assert.equal(nav.workspaceListSelection('?query=A%2BB').query,'A+B');
});

test('phase66 parser outputs are not shared mutable defaults and serialization does not mutate callers',()=>{
 const first=nav.workspaceListSelection('');first.sort='label';assert.deepEqual(nav.workspaceListSelection(''),defaults);
 const list=Object.freeze({...defaults,sort:'posts.value',query:'查找'}),scope=Object.freeze({...six});
 assert.doesNotThrow(()=>nav.workspaceSelectionPath('/','accounts',scope,list));
 assert.deepEqual(list,{...defaults,sort:'posts.value',query:'查找'});assert.deepEqual(scope,six);
});

test('phase66 unknown URL keys stay ignored and canonical return context cannot smuggle redirects',()=>{
 const q=sixQuery+'&query=A%26B&sort=label&utm_source=peer&redirect=https%3A%2F%2Fevil.invalid';
 const path=nav.workspacePath('/dash','accounts',q),params=new URLSearchParams(selectionOf(path));
 assert.equal(params.has('redirect'),false);assert.equal(params.has('utm_source'),false);assert.equal(params.get('query'),'A&B');
 for(const pathname of ['//evil.invalid','https://evil.invalid','/x?y','/x#y','/x\r','/x\n'])assert.throws(()=>nav.workspaceSelectionPath(pathname,'accounts',six,defaults));
 assert.throws(()=>nav.workspaceSelectionPath('/','evil',six,defaults));
 const context=returns.captureWorkspaceReturn({pathname:'/dash',search:q,hash:'#accounts',generation:asOf});
 assert.equal(context.path,path);assert.equal(returns.workspaceReturnPath(context,{pathname:'/dash',generation:asOf}),path);
 assert.equal(returns.workspaceReturnPath({...context,path:context.path+'&redirect=x'},{pathname:'/dash',generation:asOf}),null);
 assert.equal(returns.workspaceReturnPath(context,{pathname:'/different',generation:asOf}),null);
 assert.equal(returns.workspaceReturnPath(context,{pathname:'/dash',generation:'2026-10-01T06:00:00.000Z'}),null);
});

test('phase66 pinned personal identity remains authoritative and never inherits workspace extras',()=>{
 const q='?'+new URLSearchParams({account:'234',start:six.start,end:six.end,generation:asOf});
 const personal=nav.workspaceNavigation(q,'#topics').personal;
 for(const extras of ['&query=%00&query=again&sort=__proto__&rosterStatus=bad','&period=bad&theme=&order=ASC']){
  assert.deepEqual(nav.workspaceNavigation(q+extras,'#topics').personal,personal);
  assert.equal(nav.workspaceListSelection(q+extras),null);
  assert.equal(nav.workspacePath('/','overview',q+extras),'/#overview');
 }
 for(const invalid of ['?account=0234','?account=234&account=235','?account=234&generation=bad','?generation='+encodeURIComponent(asOf)])assert.throws(()=>nav.workspaceNavigation(invalid+'&sort=label','#accounts'));
 assert.equal(nav.navigationNeedsLoad(nav.workspaceNavigation(q,''),{manifest:{asOf},summaryLoaded:true}),false);
 assert.equal(nav.navigationNeedsLoad(nav.workspaceNavigation(q,''),{manifest:{asOf:'2026-10-01T06:00:00.000Z'},summaryLoaded:true}),true);
});

test('phase66 old date/scope validation is not diluted by valid new list state',()=>{
 for(const q of ['?period=bad','?period=custom','?start=2026-09-31&end=2026-10-01','?start=2026-10-01&end=2026-09-30','?theme=','?theme=a&theme=b'])assert.throws(()=>nav.workspaceNavigation(q+'&query=团团&sort=label','#accounts'));
 const accounts=[{id:1,enabled:true,boardKeys:['peer'],classification:{theme:{key:'peer'},labels:[]}},{id:2,enabled:false,boardKeys:['peer'],classification:{theme:{key:'peer'},labels:[]}}];
 const selection=nav.workspaceSelection(sixQuery+'&rosterStatus=all&query=nevermatch');
 assert.deepEqual(nav.workspaceSelectionScope(selection,accounts,[{key:'peer'}]).map(a=>a.id),[1]);
});

const ts=requireSite('typescript'),source=await readFile(new URL('app/page.tsx',site),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),stateNames=[];
function visit(n){if(ts.isVariableDeclaration(n)&&ts.isArrayBindingPattern(n.name)&&ts.isCallExpression(n.initializer)&&n.initializer.expression.getText(ast)==='useState')stateNames.push(n.name.elements[0].name.getText(ast));ts.forEachChild(n,visit);}visit(ast);
const textOf=x=>x==null||typeof x==='boolean'?'':Array.isArray(x)?x.map(textOf).join(''):typeof x==='object'?textOf(x.props?.children):String(x);
function nodes(x,out=[]){if(!x||typeof x!=='object')return out;if(Array.isArray(x))x.forEach(n=>nodes(n,out));else{out.push(x);nodes(x.props?.children,out);}return out;}
const sameDeps=(a,b)=>a&&b&&a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]));
function fixture(){
 const accounts=Array.from({length:25},(_,i)=>({id:i+1,label:'合成作者'+String(i+1).padStart(3,'0'),platform:'douyin',enabled:i<22,boardKeys:['peer'],classification:{theme:{key:'peer',label:'合成主题'},labels:[]}}));
 const points=accounts.flatMap(a=>[six.start,six.end].map((date,i)=>({targetId:a.id,date,capturedAt:date+'T03:00:00.000Z',followers:i?100-a.id:100,likes:i?(a.id===2?null:a.id):0,posts:0,followersAt:date+'T03:00:00.000Z',likesAt:a.id===2&&i?null:date+'T03:00:00.000Z',postsAt:date+'T03:00:00.000Z'})));
 return {manifest:{asOf,timeZone:'Asia/Shanghai',files:accounts.map(a=>({path:'daily/'+a.id+'.json',kind:'daily',targetId:a.id,count:2,sha256:'a'.repeat(64)})),counts:{enabledAccounts:22,daily:points.length}},accounts,points,boards:[{key:'peer',name:'合成矩阵'}],topics:{topics:[],items:[]},summaryLoaded:true,dateIndexed:false};
}
function home(address='https://phase66.invalid/'+sixQuery+'#accounts'){
 let cursor=0,ordinal=0,dirty=true,tree,effects=[],frames=[];const hooks=[],slots=new Map(),listeners=new Map(),exports={},downloads=[],blobs=[],network=[];
 const initial={data:fixture(),loading:false,start:six.start,end:six.end};
 const react={useState(value){const i=cursor++,name=stateNames[ordinal++];slots.set(name,i);if(!hooks[i])hooks[i]={value:Object.hasOwn(initial,name)?initial[name]:typeof value==='function'?value():value};return [hooks[i].value,next=>{next=typeof next==='function'?next(hooks[i].value):next;if(!Object.is(next,hooks[i].value)){hooks[i].value=next;dirty=true;}}];},useRef(value){const i=cursor++;return hooks[i]??(hooks[i]={current:value});},useMemo(fn,deps){const i=cursor++;if(!sameDeps(hooks[i]?.deps,deps))hooks[i]={deps,value:fn()};return hooks[i].value;},useEffect(fn,deps){const i=cursor++,old=hooks[i];if(!sameDeps(old?.deps,deps)){hooks[i]={deps,cleanup:old?.cleanup};effects.push(()=>{old?.cleanup?.();hooks[i].cleanup=fn();});}}};
 const location=new URL(address),entries=[location.href];let entry=0;
 const document={activeElement:{tagName:'BODY'},visibilityState:'visible',querySelector:()=>null,createElement(){return {click(){downloads.push({name:this.download,blob:blobs.at(-1)});}};}};
 const window={location,scrollY:0,scrollTo(value){this.scrollY=value.top;},addEventListener:(key,fn)=>listeners.set(key,fn),removeEventListener:key=>listeners.delete(key),history:{scrollRestoration:'auto',pushState(_s,_t,next){location.href=new URL(next,location.href).href;entries.splice(++entry);entries.push(location.href);},replaceState(_s,_t,next){location.href=new URL(next,location.href).href;entries[entry]=location.href;}}};
 class DownloadURL extends URL{static createObjectURL(blob){blobs.push(blob);return 'blob:peer';}static revokeObjectURL(){}}
 const jsx=(type,props,key)=>({type,props:props||{},key});
 vm.runInNewContext(compiled,{exports,URL:DownloadURL,URLSearchParams,Date,Map,Set,Promise,AbortController,Blob,console,window,document,requestAnimationFrame:fn=>{frames.push(fn);return frames.length;},cancelAnimationFrame(){},setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},fetch:async(...args)=>{network.push(args);throw Error('Independent tests never use network');},navigator:{clipboard:{writeText:async()=>{}}},require(spec){if(spec==='react')return react;if(spec==='react/jsx-runtime')return {jsx,jsxs:jsx,Fragment:'Fragment'};if(spec==='@/lib/replica-reader.mjs')return {readReplicaPart:async()=>({items:[]})};if(spec.startsWith('@/components/')||spec==='recharts'||spec==='lucide-react')return new Proxy({}, {get:(_t,k)=>String(k)});if(spec.startsWith('@/lib/'))return requireSite(new URL(spec.slice(2),site).pathname);return requireSite(spec);}},{filename:'phase66-actual-Home.tsx'});
 function commit(x){for(const n of nodes(x)){const ref=n.props.ref;if(ref&&typeof ref==='object'&&!ref.current)ref.current={isConnected:true,focus(){document.activeElement=this;},scrollIntoView(){},getClientRects(){return [{}];}};}}
 return {window,document,downloads,network,all:()=>nodes(tree),state:name=>hooks[slots.get(name)]?.value,set(name,value){hooks[slots.get(name)].value=value;dirty=true;},go(path){location.href=new URL(path,location.href).href;listeners.get('popstate')?.();},back(){assert.ok(entry>0);location.href=entries[--entry];listeners.get('popstate')?.();},async flush(){for(let pass=0;pass<30;pass++){if(dirty){cursor=0;ordinal=0;dirty=false;tree=exports.default();commit(tree);}const due=effects;effects=[];due.forEach(fn=>fn());await Promise.resolve();if(dirty)continue;const dueFrames=frames;frames=[];dueFrames.forEach(fn=>fn());if(!dirty&&!effects.length)return;}throw Error('Home state did not settle');},close(){hooks.forEach(h=>h?.cleanup?.());}};
}
const button=(h,label)=>{const found=h.all().find(n=>n.type==='Button'&&textOf(n)===label);assert.ok(found,'Actual control missing: '+label);return found;};
const search=h=>h.all().find(n=>n.type==='Input'&&n.props['aria-label']==='搜索作者');
const listState=h=>Object.fromEntries(Object.keys(defaults).map(k=>[k,h.state(k)]));
const authors=h=>h.all().filter(n=>n.type==='Button'&&n.props.className==='author').map(textOf);

test('phase66 actual Home restores initial list URL while enabled operating totals remain independent',async()=>{
 const list={sort:'label',order:'asc',query:'023',rosterStatus:'paused'},path=nav.workspaceSelectionPath('/','accounts',six,list),h=home('https://phase66.invalid'+path);
 try{await h.flush();assert.deepEqual(listState(h),list);assert.deepEqual(authors(h),['合成作者023']);assert.equal(h.all().find(n=>n.type==='MetricLedger').props.count,22);assert.deepEqual(nav.workspaceListSelection(h.window.location.search),list);assert.equal(h.network.length,0);assert.equal(search(h).props.maxLength,200);
  button(h,'导出全部结果').props.onClick();const csv=await h.downloads[0].blob.text();assert.equal(csv.trimEnd().split(/\r?\n/).length,2);assert.ok(csv.includes('"'+asOf+'","23","douyin"'));assert.ok(csv.includes('暂停（仅历史）'));
 }finally{h.close();}
});

test('phase66 actual Home writes changed list state and a fresh controller recreates the result',async()=>{
 const h=home();let fresh;try{await h.flush();search(h).props.onChange({target:{value:'002'}});button(h,'点赞').props.onClick();await h.flush();const saved=h.window.location.href;
  assert.deepEqual(nav.workspaceListSelection(h.window.location.search),{...defaults,sort:'likes.value',query:'002'});fresh=home(saved);await fresh.flush();assert.deepEqual(listState(fresh),listState(h));assert.deepEqual(authors(fresh),['合成作者002']);
  const metrics=fresh.all().find(n=>n.type==='MetricLedger').props.metrics;assert.equal(metrics.likes.knownCount,21);assert.equal(metrics.likes.comparableCount,21);assert.equal(metrics.followers.delta,-253);assert.equal(metrics.posts.delta,0);assert.equal(fresh.network.length,0);
 }finally{h.close();fresh?.close();}
});

test('phase66 actual Home old-six and list-empty popstate clear stale conditions instead of leaking them',async()=>{
 const h=home('https://phase66.invalid'+nav.workspaceSelectionPath('/','accounts',six,{sort:'posts.value',order:'asc',query:'024',rosterStatus:'paused'}));
 try{await h.flush();assert.equal(h.state('query'),'024');h.go('/'+sixQuery+'#accounts');await h.flush();assert.deepEqual(listState(h),defaults);assert.equal(authors(h).length,20);
  search(h).props.onChange({target:{value:'003'}});await h.flush();h.go('/#accounts');await h.flush();assert.deepEqual(listState(h),defaults);assert.equal(h.state('page'),1);
 }finally{h.close();}
});

test('phase66 actual Home protected account return preserves list/date/version and ordinary tabs retain it',async()=>{
 const list={sort:'followers.value',order:'asc',query:'003',rosterStatus:'all'},h=home('https://phase66.invalid'+nav.workspaceSelectionPath('/','accounts',six,list));
 try{await h.flush();button(h,'话题观察').props.onClick();await h.flush();button(h,'账号明细').props.onClick();await h.flush();assert.deepEqual(listState(h),list);assert.deepEqual(nav.workspaceListSelection(h.window.location.search),list);
  h.window.scrollY=640;h.all().find(n=>n.type==='CoveragePanel').props.onAccount(h.state('data').accounts[2]);await h.flush();assert.equal(h.state('personal').generation,asOf);for(const key of Object.keys(defaults))assert.equal(h.window.location.search.includes(key+'='),false);
  const panel=h.all().find(n=>n.type==='AccountPanel');assert.equal(panel.props.returnLabel,'返回原核对页');panel.props.onReturn();await h.flush();assert.deepEqual(listState(h),list);assert.equal(h.state('start'),six.start);assert.equal(h.state('end'),six.end);assert.equal(h.window.scrollY,640);assert.equal(h.network.length,0);
 }finally{h.close();}
});

test('phase66 actual Home malformed list URL stops before data loading and displays validation error',async()=>{
 const h=home('https://phase66.invalid/?sort=__proto__#accounts');try{await h.flush();assert.match(h.state('linkError'),/无效/);assert.equal(h.network.length,0);assert.equal(h.state('personal'),null);assert.equal(h.state('loading'),false);}finally{h.close();}
});

test('phase66 actual pending-period disclosure never serializes an unapplied draft or substitutes new totals',async()=>{
 const h=home();try{await h.flush();const beforeURL=h.window.location.href,beforeMetrics=h.all().find(n=>n.type==='MetricLedger').props.metrics,beforeData=h.state('data');
  const period=h.all().find(n=>n.type==='select'&&nodes(n).some(child=>child.type==='option'&&child.props.value==='week'));assert.ok(period);
  period.props.onChange({target:{value:'week'}});await h.flush();
  assert.equal(h.state('start'),six.start);assert.equal(h.state('end'),six.end);assert.equal(h.window.location.href,beforeURL);assert.equal(h.state('data'),beforeData);assert.equal(h.all().find(n=>n.type==='MetricLedger').props.metrics,beforeMetrics);
  assert.match(textOf(h.all().find(n=>n.props.className==='period-state')),/当前已应用自选日期2026-09-12 → 2026-09-30/);
  assert.match(textOf(h.all().find(n=>n.props.className==='period-pending')),/待应用：近7天净变.*尚未改变统计/);
  button(h,'应用周期').props.onClick();await h.flush();assert.equal(h.state('start'),'2026-09-23');assert.equal(h.state('end'),'2026-09-30');assert.equal(nav.workspaceSelection(h.window.location.search).period,'week');assert.equal(h.all().some(n=>n.props.className==='period-pending'),false);
  const metrics=h.all().find(n=>n.type==='MetricLedger').props.metrics;assert.equal(metrics.followers.delta,null);assert.equal(metrics.followers.comparableCount,0);assert.equal(h.state('data'),beforeData);assert.equal(h.network.length,0);
 }finally{h.close();}
});

test('phase66 actual sorting disclosure and aria-sort track both directions while missing stays last in export',async()=>{
 const h=home();try{await h.flush();const context=()=>h.all().find(n=>n.props['aria-label']==='当前列表排序');
  assert.match(textOf(context()),/当前排序.*粉丝变化 · 降序 ↓.*缺测始终置后/);
  button(h,'点赞').props.onClick();await h.flush();assert.match(textOf(context()),/点赞 · 降序 ↓/);assert.equal(h.all().filter(n=>n.type==='TableHead'&&n.props['aria-sort']==='descending').length,1);
  button(h,'点赞 ↓').props.onClick();await h.flush();assert.match(textOf(context()),/点赞 · 升序 ↑/);assert.equal(h.all().filter(n=>n.type==='TableHead'&&n.props['aria-sort']==='ascending').length,1);assert.equal(authors(h)[0],'合成作者001');
  assert.deepEqual(nav.workspaceListSelection(h.window.location.search),{...defaults,sort:'likes.value',order:'asc'});
  button(h,'导出全部结果').props.onClick();const lines=(await h.downloads[0].blob.text()).trimEnd().split(/\r?\n/);assert.equal(lines.length,23);assert.ok(lines.at(-1).includes('合成作者002'),'unknown likes must stay last, never rank as a real zero');
 }finally{h.close();}
});
