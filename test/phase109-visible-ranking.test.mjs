import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { pathToFileURL } from 'node:url';

const root = process.env.PHASE109_SUBJECT;
const source = file => root ? pathToFileURL(`${root}/public/${file}`) : new URL(`../public/${file}`, import.meta.url);
const model = await import(source('console-model.js'));
const js = readFileSync(source('rebuild.js'), 'utf8');
const ids = rows => Array.from(rows, row => row.id);
function accounts() {
  return [[1,999999,false],[2,-999999,false],[3,0,true],[4,-9,true],[5,null,true],[6,12,true],[7,12,true],[8,4,undefined]].map(([id,delta,dailyComparable]) => ({
    id,label:`账号${id}`,enabled:true,platform:'douyin',boards:[],status:{},collection:{},publicId:`public${id}`,
    metrics:Object.fromEntries(Object.keys(model.METRICS).map(key => [key,{value:id * 12345,delta,dailyComparable,reason:dailyComparable===false?'跨日记录，不是当日变化':''}]))
  }));
}
function fixture() {
  const nodes = new Map();
  const node = id => { if(!nodes.has(id)) nodes.set(id,{innerHTML:'',textContent:'',value:'',dataset:{},setAttribute(){},focus(){},querySelector(){return null;}}); return nodes.get(id); };
  let blob;
  class FixtureURL extends URL { static createObjectURL(value){blob=value;return 'blob:fixture';} static revokeObjectURL(){} }
  const context={...model,fmt:model.formatNumber,document:{getElementById:node,querySelectorAll:()=>[],createElement:()=>({click(){}})},URL:FixtureURL,URLSearchParams,Intl,Date,Blob,setTimeout:()=>0,location:new URL('http://fixture.invalid/'),history:{replaceState(){}}};
  runInNewContext(js.replace(/^import[^\n]+\n/,'').replace(/void init\(\);\s*$/,'')+'\nthis.subject={state,rows,renderAccounts,downloadCsv};',context);
  Object.assign(context.subject.state,{view:'accounts',period:'month',start:'2026-10-02',end:'2026-10-02',data:{period:'day',range:{startDate:'2026-10-02',endDate:'2026-10-02'},accounts:accounts()}});
  return {...context.subject,node,blob:()=>blob};
}
test('daily delta ranking uses the same visible values, unknown last both ways, numeric ID ties',()=>{
  const input=accounts(),before=JSON.stringify(input);
  for(const metric of Object.keys(model.METRICS)) for(const direction of ['asc','desc']) {
    assert.deepEqual(ids(model.sortAccounts(input,`${metric}.delta`,direction,'day')),direction==='asc'?[4,3,8,6,7,1,2,5]:[6,7,8,3,4,1,2,5]);
  }
  assert.equal(JSON.stringify(input),before,'sort never rewrites evidence');
});
test('only explicit daily false is hidden; generic three-argument and other periods retain raw sorting',()=>{
  const input=accounts();
  for(const period of [undefined,'week','month','30d','custom','since']) for(const direction of ['asc','desc']) {
    assert.deepEqual(ids(model.sortAccounts(input,'followers.delta',direction,period)),direction==='asc'?[2,4,3,8,6,7,1,5]:[1,6,7,8,3,4,2,5]);
  }
  for(const flag of [undefined,null,0,'false',true]) {
    const rows=[{id:1,metrics:{followers:{delta:20,dailyComparable:flag}}},{id:2,metrics:{followers:{delta:0,dailyComparable:true}}}];
    assert.deepEqual(ids(model.sortAccounts(rows,'followers.delta','desc','day')),[1,2]);
  }
  for(const key of ['followers.value','label']) for(const direction of ['asc','desc']) assert.deepEqual(ids(model.sortAccounts(input,key,direction,'day')),ids(model.sortAccounts(input,key,direction)));
});
test('actual renderer and overview rank applied day data, not the unapplied month control, with honest summary',()=>{
  const f=fixture();
  for(const metric of Object.keys(model.METRICS)) for(const direction of ['asc','desc']) {
    Object.assign(f.state,{sort:`${metric}.delta`,direction});f.renderAccounts();
    const expected=direction==='asc'?[4,3,8,6,7,1,2,5]:[6,7,8,3,4,1,2,5];
    assert.deepEqual(ids(f.rows()),expected);assert.deepEqual(ids(f.rows({overview:true})),expected);
    const html=f.node('accountsTable').innerHTML;
    assert.deepEqual([...html.matchAll(/data-account-id="(\d+)"/g)].map(match=>Number(match[1])),expected);
    assert.match(html,/跨日记录，不是当日变化/);assert.match(html,/class="flat">—<\/span>/);
    assert.match(f.node('accountCount').textContent,/非日可比变化显示— · 缺测最后/);
    assert.doesNotMatch(f.node('accountCount').textContent,/按原记录排序/);
  }
});
test('actual CSV preserves each account stock and visible delta while following daily ranking',async()=>{
  const f=fixture();Object.assign(f.state,{sort:'followers.delta',direction:'desc'});f.downloadCsv();
  const records=(await f.blob().text()).replace(/^\ufeff/,'').split('\r\n').slice(1).map(line=>line.split(',').map(cell=>cell.replace(/^"|"$/g,'')));
  assert.deepEqual(records.map(row=>row[0]),[6,7,8,3,4,1,2,5].map(id=>`账号${id}`));
  for(const record of records) {
    const account=f.state.data.accounts.find(row=>row.label===record[0]);
    assert.equal(record[5],String(account.metrics.followers.value));
    assert.equal(record[6],String(model.periodDelta(account.metrics.followers,'day')??''));
    assert.equal(record[8],String(model.periodDelta(account.metrics.likes,'day')??''));
    assert.equal(record[11],String(model.periodDelta(account.metrics.posts,'day')??''));
  }
  assert.equal(f.state.data.accounts[0].metrics.followers.delta,999999,'raw source delta is retained');
});
