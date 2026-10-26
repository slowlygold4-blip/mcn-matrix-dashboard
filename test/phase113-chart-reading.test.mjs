import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import * as model from '../public/console-model.js';
const source=readFileSync(process.env.PHASE113_JS_SOURCE||new URL('../public/rebuild.js',import.meta.url),'utf8');
function fixture(){
 const nodes=new Map(),listeners=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{id,innerHTML:'',textContent:'',value:'',dataset:{},open:false,disabled:false,setAttribute(){},focus(){document.activeElement=this;},addEventListener(){},querySelector(){return null;},showModal(){this.open=true;},close(){this.open=false;}});return nodes.get(id);};
 const document={getElementById:node,querySelector:()=>node('query'),querySelectorAll:()=>[],activeElement:null,addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(fn);}};
 let requests=0;const account={id:7,label:'实际夹具',platform:'douyin',boards:[],status:{},metrics:Object.fromEntries(['followers','likes','posts'].map(k=>[k,{value:12345,delta:2,reason:null}])),trend:[{date:'2026-10-01',followersDelta:0,likesDelta:-9,postsDelta:1},{date:'2026-10-03',followersDelta:12345,likesDelta:null,postsDelta:0}]};
 const ctx={...model,fmt:model.formatNumber,document,window:{matchMedia:()=>({matches:true}),addEventListener(){}},URL,URLSearchParams,Intl,Date,AbortController,setTimeout:()=>0,clearTimeout:()=>{},location:new URL('http://fixture.invalid'),history:{replaceState(){}},fetch:async()=>{requests++;return{ok:true,json:async()=>({account})};}};
 runInNewContext(source.replace(/^import[^\n]+\n/,'').replace(/void init\(\);\s*$/,'')+`\nthis.subject={state,chartMarkup,renderTrend,openAccount,closeAccount,changeDetailTrend,bind,readableChartMarkup:typeof readableChartMarkup==='function'?readableChartMarkup:null,selectChartDay:typeof selectChartDay==='function'?selectChartDay:null,chartReadings:typeof chartReadings!=='undefined'?chartReadings:null};`,ctx);
 const f=ctx.subject;Object.assign(f.state,{start:'2026-10-01',end:'2026-10-03',period:'custom',data:{period:'custom',range:{startDate:'2026-10-01',endDate:'2026-10-03'},accounts:[account],summary:{enabledCount:1,trend:account.trend}}});
 return {...f,node,document,listeners,account,requests:()=>requests};
}
test('integer count axes have unique unrounded integer labels for zero/one/negative and large counts',()=>{
 const f=fixture();for(const values of [[0],[0,1],[-1,0],[-2,1],[12345,12346],[-9876543210123,0]]){const html=f.chartMarkup(values.map((n,i)=>({date:`2026-10-0${i+1}`,postsDelta:n})),'postsDelta',[],'posts',{singleAccount:true});const labels=[...html.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map(m=>m[1]);assert.equal(new Set(labels).size,labels.length);assert.ok(labels.every(s=>s.length<=8));if(values.every(v=>Math.abs(v)<10))assert.ok(labels.every(s=>/^-?[\d,]+$/.test(s)));}
});
test('real overview reading retains zero negative null coverage and both actual comparison dates',()=>{
 const f=fixture(),points=[{date:'2026-10-01',followersDelta:0,followersDeltaReliable:true},{date:'2026-10-02',followersDelta:null},{date:'2026-10-03',followersDelta:-12345,followersDeltaReliable:false}],comparison=[{date:'2026-09-01',followersDelta:6,followersDeltaReliable:true}];const before=JSON.stringify([points,comparison]);
 const html=f.readableChartMarkup('overview','scope',points,'followersDelta',comparison,'followers');assert.match(html,/tabindex="0"/);assert.equal((html.match(/tabindex=/g)||[]).length,1);
 f.selectChartDay('overview',0);assert.match(f.node('overviewChartReading').innerHTML,/记录 0 人/);assert.match(f.node('overviewChartReading').innerHTML,/2026-09-01/);
 f.selectChartDay('overview',1);assert.match(f.node('overviewChartReading').innerHTML,/缺测/);assert.doesNotMatch(f.node('overviewChartReading').innerHTML,/记录 0/);
 f.selectChartDay('overview',2);assert.match(f.node('overviewChartReading').innerHTML,/-12,345 人/);assert.match(f.node('overviewChartReading').innerHTML,/覆盖不足/);assert.match(f.node('overviewChartReading').innerHTML,/对比期 · 范围外/);assert.equal(JSON.stringify([points,comparison]),before);
});
test('applied scope retains reading across same snapshot refresh but changes metric/range reset, drafts do not',()=>{
 const f=fixture();f.renderTrend();f.selectChartDay('overview',0);f.state.start='2025-01-01';f.state.end='2025-12-31';f.renderTrend();assert.equal(f.chartReadings.get('overview').index,0);
 f.state.metric='posts';f.renderTrend();assert.equal(f.chartReadings.get('overview').index,2);f.selectChartDay('overview',0);f.state.data.range.endDate='2026-10-02';f.renderTrend();assert.equal(f.chartReadings.get('overview').index,1);
});
test('actual detail normalizes missing calendar day without inventing zero and only replaces chart on metric change',async()=>{
 const f=fixture();await f.openAccount(7);assert.match(f.node('dialogBody').innerHTML,/detailChartDate/);assert.doesNotMatch(f.node('dialogBody').innerHTML,/缺少区间口径说明/);const body=f.node('dialogBody').innerHTML;f.node('accountHistoryPanel').innerHTML='history page2';
 f.selectChartDay('detail',1);assert.match(f.node('detailChartReading').innerHTML,/2026-10-02/);assert.match(f.node('detailChartReading').innerHTML,/缺测/);
 f.changeDetailTrend('likes');assert.equal(f.chartReadings.get('detail').index,2);assert.equal(f.node('dialogBody').innerHTML,body);assert.equal(f.node('accountHistoryPanel').innerHTML,'history page2');assert.equal(f.requests(),1);
 f.account.metrics.posts.reason='<img src=x> 真正缺端点';f.changeDetailTrend('posts');assert.match(f.node('detailTrendReason').textContent,/<img src=x> 真正缺端点/);
 await f.closeAccount();assert.equal(f.chartReadings.has('detail'),false);
});
test('all-null dates remain selectable and estimated values are labelled nonactual without requests',()=>{
 const f=fixture();const html=f.readableChartMarkup('overview','empty',[{date:'2026-10-01',estimatedPlaysDelta:null},{date:'2026-10-02',estimatedPlaysDelta:null}],'estimatedPlaysDelta',[],'estimatedPlays');assert.match(html,/这个时段还没有可比快照/);assert.match(html,/2026-10-01/);assert.match(html,/非实际播放量/);f.selectChartDay('overview',0);assert.match(f.node('overviewChartReading').innerHTML,/缺测/);assert.equal(f.requests(),0);
});
test('conflicting numeric payload is withheld from plot and reading without mutating source',()=>{
 const f=fixture(),points=[{date:'2026-10-01',followersDelta:99,conflict:true}],before=JSON.stringify(points);
 const html=f.readableChartMarkup('overview','conflict',points,'followersDelta',[],'followers');assert.doesNotMatch(html,/<circle/);assert.match(html,/缺测/);assert.match(html,/同日记录冲突/);assert.doesNotMatch(html,/记录 99/);assert.equal(JSON.stringify(points),before);
});
test('plot focus identity is stable across redraw while readout full large negative stays unrounded',()=>{
 const f=fixture(),points=[{date:'2026-10-01',postsDelta:-9876543210123}];
 const first=f.readableChartMarkup('overview','stable',points,'postsDelta',[],'posts'),second=f.readableChartMarkup('overview','stable',points,'postsDelta',[],'posts');
 assert.match(first,/id="overviewChartPlot"/);assert.match(second,/id="overviewChartPlot"/);assert.match(first,/-9,876,543,210,123 条/);
});
test('wide SVG click selects the date under the actual centered viewBox point',()=>{
 const f=fixture(),points=Array.from({length:30},(_,i)=>({date:`2026-09-${String(i+1).padStart(2,'0')}`,followersDelta:i+1,followersDeltaReliable:true}));
 f.readableChartMarkup('overview','wide',points,'followersDelta',[],'followers');f.bind();
 const clickHandlers=f.listeners.get('click');let svg;const plot={dataset:{chartPlot:'overview'},querySelector:()=>svg,focus(){}};
 for(const width of [1110,1350]){
  const height=235,rect={left:100,top:20,width,height,right:100+width,bottom:20+height};
  const scale=Math.min(width/980,height/235),left=rect.left+(width-980*scale)/2,top=rect.top+(height-235*scale)/2;
  svg={getBoundingClientRect:()=>rect,getScreenCTM:()=>({inverse:()=>({a:1/scale,d:1/scale,e:-left/scale,f:-top/scale})}),
   createSVGPoint:()=>({x:0,y:0,matrixTransform(m){return{x:this.x*m.a+m.e,y:this.y*m.d+m.f};}})};
  for(const [index,userX] of [[0,68],[29,956]]){
   const event={clientX:left+userX*scale,clientY:top+117.5*scale,target:{closest:selector=>selector==='[data-chart-plot]'?plot:null}};
   clickHandlers[0](event);
   assert.equal(f.chartReadings.get('overview').index,index,`width ${width}: point ${index} must select its own date`);
  }
 }
});
