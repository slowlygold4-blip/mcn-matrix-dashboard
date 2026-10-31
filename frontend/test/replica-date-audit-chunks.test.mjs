import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';import {build} from 'esbuild';
import {ingestFixture} from './helpers/replica-ingest-fixture.mjs';
import {dateAuditPlan,dateAuditReceipt,dateAuditReceiptKey,DATE_AUDIT_CONTRACT} from '../lib/replica-date-audit-plan.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex'),at='2026-10-30T00:00:00.000Z',common={version:1,asOf:at,timeZone:'Asia/Shanghai'};
const producer='synthetic-date-audit-producer-'.repeat(3),fixture=ingestFixture(producer),reads=new Map();globalThis.__dateChunkFixture=fixture.env;
fixture.env.BUCKET.get=async key=>{reads.set(key,(reads.get(key)||0)+1);const text=fixture.objects.get(key);return text===undefined?null:{size:Buffer.byteLength(text),text:async()=>text,body:new Response(text).body};};
const root=fileURLToPath(new URL('../',import.meta.url));
const bundle=await build({entryPoints:[root+'app/api/replica/route.ts'],bundle:true,write:false,format:'esm',platform:'node',alias:{'@':root},plugins:[{name:'chunk-cloud',setup(b){b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'cloud',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const env=globalThis.__dateChunkFixture;',loader:'js'}));}}]});
const {POST}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
test.beforeEach(()=>{fixture.reset();reads.clear();});test.after(()=>fixture.close());
function publication(size=513){
 const files=[],points=[];
 const add=(path,kind,count,payload,extra={})=>{const data=JSON.stringify({...common,...payload})+'\n',meta={path,kind,...extra,count,bytes:Buffer.byteLength(data),sha256:sha(data)};files.push({...meta,data});return meta;};
 add('catalog.json','catalog',0,{accounts:[],boards:[],classificationRuleVersion:'fixture'});add('topics.json','topics',0,{topics:[],items:[]});
 for(let id=1;id<=size;id++){
  const sampled='2026-10-29T20:00:00.000Z',point={targetId:id,date:'2026-10-30',capturedAt:sampled,followers:id,followersAt:sampled,likes:0,likesAt:sampled,posts:null,postsAt:null};points.push(point);
  add(`daily/${id}.json`,'daily',1,{items:[point]},{targetId:id});
 }
 add('summary.json','summary',points.length,{items:points});
 const base={...common,counts:{daily:size},files:files.map(({data,...meta})=>meta)},sourceDaily=base.files.filter(f=>f.kind==='daily').map(({kind,...meta})=>meta),shards=[];
 for(let i=0;i<points.length;i+=2000){const rows=points.slice(i,i+2000),meta=add(`date-summary/${String(shards.length+1).padStart(6,'0')}.json`,'summaryDateShard',rows.length,{items:rows});const {kind,...descriptor}=meta;shards.push({...descriptor,firstDate:'2026-10-30',lastDate:'2026-10-30'});}
 add('date-summary-index.json','summaryDateIndex',size,{format:'date-shards-v1',sourceManifestSha256:sha(JSON.stringify(base)),sourceDaily,count:size,firstDate:'2026-10-30',lastDate:'2026-10-30',shards});
 return {asOf:at,files,manifest:{...common,counts:{daily:size},files:files.map(({data,...meta})=>meta)}};
}
function stage(p){for(const file of p.files){fixture.sqlite.prepare('INSERT INTO replica_files VALUES(?,?,?,?)').run(at,file.path,file.sha256,file.bytes);fixture.objects.set(at+'/'+file.sha256,file.data);}}
const post=(body,auth=true)=>POST(new Request('https://fixture.test/api/replica',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+producer}:{})},body:JSON.stringify(body)}));
const audit=(p,index,auth=true)=>post({action:'audit-date',asOf:at,manifest:p.manifest,chunkIndex:index},auth);
const activate=(p,contract=DATE_AUDIT_CONTRACT)=>post({action:'activate',asOf:at,manifest:p.manifest,...(contract?{dateAudit:contract}:{})});

test('three source batches verify every one of 513 accounts exactly once; retry reuses only matching server proofs',async()=>{
 const p=publication();stage(p);const plan=dateAuditPlan(p.manifest);assert.equal(plan.chunkCount,3);
 for(let i=0;i<3;i++){const response=await audit(p,i);assert.equal(response.status,200);assert.deepEqual(await response.json(),{audited:true,asOf:at,chunkIndex:i,chunkCount:3,verifiedDaily:i===2?1:256});}
 for(const f of p.files.filter(f=>f.kind==='daily'))assert.equal(reads.get(at+'/'+f.sha256),1);
 reads.clear();for(let i=0;i<3;i++)assert.equal((await audit(p,i)).status,200);
 assert.equal(reads.size,3,'retry must read only its three private receipts');
 const response=await activate(p);assert.equal(response.status,200,await response.clone().text());assert.equal(fixture.sqlite.prepare('SELECT count(*) n FROM replica_generations').get().n,1);
 assert.equal([...reads.keys()].some(key=>p.files.some(f=>f.kind==='daily'&&key===at+'/'+f.sha256)),false,'activation uses proofs already issued by full source checks');
});

test('missing, forged and another-manifest receipts cannot activate or substitute for a source check',async()=>{
 const p=publication(257);stage(p);assert.equal((await audit(p,0)).status,200);assert.equal((await activate(p)).status,409);
 const plan=dateAuditPlan(p.manifest),key=dateAuditReceiptKey(dateAuditReceipt(plan,1));fixture.objects.set(key,JSON.stringify({...dateAuditReceipt(plan,1),manifestHash:'0'.repeat(64)})+'\n');
 assert.equal((await activate(p)).status,409);assert.equal(fixture.sqlite.prepare('SELECT count(*) n FROM replica_generations').get().n,0);
 assert.equal((await audit(p,1)).status,200);assert.equal((await activate(p)).status,200);
 const changed={...p,manifest:{...p.manifest,policyNote:'different immutable manifest'}};
 assert.equal((await activate(changed)).status,409,'proofs are bound to the whole manifest, not merely date or counts');
});

test('a corrupt daily source never produces a proof or publishes; retry repairs just the unfinished chunk',async()=>{
 const p=publication(257);stage(p);assert.equal((await audit(p,0)).status,200);
 const daily=p.files.find(f=>f.path==='daily/257.json'),key=at+'/'+daily.sha256;fixture.objects.set(key,daily.data.replace('"likes":0','"likes":8'));
 assert.notEqual((await audit(p,1)).status,200);assert.equal((await activate(p)).status,409);
 assert.equal(fixture.sqlite.prepare('SELECT count(*) n FROM replica_generations').get().n,0);
 fixture.objects.set(key,daily.data);assert.equal((await audit(p,1)).status,200);assert.equal((await activate(p)).status,200);
});

test('anonymous and invalid chunk requests cannot write private proofs; legacy full audits remain supported',async()=>{
 const p=publication(2);stage(p);assert.equal((await audit(p,0,false)).status,403);
 for(const index of [-1,1,0.1,'0',null])assert.equal((await audit(p,index)).status,400);
 assert.equal([...fixture.objects.keys()].some(k=>k.startsWith('__replica_date_audits/')),false);
 assert.equal((await activate(p,'unknown-contract')).status,400);
 assert.equal((await activate(p,null)).status,200);
});
