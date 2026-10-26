import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const load=async path=>{const r=await build({entryPoints:[path],bundle:true,write:false,platform:'node',format:'cjs',packages:'external'});const m={exports:{}};Function('require','module','exports',r.outputFiles[0].text)(createRequire(import.meta.url),m,m.exports);return m.exports;};
const {changeState}=await load('components/change-indicator.tsx');
const {changeGeometry,DailyChangeTrend}=await load('components/daily-change-trend.tsx');
test('four states distinguish unknown and genuine zero, including invalid numbers',()=>{
 for(const [value,kind] of [[2,'positive'],[-2,'negative'],[0,'neutral'],[null,'missing'],[undefined,'missing'],[NaN,'missing'],[Infinity,'missing']])assert.equal(changeState(value).kind,kind);
});
test('curve uses a zero axis and leaves missing samples unconnected',()=>{
 const points=[10,null,-10,0].map((value,i)=>({date:`2026-10-${20+i}`,value}));
 const before=JSON.stringify(points),g=changeGeometry(points);
 assert.deepEqual(g.map(p=>p.y),[22,null,138,80]);assert.equal(JSON.stringify(points),before);
 const html=renderToStaticMarkup(React.createElement(DailyChangeTrend,{points,label:'每日净变化',unit:'人'}));
 assert.equal((html.match(/class="daily-change-trend__line"/g)||[]).length,1,'only adjacent observed points connect');
 assert.equal((html.match(/class="daily-change-trend__missing"/g)||[]).length,1);
 assert.match(html,/aria-pressed="true" aria-label="2026-10-23，0，持平"/);
 assert.match(html,/2026-10-21，—，缺少可比数据/);
 assert.match(html,/↗/);assert.match(html,/↘/);
});
test('empty and zero-only curves cannot generate invalid coordinates',()=>{
 assert.deepEqual(changeGeometry([]),[]);
 assert.equal(changeGeometry([{date:'2026-10-20',value:0}])[0].y,80);
});
