import {test} from 'node:test';
import assert from 'node:assert/strict';
import {workspaceSelection,workspaceSelectionPath,workspaceSelectionScope,workspaceNavigation,navigationNeedsLoad} from '../../mcn-public-site/lib/replica-navigation.mjs';
import {dailyCoverageMembers} from '../../mcn-public-site/lib/daily-coverage-view.mjs';
import {orderRows,rowsFor} from '../../mcn-public-site/lib/replica-model.mjs';
import {captureWorkspaceReturn,workspaceReturnPath} from '../../mcn-public-site/lib/replica-return.mjs';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';

const generation='2026-10-01T05:44:51.113Z';
const selection={board:'tuantuan-roster',theme:'tuantuan',tag:'slice',period:'custom',start:'2026-09-12',end:'2026-10-01'};
const author=(id,label='同名作者',platform='douyin')=>({id,label,platform,enabled:true,boardKeys:['tuantuan-roster'],classification:{theme:{key:'tuantuan',label:'团团'},labels:[{key:'slice',label:'切片'}]}});
const point=(id,date,value)=>({targetId:id,date,capturedAt:date+'T03:00:00.000Z',followers:value,followersAt:date+'T03:00:00.000Z',likes:value,likesAt:date+'T03:00:00.000Z',posts:value,postsAt:date+'T03:00:00.000Z'});

test('candidate same-origin return path preserves validated scope and exact A dates',()=>{
 const path=workspaceSelectionPath('/','overview',selection),url=new URL(path,'https://public.example');
 assert.equal(url.origin,'https://public.example');
 assert.equal(url.hash,'#overview');
 assert.deepEqual(workspaceSelection(url.search),selection);
 assert.equal(workspaceNavigation(url.search,url.hash).tab,'overview');
 for(const pathname of ['//other.example/','https://other.example/','/x?return=x','/x#account','/x\r\n'])assert.throws(()=>workspaceSelectionPath(pathname,'overview',selection));
});

test('return scope retains stable IDs across same labels and multiple platforms',()=>{
 const accounts=[author(13),author(7,'同名作者','bilibili'),{...author(41),enabled:false},author(3,'其他')];
 accounts[3].classification.theme={key:'yangqijia',label:'杨齐家'};
 const selected=workspaceSelectionScope(selection,accounts,[{key:'tuantuan-roster'}]);
 assert.deepEqual(selected.map(a=>a.id),[13,7]);
 assert.equal(selected[0].label,selected[1].label);
 assert.notEqual(selected[0].platform,selected[1].platform);
});

test('same publication personal routing validates identity without requiring unrelated global reload',()=>{
 const route=workspaceNavigation('?'+new URLSearchParams({account:'13',start:selection.start,end:selection.end,generation}), '#topics');
 assert.equal(route.personal.id,13);
 assert.equal(route.personal.generation,generation);
 assert.equal(route.tab,'accounts');
 assert.equal(navigationNeedsLoad(route,{manifest:{asOf:generation},summaryLoaded:true}),false);
 assert.equal(navigationNeedsLoad(route,{manifest:{asOf:'2026-10-01T03:56:19.682Z'},summaryLoaded:true}),true);
});

test('47 member drilldown can page without losing or merging same-name identities',()=>{
 const accounts=Array.from({length:47},(_,i)=>author(700-i));
 const points=accounts.map(a=>point(a.id,'2026-09-20',0));
 const rows=dailyCoverageMembers(accounts,points,{date:'2026-09-20',metric:'followers',reason:'missingBaseline'});
 const pages=[rows.slice(0,20),rows.slice(20,40),rows.slice(40,60)];
 assert.deepEqual(pages.map(p=>p.length),[20,20,7]);
 assert.deepEqual(pages.flat().map(a=>a.id),Array.from({length:47},(_,i)=>654+i));
 assert.equal(new Set(pages.flat().map(a=>a.id)).size,47);
 assert.ok(rows.every(r=>r.currentValue===0&&r.baselineValue===null&&r.delta===null));
});

test('member context must be metric-specific and distinguish current missing from baseline missing',()=>{
 const accounts=[author(13),author(7)],points=[point(13,'2026-09-20',20),point(7,'2026-09-19',10)];
 points[0].likes=null;points[0].likesAt=null;
 assert.deepEqual(dailyCoverageMembers(accounts,points,{date:'2026-09-20',metric:'followers',reason:'missingBaseline'}).map(a=>a.id),[13]);
 assert.deepEqual(dailyCoverageMembers(accounts,points,{date:'2026-09-20',metric:'likes',reason:'missingCurrent'}).map(a=>a.id),[7,13]);
 assert.throws(()=>dailyCoverageMembers(accounts,points,{date:'2026-09-20',metric:'views',reason:'missingCurrent'}));
 assert.throws(()=>dailyCoverageMembers(accounts,points,{date:'2026-09-20',metric:'likes',reason:'unavailable'}));
});

test('numeric ordering keeps exact zero and negative before missing in both directions',()=>{
 const accounts=[author(13),author(7),author(19),author(2)],points=[point(13,'2026-09-19',10),point(13,'2026-09-20',9),point(7,'2026-09-19',0),point(7,'2026-09-20',0),point(19,'2026-09-19',10),point(19,'2026-09-20',12)];
 const rows=rowsFor(accounts,points,'2026-09-19','2026-09-20');
 assert.deepEqual(orderRows(rows,'followers.delta','asc').map(a=>a.id),[13,7,19,2]);
 assert.deepEqual(orderRows(rows,'followers.delta','desc').map(a=>a.id),[19,7,13,2]);
 assert.deepEqual(orderRows(rows,'label','asc').map(a=>a.id),[2,7,13,19]);
 assert.deepEqual(orderRows(rows,'label','desc').map(a=>a.id),[2,7,13,19]);
});

test('saved return dates fail closed rather than silently repair malformed or reversed bounds',()=>{
 for(const range of [{start:'2026-09-31',end:'2026-10-01'},{start:'2026-10-01',end:'2026-09-12'},{start:'2026-09-12',end:null}])assert.throws(()=>workspaceSelectionPath('/','overview',{...selection,...range}));
 assert.throws(()=>workspaceSelection('?theme=tuantuan&theme=other&period=custom&start=2026-09-12&end=2026-10-01'));
});

const savedAddress=()=>{
 const url=new URL(workspaceSelectionPath('/','overview',selection),'https://public.example');
 return {pathname:url.pathname,search:url.search,hash:url.hash,generation};
};
const captureRejects=input=>{
 let value;
 try{value=captureWorkspaceReturn(input);}catch{return;}
 assert.equal(value,null,'invalid input must never produce a reusable return context');
};

test('return capture uses immutable canonical global scope, not account identity',()=>{
 const input=Object.freeze(savedAddress()),copy=JSON.stringify(input),context=captureWorkspaceReturn(input);
 assert.ok(Object.isFrozen(context));
 assert.deepEqual(Object.keys(context).sort(),['generation','path']);
 assert.equal(context.generation,generation);
 assert.equal(context.path,workspaceSelectionPath('/','overview',selection));
 assert.equal(JSON.stringify(input),copy);
 assert.throws(()=>{context.generation='2026-10-01T00:00:00.000Z';},TypeError);
 assert.equal(workspaceReturnPath(context,{pathname:'/',generation}),context.path);
});

test('return context cannot cross pathname or fixed publication and does not silently use another version',()=>{
 const context=captureWorkspaceReturn(savedAddress());
 assert.equal(workspaceReturnPath(context,{pathname:'/another',generation}),null);
 assert.equal(workspaceReturnPath(context,{pathname:'/',generation:'2026-10-01T03:56:19.682Z'}),null);
 assert.equal(workspaceReturnPath(context,{pathname:'/',generation:'not-a-version'}),null);
 assert.equal(workspaceReturnPath(context,{pathname:'//other.example/',generation}),null);
 assert.equal(workspaceReturnPath(null,{pathname:'/',generation}),null);
});

test('return capture rejects external paths, personal routes and duplicate or malformed global date links',()=>{
 for(const pathname of ['https://other.example/','//other.example/','/x?bad','/x#bad','/x\n'])captureRejects({...savedAddress(),pathname});
 for(const search of [
  '?account=13&generation='+encodeURIComponent(generation),
  '?generation='+encodeURIComponent(generation),
  '?theme=tuantuan&theme=other',
  '?period=custom&start=2026-09-31&end=2026-10-01',
  '?period=custom&start=2026-10-01&end=2026-09-12',
  '?period=custom&start=2026-09-12',
 ])captureRejects({...savedAddress(),search});
 for(const invalid of ['not-a-version','2026-10-01T05:44:51Z','2026-02-30T00:00:00.000Z'])captureRejects({...savedAddress(),generation:invalid});
});

test('return consumption rejects extra fields and tampered stored paths rather than redirecting',()=>{
 const context=captureWorkspaceReturn(savedAddress());
 const current={pathname:'/',generation};
 assert.equal(workspaceReturnPath({...context,account:13},current),null);
 for(const path of ['https://other.example/','//other.example/','/?account=13#overview','/?period=custom&start=2026-09-31&end=2026-10-01#overview','/#accounts\n'])assert.equal(workspaceReturnPath({...context,path},current),null);
});

const site=new URL('../../mcn-public-site/',import.meta.url);
const requireSite=createRequire(new URL('package.json',site));
const ts=requireSite('typescript');
const dailySource=await readFile(new URL('components/daily-coverage-panel.tsx',site),'utf8');
const dailyAst=ts.createSourceFile('daily.tsx',dailySource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function jsxExpression(tag,attribute,guard=()=>true){
 let expression;
 function visit(node){
  if(ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node)){
   if(node.tagName.getText(dailyAst)===tag&&guard(node)){
    const property=node.attributes.properties.find(p=>ts.isJsxAttribute(p)&&p.name.getText(dailyAst)===attribute);
    if(property?.initializer&&ts.isJsxExpression(property.initializer)&&property.initializer.expression)expression=property.initializer.expression.getText(dailyAst);
   }
  }
  ts.forEachChild(node,visit);
 }
 visit(dailyAst);assert.ok(expression,`actual ${tag}.${attribute} expression not found`);return expression;
}
const hasClass=(node,name)=>node.attributes.properties.some(p=>ts.isJsxAttribute(p)&&p.name.getText(dailyAst)==='className'&&ts.isStringLiteral(p.initializer)&&p.initializer.text.split(' ').includes(name));

test('actual DailyCoverage author callback retains drill and uses stable selected identity',()=>{
 const source=jsxExpression('Button','onClick',node=>hasClass(node,'author'));
 for(const id of [13,99]){
  const authors=[author(7),author(13)],selected=[];let cleared=0;
  const click=vm.runInNewContext('('+source+')',{accounts:authors,a:{id},onAccount:a=>selected.push(a),setDrill:()=>cleared++});
  click();assert.equal(cleared,0,'visiting an author must not clear the retained gap context');
  assert.deepEqual(selected,id===13?[authors[1]]:[]);
 }
});

test('actual DailyCoverage portal is closed while suspended and reopens only valid retained drill',()=>{
 const source=jsxExpression('Dialog','open');
 for(const [drill,ready,suspended,expected] of [[{date:'2026-09-20',reason:'missingBaseline'},true,false,true],[{date:'2026-09-20',reason:'missingBaseline'},true,true,false],[{date:'2026-09-20',reason:'missingBaseline'},false,false,false],[null,true,false,false]]){
  assert.equal(vm.runInNewContext(source,{drill,ready,suspended}),expected);
 }
});

test('actual gap close autofocus never targets suspended or hidden workspace nodes',()=>{
 const source=jsxExpression('DialogContent','onCloseAutoFocus',node=>hasClass(node,'daily-gap-dialog'));
 for(const [suspended,hidden,connected,expected] of [[true,false,true,0],[false,true,true,0],[false,false,false,0],[false,false,true,1]]){
  let focused=0,prevented=0;
  const target={isConnected:connected,closest:selector=>{assert.equal(selector,'[hidden]');return hidden?{}:null;},focus:()=>focused++};
  const close=vm.runInNewContext('('+source+')',{suspended,returnFocus:{current:target}});
  close({preventDefault:()=>prevented++});assert.equal(prevented,1);assert.equal(focused,expected);
 }
});
