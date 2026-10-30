// Render the actual component with synthetic records; no external services.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const root=fileURLToPath(new URL('../',import.meta.url));
const bundle=await build({entryPoints:[root+'components/work-likes-history.tsx'],absWorkingDir:root,
 bundle:true,write:false,platform:'node',format:'cjs',packages:'external',tsconfig:root+'tsconfig.json'});
const mod={exports:{}};
Function('require','module','exports',bundle.outputFiles[0].text)(createRequire(import.meta.url),mod,mod.exports);
const {WorkLikesHistory}=mod.exports;
const manifest={asOf:'2026-10-30T05:00:00.000Z',files:[{path:'work-metrics/1.json',targetId:1,kind:'workMetrics',count:2,sha256:'a'.repeat(64)}]};
const sample=(id,date,likes)=>({id,targetId:1,workId:7,externalId:'7500000000000000001',capturedAt:date+'T04:00:00.000Z',likes});
const render=records=>renderToStaticMarkup(React.createElement(WorkLikesHistory,{records,account:{id:1,label:'fixture'},manifest,workId:7}));

test('actual work detail defaults to daily likes, shows signed changes and retains raw samples and exports',()=>{
 const html=render([sample(1,'2026-10-29',10),sample(2,'2026-10-30',7)]);
 for(const text of ['单作品每日点赞变化','每日变化','原始采样','导出全部每日变化','日净变化','前日','-3','negative'])assert.ok(html.includes(text),text);
 assert.match(html,/aria-pressed="true"/);assert.match(html,/aria-sort="descending"/);
 assert.match(html,/2 日有点赞观测 · 0 日缺测/);
 const page=readFileSync(root+'app/page.tsx','utf8');
 assert.match(page,/kind==='workMetrics'&&account&&data&&work!==null\?<WorkLikesHistory/);
 assert.match(page,/records=\{history.items\}/);
});

test('stale or empty history cannot render today as zero growth',()=>{
 const html=render([sample(1,'2026-10-28',10)]);
 assert.match(html,/本日缺测/);assert.match(html,/2 日缺测/);assert.match(html,/查看缺测日期/);
 assert.doesNotMatch(html,/>\+0</);
 const empty=render([]);assert.match(empty,/这条作品尚无点赞采样，不能计算增长/);assert.match(empty,/>—</);
});

test('identity-invalid history renders an error instead of an apparently valid delta',()=>{
 const html=render([{...sample(1,'2026-10-30',10),targetId:2}]);
 assert.match(html,/role="alert"/);assert.match(html,/已停止计算/);assert.doesNotMatch(html,/日净变化/);
});
