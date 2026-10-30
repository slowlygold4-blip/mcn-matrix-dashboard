import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateSourceWorkOwners,validateFoundationWorkOwners,readLiveSourceWorkOwners} from '../lib/source-work-owner-contract.mjs';
import {mergeAuthorWorks} from '../lib/author-unified-works.mjs';
import {authorDailyPublication} from '../lib/author-daily-publication.mjs';
import {presentUnifiedWorkMetric} from '../lib/unified-work-presentation.mjs';
import {auditCreatorPublication,creatorEditionIdentityPayload} from '../lib/replica-creator.mjs';
import {buildCreatorIntelligence} from '../lib/creator-intelligence.mjs';
const asOf='2026-10-30T04:00:00.000Z',id='7500000000000000001';
const source={row:7,contentId:id,douyinId:'claimed_a',author:'原声明',publishDate:'2026-10-30',title:'原作品',likes:50,plays:500};
const owner={workRow:7,contentId:id,targetId:10},a={douyinId:'claimed_a',targetIds:[9]},b={douyinId:'publisher_b',targetIds:[10]};
const native={id:77,targetId:10,externalId:id,caption:'已核验作品',publishedAt:'2026-10-29T20:00:00.000Z',lastObservedAt:asOf,likes:7,plays:0,playsEvidence:{mayBePlaceholder:true}};
const index={revision:'fixture',sourceModifiedAt:'2026-10-20T00:00:00.000Z',sourceRows:50};
const projection={revision:'fixture',modifiedAt:index.sourceModifiedAt,rowCount:50,links:[],workOwners:[owner]};

test('owner maps are optional, precisely edition-bound, row-bound and have no author-binding authority',()=>{
 assert.deepEqual(readLiveSourceWorkOwners(undefined,index,[source]),[]);
 assert.deepEqual(readLiveSourceWorkOwners(projection,index,[source]),[owner]);
 for(const value of [{...projection,revision:'other'},{...projection,modifiedAt:asOf},{...projection,rowCount:49}])assert.throws(()=>readLiveSourceWorkOwners(value,index,[source]),/版本/);
 for(const value of [[owner,owner],[{...owner,workRow:8}],[{...owner,contentId:1}],[{...owner,cookie:'forbidden'}],[{...owner,targetId:99}]]){
  assert.throws(()=>validateSourceWorkOwners(value,{sourceRows:new Map([[7,source]]),accountIds:new Set([9,10])}));
 }
 assert.deepEqual(a.targetIds,[9]);
});
test('old author retains the claim and its original numbers but contributes neither likes nor a false publishing day',()=>{
 const originals=structuredClone([source,a]),rows=mergeAuthorWorks({author:a,sourceWorks:[source],platformWorks:[],workOwners:[owner],asOf});
 assert.equal(rows.length,1);assert.equal(rows[0].ownershipClaimOnly,true);assert.equal(rows[0].canonicalOwnerTargetId,10);
 assert.equal(rows[0].adoptedLikes,null);assert.equal(rows[0].likesOrigin,'conflict');assert.equal(rows[0].sourceClaimedCumulativeLikes,50);
 const metric=presentUnifiedWorkMetric(rows[0],'plays');assert.equal(metric.value,null);assert.equal(metric.sourceClaimValue,500);assert.match(metric.note,/另一账号/);
 const daily=authorDailyPublication(rows,{asOf});assert.equal(daily.knownWorks,0);assert.equal(daily.status,'unknown');assert.equal(daily.ownershipClaimWorks,1);
 assert.deepEqual([source,a],originals);
});
test('independent publisher maps retain matching source counters without binding or double-counting the source author',()=>{
 for(const supplemental of [false,true]){
  const row={...source,douyinId:'same_public_handle',...(supplemental?{row:undefined}:{})};
  const map={...owner,sourceClaimMatches:true};if(supplemental)delete map.workRow;
  const mappings=supplemental?{foundationWorkOwners:[map]}:{workOwners:[map]};
  const publisher={douyinId:'',targetIds:[10]},declared={douyinId:'same_public_handle',targetIds:[]};
  const actual=mergeAuthorWorks({author:publisher,sourceWorks:[row],platformWorks:[{...native,likes:null}],...mappings,asOf});
  assert.equal(actual.length,1);assert.equal(actual[0].sourceOwnershipConflict,false);
  assert.equal(actual[0].canonicalOwnerTargetId,10);assert.equal(actual[0].ownershipClaimOnly,false);
  assert.equal(actual[0].adoptedLikes,50,'matching source record survives a missing platform field');
  assert.equal(actual[0].adoptedPlays,500,'placeholder platform play count does not erase the source');
  const claim=mergeAuthorWorks({author:declared,sourceWorks:[row],platformWorks:[],...mappings,asOf});
  assert.equal(claim[0].ownershipClaimOnly,true);assert.equal(claim[0].adoptedLikes,null);
  assert.equal(authorDailyPublication(claim,{asOf}).knownWorks,0);assert.equal(authorDailyPublication(actual,{asOf}).knownWorks,1);
  assert.deepEqual(declared.targetIds,[]);
 }
});
test('source-claim match evidence accepts only explicit true in either source namespace',()=>{
 assert.deepEqual(validateSourceWorkOwners([{...owner,sourceClaimMatches:true}]),[{...owner,sourceClaimMatches:true}]);
 assert.deepEqual(validateFoundationWorkOwners([{contentId:id,targetId:10,sourceClaimMatches:true}]),[{contentId:id,targetId:10,sourceClaimMatches:true}]);
 for(const value of [false,1,'true',null,undefined]){
  assert.throws(()=>validateSourceWorkOwners([{...owner,sourceClaimMatches:value}]));
  assert.throws(()=>validateFoundationWorkOwners([{contentId:id,targetId:10,sourceClaimMatches:value}]));
 }
 assert.throws(()=>validateSourceWorkOwners([{...owner,sourceClaimMatches:true,extra:1}]));
});
test('verified publisher gets one work with actual observations and original unadopted claim evidence',()=>{
 const rows=mergeAuthorWorks({author:b,sourceWorks:[source],platformWorks:[native],workOwners:[owner],asOf});
 assert.equal(rows.length,1);assert.equal(rows[0].ownershipClaimOnly,false);assert.equal(rows[0].adoptedLikes,7);assert.equal(rows[0].likesOrigin,'platform');
 assert.equal(rows[0].adoptedPlays,null);assert.equal(rows[0].playsOrigin,'conflict');assert.equal(rows[0].sourceClaimedCumulativePlays,500);
 const daily=authorDailyPublication(rows,{asOf});assert.equal(daily.knownWorks,1);assert.equal(daily.status,'published');
});
test('a synthetic old account history cannot re-admit the original claim or use a newer same-author claimed observation',()=>{
 const old={...native,id:'creator-source:1:7',source:'creator-source',targetId:9,likes:999};
 const rows=mergeAuthorWorks({author:a,sourceWorks:[source],platformWorks:[old],workOwners:[owner],asOf});
 assert.equal(rows[0].ownershipClaimOnly,true);assert.equal(rows[0].adoptedLikes,null);assert.equal(authorDailyPublication(rows,{asOf}).knownWorks,0);
});

function edition(){
 const hash=s=>createHash('sha256').update(s).digest('hex'),bodies=new Map(),metas=[];
 const authors=[{row:2,name:'原声明',douyinId:'claimed_a',posts:1,slicePosts:1,creationPosts:0,aiPosts:0,cupPosts:0,plays:500,likes:50,followers:null,targetIds:[9]}];
 const works=[{...source,type:'video',track:'切片激励',tracks:'切片激励',url:'https://www.douyin.com/video/'+id}];
 const insight=buildCreatorIntelligence(authors,works),common={version:1,asOf,timeZone:'Asia/Shanghai',revision:'fixture'};
 function add(path,kind,items){const body={...common,items},text=JSON.stringify(body)+'\n',meta={path,kind,count:items.length,bytes:Buffer.byteLength(text),sha256:hash(text)};bodies.set(path,body);metas.push(meta);return {path:path.replace(/^creator\//,''),count:meta.count,bytes:meta.bytes,sha256:meta.sha256,generation:asOf};}
 const files=[add('creator/authors.json','creatorAuthors',authors),add('creator/works-001.json','creatorWorks',works),add('creator/insights.json','creatorInsights',[insight])];
 const root={...common,sourceModifiedAt:index.sourceModifiedAt,importedAt:'2026-10-20T01:00:00.000Z',sourceRows:50,linkMode:'current-strict',linkFingerprint:'a'.repeat(64),stats:{authors:1,rawAuthorRows:1,reciprocalDuplicates:0,works:1,datedWorks:1,undatedWorks:0,linkedAuthors:1,worksWithPlays:1,worksWithLikes:1,cumulativePlays:500,cumulativeLikes:50},tracks:insight.tracks.map(t=>({name:t.track,works:t.works,cumulativePlays:t.cumulativePlays,cumulativeLikes:t.cumulativeLikes,authors:t.authors})),files,semantics:{plays:'累计',likes:'累计',missing:'缺测',privacy:'公开字段'}};
 root.editionFingerprint=hash(creatorEditionIdentityPayload(root,authors,works));bodies.set('creator/index.json',root);metas.push({path:'creator/index.json',kind:'creatorIndex',count:1});
 bodies.set('catalog.json',{accounts:[{id:9},{id:10}],creatorSourceLinks:{...projection,links:[{authorRow:2,targetId:9}]}});metas.push({path:'catalog.json',kind:'catalog',count:2});
 bodies.set('works/10.json',{...common,items:[native]});metas.push({path:'works/10.json',kind:'works',targetId:10,count:1});
 const calls=[];return {bodies,manifest:{asOf,files:metas},readPart:async path=>{calls.push(path);return bodies.get(path);},calls};
}
test('actual source audit checks canonical claims against sealed source rows, catalog accounts and native works',async()=>{
 const f=edition();await auditCreatorPublication(f);assert.ok(f.calls.includes('works/10.json'));
 for(const fault of ['row','account','synthetic','missing','time']){
  const x=edition();const link=x.bodies.get('catalog.json').creatorSourceLinks;
  if(fault==='row')link.workOwners=[{...owner,workRow:8}];if(fault==='account')link.workOwners=[{...owner,targetId:11}];
  if(fault==='synthetic')x.bodies.get('works/10.json').items=[{...native,id:'creator-source:1:7',source:'creator-source'}];
  if(fault==='missing')x.bodies.get('works/10.json').items=[];
  if(fault==='time')x.bodies.get('works/10.json').asOf='2026-10-29T04:00:00.000Z';
  await assert.rejects(auditCreatorPublication(x));
 }
});
test('older publications require no owner mapping or extra work partition reads',async()=>{
 const f=edition();delete f.bodies.get('catalog.json').creatorSourceLinks.workOwners;await auditCreatorPublication(f);assert.equal(f.calls.includes('works/10.json'),false);
});
test('a catalog cannot assert a base-sheet publisher without the sealed source family',async()=>{
 const x=edition();x.manifest.files=x.manifest.files.filter(f=>!f.path.startsWith('creator/'));await assert.rejects(auditCreatorPublication(x),/source-missing/);
});
