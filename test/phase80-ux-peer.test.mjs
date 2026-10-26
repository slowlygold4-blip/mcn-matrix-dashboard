// Phase80 independent review: execute current Home, actual Input/Button, current
// source CSS. Browser is fresh/offline/about:blank; no server or platform reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {chromium} from 'playwright-core';

const SITE=new URL('../../mcn-public-site/',import.meta.url),requireSite=createRequire(new URL('package.json',SITE));
const oldUrl=new URL('./phase66-workspace-state-peer.test.mjs',import.meta.url),oldHarness=await readFile(oldUrl,'utf8');
const code=oldHarness.replace(/^import[^\n]*\n/gm,'').replaceAll('import.meta.url',JSON.stringify(oldUrl.href));
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const {home,nodes,textOf,button,fixture,ts,six}=await new AsyncFunction('test','assert','readFile','createRequire','vm',code+'\nreturn {home,nodes,textOf,button,fixture,ts,six};')(()=>{},assert,readFile,createRequire,vm);
const react=requireSite('react'),render=requireSite('react-dom/server').renderToStaticMarkup;
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const modules=new Map();
async function loadActual(path){
 const exports={};
 vm.runInNewContext(compile(await readFile(new URL(path,SITE),'utf8')),{exports,require(spec){if(spec==='@/lib/utils')return modules.get('utils');return requireSite(spec);}},{filename:'phase80-actual-'+path});
 return exports;
}
modules.set('utils',await loadActual('lib/utils.ts'));
const input=await loadActual('components/ui/input.tsx'),buttons=await loadActual('components/ui/button.tsx');
const globals=await readFile(new URL('app/globals.css',SITE),'utf8'),replica=await readFile(new URL('app/replica.css',SITE),'utf8');
const postcss=requireSite('postcss'),tailwind=requireSite('@tailwindcss/postcss');
const model=await import(new URL('lib/replica-model.mjs',SITE)),exporter=await import(new URL('lib/replica-export.mjs',SITE));
const compiledCss=(await postcss([tailwind({base:SITE.pathname})]).process(globals,{from:new URL('app/globals.css',SITE).pathname})).css+'\n'+replica;
const candidate=process.env.PHASE80_UX_CANDIDATE==='1';
// Review-only proposed CSS. Never written into production. Default run uses no
// candidate at all and must detect the actual shipped regression.
const candidateCss=`@media(max-width:760px){
 .account-ledger .panel-head>.search{flex:1 1 100%;width:100%;max-width:none;min-height:44px;}
}`;
const sha=x=>createHash('sha256').update(x).digest('hex');
console.info(JSON.stringify({phase80ActualHomeSha256:sha(await readFile(new URL('app/page.tsx',SITE))),replicaCssSha256:sha(replica),candidateOnly:candidate}));

function actualToolbar(h){
 const ledger=h.all().find(n=>n.props.className==='account-ledger');
 assert.ok(ledger,'actual Home account ledger exists');
 const toolbar=nodes(ledger).find(n=>n.props.className==='panel-head');
 assert.ok(toolbar);return toolbar;
}
function actualElement(node,key='root'){
 if(node==null||typeof node==='boolean'||typeof node==='string'||typeof node==='number')return node;
 if(Array.isArray(node))return node.map((child,index)=>actualElement(child,key+'-'+index));
 const {children,ref,...props}=node.props||{};
 const type=node.type==='Input'?input.Input:node.type==='Button'?buttons.Button:node.type==='Fragment'?react.Fragment:node.type;
 return react.createElement(type,{...props,key:node.key??key},...(children===undefined?[]:[actualElement(children,key+'-child')]));
}
function toolbarShell(h){
 const target=actualToolbar(h),root=h.all()[0];
 function retain(node){
  if(node===target)return node;
  if(!node||typeof node!=='object')return null;
  if(Array.isArray(node)){const children=node.map(retain).filter(Boolean);return children.length?children:null;}
  const children=retain(node.props?.children);if(!children)return null;
  // Preserve the actual workspace's two grid tracks. All other ancestors and
  // classes come directly from executed Home; no substitute toolbar is built.
  const kept=node.props?.className==='workspace'?[{type:'aside',props:{className:'sidebar'}},children]:children;
  return {...node,props:{...node.props,children:kept}};
 }
 const tree=retain(root);assert.ok(tree);return render(actualElement(tree));
}
const deep=x=>JSON.parse(JSON.stringify(x));
const search=h=>h.all().find(n=>n.type==='Input'&&n.props['aria-label']==='搜索作者');

test('phase80 actual Home search keeps applied A/B, stable metrics, URL and exact export scope',async()=>{
 const h=home();try{
  await h.flush();const f=fixture();f.accounts[0].label='糯米团子🍡';h.set('data',f);await h.flush();
  const growth=h.all().find(n=>n.type==='GrowthPanel');growth.props.onComparison({compare:true,otherStart:'2026-09-13',otherEnd:'2026-09-29'});await h.flush();
  button(h,'下一页').props.onClick();await h.flush();assert.equal(h.state('page'),2);
  const metrics=deep(h.all().find(n=>n.type==='MetricLedger').props.metrics),points=deep(h.state('data').points);
  search(h).props.onChange({target:{value:'糯米团子'}});await h.flush();
  assert.equal(h.state('page'),1);assert.equal(h.state('start'),six.start);assert.equal(h.state('end'),six.end);
  assert.deepEqual(deep(h.state('comparison')),{compare:true,otherStart:'2026-09-13',otherEnd:'2026-09-29'});
  assert.equal(new URL(h.window.location.href).searchParams.get('query'),'糯米团子');
  assert.equal(h.all().filter(n=>n.type==='Button'&&n.props.className==='author').length,1);
  button(h,'导出全部结果').props.onClick();const blob=h.downloads.at(-1).blob,csv=await blob.text();assert.equal(csv.trimEnd().split(/\r?\n/).length,2);assert.ok(csv.includes('糯米团子🍡'));assert.ok(csv.includes('"1","douyin"'));
  const expected=model.orderRows(model.rowsFor(f.accounts,f.points,six.start,six.end).filter(a=>a.enabled&&a.label.includes('糯米团子')),'followers.delta','desc');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),new TextEncoder().encode(model.csv(exporter.accountExport(expected,f.manifest,six.start,six.end))),'original CSV/BOM/identity/source/time/values remain byte-exact');
  assert.deepEqual(deep(h.all().find(n=>n.type==='MetricLedger').props.metrics),metrics);assert.deepEqual(h.state('data').points,points);assert.equal(h.network.length,0);
 }finally{h.close();}
});

test('phase80 actual Home search and applied A/B survive account detail return and clearing search',async()=>{
 const h=home();try{
  await h.flush();const growth=h.all().find(n=>n.type==='GrowthPanel');growth.props.onComparison({compare:true,otherStart:'2026-09-13',otherEnd:'2026-09-29'});await h.flush();
  button(h,'点赞').props.onClick();await h.flush();button(h,'点赞 ↓').props.onClick();await h.flush();
  search(h).props.onChange({target:{value:'003'}});await h.flush();
  const before={url:h.window.location.href,metrics:deep(h.all().find(n=>n.type==='MetricLedger').props.metrics),comparison:deep(h.state('comparison')),sort:h.state('sort'),order:h.state('order')};
  const row=h.all().find(n=>n.type==='TableRow'&&n.key===3),action=nodes(row).find(n=>n.props['aria-label']==='查看合成作者003的经营详情');assert.ok(action);
  const trigger={isConnected:true,disabled:false,focus(){h.document.activeElement=this;}};
  h.window.scrollY=580;action.props.onClick({currentTarget:trigger});await h.flush();assert.equal(h.state('personal').id,3);
  h.all().find(n=>n.type==='AccountPanel').props.onReturn();await h.flush();
  assert.equal(h.state('query'),'003');assert.equal(h.window.location.href,before.url);assert.equal(h.window.scrollY,580);assert.equal(h.document.activeElement,trigger);
  assert.deepEqual(deep(h.state('comparison')),before.comparison);assert.equal(h.state('sort'),before.sort);assert.equal(h.state('order'),before.order);assert.deepEqual(deep(h.all().find(n=>n.type==='MetricLedger').props.metrics),before.metrics);
  search(h).props.onChange({target:{value:''}});await h.flush();assert.equal(h.state('page'),1);assert.equal(h.all().filter(n=>n.type==='Button'&&n.props.className==='author').length,20);assert.equal(h.state('sort'),before.sort);assert.equal(h.state('order'),before.order);
  button(h,'导出全部结果').props.onClick();assert.equal((await h.downloads.at(-1).blob.text()).trimEnd().split(/\r?\n/).length,23);assert.equal(h.network.length,0);
 }finally{h.close();}
});

test('phase80 actual Home/CSS search remains readable and keyboard reachable at 390px and 200% text',async()=>{
 const h=home();let browser;try{
  await h.flush();const html=toolbarShell(h);assert.match(html,/aria-label="搜索作者"/);assert.match(html,/搜索作者名称/);
  browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce',serviceWorkers:'block'});
  const network=[];await context.route('**/*',route=>{network.push(route.request().url());return route.abort();});
  const page=await context.newPage();await page.setContent('<!doctype html><html lang="zh-CN"><head><style>'+compiledCss+(candidate?candidateCss:'')+'</style></head><body>'+html+'</body></html>');
  const findings=[];
  for(const [width,scale] of [[390,1],[390,2],[1440,1],[1440,2]]){
   await page.setViewportSize({width,height:900});await page.evaluate(scale=>document.documentElement.style.fontSize=(scale*100)+'%',scale);
   const field=page.getByRole('textbox',{name:'搜索作者',exact:true}),status=page.getByRole('combobox');
   await status.focus();await page.keyboard.press('Tab');assert.equal(await field.evaluate(el=>document.activeElement===el),true,'status → search keyboard order');
   await page.keyboard.insertText('糯米团子🍡');assert.equal(await field.inputValue(),'糯米团子🍡');await field.fill('');
   await page.keyboard.press('Tab');assert.equal(await page.getByRole('button',{name:'导出全部结果',exact:true}).evaluate(el=>document.activeElement===el),true,'search → export keyboard order');
   const geometry=await field.evaluate(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el),canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');ctx.font=s.font;const text=ctx.measureText(el.placeholder).width;return {width:r.width,height:r.height,font:s.fontSize,placeholderWidth:text,textSpace:el.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight),computedMinWidth:s.minWidth,computedFlex:s.flex,documentWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth};});
   findings.push({viewport:width,textScale:scale,...geometry,readable:geometry.textSpace>=geometry.placeholderWidth});
   if(['1','production'].includes(process.env.PHASE80_UX_SCREENSHOTS)&&width===390)await page.screenshot({path:new URL('../data/maintenance-journal/2026-10-02-phase80-ux-'+(candidate?'candidate':process.env.PHASE80_UX_SCREENSHOTS==='production'?'production':'current')+'-'+width+'-'+scale+'x.png',import.meta.url).pathname,fullPage:true});
  }
  console.info('PHASE80_UX_GEOMETRY '+JSON.stringify({candidateOnly:candidate,findings,externalRequests:network.length,url:page.url()}));
  assert.deepEqual(network,[]);assert.equal(page.url(),'about:blank');
  for(const result of findings){assert.ok(result.documentWidth<=result.viewportWidth+1,'page overflow '+JSON.stringify(result));assert.ok(result.readable,'actual author search clips its whole task label: '+JSON.stringify(result));assert.ok(result.width>=44,'search hit target below 44px');}
 }finally{h.close();await browser?.close();}
});
