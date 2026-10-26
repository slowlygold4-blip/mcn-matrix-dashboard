import test from 'node:test';
import assert from 'node:assert/strict';
import {sortTuantuanRoster,resolveRosterPage} from '../lib/tuantuan-roster-view.mjs';
import {filterTuantuanRoster,rosterModeCounts,tuantuanRosterExport} from '../lib/tuantuan-roster.mjs';

const row = (key, source, accounts = []) => ({key, source, accounts});
const keys = rows => rows.map(item => item.key);

test('both rank directions keep display-missing values last and preserve genuine zero', () => {
 const rows = [row('zero', {posts: 1, plays: 0}), row('high', {posts: 2, plays: 100}),
  row('empty', {posts: 0, plays: 0}), row('negative', {posts: 1, plays: -1}),
  row('unknown', null), row('invalid', {posts: 1, plays: '20'})];
 assert.deepEqual(keys(sortTuantuanRoster(rows, 'plays', 'asc')).slice(0, 2), ['zero', 'high']);
 assert.deepEqual(keys(sortTuantuanRoster(rows, 'plays', 'desc')).slice(0, 2), ['high', 'zero']);
 assert.equal(keys(sortTuantuanRoster(rows, 'posts', 'asc'))[0], 'empty');
 assert.deepEqual(keys(rows), ['zero', 'high', 'empty', 'negative', 'unknown', 'invalid']);
});

test('四范围、分类和搜索后的 CSV 与当前全部筛选行一致，不截为分页行',()=>{
 const rows=Array.from({length:96},(_,i)=>row(`id-${i}`,{
  name:`同组作者${i}`,douyinId:`id-${i}`,posts:1,plays:i===0?0:i,likes:i===1?null:i,
  slicePosts:i%2===0?1:0,creationPosts:i%2===1?1:0,
 },i<32?[{id:i+1,enabled:true,classification:{labels:[]}}]:i<64?[{id:i+1,enabled:false,classification:{labels:[]}}]:[]));
 assert.deepEqual(rosterModeCounts(rows),{all:96,monitored:32,paused:32,'source-only':32});
 for(const mode of ['all','monitored','paused','source-only'])for(const classification of ['all','slice','original']){
  const filtered=sortTuantuanRoster(filterTuantuanRoster(rows,{mode,classification,query:'同组'}),'plays','asc');
  const exported=tuantuanRosterExport(filtered);
  assert.equal(exported.length,filtered.length+1);
  assert.deepEqual(exported.slice(1).map(cells=>cells[1]),filtered.map(row=>row.source.douyinId));
  assert.ok(exported.slice(1).every(cells=>mode==='all'||cells[2]===({monitored:'启用主页监控',paused:'监控暂停','source-only':'仅表格来源'})[mode]));
  const page=resolveRosterPage({scope:mode,page:1},mode,filtered.length);
  assert.equal(filtered.slice(0,page.end).length,Math.min(30,filtered.length));
 }
 const paused=filterTuantuanRoster(rows,{mode:'paused'});
 assert.equal(tuantuanRosterExport(paused).length,33);
 assert.equal(tuantuanRosterExport(rows)[1][5],0);
 assert.equal(tuantuanRosterExport(rows)[2][6],null);
});

test('equal metrics keep a stable account key in either direction or refreshed input order', () => {
 const rows = [row('b', {likes: 12}), row('a', {likes: 12}), row('c', {likes: null})];
 assert.deepEqual(keys(sortTuantuanRoster(rows, 'likes', 'asc')), ['a', 'b', 'c']);
 assert.deepEqual(keys(sortTuantuanRoster([...rows].reverse(), 'likes', 'desc')), ['a', 'b', 'c']);
});

test('name sorting uses the displayed source or monitor name, with unnamed authors last', () => {
 const rows = [row('b', {name: '作者10'}), row('a', null, [{label: '作者2'}]), row('c', null)];
 assert.deepEqual(keys(sortTuantuanRoster(rows, 'name', 'asc')), ['a', 'b', 'c']);
 assert.deepEqual(keys(sortTuantuanRoster(rows, 'name', 'desc')), ['b', 'a', 'c']);
});

test('changed category, search, or roster identity resets to the first page even at equal counts', () => {
 const old = {scope: 'all', page: 4};
 assert.equal(resolveRosterPage(old, 'all', 150).page, 4);
 assert.equal(resolveRosterPage(old, 'slice', 150).page, 1);
 assert.equal(resolveRosterPage(old, 'search', 150).page, 1);
 assert.equal(resolveRosterPage(old, 'changed-ids', 150).page, 1);
});

test('shrink and regrow cannot resurrect an obsolete page; empty ranges read 0 to 0', () => {
 const shrunk = resolveRosterPage({scope: 'all', page: 6}, 'all', 40);
 assert.equal(shrunk.page, 2);
 assert.equal(resolveRosterPage(shrunk, 'all', 200).page, 2);
 assert.deepEqual(resolveRosterPage(shrunk, 'all', 0), {scope: 'all', page: 1, pages: 1, start: 0, end: 0});
 assert.equal(resolveRosterPage({scope: 'all', page: -1}, 'all', 200).page, 1);
});

test('ranking retains alias search evidence and export contains every filtered row beyond the page', () => {
 const rows = Array.from({length: 65}, (_, i) => row(`id-${i}`, {
  name: `作者${i}`, douyinId: String(i), douyinIds: [String(i), `alias-${i}`], plays: i, posts: 1,
  sourceTitles: ['原表', '补充表'],
 }));
 const ordered = sortTuantuanRoster(filterTuantuanRoster(rows), 'plays', 'asc');
 const view = resolveRosterPage({scope: 'all', page: 2}, 'all', ordered.length);
 assert.equal(ordered.slice(view.start - 1, view.end).length, 30);
 assert.equal(tuantuanRosterExport(ordered).length, 66);
 const found = filterTuantuanRoster(ordered, {query: 'alias-64'});
 assert.equal(found.length, 1);
 assert.equal(tuantuanRosterExport(found)[1][1], '64 / alias-64');
 assert.equal(tuantuanRosterExport(found)[1][7], '原表 / 补充表');
});
