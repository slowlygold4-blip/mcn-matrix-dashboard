import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {belongsToSourceTrack,belongsToSourceLinkage,sameSourceDouyinId} from '../lib/source-ledger-track.mjs';

test('source-table overlapping work and author categories remain selectable in both tracks',async()=>{
  const index=JSON.parse(await readFile(new URL('../public/creator-source/index.json',import.meta.url)));
  let overlappingWork;
  for(const file of index.files.filter(item=>item.path.startsWith('works-'))){
    const part=JSON.parse(await readFile(new URL('../public/creator-source/'+file.path,import.meta.url)));
    overlappingWork=part.items.find(row=>row.tracks==='切片激励 / 创作激励');
    if(overlappingWork)break;
  }
  assert.ok(overlappingWork,'sealed source has a multi-track work');
  assert.equal(belongsToSourceTrack(overlappingWork,'切片激励','works'),true);
  assert.equal(belongsToSourceTrack(overlappingWork,'创作激励','works'),true);
  assert.equal(belongsToSourceTrack(overlappingWork,'即梦二创','works'),false);
  const authors=JSON.parse(await readFile(new URL('../public/creator-source/authors.json',import.meta.url))).items;
  const overlappingAuthor=authors.find(row=>row.slicePosts>0&&row.creationPosts>0);
  assert.ok(overlappingAuthor);
  assert.equal(belongsToSourceTrack(overlappingAuthor,'切片激励','authors'),true);
  assert.equal(belongsToSourceTrack(overlappingAuthor,'创作激励','authors'),true);
});

test('source identity filtering uses complete Douyin IDs; unknown metrics do not become zero',()=>{
  assert.equal(sameSourceDouyinId({douyinId:'16828182'},'16828182'),true);
  assert.equal(sameSourceDouyinId({douyinId:'116828182'},'16828182'),false);
  assert.equal(sameSourceDouyinId({douyinId:''},''),false);
  assert.equal(belongsToSourceTrack({sourceSupplement:true,slicePosts:null},'__unclassified__','authors'),true);
  assert.equal(belongsToSourceTrack({sourceSupplement:false,track:null},'__unclassified__','works'),true);
  assert.equal(belongsToSourceTrack({sourceSupplement:true,track:null},'切片激励','works'),false);
  assert.equal(belongsToSourceLinkage({targetIds:[285]},'linked'),true);
  assert.equal(belongsToSourceLinkage({targetIds:[]},'sourceOnly'),true);
  assert.equal(belongsToSourceLinkage({targetIds:[]},'linked'),false);
});

test('published source-only author filter separates identity evidence from target-ID links',async()=>{
  const base=JSON.parse(await readFile(new URL('../public/creator-source/authors.json',import.meta.url))).items;
  const supplement=JSON.parse(await readFile(new URL('../public/table-foundation/authors.json',import.meta.url))).items;
  const all=[...base,...supplement];
  assert.equal(all.length,4503);
  assert.equal(all.filter(row=>belongsToSourceLinkage(row,'linked')).length,595);
  assert.equal(all.filter(row=>belongsToSourceLinkage(row,'sourceOnly')).length,3908);
  assert.equal(all.filter(row=>belongsToSourceLinkage(row,'linked')).length+all.filter(row=>belongsToSourceLinkage(row,'sourceOnly')).length,all.length);
});
