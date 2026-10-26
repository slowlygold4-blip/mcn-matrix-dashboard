// Independent Phase79: actual Home and actual classification renderer. Offline
// source execution + real React static DOM, not live browser keyboard/layout QA.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import vm from 'node:vm';

const SITE=new URL('../../mcn-public-site/',import.meta.url),requireSite=createRequire(new URL('package.json',SITE));
const oldUrl=new URL('./phase66-workspace-state-peer.test.mjs',import.meta.url),oldHarness=await readFile(oldUrl,'utf8');
const code=oldHarness.replace(/^import[^\n]*\n/gm,'').replaceAll('import.meta.url',JSON.stringify(oldUrl.href));
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const {home,nodes,textOf,button,fixture,ts,six,asOf}=await new AsyncFunction('test','assert','readFile','createRequire','vm',code+'\nreturn {home,nodes,textOf,button,fixture,ts,six,asOf};')(()=>{},assert,readFile,createRequire,vm);
const compile=s=>ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const react=requireSite('react'),render=requireSite('react-dom/server').renderToStaticMarkup;
const model=await import(new URL('lib/replica-model.mjs',SITE)),exporter=await import(new URL('lib/replica-export.mjs',SITE));
const componentUrl=new URL('components/account-classification.tsx',SITE),exports={},virtual={},jsx=(type,props,key)=>({type,props:props||{},key});
let componentSource='',loadError=null;
try{componentSource=await readFile(componentUrl,'utf8');}catch(e){loadError=e;}
if(componentSource){
 vm.runInNewContext(compile(componentSource),{exports,require(spec){return requireSite(spec);}},{filename:'phase79-real-account-classification.cjs'});
 vm.runInNewContext(compile(componentSource),{exports:virtual,require(spec){if(spec==='react/jsx-runtime')return {jsx,jsxs:jsx,Fragment:'Fragment'};return requireSite(spec);}},{filename:'phase79-real-account-classification-tree.cjs'});
}
const deep=x=>JSON.parse(JSON.stringify(x));
const labels=n=>Array.from({length:n},(_,i)=>({key:'label-'+i,label:i<2?['切片','原创'][i]:`真实来源标签${i+1} · 长字段中文与 English ${i+1}，不是昵称猜测`}));
const classification=(n,theme='已确认大主题')=>({theme:{key:'peer',label:theme},labels:labels(n)});
const sourceSHA=createHash('sha256').update(await readFile(new URL('app/page.tsx',SITE))).digest('hex');
console.info('Phase79 actual Home SHA256 '+sourceSHA+'; renderer '+(componentSource?createHash('sha256').update(componentSource).digest('hex'):'not present'));

function expand(n){
 if(n==null||typeof n!=='object')return n;
 if(Array.isArray(n))return n.map(expand);
 if(n.type==='AccountClassification'){
  assert.equal(typeof virtual.AccountClassification,'function','actual classification renderer must exist');
  return expand(virtual.AccountClassification(n.props));
 }
 return {...n,props:{...n.props,children:expand(n.props?.children)}};
}
function closedText(n){
 if(n==null||typeof n==='boolean')return '';
 if(Array.isArray(n))return n.map(closedText).join('');
 if(typeof n!=='object')return String(n);
 if(n.type==='details'&&!n.props?.open)return closedText(nodes(n.props.children).find(x=>x.type==='summary'));
 return closedText(n.props?.children);
}
const detail=n=>nodes(n).filter(x=>x.type==='details'),summaries=n=>nodes(n).filter(x=>x.type==='summary');
const row=(h,id)=>{const n=h.all().find(n=>n.type==='TableRow'&&n.key===id);assert.ok(n,'actual account row missing '+id);return n;};
const cell=(h,id)=>expand(nodes(row(h,id)).find(n=>n.type==='TableCell'));
async function workspace(n=7){const h=home();await h.flush();const f=fixture();f.accounts=f.accounts.map(a=>({...a,classification:classification(n)}));h.set('data',f);await h.flush();return h;}
function renderer(value){assert.equal(typeof exports.AccountClassification,'function',loadError?.message||'actual renderer missing');return render(react.createElement(exports.AccountClassification,{classification:value}));}
function widgetTree(value){assert.equal(typeof virtual.AccountClassification,'function');return expand(virtual.AccountClassification({classification:value}));}

test('phase79 actual Home: default fixed author cell does not always expose all seven labels',async()=>{
 const h=await workspace();try{
  const c=cell(h,1),visible=closedText(c);assert.ok(visible.includes('已确认大主题'));assert.ok(visible.includes('切片'));assert.ok(visible.includes('原创'));
  for(const tag of labels(7).slice(2))assert.equal(visible.includes(tag.label),false,'collapsed author cell must not always expose '+tag.key);
  assert.equal(detail(c).length,1,'actual author row needs one native disclosure');assert.equal(summaries(c).length,1);assert.equal(detail(c)[0].props.open===true,false);
  assert.match(textOf(summaries(c)[0]),/5/);for(const tag of labels(7))assert.ok(textOf(c).includes(tag.label),'full label missing '+tag.key);
  assert.equal(h.network.length,0);
 }finally{h.close();}
});

test('phase79 actual renderer: zero, one and two labels retain full exact labels without fake remainder',()=>{
 for(const n of [0,1,2]){const value=classification(n),before=deep(value),tree=widgetTree(value),markup=renderer(value);
  assert.equal(detail(tree).length,0);assert.equal(summaries(tree).length,0);assert.ok(markup.includes('已确认大主题'));
  for(const tag of value.labels)assert.ok(markup.includes(tag.label));if(!n)assert.ok(markup.includes('暂无确认分类'));
  assert.deepEqual(value,before);assert.doesNotMatch(markup,/<details\b/);
 }
});

test('phase79 actual renderer: third and later full labels are native summary-controlled rather than deleted or invented',()=>{
 for(const n of [3,7,25]){const value=classification(n),before=deep(value),tree=widgetTree(value),markup=renderer(value),d=detail(tree);
  assert.equal(d.length,1);assert.equal(summaries(d[0]).length,1);assert.equal(d[0].props.open===true,false);assert.match(textOf(summaries(d[0])[0]),new RegExp(String(n-2)));
  assert.match(markup,/<details\b/);assert.match(markup,/<summary\b/);assert.doesNotMatch(markup,/<summary[^>]*(?:tabindex="-1"|aria-hidden="true")/i);
  assert.doesNotMatch(markup,/<details[^>]*\sopen(?:[\s=>])/i);assert.doesNotMatch(markup,/<(?:button|a)\b/);
  for(const [i,tag] of value.labels.entries()){assert.ok(markup.includes(tag.label),'full exact text retained '+tag.key);assert.equal(closedText(tree).includes(tag.label),i<2);}
  assert.deepEqual(value,before);
 }
});

test('phase79 actual renderer: Unicode, long names and angle brackets stay escaped and data order unchanged',()=>{
 const value=classification(5,'未知归属 · 保留原主题');value.labels=[{key:'1',label:'含重复文案'},{key:'2',label:'含重复文案'},{key:'3',label:'<script>真实标签 & "不执行"</script>'},{key:'4',label:'超长中文标签'.repeat(25)},{key:'5',label:'团团 OvO 🟢 e\u0301'}];
 const before=deep(value),markup=renderer(value),tree=widgetTree(value);assert.ok(markup.includes('未知归属'));assert.doesNotMatch(markup,/<script>/);assert.ok(markup.includes('&lt;script&gt;'));
 assert.equal(detail(tree).length,1);assert.match(textOf(summaries(tree)[0]),/3/);assert.equal((textOf(tree).match(/含重复文案/g)||[]).length,2);
 const all=textOf(tree);for(let i=1;i<value.labels.length;i++)assert.ok(all.lastIndexOf(value.labels[i].label)>=all.indexOf(value.labels[i-1].label));assert.deepEqual(value,before);
});

test('phase79 actual Home: expandability does not change stable ID, operating cards, classification filters or complete CSV',async()=>{
 const h=await workspace();try{
  const before=deep(h.state('data')),beforeMetrics=deep(h.all().find(n=>n.type==='MetricLedger').props.metrics),address=h.window.location.href;
  for(const id of [1,2]){const c=cell(h,id);assert.equal(detail(c).length,1);const actions=nodes(row(h,id)).filter(n=>n.type==='Button');assert.ok(actions.some(n=>String(n.props['aria-label']||'').includes('经营详情')));assert.ok(actions.some(n=>String(n.props['aria-label']||'').includes('历史')));}
  const menu=h.all().find(n=>n.type==='select'&&n.props['aria-describedby']==='classification-menu-help');assert.ok(menu);const options=nodes(menu).filter(n=>n.type==='option');for(const tag of labels(7))assert.ok(options.some(n=>n.props.value===tag.key));
  button(h,'导出全部结果').props.onClick();const blob=h.downloads.at(-1).blob,csv=await blob.text();assert.equal(csv.trimEnd().split(/\r?\n/).length,23);
  const actualRows=model.orderRows(model.rowsFor(before.accounts,before.points,six.start,six.end).filter(a=>a.enabled),'followers.delta','desc');
  // Blob.text strips the UTF-8 BOM by standard decoding; compare actual bytes
  // instead so the existing spreadsheet BOM is explicitly preserved, not waived.
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),new TextEncoder().encode(model.csv(exporter.accountExport(actualRows,before.manifest,six.start,six.end))),'existing CSV bytes/BOM/order/source identity must stay exact');
  // Current accountExport includes the large theme, not secondary labels. Do not
  // pretend UI disclosure adds CSV columns or alter that production contract.
  assert.ok(csv.includes('已确认大主题'));
  assert.deepEqual(h.state('data'),before);assert.deepEqual(deep(h.all().find(n=>n.type==='MetricLedger').props.metrics),beforeMetrics);assert.equal(h.window.location.href,address);assert.equal(h.network.length,0);
 }finally{h.close();}
});

test('phase79 actual Home: page2 renders each own classification and keeps pause status and exact missing metric',async()=>{
 const h=await workspace();try{
  const f=deep(h.state('data'));f.accounts[20].classification=classification(3,'第二页独有主题');f.accounts[21].classification=classification(0,'第二页另一个主题');h.set('data',f);await h.flush();
  button(h,'下一页').props.onClick();await h.flush();assert.equal(h.state('page'),2);const a=cell(h,21),b=cell(h,22);assert.ok(closedText(a).includes('第二页独有主题'));assert.equal(detail(a).length,1);assert.equal(detail(b).length,0);assert.ok(closedText(b).includes('暂无确认分类'));assert.equal(closedText(b).includes('第二页独有主题'),false);
  const status=h.all().find(n=>n.type==='select'&&nodes(n).some(c=>c.type==='option'&&c.props.value==='paused'));status.props.onChange({target:{value:'all'}});await h.flush();button(h,'下一页').props.onClick();await h.flush();assert.ok(closedText(cell(h,23)).includes('暂停'));
  const firstMetrics=h.state('data').points.filter(p=>p.targetId===2);assert.equal(firstMetrics.at(-1).likes,null);assert.equal(h.network.length,0);
 }finally{h.close();}
});

test('phase79 actual Home: identical author names do not cross-bind label disclosures or themes',async()=>{
 const h=await workspace();try{
  const f=deep(h.state('data'));f.accounts[0]={...f.accounts[0],label:'完全相同的作者名称',classification:classification(3,'来源确认主题A')};f.accounts[1]={...f.accounts[1],label:'完全相同的作者名称',classification:classification(7,'来源确认主题B')};h.set('data',f);await h.flush();
  const a=cell(h,1),b=cell(h,2);assert.ok(closedText(a).includes('来源确认主题A'));assert.equal(closedText(a).includes('来源确认主题B'),false);assert.ok(closedText(b).includes('来源确认主题B'));
  assert.match(textOf(summaries(a)[0]),/1/);assert.match(textOf(summaries(b)[0]),/5/);assert.equal(textOf(a).includes(labels(7)[6].label),false);assert.ok(textOf(b).includes(labels(7)[6].label));assert.equal(h.state('data').accounts[0].id,1);assert.equal(h.state('data').accounts[1].id,2);assert.equal(h.network.length,0);
 }finally{h.close();}
});

test('phase79 actual Home: current classification props refresh without stale disclosure counts or changing numeric endpoints',async()=>{
 const h=await workspace(1);try{
  const metrics=deep(h.all().find(n=>n.type==='MetricLedger').props.metrics),points=deep(h.state('data').points);assert.equal(detail(cell(h,1)).length,0);
  const f=deep(h.state('data'));f.accounts[0].classification=classification(7,'新确认主题');h.set('data',f);await h.flush();assert.equal(detail(cell(h,1)).length,1);assert.match(textOf(summaries(cell(h,1))[0]),/5/);assert.ok(closedText(cell(h,1)).includes('新确认主题'));assert.equal(detail(cell(h,2)).length,0);
  assert.deepEqual(h.state('data').points,points);assert.deepEqual(deep(h.all().find(n=>n.type==='MetricLedger').props.metrics),metrics);assert.equal(h.network.length,0);
 }finally{h.close();}
});
