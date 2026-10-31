import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePost,normalizeCollection,normalizeManualCollection} from '../lib/providers/normalize.mjs';
import {summarizeWorkLikeComparability} from '../lib/work-like-comparability.mjs';
import {DatabaseSync} from 'node:sqlite';
import {persistPosts} from '../lib/post-persistence.mjs';

const id='7300000000000000000';
const account={id:1,type:'account',provider:'public-web',platform:'douyin',locator:'MS4wLjABAAAAscopeFixture',label:'指标作用域'};
const counters={digg_count:900000,comment_count:800000,share_count:700000,collect_count:600000,play_count:500000};
const actual={likes:null,comments:null,shares:null,collects:null,plays:null};
const values=post=>Object.fromEntries(Object.keys(actual).map(key=>[key,post[key]]));
const item=extra=>({aweme_id:id,author:{sec_uid:account.locator,uid:'123456',nickname:'作者',...counters},...extra});

test('missing work statistics never borrow the author counters',()=>{
 const input=item({}),before=structuredClone(input);
 assert.deepEqual(values(normalizePost(input)),actual);
 assert.deepEqual(input,before);
});

test('author creation date, profile link and biography are never adopted as work metadata',()=>{
 const input={aweme_id:id,author:{id:'123456',created_at:'2026-10-31T03:00:00.000Z',
  url:'https://www.douyin.com/user/profileFixture',description:'作者简介'}};
 const post=normalizePost(input);
 assert.equal(post.publishedAt,null);
 assert.equal(post.caption,'');
 assert.equal(post.url,`https://www.douyin.com/video/${id}`);
 const missingId=normalizePost({author:input.author},'scope');
 assert.match(missingId.externalId,/^scope-[a-f0-9]{24}$/);
 assert.notEqual(missingId.externalId,input.author.id);
});

test('nested author, user and sibling counters are not metrics of this work',()=>{
 for(const extra of [{author:{likes:123,comments:456,views:789}},
   {statistics:{author:{...counters}}},{stats:{user:{...counters}}},
   {metrics:{recommendation:{...counters}}},{recommendation:{...counters}}]){
  assert.deepEqual(values(normalizePost(item(extra))),actual);
 }
});

test('explicit flat work statistics and true zero remain valid without rewriting input',()=>{
 for(const container of [null,'statistics','stats','metrics']){
  for(const count of [0,23,'42']){
   const raw={digg_count:count,comment_count:count,share_count:count,collect_count:count,play_count:count};
   const input=item(container?{[container]:raw}:raw),before=structuredClone(input);
   assert.deepEqual(values(normalizePost(input)),Object.fromEntries(Object.keys(actual).map(key=>[key,Number(count)])));
   assert.deepEqual(input,before);
  }
 }
 // A declared statistics container owns its missing fields, even if another
 // part of the response has counters that happen to share a field name.
 assert.deepEqual(values(normalizePost(item({statistics:{},...counters}))),actual);
});

test('automatic and manual imports keep independent account likes while work likes remain missing',()=>{
 const work=item({}),capturedAt='2026-10-31T04:00:00.000Z';
 const auto=normalizeCollection(account,{profile:{user:{follower_count:10,total_favorited:345,aweme_count:1}},
   works:{aweme_list:[work]}},{capturedAt});
 const manual=normalizeManualCollection(account,{capturedAt,snapshot:{followers:10,totalLikes:345,totalPosts:1},posts:[work]});
 for(const collection of [auto,manual]){
  assert.equal(collection.snapshot.totalLikes,345);
  assert.equal(collection.posts[0].likes,null);
 }
 assert.ok(auto.warnings.includes('部分作品缺少点赞数'));
});

test('missing work likes cannot create a false adjacent-day baseline or growth comparison',()=>{
 const rows=[{target_id:1,external_id:id,captured_at:'2026-10-30T04:00:00.000Z',likes:8},
   {target_id:1,external_id:id,captured_at:'2026-10-31T04:00:00.000Z',likes:normalizePost(item({})).likes}];
 const result=summarizeWorkLikeComparability(rows,{enabled:[account],asOf:'2026-10-31T05:00:00.000Z'});
 assert.deepEqual(result.platforms,[{platform:'douyin',knownTodayWorks:0,comparableWorks:0,missingBaselineWorks:0,conflictingWorks:0}]);
});

test('real storage retains yesterday evidence without fabricating a current work-like observation',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec(`CREATE TABLE posts(id INTEGER PRIMARY KEY,target_id INTEGER,external_id TEXT,author_id TEXT,
   author_name TEXT,caption TEXT,published_at TEXT,likes INTEGER,comments INTEGER,shares INTEGER,
   collects INTEGER,plays INTEGER,url TEXT,first_seen_at TEXT,last_seen_at TEXT,raw_json TEXT,
   UNIQUE(target_id,external_id));
   CREATE TABLE post_metrics(post_id INTEGER,captured_at TEXT,likes INTEGER,comments INTEGER,
   shares INTEGER,collects INTEGER,plays INTEGER,UNIQUE(post_id,captured_at));`);
  persistPosts(db,{target:account,posts:[normalizePost(item({statistics:{digg_count:8}}))],capturedAt:'2026-10-30T04:00:00.000Z'});
  persistPosts(db,{target:account,posts:[normalizePost(item({}))],capturedAt:'2026-10-31T04:00:00.000Z'});
  assert.equal(db.prepare('SELECT likes FROM posts').get().likes,8);
  const observations=db.prepare('SELECT captured_at,likes FROM post_metrics ORDER BY captured_at').all();
  assert.deepEqual(observations.map(r=>[r.captured_at,r.likes]),[
   ['2026-10-30T04:00:00.000Z',8],['2026-10-31T04:00:00.000Z',null]]);
  const records=db.prepare('SELECT p.target_id,p.external_id,m.captured_at,m.likes FROM posts p JOIN post_metrics m ON m.post_id=p.id').all();
  const result=summarizeWorkLikeComparability(records,{enabled:[account],asOf:'2026-10-31T05:00:00.000Z'});
  assert.equal(result.platforms[0].knownTodayWorks,0);
  assert.equal(result.platforms[0].comparableWorks,0);
 }finally{db.close();}
});
