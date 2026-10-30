import test from 'node:test';import assert from 'node:assert/strict';
import {validateFoundationWorkOwners,readLiveFoundationWorkOwners} from '../lib/source-work-owner-contract.mjs';
import {mergeAuthorWorks,authorWorkExportRows} from '../lib/author-unified-works.mjs';
import {authorDailyPublication} from '../lib/author-daily-publication.mjs';
import {auditFoundationPublication} from '../lib/replica-foundation.mjs';
import {foundationPublication} from './helpers/foundation-publication.mjs';
const asOf='2026-10-30T04:00:00.000Z',id='7500000000000000001',owner={contentId:id,targetId:10};
const source={contentId:id,douyinId:'claim_a',author:'原声明',publishDate:'2026-10-30',type:'video',track:'切片激励',tracks:'切片激励',title:'原作品',likes:50,plays:500,url:'https://www.douyin.com/video/'+id,evidenceRows:1,sourceTitles:['合成资料']};
const native={id:77,targetId:10,externalId:id,caption:'已核验作品',publishedAt:'2026-10-29T20:00:00.000Z',lastObservedAt:asOf,likes:7,plays:null};
const a={douyinId:'claim_a',targetIds:[9]},b={douyinId:'publisher_b',targetIds:[10]};
test('supplementary mappings use exact work IDs and their own sealed edition, never made-up row keys',()=>{
 const revision='a'.repeat(64),foundation={index:{asOf,revision},works:[source]},projection={foundationWorkOwners:[owner],foundationWorkOwnerRevision:revision};
 assert.deepEqual(readLiveFoundationWorkOwners({},foundation,asOf),[]);assert.deepEqual(readLiveFoundationWorkOwners(projection,foundation,asOf),[owner]);
 assert.deepEqual(readLiveFoundationWorkOwners(projection,{...foundation,index:{asOf:'2026-10-29T04:00:00.000Z',revision}},asOf),[owner],'unchanged cached source edition remains usable after a new manifest clock');
 assert.throws(()=>readLiveFoundationWorkOwners(projection,{...foundation,index:{asOf,revision:'b'.repeat(64)}},asOf),/版本/);
 assert.throws(()=>readLiveFoundationWorkOwners(projection,{...foundation,index:{asOf:'2026-10-31T04:00:00.000Z',revision}},asOf),/版本/);
 assert.throws(()=>readLiveFoundationWorkOwners({foundationWorkOwners:[owner]},foundation,asOf),/版本/);
 for(const value of [[owner,owner],[{...owner,workRow:1}],[{...owner,cookie:'forbidden'}],[{...owner,contentId:'7500000000000000002'}],[{...owner,targetId:11}]])assert.throws(()=>validateFoundationWorkOwners(value,{sourceWorks:new Map([[id,source]]),accountIds:new Set([9,10])}));
});
test('original supplementary declaration remains visible while only the verified publisher contributes',()=>{
 const input={sourceWorks:[source],platformWorks:[],foundationWorkOwners:[owner],asOf};
 const claim=mergeAuthorWorks({...input,author:a});assert.equal(claim.length,1);assert.equal(claim[0].ownershipClaimOnly,true);assert.equal(claim[0].sourceClaimedCumulativeLikes,50);assert.equal(claim[0].adoptedLikes,null);assert.equal(authorDailyPublication(claim,{asOf}).knownWorks,0);
 const actual=mergeAuthorWorks({...input,author:b,platformWorks:[native]});assert.equal(actual.length,1);assert.equal(actual[0].adoptedLikes,7);assert.equal(actual[0].ownershipClaimOnly,false);assert.equal(authorDailyPublication(actual,{asOf}).knownWorks,1);
 assert.equal(source.douyinId,'claim_a');assert.deepEqual(a.targetIds,[9]);
});
test('synthetic history cannot re-admit a refused supplementary claim, and source namespaces cannot collide',()=>{
 const rows=mergeAuthorWorks({author:a,sourceWorks:[source],platformWorks:[{...native,id:'creator-source:1:1',source:'creator-source',targetId:9,likes:999}],foundationWorkOwners:[owner],asOf});assert.equal(rows[0].adoptedLikes,null);assert.equal(rows[0].ownershipClaimOnly,true);
 assert.throws(()=>mergeAuthorWorks({author:a,sourceWorks:[{...source,row:7}],platformWorks:[],foundationWorkOwners:[owner],asOf}),/来源/);
});
test('author CSV retains undated submitted counters while adopted metrics and publication stay withheld',()=>{
 const sourceObservations=[{contentId:id,douyinId:'claim_a',likes:50,plays:500,observedAt:asOf,recordedAt:asOf,timeBasis:'submission-time',sourceRow:2}];
 const rows=mergeAuthorWorks({author:a,sourceWorks:[{...source,likes:null,plays:null}],platformWorks:[],foundationWorkOwners:[owner],sourceObservations,asOf});
 const table=authorWorkExportRows(rows),values=Object.fromEntries(table[0].map((name,i)=>[name,table[1][i]]));
 assert.equal(values['点赞'],null);assert.equal(values['播放字段'],null);assert.equal(values['来源记录点赞'],50);assert.equal(values['来源记录播放字段'],500);assert.equal(values['来源记录时间依据'],'submission-time');assert.equal(values['点赞观察时间'],'');assert.match(values['归属状态'],/未计入/);assert.equal(authorDailyPublication(rows,{asOf}).knownWorks,0);
});
function edition(){
 const base=foundationPublication(asOf,{works:[source]}),bodies=new Map(base.files.map(f=>[f.path,JSON.parse(f.data)])),calls=[];
 Object.assign(bodies.get('catalog.json'),{accounts:[{id:9},{id:10}],creatorSourceLinks:{foundationWorkOwners:[owner],foundationWorkOwnerRevision:base.index.revision}});
 bodies.set('works/10.json',{version:1,asOf,items:[native]});base.manifest.files.push({path:'works/10.json',kind:'works',targetId:10,count:1});
 return {manifest:base.manifest,bodies,calls,readPart:async path=>{calls.push(path);return bodies.get(path);}};
}
test('actual foundation activation audits source namespace, exact account and genuine native works',async()=>{
 const f=edition();await auditFoundationPublication(f);assert.equal(f.calls.filter(p=>p==='works/10.json').length,1);
 for(const fault of ['source','account','duplicate','synthetic','missing','version','time','descriptor','namespace','edition']){
  const x=edition(),link=x.bodies.get('catalog.json').creatorSourceLinks;
  if(fault==='source')link.foundationWorkOwners=[{...owner,contentId:'7500000000000000002'}];
  if(fault==='account')link.foundationWorkOwners=[{...owner,targetId:11}];
  if(fault==='duplicate')link.foundationWorkOwners=[owner,owner];
  if(fault==='synthetic')x.bodies.get('works/10.json').items=[{...native,id:'creator-source:1:1',source:'creator-source'}];
  if(fault==='missing')x.bodies.get('works/10.json').items=[];
  if(fault==='version')x.bodies.get('works/10.json').version=2;
  if(fault==='time')x.bodies.get('works/10.json').asOf='2026-10-29T04:00:00.000Z';
  if(fault==='descriptor')x.manifest.files.find(p=>p.path==='works/10.json').targetId=9;
  if(fault==='namespace')link.workOwners=[{workRow:7,...owner}];
  if(fault==='edition')link.foundationWorkOwnerRevision='b'.repeat(64);
  await assert.rejects(auditFoundationPublication(x),undefined,fault);
 }
});
test('old foundation editions require no extra native work reads or invented overrides',async()=>{
 const x=edition();delete x.bodies.get('catalog.json').creatorSourceLinks.foundationWorkOwners;delete x.bodies.get('catalog.json').creatorSourceLinks.foundationWorkOwnerRevision;await auditFoundationPublication(x);assert.equal(x.calls.includes('works/10.json'),false);
 const rows=mergeAuthorWorks({author:a,sourceWorks:[source],platformWorks:[],asOf});assert.equal(rows[0].adoptedLikes,50);assert.equal(rows[0].sourceOwnershipConflict,undefined);
});
test('a catalog cannot assert a supplementary publisher without its source family',async()=>{
 const x=edition();x.manifest.files=x.manifest.files.filter(f=>!f.path.startsWith('foundation/'));await assert.rejects(auditFoundationPublication(x),/source-missing/);
});
