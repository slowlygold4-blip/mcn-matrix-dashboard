import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const site=fileURLToPath(new URL('../',import.meta.url));
const requireSite=createRequire(join(site,'package.json'));
const ts=requireSite('typescript'),React=requireSite('react'),{renderToStaticMarkup}=requireSite('react-dom/server');
const cache=new Map();
function load(name){
 const base=join(site,name),path=[base,base+'.tsx',base+'.ts'].find(candidate=>existsSync(candidate));
 assert.ok(path,`missing source module: ${name}`);if(cache.has(path))return cache.get(path);
 const result={};cache.set(path,result);
 const compiled=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 vm.runInNewContext(compiled,{exports:result,require(spec){return spec.startsWith('@/')?load(spec.slice(2)):requireSite(spec);},console,Date});
 return result;
}
const {TopicHistory,recentTopicPlayDays}=load('components/topic-history.tsx');
const time=value=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
const point=(overrides={})=>({id:1,targetId:7,date:'2026-09-27',capturedAt:'2026-09-27T10:00:00.000Z',participants:null,views:null,participantsDelta:null,viewsDelta:null,sourceChecksum:'a'.repeat(64),qualityStatus:'validated',metricsEvidence:'topic-identity-source-run-time-vector-bound',participantsBaselineAt:null,participantsBaselineChecksum:null,viewsBaselineAt:null,viewsBaselineChecksum:null,...overrides});
const render=items=>renderToStaticMarkup(React.createElement(TopicHistory,{topic:{id:7,label:'#独立测试话题'},items}));
const plain=markup=>markup.replace(/<[^>]+>/g,'');
const dailySigns=markup=>[...markup.matchAll(/<div(?=[^>]*class="topic-delta")(?=[^>]*data-sign="([^"]+)")[^>]*>/g)].map(match=>match[1]);

test('topic cards keep each metric’s latest real value and daily delta independent across missing observations',()=>{
 const inputs=[
  point({id:1,date:'2026-09-27',capturedAt:'2026-09-27T10:00:00.000Z',participants:100,views:1000,participantsDelta:5,viewsDelta:50}),
  point({id:2,date:'2026-09-28',capturedAt:'2026-09-28T10:00:00.000Z',views:1250,viewsDelta:250,viewsBaselineAt:'2026-09-27T10:00:00.000Z'}),
  point({id:3,date:'2026-09-29',capturedAt:'2026-09-29T10:00:00.000Z',participants:140}),
 ];
 const before=JSON.stringify(inputs),markup=render([...inputs].reverse()),text=plain(markup);
 const values=[...markup.matchAll(/<strong>(.*?)<\/strong>/g)].map(match=>match[1]);
 assert.deepEqual(values,['140','—','1,250','+250']);
 assert.ok(text.includes(`最近有效采样 ${time(inputs[2].capturedAt)}`));
 assert.ok(text.includes(`最近有效采样 ${time(inputs[1].capturedAt)} · 最新采样日该项缺测`));
 assert.ok(text.includes('最近采样记录 '+time(inputs[2].capturedAt)));
 assert.equal(JSON.stringify(inputs),before,'display sorting must not mutate the caller’s observations');
});

test('unknown topic metrics stay unknown rather than becoming zero or inheriting a contradictory delta',()=>{
 const html=render([point({participants:null,views:null,participantsDelta:12,viewsDelta:-9})]);
 assert.deepEqual([...html.matchAll(/<strong>(.*?)<\/strong>/g)].map(match=>match[1]),['—','—','—','—']);
 assert.deepEqual(dailySigns(html),['missing','missing']);
 assert.doesNotMatch(plain(html),/\+12|-9次/);
 assert.equal((plain(html).match(/尚无有效采样/g)||[]).length,2);
});

test('topic daily change marks positive, negative, zero and missing without changing the displayed data',()=>{
 const cases=[
  {delta:12,sign:'positive',display:'+12'},
  {delta:-9,sign:'negative',display:'-9'},
  {delta:0,sign:'neutral',display:'0'},
  {delta:null,sign:'missing',display:'—'},
 ];
 for(const {delta,sign,display} of cases){
  const html=render([
   point({id:1,date:'2026-09-26',capturedAt:'2026-09-26T10:00:00.000Z',participants:delta===null?null:100-delta,views:delta===null?null:1000-delta}),
   point({id:2,participants:100,views:1000,participantsDelta:999,viewsDelta:999}),
  ]);
  assert.deepEqual(dailySigns(html),[sign,sign],`${display} should have the same semantic state for both topic metrics`);
  assert.deepEqual([...html.matchAll(/<strong>(.*?)<\/strong>/g)].map(match=>match[1]),['100',display,'1,000',display],`the ${sign} marker must not alter saved values`);
 }
});

test('unverified newer topic observations cannot replace verified headline values or create daily change',()=>{
 const html=render([
  point({id:1,date:'2026-10-20',capturedAt:'2026-10-20T10:00:00.000Z',participants:50,views:1000}),
  point({id:2,date:'2026-10-21',capturedAt:'2026-10-21T10:00:00.000Z',participants:60,views:1200,participantsDelta:900,viewsDelta:900}),
  point({id:3,date:'2026-10-22',capturedAt:'2026-10-22T10:00:00.000Z',participants:9000000,views:9000000,participantsDelta:8999940,viewsDelta:8998800,qualityStatus:'unverified'}),
 ]);
 const headline=[...html.matchAll(/<strong>(.*?)<\/strong>/g)].map(match=>match[1]);
 assert.deepEqual(headline.slice(0,4),['60','+10','1,200','+200']);
 assert.doesNotMatch(plain(html),/9,000,000|8,998,800/);
 assert.match(plain(html),/最新采样日该项缺测或未核验/);
 assert.match(plain(html),/2026-10-22— · 来源未核验/);
});

test('recent seven Beijing calendar days compute real play change only against the immediately preceding verified day',()=>{
 const observed=[
  point({id:19,date:'2026-10-19',capturedAt:'2026-10-19T10:00:00.000Z',views:1100}),
  point({id:20,date:'2026-10-20',capturedAt:'2026-10-20T10:00:00.000Z',views:1000}),
  point({id:21,date:'2026-10-21',capturedAt:'2026-10-21T10:00:00.000Z',views:1250,viewsDelta:999}),
  point({id:23,date:'2026-10-23',capturedAt:'2026-10-23T10:00:00.000Z',views:1240}),
 ];
 const before=JSON.stringify(observed),days=recentTopicPlayDays([...observed].reverse());
 assert.equal(days.length,7);
 assert.deepEqual(Array.from(days,day=>day.date),['2026-10-23','2026-10-22','2026-10-21','2026-10-20','2026-10-19','2026-10-18','2026-10-17']);
 assert.equal(days[0].viewsDelta,null,'missing 22 October must not compare 23 October to 21 October');
 assert.equal(days[1].missing,'未采样');
 assert.equal(days[2].viewsDelta,250,'derive from the two actual observed totals, not a contradictory stored delta');
 assert.equal(days[3].viewsDelta,-100,'retain genuine negative corrections');
 assert.equal(days[4].viewsDelta,null,'no 18 October baseline exists');
 assert.equal(JSON.stringify(observed),before,'calendar display must not mutate observations');
 const text=plain(render(observed));
 assert.ok(text.includes('截至最近保存的采样日 2026-10-23，向前 7 个日历日'));
 assert.ok(text.includes('2026-10-22— · 未采样'));
 assert.ok(text.includes('2026-10-231,240'),text);
 assert.ok(text.includes('+250'));
 assert.ok(text.includes('-100'));
});

test('unverified, absent and malformed play values never become daily growth or synthetic zero',()=>{
 const rows=[
  point({id:1,date:'2026-10-21',capturedAt:'2026-10-21T10:00:00.000Z',views:0}),
  point({id:2,date:'2026-10-22',capturedAt:'2026-10-22T10:00:00.000Z',views:200,qualityStatus:'unverified'}),
  point({id:3,date:'2026-10-23',capturedAt:'2026-10-23T10:00:00.000Z',views:400}),
 ];
 const days=recentTopicPlayDays(rows);
 assert.equal(days[0].viewsDelta,null,'unverified 22 October is not a baseline');
 assert.equal(days[1].views,null);
 assert.equal(days[1].missing,'来源未核验');
 assert.equal(days[2].views,0,'an actually observed zero remains zero');
 assert.equal(days[2].viewsDelta,null,'zero current total still requires an adjacent previous observation');
 assert.equal(recentTopicPlayDays([]).length,0);
 assert.equal(recentTopicPlayDays([point({date:'2026-02-30',views:100})]).length,0,'invalid calendar date cannot anchor a fabricated week');
});

test('participant trend uses participant observations, never borrows playback deltas',()=>{
 const rows=[point({date:'2026-10-24',participants:100,views:5000}),point({id:2,date:'2026-10-25',participants:90,views:6000}),point({id:3,date:'2026-10-26',participants:null,views:8000})];
 const result=recentTopicPlayDays(rows,7,'participants');
 assert.equal(result[0].viewsDelta,null);
 assert.equal(result[1].viewsDelta,-10);
 assert.equal(recentTopicPlayDays(rows)[0].viewsDelta,2000);
});
