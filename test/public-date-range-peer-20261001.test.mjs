// Independent range/UI mathematics. Synthetic sealed sources only; no DB, platform or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {rendererJsx,synchronousGrowthDynamic} from './helpers/growth-renderer-transport.mjs';
import { derivePublicHistoryDateIndex, iteratePublicHistoryDateRange,
  iterateLegacyPublicHistoryRange, verifyPublicHistoryDateIndex } from '../lib/public-history-range.mjs';

const SITE = new URL('../../mcn-public-site/',import.meta.url);
const { rowsFor,aggregate,csv } = await import(new URL('lib/replica-model.mjs',SITE));
const { growthSeries } = await import(new URL('lib/replica-trends.mjs',SITE));
const AS_OF='2028-01-01T03:00:00.000Z',BASE='2026-09-12';
const hash=x=>createHash('sha256').update(x).digest('hex');
const day=n=>new Date(Date.parse(BASE+'T02:00:00Z')+n*86400000).toISOString().slice(0,10);
const metaOf=({content,...meta})=>meta;
const triple=p=>`${p.targetId}/${p.date}`;
const normalized=rows=>[...rows].sort((a,b)=>triple(a).localeCompare(triple(b)));

async function fixture(accountCount=3,days=475) {
 const accounts=Array.from({length:accountCount},(_,i)=>({id:i+1,label:`Synthetic ${i+1}`,enabled:true}));
 const sources=new Map(),files=[];
 for(const account of accounts) {
  const items=[];
  for(let n=0;n<days;n++) {
   if(account.id===3&&n===12)continue; // Real absence, not a zero point.
   const capturedAt=new Date(Date.parse(BASE+'T02:00:00Z')+n*86400000).toISOString();
   const followers=account.id===3&&n===20?null:1000+account.id+n*n;
   items.push({id:n+1,targetId:account.id,date:day(n),capturedAt,followers,
    followersAt:followers===null?null:capturedAt,likes:500+account.id+n*7-(n>=30?50:0),
    likesAt:capturedAt,posts:Math.floor(n/3),postsAt:capturedAt});
  }
  const path=`daily/${account.id}.json`,content=JSON.stringify({version:1,asOf:AS_OF,timeZone:'Asia/Shanghai',items})+'\n';
  sources.set(path,content);files.push({path,kind:'daily',targetId:account.id,count:items.length,
   bytes:Buffer.byteLength(content),sha256:hash(content)});
 }
 const manifest={version:1,asOf:AS_OF,timeZone:'Asia/Shanghai',counts:{daily:files.reduce((n,f)=>n+f.count,0)},files};
 const publication=await derivePublicHistoryDateIndex({sourceManifest:manifest,readPart:async path=>sources.get(path)});
 const parts=new Map(publication.files.map(f=>[f.path,f.content]));
 return {accounts,manifest,sources,publication,parts,
  options(reads=[],readOverride){return {sourceManifest:manifest,indexContent:publication.indexFile.content,
   indexMeta:metaOf(publication.indexFile),readPart:async path=>{reads.push(path);return readOverride?readOverride(path):parts.get(path);}};}};
}
const small=fixture(),large=fixture(71);
async function collect(iterator){const points=[],receipts=[];for await(const batch of iterator){points.push(...batch.items);receipts.push(batch);}return {points,receipts};}
const range=(start,end)=>({start:day(start),end:day(end)});

test('date peer: exact inclusive dates support headline, ranking and export from the same saved endpoints',async()=>{
 const f=await small,reads=[];
 const {points}=await collect(iteratePublicHistoryDateRange({...f.options(reads),ranges:[range(24,30)]}));
 assert.equal(points.length,21);assert.ok(points.every(p=>p.date>=day(24)&&p.date<=day(30)));
 const rows=rowsFor(f.accounts,points,day(24),day(30)),total=aggregate(rows);
 assert.equal(total.followers.delta,972);assert.equal(total.likes.delta,-24);assert.equal(total.posts.delta,6);
 assert.equal(total.followers.comparableCount,3);assert.ok(rows.every(r=>r.metrics.likes.delta===-8));
 assert.equal(total.likes.delta*100,-2400); // Estimated net plays, never cumulative or actual plays.
 const text=csv([['start','end','followersChange','likesChange','estimatedPlaysChange'],
  [day(24),day(30),total.followers.delta,total.likes.delta,total.likes.delta*100]]);
 assert.ok(text.includes('"972","-24","-2400"'));assert.ok(text.includes(day(24))&&text.includes(day(30)));
 assert.equal(new Set(reads).size,reads.length);
});
test('date peer: A+B union preserves the same four-endpoint cohort; metric missingness is independent',async()=>{
 const f=await small;
 const {points}=await collect(iteratePublicHistoryDateRange({...f.options(),ranges:[range(0,6),range(20,27)],dates:[day(0),day(6),day(20),day(27)]}));
 const followers=growthSeries(f.accounts,points,{...range(0,6),otherStart:day(20),otherEnd:day(27),metric:'followers'});
 assert.equal(followers.cohortCount,2);assert.equal(followers.totalCount,3);
 assert.equal(followers.points[6].current,72);assert.equal(followers.points[7].comparison,658);
 assert.equal(followers.points[7].currentDate,null);assert.equal(followers.points[7].current,null);
 const estimated=growthSeries(f.accounts,points,{...range(0,6),otherStart:day(20),otherEnd:day(27),metric:'estimated'});
 assert.equal(estimated.cohortCount,3);assert.equal(estimated.points[6].current,12600);
 assert.equal(aggregate(rowsFor(f.accounts,points,day(0),day(6))).followers.delta,108);
});
test('date peer: an interior absent observation breaks the fixed-cohort comparison line without dropping the account',async()=>{
 const f=await small;
 const {points}=await collect(iteratePublicHistoryDateRange({...f.options(),ranges:[range(0,6),range(10,16)]}));
 assert.equal(points.some(p=>p.targetId===3&&p.date===day(12)),false);
 const result=growthSeries(f.accounts,points,{...range(0,6),otherStart:day(10),otherEnd:day(16)});
 assert.equal(result.cohortCount,3);assert.equal(result.points[2].comparison,null);
 assert.equal(result.points[2].comparisonKnown,2);assert.equal(result.points[2].current,12);
 assert.equal(result.points[6].comparison,468);
});
test('date peer: multi-year since headline endpoints are separate from a bounded recent curve window',async()=>{
 const f=await large,reads=[];
 const result=await collect(iteratePublicHistoryDateRange({...f.options(reads),ranges:[range(468,474)],dates:[day(0),day(474)]}));
 assert.equal(result.points.length,71*8);assert.equal(result.receipts[0].totalSavedCount,71*475-1);
 assert.ok(reads.length<=3&&reads.length<f.publication.files.length);
 const total=aggregate(rowsFor(f.accounts,result.points,day(0),day(474)));
 assert.equal(total.followers.delta,71*474*474);assert.equal(total.followers.comparableCount,71);
 assert.equal(result.points.some(p=>p.date===day(467)),false);
 assert.equal(result.points.filter(p=>p.date===day(0)).length,71);
 assert.ok(result.receipts.every(r=>r.asOf===AS_OF&&r.sourceManifestSha256===hash(JSON.stringify(f.manifest))));
});
test('date peer: missing endpoints remain null while explicit zero and negative interval values survive',async()=>{
 const f=await small;
 const result=await collect(iteratePublicHistoryDateRange({...f.options(),dates:[day(0),day(20),day(30),day(29)]}));
 const missing=rowsFor(f.accounts,result.points,day(0),day(20));
 assert.equal(missing[2].metrics.followers.delta,null);assert.equal(missing[2].metrics.followers.value,null);
 assert.equal(missing[0].metrics.posts.baseline,0);assert.equal(missing[2].metrics.likes.delta,140);
 assert.equal(aggregate(rowsFor(f.accounts,result.points,day(29),day(30))).likes.delta,-129);
 const out=csv([['missing','zero','negative'],[null,0,-129]]);assert.ok(out.includes('"","0","-129"'));
});
test('date peer: out-of-history exact dates are an empty observation set, not fabricated zero growth',async()=>{
 const f=await small;
 const result=await collect(iteratePublicHistoryDateRange({...f.options(),dates:['2026-09-01']}));
 assert.equal(result.points.length,0);assert.equal(aggregate(rowsFor(f.accounts,result.points,'2026-09-01',day(6))).followers.delta,null);
});
test('date peer: legacy immutable daily sources produce exactly the same union without rewriting source bytes',async()=>{
 const f=await small,saved=JSON.stringify(f.manifest),bytes=[...f.sources],request={ranges:[range(0,6),range(20,27)],dates:[day(0),day(474)]};
 const indexed=await collect(iteratePublicHistoryDateRange({...f.options(),...request}));
 const legacy=await collect(iterateLegacyPublicHistoryRange({sourceManifest:f.manifest,readPart:async path=>f.sources.get(path),...request}));
 assert.deepEqual(normalized(legacy.points),normalized(indexed.points));assert.equal(JSON.stringify(f.manifest),saved);assert.deepEqual([...f.sources],bytes);
});
test('date peer: malformed/custom/incomplete/reversed dates fail closed before any selected part read',async()=>{
 const f=await small;
 for(const request of [{ranges:[{start:'2026-02-30',end:day(6)}]},
  {ranges:[{start:day(6),end:day(0)}]},{ranges:[{start:day(0)}]},
  {ranges:[{...range(0,6),secret:'synthetic-only'}]},{dates:[day(0),'2026-02-30']}]) {
  const reads=[];await assert.rejects(collect(iteratePublicHistoryDateRange({...f.options(reads),...request})),/invalid-history-range-contract/);
  assert.equal(reads.length,0);
 }
});
test('date peer: stale generation/source identity rejects before reading any date shard',async()=>{
 const f=await small;
 for(const edit of [m=>m.asOf='2028-01-01T04:00:00.000Z',m=>m.files[0].targetId=99,m=>m.files[0].sha256='f'.repeat(64)]) {
  const manifest=structuredClone(f.manifest);edit(manifest);const reads=[];
  await assert.rejects(collect(iteratePublicHistoryDateRange({...f.options(reads),sourceManifest:manifest,dates:[day(0)]})),/invalid-history-range-contract/);
  assert.equal(reads.length,0);
 }
 assert.equal(verifyPublicHistoryDateIndex(f.options()).asOf,AS_OF);
});
test('date peer: abort after successful part transport yields no cancelled points or success receipt',async()=>{
 const f=await small,controller=new AbortController();let yielded=0;
 const options=f.options([],async path=>{const content=f.parts.get(path);controller.abort();return content;});
 await assert.rejects(async()=>{for await(const batch of iteratePublicHistoryDateRange({...options,signal:controller.signal,dates:[day(0)]}))yielded+=batch.items.length;},e=>e.name==='AbortError');
 assert.equal(yielded,0);
});

// Root owns this browser module. Import its real implementation, never a local substitute.
let browserModule;
async function browserRange(options){browserModule??=await import(new URL('lib/replica-date-range.mjs',SITE));return browserModule.loadSummaryRange(options);}
function browserOptions(f,{indexed=true,mutate,reads=[],signal}={}) {
 const dateFiles=[metaOf(f.publication.indexFile),...f.publication.files.map(metaOf)];
 const manifest={...structuredClone(f.manifest),files:[...structuredClone(f.manifest.files),...(indexed?structuredClone(dateFiles):[])]};
 const json=new Map([...f.sources,...(indexed?[['date-summary-index.json',f.publication.indexFile.content],...f.parts]:[])].map(([path,content])=>[path,JSON.parse(content)]));
 mutate?.({manifest,json});
 return {manifest,signal,readPart:async path=>{reads.push(path);assert.ok(json.has(path),`part not present: ${path}`);return structuredClone(json.get(path));}};
}
test('date browser peer: real indexed loader reads exact A+B union, deduplicates parts and returns fixed generation receipt',async()=>{
 const f=await small,reads=[],request={ranges:[range(0,6),range(20,27),range(0,6)],dates:[day(0),day(27),day(0)]};
 const actual=await browserRange({...browserOptions(f,{reads}),request});
 const expected=await collect(iteratePublicHistoryDateRange({...f.options(),...request}));
 assert.deepEqual(normalized(actual.points),normalized(expected.points));assert.equal(actual.receipt.asOf,AS_OF);
 assert.equal(new Set(reads).size,reads.length);assert.equal(reads.some(p=>p.startsWith('daily/')),false);
 assert.ok(actual.points.every(p=>p.date<=day(6)||p.date>=day(20)&&p.date<=day(27)));
 assert.equal(aggregate(rowsFor(f.accounts,actual.points,day(0),day(6))).followers.delta,108);
});
test('date browser peer: long saved history loads recent window plus unchanged since endpoints without flattening all history',async()=>{
 const f=await large,reads=[],actual=await browserRange({...browserOptions(f,{reads}),request:{ranges:[range(468,474)],dates:[day(0),day(474)]}});
 assert.equal(actual.points.length,71*8);assert.ok(reads.length<=4&&reads.length<f.publication.files.length);
 assert.equal(aggregate(rowsFor(f.accounts,actual.points,day(0),day(474))).followers.delta,71*474*474);
 assert.equal(new Set(actual.points.map(triple)).size,actual.points.length);
});
test('date browser peer: old sealed generation remains byte-identical and preserves missing/zero/negative observations',async()=>{
 const f=await small,options=browserOptions(f,{indexed:false}),saved=JSON.stringify(options.manifest),sources=[...f.sources];
 const actual=await browserRange({...options,request:{ranges:[range(10,16),range(29,30)],dates:[day(0),day(20)]}});
 const expected=await collect(iterateLegacyPublicHistoryRange({sourceManifest:f.manifest,readPart:async path=>f.sources.get(path),ranges:[range(10,16),range(29,30)],dates:[day(0),day(20)]}));
 assert.deepEqual(normalized(actual.points),normalized(expected.points));assert.equal(JSON.stringify(options.manifest),saved);assert.deepEqual([...f.sources],sources);
 assert.equal(aggregate(rowsFor(f.accounts,actual.points,day(29),day(30))).likes.delta,-129);
 assert.equal(actual.points.find(p=>p.targetId===3&&p.date===day(20)).followers,null);
});
test('date browser peer: index source identity/count/generation/extra-field faults fail closed',async()=>{
 const f=await small,attacks=[
  ({json})=>{json.get('date-summary-index.json').sourceManifestSha256='f'.repeat(64);},
  ({json})=>{json.get('date-summary-index.json').sourceDaily[0].sha256='f'.repeat(64);},
  ({json})=>{json.get('date-summary-index.json').count++;},
  ({json})=>{json.get('date-summary-index.json').asOf='2028-01-02T03:00:00.000Z';},
  ({json})=>{json.get('date-summary-index.json').credential='synthetic-only';},
 ];
 for(const mutate of attacks)await assert.rejects(browserRange({...browserOptions(f,{mutate}),request:{dates:[day(0)],ranges:[]}}));
});
test('date browser peer: foreign account, duplicate date/account, hidden field and future metric reject entire point batch',async()=>{
 const f=await small,path=f.publication.files[0].path,attacks=[
  ({json})=>{json.get(path).items[0].targetId=999;},
  ({json})=>{json.get(path).items[1]=structuredClone(json.get(path).items[0]);},
  ({json})=>{json.get(path).items[0].credential='synthetic-only';},
  ({json})=>{json.get(path).items[0].followersAt='2029-01-01T00:00:00.000Z';},
 ];
 for(const mutate of attacks)await assert.rejects(browserRange({...browserOptions(f,{mutate}),request:{dates:[day(0)],ranges:[]}}));
});
test('date browser peer: an omitted declared date partition cannot produce a partial success receipt',async()=>{
 const f=await large;const missing=f.publication.files.at(-1).path;
 await assert.rejects(browserRange({...browserOptions(f,{mutate:({manifest})=>{manifest.files=manifest.files.filter(p=>p.path!==missing);}}),
  request:{ranges:[range(468,474)],dates:[day(0),day(474)]}}));
});
test('date browser peer: successful transport followed by cancellation never resolves with points/receipt',async()=>{
 const f=await small,controller=new AbortController(),options=browserOptions(f,{signal:controller.signal});
 const original=options.readPart;options.readPart=async path=>{const result=await original(path);if(path.startsWith('date-summary/'))controller.abort();return result;};
 await assert.rejects(browserRange({...options,request:{dates:[day(0)],ranges:[]}}),e=>e.name==='AbortError');
});
test('date browser/trend peer: visible late window keeps original A/B anchors and fixed cohort even after short B ends',async()=>{
 const f=await small,{trendRangeRequest}=await import(new URL('lib/replica-date-range.mjs',SITE));
 const request=trendRangeRequest({start:day(0),end:day(474),otherStart:day(20),otherEnd:day(27),offset:468,days:7});
 assert.deepEqual(request.ranges,[range(468,474)]);assert.deepEqual(request.dates,[day(0),day(20),day(27),day(474)]);
 const actual=await browserRange({...browserOptions(f),request});
 const trend=growthSeries(f.accounts,actual.points,{start:day(0),end:day(474),otherStart:day(20),otherEnd:day(27),visibleOffset:468,visibleDays:7});
 assert.equal(trend.cohortCount,2);assert.equal(trend.points.length,7);
 assert.equal(trend.points[0].day,468);assert.equal(trend.points[0].currentDate,day(468));
 assert.equal(trend.points[0].current,2*468*468);assert.equal(trend.points.at(-1).current,2*474*474);
 assert.ok(trend.points.every(p=>p.comparisonDate===null&&p.comparison===null));
 assert.equal(aggregate(rowsFor(f.accounts,actual.points,day(0),day(474))).followers.delta,3*474*474);
});
test('date browser/trend peer: strict visible-window parameters reject invalid or oversized requests',async()=>{
 const {trendRangeRequest}=await import(new URL('lib/replica-date-range.mjs',SITE));
 for(const edit of [{offset:-1},{offset:1.5},{days:0},{days:91},{otherStart:day(20)},
  {otherStart:day(27),otherEnd:day(20)},{start:'2026-02-30'}]) {
  assert.throws(()=>trendRangeRequest({start:day(0),end:day(474),...edit}));
 }
});
test('date browser peer: request snapshot and receipt remain exact if caller mutates its draft while loading',async()=>{
 const f=await small,options=browserOptions(f),request={ranges:[range(24,30)],dates:[]};
 const original=options.readPart;
 options.readPart=async path=>{if(path==='date-summary-index.json')request.ranges[0].end=day(40);return original(path);};
 const actual=await browserRange({...options,request});
 assert.deepEqual(actual.receipt.request,{ranges:[range(24,30)],dates:[]});
 assert.equal(actual.points.length,21);assert.ok(actual.points.every(p=>p.date<=day(30)));
 assert.equal(actual.receipt.requestKey,JSON.stringify(actual.receipt.request));assert.equal(actual.receipt.complete,true);
});

const {auditDatePublication}=await import(new URL('lib/replica-date-audit.mjs',SITE));
function auditOptions(f,edit) {
 const manifest=browserOptions(f).manifest;
 const texts=new Map([...f.sources,['date-summary-index.json',f.publication.indexFile.content],...f.parts]);
 const index=JSON.parse(texts.get('date-summary-index.json'));
 const resignPart=(path,mutate)=>{
  const value=JSON.parse(texts.get(path));mutate(value);
  const content=JSON.stringify(value)+'\n';texts.set(path,content);
  const meta=manifest.files.find(f=>f.path===path);
  Object.assign(meta,{count:value.items.length,bytes:Buffer.byteLength(content),sha256:hash(content)});
  const descriptor=index.shards.find(f=>f.path===path);
  Object.assign(descriptor,{count:meta.count,bytes:meta.bytes,sha256:meta.sha256,
   firstDate:value.items[0].date,lastDate:value.items.at(-1).date});
  index.firstDate=index.shards[0].firstDate;index.lastDate=index.shards.at(-1).lastDate;
 };
 edit?.({manifest,texts,index,resignPart});
 const content=JSON.stringify(index)+'\n';texts.set('date-summary-index.json',content);
 Object.assign(manifest.files.find(f=>f.kind==='summaryDateIndex'),{bytes:Buffer.byteLength(content),sha256:hash(content)});
 return {manifest,readText:async path=>texts.get(path),texts};
}
test('date server peer: real bounded full-source proof accepts exact sealed derived source projections',async()=>{
 const f=await large,options=auditOptions(f),originalSources=[...f.sources];
 const proof=await auditDatePublication(options);assert.equal(proof.fullySourceBound,true);
 assert.equal(proof.count,71*475-1);assert.equal(proof.shards,f.publication.files.length);
 assert.deepEqual([...f.sources],originalSources);
});
test('date server peer: a correctly re-signed date value that passes client structure cannot activate against original source',async()=>{
 const f=await small,path=f.publication.files[0].path;
 const options=auditOptions(f,({resignPart})=>resignPart(path,p=>{p.items[0].followers++;}));
 const client=await browserRange({manifest:options.manifest,readPart:async path=>JSON.parse(options.texts.get(path)),request:{dates:[day(0)],ranges:[]}});
 assert.equal(client.points.find(p=>p.targetId===1).followers,1002); // Self-consistency is not source proof.
 await assert.rejects(auditDatePublication(options),/date-source-audit-failed/);
});
test('date server peer: self-consistent re-signed earliest date and vector boundaries still fail original full-source proof',async()=>{
 const f=await small,path=f.publication.files[0].path;
 const options=auditOptions(f,({resignPart})=>resignPart(path,p=>{
  for(const row of p.items.filter(x=>x.date===day(0))) {
   row.date=day(-1);row.capturedAt=new Date(Date.parse(row.capturedAt)-86400000).toISOString();
   for(const field of ['followers','likes','posts'])if(row[field+'At'])row[field+'At']=row.capturedAt;
  }
 }));
 const client=await browserRange({manifest:options.manifest,readPart:async path=>JSON.parse(options.texts.get(path)),request:{dates:[day(-1)],ranges:[]}});
 assert.equal(client.points.length,3);assert.ok(client.points.every(p=>p.date===day(-1)));
 await assert.rejects(auditDatePublication(options),/date-source-audit-failed/);
});
test('date server peer: changed raw byte receipt and cancellation reject, never return full-source success',async()=>{
 const f=await small,options=auditOptions(f),original=options.readText;
 await assert.rejects(auditDatePublication({...options,readText:async path=>(await original(path))+(path==='daily/1.json'?' ':'')}),/date-source-audit-failed/);
 const controller=new AbortController();await assert.rejects(auditDatePublication({...options,signal:controller.signal,
  readText:async path=>{const text=await original(path);if(path==='daily/3.json')controller.abort();return text;}}),e=>e.name==='AbortError');
});

const siteRequire=createRequire(new URL('package.json',SITE));
const textOf=x=>x==null||typeof x==='boolean'?'':typeof x==='object'?Array.isArray(x)?x.map(textOf).join(''):textOf(x.props?.children):String(x);
function elements(x,result=[]){if(x&&typeof x==='object'){if(Array.isArray(x))x.forEach(v=>elements(v,result));else {result.push(x);elements(x.props?.children,result);}}return result;}
async function componentHarness(file,exportName,initialProps,{readPart}={}){
 const ts=siteRequire('typescript'),source=await readFile(new URL(file,SITE),'utf8');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 let props=initialProps,cursor=0,tree,dirty=true,effects=[];const hooks=[],blobs=[],downloads=[];
 const react={useId:()=>"phase114-test-reading",useState(initial){const i=cursor++;hooks[i]??={value:typeof initial==='function'?initial():initial};return [hooks[i].value,next=>{hooks[i].value=typeof next==='function'?next(hooks[i].value):next;dirty=true;}];},
  useMemo(fn){cursor++;return fn();},useCallback(fn){cursor++;return fn;},useRef(initial){const i=cursor++;hooks[i]??={current:initial};return hooks[i];},
  useEffect(fn,deps){const i=cursor++,old=hooks[i];if(!old||deps.some((v,j)=>!Object.is(v,old.deps[j]))){hooks[i]={deps,cleanup:old?.cleanup};effects.push(()=>{old?.cleanup?.();hooks[i].cleanup=fn();});}}};
 const jsx=rendererJsx,exports={};
 class TestURL extends URL{static createObjectURL(blob){blobs.push(blob);return 'blob:synthetic-'+blobs.length;}static revokeObjectURL(){}}
 const context={exports,Blob,URL:TestURL,Date,Map,Set,Promise,AbortController,
  document:{createElement:()=>{const a={click(){downloads.push({name:a.download,href:a.href});}};return a;}},
  setTimeout:fn=>{fn();return 1;},clearTimeout:()=>{},
  require(spec){if(spec==='next/dynamic')return {default:synchronousGrowthDynamic};if(spec==='react')return react;if(spec==='react/jsx-runtime')return {jsx,jsxs:jsx,Fragment:'Fragment'};
   if(spec==='@/lib/replica-reader.mjs'&&readPart)return {readReplicaPart:readPart};
   if(spec.startsWith('@/lib/'))return siteRequire(new URL(spec.slice(2),SITE).pathname);
   if(spec.startsWith('@/components/')||spec==='recharts')return new Proxy({}, {get:(_t,key)=>String(key)});
   return siteRequire(spec);}};
 vm.runInNewContext(code,context,{filename:'independent-real-'+file});
 async function flush(){for(let i=0;i<12;i++){if(dirty){cursor=0;dirty=false;tree=exports[exportName](props);}const queued=effects;effects=[];queued.forEach(f=>f());await new Promise(r=>setImmediate(r));if(!dirty&&!effects.length)break;}return tree;}
 await flush();return {blobs,downloads,flush,all:()=>elements(tree),
  find:predicate=>elements(tree).find(predicate),async setProps(next){props={...props,...next};dirty=true;await flush();},
  async click(label){const node=elements(tree).find(n=>n.type==='Button'&&textOf(n)===label);assert.ok(node,`button missing: ${label}`);node.props.onClick();await flush();},
  close(){hooks.forEach(h=>h?.cleanup?.());}};
}
test('date UI peer: actual GrowthPanel sends controlled B dates and resets visible offset, not private hidden comparison state',async()=>{
 const f=await small,{points}=await collect(iteratePublicHistoryDateRange({...f.options(),ranges:[range(0,6),range(20,27)]}));
 let comparison={compare:false,otherStart:'',otherEnd:''},offset=180;const events=[];
 const onComparison=x=>{comparison=x;events.push(x);},onOffset=x=>{offset=x;};
 const h=await componentHarness('components/growth-panel.tsx','GrowthPanel',{accounts:f.accounts,points,...range(0,6),comparison,offset,onComparison,onOffset});try {
  await h.click('比较另一段日期');assert.equal(comparison.compare,true);assert.equal(offset,0);await h.setProps({comparison,offset});
  h.all().find(n=>n.type==='Input'&&n.props.type==='date').props.onChange({target:{value:day(20)}});assert.equal(comparison.otherStart,day(20));await h.setProps({comparison});
  h.all().filter(n=>n.type==='Input'&&n.props.type==='date')[1].props.onChange({target:{value:day(27)}});await h.setProps({comparison});
  assert.equal(events.length,3);const chart=h.find(n=>n.type==='LineChart');assert.ok(chart);
  assert.equal(chart.props.data[6].current,72);assert.equal(chart.props.data[7].comparison,658);
 }finally{h.close();}
});
test('date UI peer: actual curve export contains exact A/B dates, fixed cohort and current-screen values',async()=>{
 const f=await small,{points}=await collect(iteratePublicHistoryDateRange({...f.options(),ranges:[range(0,6),range(20,27)]}));
 const h=await componentHarness('components/growth-panel.tsx','GrowthPanel',{accounts:f.accounts.map(a=>({...a,platform:'douyin'})),points,manifest:browserOptions(f).manifest,...range(0,6),comparison:{compare:true,otherStart:day(20),otherEnd:day(27)},offset:0,onComparison(){},onOffset(){}});try {
  await h.click('导出本屏曲线记录');assert.equal(h.blobs.length,1);assert.equal(h.downloads.length,1);
  const text=await h.blobs[0].text(),table=[];let record=[],value='',quoted=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){record.push(value);value='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;record.push(value);value='';if(record.some(Boolean))table.push(record);record=[];}else if(c!=='\uFEFF')value+=c;}
  if(value||record.length){record.push(value);table.push(record);}const rows=table.slice(1).map(row=>Object.fromEntries(table[0].map((key,i)=>[key,row[i]]))),metadata=rows.find(row=>row.recordType==='metadata'),cohort=rows.filter(row=>row.recordType==='cohort'),curve=rows.filter(row=>row.recordType==='point');
  assert.equal(metadata.asOf,AS_OF);assert.equal(metadata.start,day(0));assert.equal(metadata.end,day(6));assert.equal(metadata.otherStart,day(20));assert.equal(metadata.otherEnd,day(27));
  assert.equal(metadata.cohortCount,'2');assert.equal(metadata.selectedCount,'3');assert.deepEqual(JSON.parse(metadata.cohortTargetIds),[1,2]);assert.deepEqual(cohort.map(row=>Number(row.targetId)),[1,2]);
  assert.equal(curve.length,8);assert.equal(curve[0].currentDate,day(0));assert.equal(curve[0].comparisonDate,day(20));assert.equal(curve[6].currentDate,day(6));assert.equal(curve[6].currentNetChange,'72');assert.equal(curve[7].comparisonDate,day(27));assert.equal(curve[7].comparisonNetChange,'658');assert.equal(curve[7].currentDate,'');assert.equal(curve[7].currentNetChange,'');
 }finally{h.close();}
});
test('date UI peer: actual AccountPanel nested chart renders and compares safely through its personal controlled props',async()=>{
 const f=await small,account={...f.accounts[0],platform:'douyin',boardKeys:[],classification:{theme:{label:'团团'},labels:[]}};
 const h=await componentHarness('components/account-panel.tsx','AccountPanel',{account,manifest:browserOptions(f).manifest,boards:[],request:{id:1,start:day(0),end:day(6),generation:AS_OF},onReturn(){},onAddress(){},onHistory(){}},
  {readPart:async({part})=>JSON.parse(f.sources.get(part))});try {
   const nested=h.find(n=>n.type==='GrowthPanel');assert.ok(nested,'personal history must expose a usable chart');
   const chart=await componentHarness('components/growth-panel.tsx','GrowthPanel',nested.props);try {
    assert.equal(typeof nested.props.onComparison,'function');assert.equal(typeof nested.props.onOffset,'function');
    const synchronize=async()=>{await h.flush();await chart.setProps(h.find(n=>n.type==='GrowthPanel').props);};
    assert.ok(chart.find(n=>n.type==='LineChart'));await chart.click('比较另一段日期');
    await synchronize();
    chart.all().find(n=>n.type==='Input'&&n.props.type==='date').props.onChange({target:{value:day(20)}});await synchronize();
    chart.all().filter(n=>n.type==='Input'&&n.props.type==='date')[1].props.onChange({target:{value:day(27)}});await synchronize();
    const comparison=chart.find(n=>n.type==='LineChart');assert.ok(comparison);
    assert.equal(comparison.props.data[6].current,36);assert.equal(comparison.props.data[7].comparison,329);
   }finally{chart.close();}
  }finally{h.close();}
});
