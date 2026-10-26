import test from 'node:test';
import assert from 'node:assert/strict';
import * as exports from '../../mcn-public-site/lib/replica-export.mjs';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {growthSeries} from '../../mcn-public-site/lib/replica-trends.mjs';
import {csv} from '../../mcn-public-site/lib/replica-model.mjs';
import {workspaceSelectionScope} from '../../mcn-public-site/lib/replica-navigation.mjs';

const stage=new URL('../data/public-replica-staging/publisher-2026-10-01T05-08-10-925Z/',import.meta.url);
const manifest=JSON.parse(fs.readFileSync(new URL('manifest.json',stage)));
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function readPart(path){
  const part=manifest.files.find(x=>x.path===path);assert.ok(part,`declared ${path}`);
  const bytes=fs.readFileSync(new URL(path,stage));assert.equal(bytes.length,part.bytes);assert.equal(sha(bytes),part.sha256);
  const body=JSON.parse(bytes);assert.equal(body.asOf,manifest.asOf);assert.equal(body.timeZone,manifest.timeZone);
  if(body.items){assert.equal(body.items.length,part.count);assert.ok(body.items.every(x=>x.targetId===part.targetId));}
  return body;
}
const catalog=readPart('catalog.json'),account=catalog.accounts.find(a=>a.id===234);
const daily=readPart('daily/234.json').items;
const points=manifest.files.filter(x=>x.kind==='daily').flatMap(x=>readPart(x.path).items);
const start='2026-09-12',end='2026-09-14',otherStart='2026-09-20',otherEnd='2026-09-21';
const at=(id,date)=>points.find(p=>p.targetId===id&&p.date===date);
const eligible=catalog.accounts.filter(a=>[start,end,otherStart,otherEnd].every(d=>at(a.id,d)?.followers!=null));
assert.ok(eligible.length>=2,'real four-endpoint account sample');
const decode=table=>table.slice(1).map(row=>Object.fromEntries(table[0].map((key,i)=>[key,row[i]])));
function independentSeries(accounts,source,{start,end,otherStart=null,otherEnd=null,metric='followers',visibleOffset=0,visibleDays=90}){
  const field=metric==='estimated'?'likes':metric,index=new Map(source.map(p=>[`${p.targetId}/${p.date}`,p]));
  const ids=accounts.filter(a=>[start,end,...(otherStart?[otherStart,otherEnd]:[])].every(d=>index.get(`${a.id}/${d}`)?.[field]!=null)).map(a=>a.id).sort((a,b)=>a-b);
  const dates=(s,e)=>s?Array.from({length:Math.max(0,Math.min(visibleDays,(Date.parse(e)-Date.parse(s))/86400000+1-visibleOffset))},(_,i)=>new Date(Date.parse(s)+(i+visibleOffset)*86400000).toISOString().slice(0,10)):[];
  const A=dates(start,end),B=dates(otherStart,otherEnd),point=(date,base)=>{if(!date)return {value:null,known:0};const known=ids.filter(id=>index.get(`${id}/${date}`)?.[field]!=null),sum=known.reduce((n,id)=>n+index.get(`${id}/${date}`)[field]-index.get(`${id}/${base}`)[field],0);return {value:ids.length&&known.length===ids.length?sum*(metric==='estimated'?100:1):null,known:known.length};};
  return {ids,points:Array.from({length:Math.max(A.length,B.length)},(_,i)=>({day:i+visibleOffset,currentDate:A[i]??null,currentNetChange:point(A[i],start).value,currentKnown:point(A[i],start).known,comparisonDate:B[i]??null,comparisonNetChange:point(B[i],otherStart).value,comparisonKnown:point(B[i],otherStart).known}))};
}

test('MCN interval curve export has a traceable pure-data contract', () => {
  assert.equal(typeof exports.trendExport, 'function');
});

test('MCN complete account history export has an identity and partition contract', () => {
  assert.equal(typeof exports.historyExport, 'function');
});

test('actual sealed history retains every requested daily, work and metric record with correct immutable identity',()=>{
  for(const [kind,path] of [['daily','daily/234.json'],['works','works/234.json'],['workMetrics','work-metrics/234.json']]){
    const source=readPart(path).items,table=exports.historyExport({rows:source,kind,account,manifest}),rows=decode(table),part=manifest.files.find(p=>p.path===path);
    assert.equal(rows.length,source.length);assert.deepEqual(rows.map(r=>r.id),source.map(r=>r.id));
    for(let i=0;i<rows.length;i++){const row=rows[i];assert.equal(row.targetId,234);assert.equal(row.platform,account.platform);assert.equal(row.label,account.label);assert.equal(row.asOf,manifest.asOf);assert.equal(row.timeZone,'Asia/Shanghai');assert.equal(row.sourcePart,path);assert.equal(row.sourcePartSha256,part.sha256);assert.equal(row.requestedStart,null);assert.equal(row.requestedEnd,null);if(kind==='daily'){assert.equal(row.followersAt,source[i].followersAt);assert.equal(row.sourceChecksum,source[i].sourceChecksum);assert.equal(row.likesDelta,source[i].likesDelta);}else assert.equal(row.playsNote,source[i].playsEvidence?.note??'来源播放字段未经独立核验');}
  }
});

test('real interval exports cannot label out-of-range days as belonging to the requested interval',()=>{
  assert.throws(()=>exports.historyExport({rows:daily,kind:'daily',account,manifest,start:'2026-09-30',end:'2026-10-01'}));
  const selected=daily.filter(x=>x.date>='2026-09-30'&&x.date<='2026-10-01'),rows=decode(exports.historyExport({rows:selected,kind:'daily',account,manifest,start:'2026-09-30',end:'2026-10-01'}));
  assert.equal(rows.length,selected.length);assert.ok(rows.every(x=>x.date>='2026-09-30'&&x.date<='2026-10-01'));assert.ok(rows.every(x=>x.requestedStart==='2026-09-30'&&x.requestedEnd==='2026-10-01'));
});

test('real curve export fixes source publication, four-endpoint identities and unequal interval semantics',()=>{
  const accounts=catalog.accounts.filter(a=>a.enabled),options={start,end,otherStart,otherEnd,metric:'followers',visibleOffset:0,visibleDays:90},expected=independentSeries(accounts,points,options);
  const rows=decode(exports.trendExport({accounts,points,manifest,options})),meta=rows.find(x=>x.recordType==='metadata'),cohort=rows.filter(x=>x.recordType==='cohort'),line=rows.filter(x=>x.recordType==='point');
  assert.equal(meta.asOf,manifest.asOf);assert.equal(meta.start,start);assert.equal(meta.end,end);assert.equal(meta.otherStart,otherStart);assert.equal(meta.otherEnd,otherEnd);assert.deepEqual(JSON.parse(meta.cohortTargetIds),expected.ids);assert.deepEqual(JSON.parse(meta.selectedTargetIds),accounts.map(a=>a.id).sort((a,b)=>a-b));assert.equal(meta.cohortCount,expected.ids.length);assert.equal(meta.selectedCount,accounts.length);
  assert.deepEqual(cohort.map(x=>x.targetId),expected.ids);assert.deepEqual(line.map(({day,currentDate,currentNetChange,currentKnown,comparisonDate,comparisonNetChange,comparisonKnown})=>({day,currentDate,currentNetChange,currentKnown,comparisonDate,comparisonNetChange,comparisonKnown})),expected.points);
  assert.equal(line[0].currentNetChange,0);assert.equal(line[0].comparisonNetChange,0);assert.equal(line.at(-1).comparisonDate,null);assert.equal(line.at(-1).comparisonNetChange,null);
  for(const row of cohort){const a=at(row.targetId,start),b=at(row.targetId,end),c=at(row.targetId,otherStart),d=at(row.targetId,otherEnd);assert.equal(row.currentBaseline,a.followers);assert.equal(row.currentEnd,b.followers);assert.equal(row.currentBaselineAt,a.followersAt??a.capturedAt);assert.equal(row.currentEndAt,b.followersAt??b.capturedAt);assert.equal(row.comparisonBaseline,c.followers);assert.equal(row.comparisonEnd,d.followers);assert.equal(row.dailyPartSha256,manifest.files.find(p=>p.path===`daily/${row.targetId}.json`).sha256);}
});

test('same displayed name on two platforms never merges stable source-backed author IDs',()=>{
  // Only display metadata is deliberately synthetic; endpoint times and source partition hashes remain real.
  const accounts=eligible.slice(0,2).map((a,i)=>({...a,label:'=同名账号',platform:i?'bilibili':'douyin'})),options={start,end,otherStart,otherEnd,visibleOffset:0},rows=decode(exports.trendExport({accounts,points,manifest,options})),cohort=rows.filter(r=>r.recordType==='cohort');
  assert.equal(cohort.length,2);assert.deepEqual(cohort.map(r=>r.targetId),accounts.map(a=>a.id).sort((a,b)=>a-b));assert.deepEqual(new Set(cohort.map(r=>r.platform)),new Set(['douyin','bilibili']));assert.ok(cohort.every(r=>r.label==='=同名账号'));assert.ok(csv(exports.trendExport({accounts,points,manifest,options})).includes("'=同名账号"));
});

test('missing interiors break the fixed cohort line rather than masquerading as zero growth',()=>{
  const accounts=eligible.slice(0,2),mid='2026-09-13',source=points.filter(p=>!(p.targetId===accounts[0].id&&p.date===mid));
  const rows=decode(exports.trendExport({accounts,points:source,manifest,options:{start,end,otherStart,otherEnd,visibleOffset:0}})),meta=rows.find(r=>r.recordType==='metadata'),line=rows.filter(r=>r.recordType==='point');
  assert.equal(meta.cohortCount,2);assert.equal(line.find(p=>p.currentDate===mid).currentNetChange,null);assert.ok(line.find(p=>p.currentDate===mid).currentKnown<2);assert.equal(line[0].currentNetChange,0);
});

test('real negative endpoint change is not clamped and estimated views use the same net-like cohort',()=>{
  const groups=Map.groupBy(points,p=>p.targetId);let found;
  for(const [id,items] of groups){const ordered=[...items].sort((a,b)=>a.date.localeCompare(b.date));for(let i=1;i<ordered.length;i++)if(ordered[i].likes!=null&&ordered[i-1].likes!=null&&ordered[i].likes<ordered[i-1].likes){found={id,base:ordered[i-1],current:ordered[i]};break;}if(found)break;}
  assert.ok(found,'real negative like counter endpoint');const a=catalog.accounts.find(a=>a.id===found.id),options={start:found.base.date,end:found.current.date,metric:'estimated',visibleOffset:0},rows=decode(exports.trendExport({accounts:[a],points,manifest,options})),last=rows.filter(r=>r.recordType==='point').at(-1);
  assert.equal(last.currentNetChange,(found.current.likes-found.base.likes)*100);assert.ok(last.currentNetChange<0);assert.equal(rows[0].metricPolicy,'net-like-change-times-100-not-actual-views');assert.ok(csv(exports.trendExport({accounts:[a],points,manifest,options})).includes('"'+last.currentNetChange+'"'));
});

test('no comparable real endpoints export empty identity cohort and unknown values, not zero',()=>{
  const options={start:'2026-08-01',end:'2026-08-02',visibleOffset:0},rows=decode(exports.trendExport({accounts:[account],points,manifest,options}));
  assert.equal(rows[0].cohortCount,0);assert.equal(rows[0].cohortTargetIds,'[]');assert.equal(rows.filter(r=>r.recordType==='cohort').length,0);assert.ok(rows.filter(r=>r.recordType==='point').every(r=>r.currentNetChange===null));
});

test('curve export rejects points observed after the frozen publication rather than stamping a false asOf',()=>{
  const source=daily.filter(x=>x.date>='2026-09-30').map(x=>({...x}));for(const p of source)if(p.date==='2026-10-01'){p.capturedAt='2026-10-01T06:00:00.000Z';p.followersAt=p.capturedAt;}
  assert.throws(()=>exports.trendExport({accounts:[account],points:source,manifest,options:{start:'2026-09-30',end:'2026-10-01',metric:'followers',visibleOffset:0}}));
});

test('wrong author, wrong partition, duplicate identities and broken hashes fail closed',()=>{
  for(const mutation of [m=>m.timeZone='UTC',m=>m.asOf='2026-10-01',m=>m.files.find(x=>x.path==='daily/234.json').targetId=235,m=>m.files.find(x=>x.path==='daily/234.json').kind='works',m=>m.files.find(x=>x.path==='daily/234.json').sha256='wrong',m=>m.files.push({...m.files.find(x=>x.path==='daily/234.json')})]){const bad=structuredClone(manifest);mutation(bad);assert.throws(()=>exports.historyExport({rows:daily,kind:'daily',account,manifest:bad}));}
  assert.throws(()=>exports.historyExport({rows:[{...daily[0],targetId:235}],kind:'daily',account,manifest}));assert.throws(()=>exports.historyExport({rows:[daily[0],daily[0]],kind:'daily',account,manifest}));assert.throws(()=>exports.trendExport({accounts:[account,account],points,manifest,options:{start,end,visibleOffset:0}}));
});

test('fixed history whitelist cannot spill arbitrary private attributes into CSV',()=>{
  const source=readPart('works/234.json').items.slice(0,1).map(p=>({...p,raw:'PRIVATE_SYNTHETIC_CANARY',cookie:'PRIVATE_SYNTHETIC_CANARY',privatePath:'PRIVATE_SYNTHETIC_CANARY'}));
  const table=exports.historyExport({rows:source,kind:'works',account,manifest});assert.ok(!csv(table).includes('PRIVATE_SYNTHETIC_CANARY'));assert.ok(!table[0].includes('raw'));assert.ok(!table[0].includes('cookie'));
});

test('non-daily history cannot claim a requested date filter whose timestamp semantics are not implemented',()=>{
  for(const [kind,path] of [['works','works/234.json'],['workMetrics','work-metrics/234.json']])assert.throws(()=>exports.historyExport({rows:readPart(path).items,kind,account,manifest,start:'2026-09-30',end:'2026-10-01'}));
});

test('source-backed components connect all three export entry points and disable pseudo data animation',()=>{
  const root=new URL('../../mcn-public-site/',import.meta.url),growth=fs.readFileSync(new URL('components/growth-panel.tsx',root),'utf8'),personal=fs.readFileSync(new URL('components/account-panel.tsx',root),'utf8'),page=fs.readFileSync(new URL('app/page.tsx',root),'utf8');
  const renderer=fs.readFileSync(new URL('components/growth-chart.tsx',root),'utf8');
  assert.match(growth,/trendExport\(\{accounts,points,manifest,options:/);assert.match(growth,/visibleOffset:offset,visibleDays:90/);assert.match(renderer,/isAnimationActive=\{false\}/);assert.match(renderer,/connectNulls=\{false\}/);assert.match(growth,/import\('@\/components\/growth-chart'\)/);
  assert.match(personal,/<GrowthPanel[^>]*manifest=\{manifest\}/);assert.match(personal,/historyExport\(\{rows:visible,kind:'daily',account,manifest,start:actualStart,end:actualEnd\}\)/);
  assert.match(page,/<GrowthPanel[^>]*manifest=\{data\.manifest\}/);assert.match(page,/historyExport\(\{rows:hRows,kind,account,manifest:data\?\.manifest\}\)/);
  assert.ok(!growth.includes("const rows=[['指标','当前区间'"));assert.ok(!page.includes('historyFields(kind).map'));
});

test('701-author comparison exports identity JSON once, not repeated in every point or member row',()=>{
  const accounts=catalog.accounts.filter(a=>a.enabled),table=exports.trendExport({accounts,points,manifest,options:{start:'2026-09-12',end:'2026-10-01',metric:'likes',visibleOffset:0}}),rows=decode(table),series=growthSeries(accounts,points,{start:'2026-09-12',end:'2026-10-01',metric:'likes',visibleOffset:0});
  assert.equal(accounts.length,701);assert.equal(rows.filter(r=>r.recordType==='metadata').length,1);assert.equal(rows.filter(r=>r.cohortTargetIds!=null).length,1);assert.equal(rows.filter(r=>r.selectedTargetIds!=null).length,1);assert.equal(rows.filter(r=>r.recordType==='cohort').length,series.cohortCount);assert.ok(Buffer.byteLength(csv(table))<500000);assert.ok(rows.every(r=>r.asOf===manifest.asOf));
});

test('visible window offsets retain the real business baseline and never silently rebase the curve',()=>{
  const options={start:'2026-09-01',end:'2026-10-01',metric:'likes',visibleOffset:15,visibleDays:90},expected=independentSeries([account],points,options),rows=decode(exports.trendExport({accounts:[account],points,manifest,options})),line=rows.filter(r=>r.recordType==='point'),cohort=rows.find(r=>r.recordType==='cohort');
  assert.equal(rows[0].start,'2026-09-01');assert.equal(rows[0].visibleOffset,15);assert.equal(line[0].day,15);assert.equal(line[0].currentDate,'2026-09-16');assert.equal(cohort.currentBaseline,at(234,'2026-09-01').likes);assert.equal(cohort.currentBaselineAt,at(234,'2026-09-01').likesAt);assert.deepEqual(line.map(({day,currentDate,currentNetChange,currentKnown,comparisonDate,comparisonNetChange,comparisonKnown})=>({day,currentDate,currentNetChange,currentKnown,comparisonDate,comparisonNetChange,comparisonKnown})),expected.points);
});

test('multi-year calendar navigation still exports only the requested visible days without fabricating missing early history',()=>{
  const options={start:'2023-01-01',end:'2026-10-01',metric:'followers',visibleOffset:1300,visibleDays:90},rows=decode(exports.trendExport({accounts:[account],points,manifest,options})),line=rows.filter(r=>r.recordType==='point');
  assert.equal(rows[0].start,'2023-01-01');assert.equal(rows[0].end,'2026-10-01');assert.equal(rows[0].visibleOffset,1300);assert.equal(rows[0].cohortCount,0);assert.ok(line.length>0&&line.length<=90);assert.equal(line[0].day,1300);assert.ok(line.every(r=>r.currentNetChange===null));assert.equal(rows.filter(r=>r.recordType==='cohort').length,0);
});

test('the real Tuantuan slice manager scope keeps 276 unique authors and its 68 comparable like identities distinct from global coverage',()=>{
  const selection={board:'all',theme:'tuantuan',tag:'slice',period:'since',start:'2026-09-12',end:'2026-10-01'},accounts=workspaceSelectionScope(selection,catalog.accounts,catalog.boards),options={start:selection.start,end:selection.end,metric:'likes',visibleOffset:0},expected=independentSeries(accounts,points,options),rows=decode(exports.trendExport({accounts,points,manifest,options}));
  assert.equal(accounts.length,276);assert.equal(new Set(accounts.map(a=>a.id)).size,276);assert.ok(accounts.every(a=>a.enabled&&a.classification.theme.key==='tuantuan'&&a.classification.labels.some(l=>l.key==='slice')));assert.equal(rows[0].selectedCount,276);assert.equal(rows[0].cohortCount,68);assert.deepEqual(JSON.parse(rows[0].cohortTargetIds),expected.ids);assert.deepEqual(JSON.parse(rows[0].selectedTargetIds),accounts.map(a=>a.id).sort((a,b)=>a-b));assert.equal(rows.filter(r=>r.recordType==='cohort').length,68);
});
