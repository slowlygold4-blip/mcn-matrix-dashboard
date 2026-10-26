import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {latestSources,tableFoundation} from '../lib/table-foundation.mjs';
import {buildTuantuanRoster} from '../lib/tuantuan-roster.mjs';

test('latest completed revision wins; exact ID dedup retains source-only authors and never invents metrics',()=>{
 const job=(id,created_at,revision,rows)=>({id,created_at,request_json:JSON.stringify({fileName:'同一登记表.xlsx',sourceRevision:revision,rows})});
 const sources=latestSources([job('old','2026-01-01',1,[{board:'一条小团团切片矩阵',platform:'douyin',douyinId:'stale'}]),
  job('new','2026-01-02',2,[{board:'一条小团团切片矩阵',platform:'douyin',douyinId:'ＡＢＣ',name:'新增',videoId:'7695811343009594289',sourceRow:2},
   {board:'玉麒麟切片矩阵',platform:'douyin',douyinId:'other',sourceRow:3},
   {board:'一条小团团切片矩阵',platform:'douyin',name:'不可猜',sourceRow:4},
   {board:'一条小团团切片矩阵',platform:'douyin',douyinId:'base',videoId:'bad',sourceRow:5}])]);
 assert.equal(sources.length,1);assert.equal(sources[0].job.id,'new');
 const result=tableFoundation({sources,baseAuthors:[{douyinId:'base'}],baseWorks:[],targetIds:new Map()});
 assert.equal(result.authors.length,1);assert.equal(result.authors[0].douyinId,'ABC');
 assert.equal(result.authors[0].plays,null);assert.equal(result.authors[0].posts,null);
 assert.equal(result.works.length,1);assert.equal(result.works[0].plays,null);
 assert.equal(result.stats.unkeyedRows,1);assert.equal(result.stats.baseAuthorEvidence,1);
 assert.equal(result.otherAuthors.length,1);assert.equal(result.otherAuthors[0].board,'玉麒麟切片矩阵');
 const roster=buildTuantuanRoster([{name:'原表',douyinId:'base',targetIds:[]}],[],result.authors);
 assert.equal(roster.counts.all,2);assert.equal(roster.counts.supplementSource,1);
});

test('public table foundation is sealed, deduplicated and contains no raw private fields',async()=>{
 const root=new URL('../public/table-foundation/',import.meta.url);
 const index=JSON.parse(await readFile(new URL('index.json',root),'utf8'));
 assert.equal(index.version,1);assert.equal(index.stats.sheets,20);
 assert.equal(index.files.length,7);
 const parts={};
 for(const file of index.files){
  const bytes=await readFile(new URL(file.path,root));
  assert.equal(bytes.length,file.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);
  const body=JSON.parse(bytes);assert.equal(body.revision,index.revision);assert.equal(body.items.length,file.count);
  parts[file.path]=body.items;
 }
 assert.equal(parts['authors.json'].length,index.stats.additionalAuthors);
 assert.equal(parts['works.json'].length,index.stats.additionalWorks);
 assert.equal(parts['observations.json'].length,index.stats.sourceMetricObservations);
 assert.equal(parts['other-authors.json'].length,index.stats.otherAuthors);
 assert.equal(parts['other-works.json'].length,index.stats.otherWorks);
 assert.equal(parts['pending-authors.json'].length,index.stats.pendingAuthors);
 const ids=new Set(parts['authors.json'].map(row=>row.douyinId.toLowerCase()));
 assert.equal(ids.size,parts['authors.json'].length);
 const works=new Set(parts['works.json'].map(row=>row.contentId));
 assert.equal(works.size,parts['works.json'].length);
 for(const row of [...parts['authors.json'],...parts['works.json'],...parts['observations.json'],...parts['other-authors.json'],...parts['other-works.json'],...parts['pending-authors.json']]){
  assert.ok(!Object.keys(row).some(key=>/cookie|token|authorization|reward|bonus|private|metadata/i.test(key)));
  if('plays' in row)assert.ok(row.plays===null||Number.isSafeInteger(row.plays));
 }
 for(const row of parts['observations.json']){
  assert.match(row.contentId,/^\d{16,22}$/);assert.ok(row.observedAt===null||Number.isFinite(Date.parse(row.observedAt)));
 }
 for(const row of parts['pending-authors.json']){
  assert.equal(row.sourceOnly,true);
  assert.deepEqual(row.targetIds,[]);
  for(const field of ['posts','plays','likes','followers'])assert.equal(row[field],null);
  assert.ok(Array.isArray(row.sourceRows)&&row.sourceRows.length>0);
 }
});
