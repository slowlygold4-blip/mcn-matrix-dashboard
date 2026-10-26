// Independent real Home task behavior; synthetic sealed sources only, no production/network/DB.
// Classification component tasks are appended below the same actual Home controller tests.
// Independent controller tests: compile the actual Site page; no browser/network/DB/writer credential.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {derivePublicHistoryDateIndex} from '../lib/public-history-range.mjs';

const SITE = new URL('../../mcn-public-site/', import.meta.url);
const requireSite = createRequire(new URL('package.json', SITE));
const ts = requireSite('typescript');
// One immutable source snapshot per process prevents a mixed-version result while root edits.
const pageSource = await readFile(new URL('app/page.tsx',SITE),'utf8');
const pageCode = ts.transpileModule(pageSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,
  target:ts.ScriptTarget.ES2022, jsx:ts.JsxEmit.ReactJSX}}).outputText;
const ledgerSource = await readFile(new URL('components/metric-ledger.tsx',SITE),'utf8');
const ledgerCode = ts.transpileModule(ledgerSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,
  target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const { loadReplicaView } = await import(new URL('lib/replica-view.mjs', SITE));
const {periodWindowFromCatalog,periodWindow}=await import(new URL('lib/replica-periods.mjs',SITE));
const AS_OF='2026-09-29T16:34:00.000Z',BASE='2026-09-12';
const hash=s=>createHash('sha256').update(s).digest('hex');
const shift=(date,n)=>new Date(Date.parse(date+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
async function fixture({asOf=AS_OF,indexed=true}={}) {
 const common={version:1,asOf,timeZone:'Asia/Shanghai'},parts={},sources=new Map(),files=[],points=[];
 const accounts=Array.from({length:3},(_,i)=>({id:i+1,label:'Synthetic '+(i+1),platform:'douyin',enabled:true,
  boardKeys:[i<2?'tuantuan':'other'],classification:{theme:{key:i<2?'tuantuan':'other',label:i<2?'团团':'其他'},
  labels:[{key:i<2?'slice':'original',label:i<2?'切片':'原创'}]}}));
 for(const a of accounts) {
  const items=Array.from({length:a.id<3?18:17},(_,n)=>{const date=shift(BASE,n),capturedAt=date+'T02:00:00.000Z';
   return {id:n+1,targetId:a.id,date,capturedAt,followers:1000+a.id+n*n,followersAt:capturedAt,
    likes:500+a.id+7*n,likesAt:capturedAt,posts:Math.floor(n/3),postsAt:capturedAt};});
  const p=items.at(-1);a.latest=Object.fromEntries(['followers','likes','posts'].map(k=>[k,{value:p[k],date:p.date,observedAt:p.capturedAt}]));
  points.push(...items.map(({id,...p})=>p));const path='daily/'+a.id+'.json',content=JSON.stringify({...common,items})+'\n';
  sources.set(path,content);parts[path]=JSON.parse(content);files.push({path,kind:'daily',targetId:a.id,count:items.length,bytes:Buffer.byteLength(content),sha256:hash(content)});
 }
 const boards=[{key:'tuantuan',name:'团团矩阵'},{key:'other',name:'其他矩阵'}];
 for(const [path,kind,value,count] of [['catalog.json','catalog',{...common,accounts,boards},3],
  ['topics.json','topics',{...common,topics:[{id:1,label:'#一条小团团OvO'}],items:[]},0],
  ['summary.json','summary',{...common,items:points},points.length]]) {
  const content=JSON.stringify(value)+'\n';parts[path]=value;files.push({path,kind,count,bytes:Buffer.byteLength(content),sha256:hash(content)});
 }
 const manifest={...common,counts:{enabledAccounts:3,daily:points.length},files};
 if(indexed) {
  const derived=await derivePublicHistoryDateIndex({sourceManifest:manifest,readPart:async p=>sources.get(p)});
  for(const {content,...meta} of [derived.indexFile,...derived.files]){parts[meta.path]=JSON.parse(content);manifest.files.push(meta);}
 }
 return {meta:{manifest,publishedAt:asOf},parts,accounts,points};
}
const deferred = () => {let resolve,reject; const promise = new Promise((r,j) => {resolve=r;reject=j;}); return {promise,resolve,reject};};
const textOf = value => value == null || typeof value === 'boolean' ? '' : typeof value === 'object'
  ? Array.isArray(value) ? value.map(textOf).join('') : textOf(value.props?.children) : String(value);
function nodes(value, result=[]) {
  if(!value || typeof value !== 'object') return result;
  if(Array.isArray(value)) value.forEach(x => nodes(x,result));
  else {result.push(value); nodes(value.props?.children,result);} return result;
}

async function pageHarness(address='https://synthetic.invalid/#overview', options={}) {
  const {meta,parts}=options.fixture??await fixture();
  let cursor=0, dirty=false, tree, pendingEffects=[], strictReplayed=false;
  const hooks=[], listeners=new Map(), reads=[], fetches=[], scrolls=[], historyEntries=[address];
  const querySelectors=[];
  const document={visibilityState:'visible',activeElement:null,
    querySelector(selector){
      querySelectors.push(selector);
      assert.equal(selector,'[role="dialog"]','actual return focus must query the valid dialog selector');
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
  const ledgerExports={};
  const jsx=(type,props,key)=>type===ledgerExports.MetricLedger?type(props||{}):({type,props:props||{},key});
  const exports={};
  const context={exports, window, document,
    URL,URLSearchParams,AbortController,Blob,Date,Map,Set,Promise,console,
    requestAnimationFrame:fn=>{fn();return 1;},setTimeout,clearTimeout,
    setInterval:()=>1,clearInterval:()=>{},
    fetch:async(url,init)=>{fetches.push({url,signal:init?.signal});
      if(options.beforeFetch) await options.beforeFetch(fetches.length,url,init);
      return {ok:true,json:async()=>structuredClone(meta)};},
    require(specifier){
      if(specifier==='react')return react;
      if(specifier==='react/jsx-runtime')return {jsx,jsxs:jsx,Fragment:'Fragment'};
      if(specifier==='@/lib/replica-reader.mjs')return {readReplicaPart:async({part,signal})=>{
        reads.push(part);signal?.throwIfAborted();if(options.beforeRead)await options.beforeRead(part,signal,reads.length);signal?.throwIfAborted();return structuredClone(parts[part]);}};
      if(specifier==='@/lib/replica-coverage.mjs')return {accountCoverage:()=>({})};
            if(specifier.startsWith('@/lib/'))return requireSite(new URL(specifier.slice(2),SITE).pathname);
      if(specifier==='@/components/metric-ledger')return ledgerExports;
      if(specifier.startsWith('@/components/'))return new Proxy({}, {get:(_t,key)=>String(key)});
      return requireSite(specifier);
    },
  };
  vm.runInNewContext(ledgerCode,{...context,exports:ledgerExports},{filename:'actual-metric-ledger.cjs'});
  vm.runInNewContext(pageCode,context,{filename:'independent-actual-page-navigation.cjs'});
  function render(){cursor=0;dirty=false;tree=exports.default();}
  async function flush(){for(let i=0;i<100;i++) {
    if(dirty||!tree)render(); const effects=pendingEffects;pendingEffects=[];effects.forEach(f=>f());
    if(options.strict&&!strictReplayed){strictReplayed=true;
      hooks.filter(h=>h?.fn).forEach(h=>h.cleanup?.());
      hooks.filter(h=>h?.fn).forEach(h=>{h.cleanup=h.fn();});}
    await new Promise(r=>setTimeout(r,1));
    const growth=nodes(tree).find(n=>n.type==='GrowthPanel');
    const busy=hooks[2]?.value||(growth?.props.ready===false&&!growth.props.pendingError);
    if(!dirty&&!pendingEffects.length&&!busy)break;
  }if(dirty)render();return tree;}
  const all=()=>nodes(tree);
  const findButton=label=>{const node=all().find(n=>n.type==='Button'&&textOf(n)===label);
    assert.ok(node,`missing button ${label}`);return node;};
  render();await flush();
  return {reads,fetches,scrolls,window,historyEntries,flush,querySelectors,
    heading:()=>textOf(all().find(n=>n.type==='h1')),
    currentNav:()=>textOf(all().find(n=>n.type==='Button'&&n.props['aria-current']==='page')),
    button:findButton,
    all, text:()=>textOf(tree), dates:()=>all().filter(n=>n.type==='Input'&&n.props.type==='date').map(n=>n.props.value),
    metric:label=>{const n=all().find(n=>(n.type==='Card'||n.type==='article'&&n.props.className?.split(' ').includes('metric-cell'))&&textOf(n).startsWith(label));assert.ok(n,'missing metric '+label);return textOf(n);},
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

async function apply(h,key){await h.change(n=>n.type==='select'&&n.props.value&&n.props.children?.some?.(o=>o.props?.value==='month'),key);await h.click('应用周期');}

test('live U19: actual indexed Home keeps current-month observed growth at Beijing midnight',async()=>{
 const h=await pageHarness();try {
  assert.deepEqual(h.dates(),[BASE,'2026-09-29']);assert.ok(h.metric('粉丝净变化').includes('+578'));
  await apply(h,'month');assert.deepEqual(h.dates(),[BASE,'2026-09-29']);
  assert.ok(h.metric('粉丝净变化').includes('+578'),'month must not erase existing observed changes at midnight');
  assert.ok(h.text().includes('2026-09-30')&&h.text().includes('2026-09-29'),'requested cutoff and observed endpoint must both be explicit');
 }finally{h.close();}
});
test('live U19: actual legacy Home shares observed-month contract rather than original wall-day endpoint',async()=>{
 const h=await pageHarness(undefined,{fixture:await fixture({indexed:false})});try{
  await apply(h,'month');assert.deepEqual(h.dates(),[BASE,'2026-09-29']);
  assert.ok(h.metric('粉丝净变化').includes('+578'));
 }finally{h.close();}
});
test('live U16/U19: recent seven days uses selected last observed day and exact seven-day baseline',async()=>{
 const h=await pageHarness();try{await apply(h,'week');assert.deepEqual(h.dates(),['2026-09-22','2026-09-29']);
  assert.ok(h.metric('粉丝净变化').includes('+378'));assert.ok(h.metric('粉丝净变化').includes('2/3'));
 }finally{h.close();}
});
test('live U10/U13: applying week inside a slower classification uses its own observation anchor',async()=>{
 const h=await pageHarness();try{
  await h.change(n=>n.type==='select'&&n.props.children?.[0]?.props?.children==='全部分类','original');
  await apply(h,'week');assert.deepEqual(h.dates(),['2026-09-21','2026-09-28']);
  assert.ok(h.metric('粉丝净变化').includes('+175'));assert.ok(h.metric('粉丝净变化').includes('1/1'));
 }finally{h.close();}
});
test('live U19/U20: new month with no observations remains unknown, never borrows previous month or emits zero',async()=>{
 const h=await pageHarness(undefined,{fixture:await fixture({asOf:'2026-09-30T16:34:00.000Z'})});try{
  await apply(h,'month');assert.deepEqual(h.dates(),['2026-09-30','2026-10-01']);
  const card=h.metric('粉丝净变化');assert.ok(card.includes('0/3'));assert.ok(card.includes('—'));assert.ok(!card.includes('+578'));
  assert.ok(h.text().includes('本月尚无'),'no-month-observation needs a human-readable explanation');
 }finally{h.close();}
});
test('live U27/U45: explicit dates survive classification, board, personal route and refresh',async()=>{
 const h=await pageHarness();try{
  await h.change(n=>n.type==='Input'&&n.props.type==='date'&&n.props.max,'2026-09-20');
  const explicit=[...h.dates()];
  await h.change(n=>n.type==='select'&&n.props.children?.[0]?.props?.children==='全部主题','tuantuan');
  await h.change(n=>n.type==='select'&&n.props.children?.[0]?.props?.children==='全部分类','slice');
  await h.change(n=>n.type==='select'&&n.props.children?.[0]?.props?.children==='全部矩阵','tuantuan');
  assert.deepEqual(h.dates(),explicit);await h.click('刷新已发布数据');assert.deepEqual(h.dates(),explicit);
  const historyEntry=h.element(n=>n.type==='Button'&&n.props['aria-label']==='查看Synthetic 1的历史');assert.ok(historyEntry);historyEntry.props.onClick({currentTarget:{isConnected:true,focus(){}}});await h.flush();await h.click('打开独立账号页面');
  assert.equal(h.heading(),'账号经营详情');h.element(n=>n.type==='AccountPanel').props.onReturn();await h.flush();
  assert.deepEqual(h.dates(),explicit);
  assert.deepEqual(h.querySelectors,['[role="dialog"]','[role="dialog"]'],'personal return must use the real dialog-presence DOM contract');
 }finally{h.close();}
});
test('live U20/U43: failed date request keeps controls recoverable and suppresses mismatched statistics/export',async()=>{
 let breakDates=false;
 const h=await pageHarness(undefined,{beforeRead:async part=>{if(breakDates&&part==='date-summary-index.json')throw Error('synthetic-range-failure');}});
 try {
  breakDates=true;await h.change(n=>n.type==='Input'&&n.props.type==='date'&&n.props.max,'2026-09-20');
  const growth=h.element(n=>n.type==='GrowthPanel');assert.equal(growth.props.ready,false);assert.match(growth.props.pendingError,/synthetic-range-failure/);
  assert.ok(h.button('重试日期读取'));assert.ok(h.button('取消比较，返回首屏曲线'));
  assert.ok(h.all().some(n=>n.type==='div'&&n.props.hidden===true&&textOf(n).includes('导出全部结果')),'old interval account export must remain hidden');
  breakDates=false;await h.click('重试日期读取');
  assert.equal(h.element(n=>n.type==='GrowthPanel').props.ready,true);assert.deepEqual(h.dates(),['2026-09-20','2026-09-29']);
  assert.ok(h.metric('粉丝净变化').includes('+450'));
 }finally{h.close();}
});
test('live U30/U45: topics and pinned personal pages remain independent from matrix date index',async()=>{
 const topic=await pageHarness('https://synthetic.invalid/#topics');try{
  assert.deepEqual(topic.reads,['catalog.json','topics.json']);assert.equal(topic.heading(),'话题观察');
 }finally{topic.close();}
 const account=await pageHarness('https://synthetic.invalid/?account=2&generation='+encodeURIComponent(AS_OF));try{
  assert.deepEqual(account.reads,['catalog.json','topics.json']);assert.equal(account.heading(),'账号经营详情');
 }finally{account.close();}
});
test('live U18/U19: empty or entirely disabled catalog has no fabricated wall-clock observation anchor',async()=>{
 const f=await fixture();
 for(const accounts of [[],f.accounts.map(a=>({...a,enabled:false})),f.accounts.map(a=>({...a,latest:{}}))]){
  for(const key of ['day','week','month','since']){
   const actual=periodWindowFromCatalog(key,accounts,AS_OF);assert.equal(actual.start,null);assert.equal(actual.end,null);assert.equal(actual.anchor,null);
   assert.match(actual.note,/暂无真实/);
  }
 }
});
test('live U18: enabled latest future/date mismatch/noninteger pollution rejects instead of making a period',async()=>{
 const f=await fixture();
 for(const mutate of [m=>m.observedAt='2026-09-30T02:00:00.000Z',m=>m.date='2026-09-28',m=>m.value=-1,m=>m.value=1.5,m=>m.observedAt='not-a-time']){
  const accounts=structuredClone(f.accounts);mutate(accounts[0].latest.followers);
  assert.throws(()=>periodWindowFromCatalog('month',accounts,AS_OF),/采样时间与日期不一致/);
 }
 assert.throws(()=>periodWindowFromCatalog('week',[f.accounts[0],f.accounts[0]],AS_OF),/重复账号/);
});
test('live U18/U45: paused future history never advances enabled monthly anchor; real zero is still observed',async()=>{
 const f=await fixture();const paused={...structuredClone(f.accounts[2]),enabled:false};
 paused.latest.followers={value:999,date:'2026-10-04',observedAt:'2026-10-04T02:00:00.000Z'};
 const accounts=[{...f.accounts[0],latest:{followers:{value:0,date:'2026-09-29',observedAt:'2026-09-29T02:00:00.000Z'}}},paused];
 const actual=periodWindowFromCatalog('month',accounts,AS_OF);assert.equal(actual.end,'2026-09-29');assert.equal(actual.anchor,'2026-09-29');
});
test('live U19: previous month-end remains exact, missing baseline never becomes first available observation',async()=>{
 const f=await fixture({asOf:'2026-10-04T03:00:00.000Z'}),accounts=structuredClone(f.accounts);
 accounts[0].latest.followers={value:1400,date:'2026-10-04',observedAt:'2026-10-04T02:00:00.000Z'};
 const actual=periodWindowFromCatalog('month',accounts,f.meta.manifest.asOf);
 assert.equal(actual.start,'2026-09-30');assert.equal(actual.end,'2026-10-04');
 const missing=periodWindow('month',accounts,[...f.points,{targetId:1,date:'2026-10-04',capturedAt:'2026-10-04T02:00:00.000Z',followers:1400,followersAt:'2026-10-04T02:00:00.000Z',likes:null,likesAt:null,posts:null,postsAt:null}],f.meta.manifest.asOf);
 assert.equal(missing.start,'2026-09-30');assert.equal(missing.end,'2026-10-04');
});
test('live U20/U28: clearing the actual A date is validation, never endless fake network loading',async()=>{
 const h=await pageHarness();try{
  const before=h.reads.length;await h.change(n=>n.type==='Input'&&n.props.type==='date'&&n.props.max,'');
  assert.equal(h.reads.length,before);assert.deepEqual(h.dates(),['','2026-09-29']);
  const status=h.all().find(n=>n.type==='div'&&n.props.role==='status'&&['notice','error'].includes(n.props.className));
  assert.ok(status);assert.match(textOf(status),/完整|有序|无效.*日期|起点.*终点/);assert.ok(!textOf(status).includes('正在核对'));
  assert.ok(h.element(n=>n.type==='GrowthPanel'),'invalid date must retain editable chart comparison controls');
 }finally{h.close();}
});
test('live U20/U28: reversed actual B dates retain controls and show validation without date transport',async()=>{
 const h=await pageHarness();try{
  const before=h.reads.length;h.element(n=>n.type==='GrowthPanel').props.onComparison({compare:true,otherStart:'2026-09-25',otherEnd:'2026-09-20'});await h.flush();
  assert.equal(h.reads.length,before);const growth=h.element(n=>n.type==='GrowthPanel');assert.ok(growth);assert.equal(growth.props.comparison.compare,true);
  assert.equal(growth.props.comparison.otherStart,'2026-09-25');assert.equal(growth.props.ready,false);
  const status=h.all().find(n=>n.type==='div'&&n.props.role==='status'&&['notice','error'].includes(n.props.className));
  assert.ok(status);assert.match(textOf(status),/完整|有序|无效.*日期|起点.*终点/);assert.ok(!textOf(status).includes('正在核对'));
 }finally{h.close();}
});
test('live U20/U43: late same-generation refresh cannot strand a newer accepted date request',async()=>{
 const gate=deferred();const h=await pageHarness(undefined,{beforeFetch:async count=>{if(count===2)await gate.promise;}});
 try{
  h.button('刷新已发布数据').props.onClick();await h.flush();
  await h.change(n=>n.type==='Input'&&n.props.type==='date'&&n.props.max,'2026-09-20');
  assert.equal(h.element(n=>n.type==='GrowthPanel').props.ready,true);
  gate.resolve();await h.flush();
  assert.deepEqual(h.dates(),['2026-09-20','2026-09-29']);
  assert.equal(h.element(n=>n.type==='GrowthPanel').props.ready,true,'late refresh must reload or preserve the newer accepted date receipt');
  assert.ok(h.metric('粉丝净变化').includes('+450'));
 }finally{gate.resolve();h.close();}
});

const siteRequire=requireSite,elements=nodes;
async function componentHarness(file,exportName,initialProps,{readPart}={}){
 const ts=siteRequire('typescript'),source=await readFile(new URL(file,SITE),'utf8');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 let props=initialProps,cursor=0,tree,dirty=true,effects=[];const hooks=[],blobs=[],downloads=[];
 const react={useState(initial){const i=cursor++;hooks[i]??={value:typeof initial==='function'?initial():initial};return [hooks[i].value,next=>{hooks[i].value=typeof next==='function'?next(hooks[i].value):next;dirty=true;}];},
  useMemo(fn){cursor++;return fn();},useCallback(fn){cursor++;return fn;},useRef(initial){const i=cursor++;hooks[i]??={current:initial};return hooks[i];},
  useEffect(fn,deps){const i=cursor++,old=hooks[i];if(!old||deps.some((v,j)=>!Object.is(v,old.deps[j]))){hooks[i]={deps,cleanup:old?.cleanup};effects.push(()=>{old?.cleanup?.();hooks[i].cleanup=fn();});}}};
 const jsx=(type,props,key)=>({type,props:props||{},key}),exports={};
 class TestURL extends URL{static createObjectURL(blob){blobs.push(blob);return 'blob:synthetic-'+blobs.length;}static revokeObjectURL(){}}
 const context={exports,Blob,URL:TestURL,Date,Map,Set,Promise,AbortController,
  document:{createElement:()=>{const a={click(){downloads.push({name:a.download,href:a.href});}};return a;}},
  setTimeout:fn=>{fn();return 1;},clearTimeout:()=>{},
  require(spec){if(spec==='react')return react;if(spec==='react/jsx-runtime')return {jsx,jsxs:jsx,Fragment:'Fragment'};
   if(spec==='@/lib/replica-reader.mjs'&&readPart)return {readReplicaPart:readPart};
   if(spec.startsWith('@/lib/'))return siteRequire(new URL(spec.slice(2),SITE).pathname);
   if(spec.startsWith('@/components/')||spec==='recharts')return new Proxy({}, {get:(_t,key)=>String(key)});
   return siteRequire(spec);}};
 vm.runInNewContext(code,context,{filename:'independent-real-'+file});
 async function flush(){for(let i=0;i<12;i++){if(dirty){cursor=0;dirty=false;tree=exports[exportName](props);}const queued=effects;effects=[];queued.forEach(f=>f());await new Promise(r=>setImmediate(r));if(!dirty&&!effects.length)break;}return tree;}
 await flush();return {blobs,downloads,flush,all:()=>elements(tree),
  find:predicate=>elements(tree).find(predicate),async setProps(next){props={...props,...next};dirty=true;await flush();},
  async click(label){const node=elements(tree).find(n=>n.type==='Button'&&textOf(n)===label);assert.ok(node,`button missing: ${label}`);node.props.onClick();await flush();},
  close(){hooks.forEach(h=>h?.cleanup?.());}};
}
test('live U10/U14/U24: actual classification panel ranks partial endpoints, preserves null and drills down by exact dimension',async()=>{
 const f=await fixture(),{rowsFor}=await import(new URL('lib/replica-model.mjs',SITE));
 const accounts=structuredClone(f.accounts);accounts[0].classification.labels.push({key:'ai',label:'AI二创'},{key:'ai',label:'AI二创'});
 const rows=rowsFor(accounts,f.points,BASE,'2026-09-29'),selection=[];
 const h=await componentHarness('components/group-summary.tsx','GroupSummary',{rows,start:BASE,end:'2026-09-29',onSelect:(dimension,key)=>selection.push([dimension,key])});
 try{
  const body=()=>h.find(n=>n.type==='TableBody');
  const keys=()=>elements(body()).filter(n=>n.type==='TableRow').map(n=>n.key);
  assert.deepEqual(keys(),['tuantuan','other']);assert.ok(textOf(body()).includes('+578'));assert.ok(textOf(body()).includes('0/1 可比'));
  await h.click('粉丝净变 ↓');assert.deepEqual(keys(),['tuantuan','other'],'missing group must remain last in ascending direction');
  await h.click('团团');assert.deepEqual(selection,[['theme','tuantuan']]);
  await h.click('内容分类');assert.ok(textOf(h.find(n=>n.type==='p'&&n.props.className==='group-note')).includes('不能把各分类相加当全局'));
  assert.deepEqual(new Set(keys()),new Set(['slice','ai','original']));
  const ai=elements(body()).find(n=>n.type==='TableRow'&&n.key==='ai');assert.ok(textOf(ai).includes('AI二创1'));assert.ok(textOf(ai).includes('+289'));
  await h.click('AI二创');assert.deepEqual(selection.at(-1),['content','ai']);
 }finally{h.close();}
});
test('live U10/U45: actual overview group click retains dates and exposes only selected theme members',async()=>{
 const h=await pageHarness();try{
  const before=[...h.dates()],group=h.element(n=>n.type==='GroupSummary');assert.ok(group);
  group.props.onSelect('theme','tuantuan');await h.flush();
  assert.equal(h.heading(),'账号明细');assert.equal(h.window.location.hash,'#accounts');assert.deepEqual(h.dates(),before);
  assert.equal(h.element(n=>n.type==='select'&&n.props.children?.[0]?.props?.children==='全部主题').props.value,'tuantuan');
  const names=h.all().filter(n=>n.type==='Button'&&n.props.className==='author').map(textOf);assert.deepEqual(names,['Synthetic 1','Synthetic 2']);
  assert.ok(h.metric('粉丝净变化').includes('+578'));assert.ok(h.metric('粉丝净变化').includes('2/2'));
 }finally{h.close();}
});
test('live U10/U14: group contract deduplicates repeated labels, excludes paused accounts, keeps zero/decrease/missing',async()=>{
 const {groupEndpointRows,orderEndpointGroups}=await import(new URL('lib/replica-groups.mjs',SITE));
 const metric=delta=>({value:delta===null?null:100,delta,baseline:delta===null?null:100-delta,currentAt:null,baselineAt:null});
 const row=(id,key,delta,enabled=true)=>({id,enabled,classification:{theme:{key,label:key},labels:[{key,label:key},{key,label:key}]},metrics:Object.fromEntries(['followers','likes','posts'].map(k=>[k,metric(delta)]))});
 const groups=groupEndpointRows([row(1,'negative',-4),row(2,'zero',0),row(3,'missing',null),row(4,'paused',999,false)],'content');
 assert.equal(groups.length,3);assert.ok(groups.every(g=>g.count===1));
 assert.deepEqual(orderEndpointGroups(groups,'followers.delta','desc').map(g=>g.key),['zero','negative','missing']);
 assert.deepEqual(orderEndpointGroups(groups,'followers.delta','asc').map(g=>g.key),['negative','zero','missing']);
 assert.throws(()=>groupEndpointRows([row(1,'a',1),row(1,'a',2)]),/重复/);
});
test('live U23/U24: actual classification pages reach all groups and reset after sorting or roster changes',async()=>{
 const metric=delta=>({value:100+delta,delta,baseline:100,currentAt:null,baselineAt:null});
 const rows=Array.from({length:18},(_,i)=>({id:i+1,enabled:true,classification:{theme:{key:'g'+i,label:'Group '+i},labels:[]},metrics:Object.fromEntries(['followers','likes','posts'].map(k=>[k,metric(i)]))}));
 const h=await componentHarness('components/group-summary.tsx','GroupSummary',{rows,start:BASE,end:'2026-09-29',onSelect(){}});
 const keys=()=>elements(h.find(n=>n.type==='TableBody')).filter(n=>n.type==='TableRow').map(n=>n.key);
 try{
  assert.deepEqual(keys(),['g17','g16','g15','g14','g13','g12','g11','g10']);
  await h.click('下一页分类');assert.deepEqual(keys(),['g9','g8','g7','g6','g5','g4','g3','g2']);
  await h.click('下一页分类');assert.deepEqual(keys(),['g1','g0']);assert.equal(h.find(n=>n.type==='Button'&&textOf(n)==='下一页分类').props.disabled,true);
  await h.click('上一页分类');assert.deepEqual(keys(),['g9','g8','g7','g6','g5','g4','g3','g2']);
  await h.click('粉丝净变 ↓');assert.deepEqual(keys(),['g0','g1','g2','g3','g4','g5','g6','g7']);
  await h.click('下一页分类');await h.setProps({rows:rows.slice(0,3)});assert.deepEqual(keys(),['g0','g1','g2']);
  assert.ok(textOf(h.find(n=>n.type==='div'&&n.props['aria-label']==='分类翻页')).includes('第 1/1 页'));
 }finally{h.close();}
});
