// Independent U20/U45 task audit. Uses the existing actual-Home controller harness,
// not a copied production controller. No network, DB, browser, sampler or credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {derivePublicHistoryDateIndex} from '../lib/public-history-range.mjs';
import * as navigation from '../../mcn-public-site/lib/replica-navigation.mjs';
import {captureWorkspaceReturn,workspaceReturnPath} from '../../mcn-public-site/lib/replica-return.mjs';
import {parseAccountRequest} from '../../mcn-public-site/lib/replica-account.mjs';
const SITE=new URL('../../mcn-public-site/',import.meta.url);
const original=await readFile(new URL('./public-global-url-phase53-peer-20261001.test.mjs',import.meta.url),'utf8');
const begin=original.indexOf('const SITE = new URL('),end=original.indexOf('\nasync function apply(h,key)');
assert.ok(begin>0&&end>begin,'existing unchanged Home harness boundaries must exist');
let harnessSource=original.slice(begin,end).replace("new URL('../../mcn-public-site/', import.meta.url)",`new URL(${JSON.stringify(SITE.href)})`);
// The original date-only harness did not exercise detail return. Supply only the
// documented DOM query used by the unchanged production focus restoration path.
harnessSource=harnessSource.replace("document:{visibilityState:'visible',activeElement:null,createElement()", "document:{visibilityState:'visible',activeElement:null,querySelector(){return null;},createElement()");
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const {pageHarness,fixture}=await new AsyncFunction('readFile','createRequire','createHash','vm','assert','derivePublicHistoryDateIndex',harnessSource+'\nreturn {pageHarness,fixture};')(readFile,createRequire,createHash,vm,assert,derivePublicHistoryDateIndex);
const A={start:'2026-09-20',end:'2026-09-29'},B={compare:true,otherStart:'2026-09-12',otherEnd:'2026-09-19'};
const idle={compare:false,otherStart:'',otherEnd:''};
const query='?theme=tuantuan&classification=slice&period=custom&start='+A.start+'&end='+A.end;
const withB=query+'&compareStart='+B.otherStart+'&compareEnd='+B.otherEnd;
const growth=h=>h.element(n=>n.type==='GrowthPanel');
const comparison=h=>({...growth(h).props.comparison});
async function setComparison(h,next){const panel=growth(h);assert.ok(panel,'actual Home must render GrowthPanel');panel.props.onComparison(next);await h.flush();}
const params=h=>new URL(h.window.location.href).searchParams;

test('phase70 U20 optional comparison contract is exact and leaves legacy single-window shapes untouched',()=>{
 assert.equal(typeof navigation.workspaceComparisonSelection,'function','missing comparison URL parser');
 assert.deepEqual(navigation.workspaceComparisonSelection(query),idle);
 assert.deepEqual(navigation.workspaceComparisonSelection(withB),B);
 assert.deepEqual(navigation.workspaceSelection(query),{board:'all',theme:'tuantuan',tag:'slice',period:'custom',...A});
 const path=navigation.workspaceSelectionPath('/','accounts',navigation.workspaceSelection(query),navigation.workspaceListSelection(query),B);
 assert.equal(new URL(path,'https://synthetic.invalid').searchParams.get('compareStart'),B.otherStart);
 assert.equal(new URL(path,'https://synthetic.invalid').searchParams.get('compareEnd'),B.otherEnd);
 assert.equal(navigation.workspacePath('/','topics',withB).endsWith('#topics'),true);
 assert.deepEqual(navigation.workspaceComparisonSelection(navigation.workspacePath('/','topics',withB).split('#')[0].slice(1)),B);
 assert.deepEqual(navigation.workspaceComparisonSelection('?compareStart=2026-09-12&compareEnd=2026-09-12'),{compare:true,otherStart:'2026-09-12',otherEnd:'2026-09-12'},'a real same-day comparison is valid, not missing');
});

for(const bad of [
 '?compareStart=2026-09-12', '?compareEnd=2026-09-19',
 '?compareStart=&compareEnd=', '?compareStart=2026-09-20&compareEnd=2026-09-19',
 '?compareStart=2026-09-31&compareEnd=2026-10-01',
 '?compareStart=2026-09-12&compareStart=2026-09-13&compareEnd=2026-09-19',
 '?compareStart=2026-09-12&compareEnd=2026-09-19&%63ompareEnd=2026-09-20'
])test('phase70 U20 malformed B range fails closed before route/read '+bad,()=>{
 assert.throws(()=>navigation.workspaceNavigation(bad,'#overview'),Error);
});

for(const bad of ['?compareStart=2026-09-12','?compareStart=2026-09-31&compareEnd=2026-10-01','?compareStart=2026-09-12&compareEnd=2026-09-19&compareEnd=2026-09-20'])test('phase70 U20 actual malformed B link has an explanation and does not fetch or export '+bad,async()=>{
 const h=await pageHarness('https://synthetic.invalid/'+bad+'#overview');try{
  assert.ok(h.element(n=>n.props.role==='alert'),'show invalid date link, not another valid statistic');
  assert.equal(h.fetches.length,0,'invalid paired B dates must fail before metadata request');
  assert.ok(!h.element(n=>n.type==='MetricLedger'),'no misleading single-A data under malformed B link');
  assert.ok(!h.element(n=>n.type==='Button'&&n.props.children==='导出全部结果'),'no wrong-range export');
 }finally{h.close();}
});

test('phase70 U20 actual Home applies B into address and a new reader reopens identical A/B and scope',async()=>{
 const h=await pageHarness('https://synthetic.invalid/'+query+'#overview');try{
  await setComparison(h,B);assert.equal(params(h).get('compareStart'),B.otherStart);assert.equal(params(h).get('compareEnd'),B.otherEnd);
  assert.equal(params(h).get('theme'),'tuantuan');assert.equal(params(h).get('classification'),'slice');
  const shared=await pageHarness(h.window.location.href);try{assert.deepEqual(shared.dates(),[A.start,A.end]);assert.deepEqual(comparison(shared),B);assert.equal(growth(shared).props.ready,true);}finally{shared.close();}
 }finally{h.close();}
});

test('phase70 U20 actual direct B URL never silently overwrites it with a single-A address',async()=>{
 const h=await pageHarness('https://synthetic.invalid/'+withB+'#accounts');try{
  assert.deepEqual(comparison(h),B);assert.equal(params(h).get('compareStart'),B.otherStart);assert.equal(params(h).get('compareEnd'),B.otherEnd);
  assert.equal(growth(h).props.ready,true);assert.deepEqual(growth(h).props.points.map(p=>p.date).filter(d=>d<B.otherStart),[]);
  await h.click('刷新已发布数据');assert.deepEqual(comparison(h),B);assert.equal(params(h).get('compareEnd'),B.otherEnd);
 }finally{h.close();}
});

test('phase70 U20 B drafting does not rewrite the applied address; closing compare removes only B',async()=>{
 const h=await pageHarness('https://synthetic.invalid/'+withB+'#overview');try{
  const applied=h.window.location.href;await setComparison(h,{...B,otherEnd:''});
  assert.equal(h.window.location.href,applied);assert.equal(growth(h).props.ready,false,'no stale A/B curve while paired B draft is invalid');
  await setComparison(h,idle);assert.equal(params(h).has('compareStart'),false);assert.equal(params(h).has('compareEnd'),false);
  assert.equal(params(h).get('start'),A.start);assert.equal(params(h).get('end'),A.end);assert.equal(params(h).get('classification'),'slice');
 }finally{h.close();}
});

test('phase70 U20 saved address back/forward restores and clears B rather than retaining unrelated state',async()=>{
 const h=await pageHarness('https://synthetic.invalid/'+withB+'#accounts');try{
  h.window.history.pushState(null,'',query+'#overview');await h.dispatch('popstate');assert.deepEqual(comparison(h),idle);
  await h.back();assert.deepEqual(comparison(h),B);assert.equal(h.heading(),'账号明细');
  await h.forward();assert.deepEqual(comparison(h),idle);assert.equal(h.heading(),'矩阵经营总览');
 }finally{h.close();}
});

test('phase70 U45 complete detail round trip keeps original A/B, list sort and search',async()=>{
 const h=await pageHarness('https://synthetic.invalid/'+withB+'&sort=likes.delta&order=asc&query=Synthetic#accounts');try{
  const before=h.window.location.href;
  const historyEntry=h.element(n=>n.type==='Button'&&n.props['aria-label']==='查看Synthetic 1的历史');assert.ok(historyEntry);historyEntry.props.onClick({currentTarget:{isConnected:true,focus(){}}});await h.flush();await h.click('打开独立账号页面');
  assert.equal(h.heading(),'账号经营详情');
  // Phase86 deliberately preserves a ready enabled-account comparison. Keep
  // the personal identity/generation allowlist strict, rather than forwarding
  // the matrix's query, scope, sort or any navigation-return field.
  const panel=h.element(n=>n.type==='AccountPanel');assert.ok(panel);
  assert.deepEqual([...params(h).keys()].sort(),['account','compareEnd','compareStart','end','generation','start'].sort());
  assert.equal(params(h).get('account'),String(panel.props.account.id));assert.equal(params(h).get('generation'),panel.props.manifest.asOf);
  assert.equal(params(h).get('start'),A.start);assert.equal(params(h).get('end'),A.end);
  assert.equal(params(h).get('compareStart'),B.otherStart);assert.equal(params(h).get('compareEnd'),B.otherEnd);
  assert.deepEqual(parseAccountRequest(h.window.location.search),{id:panel.props.account.id,...A,generation:panel.props.manifest.asOf,comparison:B});
  panel.props.onReturn();await h.flush();
  assert.equal(h.window.location.href,before);assert.deepEqual(comparison(h),B);assert.equal(params(h).get('sort'),'likes.delta');assert.equal(params(h).get('query'),'Synthetic');
 }finally{h.close();}
});

test('phase70 U45 pure captured return preserves B without changing account share identity or generation',()=>{
 const generation='2026-09-29T16:34:00.000Z';
 const captured=captureWorkspaceReturn({pathname:'/',search:withB,hash:'#accounts',generation});
 const path=workspaceReturnPath(captured,{pathname:'/',generation});
 assert.equal(new URL(path,'https://synthetic.invalid').searchParams.get('compareStart'),B.otherStart);
 assert.equal(new URL(path,'https://synthetic.invalid').searchParams.get('compareEnd'),B.otherEnd);
 assert.equal(workspaceReturnPath(captured,{pathname:'/',generation:'2026-09-30T16:34:00.000Z'}),null);
});

test('phase70 U20 indexed initial A/B receipt reads one combined truthful window, not initial A then a second replacement',async()=>{
 const f=await fixture({days:701,asOf:'2028-08-13T16:34:00.000Z'});
 const address='https://synthetic.invalid/?period=custom&start=2028-08-01&end=2028-08-05&compareStart=2026-09-12&compareEnd=2026-09-15#overview';
 const h=await pageHarness(address,{fixture:f});try{
  assert.deepEqual(comparison(h),{compare:true,otherStart:'2026-09-12',otherEnd:'2026-09-15'});
  assert.equal(h.reads.filter(p=>p==='date-summary-index.json').length,1,'one accepted initial combined-range receipt');
  assert.ok(h.reads.includes('date-summary/000001.json'),'B older dates must be read');assert.ok(h.reads.includes('date-summary/000002.json'),'A later dates must be read');
  assert.equal(growth(h).props.ready,true);assert.ok(growth(h).props.points.some(p=>p.date==='2026-09-12'));
 }finally{h.close();}
});

test('phase70 U20 independent comparison-only URL resolves its real default A once and preserves B',async()=>{
 const h=await pageHarness('https://synthetic.invalid/?compareStart=2026-09-12&compareEnd=2026-09-15#overview');try{
  assert.deepEqual(comparison(h),{compare:true,otherStart:'2026-09-12',otherEnd:'2026-09-15'});
  assert.equal(params(h).get('start'),'2026-09-12');assert.equal(params(h).get('end'),'2026-09-29');
  assert.equal(params(h).get('compareStart'),'2026-09-12');assert.equal(params(h).get('compareEnd'),'2026-09-15');
  assert.equal(h.reads.filter(p=>p==='date-summary-index.json').length,1);
 }finally{h.close();}
});

test('phase70 U20 after topics metadata refresh a new saved A/B route does not fetch the previous A/B scope first',async()=>{
 const f=await fixture({days:701,asOf:'2028-08-13T16:34:00.000Z'});
 const h=await pageHarness('https://synthetic.invalid/'+withB+'#overview',{fixture:f});try{
  await h.click('话题观察');await h.click('刷新已发布数据');
  const from=h.reads.length;
  const next='?period=custom&start=2028-08-01&end=2028-08-05&compareStart=2028-08-06&compareEnd=2028-08-10#overview';
  h.window.history.pushState(null,'',next);await h.dispatch('popstate');
  assert.deepEqual(comparison(h),{compare:true,otherStart:'2028-08-06',otherEnd:'2028-08-10'});
  const changed=h.reads.slice(from);
  assert.equal(changed.filter(p=>p==='date-summary-index.json').length,1,'only the newly addressed A/B receipt may be read');
  assert.equal(changed.includes('date-summary/000001.json'),false,'old A/B history must not be fetched after a new address owns the view');
  assert.equal(growth(h).props.ready,true);
 }finally{h.close();}
});

test('phase70 U20 late superseded B read cannot restore old curve, address or export-ready scope',async()=>{
 let delayNext=false,resolveDelayed,oldSignal;
 const delayed=new Promise(resolve=>{resolveDelayed=resolve;});
 const h=await pageHarness('https://synthetic.invalid/'+withB+'#overview',{beforeRead:async(part,signal)=>{
  if(delayNext&&part==='date-summary-index.json'){delayNext=false;oldSignal=signal;await delayed;}
 }});
 try{
  delayNext=true;const older=setComparison(h,{compare:true,otherStart:'2026-09-14',otherEnd:'2026-09-18'});
  for(let n=0;n<50&&!oldSignal;n++)await new Promise(resolve=>setTimeout(resolve,1));
  assert.ok(oldSignal,'actual older range read must have started');
  assert.equal(growth(h).props.ready,false,'old applied bytes may not be presented as the new B');
  const wanted={compare:true,otherStart:'2026-09-21',otherEnd:'2026-09-23'};
  await setComparison(h,wanted);assert.equal(oldSignal.aborted,true);assert.equal(growth(h).props.ready,true);
  const latest=h.window.location.href;resolveDelayed();await older;await h.flush();
  assert.equal(h.window.location.href,latest);assert.deepEqual(comparison(h),wanted);
  assert.equal(params(h).get('compareStart'),wanted.otherStart);assert.equal(params(h).get('compareEnd'),wanted.otherEnd);
  assert.equal(growth(h).props.points.some(p=>p.date==='2026-09-14'),false,'superseded B day must not replace accepted newer points');
 }finally{resolveDelayed();h.close();}
});

test('phase70 U20 failed B read explains failure and keeps last applied share address rather than asserting new statistics',async()=>{
 let failNext=false;
 const h=await pageHarness('https://synthetic.invalid/'+withB+'#overview',{beforeRead:async part=>{
  if(failNext&&part==='date-summary-index.json'){failNext=false;throw Error('Synthetic B source read failure');}
 }});
 try{
  const applied=h.window.location.href;failNext=true;
  await setComparison(h,{compare:true,otherStart:'2026-09-14',otherEnd:'2026-09-18'});
  assert.equal(growth(h).props.ready,false);assert.match(growth(h).props.pendingError,/Synthetic B source read failure/);
  assert.equal(h.window.location.href,applied,'unread new B may not be advertised as an applied shared range');
 }finally{h.close();}
});
