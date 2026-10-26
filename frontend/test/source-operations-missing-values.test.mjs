import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

const root=fileURLToPath(new URL('../',import.meta.url));
const compiled=await build({entryPoints:[root+'components/source-operations.tsx'],absWorkingDir:root,bundle:true,write:false,platform:'node',format:'cjs',packages:'external',tsconfig:root+'tsconfig.json'});
const renderedModule={exports:{}};
Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),renderedModule,renderedModule.exports);

function render(known){
  const insights={firstDate:'2026-10-12',lastDate:'2026-10-12',sevenDayStart:'2026-10-06',days:[],tracks:[{track:'切片',works:1,authors:1,playsKnown:known,likesKnown:known,cumulativePlays:0,cumulativeLikes:0}],leaderboards:{all:{authors:[{douyinId:'abc',name:'甲',works:1,playsKnown:known,cumulativePlays:0}],works:[]}},counts:{tableWorks:1,datedWorks:1,undatedWorks:0,activeWorkAuthors:1,datedWorkAuthors:1,sevenDayWorks:1,playsKnown:known,likesKnown:known,cumulativePlays:0,cumulativeLikes:0,authorFollowersKnown:0}};
  const source={revision:'test',stats:{authors:1,works:1,linkedAuthors:0,reciprocalDuplicates:0}};
  return renderToStaticMarkup(React.createElement(renderedModule.exports.SourceOperations,{insights,source,foundation:null,sourceRosterCount:null,error:'',onInspect:()=>{},onNavigateAccounts:()=>{}}));
}

test('legacy all-missing source aggregates render as unknown rather than numeric zero',()=>{
  const html=render(0);
  assert.match(html,/位有作品作者 · 表格播放 —/);
  assert.match(html,/有记录作品的表格播放值合计<\/small><strong>—<\/strong>/);
  assert.match(html,/有记录作品的表格点赞值合计<\/small><strong>—<\/strong>/);
  assert.match(html,/暂无有值的播放记录，不能排列播放成绩/);
  assert.doesNotMatch(html,/source-ops-rank-value[^>]*>0/);
});

test('a source-reported zero remains a visible observed zero',()=>{
  const html=render(1);
  assert.match(html,/有记录作品的表格播放值合计<\/small><strong>0<\/strong>/);
  assert.match(html,/有记录作品的表格点赞值合计<\/small><strong>0<\/strong>/);
  assert.match(html,/source-ops-rank-value[^>]*>0/);
  assert.doesNotMatch(html,/暂无有值的播放记录/);
});
