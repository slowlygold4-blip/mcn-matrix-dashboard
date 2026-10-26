import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';

const page=await readFile(new URL('../app/page.tsx',import.meta.url),'utf8');
const source=ts.createSourceFile('page.tsx',page,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);

function headingMeta(scope,rosterEligible,tuantuanRoster){
 let expression;
 function visit(node){
  if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='accountHeadingMeta')expression=node.initializer?.getText(source);
  ts.forEachChild(node,visit);
 }
 visit(source);
 assert.ok(expression,'account heading must derive its label from current roster counts');
 return Function('scope','rosterEligible','tuantuanRoster','fmt',`return (${expression})`)(
  scope,rosterEligible,tuantuanRoster,value=>Number(value).toLocaleString('zh-CN'));
}

test('accounts heading reconciles full roster without calling each unlinked target a new person',()=>{
 assert.match(page,/tab==='topics'\?'参与人数与实际播放量 · 独立于账号筛选':accountHeadingMeta/,'heading must display the reconciled label');
 const counts={all:4782,source:4497,platformOnly:285};
 const label=headingMeta({length:696},true,{counts});
 assert.match(label,/当前范围 696 个启用监控账号/);
 assert.match(label,/团团总名册 4,782 条（表格去重作者 4,497 \+ 未关联表格的监控账号 285）/);
 assert.doesNotMatch(label,/4,782 位作者/);
});

test('other themes and unavailable roster do not inherit the Tuantuan count',()=>{
 const roster={counts:{all:4782,source:4497,platformOnly:285}};
 assert.equal(headingMeta({length:12},false,roster),'当前范围 12 个启用监控账号');
 assert.equal(headingMeta({length:696},true,null),'当前范围 696 个启用监控账号');
});
