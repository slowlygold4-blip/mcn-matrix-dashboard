// Node-only regression: optional author-linkage failure must not hide verified
// overview data. No browser, network, collector, or business-data writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';

const root=fileURLToPath(new URL('../',import.meta.url));
const page=await readFile(root+'app/page.tsx','utf8');
const source=ts.createSourceFile('page.tsx',page,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);

function sourceOperationsProp(name){
 let expression=null;
 function visit(node){
  if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(source)==='SourceOperations'){
   const prop=node.attributes.properties.find(item=>ts.isJsxAttribute(item)&&item.name.text===name);
   expression=prop?.initializer&&ts.isJsxExpression(prop.initializer)?prop.initializer.expression?.getText(source):null;
  }
  ts.forEachChild(node,visit);
 }
 visit(source);
 assert.ok(expression,`SourceOperations must receive ${name} from Home`);
 return expression;
}

function evaluate(expression,values){
 const names=['sourceInsightsError','sourceIndexError','sourceAuthorsError','foundationError','tuantuanRoster'];
 return Function(...names,`return (${expression})`)(...names.map(name=>values[name]));
}

async function serverComponent(){
 const output=await build({entryPoints:[root+'components/source-operations.tsx'],absWorkingDir:root,bundle:true,write:false,platform:'node',format:'cjs',packages:'external',tsconfig:root+'tsconfig.json'});
 const bundledModule={exports:{}};
 Function('require','module','exports',output.outputFiles[0].text)(createRequire(import.meta.url),bundledModule,bundledModule.exports);
 return bundledModule.exports.SourceOperations;
}

const insights={firstDate:'2026-09-12',lastDate:'2026-09-13',sevenDayStart:'2026-09-12',days:[],tracks:[],leaderboards:{all:{authors:[],works:[]}},counts:{tableWorks:2,datedWorkAuthors:1,activeWorkAuthors:1,sevenDayWorks:2,playsKnown:1,undatedWorks:0,cumulativePlays:100,cumulativeLikes:20,likesKnown:1,datedWorks:2,authorFollowersKnown:0}};
const index={revision:'synthetic',stats:{authors:1,works:2,linkedAuthors:0,reciprocalDuplicates:0}};
const foundation={authors:[],works:[],otherAuthors:[],otherWorks:[],observations:[],index:{stats:{sheets:1,sourceDocuments:1,unkeyedRows:0}}};

test('optional author-directory failure leaves verified overview visible and roster dedupe pending',async()=>{
 const errorProp=sourceOperationsProp('error');
 const countProp=sourceOperationsProp('sourceRosterCount');
 const optional={sourceInsightsError:'',sourceIndexError:'',foundationError:'',sourceAuthorsError:'authors.json unavailable',tuantuanRoster:{counts:{source:99}}};
 assert.equal(evaluate(errorProp,optional),'','author linkage is not a fatal overview prerequisite');
 assert.equal(evaluate(countProp,optional),null,'a failed linkage cannot publish even a cached deduplicated roster count');
 assert.match(page,/作者关联信息暂未读到：\{sourceAuthorsError\}。跨表名册去重待核，不影响作品与图表的独立读取/,'the failure is explicitly disclosed next to the overview');
 const SourceOperations=await serverComponent();
 const markup=renderToStaticMarkup(React.createElement(SourceOperations,{insights,source:index,foundation,sourceRosterCount:evaluate(countProp,optional),error:evaluate(errorProp,optional),onInspect:()=>{},onNavigateAccounts:()=>{}}));
 assert.match(markup,/查看全部作品/);
 assert.match(markup,/已去重的作品记录/);
 assert.match(markup,/表格登记身份（去重待核）/);
 assert.doesNotMatch(markup,/表格分析暂不可读/);
});

test('required main sources remain fatal while supplemental failure stays separately disclosed',()=>{
 const errorProp=sourceOperationsProp('error');
 const foundationProp=sourceOperationsProp('foundationError');
 const countProp=sourceOperationsProp('sourceRosterCount');
 const good={sourceInsightsError:'',sourceIndexError:'',foundationError:'',sourceAuthorsError:'',tuantuanRoster:{counts:{source:99}}};
 assert.equal(evaluate(errorProp,good),'');
 assert.equal(evaluate(countProp,good),99);
 for(const field of ['sourceInsightsError','sourceIndexError']){
  const failed={...good,[field]:field+' unavailable'};
  assert.equal(evaluate(errorProp,failed),field+' unavailable',field+' must still block an incomplete overview');
 }
 const supplementFailed={...good,foundationError:'foundation unavailable'};
 assert.equal(evaluate(errorProp,supplementFailed),'','verified main-table insights must not disappear with a supplemental failure');
 assert.equal(evaluate(foundationProp,supplementFailed),'foundation unavailable','supplemental failure must remain visible to the user');
});
