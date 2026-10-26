// Independent controller tests: compile the actual Site page; no browser/network/DB/writer credential.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const SITE = new URL('../../mcn-public-site/', import.meta.url);
const requireSite = createRequire(new URL('package.json', SITE));
const ts = requireSite('typescript');
// One immutable source snapshot per process prevents a mixed-version result while root edits.
const pageSource = await readFile(new URL('app/page.tsx',SITE),'utf8');
const pageCode = ts.transpileModule(pageSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,
  target:ts.ScriptTarget.ES2022, jsx:ts.JsxEmit.ReactJSX}}).outputText;
const { loadReplicaView } = await import(new URL('lib/replica-view.mjs', SITE));
const AS_OF = '2026-10-01T03:00:00.000Z';
const common = { version: 1, asOf: AS_OF, timeZone: 'Asia/Shanghai' };
const accounts = Array.from({length: 45}, (_, i) => ({id: i+1, label: `Synthetic ${i+1}`, enabled: true,
  boardKeys: ['tuantuan'], classification: {theme: {key:'tuantuan', label:'团团'},
    labels: [{key:'slice', label:'切片'}]}}));
const catalog = {...common, accounts, boards: [{key:'tuantuan', name:'团团矩阵'}]};
const topics = {...common, topics: [{id:1, label:'#一条小团团OvO'}], items: []};
const summary = {...common, items: []};
const meta = {manifest: {...common, counts: {enabledAccounts:45, daily:0},
  files: ['catalog.json','topics.json','summary.json'].map(path => ({path,
    kind:path.split('.')[0],count:path==='catalog.json'?45:0,bytes:1,sha256:'a'.repeat(64)}))}, publishedAt:AS_OF};
const parts = {'catalog.json':catalog, 'topics.json':topics, 'summary.json':summary};
const deferred = () => {let resolve,reject; const promise = new Promise((r,j) => {resolve=r;reject=j;}); return {promise,resolve,reject};};
const textOf = value => value == null || typeof value === 'boolean' ? '' : typeof value === 'object'
  ? Array.isArray(value) ? value.map(textOf).join('') : textOf(value.props?.children) : String(value);
function nodes(value, result=[]) {
  if(!value || typeof value !== 'object') return result;
  if(Array.isArray(value)) value.forEach(x => nodes(x,result));
  else {result.push(value); nodes(value.props?.children,result);} return result;
}

async function pageHarness(address='https://synthetic.invalid/#overview', options={}) {
  let cursor=0, dirty=false, tree, pendingEffects=[], strictReplayed=false;
  const hooks=[], listeners=new Map(), reads=[], fetches=[], scrolls=[], historyEntries=[address];
  const focusEvents=[];
  const document={visibilityState:'visible',activeElement:null,
    querySelector(selector){
      if(selector!=='[role="dialog"]')return null;
      return typeof options.dialogPresent==='function'?options.dialogPresent():options.dialogPresent||null;
    }};
  let historyIndex=0, href=address;
  const location={};
  for(const property of ['href','pathname','search','hash']) Object.defineProperty(location,property,
    {get:()=>new URL(href)[property]});
  const window={location, scrollY:0, scrollTo(options){scrolls.push(options);this.scrollY=options.top;},
    addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},
    removeEventListener(name,fn){listeners.get(name)?.delete(fn);},
    history:{pushState(_state,_title,next){href=new URL(next,href).href;
      historyEntries.splice(++historyIndex); historyEntries.push(href);},
      replaceState(_state,_title,next){href=new URL(next,href).href; historyEntries[historyIndex]=href;}}};
  const react={
    useState(initial){const i=cursor++;if(!(i in hooks))hooks[i]={value:typeof initial==='function'?initial():initial};
      return [hooks[i].value,value=>{const next=typeof value==='function'?value(hooks[i].value):value;
        if(!Object.is(next,hooks[i].value)){hooks[i].value=next;dirty=true;}}];},
    useRef(initial){const i=cursor++;if(!(i in hooks))hooks[i]={current:initial};return hooks[i];},
    useMemo(fn){cursor++;return fn();},
    useEffect(fn,deps){const i=cursor++, old=hooks[i];if(!old||deps.some((x,j)=>!Object.is(x,old.deps[j]))) {
      hooks[i]={deps,fn,cleanup:old?.cleanup};pendingEffects.push(()=>{old?.cleanup?.();hooks[i].cleanup=fn();});}},
  };
  const jsx=(type,props,key)=>{
    if(options.attachFocusTargets&&props?.ref&&['h1','Input'].includes(type)){
      props.ref.current={isConnected:true,focus(settings){document.activeElement=this;focusEvents.push({type,settings});}};
    }
    return {type,props:props||{},key};
  };
  const exports={};
  const context={exports, window, document,
    URL,URLSearchParams,AbortController,Blob,Date,Map,Set,Promise,console,
    requestAnimationFrame:fn=>{fn();return 1;},setTimeout,clearTimeout,
    setInterval:()=>1,clearInterval:()=>{},
    fetch:async(url,init)=>{fetches.push({url,signal:init?.signal});
      if(options.beforeFetch) await options.beforeFetch(fetches.length,url,init);
      return {ok:true,json:async()=>structuredClone(options.meta??meta)};},
    require(specifier){
      if(specifier==='react')return react;
      if(specifier==='react/jsx-runtime')return {jsx,jsxs:jsx,Fragment:'Fragment'};
      if(specifier==='@/lib/replica-reader.mjs')return {readReplicaPart:async({part,signal})=>{
        reads.push(part);signal?.throwIfAborted();return structuredClone(options.parts?.[part]??parts[part]);}};
      if(specifier==='@/lib/replica-coverage.mjs')return {accountCoverage:()=>({})};
      if(specifier==='@/lib/replica-periods.mjs')return {periodNames:{since:'9/12至今',custom:'自选'},
        periodWindow:()=>({start:'2026-09-12',end:'2026-09-30',note:'synthetic observation range'})};
      if(specifier.startsWith('@/lib/'))return requireSite(new URL(specifier.slice(2),SITE).pathname);
      if(specifier.startsWith('@/components/'))return new Proxy({}, {get:(_t,key)=>String(key)});
      return requireSite(specifier);
    },
  };
  vm.runInNewContext(pageCode,context,{filename:'independent-actual-page-navigation.cjs'});
  function render(){cursor=0;dirty=false;tree=exports.default();}
  async function flush(){for(let i=0;i<12;i++) {
    if(dirty||!tree)render(); const effects=pendingEffects;pendingEffects=[];effects.forEach(f=>f());
    if(options.strict&&!strictReplayed){strictReplayed=true;
      hooks.filter(h=>h?.fn).forEach(h=>h.cleanup?.());
      hooks.filter(h=>h?.fn).forEach(h=>{h.cleanup=h.fn();});}
    await new Promise(r=>setImmediate(r)); if(!dirty&&!pendingEffects.length)break;
  }if(dirty)render();return tree;}
  const all=()=>nodes(tree);
  const findButton=label=>{const node=all().find(n=>n.type==='Button'&&textOf(n)===label);
    assert.ok(node,`missing button ${label}`);return node;};
  render();await flush();
  return {reads,fetches,scrolls,window,historyEntries,flush,document,focusEvents,
    heading:()=>textOf(all().find(n=>n.type==='h1')),
    currentNav:()=>textOf(all().find(n=>n.type==='Button'&&n.props['aria-current']==='page')),
    button:findButton,
    element:predicate=>all().find(predicate),
    async click(label){findButton(label).props.onClick({currentTarget:{isConnected:true,focus(){}}});await flush();},
    async change(predicate,value){const n=all().find(predicate);assert.ok(n,'missing input/select');n.props.onChange({target:{value}});await flush();},
    async dispatch(name){for(const fn of [...listeners.get(name)||[]])fn({});await flush();},
    async back(){assert.ok(historyIndex>0);href=historyEntries[--historyIndex];await this.dispatch('popstate');},
    async forward(){assert.ok(historyIndex<historyEntries.length-1);href=historyEntries[++historyIndex];await this.dispatch('popstate');},
    async anchor(hash){href=new URL(hash,href).href;await this.dispatch('hashchange');},
    async wordmark(modifiers={}){const a=all().find(n=>n.type==='a'&&n.props.className==='wordmark');
      assert.ok(a,'missing wordmark');let prevented=false;
      a.props.onClick?.({button:0,metaKey:false,ctrlKey:false,shiftKey:false,altKey:false,
        ...modifiers,
        preventDefault(){prevented=true;}});
      if(!prevented&&!Object.values(modifiers).some(Boolean)){href=new URL(a.props.href,href).href;await this.dispatch('hashchange');}
      await flush();return {prevented};},
    close(){hooks.forEach(h=>h?.cleanup?.());},
  };
}

test('peer U27/U45: initial #accounts renders account view, not overview',async()=>{
 const h=await pageHarness('https://synthetic.invalid/#accounts');try {
  assert.equal(h.heading(),'账号明细');assert.equal(h.currentNav(),'账号明细');
 }finally{h.close();}
});
test('peer U27: initial #topics is independent of matrix summary',async()=>{
 const h=await pageHarness('https://synthetic.invalid/#topics');try {
  assert.equal(h.heading(),'话题观察');assert.equal(h.currentNav(),'话题观察');
  assert.deepEqual(h.reads,['catalog.json','topics.json']);
 }finally{h.close();}
});
test('peer U27: sidebar overview→topics updates share/reload address exactly once',async()=>{
 const h=await pageHarness();try {const n=h.historyEntries.length;await h.click('话题观察');
  assert.equal(h.heading(),'话题观察');assert.equal(h.window.location.hash,'#topics');
  assert.equal(h.historyEntries.length,n+1);assert.equal(h.window.location.search,'?period=since&start=2026-09-12&end=2026-09-30');
  const p=new URLSearchParams(h.window.location.search);assert.equal(p.has('account'),false);assert.equal(p.has('generation'),false);
 }finally{h.close();}
});
test('peer U27/U45: Back and Forward restore both address and visible tab',async()=>{
 const h=await pageHarness();try {await h.click('账号明细');await h.click('话题观察');
  await h.back();assert.equal(h.window.location.hash,'#accounts');assert.equal(h.heading(),'账号明细');
  await h.back();assert.equal(h.heading(),'矩阵经营总览');
  await h.forward();assert.equal(h.heading(),'账号明细');await h.forward();assert.equal(h.heading(),'话题观察');
 }finally{h.close();}
});
test('peer U27: native hashchange synchronizes the tab without redundant summary reload',async()=>{
 const h=await pageHarness('https://synthetic.invalid/#topics');try {
  await h.anchor('#accounts');assert.equal(h.heading(),'账号明细');assert.ok(h.reads.includes('summary.json'));
  const count=h.reads.filter(p=>p==='summary.json').length;
  await h.anchor('#overview');assert.equal(h.heading(),'矩阵经营总览');
  assert.equal(h.reads.filter(p=>p==='summary.json').length,count);
 }finally{h.close();}
});
test('peer U45: direct personal URL loads catalog/topics, never global summary',async()=>{
 const h=await pageHarness('https://synthetic.invalid/?account=1&generation='+encodeURIComponent(AS_OF));try {
  assert.equal(h.heading(),'账号经营详情');assert.deepEqual(h.reads,['catalog.json','topics.json']);
  const panel=h.element(n=>n.type==='AccountPanel');assert.equal(panel.props.request.id,1);
  assert.equal(panel.props.request.generation,AS_OF);
 }finally{h.close();}
});
test('peer U27/U45: personal→topics has #topics URL and never fetches matrix summary',async()=>{
 const h=await pageHarness('https://synthetic.invalid/?account=1&generation='+encodeURIComponent(AS_OF));try {
  await h.click('话题观察');assert.equal(h.heading(),'话题观察');assert.equal(h.window.location.hash,'#topics');
  assert.equal(h.window.location.search,'');assert.equal(h.reads.includes('summary.json'),false);
 }finally{h.close();}
});
test('peer U45: personal→global Back restores pinned identity and Forward returns accounts',async()=>{
 const h=await pageHarness('https://synthetic.invalid/?account=2&generation='+encodeURIComponent(AS_OF));try {
  const panel=h.element(n=>n.type==='AccountPanel');panel.props.onReturn();await h.flush();
  assert.equal(h.heading(),'账号明细');assert.equal(h.window.location.hash,'#accounts');
  await h.back();assert.equal(h.heading(),'账号经营详情');
  assert.equal(h.element(n=>n.type==='AccountPanel').props.request.id,2);
  await h.forward();assert.equal(h.heading(),'账号明细');
 }finally{h.close();}
});
test('peer U27/U45: personal wordmark returns clean overview URL instead of retaining account query',async()=>{
 const h=await pageHarness('https://synthetic.invalid/?account=2&generation='+encodeURIComponent(AS_OF));try {
  await h.wordmark();assert.equal(h.heading(),'矩阵经营总览');
  assert.equal(h.window.location.search,'?period=since&start=2026-09-12&end=2026-09-30');assert.equal(h.window.location.hash,'#overview');
  const p=new URLSearchParams(h.window.location.search);assert.equal(p.has('account'),false);assert.equal(p.has('generation'),false);
 }finally{h.close();}
});
test('peer U27: wordmark preserves native Ctrl/Cmd open-new-tab without changing current personal page',async()=>{
 const h=await pageHarness('https://synthetic.invalid/?account=2&generation='+encodeURIComponent(AS_OF));try {
  const address=h.window.location.href;
  for(const modifiers of [{ctrlKey:true},{metaKey:true}]) {
   const result=await h.wordmark(modifiers);assert.equal(result.prevented,false,'modified link click must remain native');
   assert.equal(h.window.location.href,address);assert.equal(h.heading(),'账号经营详情');
  }
 }finally{h.close();}
});
test('peer U27: popstate plus hashchange for the same address does not duplicate metadata or part requests',async()=>{
 const h=await pageHarness('https://synthetic.invalid/?account=2&generation='+encodeURIComponent(AS_OF));try {
  await h.click('话题观察');await h.back();
  assert.equal(h.heading(),'账号经营详情');const fetches=h.fetches.length,reads=h.reads.length;
  await h.dispatch('hashchange');assert.equal(h.fetches.length,fetches);assert.equal(h.reads.length,reads);
 }finally{h.close();}
});
test('peer U27: invalid personal URL error can recover directly to topics without global summary',async()=>{
 const h=await pageHarness('https://synthetic.invalid/?account=0');try {
  assert.ok(h.element(n=>n.props?.role==='alert'));await h.click('话题观察');
  assert.equal(h.heading(),'话题观察');assert.equal(h.window.location.hash,'#topics');
  assert.equal(h.window.location.search,'');assert.equal(h.element(n=>n.props?.role==='alert'),undefined);
  assert.equal(h.reads.includes('summary.json'),false);
 }finally{h.close();}
});
test('peer U45: filter/date/search/rank draft survives a personal visit and return',async()=>{
 const items=accounts.flatMap(account=>['2026-09-12','2026-09-15'].map(date=>{
  const capturedAt=date+'T04:00:00.000Z',delta=date==='2026-09-15'?1:0;
  return {targetId:account.id,date,capturedAt,followers:account.id*100+delta,followersAt:capturedAt,
   likes:account.id*200+delta,likesAt:capturedAt,posts:account.id*10+delta,postsAt:capturedAt};
 }));
 const testMeta={...meta,manifest:{...meta.manifest,counts:{...meta.manifest.counts,daily:items.length},
  files:meta.manifest.files.map(file=>file.path==='summary.json'?{...file,count:items.length}:file)}};
 const h=await pageHarness('https://synthetic.invalid/#accounts',{meta:testMeta,parts:{'summary.json':{...common,items}}});try {
  await h.change(n=>n.type==='select'&&n.props.children?.[0]?.props?.children==='全部主题','tuantuan');
  await h.change(n=>n.type==='select'&&n.props.children?.[0]?.props?.children==='全部分类','slice');
  await h.change(n=>n.type==='Input'&&n.props.type==='date'&&n.props.max,'2026-09-15');
  await h.change(n=>n.type==='Input'&&n.props['aria-label']==='搜索作者','Synthetic');
  await h.click('粉丝');
  // This controller harness does not expand local function components such as Pager;
  // drive the real owner callback, then verify the persisted page prop after navigation.
  const pager=()=>h.element(n=>n.type?.name==='Pager'&&Number.isSafeInteger(n.props?.count));
  assert.equal(pager()?.props.count,45);assert.equal(pager()?.props.page,1);
  pager().props.change(2);await h.flush();
  const pageState=()=>({count:pager()?.props.count,page:pager()?.props.page});
  const savedPage=pageState();assert.deepEqual(savedPage,{count:45,page:2});
  const date=h.element(n=>n.type==='Input'&&n.props.type==='date'&&n.props.max).props.value;
  const sort=textOf(h.element(n=>n.type==='TableHead'&&n.props['aria-sort']==='descending'));
  h.window.scrollY=720;
  const historyEntry=h.element(n=>n.type==='Button'&&n.props['aria-label']==='查看Synthetic 21的历史');assert.ok(historyEntry);historyEntry.props.onClick({currentTarget:{isConnected:true,focus(){}}});await h.flush();await h.click('打开独立账号页面');
  assert.equal(h.heading(),'账号经营详情');
  h.element(n=>n.type==='AccountPanel').props.onReturn();await h.flush();
  assert.equal(h.heading(),'账号明细');assert.equal(h.element(n=>n.type==='Input'&&n.props.type==='date'&&n.props.max).props.value,date);
  assert.equal(h.element(n=>n.type==='Input'&&n.props['aria-label']==='搜索作者').props.value,'Synthetic');
  assert.deepEqual(pageState(),savedPage);
  assert.equal(textOf(h.element(n=>n.type==='TableHead'&&n.props['aria-sort']==='descending')),sort);
  assert.equal(h.element(n=>n.type==='select'&&n.props.children?.[0]?.props?.children==='全部主题').props.value,'tuantuan');
  assert.equal(h.element(n=>n.type==='select'&&n.props.children?.[0]?.props?.children==='全部分类').props.value,'slice');
  assert.ok(h.scrolls.some(s=>s.top===720));
 }finally{h.close();}
});
test('peer U27/U45: late personal load cannot re-pin URL after navigation to topics',async()=>{
 const gate=deferred();const h=await pageHarness('https://synthetic.invalid/?account=3',{
  beforeFetch:count=>count===1?gate.promise:undefined});try {
  await h.click('话题观察');gate.resolve();await h.flush();
  assert.equal(h.heading(),'话题观察');assert.equal(h.window.location.hash,'#topics');
  assert.equal(h.window.location.search,'');assert.equal(h.reads.includes('summary.json'),false);
 }finally{gate.resolve();h.close();}
});
test('peer U27: StrictMode effect setup-cleanup-setup restarts aborted initial load',async()=>{
 const h=await pageHarness('https://synthetic.invalid/#accounts',{strict:true});try {
  assert.equal(h.heading(),'账号明细');assert.ok(h.element(n=>n.type==='CoveragePanel'),'replay must load data, not stay indefinitely connecting');
  assert.equal(h.button('刷新已发布数据').props.disabled,false);
  assert.equal(h.fetches.length,2);assert.equal(h.fetches[0].signal.aborted,true);
 }finally{h.close();}
});
test('peer U27: repeatedly clicking current tab does not abort or duplicate an in-flight initial read',async()=>{
 const gate=deferred();const h=await pageHarness('https://synthetic.invalid/#accounts',{
  beforeFetch:count=>count===1?gate.promise:undefined});try {
  await h.click('账号明细');await h.click('账号明细');
  assert.equal(h.fetches.length,1);assert.equal(h.fetches[0].signal.aborted,false);
  assert.equal(h.historyEntries.length,1);gate.resolve();await h.flush();
  assert.equal(h.heading(),'账号明细');assert.ok(h.element(n=>n.type==='CoveragePanel'));
 }finally{gate.resolve();h.close();}
});
test('peer U27/U45: late global refresh cannot replace a cached fixed-version personal page',async()=>{
 const gate=deferred();const h=await pageHarness('https://synthetic.invalid/#accounts',{
  beforeFetch:count=>count===2?gate.promise:undefined});try {
  await h.click('刷新已发布数据');h.window.scrollY=510;
  h.element(n=>n.type==='CoveragePanel').props.onAccount(accounts[20]);await h.flush();
  assert.equal(h.heading(),'账号经营详情');assert.equal(h.fetches[1].signal.aborted,true);
  const address=h.window.location.href;gate.resolve();await h.flush();
  assert.equal(h.window.location.href,address);assert.equal(h.heading(),'账号经营详情');
  assert.equal(h.element(n=>n.type==='AccountPanel').props.request.id,21);
  assert.equal(h.element(n=>n.props?.role==='alert'),undefined);
 }finally{gate.resolve();h.close();}
});
test('peer U27: late global refresh cannot change topic URL/view or overwrite cached topics',async()=>{
 const gate=deferred();const h=await pageHarness('https://synthetic.invalid/#overview',{
  beforeFetch:count=>count===2?gate.promise:undefined});try {
  await h.click('刷新已发布数据');await h.click('话题观察');
  assert.equal(h.fetches[1].signal.aborted,true);gate.resolve();await h.flush();
  assert.equal(h.heading(),'话题观察');assert.equal(h.window.location.hash,'#topics');
  assert.equal(h.currentNav(),'话题观察');assert.equal(h.element(n=>n.props?.role==='alert'),undefined);
 }finally{gate.resolve();h.close();}
});
test('peer U27/U45: failed explicit global refresh preserves address, previous catalog and draft',async()=>{
 const h=await pageHarness('https://synthetic.invalid/#accounts',{
  beforeFetch:count=>{if(count===2)throw Error('synthetic transport unavailable');}});try {
  await h.change(n=>n.type==='Input'&&n.props['aria-label']==='搜索作者','Synthetic 2');
  const address=h.window.location.href;await h.click('刷新已发布数据');
  assert.equal(h.window.location.href,address);assert.equal(h.heading(),'账号明细');
  assert.ok(h.element(n=>n.type==='CoveragePanel'));assert.ok(h.element(n=>n.props?.role==='alert'));
  assert.equal(h.element(n=>n.type==='Input'&&n.props['aria-label']==='搜索作者').props.value,'Synthetic 2');
  assert.equal(h.button('刷新已发布数据').props.disabled,false);
 }finally{h.close();}
});
test('peer U27/U45: rejected superseded transport cannot raise error on cached personal page',async()=>{
 const gate=deferred();const h=await pageHarness('https://synthetic.invalid/#accounts',{
  beforeFetch:count=>count===2?gate.promise:undefined});try {
  await h.click('刷新已发布数据');h.element(n=>n.type==='CoveragePanel').props.onAccount(accounts[20]);await h.flush();
  const address=h.window.location.href;gate.reject(Error('synthetic superseded transport'));await h.flush();
  assert.equal(h.window.location.href,address);assert.equal(h.heading(),'账号经营详情');
  assert.equal(h.element(n=>n.props?.role==='alert'),undefined);
 }finally{gate.resolve();h.close();}
});
test('peer U27/U45: summary failure does not poison independent personal/topic reads',async()=>{
 for(const mode of [{personal:true},{topicsOnly:true}]) {
  const reads=[];const loaded=await loadReplicaView({manifest:meta.manifest,...mode,
   readPart:async part=>{reads.push(part);if(part==='summary.json')throw Error('synthetic unavailable summary');return parts[part];}});
  assert.deepEqual(reads,['catalog.json','topics.json']);assert.equal(loaded.summaryLoaded,false);
  assert.equal(loaded.accounts.length,45);assert.equal(loaded.topics.topics.length,1);
 }
});

test('peer U45 Phase59: returning to existing gap dialog does not steal its focus, ordinary return retains heading fallback',async()=>{
 for(const dialogOpen of [true,false]){
  const dialogFocus={role:'dialog',name:'existing-gap-focus'};
  let dialog=null;
  const h=await pageHarness('https://synthetic.invalid/#overview',{
   attachFocusTargets:true,dialogPresent:()=>dialog,
  });try{
   const initialGap=h.element(n=>n.type==='DailyCoveragePanel');
   assert.ok(initialGap,'the original overview has a daily gap panel');
   assert.equal(initialGap.props.suspended,false);
   h.window.scrollY=620;
   h.element(n=>n.type==='CoveragePanel').props.onAccount(accounts[0]);await h.flush();
   assert.equal(h.heading(),'账号经营详情');
   const retainedGap=h.element(n=>n.type==='DailyCoveragePanel');
   assert.ok(retainedGap,'personal view retains the original globalTab gap component instead of removing it');
   assert.equal(retainedGap.key,initialGap.key,'scope/date/version key must not change for a same-version personal visit');
   assert.equal(retainedGap.props.suspended,true,'a retained panel must close its portal while personal view is active');
   assert.ok(h.element(n=>n.type==='div'&&n.props.hidden===true),'retained workspace is hidden from the personal view');
   const panel=h.element(n=>n.type==='AccountPanel');assert.equal(panel.props.returnLabel,'返回原核对页');
   dialog=dialogOpen?dialogFocus:null;h.document.activeElement=dialogOpen?dialogFocus:null;
   const priorFocus=h.focusEvents.length;
   panel.props.onReturn();await h.flush();
   assert.equal(h.heading(),'矩阵经营总览');assert.equal(h.window.location.hash,'#overview');
   const resumedGap=h.element(n=>n.type==='DailyCoveragePanel');
   assert.equal(resumedGap.key,initialGap.key);
   assert.equal(resumedGap.props.suspended,false);
   assert.ok(h.scrolls.some(s=>s.top===620),'return still restores the prior scroll');
   if(dialogOpen){
    assert.equal(h.focusEvents.length,priorFocus,'existing dialog owns focus; global heading/search must not steal it');
    assert.equal(h.document.activeElement,dialogFocus);
   }else{
    assert.equal(h.focusEvents.length,priorFocus+1);
    assert.equal(h.focusEvents.at(-1).type,'h1','ordinary overview return keeps its prior accessible fallback');
   }
  }finally{h.close();}
 }
});

test('peer U29/U45 Phase59: malformed global date links escape to clean validated account workspace',async()=>{
 for(const query of ['?period=custom&start=2026-09-31&end=2026-10-01','?period=custom&start=2026-09-12']){
  const h=await pageHarness('https://synthetic.invalid/'+query+'#overview');try{
   assert.ok(h.element(n=>n.props?.role==='alert'));
   await h.click('返回账号列表');
   assert.equal(h.heading(),'账号明细');assert.equal(h.window.location.hash,'#accounts');
   assert.equal(h.window.location.search,'?period=since&start=2026-09-12&end=2026-09-30');
   assert.equal(h.element(n=>n.props?.role==='alert'),undefined);
   assert.ok(h.element(n=>n.type==='CoveragePanel'),'clean recovery loads the real workspace instead of retaining an error-only view');
   assert.equal(h.element(n=>n.type==='select'&&n.props.children?.[0]?.props?.children==='全部主题').props.value,'all');
   assert.equal(h.element(n=>n.type==='select'&&n.props.children?.[0]?.props?.children==='全部分类').props.value,'all');
   assert.equal(h.element(n=>n.type==='Input'&&n.props.type==='date'&&n.props.max).props.value,'2026-09-12');
  }finally{h.close();}
 }
});
