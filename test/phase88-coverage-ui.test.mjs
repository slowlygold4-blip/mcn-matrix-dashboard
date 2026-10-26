// Phase88: execute the actual CoveragePanel and Button sources. The optional
// browser assertion uses the real rendered markup/CSS in a fresh offline page;
// it does not prove a live Site release, platform collection or dialog routing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {chromium} from 'playwright-core';

const SITE=new URL('../../mcn-public-site/',import.meta.url);
const requireSite=createRequire(new URL('package.json',SITE));
const ts=requireSite('typescript'),React=requireSite('react');
const render=requireSite('react-dom/server').renderToStaticMarkup;
const coverage=await import(new URL('lib/replica-coverage.mjs',SITE));
const source=await readFile(new URL('components/coverage-panel.tsx',SITE),'utf8');
const backup=await readFile(new URL('../data/backups/phase88-code-20261002/coverage-panel.tsx',import.meta.url),'utf8');
const compile=s=>ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const utils={};vm.runInNewContext(compile(await readFile(new URL('lib/utils.ts',SITE),'utf8')),{exports:utils,require:requireSite});
const buttons={};vm.runInNewContext(compile(await readFile(new URL('components/ui/button.tsx',SITE),'utf8')),{exports:buttons,require(spec){return spec==='@/lib/utils'?utils:requireSite(spec);}});
const sha=s=>createHash('sha256').update(s).digest('hex');
console.info('PHASE88_COVERAGE_SOURCES '+JSON.stringify({actual:sha(source),backup:sha(backup),model:sha(await readFile(new URL('lib/replica-coverage.mjs',SITE),'utf8'))}));
assert.equal(sha(backup),'010fd913809cceab16926f63b0e0d3421c1fd7c5e573bd6e4015061168701c06','original before-code backup must remain exact');

function load(s,react=React,jsx=requireSite('react/jsx-runtime'),button=buttons.Button){
 const exports={};vm.runInNewContext(compile(s),{exports,setInterval,clearInterval,require(spec){
  if(spec==='react')return react;
  if(spec==='react/jsx-runtime')return jsx;
  if(spec==='@/lib/replica-coverage.mjs')return coverage;
  if(spec==='@/components/ui/button')return {Button:button};
  throw Error('unexpected component import '+spec);
 }},{filename:'phase88-actual-coverage-panel.cjs'});return exports;
}
const actual=load(source),original=load(backup);
const ASOF='2026-10-01T23:45:00.000Z';
const OBS='2026-10-01T23:40:00.000Z';
const topics={topics:[],items:[]};
function account(id,status='complete',enabled=true,observed=OBS){return {id,label:`来源确认账号${String(id).padStart(3,'0')}`,enabled,coverage:{version:1,profileObservedAt:observed,works:{status,attemptedAt:status==='missing'?null:observed,observedAt:['missing','unavailable'].includes(status)?null:observed}}};}
function fixture(gapCount){return [...Array.from({length:gapCount},(_,i)=>account(i+1,'limited')),...[account(gapCount+1),account(gapCount+2)],account(900,'missing',false)];}
const deep=x=>JSON.parse(JSON.stringify(x));
const jsx=(type,props,key)=>({type,props:props||{},key});
function tree(accounts,now=null,onAccount=()=>{},componentSource=source){
 const virtual=load(componentSource,{useState:()=>[now,()=>{}],useEffect:()=>{}},{jsx,jsxs:jsx,Fragment:'Fragment'},'Button');
 return virtual.CoveragePanel({accounts,topics,asOf:ASOF,onAccount});
}
function nodes(n){if(n==null||typeof n!=='object')return [];if(Array.isArray(n))return n.flatMap(nodes);return [n,...nodes(n.props?.children)];}
function text(n){if(n==null||typeof n==='boolean')return '';if(Array.isArray(n))return n.map(text).join('');if(typeof n!=='object')return String(n);return text(n.props?.children);}
function visibleText(n){if(n==null||typeof n==='boolean')return '';if(Array.isArray(n))return n.map(visibleText).join('');if(typeof n!=='object')return String(n);if(n.type==='details'&&!n.props.open)return visibleText(nodes(n.props.children).find(x=>x.type==='summary'));return visibleText(n.props?.children);}
const gapSection=t=>nodes(t).find(n=>n.type==='section'&&n.props['aria-label']==='采样缺口账号');
const gapButtons=t=>nodes(gapSection(t)).filter(n=>n.type==='Button');
const markup=accounts=>render(React.createElement(actual.CoveragePanel,{accounts,topics,asOf:ASOF,onAccount:()=>{}}));

test('phase88 actual coverage: one native expansion exposes 0/1/20/21/55 exact gaps and keeps long definitions folded',()=>{
 for(const count of [0,1,20,21,55]){
  const accounts=fixture(count),before=deep(accounts),t=tree(accounts),section=gapSection(t);assert.ok(section);
  assert.equal(t.type,'details');assert.equal(t.props.open===true,false);assert.equal(nodes(section).filter(n=>n.type==='details').length,0,'no second disclosure before account names');
  assert.equal(gapButtons(t).length,Math.min(count,20));assert.equal(nodes(t).filter(n=>n.type==='details').length,2,'outer overview plus separate long definitions');
  const header=nodes(section).find(n=>n.type==='h3');assert.match(text(header),new RegExp(`需核对 ${count} 个账号`));assert.match(text(header),new RegExp(`当前显示${count>20?'前':''} ${Math.min(count,20)} 个`));
  t.props.open=true;const visible=visibleText(t);for(const a of accounts.slice(0,Math.min(count,20)))assert.ok(visible.includes(a.label),'first expansion shows real account '+a.id);
  assert.equal(visible.includes('完整仅表示该次分页和库存核验完成'),false,'long definitions remain separately collapsed');
  assert.equal(visible.includes('来源确认账号900'),false,'paused account is excluded from enabled coverage');
  if(count>20)assert.equal(visible.includes(accounts[20].label),false,'first20 limit remains honest');
  if(count===0)assert.ok(visible.includes('不代表其他日期没有缺测'));
  assert.deepEqual(accounts,before,'render does not mutate user data');
 }
});

test('phase88 before/after actual source: old one expansion hides account names, new one expansion exposes them',()=>{
 const accounts=fixture(1),before=tree(accounts,null,()=>{},backup),after=tree(accounts);before.props.open=true;after.props.open=true;
 assert.equal(visibleText(before).includes(accounts[0].label),false);assert.equal(visibleText(after).includes(accounts[0].label),true);
});

test('phase88 actual coverage: callbacks use exact stable ID/source account object even with identical labels',()=>{
 const accounts=fixture(2);accounts[0].label='相同名称 OvO';accounts[1].label='相同名称 OvO';const clicks=[],t=tree(accounts,null,a=>clicks.push(a)),actions=gapButtons(t);
 assert.equal(actions.length,2);assert.equal(actions[0].props.type,'button');assert.equal(actions[1].props.type,'button');
 actions[1].props.onClick();actions[0].props.onClick();assert.equal(clicks[0],accounts[1]);assert.equal(clicks[1],accounts[0]);assert.equal(clicks[0].id,2);assert.equal(clicks[1].id,1);
 assert.equal(actions[0].props['aria-label'],'查看相同名称 OvO的经营详情');assert.equal(actions[1].props['aria-label'],'查看相同名称 OvO的经营详情');
});

test('phase88 actual coverage: published/current 8h boundary, unavailable/unknown and known zeros are not collapsed into success',()=>{
 const exact=account(1,'complete',true,ASOF),stale=account(2,'complete',true,'2026-10-01T15:44:59.999Z'),limited=account(3,'limited'),missing=account(4,'missing'),unknown={id:5,label:'旧发布未知覆盖',enabled:true};
 const accounts=[exact,stale,limited,missing,unknown],before=deep(accounts),initial=tree(accounts,null),atBoundary=tree(accounts,Date.parse(ASOF)+8*3600000),past=tree(accounts,Date.parse(ASOF)+8*3600000+1);
 assert.equal(gapButtons(initial).length,4);assert.equal(gapButtons(atBoundary).length,4,'inclusive 8h boundary is unchanged');assert.equal(gapButtons(past).length,5);
 assert.ok(text(initial).includes('该发布版本未提供作品覆盖证据'));assert.ok(text(initial).includes('无作品观察'));assert.ok(text(initial).includes('未取得有效采样'));assert.ok(text(initial).includes('完整观察'));
 const currentSummary=nodes(atBoundary).find(n=>n.type==='summary');assert.ok(text(currentSummary).includes('主页三指标 1/5'));assert.ok(text(currentSummary).includes('作品完整 1/5'));
 assert.ok(text(nodes(past).find(n=>n.type==='summary')).includes('主页三指标 0/5'));assert.deepEqual(accounts,before);
});

test('phase88 real React markup: labels/time remain escaped, first20 use actual Button and all source/AccountCoverage wording retained',()=>{
 const accounts=fixture(21);accounts[0].label='<script>原始 & 账号</script>';const html=markup(accounts);
 assert.match(html,/&lt;script&gt;原始 &amp; 账号&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>/);
 assert.equal((html.match(/class="[^"]*coverage-account/g)||[]).length,20);assert.equal((html.match(/type="button"/g)||[]).length,20);assert.match(html,/来源确认账号020/);assert.doesNotMatch(html,/来源确认账号021/);
 assert.match(html,/刚发布不代表刚采样/);assert.match(html,/保存作品数量不等于平台全集/);assert.match(html,/每日历史按观察日合并/);assert.match(html,/完整仅表示该次分页和库存核验完成/);
 const a=account(123,'limited');assert.equal(render(React.createElement(actual.AccountCoverage,{account:a,asOf:ASOF})),render(React.createElement(original.AccountCoverage,{account:a,asOf:ASOF})),'individual source coverage is byte-identical');
});

test('phase88 actual coverage rejects invalid source evidence rather than hiding it behind a new empty state',()=>{
 const bad=fixture(1);bad[0].coverage.works.observedAt='invalid';assert.throws(()=>markup(bad),/账号覆盖证据无效/);assert.throws(()=>tree(bad),/账号覆盖证据无效/);
});

test('phase88 native keyboard disclosure: one Enter shows names, long definitions stay closed, first account is focusable; 390px/200% no page overflow',async()=>{
 const postcss=requireSite('postcss'),tailwind=requireSite('@tailwindcss/postcss');
 const globals=await readFile(new URL('app/globals.css',SITE),'utf8'),replica=await readFile(new URL('app/replica.css',SITE),'utf8');
 const css=(await postcss([tailwind({base:SITE.pathname})]).process(globals,{from:new URL('app/globals.css',SITE).pathname})).css+'\n'+replica;
 let browser;try{
  browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block',reducedMotion:'reduce'}),network=[];
  await context.route('**/*',route=>{network.push(route.request().url());return route.abort();});
  const browserAccounts=fixture(21);browserAccounts[0].label='长来源账号昵称（不是昵称猜归属）'.repeat(8)+' English_OvO_'.repeat(12);
  const page=await context.newPage();await page.setContent('<!doctype html><html lang="zh-CN"><head><style>'+css+'</style></head><body>'+markup(browserAccounts)+'</body></html>');
  const outer=page.locator('details.coverage-panel'),method=page.locator('details.coverage-method'),first=page.getByRole('button',{name:`查看${browserAccounts[0].label}的经营详情`,exact:true});
  assert.equal(await first.isVisible(),false);await outer.locator(':scope > summary').focus();await page.keyboard.press('Enter');assert.equal(await outer.evaluate(el=>el.open),true);assert.equal(await first.isVisible(),true);assert.equal(await method.evaluate(el=>el.open),false);
  await page.keyboard.press('Tab');assert.equal(await first.evaluate(el=>document.activeElement===el),true,'after one expansion keyboard reaches existing first source account');
  const focus=await first.evaluate(el=>{const s=getComputedStyle(el);return {outlineWidth:s.outlineWidth,outlineStyle:s.outlineStyle,outlineColor:s.outlineColor};});assert.ok(parseFloat(focus.outlineWidth)>=2);assert.equal(focus.outlineStyle,'solid');
  await method.locator(':scope > summary').focus();await page.keyboard.press('Space');assert.equal(await method.evaluate(el=>el.open),true);await page.keyboard.press('Space');assert.equal(await method.evaluate(el=>el.open),false);
  const findings=[];for(const [width,scale] of [[390,1],[390,2],[1440,1],[1440,2]]){
   await page.setViewportSize({width,height:900});await page.evaluate(scale=>document.documentElement.style.fontSize=(scale*100)+'%',scale);
   const geometry=await page.evaluate(()=>{const parent=document.querySelector('.coverage-details').getBoundingClientRect();return {document:document.documentElement.scrollWidth,viewport:innerWidth,buttons:document.querySelectorAll('.coverage-account').length,methodOpen:document.querySelector('.coverage-method').open,accountTargets:[...document.querySelectorAll('.coverage-account')].map(el=>{const r=el.getBoundingClientRect();return {width:r.width,height:r.height,left:r.left,right:r.right,containerLeft:parent.left,containerRight:parent.right,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight};})};});
   findings.push({width,scale,...geometry});assert.ok(geometry.document<=geometry.viewport+1,'page must not overflow '+JSON.stringify(geometry));assert.equal(geometry.buttons,20);assert.equal(geometry.methodOpen,false);
   for(const target of geometry.accountTargets){assert.ok(target.height>=44,'every actual account action remains at least44px');assert.ok(target.left>=target.containerLeft-1&&target.right<=target.containerRight+1,'full long name action remains inside panel');assert.ok(target.scrollWidth<=target.clientWidth+1&&target.scrollHeight<=target.clientHeight+1,'long source name is wrapped, not clipped');}
  }
  console.info('PHASE88_COVERAGE_LOCAL_DOM '+JSON.stringify({findings:findings.map(({accountTargets,...f})=>({...f,firstLongName:accountTargets[0],minimumTargetHeight:Math.min(...accountTargets.map(t=>t.height))})),focus,externalRequests:network.length,url:page.url(),hydrated:false,textScale:'root font-size 100%/200%, not browser zoom',source:'actual SSR markup and current actual CSS',replicaCssSha256:sha(replica)}));
  assert.deepEqual(network,[]);assert.equal(page.url(),'about:blank');await context.close();
 }finally{await browser?.close();}
});
