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
const { loadReplicaView } = await import(new URL('lib/replica-view.mjs', SITE));
const {periodWindowFromCatalog,periodWindow}=await import(new URL('lib/replica-periods.mjs',SITE));
const AS_OF='2026-09-29T16:34:00.000Z',BASE='2026-09-12';
const hash=s=>createHash('sha256').update(s).digest('hex');
const shift=(date,n)=>new Date(Date.parse(date+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
async function fixture({asOf=AS_OF,indexed=true,days=null}={}) {
 const common={version:1,asOf,timeZone:'Asia/Shanghai'},parts={},sources=new Map(),files=[],points=[];
 const accounts=Array.from({length:3},(_,i)=>({id:i+1,label:'Synthetic '+(i+1),platform:'douyin',enabled:true,
  boardKeys:[i<2?'tuantuan':'other'],classification:{theme:{key:i<2?'tuantuan':'other',label:i<2?'团团':'其他'},
  labels:[{key:i<2?'slice':'original',label:i<2?'切片':'原创'}]}}));
 for(const a of accounts) {
  const items=Array.from({length:days===null?(a.id<3?18:17):(a.id<3?days:days-1)},(_,n)=>{const date=shift(BASE,n),capturedAt=date+'T02:00:00.000Z';
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
  const hooks=[], listeners=new Map(), reads=[], fetches=[], scrolls=[], historyEntries=[address], blobs=[], downloads=[];
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
  const jsx=(type,props,key)=>({type,props:props||{},key});
  const exports={};
  class TestURL extends URL {static createObjectURL(blob){blobs.push(blob);return 'blob:synthetic/'+blobs.length;}static revokeObjectURL(){}}
  const context={exports, window, document:{visibilityState:'visible',activeElement:null,createElement(){return {click(){downloads.push(this.download);}};}},
    URL:TestURL,URLSearchParams,AbortController,Blob,Date,Map,Set,Promise,console,
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
      if(specifier.startsWith('@/components/'))return new Proxy({}, {get:(_t,key)=>String(key)});
      return requireSite(specifier);
    },
  };
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
  return {reads,fetches,scrolls,window,historyEntries,flush,blobs,downloads,
    heading:()=>textOf(all().find(n=>n.type==='h1')),
    currentNav:()=>textOf(all().find(n=>n.type==='Button'&&n.props['aria-current']==='page')),
    button:findButton,
    all, text:()=>textOf(tree), dates:()=>all().filter(n=>n.type==='Input'&&n.props.type==='date').map(n=>n.props.value),
    metric:label=>{const n=all().find(n=>n.type==='Card'&&textOf(n).startsWith(label));assert.ok(n,'missing metric '+label);return textOf(n);},
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

const selectValue=(h,first)=>h.element(n=>n.type==='select'&&n.props.children?.[0]?.props?.children===first)?.props.value;
const periodValue=h=>h.element(n=>n.type==='select'&&n.props.children?.some?.(x=>x.props?.value==='month'))?.props.value;
for(const [period,expected] of [['month',[BASE,'2026-09-29']],['week',['2026-09-22','2026-09-29']]])test('phase53 actual initial URL honors '+period,async()=>{const h=await pageHarness('https://synthetic.invalid/?period='+period+'#overview');try{assert.equal(periodValue(h),period);assert.deepEqual(h.dates(),expected);}finally{h.close();}});
test('phase53 actual explicit URL restores classification/theme and exact dates',async()=>{const h=await pageHarness('https://synthetic.invalid/?theme=tuantuan&classification=slice&start=2026-09-20&end=2026-09-29#accounts');try{assert.equal(h.heading(),'账号明细');assert.equal(selectValue(h,'全部主题'),'tuantuan');assert.equal(selectValue(h,'全部分类'),'slice');assert.deepEqual(h.dates(),['2026-09-20','2026-09-29']);assert.ok(h.text().includes('Synthetic 1'));assert.ok(!h.text().includes('Synthetic 3'));}finally{h.close();}});
test('phase53 actual reload keeps global explicit URL rather than since default',async()=>{const url='https://synthetic.invalid/?board=tuantuan&theme=tuantuan&classification=slice&start=2026-09-20&end=2026-09-29#overview',a=await pageHarness(url);try{await a.click('刷新已发布数据');assert.deepEqual(a.dates(),['2026-09-20','2026-09-29']);const b=await pageHarness(a.window.location.href);try{assert.deepEqual(b.dates(),a.dates());assert.equal(selectValue(b,'全部矩阵'),'tuantuan');assert.equal(selectValue(b,'全部主题'),'tuantuan');assert.equal(selectValue(b,'全部分类'),'slice');}finally{b.close();}}finally{a.close();}});
for(const query of ['start=2026-09-20','start=2026-09-31&end=2026-10-01','start=2026-09-29&end=2026-09-20'])test('phase53 malformed explicit URL fails closed '+query,async()=>{const h=await pageHarness('https://synthetic.invalid/?'+query+'#overview');try{assert.ok(h.element(n=>n.props.role==='alert'),'must expose invalid URL rather than silently display another range');assert.ok(!h.element(n=>n.type==='Card'),'no unrelated since metrics');assert.ok(!h.element(n=>n.type==='MetricLedger'),'no unrelated metric ledger after component extraction');assert.ok(!h.element(n=>n.type==='Button'&&textOf(n)==='导出全部结果'),'no misleading export');}finally{h.close();}});
test('phase53 actual global CSV has stable identity/version/platform and endpoint times',async()=>{const f=await fixture();f.accounts[1].label=f.accounts[0].label;f.parts['catalog.json'].accounts=f.accounts;const h=await pageHarness('https://synthetic.invalid/#accounts',{fixture:f});try{await h.click('导出全部结果');assert.equal(h.blobs.length,1);const body=await h.blobs[0].text(),header=body.split(/\r?\n/)[0];for(const field of ['asOf','targetId','platform','followersBaselineAt','followersCurrentAt'])assert.ok(header.includes(field),'CSV missing '+field);assert.ok(body.includes(AS_OF));assert.ok(body.includes('douyin'));assert.ok(body.includes('2026-09-12T02:00:00.000Z'));assert.ok(body.includes('2026-09-29T02:00:00.000Z'));}finally{h.close();}});
test('phase53 user-selected scope and dates become a reloadable address, unapplied period remains draft',async()=>{const h=await pageHarness();try{await h.change(n=>n.type==='select'&&n.props.children?.[0]?.props?.children==='全部主题','tuantuan');await h.change(n=>n.type==='select'&&n.props.children?.[0]?.props?.children==='全部分类','slice');await h.change(n=>n.type==='Input'&&n.props.type==='date'&&n.props.max,'2026-09-20');const address=h.window.location.href,p=new URL(address).searchParams;assert.equal(p.get('theme'),'tuantuan');assert.equal(p.get('classification'),'slice');assert.equal(p.get('start'),'2026-09-20');assert.equal(p.get('end'),'2026-09-29');await h.change(n=>n.type==='select'&&n.props.children?.some?.(x=>x.props?.value==='month'),'week');assert.equal(h.window.location.href,address,'changing only the period draft must not replace applied scope');const b=await pageHarness(address);try{assert.deepEqual(b.dates(),['2026-09-20','2026-09-29']);assert.equal(selectValue(b,'全部分类'),'slice');}finally{b.close();}}finally{h.close();}});
test('phase53 two explicit saved scopes survive actual popstate back and forward',async()=>{const a='https://synthetic.invalid/?theme=tuantuan&classification=slice&start=2026-09-20&end=2026-09-29#accounts',h=await pageHarness(a);try{h.window.history.pushState(null,'','?theme=other&classification=original&start=2026-09-21&end=2026-09-28#overview');await h.dispatch('popstate');assert.equal(selectValue(h,'全部主题'),'other');assert.deepEqual(h.dates(),['2026-09-21','2026-09-28']);await h.back();assert.equal(h.heading(),'账号明细');assert.equal(selectValue(h,'全部主题'),'tuantuan');assert.deepEqual(h.dates(),['2026-09-20','2026-09-29']);await h.forward();assert.equal(h.heading(),'矩阵经营总览');assert.equal(selectValue(h,'全部分类'),'original');assert.deepEqual(h.dates(),['2026-09-21','2026-09-28']);}finally{h.close();}});
test('phase53 unknown matrix URL never silently defaults to all accounts',async()=>{const h=await pageHarness('https://synthetic.invalid/?theme=unregistered&classification=slice&period=week#accounts');try{assert.ok(h.element(n=>n.props.role==='alert'));assert.ok(!h.element(n=>n.type==='Card'));assert.ok(!h.element(n=>n.type==='MetricLedger'),'unknown scope cannot expose extracted metric ledger');}finally{h.close();}});
test('phase53 real CSV contract separates same-label identities and binds exact public daily source partitions',async()=>{const {accountExport}=await import(new URL('lib/replica-export.mjs',SITE)),{rowsFor}=await import(new URL('lib/replica-model.mjs',SITE)),f=await fixture();f.accounts[1].label=f.accounts[0].label;f.accounts[1].platform='bilibili';const table=accountExport(rowsFor(f.accounts,f.points,BASE,'2026-09-29'),f.meta.manifest,BASE,'2026-09-29'),[header,a,b]=table;const at=k=>header.indexOf(k);assert.equal(a[at('targetId')],1);assert.equal(b[at('targetId')],2);assert.equal(a[at('作者')],b[at('作者')]);assert.equal(a[at('platform')],'douyin');assert.equal(b[at('platform')],'bilibili');for(const row of [a,b]){const id=row[at('targetId')],part=f.meta.manifest.files.find(x=>x.path==='daily/'+id+'.json');assert.equal(row[at('asOf')],AS_OF);assert.equal(row[at('dailyPart')],part.path);assert.equal(row[at('dailyPartSha256')],part.sha256);assert.match(row[at('来源说明')],/分区指纹/);assert.equal(row[at('followersBaselineAt')],BASE+'T02:00:00.000Z');assert.equal(row[at('followersCurrentAt')],'2026-09-29T02:00:00.000Z');}});
test('phase53 CSV never borrows a foreign target partition or fills a missing endpoint time',async()=>{const {accountExport}=await import(new URL('lib/replica-export.mjs',SITE)),{rowsFor}=await import(new URL('lib/replica-model.mjs',SITE)),f=await fixture();f.meta.manifest.files.find(x=>x.path==='daily/1.json').targetId=999;const table=accountExport(rowsFor(f.accounts,f.points,BASE,'2026-09-29'),f.meta.manifest,BASE,'2026-09-29'),[header,a,,missing]=table,at=k=>header.indexOf(k);assert.equal(a[at('dailyPart')],null);assert.equal(a[at('dailyPartSha256')],null);assert.equal(missing[at('粉丝')],null);assert.equal(missing[at('粉丝净变')],null);assert.equal(missing[at('followersCurrentAt')],null);assert.equal(missing[at('followersBaselineAt')],BASE+'T02:00:00.000Z');});
test('phase53 CSV preserves true negative and zero values and rejects reversed requested range',async()=>{const {accountExport}=await import(new URL('lib/replica-export.mjs',SITE)),{rowsFor,csv}=await import(new URL('lib/replica-model.mjs',SITE)),f=await fixture();const p=f.points.find(x=>x.targetId===1&&x.date==='2026-09-29');p.followers=0;p.likes=501;const table=accountExport(rowsFor(f.accounts,f.points,BASE,'2026-09-29'),f.meta.manifest,BASE,'2026-09-29'),[header,a]=table,at=k=>header.indexOf(k);assert.equal(a[at('粉丝')],0);assert.equal(a[at('粉丝净变')],-1001);assert.equal(a[at('点赞净变')],0);assert.ok(csv(table).includes('"-1001"'),'numeric decrease is numeric, not formula-escaped unknown');assert.throws(()=>accountExport([],f.meta.manifest,'2026-09-29',BASE),/日期/);});
for(const period of ['month','week'])test('phase53 initial '+period+' reads selected shards once, never initial full-since history',async()=>{const end=shift(BASE,700),f=await fixture({days:701,asOf:end+'T16:34:00.000Z'});assert.equal(f.parts['date-summary-index.json'].shards.length,2);const h=await pageHarness('https://synthetic.invalid/?period='+period+'#overview',{fixture:f});try{assert.equal(periodValue(h),period);assert.equal(h.dates()[1],end);assert.equal(h.reads.includes('date-summary/000001.json'),false,'first older-history shard proves an initial since fallback');assert.equal(h.reads.filter(x=>x==='date-summary/000002.json').length,1);assert.equal(h.reads.filter(x=>x==='date-summary-index.json').length,1,'date receipt must avoid a second redundant accepted window');}finally{h.close();}});
