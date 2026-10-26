// Independent execution of actual owner TSX with simulated event targets/hooks.
// This is neither a browser focus/keyboard acceptance run nor React DOM rendering.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const main=new URL('../',import.meta.url);
const site=new URL(process.env.PHASE96_SITE ? 'file://'+process.env.PHASE96_SITE.replace(/\/$/,'')+'/' : '../../mcn-public-site/',import.meta.url);
const requireSite=createRequire(new URL('package.json',site)),ts=requireSite('typescript');
const tableSource=await readFile(new URL('components/scrollable-table.tsx',site),'utf8');
const tableCompiled=ts.transpileModule(tableSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const tableExports={},jsx=(type,props,key)=>({type,props,key});
vm.runInNewContext(tableCompiled,{exports:tableExports,require(name){if(name==='react')return {useRef:value=>({current:value}),useEffect:fn=>fn()};if(name==='react/jsx-runtime')return {jsx,jsxs:jsx};if(name==='@/components/ui/table')return {Table:'BaseTable'};throw Error(name);}});
const table=tableExports.ScrollableTable({children:null});
const region=table.props.children.find(n=>n?.props?.role==='region');
function event(key,{nested=false,overflow=true,modifier}={}){
 const operations=[];const area={scrollWidth:overflow?900:300,clientWidth:300,scrollBy:x=>operations.push(['by',x.left,x.behavior]),scrollTo:x=>operations.push(['to',x.left,x.behavior])};
 const currentTarget={querySelector:selector=>{assert.equal(selector,'[data-slot="table-container"]');return area;}};
 const e={key,currentTarget,target:nested?{}:currentTarget,preventDefault:()=>operations.push(['prevent']),...(modifier?{[modifier]:true}:{})};
 region.props.onKeyDown(e);return operations;
}
test('actual ScrollableTable arrows/Home/End act only on focused overflow region',()=>{
 assert.equal(region.props.tabIndex,0);
 for(const [key,action,amount] of [['ArrowLeft','by',-120],['ArrowRight','by',120],['Home','to',0],['End','to',900]])assert.deepEqual(event(key),[['prevent'],[action,amount,'instant']]);
});
test('actual ScrollableTable does not hijack arrows from nested work metric buttons',()=>{
 for(const key of ['ArrowLeft','ArrowRight','Home','End','Enter',' '])assert.deepEqual(event(key,{nested:true}),[]);
});
test('actual ScrollableTable leaves modifiers, non-overflow and unrelated keys alone',()=>{
 for(const modifier of ['altKey','ctrlKey','metaKey','shiftKey'])for(const key of ['ArrowLeft','ArrowRight','Home','End'])assert.deepEqual(event(key,{modifier}),[]);
 for(const key of ['ArrowLeft','ArrowRight','Home','End'])assert.deepEqual(event(key,{overflow:false}),[]);
 for(const key of ['Tab','Escape','Enter',' ','ArrowUp','ArrowDown'])assert.deepEqual(event(key),[]);
});

const harnessUrl=new URL('test/phase66-workspace-state-peer.test.mjs',main);
const historyReplies=new Map(),deferred=[];
let harness=(await readFile(harnessUrl,'utf8')).replace(/^import[^\n]*\n/gm,'')
 .replace("new URL('../../mcn-public-site/',import.meta.url)",JSON.stringify(site.href))
 .replaceAll('import.meta.url',JSON.stringify(harnessUrl.href))
 .replace('readReplicaPart:async()=>({items:[]})','readReplicaPart:async(args)=>{const value=historyReplies.get(args.part);if(value===\'defer\')return new Promise((resolve,reject)=>deferred.push({args,resolve,reject}));return {items:value||[]};}')
 .replace("const document={activeElement:{tagName:'BODY'},", "const document={body:{tagName:'BODY'},activeElement:{tagName:'BODY'},")
 .replace(/ function commit\(x\)\{[^\n]+\}/,` const dom=new Map(); let dialogOpen=false;
 function commit(x){
  for(const host of dom.values())host.isConnected=false;
  const all=nodes(x);dialogOpen=!!all.find(n=>n.type==='Dialog')?.props.open;
  const host=(key)=>{let node=dom.get(key);if(!node){node={key,isConnected:true,disabled:false,scrollTop:0,scrollLeft:0,focusCalls:0,focus(options){this.focusCalls++;this.lastOptions=options;document.activeElement=this;},scrollIntoView(){},getClientRects(){return [{}];},querySelector(selector){if(selector==='[data-history-table] [data-slot="table-container"]')return dom.get('table-scroll');const match=selector.match(/data-work-history="(\\d+)"/);return match?dom.get('work-'+match[1]):null;}};dom.set(key,node);}node.isConnected=true;return node;};
  if(dialogOpen)host('table-scroll');
  for(const n of all){const key=n.type==='DialogContent'?'dialog':n.props['data-work-history']!=null?'work-'+n.props['data-work-history']:n.type+'-'+textOf(n).slice(0,80);const element=host(key);element.disabled=!!n.props.disabled;n.host=element;const ref=n.props.ref;if(ref&&typeof ref==='object')ref.current=element;else if(typeof ref==='function')ref(element);}
  document.querySelector=selector=>selector==='[role="dialog"]'&&dialogOpen?dom.get('dialog'):null;
 }
`);
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const {home,nodes,textOf}=await new AsyncFunction('test','assert','readFile','createRequire','vm','historyReplies','deferred',harness+'\nreturn {home,nodes,textOf};')(()=>{},assert,readFile,createRequire,vm,historyReplies,deferred);
async function modalWithTrigger(triggerKind){
 const h=home();await h.flush();let called=0;
 const trigger={isConnected:triggerKind!=='disconnected',disabled:triggerKind==='disabled',focus(options){called++;assert.equal(options.preventScroll,true);if(triggerKind!=='reject-focus')h.document.activeElement=this;}};
 const button=h.all().find(n=>n.type==='Button'&&n.props['aria-label']===`查看${h.state('data').accounts[0].label}的历史`);
 button.props.onClick({currentTarget:trigger});await h.flush();
 return {h,trigger,called:()=>called};
}
test('actual Home dialog close restores original author trigger without scrolling',async()=>{
 const {h,trigger,called}=await modalWithTrigger('valid');try{
  let prevented=0;h.all().find(n=>n.type==='DialogContent').props.onCloseAutoFocus({preventDefault(){prevented++;}});
  assert.equal(prevented,1);assert.equal(called(),1);assert.equal(h.document.activeElement,trigger);assert.equal(h.network.length,0);
 }finally{h.close();}
});
for(const kind of ['disconnected','disabled','reject-focus'])test(`actual Home dialog close has connected fallback when author trigger is ${kind}`,async()=>{
 const {h,trigger,called}=await modalWithTrigger(kind);try{
  h.all().find(n=>n.type==='DialogContent').props.onCloseAutoFocus({preventDefault(){}});
  assert.notEqual(h.document.activeElement,trigger);assert.equal(h.document.activeElement.isConnected,true);assert.equal(called(),kind==='reject-focus'?1:0);assert.equal(h.network.length,0);
 }finally{h.close();}
});

const modalNodes=h=>nodes(h.all().find(n=>n.type==='DialogContent'));
const control=(h,label)=>{const node=modalNodes(h).find(n=>n.type==='Button'&&textOf(n)===label);assert.ok(node,'actual control '+label);return node;};
async function click(h,label){const n=control(h,label);assert.notEqual(n.props.disabled,true);h.document.activeElement=n.host;n.props.onClick({currentTarget:n.host});await h.flush();await h.flush();}
async function worksReady(){
 historyReplies.clear();deferred.length=0;
 historyReplies.set('works/1.json',Array.from({length:41},(_,i)=>({id:i+1,targetId:1,caption:'synthetic '+(i+1),publishedAt:'2026-09-20T01:00:00.000Z',likes:i,comments:0,plays:null})));
 historyReplies.set('work-metrics/1.json',[{id:101,workId:21,targetId:1,capturedAt:'2026-09-29T01:00:00.000Z',likes:20}]);
 const h=home();await h.flush();const d=h.state('data');h.set('data',{...d,manifest:{...d.manifest,files:[...d.manifest.files,...['works','work-metrics'].map(kind=>({path:kind+'/1.json',sha256:'b'.repeat(64)}))]}});await h.flush();
 const start=h.all().find(n=>n.type==='Button'&&n.props['aria-label']===`查看${h.state('data').accounts[0].label}的历史`);start.props.onClick({currentTarget:start.host});await h.flush();
 await click(h,'全部保存作品');await click(h,'点赞');await click(h,'点赞 ↓');await click(h,'下一页');
 const dialog=h.document.querySelector('[role="dialog"]');dialog.scrollTop=410;dialog.querySelector('[data-history-table] [data-slot="table-container"]').scrollLeft=155;
 return h;
}
for(const activeKind of ['body','radix-container'])test(`actual Home restores row focus and both scroll positions after async return (${activeKind})`,async()=>{
 const h=await worksReady();try{
  await click(h,'查看指标历史');assert.equal(h.document.activeElement,control(h,'返回作品列表').host);
  historyReplies.set('works/1.json','defer');await click(h,'返回作品列表');assert.equal(h.state('history'),null);
  h.document.activeElement=activeKind==='body'?h.document.body:h.document.querySelector('[role="dialog"]');
  const job=deferred.shift();assert.equal(job.args.part,'works/1.json');job.resolve({items:Array.from({length:41},(_,i)=>({id:i+1,likes:i}))});await h.flush();await h.flush();
  assert.equal(h.state('hPage'),2);assert.equal(h.document.activeElement.key,'work-21');assert.equal(h.document.activeElement.lastOptions.preventScroll,true);
  const dialog=h.document.querySelector('[role="dialog"]');assert.equal(dialog.scrollTop,410);assert.equal(dialog.querySelector('[data-history-table] [data-slot="table-container"]').scrollLeft,155);
 }finally{h.close();}
});
test('actual Home late history cannot steal focus from a different user-selected control',async()=>{
 const h=await worksReady();try{
  await click(h,'查看指标历史');historyReplies.set('works/1.json','defer');await click(h,'返回作品列表');
  const other=control(h,'每日统计').host;h.document.activeElement=other;
  deferred.shift().resolve({items:Array.from({length:41},(_,i)=>({id:i+1,likes:i}))});await h.flush();await h.flush();
  assert.equal(h.document.activeElement,other);assert.equal(h.network.length,0);
 }finally{h.close();}
});
test('actual Home close during deferred return rejects late focus restore',async()=>{
 const h=await worksReady();try{
  await click(h,'查看指标历史');historyReplies.set('works/1.json','defer');await click(h,'返回作品列表');
  h.all().find(n=>n.type==='Dialog').props.onOpenChange(false);await h.flush();const active=h.document.activeElement;
  const job=deferred.shift();assert.equal(job.args.signal.aborted,true);job.resolve({items:[{id:21,likes:20}]});await h.flush();assert.equal(h.document.activeElement,active);assert.equal(h.state('account'),null);
 }finally{h.close();}
});
test('actual Home generation replacement discards pending focus and late response',async()=>{
 const h=await worksReady();try{
  await click(h,'查看指标历史');historyReplies.set('works/1.json','defer');await click(h,'返回作品列表');const old=deferred.shift();
  const data=h.state('data');historyReplies.set('works/1.json',[{id:99,likes:7}]);h.set('data',{...data,manifest:{...data.manifest,asOf:'2026-10-01T06:44:51.113Z'}});await h.flush();await h.flush();
  const active=h.document.activeElement;old.resolve({items:[{id:21,likes:200}]});await h.flush();await h.flush();
  assert.equal(old.args.signal.aborted,true);assert.equal(h.document.activeElement,active);assert.equal(h.state('hPage'),1);assert.deepEqual(h.state('history').items.map(x=>x.id),[99]);
 }finally{h.close();}
});
test('actual Home tab change invalidates deferred return and never focuses an unrendered work',async()=>{
 const h=await worksReady();try{
  await click(h,'查看指标历史');historyReplies.set('works/1.json','defer');await click(h,'返回作品列表');const old=deferred.shift();
  await click(h,'每日统计');const active=h.document.activeElement;old.resolve({items:[{id:21,likes:200}]});await h.flush();await h.flush();
  assert.equal(old.args.signal.aborted,true);assert.equal(h.document.activeElement,active);assert.equal(h.state('kind'),'daily');assert.equal(modalNodes(h).some(n=>n.props['data-work-history']===21),false);
 }finally{h.close();}
});
test('actual Home successful restore is single-shot and not repeated on unrelated renders',async()=>{
 const h=await worksReady();try{
  await click(h,'查看指标历史');await click(h,'返回作品列表');
  const target=h.document.activeElement;assert.equal(target.key,'work-21');const count=target.focusCalls;
  h.set('periodDraft','week');await h.flush();assert.equal(target.focusCalls,count);
  const other=control(h,'每日统计').host;h.document.activeElement=other;h.set('hOrder','desc');await h.flush();assert.equal(h.document.activeElement,other);assert.equal(target.focusCalls,count);
 }finally{h.close();}
});
test('actual Home deferred metrics entry focuses return control only after accepted history commit',async()=>{
 const h=await worksReady();try{
  historyReplies.set('work-metrics/1.json','defer');await click(h,'查看指标历史');assert.equal(h.state('history'),null);
  h.document.activeElement=h.document.querySelector('[role="dialog"]');const target=control(h,'返回作品列表').host;const prior=target.focusCalls;
  deferred.shift().resolve({items:[{id:101,workId:21,capturedAt:'2026-09-29T01:00:00.000Z',likes:20}]});await h.flush();await h.flush();
  assert.equal(target.focusCalls,prior+1);assert.equal(h.document.activeElement,target);assert.equal(h.document.querySelector('[role="dialog"]').scrollTop,0);
 }finally{h.close();}
});
test('actual Home metrics error does not focus an old work trigger or fabricate ready rows',async()=>{
 const h=await worksReady();try{
  historyReplies.set('work-metrics/1.json','defer');await click(h,'查看指标历史');const container=h.document.querySelector('[role="dialog"]');h.document.activeElement=container;
  deferred.shift().reject(new Error('synthetic history read failure'));await h.flush();await h.flush();
  assert.match(h.state('hError'),/synthetic history read failure/);assert.equal(h.state('history'),null);assert.equal(h.document.activeElement,container);
  await click(h,'返回作品列表');assert.equal(h.document.activeElement.key,'work-21');assert.equal(h.state('hPage'),2);assert.equal(h.network.length,0);
 }finally{h.close();}
});
test('actual Home return snapshot and sorting never mutate frozen source rows',async()=>{
 const h=await worksReady();try{
  const items=h.state('history').items;const originalIds=items.map(x=>x.id);items.forEach(Object.freeze);Object.freeze(items);
  await click(h,'点赞 ↑');assert.deepEqual(items.map(x=>x.id),originalIds);await click(h,'点赞 ↓');await click(h,'下一页');
  await click(h,'查看指标历史');await click(h,'返回作品列表');assert.equal(h.document.activeElement.key,'work-21');assert.deepEqual(items.map(x=>x.id),originalIds);assert.equal(Object.isFrozen(items),true);
 }finally{h.close();}
});
