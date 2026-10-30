import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveCollectionHealth,collectionHealthLabel} from '../lib/collection-health.mjs';
import {normalizeCollection,normalizeManualCollection} from '../lib/providers/normalize.mjs';
import {asNonNegativeInteger,checksum} from '../lib/utils.mjs';
import {validateAccountSnapshot} from '../lib/account-snapshot-integrity.mjs';

const account={id:1,type:'account',provider:'public-web',locator:'fixture'};
const profile={followers:12,totalLikes:34,totalPosts:42};
const post={aweme_id:'7300000000000000001',statistics:{digg_count:0}};

test('one returned page never implies all 42 works were collected, even with no warning',()=>{
 const result=normalizeCollection(account,{profile:{user:{follower_count:12,total_favorited:34,aweme_count:42}},works:{aweme_list:[post],has_more:1}});
 assert.equal(result.worksCoverage,'limited');
 assert.equal(result.posts.length,1);assert.equal(result.posts[0].likes,0);
 assert.equal(result.snapshot.totalPosts,42);assert.equal(result.qualityStatus,'validated');
});

test('a terminal page or matching list size alone is not a pagination/identity receipt',()=>{
 for(const works of [{aweme_list:[post],has_more:0},{aweme_list:[post]}]){
  const result=deriveCollectionHealth(account,{...profile,totalPosts:1},[],{works});
  assert.equal(result.worksCoverage,'limited');
 }
});

test('profile-only zero inventory has no complete works-list observation',()=>{
 for(const raw of [{profile:{user:{aweme_count:0}}},{}]){
  assert.equal(deriveCollectionHealth(account,{...profile,totalPosts:0},[],raw).worksCoverage,'unknown');
 }
 const imported=normalizeManualCollection(account,{snapshot:{followers:0,totalLikes:0,totalPosts:0}});
 assert.equal(imported.worksCoverage,'unknown');
 assert.equal(imported.snapshot.totalPosts,0);
});

test('explicit empty list plus real zero inventory is retained; contradictory or unknown inventory is not complete',()=>{
 const raw={works:{aweme_list:[]}};
 assert.equal(deriveCollectionHealth(account,{...profile,totalPosts:0},[],raw).worksCoverage,'complete');
 for(const totalPosts of [null,42,'0',false])assert.notEqual(deriveCollectionHealth(account,{...profile,totalPosts},[],raw).worksCoverage,'complete');
 assert.equal(deriveCollectionHealth(account,{...profile,totalPosts:0},[],{works:{aweme_list:[post]}}).worksCoverage,'limited');
 assert.equal(deriveCollectionHealth(account,{...profile,totalPosts:0},[],
  {first:{aweme_list:[]},second:{posts:[post]}}).worksCoverage,'limited');
});

test('unknown provider coverage remains unknown rather than being upgraded by a returned array',()=>{
 for(const raw of [{worksCoverage:'unknown',works:{aweme_list:[post]}},
  {provenance:{worksCoverage:'unknown'},works:{aweme_list:[post]}}]){
  assert.equal(deriveCollectionHealth(account,profile,[],raw).worksCoverage,'unknown');
 }
});

test('explicit provider labels are preserved; final pagination proof still belongs to the source verifier',()=>{
 for(const coverage of ['complete','limited','retry','unavailable']){
  assert.equal(deriveCollectionHealth(account,profile,[],{worksCoverage:coverage}).worksCoverage,coverage);
 }
 assert.equal(deriveCollectionHealth(account,profile,[],{worksCoverage:'latest-public-window'}).worksCoverage,'limited');
});

test('partial status without any numeric metric is unavailable, not a successful profile update',()=>{
 const result=deriveCollectionHealth(account,{followers:null,totalLikes:null,totalPosts:null},[],{accountStatus:'partial'});
 assert.equal(result.accountStatus,'unavailable');assert.ok(result.accountError);
 assert.equal(deriveCollectionHealth(account,{followers:0},[],{accountStatus:'partial'}).accountStatus,'partial');
});

test('only real nonnegative safe integers substantiate normalized profile status',()=>{
 for(const invalid of ['0',false,true,-1,1.5,Infinity,NaN,{},Number.MAX_SAFE_INTEGER+1]){
  assert.equal(deriveCollectionHealth(account,{followers:invalid,totalLikes:invalid,totalPosts:invalid}).accountStatus,'unavailable');
 }
 assert.equal(deriveCollectionHealth(account,{followers:0,totalLikes:0,totalPosts:0}).accountStatus,'available');
 assert.equal(deriveCollectionHealth(account,{followers:0}).accountStatus,'partial');
});

test('missing or unknown coverage never falls through to a complete label',()=>{
 for(const worksCoverage of [undefined,null,'unknown','unexpected','not-applicable','']){
  const result=collectionHealthLabel({accountStatus:'available',worksCoverage});
  assert.equal(result.key,'pending');assert.doesNotMatch(result.label,/主页与作品已更新/);
 }
 assert.equal(collectionHealthLabel({accountStatus:'available',worksCoverage:'complete'}).key,'complete');
});

test('failure, limited, stale and topic statuses remain separate and inputs remain unchanged',()=>{
 const raw={works:{aweme_list:[post]}},before=structuredClone(raw);
 const result=deriveCollectionHealth(account,profile,[],raw);assert.deepEqual(raw,before);
 assert.equal(collectionHealthLabel({...result,stale:true}).key,'stale');
 for(const worksCoverage of ['retry','unavailable','limited','latest-public-window']){
  assert.equal(collectionHealthLabel({accountStatus:'available',worksCoverage}).key,'profile');
 }
 assert.equal(collectionHealthLabel({accountStatus:'unavailable',worksCoverage:'complete'}),null);
 assert.equal(deriveCollectionHealth({type:'hashtag'},profile,[],raw).worksCoverage,'not-applicable');
});

test('counter conversion never turns booleans, blanks, arrays, fractions or unsafe integers into fake counts',()=>{
 for(const value of [false,true,' ',[],[1],{},1.5,'1.5','1.0000000000000001',Infinity,NaN,-1,'-0',Number.MAX_SAFE_INTEGER+1,'9007199254740993']){
  assert.equal(asNonNegativeInteger(value),null,String(value));
 }
 for(const value of [0,'0',' 0000 ',12,'0012',Number.MAX_SAFE_INTEGER,String(Number.MAX_SAFE_INTEGER)]){
  assert.equal(asNonNegativeInteger(value),Number(value));
 }
 assert.equal(asNonNegativeInteger(false,99),99);
});

test('invalid incoming profile, video, manual and topic counters remain missing end to end',()=>{
 for(const value of [false,true,' ',[],1.5,'1.0000000000000001']){
  const incoming={profile:{user:{follower_count:value,total_favorited:value,aweme_count:value}},
   works:{aweme_list:[{...post,statistics:{digg_count:value,play_count:value}}]},accountStatus:'partial'};
  const result=normalizeCollection(account,incoming);
  assert.deepEqual([result.snapshot.followers,result.snapshot.totalLikes,result.snapshot.totalPosts],[null,null,null]);
  assert.deepEqual([result.posts[0].likes,result.posts[0].plays],[null,null]);
  assert.equal(result.accountStatus,'unavailable');
  const manual=normalizeManualCollection(account,{snapshot:{followers:value,totalLikes:value,totalPosts:value}});
  assert.deepEqual([manual.snapshot.followers,manual.snapshot.totalLikes,manual.snapshot.totalPosts],[null,null,null]);
  const topic=normalizeCollection({type:'hashtag',id:2},{participant_count:value,view_count:value});
  assert.deepEqual([topic.snapshot.hashtagParticipants,topic.snapshot.hashtagViews],[null,null]);
 }
});

test('stored source verification uses the same strict conversion and rejects an old coerced zero without rewriting raw data',()=>{
 const target={...account,locator:'MS4wLjABAAAAFixtureProfile',metadata_json:'{"platform":"douyin"}'};
 const raw={capturedAt:'2026-10-30T02:00:00.000Z',profile:{user:{sec_uid:target.locator,uid:'123456',follower_count:false,total_favorited:12,aweme_count:1}}};
 const row={target_id:1,quality_status:'warning',captured_at:raw.capturedAt,source_checksum:checksum(raw),raw_json:JSON.stringify(raw),followers:0,total_likes:12,total_posts:1};
 const before=row.raw_json;
 assert.equal(validateAccountSnapshot(row,target,'douyin',{metricsOnly:true}).valid,false);
 assert.equal(validateAccountSnapshot({...row,followers:null},target,'douyin',{metricsOnly:true}).valid,true);
 assert.equal(row.raw_json,before);
});

test('topic sample length never becomes a missing or invalid platform work total',()=>{
 const topic={type:'hashtag',id:2};
 for(const video_count of [undefined,null,false,' ',1.5]){
  const result=normalizeCollection(topic,{participant_count:0,view_count:0,video_count,works:{aweme_list:[post]}});
  assert.equal(result.snapshot.hashtagPosts,null);assert.equal(result.posts.length,1);
  assert.deepEqual([result.snapshot.hashtagParticipants,result.snapshot.hashtagViews],[0,0]);
  const manual=normalizeManualCollection(topic,{posts:[post],snapshot:{hashtagPosts:video_count}});
  assert.equal(manual.snapshot.hashtagPosts,null);assert.equal(manual.posts.length,1);
 }
 assert.equal(normalizeCollection(topic,{video_count:'12'}).snapshot.hashtagPosts,12);
});
