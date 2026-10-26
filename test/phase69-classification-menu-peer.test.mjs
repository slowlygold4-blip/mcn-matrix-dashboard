import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {classificationMenu} from '../../mcn-public-site/lib/replica-classification-menu.mjs';
import {workspaceSelection,workspaceSelectionScope,workspaceSelectionPath} from '../../mcn-public-site/lib/replica-navigation.mjs';

const label=(key,name=key)=>({key,label:name});
const row=(id,labels=[],{enabled=true,board='matrix',theme='tuantuan'}={})=>({id,enabled,boardKeys:[board],classification:{theme:{key:theme,label:theme},labels}});
function freezeDeep(value){if(value&&typeof value==='object'){Object.values(value).forEach(freezeDeep);Object.freeze(value);}return value;}
const fixtures=()=>[
 row(1,[label('ai-remix','AI二创'),label('slice','切片'),label('custom:greeting','您好!')]),
 row(2,[label('original','原创'),label('slice','切片'),label('custom:plan','未来可能进AI')]),
 row(3,[label('slice','切片'),label('slice','切片'),label('custom:greeting','您好!')],{enabled:false}),
 row(4,[label('remix','二创'),label('custom:account','账号名称:团猪的日剧🐷')],{theme:'laofeiyu'}),
 row(5,[label('original','原创'),label('custom:other','其他来源')],{board:'other',enabled:false}),
];
const emptyScope={total:0,enabled:0,paused:0};

test('phase69 classification menu: empty catalog has no fabricated primary categories',()=>{
 assert.deepEqual(classificationMenu([]),{primary:[],source:[],retainedSelected:null,scope:emptyScope});
});
test('phase69 classification menu: exact stable primary keys have deterministic content order',()=>{
 const menu=classificationMenu(fixtures());
 assert.deepEqual(menu.primary.map(x=>x.key),['slice','original','ai-remix']);
 assert.deepEqual(menu.primary.find(x=>x.key==='slice'),{key:'slice',label:'切片',total:3,enabled:2,paused:1});
 assert.deepEqual(menu.scope,{total:5,enabled:3,paused:2});
});
test('phase69 classification menu: board AND theme scope excludes unrelated provenance options',()=>{
 const menu=classificationMenu(fixtures(),{board:'matrix',theme:'tuantuan'});
 assert.deepEqual(menu.scope,{total:3,enabled:2,paused:1});
 assert.deepEqual(menu.source.map(x=>x.key).sort(),['custom:greeting','custom:plan']);
 assert.equal(menu.primary.find(x=>x.key==='original').total,1);
 assert.equal(menu.source.some(x=>x.key==='custom:account'),false);
});
test('phase69 classification menu: disabled-only labels remain reachable as real saved history',()=>{
 const menu=classificationMenu(fixtures(),{board:'other'});
 assert.deepEqual(menu.scope,{total:1,enabled:0,paused:1});
 assert.deepEqual(menu.primary,[{key:'original',label:'原创',total:1,enabled:0,paused:1}]);
 assert.equal(menu.source[0].key,'custom:other');
 assert.equal(menu.source[0].enabled,0);
});
test('phase69 classification menu: source labels, plans, tier labels and nickname prose are never promoted by substring',()=>{
 const menu=classificationMenu([
  row(1,[label('custom:ai','AI二创'),label('custom:plan','未来可能进AI'),label('custom:tier','头部'),label('custom:hello','您好!')]),
  row(2,[label('remix','二创'),label('game','游戏内容'),label('live-hotspot','直播热点')]),
 ]);
 assert.deepEqual(menu.primary,[]);
 assert.equal(menu.source.length,7);
 assert.equal(menu.source.find(x=>x.key==='custom:plan').label,'未来可能进AI');
 assert.equal(menu.source.find(x=>x.key==='custom:hello').label,'您好!');
});
test('phase69 classification menu: duplicate per-account tags count once, multilabel counts overlap explicitly',()=>{
 const rows=[row(1,[label('slice','切片'),label('slice','切片'),label('original','原创')]),row(2,[label('ai-remix','AI二创'),label('slice','切片')])];
 const menu=classificationMenu(rows);
 assert.equal(menu.scope.total,2);
 assert.equal(menu.primary.reduce((sum,x)=>sum+x.total,0),4);
 assert.equal(menu.primary.find(x=>x.key==='slice').total,2);
});
test('phase69 classification menu: membership in more than one board never duplicates an account',()=>{
 const author=row(1,[label('slice','切片')]);author.boardKeys=['matrix','other','matrix'];
 assert.equal(classificationMenu([author],{board:'matrix'}).scope.total,1);
 assert.equal(classificationMenu([author],{board:'other'}).primary[0].total,1);
});
test('phase69 classification menu: source key, label and counts remain exact without truncation',()=>{
 const name='账号名称:团猪的日剧🐷 '+ '<script>alert("x")</script>' + '长描述'.repeat(30);
 const key='custom:00ABC';
 const menu=classificationMenu([row(1,[label(key,name)])],{selected:key});
 assert.deepEqual(menu.source,[{key,label:name,total:1,enabled:1,paused:0}]);
 assert.equal(menu.retainedSelected,null);
});
test('phase69 classification menu: primary labels are source-preserved and equal source labels keep separate exact keys',()=>{
 const menu=classificationMenu([row(1,[label('slice','来源切片称谓'),label('custom:B','同名来源'),label('custom:A','同名来源')])]);
 assert.equal(menu.primary[0].key,'slice');
 assert.equal(menu.primary[0].label,'来源切片称谓');
 assert.deepEqual(menu.source.map(x=>x.key),['custom:A','custom:B']);
 assert.deepEqual(menu.source.map(x=>x.label),['同名来源','同名来源']);
});
test('phase69 classification menu: selected source tag outside scope is retained at zero without resetting identity',()=>{
 const menu=classificationMenu(fixtures(),{theme:'tuantuan',selected:'custom:account'});
 assert.deepEqual(menu.retainedSelected,{key:'custom:account',label:'账号名称:团猪的日剧🐷',...emptyScope,outsideScope:true});
 assert.equal(menu.source.some(x=>x.key==='custom:account'),false);
});
test('phase69 classification menu: selected primary tag outside board scope is retained, never invented inside it',()=>{
 const menu=classificationMenu(fixtures(),{board:'other',selected:'ai-remix'});
 assert.deepEqual(menu.retainedSelected,{key:'ai-remix',label:'AI二创',...emptyScope,outsideScope:true});
 assert.equal(menu.primary.some(x=>x.key==='ai-remix'),false);
});
test('phase69 classification menu: existing URL scope roundtrips selected outside-scope tag and remains genuinely empty',()=>{
 const authors=fixtures(),selection=workspaceSelection('?theme=tuantuan&classification=custom%3Aaccount&period=week&start=2026-09-24&end=2026-10-01');
 const menu=classificationMenu(authors,{board:selection.board,theme:selection.theme,selected:selection.tag});
 assert.equal(menu.retainedSelected.key,selection.tag);
 assert.deepEqual(workspaceSelectionScope(selection,authors,[{key:'matrix'},{key:'other'}]),[]);
 const path=workspaceSelectionPath('/','accounts',selection);
 assert.deepEqual(workspaceSelection(path.slice(1).split('#')[0]),selection);
});
test('phase69 classification menu: missing selected identity fails rather than silently switching to all',()=>{
 assert.throws(()=>classificationMenu(fixtures(),{selected:'custom:does-not-exist'}));
 assert.throws(()=>classificationMenu([],{selected:'slice'}));
});
test('phase69 classification menu: source-label disagreement fails globally even when one row is outside scope',()=>{
 const authors=[row(1,[label('custom:fixed','原标签')]),row(2,[label('custom:fixed','冲突标签')],{theme:'other'})];
 assert.throws(()=>classificationMenu(authors,{theme:'tuantuan'}));
 assert.throws(()=>classificationMenu([row(1,[label('slice','切片'),label('slice','冲突标签')])]));
});
test('phase69 classification menu: duplicate canonical IDs and invalid source identities are rejected',()=>{
 assert.throws(()=>classificationMenu([row(1),row(1)]));
 for(const id of [0,-1,1.5,'1',NaN])assert.throws(()=>classificationMenu([row(id)]));
 for(const malformed of [{key:'',label:'来源'},{key:'x',label:''},{key:'x',label:1},{key:null,label:'来源'}])assert.throws(()=>classificationMenu([row(1,[malformed])]));
});
test('phase69 classification menu: frozen source catalog is not mutated and input-order permutation does not alter navigation',()=>{
 const authors=freezeDeep(fixtures()),before=JSON.stringify(authors);
 const normal=classificationMenu(authors,{theme:'tuantuan'});
 const reverse=classificationMenu([...authors].reverse(),{theme:'tuantuan'});
 assert.deepEqual(normal,reverse);
 assert.equal(JSON.stringify(authors),before);
});
test('phase69 classification menu: canonically equivalent but exact-distinct source keys have stable non-merging order',()=>{
 const authors=[row(1,[label('custom:\u00e9','同名来源')]),row(2,[label('custom:e\u0301','同名来源')])];
 const forward=classificationMenu(authors),reverse=classificationMenu([...authors].reverse());
 assert.equal(forward.source.length,2);
 assert.deepEqual(forward,reverse);
 assert.deepEqual(new Set(forward.source.map(x=>x.key)),new Set(['custom:\u00e9','custom:e\u0301']));
});

const siteRequire=createRequire(new URL('../../mcn-public-site/package.json',import.meta.url));
function loadControl(){
 const ts=siteRequire('typescript');
 const source=fs.readFileSync(new URL('../../mcn-public-site/app/page.tsx',import.meta.url),'utf8');
 const ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const render=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='renderClassificationFilter');
 assert.ok(render,'real page uses one pure native classification render helper');
 const compiled=ts.transpileModule(render.getText(ast)+'\nexport {renderClassificationFilter};',{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const context={exports:{},module:{exports:{}},require:siteRequire};context.module.exports=context.exports;
 vm.runInNewContext(compiled,context,{filename:'classification-filter.peer.cjs',timeout:1000});
 return ({menu,value,onValueChange})=>context.exports.renderClassificationFilter(menu,value,onValueChange);
}
function flatten(element){if(element==null||typeof element==='boolean')return [];if(Array.isArray(element))return element.flatMap(flatten);if(typeof element!=='object')return [element];return [element,...flatten(element.props?.children)];}
test('phase69 real native control: scoped primary/source groups, exact option values and all option use semantic selects',()=>{
 const Control=loadControl(),menu=classificationMenu(fixtures(),{board:'matrix',theme:'tuantuan'});
 const tree=Control({menu,value:'slice',onValueChange:()=>{}}),nodes=flatten(tree),selects=nodes.filter(x=>x?.type==='select');
 assert.equal(selects.length,1);
 assert.equal(selects[0].props.value,'slice');
 const options=nodes.filter(x=>x?.type==='option');
 assert.deepEqual(options.map(x=>x.props.value).sort(),['all',...menu.primary.map(x=>x.key),...menu.source.map(x=>x.key)].sort());
 const groups=nodes.filter(x=>x?.type==='optgroup');
 assert.deepEqual(groups.map(x=>x.props.label),['常用内容类型','来源标签']);
 let changed;const controlled=flatten(Control({menu,value:'slice',onValueChange:x=>{changed=x;}})).find(x=>x?.type==='select');
 controlled.props.onChange({target:{value:'original'}});
 assert.equal(changed,'original');
});
test('phase69 real native control: retained selection stays selected and visibly explains zero scoped accounts',()=>{
 const Control=loadControl(),menu=classificationMenu(fixtures(),{theme:'tuantuan',selected:'custom:account'});
 const tree=Control({menu,value:'custom:account',onValueChange:()=>{}}),nodes=flatten(tree);
 assert.equal(nodes.find(x=>x?.type==='select').props.value,'custom:account');
 const retained=nodes.filter(x=>x?.type==='option'&&x.props.value==='custom:account');
 assert.equal(retained.length,1);
 assert.equal(nodes.some(x=>x?.type==='optgroup'&&x.props.label==='当前选择（不在此范围）'),true);
 const rendered=siteRequire('react-dom/server').renderToStaticMarkup(tree);
 assert.match(rendered,/value="custom:account"[^>]*selected=""/);
 assert.match(rendered,/0[^<]*账号/);
});
test('phase69 real native control: provenance text is React escaped, never rendered as active source HTML',()=>{
 const Control=loadControl(),menu=classificationMenu([row(1,[label('custom:html','<script>alert("x")</script>')])]);
 const rendered=siteRequire('react-dom/server').renderToStaticMarkup(Control({menu,value:'all',onValueChange:()=>{}}));
 assert.equal(rendered.includes('<script>'),false);
 assert.ok(rendered.includes('&lt;script&gt;'));
 assert.match(rendered,/value="custom:html"/);
});
test('phase69 real native control: empty loading menu is usable and has a programmatic accessible name',()=>{
 const Control=loadControl(),tree=Control({menu:classificationMenu([]),value:'all',onValueChange:()=>{}}),nodes=flatten(tree);
 const select=nodes.find(x=>x?.type==='select');
 assert.equal(select.props.value,'all');
 assert.deepEqual(nodes.filter(x=>x?.type==='option').map(x=>x.props.value),['all']);
 const wrappingLabel=nodes.some(x=>x?.type==='label'&&flatten(x.props.children).includes(select));
 assert.ok(wrappingLabel||typeof select.props['aria-label']==='string'||typeof select.props['aria-labelledby']==='string');
});
test('phase69 real page wiring: one pure native render helper uses classification data without replacing roster URL/filter semantics',()=>{
 const ts=siteRequire('typescript'),source=fs.readFileSync(new URL('../../mcn-public-site/app/page.tsx',import.meta.url),'utf8');
 const ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const imports=ast.statements.filter(ts.isImportDeclaration).map(n=>n.moduleSpecifier.text);
 assert.ok(imports.includes('@/lib/replica-classification-menu.mjs'));
 assert.ok(imports.includes('@/lib/replica-navigation.mjs'));
 let helperCalls=0,controls=0;
 function walk(n){if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&n.expression.text==='classificationMenu')helperCalls++;if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&n.expression.text==='renderClassificationFilter')controls++;ts.forEachChild(n,walk);}
 walk(ast);assert.ok(helperCalls>=1);assert.equal(controls,1);
});
function runRealPageMenuMemo(state){
 const ts=siteRequire('typescript'),source=fs.readFileSync(new URL('../../mcn-public-site/app/page.tsx',import.meta.url),'utf8');
 const ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let callback;
 function walk(n){if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.name.text==='classificationState'&&ts.isCallExpression(n.initializer))callback=n.initializer.arguments[0];ts.forEachChild(n,walk);}
 walk(ast);assert.ok(callback,'real page classificationState memo must remain reviewable');
 const compiled=ts.transpileModule(`exports.build = ${callback.getText(ast)};`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const context={exports:{},classificationMenu,data:null,board:'all',theme:'all',tag:'all',linkError:'',...state};
 vm.runInNewContext(compiled,context,{filename:'page-classification-memo.peer.cjs',timeout:1000});
 return context.exports.build();
}
test('phase69 real page memo: a saved source URL does not throw before its catalog has loaded',()=>{
 const pending=runRealPageMenuMemo({data:null,tag:'custom:account'});
 assert.equal(pending.error,'');
 assert.deepEqual(pending.menu.scope,emptyScope);
});
test('phase69 real page memo: invalid URL state stays in its captured link error instead of crashing the render',()=>{
 const failed=runRealPageMenuMemo({data:{accounts:fixtures()},tag:'missing',linkError:'链接中的分类不存在'});
 assert.equal(failed.error,'');
 assert.deepEqual(failed.menu.scope,emptyScope);
});
test('phase69 real page memo: malformed metadata is surfaced as an error rather than silently becoming all data',()=>{
 const missing=runRealPageMenuMemo({data:{accounts:fixtures()},tag:'missing'});
 assert.ok(missing.error.includes('内容分类不存在'));
 assert.deepEqual(missing.menu.scope,emptyScope);
 const conflicting=runRealPageMenuMemo({data:{accounts:[row(1,[label('slice','切片')]),row(2,[label('slice','另一称谓')])]}});
 assert.ok(conflicting.error.includes('分类名称冲突'));
 assert.deepEqual(conflicting.menu.scope,emptyScope);
});
test('phase69 real page memo: outside-scope source selection stays available through the actual board/theme hook',()=>{
 const state=runRealPageMenuMemo({data:{accounts:fixtures()},board:'matrix',theme:'tuantuan',tag:'custom:account'});
 assert.equal(state.error,'');
 assert.equal(state.menu.retainedSelected.key,'custom:account');
 assert.equal(state.menu.retainedSelected.total,0);
 assert.equal(state.menu.scope.total,3);
});
test('phase69 real page load: globally conflicting source metadata is rejected before becoming renderable state',async()=>{
 const ts=siteRequire('typescript'),source=fs.readFileSync(new URL('../../mcn-public-site/app/page.tsx',import.meta.url),'utf8');
 const ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let loadFunction;
 function walk(n){if(ts.isFunctionDeclaration(n)&&n.name?.text==='load')loadFunction=n;ts.forEachChild(n,walk);}
 walk(ast);assert.ok(loadFunction,'real page load must remain reviewable');
 const compiled=ts.transpileModule(loadFunction.getText(ast)+'\nexports.load = load;',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const errors=[],published=[];
 const authors=[row(1,[label('slice','切片')]),row(2,[label('slice','另一来源称谓')])];
 const noOp=()=>{};
 const context={
  exports:{},AbortController,loadEpoch:{current:0},loadController:{current:null},setLoading:noOp,setError:x=>errors.push(x),
  withReplicaReadDeadline:async({operation})=>operation(),workspaceNavigation:()=>({personal:null}),
  window:{location:{search:'',hash:'#overview'}},setLinkError:noOp,setPersonal:noOp,
  fetch:async()=>({ok:true,json:async()=>({manifest:{asOf:'2026-10-01T14:17:26.276Z',files:[]}})}),
  loadReplicaView:async()=>({accounts:authors,points:[],boards:[],summaryLoaded:false}),requestedRange:null,selectionRef:{current:null},
  classificationMenu,rowsFor:noOp,accountCoverage:noOp,workspaceSelectionScope,initialized:{current:true},
  setData:x=>published.push(x),setAvailable:noOp,setAccount:noOp,setHistory:noOp,
 };
 vm.runInNewContext(compiled,context,{filename:'page-load.peer.cjs',timeout:1000});
 await context.exports.load();
 assert.equal(published.length,0,'invalid source metadata must not enter the state rendered by GroupSummary');
 assert.ok(errors.some(x=>String(x).includes('分类名称冲突')));
});
