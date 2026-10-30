import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {PublicWebProvider} from '../lib/providers/public-web.mjs';
import {MonitorDatabase} from '../lib/database.mjs';
import {MonitorScheduler} from '../lib/scheduler.mjs';
import {collectionProgress} from '../lib/collection-progress.mjs';

const collector=fileURLToPath(new URL('../scripts/douyin_public_collector.py',import.meta.url));
function python(script,options={}){
 const p=spawnSync('/usr/bin/python3',['-B','-c',String.raw`import importlib.util,io,json,sys,urllib.error
s=importlib.util.spec_from_file_location('collector',sys.argv[1]);c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
options=json.loads(sys.argv[2])
`+script,collector,JSON.stringify(options)],{encoding:'utf8',timeout:10000});
 assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);
}
test('Bilibili JSON transport preserves only numeric refusal metadata and rejects missing success codes',()=>{
 for(const options of [{http:401,code:'login_required'},{http:403,code:'blocked'},{http:429,code:'rate_limited'},
  {business:-101,code:'login_required'},{business:-352,code:'business_error'},{business:999,code:'business_error'},
  {missing:true,code:'upstream_changed'},{business:false,code:'upstream_changed'},
  {malformed:true,code:'upstream_changed'},{network:true,code:'network_error'}]){
  const x=python(String.raw`
class Opener:
 def open(self,request,timeout=None):
  if options.get('http'):raise urllib.error.HTTPError(request.full_url,options['http'],'SECRET-error-message',{},None)
  if options.get('network'):raise urllib.error.URLError('SECRET-access-token')
  body={} if options.get('missing') else {'code':options.get('business',0),'message':'SECRET-business-message'}
  return io.BytesIO(b'not-json SECRET' if options.get('malformed') else json.dumps(body).encode())
try:
 c.bili_json(Opener(),'https://api.bilibili.com/x/web-interface/view?bvid=BV1fi416bEpi')
 print(json.dumps({'accepted':True}))
except c.CollectorError as e:
 print(json.dumps({'code':e.code,'httpStatus':getattr(e,'http_status',None),'businessCode':getattr(e,'business_code',None),'message':str(e)}))
`,options);
  assert.equal(x.code,options.code,JSON.stringify(options));
  assert.equal(x.httpStatus,options.http??null);
  assert.equal(x.businessCode,Number.isInteger(options.business)?options.business:null);
  assert.doesNotMatch(JSON.stringify(x),/SECRET/);
 }
});
test('verified earlier details remain valid when a later work is refused; deferred works do not acquire likes',()=>{
 const x=python(String.raw`
ids=['BV1fi416bEpi','BV1H5sf6NEP6','BV1xx416bEpi'];calls=[];c.bili_opener=lambda:object()
def listing(o,mid,limit,evidence=None):
 evidence.update({'status':'success','source':'wbi','statusCode':0,'listObserved':True,'rawCount':3})
 return [{'bvid':i,'created':1,'title':'known','play':12} for i in ids]
c.bili_latest_videos=listing
def request(o,url):
 if '/card?' in url:return {'data':{'card':{'mid':'525138167','fans':42},'like_num':91}}
 if '/navnum?' in url:return {'data':{'video':30}}
 calls.append(url)
 if len(calls)==1:return {'data':{'bvid':ids[0],'owner':{'mid':'525138167'},'stat':{'like':0}}}
 raise c.BilibiliRequestError('blocked',http_status=403)
c.bili_json=request;r=c.collect_bilibili_account('525138167',30)
print(json.dumps({'raw':r,'detailCalls':len(calls)}))
`);
 assert.equal(x.detailCalls,2);assert.equal(x.raw.workDetailEvidence.successfulCount,1);
 assert.equal(x.raw.workDetailEvidence.failedCount,1);assert.equal(x.raw.workDetailEvidence.deferredCount,1);
 assert.equal(x.raw.works.aweme_list[0].statistics.digg_count,0);
 assert.ok(x.raw.works.aweme_list.slice(1).every(w=>w.statistics.digg_count===undefined));
 assert.deepEqual(x.raw.workObservationTimes.observations.map(o=>o.source),['view','list','list']);
});
test('Bilibili navigation and list failures retain the exact stopping phase without fallback after refusal',()=>{
 for(const phase of ['navigation','list']){
  const x=python(String.raw`
calls=[];c.time.sleep=lambda n:None
class Opener:
 def open(self,request,timeout=None):
  path=c.urllib.parse.urlparse(request.full_url).path;calls.append(path)
  if '/nav' in path and options['phase']=='list':return io.BytesIO(json.dumps({'code':0,'data':{'wbi_img':{'img_url':'https://i.example/'+('a'*32)+'.png','sub_url':'https://i.example/'+('b'*32)+'.png'}}}).encode())
  raise urllib.error.HTTPError(request.full_url,403,'SECRET',{},None)
e={};rows=c.bili_latest_videos(Opener(),'525138167',30,evidence=e)
print(json.dumps({'rows':rows,'evidence':e,'calls':calls}))
`,{phase});
  assert.deepEqual(x.rows,[]);assert.equal(x.evidence.phase,phase);assert.equal(x.evidence.errorCode,'blocked');
  assert.equal(x.evidence.httpStatus,403);assert.equal(x.evidence.listObserved,false);
  assert.equal(x.calls.length,phase==='navigation'?1:2);assert.doesNotMatch(JSON.stringify(x),/SECRET|dynamic/);
 }
});
test('Bilibili detail refusal stops later requests while preserving every list reference and null likes',async()=>{
 for(const failure of [{http:401},{http:403},{http:429},{business:-352}]){
  const x=python(String.raw`
ids=['BV1fi416bEpi','BV1H5sf6NEP6','BV1xx416bEpi'];calls=[];c.bili_opener=lambda:object()
def listing(o,mid,limit,evidence=None):
 evidence.update({'status':'success','source':'wbi','statusCode':0,'listObserved':True,'rawCount':3})
 return [{'bvid':i,'created':1,'title':'known','play':12} for i in ids]
c.bili_latest_videos=listing
class Opener:
 def open(self,request,timeout=None):
  if options.get('http'):raise urllib.error.HTTPError(request.full_url,options['http'],'SECRET',{},None)
  return io.BytesIO(json.dumps({'code':options['business'],'message':'SECRET'}).encode())
actual=c.bili_json
def request(o,url):
 if '/card?' in url:return {'data':{'card':{'mid':'525138167','fans':42},'like_num':91}}
 if '/navnum?' in url:return {'data':{'video':30}}
 calls.append(url);return actual(Opener(),url)
c.bili_json=request
r=c.collect_bilibili_account('525138167',30)
print(json.dumps({'raw':r,'detailCalls':len(calls)}))
`,failure);
  assert.equal(x.detailCalls,1);assert.equal(x.raw.works.aweme_list.length,3);
  assert.equal(x.raw.workDetailEvidence.requestedCount,1);assert.equal(x.raw.workDetailEvidence.failedCount,1);
  assert.equal(x.raw.workDetailEvidence.deferredCount,2);assert.equal(x.raw.workDetailEvidence.successfulCount,0);
  assert.equal(x.raw.workDetailEvidence.errors[0].httpStatus,failure.http??null);
  assert.equal(x.raw.workDetailEvidence.errors[0].businessCode,failure.business??null);
  assert.doesNotMatch(JSON.stringify(x),/SECRET/);
  const collection=await new PublicWebProvider({},{execFileImpl:(_f,_a,_o,cb)=>cb(null,JSON.stringify({ok:true,data:x.raw}),'')})
   .collect({id:1,type:'account',locator:'525138167',metadata:{platform:'bilibili'}});
  assert.equal(collection.snapshot.followers,42);assert.equal(collection.snapshot.totalLikes,91);
  assert.equal(collection.posts.length,3);assert.ok(collection.posts.every(p=>p.likes===null));
  assert.equal(collection.worksCoverage,'limited');assert.match(collection.worksError,/详情/);
  const db=new MonitorDatabase(':memory:');
  try{
   const target=db.createTarget({type:'account',label:'offline',provider:'public-web',locator:'525138167',metadata:{platform:'bilibili'}});
   const scheduler=new MonitorScheduler(db,{providerOptions:{cooldownMs:0,execFileImpl:(_f,_a,_o,cb)=>cb(null,JSON.stringify({ok:true,data:x.raw}),'')}});
   const run=await scheduler.runAll({targetId:target.id});
   assert.equal(run.details[0].worksErrorCode,x.raw.worksErrorCode,'no Douyin transport policy required for another platform diagnostics');
   const row=db.db.prepare('SELECT works_error,raw_json FROM snapshots').get();
   assert.match(row.works_error,/详情/);assert.deepEqual(JSON.parse(row.raw_json).workDetailEvidence,x.raw.workDetailEvidence);
   assert.equal(db.db.prepare('SELECT COUNT(*) n FROM post_metrics WHERE likes IS NOT NULL').get().n,0);
   const progress=collectionProgress(db.db);
   assert.equal(progress.rolling.platforms.find(p=>p.platform==='bilibili').workIssues,1);
  }finally{db.close()}
 }
});
