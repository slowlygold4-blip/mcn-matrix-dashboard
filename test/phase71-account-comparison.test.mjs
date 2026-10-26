// Phase71 independent real AccountPanel and Home task replay. Synthetic sealed
// saved bytes only: no browser, platform, collector, writer, database or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {derivePublicHistoryDateIndex} from '../lib/public-history-range.mjs';
import {parseAccountRequest,accountShareQuery} from '../../mcn-public-site/lib/replica-account.mjs';
import {workspaceNavigation} from '../../mcn-public-site/lib/replica-navigation.mjs';
import {growthSeries} from '../../mcn-public-site/lib/replica-trends.mjs';
import {readReplicaPart} from '../../mcn-public-site/lib/replica-reader.mjs';

const SITE=new URL('../../mcn-public-site/',import.meta.url);
const oldHarness=await readFile(new URL('./public-global-url-phase53-peer-20261001.test.mjs',import.meta.url),'utf8');
const first=oldHarness.indexOf('const SITE = new URL('),last=oldHarness.indexOf('\nasync function apply(h,key)');
assert.ok(first>0&&last>first,'unchanged actual Home harness boundaries exist');
let source=oldHarness.slice(first,last).replace("new URL('../../mcn-public-site/', import.meta.url)",`new URL(${JSON.stringify(SITE.href)})`);
source=source.replace("document:{visibilityState:'visible',activeElement:null,createElement()","document:{visibilityState:'visible',activeElement:null,querySelector(){return null;},createElement()");
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const {fixture,pageHarness,nodes,textOf,ts,requireSite}=await new AsyncFunction('readFile','createRequire','createHash','vm','assert','derivePublicHistoryDateIndex',source+'\nreturn {fixture,pageHarness,nodes,textOf,ts,requireSite};')(readFile,createRequire,createHash,vm,assert,derivePublicHistoryDateIndex);
const accountSource=await readFile(new URL('components/account-panel.tsx',SITE),'utf8');
const accountCode=ts.transpileModule(accountSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const A={start:'2026-09-20',end:'2026-09-29'},B={compare:true,otherStart:'2026-09-12',otherEnd:'2026-09-19'};
const idle={compare:false,otherStart:'',otherEnd:''},generation='2026-09-29T16:34:00.000Z';
const baseRequest={id:1,...A,generation};
const baseQuery='?'+new URLSearchParams({account:'1',...A,generation});
const queryWithB=baseQuery+'&compareStart='+B.otherStart+'&compareEnd='+B.otherEnd;
const deep=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

async function accountHarness(options={}){
 const f=options.fixture??await fixture();
 let props={account:f.accounts.find(a=>a.id===(options.accountId??1)),manifest:f.meta.manifest,boards:f.parts['catalog.json'].boards,
  request:options.request??{...baseRequest},onReturn(){returns++;},onHistory(){},onAddress(query){addresses.push(query);href=new URL(query,href).href;props={...props,request:parseAccountRequest(query)};dirty=true;}};
 let href=options.address??'https://synthetic.invalid/dashboard/'+baseQuery,returns=0,cursor=0,dirty=false,tree,pendingEffects=[],activeReads=0;
 const hooks=[],reads=[],addresses=[],copies=[],location={};
 for(const p of ['href','origin','pathname','search','hash'])Object.defineProperty(location,p,{get:()=>new URL(href)[p]});
 const react={
  useState(initial){const i=cursor++;if(!(i in hooks))hooks[i]={value:typeof initial==='function'?initial():initial};return [hooks[i].value,value=>{const next=typeof value==='function'?value(hooks[i].value):value;if(!Object.is(next,hooks[i].value)){hooks[i].value=next;dirty=true;}}];},
  useRef(initial){const i=cursor++;if(!(i in hooks))hooks[i]={current:initial};return hooks[i];},
  useMemo(fn){cursor++;return fn();},
  useEffect(fn,deps){const i=cursor++,old=hooks[i];if(!old||deps.some((v,j)=>!Object.is(v,old.deps[j]))){hooks[i]={deps,cleanup:old?.cleanup};pendingEffects.push(()=>{old?.cleanup?.();hooks[i].cleanup=fn();});}}
 };
 const jsx=(type,p,key)=>({type,props:p||{},key}),exports={};
 const context={exports,window:{location},navigator:{clipboard:{async writeText(text){if(options.clipboardFailure)throw Error('Synthetic clipboard denial');copies.push(text);}}},
  URL,URLSearchParams,AbortController,Blob,Date,Map,Set,Promise,console,setTimeout,clearTimeout,
  document:{createElement(){return {click(){}};}},
  require(specifier){if(specifier==='react')return react;if(specifier==='react/jsx-runtime')return {jsx,jsxs:jsx,Fragment:'Fragment'};
   if(specifier==='@/lib/replica-reader.mjs')return {readReplicaPart:async(args)=>{reads.push({generation:args.generation,part:args.part,signal:args.signal});activeReads++;try{
    return await readReplicaPart({...args,fetcher:async()=>{if(options.beforeRead)await options.beforeRead(args);let body=JSON.stringify(f.parts[args.part])+'\n';if(options.transformBody)body=options.transformBody(body,args);return new Response(body,{headers:{'X-Data-SHA256':args.meta.sha256,'X-Data-Cutoff':args.generation}});}});
   }finally{activeReads--;}}};
   if(specifier.startsWith('@/lib/'))return requireSite(new URL(specifier.slice(2),SITE).pathname);
   if(specifier.startsWith('@/components/'))return new Proxy({},{get:(_t,key)=>String(key)});return requireSite(specifier);
  }};
 vm.runInNewContext(accountCode,context,{filename:'phase71-actual-account-panel.cjs'});
 function render(){cursor=0;dirty=false;tree=exports.AccountPanel(props);}
 async function flush(){for(let i=0;i<60;i++){if(dirty||!tree)render();const effects=pendingEffects;pendingEffects=[];effects.forEach(fn=>fn());await new Promise(r=>setTimeout(r,1));if(!dirty&&!pendingEffects.length&&!activeReads)break;}if(dirty)render();return tree;}
 const all=()=>nodes(tree),element=predicate=>all().find(predicate);
 function button(label){const n=element(n=>n.type==='Button'&&textOf(n)===label);assert.ok(n,'missing actual account button '+label);return n;}
 render();await flush();
 return {addresses,copies,reads,location,fixture:f,flush,element,button,text:()=>textOf(tree),returns:()=>returns,
  growth:()=>element(n=>n.type==='GrowthPanel'),
  async click(label){const n=button(label);assert.notEqual(n.props.disabled,true,'browser-disabled action '+label);await n.props.onClick?.({currentTarget:{focus(){}}});await flush();},
  async comparison(next){const n=this.growth();assert.ok(n,'actual AccountPanel must render GrowthPanel');assert.equal(typeof n.props.onComparison,'function','personal GrowthPanel must be controlled for saved/share B');n.props.onComparison(next);await flush();},
  async update(patch){const previousKey=props.account?.id+'-'+props.manifest.asOf;props={...props,...patch};const nextKey=props.account?.id+'-'+props.manifest.asOf;
   // Home actually keys this component by identity/publication. Replay React's
   // unmount cleanup and fresh hooks; do not manufacture stale same-key state.
   if(nextKey!==previousKey){hooks.forEach(h=>h?.cleanup?.());hooks.length=0;pendingEffects=[];tree=null;}dirty=true;await flush();},
  close(){hooks.forEach(h=>h?.cleanup?.());}
 };
}

test('phase71 legacy no-B account request and share remain exactly the four-field contract',()=>{
 assert.deepEqual(parseAccountRequest(baseQuery),baseRequest);
 assert.equal(accountShareQuery(baseRequest),baseQuery);
 assert.deepEqual([...new URLSearchParams(accountShareQuery(baseRequest)).keys()],['account','start','end','generation']);
 assert.deepEqual(parseAccountRequest('?account=1'),{id:1,start:null,end:null,generation:null});
});

test('phase71 optional personal B round-trips without changing identity, A or generation',()=>{
 const wanted={...baseRequest,comparison:B};
 assert.deepEqual(parseAccountRequest(queryWithB),wanted);
 const query=accountShareQuery(wanted),p=new URLSearchParams(query);
 assert.deepEqual([...p.keys()],['account','start','end','generation','compareStart','compareEnd']);
 assert.deepEqual(parseAccountRequest(query),wanted);
 assert.equal(p.get('account'),'1');assert.equal(p.get('generation'),generation);
 assert.equal(accountShareQuery({...baseRequest,comparison:idle}),baseQuery);
});

test('phase71 personal B serializer rejects malformed supplied comparison state rather than inventing dates',()=>{
 for(const comparison of [null,{compare:'true',otherStart:B.otherStart,otherEnd:B.otherEnd},{compare:true,otherStart:B.otherStart,otherEnd:''},{compare:true,otherStart:'2026-09-20',otherEnd:'2026-09-19'}])
  assert.throws(()=>accountShareQuery({...baseRequest,comparison}),Error);
});

test('phase71 valid optional B keeps strict account identity, generation and same-day zero semantics',()=>{
 const same={compare:true,otherStart:'2026-09-12',otherEnd:'2026-09-12'};
 assert.deepEqual(parseAccountRequest(accountShareQuery({...baseRequest,comparison:same})),{...baseRequest,comparison:same});
 for(const suffix of ['&account=2','&%61ccount=2','&generation=2026-09-30T16%3A34%3A00.000Z'])assert.throws(()=>parseAccountRequest(queryWithB+suffix),Error);
 for(const id of [0,-1,1.5,100_000_000])assert.throws(()=>accountShareQuery({...baseRequest,id,comparison:B}),Error);
 assert.throws(()=>accountShareQuery({...baseRequest,generation:null,comparison:B}),Error);
 assert.throws(()=>accountShareQuery({...baseRequest,start:null,end:null,comparison:B}),Error);
 const p=new URLSearchParams(accountShareQuery({...baseRequest,comparison:B,redirect:'https://other.invalid',part:'../../private'}));
 assert.equal(p.has('redirect'),false);assert.equal(p.has('part'),false);
});

test('phase71 first personal account-only A defaults may carry a valid B but cannot forge share readiness',async()=>{
 const query='?account=1&compareStart='+B.otherStart+'&compareEnd='+B.otherEnd;
 const wanted={id:1,start:null,end:null,generation:null,comparison:B};
 assert.deepEqual(parseAccountRequest(query),wanted);
 assert.throws(()=>accountShareQuery(wanted),Error,'sharing still needs real A dates and pinned generation');
 const h=await pageHarness('https://synthetic.invalid/'+query);try{
  const p=h.element(n=>n.type==='AccountPanel');assert.ok(p);assert.deepEqual(deep(p.props.request),{...wanted,generation});
  const a=await accountHarness({request:p.props.request});try{
   assert.deepEqual(deep(a.growth().props.comparison),B);assert.equal(a.growth().props.start,'2026-09-12');assert.equal(a.growth().props.end,'2026-09-29');
   await a.click('复制账号分享链接');assert.deepEqual(parseAccountRequest(new URL(a.copies[0]).search),{...baseRequest,start:'2026-09-12',comparison:B});
  }finally{a.close();}
 }finally{h.close();}
});

for(const suffix of [
 '&compareStart=2026-09-12','&compareEnd=2026-09-19','&compareStart=&compareEnd=',
 '&compareStart=2026-09-20&compareEnd=2026-09-19','&compareStart=2026-09-31&compareEnd=2026-10-01',
 '&compareStart=2026-09-12&compareStart=2026-09-13&compareEnd=2026-09-19',
 '&compareStart=2026-09-12&compareEnd=2026-09-19&%63ompareEnd=2026-09-20'
])test('phase71 malformed personal B pair rejects before route acceptance '+suffix,()=>{
 assert.throws(()=>parseAccountRequest(baseQuery+suffix),Error);
 assert.throws(()=>workspaceNavigation(baseQuery+suffix,'#accounts'),Error);
});

test('phase71 actual AccountPanel restores addressed B and computes only this account four endpoints',async()=>{
 const h=await accountHarness({request:{...baseRequest,comparison:B}});try{
  const g=h.growth();assert.ok(g);assert.deepEqual(deep(g.props.comparison),B);
  assert.deepEqual(deep(g.props.accounts.map(a=>a.id)),[1]);assert.ok(g.props.points.every(p=>p.targetId===1));
  const series=growthSeries(g.props.accounts,g.props.points,{start:g.props.start,end:g.props.end,otherStart:B.otherStart,otherEnd:B.otherEnd,metric:'followers'});
  assert.equal(series.cohortCount,1);assert.equal(series.points.at(-1).current,225);assert.equal(series.points[7].comparison,49);
  assert.equal(h.reads.length,1);assert.equal(h.reads[0].generation,generation);assert.equal(h.reads[0].part,'daily/1.json');
 }finally{h.close();}
});

test('phase71 actual edited B copy uses same-origin canonical six-field link and a new reader restores it',async()=>{
 const h=await accountHarness();try{
  await h.comparison(B);await h.click('复制账号分享链接');assert.equal(h.copies.length,1);
  const u=new URL(h.copies[0]);assert.equal(u.origin,'https://synthetic.invalid');assert.equal(u.pathname,'/dashboard/');
  assert.deepEqual(parseAccountRequest(u.search),{...baseRequest,comparison:B});assert.equal(h.addresses.length,0,'copy is not an implicit apply');
  const reader=await accountHarness({request:parseAccountRequest(u.search),address:u.href});try{assert.deepEqual(deep(reader.growth().props.comparison),B);assert.equal(reader.growth().props.manifest.asOf,generation);}finally{reader.close();}
 }finally{h.close();}
});

test('phase71 actual save B keeps A and pinned publication while closing comparison removes only B',async()=>{
 const h=await accountHarness();try{
  await h.comparison(B);await h.click('保存日期到地址');assert.equal(h.addresses.length,1);
  assert.deepEqual(parseAccountRequest(h.addresses[0]),{...baseRequest,comparison:B});
  await h.comparison(idle);await h.click('保存日期到地址');assert.equal(h.addresses.at(-1),baseQuery);assert.deepEqual(deep(h.growth().props.comparison),idle);
 }finally{h.close();}
});

test('phase71 legacy actual AccountPanel copy produces exactly the four fields without invented B',async()=>{
 const h=await accountHarness();try{
  await h.click('复制账号分享链接');assert.equal(h.copies.length,1);
  assert.equal(new URL(h.copies[0]).search,baseQuery);assert.deepEqual(parseAccountRequest(new URL(h.copies[0]).search),baseRequest);
 }finally{h.close();}
});

test('phase71 incomplete B draft has explanation and cannot save, copy or retain misleading ready curve',async()=>{
 const h=await accountHarness({request:{...baseRequest,comparison:B}});try{
  await h.comparison({...B,otherEnd:''});
  assert.equal(h.button('保存日期到地址').props.disabled,true);assert.equal(h.button('复制账号分享链接').props.disabled,true);
  assert.equal(h.addresses.length,0);assert.equal(h.copies.length,0);
  assert.ok(h.text().includes('日期')||h.text().includes('比较'));
  assert.ok(!h.growth()||h.growth().props.ready===false,'incomplete B must hide the curve or mark it not ready');
 }finally{h.close();}
});

for(const bad of [{compare:true,otherStart:'2026-09-20',otherEnd:'2026-09-19'},{compare:true,otherStart:'2026-09-31',otherEnd:'2026-10-01'}])
test('phase71 actual invalid B draft is not a saveable or copyable applied scope '+bad.otherStart,async()=>{
 const h=await accountHarness({request:{...baseRequest,comparison:B}});try{
  await h.comparison(bad);assert.equal(h.button('保存日期到地址').props.disabled,true);assert.equal(h.button('复制账号分享链接').props.disabled,true);
  assert.equal(h.addresses.length,0);assert.equal(h.copies.length,0);assert.ok(!h.growth()||h.growth().props.ready===false);
 }finally{h.close();}
});

test('phase71 clipboard denial retains inspectable canonical B link rather than lying about success',async()=>{
 const h=await accountHarness({clipboardFailure:true,request:{...baseRequest,comparison:B}});try{
  await h.click('复制账号分享链接');assert.equal(h.copies.length,0);
  const field=h.element(n=>n.type==='Input'&&n.props['aria-label']==='账号分享地址');assert.ok(field);
  assert.deepEqual(parseAccountRequest(new URL(field.props.value).search),{...baseRequest,comparison:B});
  assert.match(h.text(),/未允许复制|复制失败/);
 }finally{h.close();}
});

test('phase71 addressed personal B changes are reapplied without reading unrelated generation',async()=>{
 const h=await accountHarness({request:{...baseRequest,comparison:B}});try{
  const next={compare:true,otherStart:'2026-09-14',otherEnd:'2026-09-18'};
  await h.update({request:{...baseRequest,comparison:next}});assert.deepEqual(deep(h.growth().props.comparison),next);
  await h.update({request:{...baseRequest}});assert.deepEqual(deep(h.growth().props.comparison),idle);
  assert.equal(h.reads.length,1,'only B selection changes; existing sealed full personal history is reused');
 }finally{h.close();}
});

test('phase71 actual personal A shrink resets the controlled 90-day offset and shows the true first screen',async()=>{
 const f=await fixture({days:130,asOf:'2027-01-20T16:34:00.000Z'}),lastDate=f.parts['daily/1.json'].items.at(-1).date;
 const h=await accountHarness({fixture:f,request:{id:1,start:'2026-09-12',end:lastDate,generation:f.meta.manifest.asOf}});try{
  assert.equal(h.growth().props.offset,0);assert.equal(typeof h.growth().props.onOffset,'function');
  h.growth().props.onOffset(90);await h.flush();assert.equal(h.growth().props.offset,90);
  const old=growthSeries(h.growth().props.accounts,h.growth().props.points,{start:h.growth().props.start,end:h.growth().props.end,visibleOffset:h.growth().props.offset});
  assert.equal(old.points.length,40,'the real old screen contains the last forty saved days');
  const end=h.element(n=>n.type==='Input'&&n.props['aria-label']==='个人截止观察日');assert.ok(end);end.props.onChange({target:{value:'2026-09-19'}});await h.flush();
  const g=h.growth();assert.equal(g.props.offset,0);assert.equal(g.props.end,'2026-09-19');
  const current=growthSeries(g.props.accounts,g.props.points,{start:g.props.start,end:g.props.end,visibleOffset:g.props.offset});
  assert.equal(current.points.length,8);assert.equal(current.points[0].currentDate,'2026-09-12');assert.equal(current.points.at(-1).current,49);
  assert.equal(h.reads.length,1,'date changes reuse the same verified personal partition, not a second collection');
 }finally{h.close();}
});

test('phase71 actual personal B change resets offset without moving A or changing the pinned data',async()=>{
 const f=await fixture({days:130,asOf:'2027-01-20T16:34:00.000Z'}),lastDate=f.parts['daily/1.json'].items.at(-1).date;
 const request={id:1,start:'2026-09-12',end:lastDate,generation:f.meta.manifest.asOf,comparison:B};
 const h=await accountHarness({fixture:f,request});try{
  h.growth().props.onOffset(90);await h.flush();assert.equal(h.growth().props.offset,90);
  const next={...B,otherEnd:'2026-09-18'};await h.comparison(next);const g=h.growth();
  assert.equal(g.props.offset,0);assert.equal(g.props.start,request.start);assert.equal(g.props.end,lastDate);assert.equal(g.props.manifest.asOf,request.generation);assert.deepEqual(deep(g.props.comparison),next);
  const current=growthSeries(g.props.accounts,g.props.points,{start:g.props.start,end:g.props.end,otherStart:next.otherStart,otherEnd:next.otherEnd,visibleOffset:g.props.offset});
  assert.equal(current.points.length,90);assert.equal(current.points[6].comparison,36);assert.equal(h.reads.length,1);
 }finally{h.close();}
});

test('phase71 switching actual account clears unrelated local B and shares the new account only',async()=>{
 const h=await accountHarness();try{
  await h.comparison(B);await h.update({account:h.fixture.accounts[1],request:{...baseRequest,id:2}});
  assert.deepEqual(deep(h.growth().props.comparison),idle);assert.ok(h.growth().props.points.every(p=>p.targetId===2));
  await h.click('复制账号分享链接');assert.equal(new URL(h.copies[0]).searchParams.get('account'),'2');assert.equal(new URL(h.copies[0]).searchParams.has('compareStart'),false);
 }finally{h.close();}
});

test('phase71 failed sealed personal history never saves an unread new date or exposes old GrowthPanel',async()=>{
 let fail=false;
 const h=await accountHarness({beforeRead:async args=>{if(fail&&args.part==='daily/2.json')throw Error('Synthetic personal source failure');}});try{
  fail=true;await h.update({account:h.fixture.accounts[1],request:{...baseRequest,id:2,comparison:B}});
  assert.equal(h.growth(),undefined);assert.match(h.text(),/Synthetic personal source failure/);assert.equal(h.addresses.length,0);assert.equal(h.copies.length,0);
  assert.equal(h.element(n=>n.type==='Button'&&textOf(n)==='保存日期到地址'),undefined);
 }finally{h.close();}
});

test('phase71 cross-generation sealed account body is rejected without address or clipboard mutation',async()=>{
 const h=await accountHarness({request:{...baseRequest,comparison:B},transformBody:body=>body.replace(generation,'2026-09-30T16:34:00.000Z')});try{
  assert.equal(h.growth(),undefined);assert.ok(h.element(n=>n.props.role==='alert'));assert.equal(h.addresses.length,0);assert.equal(h.copies.length,0);
 }finally{h.close();}
});

test('phase71 late cancelled old account read cannot replace new account points or its B request',async()=>{
 const wait=deferred();let delayed=false,oldSignal;
 const h=await accountHarness({beforeRead:async args=>{if(delayed&&args.part==='daily/2.json'){oldSignal=args.signal;await wait.promise;}}});try{
  delayed=true;const old=h.update({account:h.fixture.accounts[1],request:{...baseRequest,id:2,comparison:B}});
  for(let i=0;i<40&&!oldSignal;i++)await new Promise(r=>setTimeout(r,1));assert.ok(oldSignal);
  const wanted={compare:true,otherStart:'2026-09-13',otherEnd:'2026-09-17'};
  await h.update({account:h.fixture.accounts[0],request:{...baseRequest,comparison:wanted}});assert.equal(oldSignal.aborted,true);
  wait.resolve();await old;await h.flush();assert.ok(h.growth().props.points.every(p=>p.targetId===1));assert.deepEqual(deep(h.growth().props.comparison),wanted);
  assert.equal(h.addresses.length,0);
 }finally{wait.resolve();h.close();}
});

test('phase71 actual Home first unpinned personal B link gains generation without erasing paired dates',async()=>{
 const query='?account=1&start='+A.start+'&end='+A.end+'&compareStart='+B.otherStart+'&compareEnd='+B.otherEnd;
 const h=await pageHarness('https://synthetic.invalid/'+query);try{
  const p=new URL(h.window.location.href).searchParams;assert.equal(p.get('generation'),generation);assert.equal(p.get('compareStart'),B.otherStart);assert.equal(p.get('compareEnd'),B.otherEnd);
  assert.deepEqual(deep(h.element(n=>n.type==='AccountPanel').props.request.comparison),B);
 }finally{h.close();}
});

test('phase71 actual Home personal B fixed-generation refresh preserves request and share state',async()=>{
 const h=await pageHarness('https://synthetic.invalid/'+queryWithB);try{
  const before=h.window.location.href;assert.deepEqual(deep(h.element(n=>n.type==='AccountPanel').props.request.comparison),B);
  await h.click('刷新已发布数据');assert.equal(h.window.location.href,before);
  assert.deepEqual(deep(h.element(n=>n.type==='AccountPanel').props.request.comparison),B);
  assert.ok(h.fetches.every(f=>new URL(f.url,'https://synthetic.invalid').searchParams.get('generation')===generation));
 }finally{h.close();}
});

test('phase71 actual Home personal B cannot fall back to another publication on generation mismatch',async()=>{
 const old=queryWithB.replace(encodeURIComponent(generation),encodeURIComponent('2026-09-28T16:34:00.000Z'));
 const address='https://synthetic.invalid/'+old,h=await pageHarness(address);try{
  assert.equal(h.window.location.href,address);assert.equal(h.element(n=>n.type==='AccountPanel'),undefined);
  assert.ok(h.element(n=>n.props.role==='alert'));assert.equal(h.fetches.length,1);assert.equal(h.reads.length,0);
 }finally{h.close();}
});

test('phase71 malformed personal B Home route explains error before any public read',async()=>{
 const h=await pageHarness('https://synthetic.invalid/'+baseQuery+'&compareStart='+B.otherStart);try{
  assert.ok(h.element(n=>n.props.role==='alert'));assert.equal(h.fetches.length,0);assert.equal(h.element(n=>n.type==='AccountPanel'),undefined);
 }finally{h.close();}
});

test('phase71 actual Home validates a rejected personal save before replacing the old applied address',async()=>{
 const h=await pageHarness('https://synthetic.invalid/'+queryWithB);try{
  const before=h.window.location.href,p=h.element(n=>n.type==='AccountPanel');assert.ok(p);
  try{p.props.onAddress(baseQuery+'&compareStart='+B.otherStart);}catch{}
  await h.flush();assert.equal(h.window.location.href,before,'reject malformed personal B before history.replaceState, not afterwards');
  assert.deepEqual(deep(h.element(n=>n.type==='AccountPanel').props.request.comparison),B);
 }finally{h.close();}
});

for(const replacement of [{...baseRequest,id:2,comparison:B},{...baseRequest,generation:'2026-09-28T16:34:00.000Z',comparison:B}])
test('phase71 actual Home does not save a foreign identity or publication from personal callback '+replacement.id+' / '+replacement.generation,async()=>{
 const h=await pageHarness('https://synthetic.invalid/'+queryWithB);try{
  const before=h.window.location.href,p=h.element(n=>n.type==='AccountPanel');assert.ok(p);
  // The actual controller's Error belongs to the isolated VM realm, not this
  // test's constructor. Validate the real rejection message, not instanceof.
  assert.throws(()=>p.props.onAddress(accountShareQuery(replacement)),error=>error?.name==='Error'&&/身份|版本/.test(error.message));await h.flush();assert.equal(h.window.location.href,before);
  assert.equal(h.element(n=>n.type==='AccountPanel').props.request.id,1);assert.equal(h.element(n=>n.type==='AccountPanel').props.request.generation,generation);
 }finally{h.close();}
});

test('phase71 personal B editing and returning preserves original matrix A/B list contract',async()=>{
 const original='?theme=tuantuan&classification=slice&period=custom&start='+A.start+'&end='+A.end+'&compareStart='+B.otherStart+'&compareEnd='+B.otherEnd+'&sort=likes.delta&order=asc&query=Synthetic#accounts';
 const h=await pageHarness('https://synthetic.invalid/'+original);try{
  const before=h.window.location.href;const historyEntry=h.element(n=>n.type==='Button'&&n.props['aria-label']==='查看Synthetic 1的历史');assert.ok(historyEntry);historyEntry.props.onClick({currentTarget:{isConnected:true,focus(){}}});await h.flush();await h.click('打开独立账号页面');
  const p=h.element(n=>n.type==='AccountPanel');assert.ok(p);
  p.props.onAddress(accountShareQuery({...p.props.request,comparison:{compare:true,otherStart:'2026-09-14',otherEnd:'2026-09-18'}}));await h.flush();
  assert.equal(new URL(h.window.location.href).searchParams.get('compareStart'),'2026-09-14');
  h.element(n=>n.type==='AccountPanel').props.onReturn();await h.flush();assert.equal(h.window.location.href,before);
  assert.deepEqual(deep(h.element(n=>n.type==='GrowthPanel').props.comparison),B);
 }finally{h.close();}
});
