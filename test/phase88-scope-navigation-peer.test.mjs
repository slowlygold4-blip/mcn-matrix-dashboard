// Independent Phase88: actual current Home TSX, unchanged existing hook/DOM
// transport and actual shipped model/navigation/export/return helpers. This is
// offline owner-state regression, not hydrated public Site browser acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import vm from 'node:vm';

const SITE=new URL('../../mcn-public-site/',import.meta.url),requireSite=createRequire(new URL('package.json',SITE));
const oldUrl=new URL('./phase66-workspace-state-peer.test.mjs',import.meta.url),oldHarness=await readFile(oldUrl,'utf8');
const harness=oldHarness.replace(/^import[^\n]*\n/gm,'').replaceAll('import.meta.url',JSON.stringify(oldUrl.href));
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const {home,nodes,textOf,button,fixture,asOf,six}=await new AsyncFunction('test','assert','readFile','createRequire','vm',harness+'\nreturn {home,nodes,textOf,button,fixture,asOf,six};')(()=>{},assert,readFile,createRequire,vm);
const nav=await import(new URL('lib/replica-navigation.mjs',SITE)),model=await import(new URL('lib/replica-model.mjs',SITE)),exporter=await import(new URL('lib/replica-export.mjs',SITE));
const SHA=createHash('sha256').update(await readFile(new URL('app/page.tsx',SITE))).digest('hex');console.info('PHASE88_ACTUAL_HOME_SHA256 '+SHA);
const deep=x=>JSON.parse(JSON.stringify(x));
const scope={...six,tag:'slice'},list={sort:'label',order:'asc',query:'作者',rosterStatus:'all'},comparison={compare:true,otherStart:'2026-09-12',otherEnd:'2026-09-30'};
async function workspace({mixed=false,duplicates=false}={}){
 const h=home();await h.flush();const f=fixture();f.accounts=f.accounts.map(a=>({...a,label:duplicates&&a.id<=2?'同名账号':a.label,classification:{theme:{key:mixed&&a.id>12?'other':'peer',label:mixed&&a.id>12?'来源另一主题':'来源确认主题'},labels:[{key:mixed&&a.id%2===0?'original':'slice',label:mixed&&a.id%2===0?'原创':'切片'}]}}));
 h.set('data',f);await h.flush();const path=nav.workspaceSelectionPath('/','accounts',scope,list,comparison);h.window.history.replaceState(null,'',path);h.go(path);await h.flush();return h;
}
const input=h=>h.all().find(n=>n.type==='Input'&&n.props['aria-label']==='搜索作者');
const period=h=>h.all().find(n=>n.type==='select'&&nodes(n).some(n=>n.type==='option'&&n.props.value==='week'));
const activeScope=h=>h.all().find(n=>n.props['aria-label']==='当前生效范围');
const action=(h,name)=>{const n=h.all().find(n=>n.type==='Button'&&n.props['aria-label']===name);assert.ok(n,'actual action not found '+name);return n;};
const themeAction=h=>action(h,'清除大主题筛选，保留其他条件'),tagAction=h=>action(h,'清除内容分类筛选，保留其他条件');
const snapshot=h=>({board:h.state('board'),theme:h.state('theme'),tag:h.state('tag'),start:h.state('start'),end:h.state('end'),sort:h.state('sort'),order:h.state('order'),query:h.state('query'),rosterStatus:h.state('rosterStatus'),periodDraft:h.state('periodDraft'),comparison:deep(h.state('comparison')),advancedOpen:h.state('advancedOpen'),page:h.state('page'),url:h.window.location.href});
async function click(h,n,target){n.props.onClick({currentTarget:target,button:0,preventDefault(){},stopPropagation(){}});await h.flush();}
const row=(h,id)=>{const found=h.all().find(n=>n.type==='TableRow'&&n.key===id);assert.ok(found,'actual row missing '+id);return found;};
const rowAction=(h,id,name)=>{const n=nodes(row(h,id)).find(n=>n.type==='Button'&&textOf(n)===name);assert.ok(n,'actual row action missing '+name);return n;};
const author=(h,id)=>{const n=nodes(row(h,id)).find(n=>n.type==='Button'&&n.props.className==='author');assert.ok(n);return n;};
const focusTarget=h=>({isConnected:true,disabled:false,focus(){h.document.activeElement=this;}});
const personal=h=>h.all().find(n=>n.type==='AccountPanel');
async function exported(h){button(h,'导出全部结果').props.onClick();return new Uint8Array(await h.downloads.at(-1).blob.arrayBuffer());}

for(const dimension of ['theme','tag'])test(`phase88 actual Home: clear ${dimension} alone preserves board/appliedA-B/date/draft/search/status/sort and returns keyboard focus to remaining scope`,async()=>{
 const h=await workspace({mixed:true});try{
  period(h).props.onChange({target:{value:'week'}});const advanced=h.all().find(n=>n.type==='details'&&n.props.className==='advanced-scope');advanced.props.onToggle({currentTarget:{open:true}});
  input(h).props.onChange({target:{value:'作者'}});await h.flush();const before=snapshot(h),data=deep(h.state('data')),focus=activeScope(h).props.ref.current,control=dimension==='theme'?themeAction(h):tagAction(h);
  assert.equal(control.props.type,'button');await click(h,control,focusTarget(h));const after=snapshot(h);
  assert.equal(after[dimension],'all');assert.equal(after[dimension==='theme'?'tag':'theme'],before[dimension==='theme'?'tag':'theme']);
  for(const key of ['board','start','end','sort','order','query','rosterStatus','periodDraft','advancedOpen'])assert.equal(after[key],before[key],key+' must not be implicitly reset');assert.deepEqual(after.comparison,before.comparison);assert.equal(after.page,1);
  assert.deepEqual(nav.workspaceSelection(h.window.location.search),{...scope,[dimension]:'all'});assert.deepEqual(nav.workspaceListSelection(h.window.location.search),list);assert.deepEqual(nav.workspaceComparisonSelection(h.window.location.search),comparison);assert.equal(h.document.activeElement,focus);assert.equal(activeScope(h).props.tabIndex,-1);
  assert.equal(h.all().some(n=>n.props['aria-label']===(dimension==='theme'?'清除大主题筛选，保留其他条件':'清除内容分类筛选，保留其他条件')),false,'removed dimension cannot remain a dead action');
  assert.ok(h.all().some(n=>n.props.className==='period-pending'&&textOf(n).includes('近7天净变')),'unapplied week remains pending');assert.deepEqual(h.state('data'),data);assert.equal(h.network.length,0);
  const expectedAccounts=data.accounts.filter(a=>a.boardKeys.includes('peer')&&(dimension==='theme'?a.classification.labels.some(x=>x.key==='slice'):a.classification.theme.key==='peer'));
  const expectedRows=model.orderRows(model.rowsFor(expectedAccounts,data.points,six.start,six.end),list.sort,list.order);
  assert.deepEqual(await exported(h),new TextEncoder().encode(model.csv(exporter.accountExport(expectedRows,data.manifest,six.start,six.end))),'CSV expands only cleared dimension and retains exact observed endpoint bytes');
  assert.deepEqual(deep(h.all().find(n=>n.type==='MetricLedger').props.metrics),deep(model.aggregate(expectedRows.filter(a=>a.enabled))));
 }finally{h.close();}
});

test('phase88 actual Home: clearing both dimensions removes both actions and does not clear the matrix or date comparison',async()=>{
 const h=await workspace({mixed:true});try{
  await click(h,tagAction(h),focusTarget(h));assert.equal(h.state('theme'),'peer');await click(h,themeAction(h),focusTarget(h));
  assert.deepEqual(nav.workspaceSelection(h.window.location.search),{...scope,theme:'all',tag:'all'});assert.deepEqual(nav.workspaceComparisonSelection(h.window.location.search),comparison);assert.equal(h.state('board'),'peer');
  const names=h.all().filter(n=>n.type==='Button').map(n=>n.props['aria-label']);assert.equal(names.includes('清除大主题筛选，保留其他条件'),false);assert.equal(names.includes('清除内容分类筛选，保留其他条件'),false);assert.ok(textOf(activeScope(h)).includes('全部主题'));assert.ok(textOf(activeScope(h)).includes('全部分类'));assert.equal(h.network.length,0);
 }finally{h.close();}
});

test('phase88 actual Home: invalid draft dates remain invalid after scope clear, no old statistic or network reads are relabelled as the new range',async()=>{
 const h=await workspace({mixed:true});try{
  h.set('start','2026-10-02');await h.flush();const before=snapshot(h),data=deep(h.state('data'));await click(h,tagAction(h),focusTarget(h));
  assert.equal(h.state('start'),before.start);assert.equal(h.state('end'),before.end);assert.deepEqual(deep(h.state('comparison')),before.comparison);assert.equal(h.state('tag'),'all');
  const hidden=h.all().find(n=>n.type==='div'&&n.props.hidden===true&&nodes(n).some(child=>child.type==='MetricLedger'));assert.ok(hidden,'invalid-date metrics stay hidden');assert.ok(textOf(activeScope(h)).includes('待核对，尚未应用'));assert.deepEqual(h.state('data'),data);assert.equal(h.network.length,0);
 }finally{h.close();}
});

test('phase88 actual Home: author-name primary entry and explicit operating detail select the same stable account/pinnedA-B, not history',async()=>{
 for(const intent of ['name','explicit']){const h=await workspace({duplicates:true});try{
  input(h).props.onChange({target:{value:'同名'}});await h.flush();const target=focusTarget(h),n=intent==='name'?author(h,2):rowAction(h,2,'经营详情');assert.equal(n.props.type,'button');assert.equal(n.props['aria-label'],'查看同名账号的经营详情');await click(h,n,target);
  assert.equal(personal(h).props.account.id,2);assert.equal(personal(h).props.request.generation,asOf);assert.deepEqual({start:personal(h).props.request.start,end:personal(h).props.request.end},{start:six.start,end:six.end});assert.deepEqual(deep(personal(h).props.request.comparison),comparison);assert.equal(h.state('account'),null);assert.equal(h.network.length,0);
 }finally{h.close();}}
});

test('phase88 actual Home: author-name page2 roundtrip preserves full CSV/cohort/list/A-B/scroll and exact triggering focus',async()=>{
 const h=await workspace();try{
  // This controller test intentionally does not mount child React components.
  // Drive the real Pager callback rather than searching its unrendered buttons;
  // the separate phase90/phase119 browser suites cover the actual button UI.
  const pager=h.all().find(n=>n.type?.name==='Pager'&&Number.isSafeInteger(n.props?.count));assert.ok(pager);assert.ok(pager.props.count>20,'fixture must contain a second page');pager.props.change(2);await h.flush();assert.equal(h.state('page'),2);h.window.scrollY=684;const before=snapshot(h),metrics=deep(h.all().find(n=>n.type==='MetricLedger').props.metrics),csv=await exported(h),target=focusTarget(h);
  await click(h,author(h,21),target);assert.equal(personal(h).props.account.id,21);assert.equal(h.window.scrollY,0);personal(h).props.onReturn();await h.flush();
  assert.deepEqual(snapshot(h),before);assert.equal(h.window.scrollY,684);assert.equal(h.document.activeElement,target);assert.deepEqual(deep(h.all().find(n=>n.type==='MetricLedger').props.metrics),metrics);assert.deepEqual(await exported(h),csv);assert.equal(h.network.length,0);
 }finally{h.close();}
});

test('phase88 actual Home: author-name browser Back retains page2 and does not restore a stale history focus',async()=>{
 const h=await workspace();try{
  const pager=h.all().find(n=>n.type?.name==='Pager'&&Number.isSafeInteger(n.props?.count));assert.ok(pager);assert.ok(pager.props.count>20,'fixture must contain a second page');pager.props.change(2);await h.flush();assert.equal(h.state('page'),2);h.window.scrollY=490;const before=snapshot(h),target=focusTarget(h);await click(h,author(h,22),target);h.back();await h.flush();
  assert.deepEqual(snapshot(h),before);assert.equal(h.window.scrollY,490);assert.equal(h.document.activeElement,target);assert.equal(h.network.length,0);
 }finally{h.close();}
});

test('phase88 actual Home: explicit history remains direct/independent with exact ID, unchanged address and original close-focus restoration',async()=>{
 const h=await workspace({duplicates:true});try{
  input(h).props.onChange({target:{value:'同名'}});await h.flush();const before=snapshot(h),target=focusTarget(h);await click(h,rowAction(h,2,'历史'),target);
  assert.equal(h.state('account').id,2);assert.equal(h.state('personal'),null);assert.equal(h.state('kind'),'daily');assert.deepEqual(snapshot(h),before);
  const content=h.all().find(n=>n.type==='DialogContent');let prevented=false;content.props.onCloseAutoFocus({preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(h.document.activeElement,target);assert.equal(h.network.length,0);
 }finally{h.close();}
});

test('phase88 actual Home: coverage account callback now matches operating-detail wording while preserving fixed source identity',async()=>{
 const h=await workspace();try{
  const callback=h.all().find(n=>n.type==='CoveragePanel').props.onAccount;callback(h.state('data').accounts[4]);await h.flush();assert.equal(personal(h).props.account.id,5);assert.equal(personal(h).props.request.generation,asOf);assert.equal(h.state('account'),null);assert.equal(h.network.length,0);
 }finally{h.close();}
});

test('phase88 actual Home: keyboard-activation author owner moves focus to the visible detail heading after entry',async()=>{
 const h=await workspace();try{
  const target=focusTarget(h);h.document.activeElement=target;author(h,1).props.onClick({currentTarget:target,detail:0,button:0});await h.flush();
  const heading=h.all().find(n=>n.type==='h1');assert.equal(textOf(heading),'账号经营详情');assert.equal(heading.props.tabIndex,-1);assert.equal(h.document.activeElement,heading.props.ref.current);assert.notEqual(h.document.activeElement,target);assert.equal(personal(h).props.account.id,1);assert.equal(h.network.length,0);
 }finally{h.close();}
});

test('phase88 actual Home: queued scope-clear frame followed immediately by detail entry cannot steal focus back to hidden scope',async()=>{
 const h=await workspace();try{
  const scopeTarget=activeScope(h).props.ref.current,heading=h.all().find(n=>n.type==='h1').props.ref.current,target=focusTarget(h);let scopeFocusCalls=0;const oldScopeFocus=scopeTarget.focus;scopeTarget.focus=function(options){scopeFocusCalls++;oldScopeFocus.call(this,options);};
  themeAction(h).props.onClick();author(h,1).props.onClick({currentTarget:target,detail:0,button:0});await h.flush();
  assert.equal(h.state('theme'),'all');assert.equal(personal(h).props.account.id,1);assert.equal(scopeFocusCalls,0,'obsolete clear frame must be epoch-rejected, not merely ignored by a browser hidden-element focus rule');assert.equal(h.document.activeElement,heading);assert.equal(h.network.length,0);
 }finally{h.close();}
});

test('phase88 actual Home: queued detail-entry frame cannot steal focus after immediate browser Back or another workspace navigation',async()=>{
 for(const destination of ['back','overview']){const h=await workspace();try{
  const heading=h.all().find(n=>n.type==='h1').props.ref.current,oldHeadingFocus=heading.focus;let headingCalls=0;heading.focus=function(options){headingCalls++;oldHeadingFocus.call(this,options);};
  const before=snapshot(h),target=focusTarget(h);h.window.scrollY=456;author(h,1).props.onClick({currentTarget:target,detail:0,button:0});
  if(destination==='back')h.back();else button(h,'经营总览').props.onClick();await h.flush();
  assert.equal(h.state('personal'),null);assert.equal(h.network.length,0);
  if(destination==='back'){assert.deepEqual(snapshot(h),before);assert.equal(h.window.scrollY,456);assert.equal(h.document.activeElement,target);assert.equal(headingCalls,0,'obsolete personal frame must not steal returned author focus');}
  else{assert.equal(h.state('tab'),'overview');assert.equal(h.document.activeElement,heading);assert.equal(headingCalls,1,'only the latest workspace navigation may focus its heading');}
 }finally{h.close();}}
});
