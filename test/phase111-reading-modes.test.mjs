import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import * as model from '../public/console-model.js';
const js=readFileSync(process.env.PHASE111_JS_SOURCE||new URL('../public/rebuild.js',import.meta.url),'utf8');
function fixture(narrow=false){
 const nodes=new Map();let blob,requests=0;
 const node=id=>{if(!nodes.has(id))nodes.set(id,{id,innerHTML:'',textContent:'',value:'',dataset:{},scrollTop:0,scrollLeft:0,open:false,disabled:false,setAttribute(){},focus(){document.activeElement=this;},querySelector(){return null;},showModal(){this.open=true;},close(){this.open=false;}});return nodes.get(id);};
 const document={getElementById:node,querySelector:()=>null,querySelectorAll:()=>[],createElement:()=>({click(){}}),activeElement:null};
 class FixtureURL extends URL{static createObjectURL(value){blob=value;return 'blob:fixture';}static revokeObjectURL(){}}
 const account=(id,value)=>({id,label:'作者'+id,platform:'douyin',enabled:true,boards:[],status:{},collection:{},metrics:Object.fromEntries(Object.keys(model.METRICS).map(key=>[key,{value,delta:value,dailyComparable:id!==1,reason:id===1?'<img src=x> 跨日':key+'说明'}])),trend:[{date:'2026-10-01',followersDelta:0,likesDelta:100,postsDelta:-2},{date:'2026-10-02',followersDelta:-5,likesDelta:null,postsDelta:1},{date:'2026-10-03',followersDelta:8,likesDelta:-10,postsDelta:0}]});
 const data={period:'day',range:{startDate:'2026-10-01',endDate:'2026-10-03'},accounts:Array.from({length:45},(_,i)=>account(i+1,i===0?99999:i===1?0:i===2?null:-i))};
 const context={...model,fmt:model.formatNumber,document,window:{matchMedia:q=>({matches:q.includes('max-width')&&narrow})},URL:FixtureURL,URLSearchParams,Intl,Date,Blob,AbortController,setTimeout:()=>0,location:new URL('http://fixture.invalid/'),history:{replaceState(){}},fetch:async()=>{requests++;return{ok:true,json:async()=>({account:data.accounts[0]})};}};
 runInNewContext(js.replace(/^import[^\n]+\n/,'').replace(/void init\(\);\s*$/,'')+'\nthis.subject={state,renderAccounts,rows,downloadCsv,openAccount,closeAccount,changeLedgerReading:typeof changeLedgerReading===\'function\'?changeLedgerReading:null,changeDetailTrend:typeof changeDetailTrend===\'function\'?changeDetailTrend:null};',context);
 Object.assign(context.subject.state,{data,view:'accounts',period:'day',page:1,sort:'followers.delta',direction:'desc',start:'2026-10-01',end:'2026-10-03'});
 return{...context.subject,node,document,context,data,blob:()=>blob,requests:()=>requests};
}
test('narrow default is a single compact table; desktop remains full without changing source values',()=>{
 const narrow=fixture(true),wide=fixture(false);narrow.renderAccounts();wide.renderAccounts();
 assert.match(narrow.node('accountsTable').innerHTML,/class="table compact-ledger"/);
 assert.equal((narrow.node('accountsTable').innerHTML.match(/<table /g)||[]).length,1);
 assert.doesNotMatch(wide.node('accountsTable').innerHTML,/compact-ledger/);
 assert.match(narrow.node('ledgerReadingControls').innerHTML,/随屏幕/);
 assert.match(narrow.node('accountsTable').innerHTML,/data-sort="followers.value"/);
 assert.match(narrow.node('accountsTable').innerHTML,/data-sort="followers.delta"/);
});
test('mode and metric changes keep page/sort/filter, exact CSV and true zero/negative/missing evidence',async()=>{
 const f=fixture();const before=JSON.stringify(f.data);f.state.page=2;f.state.query='作者';f.renderAccounts();f.downloadCsv();const csv=await f.blob().text(),ids=Array.from(f.rows(),a=>a.id);
 for(const metric of Object.keys(model.METRICS)){
  f.changeLedgerReading('mode','compact');f.changeLedgerReading('metric',metric);
  assert.equal(f.state.page,2);assert.equal(f.state.sort,'followers.delta');assert.equal(f.state.query,'作者');
  assert.deepEqual(Array.from(f.rows(),a=>a.id),ids);f.downloadCsv();assert.equal(await f.blob().text(),csv);
  assert.equal((f.node('accountsTable').innerHTML.match(/data-account-id=/g)||[]).length,20);
  if(metric==='estimatedPlays'){assert.doesNotMatch(f.node('accountsTable').innerHTML,/estimatedPlays.value/);assert.match(f.node('accountsTable').innerHTML,/非实际播放量/);}
 }
 f.state.page=1;f.state.sort='label';f.state.direction='asc';f.changeLedgerReading('metric','followers');const html=f.node('accountsTable').innerHTML;
 assert.match(html,/&lt;img src=x&gt; 跨日/);assert.doesNotMatch(html,/<img/);assert.match(html,/记录 99,999/);assert.match(html,/class="flat"[^>]*>0<\/span>/);assert.match(html,/class="flat">—<\/span>/);assert.match(html,/class="down"/);
 f.changeLedgerReading('mode','full');assert.doesNotMatch(f.node('accountsTable').innerHTML,/compact-ledger/);assert.equal(JSON.stringify(f.data),before);
});
test('actual detail response exposes three daily metrics; switching redraws only chart with no additional HTTP',async()=>{
 const f=fixture();await f.openAccount(1);const body=f.node('dialogBody').innerHTML;
 for(const metric of ['followers','likes','posts'])assert.ok(body.includes(`data-detail-metric="${metric}"`));
 f.node('accountHistoryPanel').innerHTML='history page 2';f.node('historyWorkPanel').innerHTML='selected work';
 for(const [metric,value] of [['followers','-5'],['likes','-10'],['posts','-2']]){
  f.changeDetailTrend(metric);assert.match(f.node('detailTrendChart').innerHTML,new RegExp(value));
  assert.equal(f.node('detailTrendTitle').textContent,`${model.METRICS[metric]}每日净变化`);
  assert.ok(f.node('detailTrendReason').textContent.startsWith(`所选区间${model.METRICS[metric]}口径：`));
  assert.equal(f.node('dialogBody').innerHTML,body);assert.equal(f.node('accountHistoryPanel').innerHTML,'history page 2');assert.equal(f.node('historyWorkPanel').innerHTML,'selected work');
 }
 assert.equal(f.requests(),1);assert.doesNotMatch(f.node('detailTrendChart').innerHTML,/NaN/);
});
test('closed or superseded detail cannot gain a late chart owner or issue chart HTTP',async()=>{
 const f=fixture();let resolve;f.context.fetch=()=>new Promise(done=>{resolve=done;});const pending=f.openAccount(1);await f.closeAccount();resolve({ok:true,json:async()=>({account:f.data.accounts[0]})});await pending;
 const before=f.node('detailTrendChart').innerHTML;f.changeDetailTrend('likes');assert.equal(f.node('detailTrendChart').innerHTML,before);assert.equal(f.node('accountDialog').open,false);
});
