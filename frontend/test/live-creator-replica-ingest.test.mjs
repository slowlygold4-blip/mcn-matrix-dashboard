import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';import {build} from 'esbuild';
import {ingestFixture} from './helpers/replica-ingest-fixture.mjs';
import {buildCreatorIntelligence} from '../lib/creator-intelligence.mjs';
import {creatorEditionIdentityPayload} from '../lib/replica-creator.mjs';
import {readSourceIndex,readSourcePart} from '../lib/source-part-reader.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),hash=s=>createHash('sha256').update(s).digest('hex');
const bundle=await build({entryPoints:[root+'app/api/replica/route.ts'],bundle:true,write:false,format:'esm',platform:'node',alias:{'@':root},plugins:[{name:'synthetic-cloud',setup(b){b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'cloud',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const env=globalThis.__creatorFixture;',loader:'js'}));}}]});
const producer='synthetic-creator-only-producer-'.repeat(3),fixture=ingestFixture(producer);globalThis.__creatorFixture=fixture.env;
fixture.env.BUCKET.get=async key=>fixture.objects.has(key)?{text:async()=>fixture.objects.get(key),body:new Response(fixture.objects.get(key)).body}:null;
const prepare=fixture.env.DB.prepare;fixture.env.DB.prepare=sql=>{const statement=prepare(sql);return {...statement,first:()=>statement.bind().first()};};
const {POST,GET}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
test.beforeEach(()=>fixture.reset());test.after(()=>fixture.close());
function publication(asOf,plays,{corrupt=false,classifications,dateBasis,inferredPublishDate}={}){
 const authors=[{row:2,name:'作者A',douyinId:'author_a',posts:1,slicePosts:1,creationPosts:0,aiPosts:0,cupPosts:0,plays,likes:0,followers:null,targetIds:[]}];
 const works=[{row:2,contentId:'7300000000000000001',author:'作者A',douyinId:'author_a',publishDate:'2026-09-12',type:'video',track:'切片激励',tracks:'切片激励',plays,likes:0,title:'作品',url:'https://www.douyin.com/video/7300000000000000001'}];
 if(classifications!==undefined)works[0].classifications=classifications;
 if(dateBasis!==undefined)works[0].dateBasis=dateBasis;if(inferredPublishDate!==undefined)works[0].inferredPublishDate=inferredPublishDate;
 const insight=buildCreatorIntelligence(authors,works);if(corrupt)insight.counts.cumulativePlays++;
 const base={version:1,asOf,timeZone:'Asia/Shanghai'},files=[];
 const add=(path,kind,count,payload)=>{const data=JSON.stringify({...base,...payload})+'\n';const file={path,kind,count,bytes:Buffer.byteLength(data),sha256:hash(data),data};files.push(file);return file;};
 add('catalog.json','catalog',0,{accounts:[],boards:[],classificationRuleVersion:'fixture'});add('topics.json','topics',0,{topics:[],items:[]});add('summary.json','summary',0,{items:[]});
 const descriptors=[];for(const [name,kind,items]of [['authors.json','creatorAuthors',authors],['works-001.json','creatorWorks',works],['insights.json','creatorInsights',[insight]]]){
  const f=add('creator/'+name,kind,items.length,{revision:'1',items});descriptors.push({path:name,count:f.count,bytes:f.bytes,sha256:f.sha256,generation:asOf});}
 const index={revision:'1',sourceModifiedAt:'2026-10-21T00:00:00.000Z',importedAt:'2026-10-22T00:00:00.000Z',sourceRows:2,linkMode:'current-strict',linkFingerprint:'a'.repeat(64),
  stats:{authors:1,rawAuthorRows:1,reciprocalDuplicates:0,works:1,datedWorks:1,undatedWorks:0,linkedAuthors:0,worksWithPlays:1,worksWithLikes:1,cumulativePlays:plays,cumulativeLikes:0},
  tracks:[{name:'切片激励',works:1,cumulativePlays:plays,cumulativeLikes:0,authors:1}],files:descriptors,semantics:{plays:'累计',likes:'累计',missing:'不补零',privacy:'仅公开字段'}};
 index.editionFingerprint=hash(creatorEditionIdentityPayload(index,authors,works));add('creator/index.json','creatorIndex',1,index);
 return {asOf,files,manifest:{...base,counts:{daily:0},files:files.map(({data,...f})=>f)}};
}
const post=body=>POST(new Request('https://fixture.test/api/replica',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+producer},body:JSON.stringify(body)}));
async function publish(p){assert.equal((await post({action:'upload',asOf:p.asOf,files:p.files.map(({path,sha256,data})=>({path,sha256,data}))})).status,200);return post({action:'activate',asOf:p.asOf,manifest:p.manifest});}
test('source updates publish without rebuilding the frontend; readers pin exact source generations',async()=>{
 const first=publication('2026-10-29T01:00:00.000Z',25);assert.equal((await publish(first)).status,200);
 const fetcher=url=>GET(new Request(new URL(url,'https://fixture.test')));
 const old=await readSourceIndex('/creator-source/index.json',{preferReplica:true,fetcher});
 const second=publication('2026-10-29T02:00:00.000Z',20);assert.equal((await publish(second)).status,200);
 const current=await readSourceIndex('/creator-source/index.json',{preferReplica:true,fetcher});assert.equal(current.stats.cumulativePlays,20);
 const read=index=>readSourcePart(index.files.find(f=>f.path==='works-001.json'),'1',null,'/creator-source/',{fetcher});
 assert.equal((await read(old))[0].plays,25);assert.equal((await read(current))[0].plays,20);
 assert.equal((await read(current))[0].likes,0);assert.notEqual(old.editionFingerprint,current.editionFingerprint);
});
test('incorrect source aggregation cannot activate or displace the previous published generation',async()=>{
 const first=publication('2026-10-29T01:00:00.000Z',25);assert.equal((await publish(first)).status,200);
 const bad=publication('2026-10-29T02:00:00.000Z',30,{corrupt:true});const rejected=await publish(bad);assert.equal(rejected.status,409);
 assert.match(await rejected.text(),/经营统计核验失败/);
 const current=await GET(new Request('https://fixture.test/api/replica'));assert.equal((await current.json()).manifest.asOf,first.asOf);
});
test('optional content categories activate without dropping the legacy generation or exposing unknown fields',async()=>{
 const old=publication('2026-10-29T01:00:00.000Z',25);assert.equal((await publish(old)).status,200);
 const current=publication('2026-10-29T02:00:00.000Z',25,{classifications:['slice']});assert.equal((await publish(current)).status,200);
 const fetcher=url=>GET(new Request(new URL(url,'https://fixture.test')));
 const index=await readSourceIndex('/creator-source/index.json',{preferReplica:true,fetcher});
 const rows=await readSourcePart(index.files.find(f=>f.path==='works-001.json'),'1',null,'/creator-source/',{fetcher});
 assert.deepEqual(rows[0].classifications,['slice']);assert.equal(rows[0].likes,0);
 const legacy=await GET(new Request('https://fixture.test/api/replica?generation='+encodeURIComponent(old.asOf)+'&part=creator/works-001.json'));
 assert.equal(legacy.status,200);assert.equal((await legacy.json()).items[0].classifications,undefined);
});


test('new source date authority and retained reference date survive actual ingest; old sealed generations stay readable',async()=>{
 const old=publication('2026-10-29T01:00:00.000Z',0),next=publication('2026-10-29T02:00:00.000Z',0,{dateBasis:'source-explicit-date',inferredPublishDate:'2026-09-13'});
 assert.equal((await publish(old)).status,200);assert.equal((await publish(next)).status,200);
 for(const p of [old,next]){
  const response=await GET(new Request('https://fixture.test/api/replica?'+new URLSearchParams({generation:p.asOf,part:'creator/works-001.json'})));assert.equal(response.status,200);
  const body=await response.json();assert.equal(body.items[0].likes,0);assert.equal(body.items[0].dateBasis,p===old?undefined:'source-explicit-date');
  if(p===next)assert.equal(body.items[0].inferredPublishDate,'2026-09-13');
 }
 const bad=publication('2026-10-29T03:00:00.000Z',0,{dateBasis:'platform-timestamp'});assert.equal((await post({action:'upload',asOf:bad.asOf,files:bad.files.map(({path,sha256,data})=>({path,sha256,data}))})).status,400);
});
