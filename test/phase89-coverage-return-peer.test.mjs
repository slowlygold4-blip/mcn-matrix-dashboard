// Actual Home + actual CoveragePanel, with unchanged Phase88/66 transport.
// Local synthetic events only: no browser, platform requests or accepted data injection.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import vm from 'node:vm';

const SITE=new URL('../../mcn-public-site/',import.meta.url);
const priorUrl=new URL('./phase88-scope-navigation-peer.test.mjs',import.meta.url);
const prior=await readFile(priorUrl,'utf8');
// Do not register or repeat the prior assertions; only reuse its existing transport.
const body=prior.replace(/^import[^\n]*\n/gm,'').replaceAll(',import.meta.url)',','+JSON.stringify(priorUrl.href)+')');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const {workspace,focusTarget,personal,author,click,input,snapshot,nodes,button,exported,asOf,comparison}=await new AsyncFunction('test','assert','readFile','createRequire','createHash','vm',body+'\nreturn {workspace,focusTarget,personal,author,click,input,snapshot,nodes,button,exported,asOf,comparison};')(()=>{},assert,readFile,createRequire,createHash,vm);
const requireSite=createRequire(new URL('package.json',SITE)),ts=requireSite('typescript');
const coverage=await import(new URL('lib/replica-coverage.mjs',SITE));
const source=await readFile(new URL('components/coverage-panel.tsx',SITE),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const jsx=(type,props,key)=>({type,props,key}),actual={};
vm.runInNewContext(compiled,{exports:actual,require(spec){
 if(spec==='react')return {useState:()=>[null,()=>{}],useEffect:()=>{}};
 if(spec==='react/jsx-runtime')return {jsx,jsxs:jsx};
 if(spec==='@/components/ui/button')return {Button:'Button'};
 if(spec==='@/lib/replica-coverage.mjs')return coverage;
 throw Error('unexpected actual CoveragePanel dependency '+spec);
}});
console.info('PHASE89_COVERAGE_SHA256 '+createHash('sha256').update(source).digest('hex'));
const deep=x=>JSON.parse(JSON.stringify(x));
function coverageAction(h,index=0){
 const props=h.all().find(n=>n.type==='CoveragePanel').props;
 return nodes(actual.CoveragePanel(props)).filter(n=>n.type==='Button'&&n.props.className==='coverage-account')[index];
}

test('phase89 negative control: existing account-table owner already returns to exact trigger',async()=>{
 const h=await workspace();try{const target=focusTarget(h);await click(h,author(h,1),target);personal(h).props.onReturn();await h.flush();assert.equal(h.document.activeElement,target);assert.equal(h.network.length,0);}finally{h.close();}
});

for(const exit of ['return-button','browser-back'])test(`phase89 actual coverage ${exit}: exact source trigger restored; page2/scope/A-B/generation/URL/CSV immutable`,async()=>{
 const h=await workspace();try{
  await click(h,button(h,'下一页'),focusTarget(h));h.set('periodDraft','week');await h.flush();
  h.window.scrollY=500;const target=focusTarget(h);target.focus();
  const before=snapshot(h),data=deep(h.state('data')),csv=await exported(h),metrics=deep(h.all().find(n=>n.type==='MetricLedger').props.metrics);
  await click(h,coverageAction(h,3),target);
  assert.equal(personal(h).props.account.id,4);assert.equal(personal(h).props.request.generation,asOf);
  assert.deepEqual(deep(personal(h).props.request.comparison),comparison);assert.equal(h.state('account'),null);
  if(exit==='return-button')personal(h).props.onReturn();else h.back();await h.flush();
  assert.deepEqual(snapshot(h),before);assert.equal(h.window.scrollY,500);assert.deepEqual(h.state('data'),data);
  assert.deepEqual(await exported(h),csv);assert.deepEqual(deep(h.all().find(n=>n.type==='MetricLedger').props.metrics),metrics);
  assert.equal(h.network.length,0);assert.equal(h.document.activeElement,target,'coverage source trigger must survive the complete actual owner roundtrip');
 }finally{h.close();}
});

for(const state of ['disconnected','disabled'])test(`phase89 actual coverage ${state} trigger safely falls back to search on return`,async()=>{
 const h=await workspace();try{const target=focusTarget(h);await click(h,coverageAction(h),target);if(state==='disconnected')target.isConnected=false;else target.disabled=true;
  personal(h).props.onReturn();await h.flush();assert.equal(h.document.activeElement,input(h).props.ref.current);assert.notEqual(h.document.activeElement,target);assert.equal(h.network.length,0);
 }finally{h.close();}
});

test('phase89 actual coverage overview disconnected trigger falls back to heading, not a hidden search',async()=>{
 const h=await workspace();try{h.go(h.window.location.pathname+h.window.location.search+'#overview');await h.flush();const target=focusTarget(h);await click(h,coverageAction(h),target);target.isConnected=false;
  personal(h).props.onReturn();await h.flush();assert.equal(h.state('tab'),'overview');assert.equal(h.document.activeElement,h.all().find(n=>n.type==='h1').props.ref.current);assert.equal(h.network.length,0);
 }finally{h.close();}
});
