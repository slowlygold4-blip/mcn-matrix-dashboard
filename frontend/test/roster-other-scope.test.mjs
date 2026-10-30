import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {buildTuantuanRoster,rosterMonitoringState,tuantuanRosterExport,filterTuantuanRoster} from '../lib/tuantuan-roster.mjs';
const outside={id:9,label:'已核验其他主题账号',enabled:true,platform:'douyin',boardKeys:['抖音主播板块'],classification:{theme:{key:'douyin-streamers',label:'抖音主播'}},latest:{followers:{value:9999999,date:'2026-10-30'}}};
const author={row:2,name:'来源登记作者',douyinId:'source_a',targetIds:[9],posts:2,likes:5,plays:50};
const matrix={id:1,label:'矩阵账号',enabled:true,platform:'douyin',classification:{theme:{key:'tuantuan',label:'团团'}}};
test('known other-scope account remains inspectable without becoming a Tuantuan monitoring account',()=>{
 const original=structuredClone([author,outside,matrix]),roster=buildTuantuanRoster([author],[matrix,outside]),row=roster.rows.find(row=>row.source);
 assert.equal(row.accounts.length,0);assert.equal(row.otherScopeAccounts[0].id,9);
 assert.equal(roster.counts.monitoredEnabled,1);assert.equal(roster.counts.linkedTargets,0);assert.equal(roster.counts.matchedOtherTheme,1);
 assert.equal(rosterMonitoringState(row).label,'已匹配其他主题');assert.match(rosterMonitoringState(row).detail,/抖音主播.*不计入/);
 assert.equal(filterTuantuanRoster(roster.rows,{mode:'source-only'}).length,1);
 assert.equal(tuantuanRosterExport([row])[1][2],'已匹配其他主题');
 assert.equal(tuantuanRosterExport([row])[1][3],'','其他主题不是本矩阵的监控目标');
 assert.deepEqual([author,outside,matrix],original);
});
test('missing and source-only catalog entries never masquerade as verified other-scope matches',()=>{
 for(const accounts of [[],[{...outside,sourceOnly:true}]]){
  const row=buildTuantuanRoster([author],accounts).rows[0];assert.equal(row.otherScopeAccounts.length,0);assert.equal(rosterMonitoringState(row).label,'未关联监控账号');
 }
 const row=buildTuantuanRoster([{...author,targetIds:[1,9]}],[matrix,outside]).rows[0];
 assert.equal(rosterMonitoringState(row).label,'已启用采集计划');assert.equal(row.accounts[0].id,1);
});
const root=fileURLToPath(new URL('../',import.meta.url));
const bundle=await build({entryPoints:[root+'components/tuantuan-roster.tsx'],absWorkingDir:root,bundle:true,write:false,platform:'node',format:'cjs',packages:'external',tsconfig:root+'tsconfig.json'});
const module={exports:{}};Function('require','module','exports',bundle.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
test('actual roster component names the scope difference and provides a direct account detail action',()=>{
 const roster=buildTuantuanRoster([author],[outside]);
 const html=renderToStaticMarkup(React.createElement(module.exports.TuantuanRosterTable,{roster,classification:'all',onOpenAccount(){},onOpenSourceWorks(){}}));
 for(const text of ['已匹配其他主题','抖音主播','不计入当前团团矩阵','查看其他主题账号','未纳入矩阵监控'])assert.ok(html.includes(text),text);
 assert.equal(html.includes('未关联监控账号'),false);assert.equal(html.includes('9,999,999'),false,'不把主播主页粉丝放入该矩阵行');
});
