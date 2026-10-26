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

const siteRequire=requireSite,elements=nodes;
async function componentHarness(file,exportName,initialProps,{readPart}={}){
 const ts=siteRequire('typescript'),source=await readFile(new URL(file,SITE),'utf8');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 let props=initialProps,cursor=0,tree,dirty=true,effects=[];const hooks=[],blobs=[],downloads=[];
 const react={useId:()=>"phase114-test-reading",useState(initial){const i=cursor++;hooks[i]??={value:typeof initial==='function'?initial():initial};return [hooks[i].value,next=>{hooks[i].value=typeof next==='function'?next(hooks[i].value):next;dirty=true;}];},
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
const exportsModule=await import(new URL('lib/replica-export.mjs',SITE));
function parseCsv(input){const result=[];let row=[],cell='',quoted=false;const text=input.replace(/^\ufeff/,'');for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(!quoted&&c===','){row.push(cell);cell='';}else if(!quoted&&(c==='\r'||c==='\n')){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);cell='';result.push(row);row=[];}else cell+=c;}if(cell||row.length){row.push(cell);result.push(row);}return result;}
const cell=(table,row,key)=>{const n=table[0].indexOf(key);assert.notEqual(n,-1,'missing CSV field '+key);return row[n];};
const objectRows=table=>table.slice(1).map(row=>Object.fromEntries(table[0].map((k,i)=>[k,row[i]])));
async function exportFixture(){
 const f=await fixture({indexed:false});
 for(const account of f.accounts){account.metadata={privateURL:'https://private.invalid/sheet',cookie:'synthetic-private-cookie'};account.locator='synthetic-private-locator';const path='daily/'+account.id+'.json',items=f.parts[path].items;
  for(let n=0;n<items.length;n++){const x=items[n],previous=items[n-1];x.sourceChecksum=hash('observation/'+account.id+'/'+n);for(const k of ['followers','likes','posts']){x[k+'Checksum']=x.sourceChecksum;x[k+'Delta']=previous?x[k]-previous[k]:null;x[k+'BaselineAt']=previous?.[k+'At']??null;x[k+'BaselineChecksum']=previous?.[k+'Checksum']??null;}}
  const content=JSON.stringify(f.parts[path])+'\n',meta=f.meta.manifest.files.find(x=>x.path===path);meta.bytes=Buffer.byteLength(content);meta.sha256=hash(content);
 }
 const common={version:1,asOf:AS_OF,timeZone:'Asia/Shanghai'};
 for(const [path,kind,items] of [
  ['works/1.json','works',[{targetId:1,id:17,externalId:'7123456789012345678',caption:'Synthetic public work',url:'https://www.douyin.com/video/7123456789012345678',publishedAt:BASE+'T02:00:00.000Z',firstSeenAt:BASE+'T02:10:00.000Z',lastObservedAt:'2026-09-29T02:00:00.000Z',likes:7,comments:1,shares:0,collects:0,plays:null,playsEvidence:{note:'未知，不能证明平台实际播放'}}]],
  ['work-metrics/1.json','workMetrics',[{targetId:1,id:19,workId:17,externalId:'7123456789012345678',capturedAt:'2026-09-29T02:00:00.000Z',likes:7,comments:1,shares:0,collects:0,plays:null,playsEvidence:{note:'未知，不能证明平台实际播放'}}]]
 ]){f.parts[path]={...common,items};const content=JSON.stringify(f.parts[path])+'\n';f.meta.manifest.files.push({path,kind,targetId:1,count:items.length,bytes:Buffer.byteLength(content),sha256:hash(content)});}
 return f;
}

for(const kind of ['daily','works','workMetrics'])test('phase54 history helper '+kind+' supplies immutable identity, exact partition and only explicit public row fields',async()=>{
 assert.equal(typeof exportsModule.historyExport,'function','actual historyExport is not wired yet');const f=await exportFixture(),path=kind==='workMetrics'?'work-metrics/1.json':kind+'/1.json',rows=f.parts[path].items,table=exportsModule.historyExport({rows,kind,account:f.accounts[0],manifest:f.meta.manifest,start:kind==='daily'?BASE:null,end:kind==='daily'?'2026-09-29':null}),r=table[1],meta=f.meta.manifest.files.find(x=>x.path===path);
 for(const [key,value] of [['asOf',AS_OF],['timeZone','Asia/Shanghai'],['targetId',1],['platform','douyin'],['label','Synthetic 1'],['sourcePart',path],['sourcePartSha256',meta.sha256],['requestedStart',kind==='daily'?BASE:null],['requestedEnd',kind==='daily'?'2026-09-29':null]])assert.equal(cell(table,r,key),value);
 assert.ok(!JSON.stringify(table).includes('synthetic-private'));assert.ok(!JSON.stringify(table).includes('private.invalid'));
 if(kind==='daily'){assert.equal(cell(table,r,'capturedAt'),rows[0].capturedAt);assert.equal(cell(table,r,'followersChecksum'),rows[0].followersChecksum);assert.equal(cell(table,r,'sourceChecksum'),rows[0].sourceChecksum);assert.equal(cell(table,r,'followersBaselineAt'),null);}
 else{assert.equal(table[0].includes('sourceChecksum'),false,'works sourceChecksum cannot be fabricated from public partition hash');assert.match(cell(table,r,'playsNote'),/未知/);}
});

test('phase54 actual personal daily download identifies account/platform/version and true raw sampling source',async()=>{const f=await exportFixture(),account=f.accounts[0],h=await componentHarness('components/account-panel.tsx','AccountPanel',{account,manifest:f.meta.manifest,boards:[],request:{id:1,start:BASE,end:'2026-09-29',generation:AS_OF},onReturn(){},onAddress(){},onHistory(){}},{readPart:async({part})=>structuredClone(f.parts[part])});try{await h.click('导出所选区间与来源');const table=parseCsv(await h.blobs[0].text()),r=table[1];assert.equal(cell(table,r,'label'),account.label);assert.equal(cell(table,r,'platform'),account.platform);assert.equal(cell(table,r,'asOf'),AS_OF);assert.ok(cell(table,r,'capturedAt'));assert.match(cell(table,r,'sourceChecksum'),/^[a-f0-9]{64}$/);assert.match(cell(table,r,'sourcePartSha256'),/^[a-f0-9]{64}$/);}finally{h.close();}});

test('phase54 actual full-history dialog and work metrics downloads retain selected account identity',async()=>{const f=await exportFixture(),h=await pageHarness('https://synthetic.invalid/#accounts',{fixture:f});try{const historyEntry=h.element(n=>n.type==='Button'&&n.props['aria-label']==='查看Synthetic 1的历史');assert.ok(historyEntry);historyEntry.props.onClick({currentTarget:{isConnected:true,focus(){}}});await h.flush();await h.click('导出全部历史');let table=parseCsv(await h.blobs.at(-1).text());assert.equal(cell(table,table[1],'label'),'Synthetic 1');assert.equal(cell(table,table[1],'platform'),'douyin');await h.click('全部保存作品');await h.click('导出全部历史');table=parseCsv(await h.blobs.at(-1).text());assert.equal(cell(table,table[1],'sourcePart'),'works/1.json');assert.equal(cell(table,table[1],'targetId'),'1');await h.click('查看指标历史');await h.click('导出全部历史');table=parseCsv(await h.blobs.at(-1).text());assert.equal(cell(table,table[1],'sourcePart'),'work-metrics/1.json');assert.equal(cell(table,table[1],'label'),'Synthetic 1');assert.equal(cell(table,table[1],'capturedAt'),'2026-09-29T02:00:00.000Z');assert.equal(table[0].includes('sourceChecksum'),false);}finally{h.close();}});

test('phase54 actual curve export has fixed version, real metric-specific cohort and A/B windows',async()=>{const f=await exportFixture(),points=f.points.filter(x=>x.date===BASE||x.date==='2026-09-20'||x.date==='2026-09-21'||x.date==='2026-09-29'),h=await componentHarness('components/growth-panel.tsx','GrowthPanel',{accounts:f.accounts,points,manifest:f.meta.manifest,start:BASE,end:'2026-09-29',comparison:{compare:true,otherStart:'2026-09-20',otherEnd:'2026-09-21'},offset:0,onComparison(){},onOffset(){}});try{await h.click('导出本屏曲线记录');const table=parseCsv(await h.blobs[0].text()),rs=objectRows(table),metadata=rs.find(x=>x.recordType==='metadata');assert.ok(metadata,'curve needs metadata, not just cohort count');assert.equal(metadata.asOf,AS_OF);assert.equal(metadata.start,BASE);assert.equal(metadata.end,'2026-09-29');assert.equal(metadata.otherStart,'2026-09-20');assert.equal(metadata.otherEnd,'2026-09-21');assert.deepEqual(JSON.parse(metadata.cohortTargetIds),[1,2]);assert.deepEqual(JSON.parse(metadata.selectedTargetIds),[1,2,3]);const cohort=rs.filter(x=>x.recordType==='cohort');assert.deepEqual(cohort.map(x=>Number(x.targetId)).sort(),[1,2]);assert.ok(cohort.every(x=>x.platform==='douyin'&&x.label&&/^[a-f0-9]{64}$/.test(x.dailyPartSha256)));assert.ok(!JSON.stringify(table).includes('synthetic-private'));assert.equal(table[0].includes('sourceChecksum'),false);}finally{h.close();}});

test('phase54 history contract rejects wrong target, duplicate ID, wrong/missing/duplicated partition and bad SHA',async()=>{assert.equal(typeof exportsModule.historyExport,'function');const f=await exportFixture(),request={rows:f.parts['daily/1.json'].items,kind:'daily',account:f.accounts[0],manifest:f.meta.manifest,start:null,end:null};for(const mutate of [x=>x.rows[0].targetId=2,x=>x.rows[1].id=x.rows[0].id,x=>x.manifest.files=x.manifest.files.filter(p=>p.path!=='daily/1.json'),x=>x.manifest.files.push(structuredClone(x.manifest.files.find(p=>p.path==='daily/1.json'))),x=>x.manifest.files.find(p=>p.path==='daily/1.json').kind='works',x=>x.manifest.files.find(p=>p.path==='daily/1.json').targetId=2,x=>x.manifest.files.find(p=>p.path==='daily/1.json').sha256='bad',x=>x.manifest.files.find(p=>p.path==='daily/1.json').count=-1]){const x=structuredClone(request);mutate(x);assert.throws(()=>exportsModule.historyExport(x));}});
test('phase54 history rejects future/ambiguous baseline times and corrupt original observation hashes',async()=>{assert.equal(typeof exportsModule.historyExport,'function');const f=await exportFixture(),request={rows:f.parts['daily/1.json'].items,kind:'daily',account:f.accounts[0],manifest:f.meta.manifest};for(const [field,value] of [['capturedAt','2099-01-01T02:00:00.000Z'],['followersAt','2026-09-13T02:00:00.000Z'],['followersBaselineAt','2026-09-11'],['sourceChecksum','pretend-source-hash'],['likesChecksum','secret=synthetic-leak']]){const x=structuredClone(request);x.rows[0][field]=value;assert.throws(()=>exportsModule.historyExport(x),undefined,'must reject '+field+' without exporting false provenance');}});
test('phase54 history refuses invalid publication and mismatched selected daily dates',async()=>{assert.equal(typeof exportsModule.historyExport,'function');const f=await exportFixture(),request={rows:f.parts['daily/1.json'].items,kind:'daily',account:f.accounts[0],manifest:f.meta.manifest,start:BASE,end:'2026-09-29'};for(const mutate of [x=>x.manifest=null,x=>x.manifest.asOf='2026-09-29',x=>x.manifest.timeZone='UTC',x=>x.start='2026-09-20',x=>x.end=null,x=>x.start='2026-09-31']){const x=structuredClone(request);mutate(x);assert.throws(()=>exportsModule.historyExport(x));}});
test('phase54 metric-specific A/B cohort, exact raw endpoints, source hashes and null interior trace survive compact export',async()=>{assert.equal(typeof exportsModule.trendExport,'function');const f=await exportFixture(),points=structuredClone(f.points),likesMissing=points.find(p=>p.targetId===2&&p.date==='2026-09-20');likesMissing.likes=null;likesMissing.likesAt=null;const interior=points.find(p=>p.targetId===1&&p.date==='2026-09-13');interior.followers=null;interior.followersAt=null;const options={start:BASE,end:'2026-09-29',otherStart:'2026-09-20',otherEnd:'2026-09-21',metric:'followers',visibleOffset:0,visibleDays:90};let rs=objectRows(exportsModule.trendExport({accounts:[...f.accounts].reverse(),points,manifest:f.meta.manifest,options})),m=rs.find(x=>x.recordType==='metadata'),members=rs.filter(x=>x.recordType==='cohort');assert.deepEqual(JSON.parse(m.cohortTargetIds),[1,2]);assert.deepEqual(JSON.parse(m.selectedTargetIds),[1,2,3]);assert.equal(m.metricPolicy,'fixed-endpoint-cohort-net-change-null-not-zero');const a=members.find(x=>x.targetId===1);assert.equal(a.currentBaseline,1001);assert.equal(a.currentEnd,1290);assert.equal(a.currentBaselineAt,BASE+'T02:00:00.000Z');assert.equal(a.currentEndAt,'2026-09-29T02:00:00.000Z');assert.equal(a.comparisonBaselineAt,'2026-09-20T02:00:00.000Z');assert.equal(a.comparisonEndAt,'2026-09-21T02:00:00.000Z');assert.equal(a.dailyPartSha256,f.meta.manifest.files.find(p=>p.path==='daily/1.json').sha256);const gap=rs.find(x=>x.recordType==='point'&&x.currentDate==='2026-09-13');assert.equal(gap.currentNetChange,null);assert.equal(gap.currentKnown,1);rs=objectRows(exportsModule.trendExport({accounts:f.accounts,points,manifest:f.meta.manifest,options:{...options,metric:'estimated'}}));m=rs.find(x=>x.recordType==='metadata');assert.deepEqual(JSON.parse(m.cohortTargetIds),[1]);assert.equal(m.metricPolicy,'net-like-change-times-100-not-actual-views');const end=rs.find(x=>x.recordType==='point'&&x.currentDate==='2026-09-29');assert.equal(end.currentNetChange,11900);assert.equal(rs.filter(x=>x.recordType==='cohort').length,1);assert.ok(!JSON.stringify(rs).includes('private.invalid'));});
test('phase54 trend refuses future source points and malformed cohort partition provenance',async()=>{assert.equal(typeof exportsModule.trendExport,'function');const f=await exportFixture(),request={accounts:f.accounts,points:f.points,manifest:f.meta.manifest,options:{start:BASE,end:'2026-09-29',metric:'followers',visibleOffset:0,visibleDays:90}};for(const mutate of [x=>x.manifest=null,x=>x.manifest.asOf=BASE+'T02:00:00.000Z',x=>x.manifest.files.find(p=>p.path==='daily/1.json').sha256='pretend-fingerprint',x=>x.manifest.files.find(p=>p.path==='daily/1.json').targetId=2,x=>x.accounts.push(structuredClone(x.accounts[0]))]){const x=structuredClone(request);mutate(x);assert.throws(()=>exportsModule.trendExport(x));}});
test('phase54 compact 90-day CSV metadata/cohort identities are written once, never repeated on every point',async()=>{assert.equal(typeof exportsModule.trendExport,'function');const f=await exportFixture(),rs=objectRows(exportsModule.trendExport({accounts:f.accounts,points:f.points,manifest:f.meta.manifest,options:{start:BASE,end:'2026-09-29',metric:'followers',visibleOffset:10,visibleDays:90}})),metadata=rs.filter(x=>x.recordType==='metadata'),cohort=rs.filter(x=>x.recordType==='cohort'),points=rs.filter(x=>x.recordType==='point');assert.equal(metadata.length,1);assert.equal(cohort.length,2);assert.equal(metadata[0].visibleOffset,10);assert.equal(points[0].day,10);assert.equal(points[0].currentDate,'2026-09-22');assert.equal(cohort[0].currentBaselineAt,BASE+'T02:00:00.000Z');assert.ok(points.every(p=>p.cohortTargetIds===null&&p.selectedTargetIds===null&&p.dailyPartSha256===null));});
test('phase54 public works CSV never leaks a private, credentialed or mismatched work locator',async()=>{
 const f=await exportFixture(),base={rows:f.parts['works/1.json'].items,kind:'works',account:f.accounts[0],manifest:f.meta.manifest};
 const valid=exportsModule.historyExport(base);assert.equal(cell(valid,valid[1],'url'),'https://www.douyin.com/video/7123456789012345678');
 for(const url of ['https://private.invalid/sheet','http://127.0.0.1/private','file:///tmp/private','https://synthetic-user:synthetic-pass@www.douyin.com/video/7123456789012345678','https://www.douyin.com/video/7123456789012345678?cookie=synthetic-secret','https://www.douyin.com/video/7123456789012345679','https://www.douyin.com.evil.invalid/video/7123456789012345678']){
  const x=structuredClone(base);x.rows[0].url=url;let table;try{table=exportsModule.historyExport(x);}catch{continue;}const projected=cell(table,table[1],'url');assert.ok(projected===null||projected==='https://www.douyin.com/video/7123456789012345678','invalid locator must be rejected, removed or normalized to exact safe public identity: '+url);assert.ok(!JSON.stringify(table).includes('synthetic-secret')&&!JSON.stringify(table).includes('synthetic-pass')&&!JSON.stringify(table).includes('private.invalid'));
 }
});
