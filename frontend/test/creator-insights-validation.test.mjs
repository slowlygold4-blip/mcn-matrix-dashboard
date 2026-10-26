import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateCreatorInsights} from '../lib/creator-insights-validation.mjs';

test('published legacy insight remains compatible without unknown-date counters',()=>{
 const index=JSON.parse(readFileSync(new URL('../public/creator-source/index.json',import.meta.url)));
 const {items}=JSON.parse(readFileSync(new URL('../public/creator-source/insights.json',import.meta.url)));
 assert.equal(validateCreatorInsights(items,index),items[0]);
});
test('partial dates validate against all source works, not only the dated subset',()=>{
 const index={stats:{works:2,authors:2,datedWorks:1,undatedWorks:1}};
 const rows=[{counts:{tableWorks:2,tableAuthors:2,datedWorks:1,undatedWorks:1}}];
 assert.equal(validateCreatorInsights(rows,index),rows[0]);
 for(const field of ['tableWorks','tableAuthors','datedWorks','undatedWorks']){
  for(const value of [-1,NaN,undefined,0.5,'1']){
   const bad=structuredClone(rows);bad[0].counts[field]=value;
   assert.throws(()=>validateCreatorInsights(bad,index),/表格分析/);
  }
 }
 assert.throws(()=>validateCreatorInsights(rows,{stats:{...index.stats,undatedWorks:2}}),/发布日期统计/);
 assert.throws(()=>validateCreatorInsights([],index),/格式/);
});
