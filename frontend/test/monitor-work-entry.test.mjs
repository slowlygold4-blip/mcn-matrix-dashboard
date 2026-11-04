import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const root=fileURLToPath(new URL('../',import.meta.url));
async function component(path,name){const result=await build({entryPoints:[root+path],absWorkingDir:root,bundle:true,write:false,platform:'node',format:'cjs',packages:'external',tsconfig:root+'tsconfig.json'});const mod={exports:{}};Function('require','module','exports',result.outputFiles[0].text)(createRequire(import.meta.url),mod,mod.exports);return mod.exports[name];}
const Roster=await component('components/tuantuan-roster.tsx','TuantuanRosterTable'),Account=await component('components/account-panel.tsx','AccountPanel');
const account=(id,platform='douyin')=>({id,label:'账号'+id,platform,enabled:true,boardKeys:[],classification:{theme:{key:'tuantuan',label:'团团'},labels:[]}});
test('actual roster offers separate linked-target work entries and keeps source authors on their unified work entry',()=>{
 const a=[1,2,3,4,5].map(id=>account(id,id===2?'bilibili':'douyin'));
 const rows=[{key:'one',source:null,accounts:[a[0]]},{key:'bili',source:null,accounts:[a[1]]},
  {key:'multiple',source:null,accounts:[a[2],a[3]]},{key:'source',source:{name:'来源作者',douyinId:'verified-source',targetIds:[5]},accounts:[a[4]]},
  {key:'pending',source:{name:'待核作者',sourceOnly:true,targetIds:[]},accounts:[]}];
 const html=renderToStaticMarkup(React.createElement(Roster,{roster:{rows,counts:{all:5}},classification:'all',onOpenAccount(){},onOpenSourceWorks(){},onOpenAccountWorks(){}}));
 for(const id of [1,2,3,4])assert.ok(html.includes(`aria-label="账号${id} · 账号 ${id} · 查看作品"`));
 assert.ok(html.includes('请选择要查看的账号'));assert.equal((html.match(/aria-label="账号\d · 账号 \d · 查看作品"/g)||[]).length,4);
 assert.doesNotMatch(html,/aria-label="账号5 · 账号 5 · 查看作品"/,'source author keeps the existing merged-source action');
 assert.equal((html.match(/>查看作品 →<\/button>/g)||[]).length,3,'one source entry plus two single-target entries');
});
test('independent account work/history entry is available before daily observations load',()=>{
 const a=account(2,'bilibili'),manifest={asOf:'2026-10-26T08:00:00.000Z',timeZone:'Asia/Shanghai',files:[]};
 const html=renderToStaticMarkup(React.createElement(Account,{account:a,manifest,boards:[],request:{},onReturn(){},onAddress(){},onHistory(){}}));
 assert.match(html,/正在校验这个账号的保存历史/);assert.match(html,/>查看全部每日、作品与指标历史<\/button>/);
 assert.equal((html.match(/>查看全部每日、作品与指标历史<\/button>/g)||[]).length,1);
});
