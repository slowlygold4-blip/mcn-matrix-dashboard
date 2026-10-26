// Independent Phase75: executes the actual current Home TSX and shipped helpers.
// Reuses an existing offline hook/DOM transport, not an invented navigation owner.
// Also renders the actual Button with real React/ReactDOMServer. NOT browser
// keyboard/layout acceptance, production data, network, cloud capture or retention.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';

const SITE=new URL('../../mcn-public-site/',import.meta.url),requireSite=createRequire(new URL('package.json',SITE));
const nav=await import(new URL('lib/replica-navigation.mjs',SITE));
const returns=await import(new URL('lib/replica-return.mjs',SITE));
const account=await import(new URL('lib/replica-account.mjs',SITE));
const oldUrl=new URL('./phase66-workspace-state-peer.test.mjs',import.meta.url);
const oldHarness=await readFile(oldUrl,'utf8');
const harnessCode=oldHarness.replace(/^import[^\n]*\n/gm,'').replaceAll('import.meta.url',JSON.stringify(oldUrl.href));
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
// Skip registration of the old tests only. Its unchanged helper compiles actual
// app/page.tsx; actual navigation/model/return modules are still loaded by it.
const {home,nodes,textOf,button,fixture,ts,asOf,six}=await new AsyncFunction('test','assert','readFile','createRequire','vm',harnessCode+'\nreturn {home,nodes,textOf,button,fixture,ts,asOf,six};')(()=>{},assert,readFile,createRequire,vm);
const A={start:six.start,end:six.end},B={compare:true,otherStart:'2026-09-12',otherEnd:'2026-09-30'};
const defaults={sort:'followers.delta',order:'desc',query:'',rosterStatus:'enabled'};
const scope={...six,tag:'slice'};
const list={sort:'label',order:'asc',query:'作者',rosterStatus:'all'};
const deep=v=>JSON.parse(JSON.stringify(v));

async function workspace({duplicates=false,comparison=B,query=list.query}={}){
 const h=home();await h.flush();const f=fixture();
 f.accounts=f.accounts.map(a=>({...a,label:duplicates&&a.id<=2?'同名账号':a.label,classification:{...a.classification,labels:[{key:'slice',label:'切片'}]}}));
 h.set('data',f);await h.flush();
 const path=nav.workspaceSelectionPath('/','accounts',scope,{...list,query},comparison);
 // Existing h.go models popstate by changing location only. Align its initial
 // history entry to the fixture's real current address BEFORE owner navigation;
 // otherwise browser Back wrongly returns to the old unfiltered setup URL.
 h.window.history.replaceState(null,'',path);h.go(path);await h.flush();return h;
}
const rows=h=>h.all().filter(n=>n.type==='TableRow'&&typeof n.key==='number');
function row(h,id){const found=rows(h).find(n=>n.key===id);assert.ok(found,'actual account row missing '+id);return found;}
function entry(h,id,intent){
 const candidates=nodes(row(h,id)).filter(n=>n.type==='Button');
 const found=candidates.find(n=>textOf(n)===intent||String(n.props['aria-label']||'').includes(intent));
 assert.ok(found,'actual '+intent+' entry missing for ID '+id);return found;
}
function focusTarget(h,{connected=true,disabled=false}={}){return {isConnected:connected,disabled,focus(){h.document.activeElement=this;}};}
async function click(h,element,target=focusTarget(h)){
 assert.notEqual(element.props.disabled,true);assert.equal(typeof element.props.onClick,'function');
 element.props.onClick({currentTarget:target,button:0,preventDefault(){},stopPropagation(){}});await h.flush();return target;
}
const personal=h=>h.all().find(n=>n.type==='AccountPanel');
const snapshot=h=>({scope:nav.workspaceSelection(h.window.location.search),list:nav.workspaceListSelection(h.window.location.search),comparison:nav.workspaceComparisonSelection(h.window.location.search),page:h.state('page'),url:h.window.location.href});

test('phase75 actual helpers retain A/B, theme/classification and search/sort without smuggling return redirects',()=>{
 const path=nav.workspaceSelectionPath('/dashboard','accounts',scope,list,B),u=new URL(path,'https://phase75.invalid');
 const captured=returns.captureWorkspaceReturn({pathname:u.pathname,search:u.search+'&redirect=https%3A%2F%2Fforeign.invalid',hash:u.hash,generation:asOf});
 assert.equal(captured.path,path);assert.ok(Object.isFrozen(captured));assert.equal(returns.workspaceReturnPath(captured,{pathname:u.pathname,generation:asOf}),path);
 assert.deepEqual(nav.workspaceSelection(u.search),scope);assert.deepEqual(nav.workspaceListSelection(u.search),list);assert.deepEqual(nav.workspaceComparisonSelection(u.search),B);
 assert.equal(returns.workspaceReturnPath(captured,{pathname:'/different',generation:asOf}),null);
 assert.equal(returns.workspaceReturnPath(captured,{pathname:u.pathname,generation:'2026-10-01T06:00:00.000Z'}),null);
 for(const bad of [{...captured,path:'//foreign.invalid'}, {...captured,path:'/?account=1'}, {...captured,redirect:'/'}])assert.equal(returns.workspaceReturnPath(bad,{pathname:u.pathname,generation:asOf}),null);
});

test('phase75 canonical helper intentionally has no shared page or user-return field; legacy list shape stays exact',()=>{
 const p=nav.workspaceSelectionPath('/','accounts',scope,list,B),u=new URL(p,'https://phase75.invalid');
 assert.deepEqual(Object.keys(nav.workspaceListSelection(u.search)).sort(),['order','query','rosterStatus','sort']);
 assert.equal(u.searchParams.has('page'),false);assert.equal(u.searchParams.has('return'),false);
 assert.equal(nav.workspacePath('/','accounts','?page=2&return=https%3A%2F%2Fforeign.invalid'),'/#accounts');
 assert.deepEqual(nav.workspaceListSelection(''),defaults);
});

test('phase75 same-name actual row detail entries bind stable IDs and pinned publication, never label lookup',async()=>{
 for(const id of [1,2]){const h=await workspace({duplicates:true,query:'同名'});try{
  const before=deep(h.state('data'));await click(h,entry(h,id,'经营详情'));
  const p=personal(h);assert.ok(p);assert.equal(p.props.account.id,id);assert.equal(p.props.account.label,'同名账号');assert.equal(p.props.request.id,id);assert.equal(p.props.request.generation,asOf);assert.equal(p.props.manifest.asOf,asOf);
  assert.deepEqual({start:p.props.request.start,end:p.props.request.end},A);assert.equal(h.state('account'),null,'detail must not first open history dialog');
  assert.equal(new URLSearchParams(h.window.location.search).has('query'),false);assert.deepEqual(h.state('data'),before);assert.equal(h.network.length,0);
 }finally{h.close();}}
});

test('phase75 actual history entry preserves direct history intent and stable account without changing address',async()=>{
 const h=await workspace({duplicates:true,query:'同名'});try{
  const before=h.window.location.href,target=await click(h,entry(h,2,'历史'));
  assert.equal(h.state('account').id,2);assert.equal(h.state('kind'),'daily');assert.equal(h.state('personal'),null);assert.equal(h.window.location.href,before);
  const content=h.all().find(n=>n.type==='DialogContent');assert.ok(content);let prevented=false;content.props.onCloseAutoFocus({preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(h.document.activeElement,target);assert.equal(h.network.length,0);
 }finally{h.close();}
});

test('phase75 actual direct detail roundtrip preserves page2 scope/list/A-B/scroll and focuses its own triggering button',async()=>{
 const h=await workspace();try{
  await click(h,button(h,'下一页'));assert.equal(h.state('page'),2);h.window.scrollY=735;
  const before=snapshot(h),oldHistoryTarget=focusTarget(h);await click(h,entry(h,21,'历史'),oldHistoryTarget);
  const dialog=h.all().find(n=>n.type==='Dialog');dialog.props.onOpenChange(false);await h.flush();
  const target=await click(h,entry(h,21,'经营详情'));assert.equal(personal(h).props.account.id,21);assert.equal(h.window.scrollY,0);
  assert.equal(typeof personal(h).props.onReturn,'function');personal(h).props.onReturn();await h.flush();
  assert.deepEqual(snapshot(h),before);assert.equal(h.window.scrollY,735);assert.equal(h.document.activeElement,target);assert.notEqual(h.document.activeElement,oldHistoryTarget);assert.equal(h.network.length,0);
 }finally{h.close();}
});

test('phase75 actual disconnected detail target returns to safe visible fallback, not removed or stale history control',async()=>{
 const h=await workspace();try{
  const target=focusTarget(h);await click(h,entry(h,1,'经营详情'),target);target.isConnected=false;
  personal(h).props.onReturn();await h.flush();assert.notEqual(h.document.activeElement,target);assert.ok(h.document.activeElement?.isConnected);assert.equal(h.state('personal'),null);assert.equal(h.network.length,0);
 }finally{h.close();}
});

test('phase75 actual browser-back owner callback keeps page2 and both date ranges without a stale history focus',async()=>{
 const h=await workspace();try{
  await click(h,button(h,'下一页'));h.window.scrollY=456;const before=snapshot(h);
  const target=await click(h,entry(h,22,'经营详情'));assert.equal(personal(h).props.request.id,22);
  h.back();await h.flush();assert.deepEqual(snapshot(h),before);assert.equal(h.window.scrollY,456);assert.equal(h.document.activeElement,target);assert.equal(h.network.length,0);
 }finally{h.close();}
});

test('phase75 actual detail roundtrip leaves operating cards and full-results CSV unchanged, not just visible twenty rows',async()=>{
 const h=await workspace();try{
  const beforeMetrics=deep(h.all().find(n=>n.type==='MetricLedger').props.metrics);
  await click(h,button(h,'导出全部结果'));const beforeCsv=await h.downloads.at(-1).blob.text();assert.equal(beforeCsv.trimEnd().split(/\r?\n/).length,26);
  await click(h,entry(h,1,'经营详情'));personal(h).props.onReturn();await h.flush();
  assert.deepEqual(deep(h.all().find(n=>n.type==='MetricLedger').props.metrics),beforeMetrics);
  await click(h,button(h,'导出全部结果'));assert.equal(await h.downloads.at(-1).blob.text(),beforeCsv);assert.equal(h.network.length,0);
 }finally{h.close();}
});

test('phase75 actual direct paused account detail pins identity/version but does not invent enabled-account A dates',async()=>{
 const h=await workspace();try{
  await click(h,button(h,'下一页'));await click(h,entry(h,23,'经营详情'));const p=personal(h);assert.equal(p.props.account.id,23);assert.equal(p.props.account.enabled,false);assert.equal(p.props.request.generation,asOf);
  assert.equal(p.props.request.start,null);assert.equal(p.props.request.end,null);assert.equal(h.state('account'),null);assert.equal(h.network.length,0);
 }finally{h.close();}
});

test('phase75 actual malformed account identity and B fail closed before owner can read another publication',async()=>{
 for(const query of ['?account=01','?account=1&account=2','?account=1&generation=not-date','?account=1&compareStart=2026-09-12']){
  const h=home('https://phase75.invalid/'+query);try{await h.flush();assert.ok(h.state('linkError'));assert.equal(h.state('personal'),null);assert.equal(h.network.length,0);assert.equal(h.state('loading'),false);}finally{h.close();}
 }
});

test('phase75 actual personal URL update cannot swap stable identity or pinned version',async()=>{
 const h=await workspace();try{
  await click(h,entry(h,1,'经营详情'));const update=personal(h).props.onAddress;
  assert.throws(()=>update(account.accountShareQuery({id:2,...A,generation:asOf})),/身份|版本/);
  assert.throws(()=>update(account.accountShareQuery({id:1,...A,generation:'2026-10-01T06:00:00.000Z'})),/身份|版本/);
  assert.equal(personal(h).props.account.id,1);assert.equal(h.state('personal').generation,asOf);assert.equal(h.network.length,0);
 }finally{h.close();}
});

const compile=s=>ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const utils={},actualButtons={},realReact=requireSite('react'),renderToStaticMarkup=requireSite('react-dom/server').renderToStaticMarkup;
vm.runInNewContext(compile(await readFile(new URL('lib/utils.ts',SITE),'utf8')),{exports:utils,require:requireSite},{filename:'phase75-actual-utils.cjs'});
vm.runInNewContext(compile(await readFile(new URL('components/ui/button.tsx',SITE),'utf8')),{exports:actualButtons,require(spec){return spec==='@/lib/utils'?utils:requireSite(spec);}},{filename:'phase75-actual-native-button.cjs'});
test('phase75 actual row entry props render with real React as named native buttons, not role-only clickable spans',async()=>{
 const h=await workspace();try{
  for(const intent of ['经营详情','历史']){const n=entry(h,1,intent),markup=renderToStaticMarkup(realReact.createElement(actualButtons.Button,{...n.props,children:textOf(n)}));
   assert.match(markup,/^<button\b/);assert.match(markup,/data-slot="button"/);assert.ok(markup.includes(intent));assert.doesNotMatch(markup,/tabindex="-1"/i);assert.doesNotMatch(markup,/aria-hidden="true"/i);
   assert.notEqual(n.props.disabled,true);assert.notEqual(n.props.asChild,true);assert.equal(typeof n.props.onClick,'function');
  }
 }finally{h.close();}
});
