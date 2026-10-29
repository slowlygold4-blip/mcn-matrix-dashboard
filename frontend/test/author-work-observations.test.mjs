import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeAuthorWorks,orderAuthorWorks} from '../lib/author-unified-works.mjs';

const asOf='2026-10-29T08:00:00.000Z';
const author={name:'作者甲',douyinId:'author-a',douyinIds:['author-a','previous-a'],targetIds:[9]};
const contentId='7300000000000000001';
const source={contentId,douyinId:'author-a',likes:10,plays:100,title:'作品',publishDate:'2026-09-12'};
const platform={id:1,targetId:9,externalId:contentId,likes:12,plays:50,lastObservedAt:'2026-10-20T08:00:00.000Z'};
const observation={contentId,douyinId:'previous-a',likes:30,plays:300,observedAt:'2026-10-23T08:00:00.000Z',sourceRow:2,timeBasis:'metric-observation'};
const merge=(sourceObservations,platformWorks=[platform])=>mergeAuthorWorks({author,sourceWorks:[source],platformWorks,sourceObservations,asOf});

test('dated supplied observations supersede older platform values without another work or fabricated daily growth',()=>{
 const rows=merge([observation]);assert.equal(rows.length,1);
 assert.equal(rows[0].adoptedLikes,30);assert.equal(rows[0].adoptedPlays,300);
 assert.equal(rows[0].likesObservedAt,observation.observedAt);assert.equal(rows[0].publicationDay,'2026-09-12');
});
test('each metric adopts its own latest valid evidence, including decreases and true source zero',()=>{
 const row=merge([{...observation,likes:0,plays:null}])[0];
 assert.equal(row.adoptedLikes,0);assert.equal(row.adoptedPlays,50);
 assert.equal(row.playsObservedAt,platform.lastObservedAt);
 assert.equal(merge([observation],[{...platform,likes:2,lastObservedAt:'2026-10-25T08:00:00.000Z'}])[0].adoptedLikes,2);
});
test('source-only authors receive dated metrics and their source date remains a publication day',()=>{
 const row=merge([observation],[])[0];assert.equal(row.adoptedLikes,30);assert.equal(row.adoptedPlays,300);
 assert.equal(row.likesObservedAt,observation.observedAt);assert.equal(row.publicationDay,'2026-09-12');
});
test('future/undated/unrelated owners and unrelated content cannot replace known work values',()=>{
 for(const changed of [{observedAt:'2026-10-30T08:00:00.000Z'},{observedAt:null},{douyinId:'another-author'},{contentId:'7300000000000000002'}]){
  assert.equal(merge([{...observation,...changed}])[0].adoptedLikes,12);
 }
});
test('same-time conflicting evidence stays unavailable; equal repeated observations count once',()=>{
 const row=merge([observation,{...observation,likes:31}])[0];assert.equal(row.adoptedLikes,null);assert.equal(row.adoptedPlays,300);
 const duplicate=merge([observation,{...observation}]);assert.equal(duplicate.length,1);assert.equal(duplicate[0].adoptedLikes,30);
});
test('sorting follows the adopted value rather than either old cumulative source',()=>{
 const rows=mergeAuthorWorks({author,sourceWorks:[source,{...source,contentId:'7300000000000000002',likes:20}],platformWorks:[],sourceObservations:[observation],asOf});
 assert.equal(orderAuthorWorks(rows,'adoptedLikes','desc')[0].externalId,contentId);
});

test('submission and legacy record clocks never supersede a measured value or invent a measurement date',()=>{
 for(const row of [{...observation,timeBasis:'submission-time',recordedAt:observation.observedAt,observedAt:null},{...observation,timeBasis:undefined}]){
  const adopted=merge([row])[0];assert.equal(adopted.adoptedLikes,12);assert.equal(adopted.likesObservedAt,platform.lastObservedAt);
  assert.equal(merge([row],[])[0].adoptedLikes,10,'没有采样时间的不同累计值不能冒充更新');
 }
});
test('unique submitted cumulative records fill a genuinely missing metric without a fabricated measurement clock',()=>{
 const rows=mergeAuthorWorks({author,sourceWorks:[{...source,likes:null,plays:null}],platformWorks:[],
  sourceObservations:[{...observation,observedAt:null,timeBasis:'submission-time',recordedAt:observation.observedAt}],asOf});
 assert.equal(rows[0].adoptedLikes,30);assert.equal(rows[0].likesObservedAt,null);assert.equal(rows[0].likesOrigin,'source-record');
});
