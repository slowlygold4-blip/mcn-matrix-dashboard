import {publishedFixture} from './helpers/published-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCreatorIntelligence,canonicalSourceAuthors,summarizeSourceObservations} from '../lib/creator-intelligence.mjs';

test('source intelligence counts publication, not playback growth, and leaves missing metrics missing', () => {
  const authors=[{douyinId:'ABC',name:'甲',followers:null},{douyinId:'DEF',name:'乙',followers:40}];
  const works=[
    {contentId:'1234567890123456',douyinId:'abc',author:'甲',publishDate:'2026-10-12',track:'切片',tracks:'切片 / 即梦',plays:120,likes:null,title:'作品一'},
    {contentId:'1234567890123457',douyinId:'def',author:'乙',publishDate:'2026-10-06',track:'即梦',plays:null,likes:5,title:'作品二'},
  ];
  const result=buildCreatorIntelligence(authors,works,{additionalAuthors:1,additionalWorks:1});
  assert.equal(result.counts.tableAuthors,3);
  assert.equal(result.counts.tableWorks,3);
  assert.equal(result.counts.datedWorks,2);
  assert.equal(result.counts.sevenDayWorks,2);
  assert.equal(result.counts.playsKnown,1);
  assert.equal(result.counts.cumulativePlays,120);
  assert.equal(result.counts.likesKnown,1);
  assert.equal(result.counts.authorFollowersKnown,1);
  assert.deepEqual(result.days.map(day=>[day.date,day.works]),[['2026-10-06',1],['2026-10-12',1]]);
  assert.equal(result.leaderboards.all.works.length,1);
  assert.deepEqual(Object.fromEntries(result.tracks.map(track=>[track.track,track.works])),{'即梦':2,'切片':1});
  assert.equal(result.leaderboards['即梦'].works.length,1);
  assert.equal(result.days.find(day=>day.date==='2026-10-12').tracks['即梦'],1);
  assert.equal(result.counts.cumulativePlays,120); // overlap does not inflate matrix total
  assert.match(result.basis,/不是.*区间新增/);
});

test('all-missing source metrics stay unknown while a recorded zero remains zero', () => {
  const authors=[{douyinId:'abc',name:'甲'}];
  const base={contentId:'1234567890123456',douyinId:'abc',author:'甲',publishDate:'2026-10-12',track:'切片'};
  const missing=buildCreatorIntelligence(authors,[{...base,plays:null,likes:null}]);
  assert.equal(missing.counts.activeWorkAuthors,1,'an author with a work still counts without a play sample');
  assert.deepEqual([missing.counts.playsKnown,missing.counts.likesKnown],[0,0]);
  assert.equal(missing.counts.cumulativePlays,null);
  assert.equal(missing.counts.cumulativeLikes,null);
  assert.equal(missing.tracks[0].cumulativePlays,null);
  assert.equal(missing.tracks[0].cumulativeLikes,null);
  assert.deepEqual(missing.leaderboards.all.authors,[],'unknown playback cannot be ranked as zero playback');

  const observedZero=buildCreatorIntelligence(authors,[{...base,plays:0,likes:0}]);
  assert.deepEqual([observedZero.counts.playsKnown,observedZero.counts.likesKnown],[1,1]);
  assert.equal(observedZero.counts.cumulativePlays,0);
  assert.equal(observedZero.counts.cumulativeLikes,0);
  assert.equal(observedZero.tracks[0].cumulativePlays,0);
  assert.equal(observedZero.tracks[0].cumulativeLikes,0);
  assert.equal(observedZero.leaderboards.all.authors[0].cumulativePlays,0);
  assert.equal(observedZero.leaderboards.all.authors[0].cumulativeLikes,0);
});

test('published analysis is derived from exactly the sealed source revision', () => {
  const sample=publishedFixture(),index=sample.source;
  const file=index.files.find(item=>item.path==='insights.json');
  const body=sample.read('creator-source','insights.json');
  assert.equal(file.count,1);
  assert.equal(body.revision,index.revision);
  assert.equal(body.items[0].counts.tableAuthors,index.stats.authors);
  assert.equal(body.items[0].counts.tableWorks,index.stats.works);
  assert.equal(body.items[0].counts.datedWorks+(body.items[0].counts.undatedWorks??0),index.stats.works);
  assert.equal(body.items[0].days.reduce((sum,day)=>sum+day.works,0),body.items[0].counts.datedWorks);
  assert.ok(body.items[0].tracks.reduce((sum,track)=>sum+track.works,0)>index.stats.works);
  for(const track of body.items[0].tracks){const indexed=index.tracks.find(item=>item.name===track.track);assert.ok(indexed);assert.equal(track.works,indexed.works);assert.equal(track.cumulativePlays,indexed.cumulativePlays);}
});

test('unknown publication dates retain identities, cumulative metrics and rankings without inventing timeline points',()=>{
 const authors=[{douyinId:'dated',name:'日期作者'},{douyinId:'undated',name:'未填日期作者'}];
 const works=[
  {contentId:'1234567890123456',douyinId:'dated',publishDate:'2026-10-12',track:'切片',plays:100,likes:5},
  {contentId:'1234567890123457',douyinId:'undated',publishDate:null,track:'切片',plays:200,likes:10},
  {contentId:'1234567890123458',douyinId:'undated',publishDate:'',track:'即梦',plays:null,likes:3},
  {contentId:'1234567890123459',douyinId:'undated',publishDate:'  ',track:'即梦',plays:0,likes:null},
 ];
 const result=buildCreatorIntelligence(authors,works);
 assert.equal(result.counts.tableWorks,4);
 assert.equal(result.counts.datedWorks,1);
 assert.equal(result.counts.undatedWorks,3);
 assert.equal(result.counts.activeWorkAuthors,2);
 assert.equal(result.counts.datedWorkAuthors,1);
 assert.equal(result.counts.cumulativePlays,300);
 assert.equal(result.counts.cumulativeLikes,18);
 assert.equal(result.counts.playsKnown,3);
 assert.equal(result.counts.likesKnown,3);
 assert.equal(result.counts.sevenDayWorks,1);
 assert.deepEqual(result.days.map(day=>[day.date,day.works]),[['2026-10-12',1]]);
 assert.deepEqual(result.days[0].tracks,{'切片':1});
 assert.equal(result.tracks.find(track=>track.track==='即梦').works,2);
 assert.equal(result.leaderboards.all.authors[0].douyinId,'undated');
 assert.equal(result.leaderboards.all.works[0].date,null);
 assert.equal(result.firstDate,'2026-10-12');assert.equal(result.lastDate,'2026-10-12');
 const onlyUndated=buildCreatorIntelligence(authors,works.slice(1));
 assert.equal(onlyUndated.firstDate,null);assert.equal(onlyUndated.lastDate,null);
 assert.equal(onlyUndated.sevenDayStart,null);assert.equal(onlyUndated.counts.sevenDayWorks,0);
 assert.equal(onlyUndated.counts.datedWorks,0);assert.equal(onlyUndated.counts.undatedWorks,3);
 assert.deepEqual(onlyUndated.days,[]);assert.equal(onlyUndated.counts.cumulativePlays,200);
});

test('a nonempty invalid publication date fails explicitly instead of becoming missing data',()=>{
 for(const publishDate of ['2026-02-30','2026-13-01','2026-10-32','not-a-date','2026/10/01',20261001]){
  assert.throws(()=>buildCreatorIntelligence([],[{contentId:'1234567890123456',publishDate}]),/Invalid publication date: 1234567890123456/);
 }
});

test('duplicate work identifiers are refused instead of double-counted', () => {
  assert.throws(()=>buildCreatorIntelligence([], [
    {contentId:'1234567890123456',publishDate:'2026-10-01'},
    {contentId:'1234567890123456',publishDate:'2026-10-02'},
  ]),/Duplicate/);
});

test('reciprocal name-ID zero rows collapse without deleting the source evidence', () => {
  const original=[
    {row:10,name:'某作者',douyinId:'author123',posts:9,plays:100,likes:5,targetIds:[2]},
    {row:20,name:'author123',douyinId:'某作者',posts:0,plays:0,likes:0,targetIds:[]},
    {row:30,name:'另一作者',douyinId:'other456',posts:0,plays:0,likes:0,targetIds:[]},
  ];
  const result=canonicalSourceAuthors(original);
  assert.equal(original.length,3);
  assert.deepEqual(result.authors.map(row=>row.row),[10,30]);
  assert.deepEqual(result.collapsed,[{row:20,canonicalRow:10}]);
});

test('later source observations choose a unique latest value and quarantine same-time conflicts', () => {
  const rows=[
    {contentId:'1234567890123456',observedAt:'2026-10-18T10:00:00Z',plays:100,likes:1},
    {contentId:'1234567890123456',observedAt:'2026-10-19T10:00:00Z',plays:120,likes:2},
    {contentId:'1234567890123457',observedAt:'2026-10-19T10:00:00Z',plays:500,likes:5},
    {contentId:'1234567890123457',observedAt:'2026-10-19T10:00:00Z',plays:600,likes:5},
    {contentId:'not-a-work',observedAt:'2026-10-19T10:00:00Z',plays:999,likes:9},
  ];
  const summary=summarizeSourceObservations(rows.map(row=>({...row,timeBasis:'metric-observation'})));
  assert.deepEqual([summary.rows,summary.uniqueWorks,summary.usableWorks,summary.ambiguousWorks],[5,2,1,1]);
  assert.deepEqual(summary.topWorks.map(row=>[row.contentId,row.plays]),[['1234567890123456',120]]);
});

test('sealed supplemental source sample exposes conflicts without replacing the main works total', () => {
  const body=publishedFixture().read('table-foundation','observations.json');
  const result=summarizeSourceObservations(body.items);
  assert.equal(result.rows,3);
  assert.equal(result.uniqueWorks,2);
  assert.equal(result.ambiguousWorks,1);
  assert.equal(result.usableWorks,1);assert.equal(result.latestAt,null,'提交时间或旧版未说明的时间不能作为指标采样时间');
});
