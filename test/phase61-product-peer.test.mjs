// Independent controller evidence only: no browser, server, network, production data or Site writes.
// This extends the phase60 actual-TSX harness with commit-time refs, queued animation frames,
// navigation events, synthetic reader boundaries and captured CSV downloads.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';

const site=new URL('../../mcn-public-site/',import.meta.url);
const requireSite=createRequire(new URL('package.json',site));
const ts=requireSite('typescript');
const paths=['app/page.tsx','components/account-panel.tsx'];
const sources=Object.fromEntries(await Promise.all(paths.map(async path=>[path,await readFile(new URL(path,site),'utf8')])));
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const textOf=x=>x==null||typeof x==='boolean'?'':Array.isArray(x)?x.map(textOf).join(''):typeof x==='object'?textOf(x.props?.children):String(x);
function nodes(x,out=[]){if(!x||typeof x!=='object')return out;if(Array.isArray(x))x.forEach(value=>nodes(value,out));else{out.push(x);nodes(x.props?.children,out);}return out;}
function harness(path='app/page.tsx',name='default',props={},address='https://source-review.invalid/#overview',options={}){
 let currentProps=props,cursor=0,stateOrdinal=0,dirty=true,tree,effects=[],frames=[],frameId=0;
 const hooks=[],fetches=[],reads=[],downloads=[],blobs=[],exports={},stateNames=[],stateSlots=new Map(),listeners=new Map(),scrolls=[],focuses=[];
 const ast=ts.createSourceFile(path,sources[path],ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 function visit(node){if(ts.isVariableDeclaration(node)&&ts.isArrayBindingPattern(node.name)&&ts.isCallExpression(node.initializer)&&node.initializer.expression.getText(ast)==='useState')stateNames.push(node.name.elements[0].name.getText(ast));ts.forEachChild(node,visit);}visit(ast);
 const react={
  useState(initial){const index=cursor++,stateName=stateNames[stateOrdinal++];stateSlots.set(stateName,index);if(!hooks[index])hooks[index]={value:Object.hasOwn(options.initialState||{},stateName)?options.initialState[stateName]:typeof initial==='function'?initial():initial};return [hooks[index].value,value=>{const next=typeof value==='function'?value(hooks[index].value):value;if(!Object.is(next,hooks[index].value)){hooks[index].value=next;dirty=true;}}];},
  useRef(initial){const index=cursor++;return hooks[index]??(hooks[index]={current:initial});},
  useMemo(fn){cursor++;return fn();},
  useEffect(fn,deps){const index=cursor++,old=hooks[index];if(!old||deps.some((value,i)=>!Object.is(value,old.deps[i]))){hooks[index]={deps,cleanup:old?.cleanup};effects.push(()=>{old?.cleanup?.();hooks[index].cleanup=fn();});}},
 };
 const jsx=(type,properties,key)=>({type,props:properties||{},key});
 class DownloadURL extends URL{static createObjectURL(blob){blobs.push(blob);return 'blob:synthetic-'+blobs.length;}static revokeObjectURL(){}}
 const location=new URL(address),historyEntries=[location.href];let historyIndex=0;
 const document={visibilityState:'visible',activeElement:{tagName:'BODY'},querySelector:selector=>selector==='[role="dialog"]'&&(options.dialogVisible?.()||nodes(tree).some(n=>n.type==='Dialog'&&n.props.open))?{synthetic:true}:null,
  createElement(tag){assert.equal(tag,'a');return {click(){downloads.push({name:this.download,url:this.href,blob:blobs.at(-1)});}};}};
 const window={location,scrollY:0,scrollTo(value){this.scrollY=typeof value==='object'?value.top:arguments[1];scrolls.push(this.scrollY);},addEventListener(type,fn){listeners.set(type,fn);},removeEventListener(type){listeners.delete(type);},history:{scrollRestoration:'auto',
  replaceState(_state,_title,next){location.href=new URL(next,location.href).href;historyEntries[historyIndex]=location.href;},
  pushState(_state,_title,next){location.href=new URL(next,location.href).href;historyEntries.splice(++historyIndex);historyEntries.push(location.href);},
 }};
 const context={exports,URL:DownloadURL,URLSearchParams,AbortController,Blob,Date,Map,Set,Promise,console,window,document,
  requestAnimationFrame:fn=>{frames.push({id:++frameId,fn});return frameId;},cancelAnimationFrame:id=>{frames=frames.filter(frame=>frame.id!==id);},setTimeout:fn=>setTimeout(fn,0),clearTimeout,setInterval:()=>1,clearInterval(){},
  fetch:async(...args)=>{fetches.push(args);if(options.fetcher)return options.fetcher(...args);throw Error('network unavailable in independent test');},
  navigator:{clipboard:{writeText:async()=>{}}},
  require(specifier){
   if(specifier==='react')return react;
   if(specifier==='react/jsx-runtime')return {jsx,jsxs:jsx,Fragment:'Fragment'};
   if(specifier==='@/lib/replica-reader.mjs')return {readReplicaPart:async request=>{reads.push(request);if(options.readPart)return options.readPart(request);throw Error('synthetic history unavailable');}};
   if(specifier==='recharts'||specifier==='lucide-react'||specifier.startsWith('@/components/'))return new Proxy({}, {get:(_target,key)=>String(key)});
   if(specifier==='@/lib/utils')return {cn:(...parts)=>parts.filter(Boolean).join(' ')};
   if(specifier.startsWith('@/lib/'))return requireSite(new URL(specifier.slice(2),site).pathname);
   return requireSite(specifier);
  },
 };
 vm.runInNewContext(compile(sources[path]),context,{filename:'phase61-'+path});
 function commit(node,hidden=false){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(n=>commit(n,hidden));return;}hidden=hidden||!!node.props.hidden;
  const ref=node.props.ref;if(ref&&typeof ref==='object'){if(!ref.current)ref.current={isConnected:true,disabled:false,focus(arg){if(!this.hidden){document.activeElement=this;focuses.push({element:this,options:arg});}},scrollIntoView(){},getClientRects(){return this.hidden?[]:[{}];},querySelector(){return null;}};ref.current.hidden=hidden;ref.current.label=node.props['aria-label']||node.type;}
  commit(node.props.children,hidden);
 }
 function render(next={}){currentProps={...currentProps,...next};cursor=0;stateOrdinal=0;dirty=false;tree=exports[name](currentProps);commit(tree);return tree;}
 return {render,window,document,fetches,reads,downloads,scrolls,focuses,all:()=>nodes(tree),text:()=>textOf(tree),state:name=>hooks[stateSlots.get(name)]?.value,
  back(){assert.ok(historyIndex>0);location.href=historyEntries[--historyIndex];listeners.get('popstate')?.();},
  forward(){assert.ok(historyIndex<historyEntries.length-1);location.href=historyEntries[++historyIndex];listeners.get('popstate')?.();},
  async flush(){for(let pass=0;pass<30;pass++){if(dirty)render();const queue=effects;effects=[];queue.forEach(fn=>fn());await new Promise(resolve=>setTimeout(resolve,0));if(dirty)continue;const due=frames;frames=[];due.forEach(frame=>frame.fn());if(!dirty&&!effects.length&&!frames.length)return tree;}throw Error('controller did not settle');},
  close(){hooks.forEach(hook=>hook?.cleanup?.());},
 };
}

const generation='2026-10-01T07:00:00.000Z';
const account={id:91,label:'合成作者91',platform:'douyin',enabled:true,boardKeys:['peer'],classification:{theme:{key:'peer',label:'独立合成主题'},labels:[]}};
const start='2026-09-12',end='2026-09-14';
const sample=(date,id=91,index=0)=>({id:index+1,targetId:id,date,capturedAt:date+'T03:00:00.000Z',sampleCount:1,followers:100-index,likes:index,posts:0,followersDelta:index?-1:null,likesDelta:index?1:null,postsDelta:index?0:null,followersAt:date+'T03:00:00.000Z',likesAt:date+'T03:00:00.000Z',postsAt:date+'T03:00:00.000Z',sourceChecksum:'a'.repeat(64)});
const points=[sample(start),sample('2026-09-13',91,1),sample(end,91,2)];
function published(count=45){const accounts=Array.from({length:count},(_,index)=>({...account,id:91+index,label:'合成作者'+(91+index)}));return {manifest:{asOf:generation,timeZone:'Asia/Shanghai',counts:{enabledAccounts:count,daily:count*3},files:[]},publishedAt:generation,accounts,boards:[{key:'peer',name:'合成矩阵'}],points:accounts.flatMap(a=>points.map(point=>({...point,targetId:a.id}))),topics:{topics:[],items:[]},summaryLoaded:true,dateIndexed:false};}
const initial=data=>({data,loading:false,start,end});
const button=(h,label,scope)=>{const found=nodes(scope||h.all()).find(node=>node.type==='Button'&&textOf(node)===label);assert.ok(found,'actual button missing: '+label);return found;};
const dialog=h=>{const found=h.all().find(node=>node.type==='DialogContent');assert.ok(found);return found;};
const heading=h=>h.all().find(node=>node.type==='h1').props.ref.current;
const atAddress=()=>'?'+new URLSearchParams({account:'91',start,end,generation});
async function openFirstHistory(h){h.all().find(node=>node.type==='Button'&&node.props['aria-label']==='查看合成作者91的历史').props.onClick({currentTarget:{isConnected:true,disabled:false,focus(){h.document.activeElement=this;}}});await h.flush();}

test('phase61 normal workspace navigation resets document scroll and keyboard entry without resetting filters or page',async()=>{
 const comparison={compare:true,otherStart:start,otherEnd:end},h=harness(undefined,undefined,{},undefined,{initialState:{...initial(published()),comparison}});
 try{await h.flush();h.all().find(n=>n.type==='Input'&&n.props['aria-label']==='搜索作者').props.onChange({target:{value:'合成'}});await h.flush();button(h,'下一页').props.onClick();await h.flush();
  h.window.scrollY=1840;button(h,'账号明细').props.onClick();await h.flush();
  assert.equal(h.window.scrollY,0,'normal workspace navigation must start at the new page heading');assert.equal(h.document.activeElement,heading(h));assert.equal(h.state('query'),'合成');assert.equal(h.state('page'),2);assert.equal(h.state('comparison'),comparison);assert.equal(h.state('start'),start);assert.equal(h.state('end'),end);
  h.window.scrollY=970;button(h,'话题观察').props.onClick();await h.flush();assert.equal(h.window.scrollY,0);assert.equal(h.document.activeElement,heading(h));assert.equal(h.fetches.length,0);
 }finally{h.close();}
});

test('phase61 explicit sidebar navigation from personal is a fresh workspace entry, not a protected return',async()=>{
 const h=harness(undefined,undefined,{},undefined,{initialState:initial(published())});
 try{await h.flush();h.window.scrollY=1730;h.all().find(n=>n.type==='CoveragePanel').props.onAccount(account);await h.flush();assert.equal(h.window.scrollY,0);h.window.scrollY=610;
  button(h,'话题观察').props.onClick();await h.flush();assert.equal(h.state('personal'),null);assert.equal(h.state('tab'),'topics');assert.equal(h.window.scrollY,0,'sidebar topics must not inherit the old overview scroll');assert.equal(h.document.activeElement,heading(h));
 }finally{h.close();}
});

test('phase61 workspace URL normalization must not cancel the normal personal-to-workspace scroll intent',async()=>{
 const address='https://source-review.invalid/?board=peer&period=custom&start='+start+'&end='+end+'#overview';
 const h=harness(undefined,undefined,{},address,{initialState:initial(published())});
 try{await h.flush();assert.equal(h.state('board'),'peer');h.window.scrollY=1450;h.all().find(n=>n.type==='CoveragePanel').props.onAccount(account);await h.flush();h.window.scrollY=705;
  button(h,'账号明细').props.onClick();await h.flush();assert.equal(h.state('tab'),'accounts');assert.equal(h.state('board'),'peer');assert.equal(new URLSearchParams(h.window.location.search).get('board'),'peer');assert.equal(new URLSearchParams(h.window.location.search).get('period'),'custom');assert.equal(h.window.scrollY,0);assert.equal(h.document.activeElement,heading(h));
 }finally{h.close();}
});

test('phase61 protected account return preserves exact workspace state, scroll and focus',async()=>{
 const comparison={compare:true,otherStart:start,otherEnd:end},h=harness(undefined,undefined,{},undefined,{initialState:{...initial(published()),comparison}});
 try{await h.flush();h.all().find(n=>n.type==='Input'&&n.props['aria-label']==='搜索作者').props.onChange({target:{value:'合成'}});await h.flush();button(h,'下一页').props.onClick();await h.flush();
  const address=h.window.location.href;h.window.scrollY=2150;h.all().find(n=>n.type==='CoveragePanel').props.onAccount(account);await h.flush();
  const personal=h.all().find(n=>n.type==='AccountPanel');assert.ok(personal);assert.equal(personal.props.returnLabel,'返回原核对页');personal.props.onReturn();await h.flush();
  assert.equal(h.window.location.href,address);assert.equal(h.window.scrollY,2150);assert.equal(h.state('page'),2);assert.equal(h.state('query'),'合成');assert.equal(h.state('comparison'),comparison);assert.equal(h.document.activeElement,heading(h));assert.equal(h.fetches.length,0);
 }finally{h.close();}
});

test('phase61 browser back from account restores captured overview scroll without closing a protected child dialog',async()=>{
 let protectedDialog=false;const h=harness(undefined,undefined,{},undefined,{initialState:initial(published()),dialogVisible:()=>protectedDialog});
 try{await h.flush();h.window.scrollY=1195;h.all().find(n=>n.type==='CoveragePanel').props.onAccount(account);await h.flush();protectedDialog=true;const focused={name:'gap-dialog-author'};h.document.activeElement=focused;h.back();await h.flush();assert.equal(h.window.scrollY,1195);assert.equal(h.document.activeElement,focused);assert.equal(h.state('tab'),'overview');}
 finally{h.close();}
});

test('phase61 direct account share fallback returns to the top of accounts without invented workspace context',async()=>{
 const h=harness(undefined,undefined,{},'https://source-review.invalid/'+atAddress(),{initialState:initial(published())});
 try{await h.flush();h.window.scrollY=815;const personal=h.all().find(n=>n.type==='AccountPanel');assert.equal(personal.props.returnLabel,'返回账号列表');personal.props.onReturn();await h.flush();assert.equal(h.state('tab'),'accounts');assert.equal(h.state('personal'),null);assert.equal(h.window.scrollY,0);}
 finally{h.close();}
});

function historyFixture(){const data=published(1),items=Array.from({length:45},(_,index)=>{const date=new Date(Date.UTC(2026,7,17+index)).toISOString().slice(0,10);return sample(date,91,index);});data.manifest.files.push({path:'daily/91.json',kind:'daily',targetId:91,count:45,sha256:'b'.repeat(64)});return {data,items};}

test('phase61 explicit history entry pages and exports all stored days at the same fixed publication',async()=>{
 const {data,items}=historyFixture(),h=harness(undefined,undefined,{},undefined,{initialState:initial(data),readPart:async()=>({items})});
 try{await h.flush();await openFirstHistory(h);assert.equal(h.reads.length,1);assert.equal(h.reads[0].generation,generation);assert.equal(h.reads[0].part,'daily/91.json');assert.match(textOf(dialog(h)),/全部 45 条/);
  assert.equal(nodes(dialog(h)).filter(n=>n.type==='TableRow').length,21);button(h,'下一页',dialog(h)).props.onClick();await h.flush();assert.equal(h.state('hPage'),2);button(h,'下一页',dialog(h)).props.onClick();await h.flush();assert.equal(h.state('hPage'),3);assert.equal(nodes(dialog(h)).filter(n=>n.type==='TableRow').length,6);
  button(h,'导出全部历史',dialog(h)).props.onClick();await h.flush();assert.equal(h.downloads.length,1);assert.equal(h.downloads[0].name,'91-daily.csv');const csv=await h.downloads[0].blob.text();const lines=csv.replace(/^\uFEFF/,'').trimEnd().split(/\r?\n/);assert.equal(lines.length,46,'export must include all pages');assert.ok(lines[0].startsWith('"asOf","timeZone","targetId","platform","label"'));assert.ok(lines.slice(1).every(line=>line.startsWith('"'+generation+'","Asia/Shanghai","91","douyin",')));assert.ok(csv.includes('2026-08-17'));assert.ok(csv.includes('2026-09-30'));assert.ok(csv.includes('b'.repeat(64)));
 }finally{h.close();}
});

test('phase61 full-history failure has a direct same-publication retry and no stale export during recovery',async()=>{
 const {data,items}=historyFixture();let attempt=0,release;const pending=new Promise(resolve=>{release=resolve;});const h=harness(undefined,undefined,{},undefined,{initialState:initial(data),readPart:async()=>{if(++attempt===1)throw Error('synthetic verified partition unavailable');return pending;}});
 try{await h.flush();await openFirstHistory(h);assert.match(textOf(dialog(h)),/synthetic verified partition unavailable/);assert.equal(nodes(dialog(h)).some(n=>n.type==='Button'&&textOf(n)==='导出全部历史'),false);
  const retry=nodes(dialog(h)).find(n=>n.type==='Button'&&/重试/.test(textOf(n)));assert.ok(retry,'failed full-history read needs an immediate retry control');retry.props.onClick();await h.flush();assert.equal(h.reads.length,2);assert.equal(h.reads[1].generation,generation);assert.equal(h.reads[1].part,'daily/91.json');assert.equal(nodes(dialog(h)).some(n=>n.type==='Button'&&textOf(n)==='导出全部历史'),false);assert.match(textOf(dialog(h)),/读取历史|核对/);
  release({items});await h.flush();assert.match(textOf(dialog(h)),/全部 45 条/);assert.equal(h.state('hPage'),1);assert.ok(button(h,'导出全部历史',dialog(h)));
 }finally{release?.({items});h.close();}
});

test('phase61 delayed response from a closed author cannot replace the next author history',async()=>{
 const {data,items}=historyFixture();data.accounts.push({...account,id:92,label:'合成作者92'});data.points.push(...points.map(p=>({...p,targetId:92})));data.manifest.files.push({path:'daily/92.json',kind:'daily',targetId:92,count:1,sha256:'c'.repeat(64)});let release;const old=new Promise(resolve=>{release=resolve;});const h=harness(undefined,undefined,{},undefined,{initialState:initial(data),readPart:async request=>request.part==='daily/91.json'?old:{items:[sample(start,92)]}});
 try{await h.flush();await openFirstHistory(h);h.all().find(n=>n.type==='Dialog').props.onOpenChange(false);await h.flush();const second=h.all().find(n=>n.type==='Button'&&n.props['aria-label']==='查看合成作者92的历史');second.props.onClick({currentTarget:{isConnected:true,focus(){}}});await h.flush();release({items});await h.flush();assert.equal(h.state('account').id,92);assert.equal(h.state('history').items.length,1);assert.equal(h.state('history').items[0].targetId,92);assert.equal(h.reads[0].signal.aborted,true);assert.match(textOf(dialog(h)),/全部 1 条/);}
 finally{release?.({items});h.close();}
});

test('phase61 full-history export rejects forged account ownership and preserves the fixed-version guard',async()=>{
 const {data,items}=historyFixture(),h=harness(undefined,undefined,{},undefined,{initialState:initial(data),readPart:async()=>({items:items.map((row,index)=>index?row:{...row,targetId:92})})});
 try{await h.flush();await openFirstHistory(h);button(h,'导出全部历史',dialog(h)).props.onClick();await h.flush();assert.equal(h.downloads.length,0);assert.match(textOf(dialog(h)),/归属|编号/);}
 finally{h.close();}
});

test('phase61 personal full-history action is available outside its narrow selected-date view',async()=>{
 const {data,items}=historyFixture(),seen=[],h=harness('components/account-panel.tsx','AccountPanel',{account,manifest:data.manifest,boards:data.boards,request:{id:91,start,end,generation},onReturn(){},onAddress(){},onHistory:(a,trigger)=>seen.push({account:a,trigger})},'https://source-review.invalid/'+atAddress(),{readPart:async()=>({items})});
 try{await h.flush();assert.match(h.text(),/45 个已保存日/);assert.match(h.text(),/3 个保存日/);const trigger={isConnected:true,focus(){}};button(h,'查看全部每日、作品与指标历史').props.onClick({currentTarget:trigger});assert.equal(seen.length,1);assert.equal(seen[0].account.id,91);assert.equal(seen[0].trigger,trigger,'the real history button must be retained for return focus');assert.equal(h.reads[0].generation,generation);}
 finally{h.close();}
});

test('phase61 original author focus survives personal history and restores only a usable original control',async()=>{
 for(const mode of ['connected','disconnected','disabled','hidden']){
  const h=harness(undefined,undefined,{},'https://source-review.invalid/#accounts',{initialState:initial(published())});let focusCalls=0;
  const origin={isConnected:true,disabled:false,focus(){focusCalls++;if(mode!=='hidden')h.document.activeElement=this;}};
  try{await h.flush();h.window.scrollY=1280;h.all().find(n=>n.type==='Button'&&n.props['aria-label']==='查看合成作者91的历史').props.onClick({currentTarget:origin});await h.flush();button(h,'打开独立账号页面',dialog(h)).props.onClick();await h.flush();
   const panel=h.all().find(n=>n.type==='AccountPanel');panel.props.onHistory(account);await h.flush();h.all().find(n=>n.type==='Dialog').props.onOpenChange(false);await h.flush();h.document.activeElement={name:'personal-history-close'};
   if(mode==='disconnected')origin.isConnected=false;if(mode==='disabled')origin.disabled=true;
   panel.props.onReturn();await h.flush();const search=h.all().find(n=>n.type==='Input'&&n.props['aria-label']==='搜索作者').props.ref.current;
   assert.equal(h.window.scrollY,1280);assert.equal(h.document.activeElement,mode==='connected'?origin:search,mode);assert.equal(focusCalls,mode==='disconnected'||mode==='disabled'?0:1,mode);
  }finally{h.close();}
 }
});

test('phase61 a new workspace entry cannot restore a previous author focus from another task context',async()=>{
 const h=harness(undefined,undefined,{},'https://source-review.invalid/#accounts',{initialState:initial(published())});let oldFocus=0;
 try{await h.flush();h.all().find(n=>n.type==='Button'&&n.props['aria-label']==='查看合成作者91的历史').props.onClick({currentTarget:{isConnected:true,disabled:false,focus(){oldFocus++;}}});await h.flush();button(h,'打开独立账号页面',dialog(h)).props.onClick();await h.flush();button(h,'话题观察').props.onClick();await h.flush();h.window.scrollY=690;
  h.all().find(n=>n.type==='CoveragePanel').props.onAccount(account);await h.flush();h.all().find(n=>n.type==='AccountPanel').props.onReturn();await h.flush();assert.equal(h.state('tab'),'topics');assert.equal(h.window.scrollY,690);assert.equal(h.document.activeElement,heading(h));assert.equal(oldFocus,0);
 }finally{h.close();}
});

test('phase61 a temporarily empty activeElement still uses a safe fallback when no author control was captured',async()=>{
 const h=harness(undefined,undefined,{},undefined,{initialState:initial(published())});
 try{await h.flush();h.all().find(n=>n.type==='CoveragePanel').props.onAccount(account);await h.flush();h.document.activeElement=null;
  h.all().find(n=>n.type==='AccountPanel').props.onReturn();await h.flush();assert.equal(h.document.activeElement,heading(h),'return with no origin must not confuse null with already-restored focus');
  h.all().find(n=>n.type==='CoveragePanel').props.onAccount(account);await h.flush();h.all().find(n=>n.type==='AccountPanel').props.onHistory(account);await h.flush();h.document.activeElement=null;let prevented=0;
  dialog(h).props.onCloseAutoFocus({preventDefault(){prevented++;}});assert.equal(prevented,1);assert.equal(h.document.activeElement,heading(h),'personal history close must skip hidden search and reach the visible heading');
 }finally{h.close();}
});

test('phase61 delayed protected-return frame cannot scroll a subsequently reopened account to the workspace offset',async()=>{
 const h=harness(undefined,undefined,{},undefined,{initialState:initial(published())});
 try{await h.flush();h.window.scrollY=2090;h.all().find(n=>n.type==='CoveragePanel').props.onAccount(account);await h.flush();assert.equal(h.window.scrollY,0);
  h.back();h.forward();await h.flush();assert.equal(h.state('personal').id,91);assert.equal(h.window.scrollY,0,'obsolete workspace return callback must not move the new personal view');
 }finally{h.close();}
});

test('phase61 delayed ordinary-navigation frame cannot reset a personal page restored by browser back',async()=>{
 const h=harness(undefined,undefined,{},undefined,{initialState:initial(published())});
 try{await h.flush();h.all().find(n=>n.type==='CoveragePanel').props.onAccount(account);await h.flush();h.window.scrollY=611;
  button(h,'话题观察').props.onClick();h.back();await h.flush();assert.equal(h.state('personal').id,91);assert.equal(h.window.scrollY,611,'obsolete new-workspace callback must leave the restored personal position alone');
 }finally{h.close();}
});

test('phase61 works and per-work metric history paginate, retain the selected work, and export all its rows',async()=>{
 const {data,items}=historyFixture(),works=Array.from({length:41},(_,index)=>({id:500+index,targetId:91,externalId:String(7000000000000000000n+BigInt(index)),caption:'合成作品'+index,url:'https://www.douyin.com/video/'+String(7000000000000000000n+BigInt(index)),publishedAt:'2026-09-12T03:00:00.000Z',firstSeenAt:'2026-09-12T03:00:00.000Z',lastObservedAt:'2026-09-14T03:00:00.000Z',likes:index,comments:0,shares:0,collects:0,plays:null}));
 const metrics=works.flatMap(work=>Array.from({length:3},(_,index)=>({id:work.id*10+index,targetId:91,workId:work.id,externalId:work.externalId,capturedAt:'2026-09-'+(12+index)+'T03:00:00.000Z',likes:index,comments:0,shares:0,collects:0,plays:null})));
 data.manifest.files.push({path:'works/91.json',kind:'works',targetId:91,count:works.length,sha256:'c'.repeat(64)},{path:'work-metrics/91.json',kind:'workMetrics',targetId:91,count:metrics.length,sha256:'d'.repeat(64)});
 const h=harness(undefined,undefined,{},undefined,{initialState:initial(data),readPart:async request=>({items:request.part.startsWith('works/')?works:request.part.startsWith('work-metrics/')?metrics:items})});
 try{await h.flush();await openFirstHistory(h);button(h,'全部保存作品',dialog(h)).props.onClick();await h.flush();assert.match(textOf(dialog(h)),/全部 41 条/);button(h,'下一页',dialog(h)).props.onClick();await h.flush();assert.equal(h.state('hPage'),2);
  button(h,'查看指标历史',dialog(h)).props.onClick();await h.flush();assert.equal(h.state('kind'),'workMetrics');assert.equal(h.state('work'),520);assert.equal(h.state('hPage'),1);assert.match(textOf(dialog(h)),/全部 3 条/);assert.equal(h.reads.at(-1).part,'work-metrics/91.json');assert.equal(h.reads.at(-1).generation,generation);
  button(h,'导出全部历史',dialog(h)).props.onClick();await h.flush();assert.equal(h.downloads.length,1);const csv=await h.downloads[0].blob.text();const lines=csv.replace(/^\uFEFF/,'').trimEnd().split(/\r?\n/);assert.equal(lines.length,4);assert.ok(lines.slice(1).every(line=>line.includes('"520"')));assert.ok(csv.includes('d'.repeat(64)));assert.ok(csv.includes('未经逐条独立核验'));
  button(h,'全部保存作品',dialog(h)).props.onClick();await h.flush();assert.equal(h.state('work'),null);assert.equal(h.state('hPage'),2);assert.match(textOf(dialog(h)),/全部 41 条/);
 }finally{h.close();}
});
