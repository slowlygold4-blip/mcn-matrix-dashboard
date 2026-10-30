import test from 'node:test';
import assert from 'node:assert/strict';
import {publishedFixture} from './helpers/published-fixture.mjs';
import {creatorPartValid} from '../lib/replica-creator.mjs';
import {buildTuantuanRoster,filterTuantuanRoster,rosterModeCounts,tuantuanRosterExport} from '../lib/tuantuan-roster.mjs';
import {belongsToSourceTrack} from '../lib/source-ledger-track.mjs';
import {filterSourceLedgerRows,sourceLedgerCsv} from '../lib/source-ledger-filters.mjs';

const asOf='2026-10-30T01:00:00.000Z';
const meta={path:'creator/authors.json',kind:'creatorAuthors',count:1};
const author=()=>({...structuredClone(publishedFixture().authors[0]),targetIds:[],posts:0,slicePosts:0,creationPosts:0,aiPosts:0,cupPosts:0,plays:null,likes:null,followers:null});
const part=a=>({version:1,asOf,timeZone:'Asia/Shanghai',revision:'fixture',items:[a]});

test('legacy authors still validate; explicit registration categories are an optional sealed field',()=>{
 const old=author();assert.equal(creatorPartValid(part(old),meta,asOf),true);
 const next={...old,registeredClassifications:['slice','original','ai-remix']};
 assert.equal(creatorPartValid(part(next),meta,asOf),true);
 for(const value of ['slice',null,['unknown'],['slice','slice'],['slice',1],['contest']])
  assert.equal(creatorPartValid(part({...old,registeredClassifications:value}),meta,asOf),false,JSON.stringify(value));
 assert.equal(creatorPartValid(part({...next,registrationEvidence:[{private:'secret'}]}),meta,asOf),false);
});

test('registered zero-work authors survive category filters without fabricating works or collection targets',()=>{
 const a={...author(),registeredClassifications:['slice','original','ai-remix']},roster=buildTuantuanRoster([a],[]);
 for(const classification of a.registeredClassifications){
  assert.deepEqual(filterTuantuanRoster(roster.rows,{classification}),roster.rows);
  assert.deepEqual(rosterModeCounts(roster.rows,classification),{all:1,monitored:0,paused:0,'source-only':1});
 }
 assert.equal(roster.counts.monitored,0);assert.equal(roster.rows[0].source.posts,0);
 assert.equal(roster.rows[0].source.plays,null);assert.equal(roster.rows[0].source.likes,null);
 assert.deepEqual(roster.rows[0].accounts,[]);
});

test('explicit registration and existing work evidence form a union; nicknames never classify an author',()=>{
 const first={...author(),douyinId:'first',name:'AI切片作者',slicePosts:2,registeredClassifications:['original']};
 const second={...author(),douyinId:'second',name:'AI切片作者'};
 const rows=buildTuantuanRoster([first,second],[]).rows;
 for(const classification of ['slice','original'])assert.deepEqual(filterTuantuanRoster(rows,{classification}).map(r=>r.source.douyinId),['first']);
 assert.deepEqual(filterTuantuanRoster(rows,{classification:'ai-remix'}),[]);
 assert.equal(filterTuantuanRoster(rows,{classification:'all'}).length,2);
});

test('CSV preserves registration categories and existing metric column positions for the current filter',()=>{
 const a={...author(),registeredClassifications:['slice','ai-remix']},rows=buildTuantuanRoster([a],[]).rows;
 const output=tuantuanRosterExport(filterTuantuanRoster(rows,{classification:'slice'}));
 const column=output[0].indexOf('登记类别');assert.ok(column>=0);
 assert.equal(output[1][column],'切片 / AI二创');assert.equal(output[1][4],0);assert.equal(output[1][5],null);
 assert.equal(output[0].length,output[1].length);
});

test('the author ledger shares registered categories but never assigns an author category to a work',()=>{
 const a={...author(),registeredClassifications:['slice','original']};
 for(const track of ['切片激励','创作激励']){
  assert.equal(belongsToSourceTrack(a,track,'authors'),true);
  assert.deepEqual(filterSourceLedgerRows([a],{view:'authors',track}),[a]);
 }
 assert.equal(belongsToSourceTrack(a,'__unclassified__','authors'),false);
 assert.equal(belongsToSourceTrack({...a,track:'即梦二创'},'切片激励','works'),false);
 assert.equal(belongsToSourceTrack({...a,registeredClassifications:undefined},'__unclassified__','authors'),true);
 assert.match(sourceLedgerCsv([a],'authors'),/登记类别/);
 assert.match(sourceLedgerCsv([a],'authors'),/切片 \/ 原创/);
 assert.equal(sourceLedgerCsv([{...a,contentId:'7300000000000000001'}],'works').includes('登记类别'),false);
});
