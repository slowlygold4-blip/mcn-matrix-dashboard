// Executes current production Home TSX and its real routing/export helpers using
// the unchanged Phase66 hook transport. Source-owner proof, not a browser test.
// Fixtures are explicitly synthetic. No server, browser session, DB or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import vm from 'node:vm';

const SITE=new URL('../../mcn-public-site/',import.meta.url);
const sourceUrl=new URL('app/page.tsx',SITE);
const candidate=process.env.PHASE86_UX_CANDIDATE==='1';
const source=await readFile(sourceUrl,'utf8');
const old='generation:data.manifest.asOf});window.history.pushState';
const replacement='generation:data.manifest.asOf,...(a.enabled&&data.summaryLoaded&&rangeReady&&comparison.compare?{compareStart:comparison.otherStart,compareEnd:comparison.otherEnd}:{})});window.history.pushState';
if(candidate)assert.equal(source.split(old).length,2,'candidate must patch exactly one current standalone route');
const readForTest=async(url,...args)=>{
 const value=await readFile(url,...args);
 return candidate&&String(url)===sourceUrl.href?value.replace(old,replacement):value;
};
const oldUrl=new URL('./phase66-workspace-state-peer.test.mjs',import.meta.url);
const harness=(await readFile(oldUrl,'utf8')).replace(/^import[^\n]*\n/gm,'').replaceAll('import.meta.url',JSON.stringify(oldUrl.href));
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const {home,nodes,button,six,asOf}=await new AsyncFunction('test','assert','readFile','createRequire','vm',harness+'\nreturn {home,nodes,button,six,asOf};')(()=>{},assert,readForTest,createRequire,vm);
const nav=await import(new URL('lib/replica-navigation.mjs',SITE));
const personalModel=await import(new URL('lib/replica-account.mjs',SITE));
const deep=x=>JSON.parse(JSON.stringify(x));
const B={compare:true,otherStart:'2026-09-14',otherEnd:'2026-09-28'};
const list={sort:'label',order:'asc',query:'合成作者',rosterStatus:'all'};
const initialPath=nav.workspaceSelectionPath('/','accounts',six,list,B);
const panel=h=>h.all().find(n=>n.type==='AccountPanel');
const target=h=>({isConnected:true,disabled:false,focus(){h.document.activeElement=this;}});
const rowAction=(h,id,kind)=>{
 const row=h.all().find(n=>n.type==='TableRow'&&n.key===id);assert.ok(row);
 const action=nodes(row).find(n=>String(n.props['aria-label']||'').includes(kind));assert.ok(action);return action;
};
async function ready(){const h=home('https://phase86.invalid'+initialPath);await h.flush();return h;}
function assertInherited(h,id=1){
 const request=deep(panel(h).props.request);assert.equal(request.id,id);assert.equal(request.generation,asOf);
 assert.deepEqual({start:request.start,end:request.end},{start:six.start,end:six.end});
 assert.deepEqual(request.comparison,B,'entering the account must keep the active matrix B dates');
 assert.deepEqual(personalModel.parseAccountRequest(h.window.location.search),request);
 const share=personalModel.accountShareQuery({...request,id:request.id});
 assert.deepEqual(personalModel.parseAccountRequest(share),request,'share/reopen keeps identity, fixed generation and both date ranges');
 assert.equal(new URLSearchParams(h.window.location.search).has('query'),false);
 assert.equal(new URLSearchParams(h.window.location.search).has('theme'),false);
 assert.equal(h.network.length,0);
}
console.info('PHASE86_UX_SOURCE '+JSON.stringify({candidateOnly:candidate,homeSha256:createHash('sha256').update(source).digest('hex'),proof:'actual production Home source owner with simulated hooks and DOM; synthetic fixture',browserSessions:0,dbReads:0,networkReads:0}));

test('phase86 enabled account detail inherits the active matrix comparison, shares and reopens it',async()=>{
 const h=await ready();try{rowAction(h,1,'经营详情').props.onClick({currentTarget:target(h)});await h.flush();assertInherited(h);}finally{h.close();}
});

test('phase86 history to standalone uses the same A/B identity and fixed publication',async()=>{
 const h=await ready();try{
  rowAction(h,1,'历史').props.onClick({currentTarget:target(h)});await h.flush();assert.equal(h.state('account').id,1);
  button(h,'打开独立账号页面').props.onClick();await h.flush();assertInherited(h);assert.equal(h.state('account'),null);
 }finally{h.close();}
});

test('phase86 coverage account entry inherits an already valid active comparison',async()=>{
 const h=await ready();try{
  h.all().find(n=>n.type==='CoveragePanel').props.onAccount(h.state('data').accounts[0]);await h.flush();assertInherited(h);
 }finally{h.close();}
});

test('phase86 browser-back owner preserves original A/B URL, page, scroll, trigger and CSV bytes',async()=>{
 const h=await ready();try{
  button(h,'下一页').props.onClick();await h.flush();assert.equal(h.state('page'),2);h.window.scrollY=655;
  button(h,'导出全部结果').props.onClick();const beforeCsv=await h.downloads.at(-1).blob.text();
  const before=h.window.location.href,metrics=deep(h.all().find(n=>n.type==='MetricLedger').props.metrics),trigger=target(h);
  rowAction(h,21,'经营详情').props.onClick({currentTarget:trigger});await h.flush();
  const request=deep(panel(h).props.request);assert.equal(request.generation,asOf);
  h.back();await h.flush();assert.equal(h.window.location.href,before);assert.equal(h.state('page'),2);assert.equal(h.window.scrollY,655);assert.equal(h.document.activeElement,trigger);
  assert.deepEqual(deep(h.state('comparison')),B);assert.deepEqual(deep(h.all().find(n=>n.type==='MetricLedger').props.metrics),metrics);
  button(h,'导出全部结果').props.onClick();assert.equal(await h.downloads.at(-1).blob.text(),beforeCsv);assert.equal(h.network.length,0);
 }finally{h.close();}
});

test('phase86 paused account keeps its personal saved-window default without inherited A or B',async()=>{
 const h=await ready();try{
  button(h,'下一页').props.onClick();await h.flush();rowAction(h,23,'经营详情').props.onClick({currentTarget:target(h)});await h.flush();
  const request=panel(h).props.request;assert.equal(request.id,23);assert.equal(request.generation,asOf);assert.equal(request.start,null);assert.equal(request.end,null);assert.equal(request.comparison,undefined);assert.equal(h.network.length,0);
 }finally{h.close();}
});

test('phase86 disabled, incomplete or unread summary comparison does not enter a personal URL',async()=>{
 for(const variant of ['closed','incomplete','unread','summary-failed','topics-only']){
  const h=await ready();try{
   if(variant==='unread')h.set('data',{...h.state('data'),dateIndexed:true,summaryLoaded:false,receipt:null});
   else if(variant==='summary-failed'||variant==='topics-only'){
    const {dateIndexed,receipt,...d}=h.state('data');h.set('data',{...d,summaryLoaded:false,points:[],summaryError:variant==='summary-failed'?'synthetic blocked summary':''});
   }
   else h.set('comparison',variant==='closed'?{...B,compare:false}:{compare:true,otherStart:B.otherStart,otherEnd:''});
   await h.flush();h.all().find(n=>n.type==='CoveragePanel').props.onAccount(h.state('data').accounts[0]);await h.flush();
   assert.equal(panel(h).props.request.comparison,undefined);assert.equal(h.state('linkError'),'');
   // The unread date-index range can attempt its blocked local fetch; no network
   // transport exists. This case only asserts routing, not loading success.
   assert.equal(panel(h).props.request.generation,asOf);
  }finally{h.close();}
 }
});

test('phase86 refreshed personal route keeps existing fixed B and avoids a latest-generation request',async()=>{
 const request={id:1,start:six.start,end:six.end,generation:asOf,comparison:B};
 const h=home('https://phase86.invalid/'+personalModel.accountShareQuery(request));try{
  await h.flush();assert.deepEqual(deep(panel(h).props.request),request);assert.equal(h.network.length,0);
  button(h,'刷新已发布数据').props.onClick();await h.flush();
  assert.ok(h.network.length>0);assert.equal(String(h.network.at(-1)[0]),'/api/replica?'+new URLSearchParams({generation:asOf}));
  assert.deepEqual(deep(panel(h).props.request),request,'failed offline refresh preserves the fixed personal request');
 }finally{h.close();}
});
