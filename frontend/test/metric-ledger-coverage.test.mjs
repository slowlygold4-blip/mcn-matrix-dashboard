import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

const root=fileURLToPath(new URL('../',import.meta.url));

test('ledger distinguishes an observed zero from an unknown coverage count',async()=>{
 const compiled=await build({entryPoints:[root+'components/metric-ledger.tsx'],absWorkingDir:root,bundle:true,write:false,platform:'node',format:'cjs',packages:'external',tsconfig:root+'tsconfig.json'});
 const module={exports:{}};
 Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
 const metrics={followers:{value:10,delta:3,knownCount:1,comparableCount:1},likes:{value:20,delta:2},posts:{value:null,delta:null,knownCount:0,comparableCount:0}};
 const html=renderToStaticMarkup(React.createElement(module.exports.MetricLedger,{metrics,count:3,start:'2026-09-12',end:'2026-10-23'}));
 const text=html.replace(/<[^>]+>/g,'');
 assert.match(text,/粉丝总数10有数据 1\/3 个账号/);
 assert.match(text,/主页获赞总数20有数据 账号数待核/);
 assert.match(text,/作品总数—有数据 0\/3 个账号/);
 assert.match(text,/主页获赞变化\+2↗增长两天都有数据 账号数待核/);
 assert.match(text,/估算播放变化（非实测）\+200↗增长两天都有数据 账号数待核/);
 assert.match(text,/作品数变化—\?缺少可比数据两天都有数据 0\/3 个账号/);
 assert.match(text,/获赞净变化 × 100，非平台实际播放量/);
});
