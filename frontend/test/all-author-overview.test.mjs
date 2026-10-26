import test from 'node:test';
import assert from 'node:assert/strict';
import {allAuthorOverview} from '../lib/all-author-overview.mjs';
import {buildTuantuanRoster} from '../lib/tuantuan-roster.mjs';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const a={id:1,label:'有采样作者',enabled:true,platform:'douyin',classification:{theme:{key:'tuantuan'},labels:[]},latest:{followers:{value:12,date:'2026-10-26'}}};
const authors=Array.from({length:4927},(_,i)=>({douyinId:String(10000+i),name:'作者'+i,targetIds:i===0?[1]:[],posts:3,plays:100,likes:5,slicePosts:i%2===0?3:0}));
const base=buildTuantuanRoster(authors,[a]);
const metrics=[{...a,metrics:{followers:{value:12,baseline:10,delta:2},likes:{value:5,baseline:5,delta:0},posts:{value:null,baseline:5,delta:null}}}];
test('overview retains every imported author regardless of monitoring availability',()=>{
 const result=allAuthorOverview(base,metrics);
 assert.equal(result.rows.length,4927);assert.equal(result.counts.all,4927);
 assert.deepEqual(result.availability,{sourceOnly:4926,followers:1,likes:1,posts:0});
 assert.equal(result.rows[4926].source.plays,100);
 assert.equal(allAuthorOverview(base,[]).rows.length,4927,'no snapshots never reduces roster to zero');
 assert.equal(allAuthorOverview(null,metrics),null,'loading never masquerades as a smaller complete roster');
});
test('classification preserves source-only authors with explicit source evidence',()=>{
 const result=allAuthorOverview(base,metrics,'slice');
 assert.equal(result.rows.length,2464);assert.equal(result.fullCount,4927);
 assert.equal(result.availability.sourceOnly,2463);
});
test('same author row presents source values, period endpoints and missing reasons',async()=>{
 const r=await build({entryPoints:['components/all-author-overview.tsx'],bundle:true,write:false,platform:'node',format:'cjs',packages:'external'});const m={exports:{}};Function('require','module','exports',r.outputFiles[0].text)(createRequire(import.meta.url),m,m.exports);
 const roster=allAuthorOverview(buildTuantuanRoster([{...authors[0],name:'已采作者'},{...authors[1],name:'表格作者',followers:123}],[a]),metrics);
 const html=renderToStaticMarkup(React.createElement(m.exports.AllAuthorOverview,{roster,metricRows:metrics,start:'2026-10-19',end:'2026-10-26',ready:true,scopeLabel:'团团',onOpenAccount(){},onOpenSourceWorks(){},children:'sampling detail'}));
 const plain=html.replace(/<[^>]+>/g,'');
 assert.match(plain,/全部作者的数据与变化 · 2 位/);
 assert.match(plain,/表格作者/);assert.match(plain,/已采作者/);
 assert.match(plain,/123已记录值/);assert.match(plain,/10 → 12/);
 assert.match(plain,/0→持平/);assert.match(plain,/尚无主页采样/);
 assert.match(plain,/缺少所选区间的起止采样/);
 assert.match(plain,/来源和更新情况/);
});
