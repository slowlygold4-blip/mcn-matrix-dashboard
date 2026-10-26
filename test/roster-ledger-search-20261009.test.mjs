import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';
const code=readFileSync(new URL('../public/rebuild.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/,'').replace(/void init\(\);\s*$/,'');
function fixture(){
  const events=new Map(),ctx={...model,fmt:model.formatNumber,URL,URLSearchParams,
    location:{href:'http://127.0.0.1:4188/#overview'},
    document:{getElementById:()=>null,addEventListener:(name,fn)=>events.set(name,fn)},
  };
  runInNewContext(code+'\nthis.subject={state,rows};',ctx);
  ctx.subject.state.data={range:{startDate:'2026-10-09',endDate:'2026-10-09'},accounts:[
    {id:1,label:'现名',platform:'douyin',enabled:true,metrics:{},collection:{}},
    {id:2,label:'其他',platform:'douyin',enabled:true,metrics:{},collection:{}},
  ]};
  return {...ctx.subject,loaded:items=>events.get('mcn:master-roster-loaded')({detail:{items}})};
}
test('bound original name is searchable without changing displayed identity or metrics',()=>{
  const f=fixture();f.loaded([{targetId:1,name:'现名',originalNames:['曾用名称'],accountIds:['123456']}]);
  f.state.query='曾用名称';assert.deepEqual(Array.from(f.rows(),x=>x.id),[1]);assert.equal(f.rows()[0].label,'现名');
  f.state.query='123456';assert.equal(f.rows().length,1);
});
test('unbound source record never becomes a monitored account or search alias of a target',()=>{
  const f=fixture();f.loaded([{targetId:null,name:'未接入',originalNames:['其他别名'],accountIds:['pending-id']}]);
  f.state.query='未接入';assert.equal(f.rows().length,0);assert.equal(f.state.data.accounts.length,2);
});
test('a later roster response removes stale aliases and does not accumulate duplicates',()=>{
  const f=fixture();f.loaded([{targetId:1,name:'现名',originalNames:['旧别名'],accountIds:[]}]);
  f.state.query='旧别名';assert.equal(f.rows().length,1);f.loaded([]);assert.equal(f.rows().length,0);
});
