import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeWorkSourceFacts } from '../lib/work-source-overlay.mjs';
const id='7300000000000000001',other='7300000000000000002';
const url='https://fixture.feishu.cn/sheets/FixtureWorkbook123456';
const base={key:id,contentId:id,sourceRow:2,authorKey:'a',authorName:'同名',accountId:'one',targetId:10,
  publishedOn:'2026-09-12',tracks:['切片激励'],classifications:['slice'],primaryTrack:'切片激励',cumulativePlays:100,cumulativeLikes:3,title:'旧作品'};
const author={key:'a',sourceRow:2,accountId:'one',name:'同名',targetId:10};
const fact=(changes={})=>({contentId:id,authorName:'同名',accountId:'one',plays:100,likes:3,publishedOn:null,metricDate:null,
  sourceVersionId:1,sourceUrl:url,sourceModifiedAt:'2026-10-20T00:00:00.000Z',sourceReadAt:'2026-10-29T02:00:00.000Z',
  representation:{plays:'integer',likes:'integer'},sheet:'作品',row:2,rowSha256:'a'.repeat(64),...changes});
const run=(facts,works=[base],authors=[author])=>mergeWorkSourceFacts(works,authors,
  {facts,versions:[{sourceUrl:url,report:{source:{title:'切片激励计划排名公示'}}}],fingerprint:'fp'},
  {baseModifiedAt:'2026-10-23T00:00:00.000Z'});

test('duplicate work facts corroborate one work rather than adding counters, and do not mutate the base',()=>{
  const before=JSON.stringify(base),result=run([fact(),fact({sheet:'另一页',row:4})]);
  assert.equal(result.works.length,1);assert.equal(result.works[0].cumulativePlays,100);
  assert.equal(result.works[0].sourceEditionEvidence.length,2);
  assert.equal(result.summary.updatedWorks,0);assert.equal(JSON.stringify(base),before);
});
test('read dates cannot make old metrics newer, but a newer source edition updates without claiming a sampling date',()=>{
  assert.equal(run([fact({plays:5})]).works[0].cumulativePlays,100);
  const result=run([fact({plays:8,sourceModifiedAt:'2026-10-28T00:00:00.000Z'})]);
  assert.equal(result.works[0].cumulativePlays,8,'decreases are retained, not maxed away');
  assert.equal(result.works[0].sourceEditionEvidence[0].measurementDate,null);
  assert.equal(result.works[0].publishedOn,'2026-09-12');
});
test('same-edition conflicting values do not win by row order, and missing remains distinct from zero',()=>{
  const recent={sourceModifiedAt:'2026-10-28T00:00:00.000Z'};
  for(const facts of [[fact({...recent,plays:6}),fact({...recent,plays:9})],[fact({...recent,plays:9}),fact({...recent,plays:6})]])
    assert.equal(run(facts).works[0].cumulativePlays,100);
  const result=run([fact({contentId:other,plays:null,likes:0})]);
  const added=result.works.find(w=>w.contentId===other);
  assert.equal(added.cumulativePlays,null);assert.equal(added.cumulativeLikes,0);
});
test('new works join by exact public account ID, never by nickname or uid; row keys remain stable',()=>{
  const facts=[fact({contentId:other,accountId:null,uid:'one',publishedOn:'2026-10-28'})];
  const first=run(facts).works.find(w=>w.contentId===other);
  assert.equal(first.targetId,null);assert.equal(first.authorKey,null);
  assert.equal(first.publishedOn,'2026-10-28');assert.ok(Number.isSafeInteger(first.sourceRow));
  assert.equal(run(facts).works.find(w=>w.contentId===other).sourceRow,first.sourceRow);
  assert.equal(run([fact({contentId:other})]).works.find(w=>w.contentId===other).targetId,10);
  assert.equal(run([fact({contentId:other})],[base],[author,{...author,key:'b'}]).works.find(w=>w.contentId===other).targetId,null);
});
test('unresolved and invalid work IDs are retained in the source review count, not given invented canonical IDs',()=>{
  const result=run([fact({contentId:null,url:'https://v.douyin.com/abc/'}),fact({contentId:'123'})]);
  assert.equal(result.works.length,1);assert.equal(result.summary.unresolvedFacts,2);
});
