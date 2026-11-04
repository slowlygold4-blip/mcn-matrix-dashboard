import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {MonitorDatabase} from '../lib/database.mjs';
import {PublicWebProvider} from '../lib/providers/public-web.mjs';
import {readKnownBilibiliWorks} from '../lib/bilibili-known-works.mjs';
import {normalizeCollection} from '../lib/providers/normalize.mjs';
import {bilibiliWorkObservation} from '../lib/bilibili-work-observation.mjs';
import {collectionProgress} from '../lib/collection-progress.mjs';
import {exportPublicReplica} from '../lib/public-replica-export.mjs';
import {readCommittedTargetPublication,releaseCommittedTargetPublication} from '../lib/committed-target-publication.mjs';

const mid='525138167',ids=['BV1fi416bEpi','BV1H5sf6NEP6'];
const collector=fileURLToPath(new URL('../scripts/douyin_public_collector.py',import.meta.url));
function rawFixture(options={}){
 const code=String.raw`
import importlib.util,json,sys
s=importlib.util.spec_from_file_location('collector',sys.argv[1]);c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
options=json.loads(sys.argv[2]);ids=['BV1fi416bEpi','BV1H5sf6NEP6'];calls=[];c.bili_opener=lambda:object()
def listing(o,mid,limit,evidence=None):
 evidence.update({'status':'success' if options.get('empty') or options.get('list') else 'refused','source':'wbi','statusCode':0,'listObserved':bool(options.get('empty') or options.get('list')),'rawCount':1 if options.get('list') else 0,'errorCode':'login_required'})
 return [{'bvid':'BV9999999999','title':'new head work','created':1789250010,'author_mid':'99999' if options.get('foreignHead') else mid}] if options.get('newHead') else [{'bvid':ids[0]}] if options.get('list') else []
c.bili_latest_videos=listing
def request(o,url):
 if '/card?' in url:return {'data':{'card':{'mid':'525138167','fans':42},'like_num':500}}
 if '/navnum?' in url:return {'data':{'video':0 if options.get('empty') else 100}}
 calls.append(url);bvid=c.urllib.parse.parse_qs(c.urllib.parse.urlparse(url).query)['bvid'][0]
 if options.get('detailRefusal'):raise c.BilibiliRequestError('blocked',http_status=403)
 if bvid==ids[0] and options.get('firstFailure'):
  failure=options['firstFailure'];raise c.BilibiliRequestError(failure['errorCode'],business_code=failure.get('businessCode'),http_status=failure.get('httpStatus'))
 return {'data':{'bvid':bvid,'title':'public work','pubdate':1789250000,'owner':{'mid':'99999' if options.get('foreign') else '525138167'},'stat':{'like':0 if bvid==ids[0] else 11,'view':100}}}
c.bili_json=request
try:print(json.dumps({'raw':c.collect_bilibili_account('525138167',30,options.get('ids',ids),options.get('prefer',False)),'calls':calls}))
except c.CollectorError as e:print(json.dumps({'rejected':True,'calls':calls}))
`;
 const result=spawnSync('/usr/bin/python3',['-B','-c',code,collector,JSON.stringify(options)],{encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}
function setup(t){
 const database=new MonitorDatabase(':memory:');t.after(()=>database.close());
 const target=database.createTarget({type:'account',provider:'public-web',label:'offline Bili',locator:mid,metadata:{platform:'bilibili'}});
 return {database,target,db:database.db};
}
test('only own enabled stored BVs are selected, bounded and rotated by actual like observations',t=>{
 const f=setup(t),at='2026-11-01T00:00:00.000Z';
 const add=(id,author=mid)=>f.db.prepare("INSERT INTO posts(target_id,external_id,author_id,caption,first_seen_at,last_seen_at) VALUES(?,?,?,'',?,?)").run(f.target.id,id,author,at,at).lastInsertRowid;
 const rows=Array.from({length:9},(_,i)=>add('BV'+String(i+1).padStart(10,'0')));add('BV9999999999','99999');
 for(let i=0;i<rows.length;i++)f.db.prepare('INSERT INTO post_metrics(post_id,captured_at,likes) VALUES(?,?,?)').run(rows[i],at,i===0?null:i===1?0:i);
 assert.deepEqual(readKnownBilibiliWorks(f.database,f.target,mid),Array.from({length:6},(_,i)=>'BV'+String(i+1).padStart(10,'0')));
 for(const row of rows.slice(0,6))f.db.prepare('INSERT INTO post_metrics(post_id,captured_at,likes) VALUES(?,?,1)').run(row,'2026-11-02T00:00:00.000Z');
 assert.deepEqual(readKnownBilibiliWorks(f.database,f.target,mid).slice(0,3),['BV0000000007','BV0000000008','BV0000000009']);
 const evidence={knownWorksEvidence:{version:1,source:'stored-account-work-ids',attemptedIds:['BV0000000007']}};
 f.db.prepare("INSERT INTO snapshots(target_id,captured_at,quality_status,raw_json,source_checksum) VALUES(?,?,'warning',?,'synthetic')")
  .run(f.target.id,'2026-11-02T01:00:00.000Z',JSON.stringify(evidence));
 assert.equal(readKnownBilibiliWorks(f.database,f.target,mid)[0],'BV0000000008','failed known work rotates without manufacturing a metric');
 assert.deepEqual(readKnownBilibiliWorks(f.database,f.target,'99999'),[]);
 assert.equal(readKnownBilibiliWorks(f.database,{...f.target,locator:'https://space.bilibili.com/'+mid},mid).length,6);
 f.db.prepare('UPDATE targets SET enabled=0 WHERE id=?').run(f.target.id);
 assert.deepEqual(readKnownBilibiliWorks(f.database,f.target,mid),[]);
 assert.deepEqual(readKnownBilibiliWorks(null,f.target,mid),[]);
});
test('a refused author inventory does not prevent independently bound stored work metrics or invent daily inventory',async t=>{
 const f=setup(t),run=f.database.beginRun('test',f.target.id,1),fixture=rawFixture();let args;
 for(const id of ids)f.db.prepare("INSERT INTO posts(target_id,external_id,author_id,caption,first_seen_at,last_seen_at) VALUES(?,?,?,'',?,?)")
  .run(f.target.id,id,mid,'2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z');
 const provider=new PublicWebProvider({}, {database:f.database,execFileImpl:(_file,a,_options,callback)=>{args=a;callback(null,JSON.stringify({ok:true,data:fixture.raw}), '');}});
 const result=await provider.collect(f.target);
 assert.equal(result.worksCoverage,'limited');assert.equal(result.snapshot.totalLikes,500);
 assert.deepEqual(result.posts.map(p=>p.likes),[0,11]);assert.equal(result.raw.worksListEvidence.status,'refused');
 assert.equal(result.raw.knownWorksEvidence.used,true);assert.match(result.warnings.join(' '),/每日新投稿数量仍未确认/);
 f.database.saveCollection(f.target,run,result);
 f.database.finishRun(run,{status:'success',successCount:1,warningCount:1});
 const progress=collectionProgress(f.db);
 assert.equal(progress.dailyWorkLikes.platforms[0].observedWorks,2);
 assert.equal(progress.dailyWorkLikes.platforms[0].observedAccounts,1);
 assert.equal(progress.rolling.worksComplete,0);assert.equal(f.db.prepare('SELECT total_likes FROM snapshots').get().total_likes,500);
 assert.deepEqual(args.flatMap((a,i)=>a==='--known-work'?[args[i+1]]:[]),ids);
 // Verify the real durable collection can reach the public replica, rather
 // than only testing a process response or the local metric count.
 f.db.exec('BEGIN');let receipt;
 try{
  const asOf=new Date().toISOString();receipt=readCommittedTargetPublication(f.db,{asOf});
  const replica=exportPublicReplica(f.db,{asOf,committedPublication:receipt});
  const metrics=replica.partitions.filter(p=>p.kind==='workMetrics').flatMap(p=>p.items);
  assert.equal(metrics.length,2);assert.deepEqual(metrics.map(p=>p.likes),[0,11]);
  assert.equal(replica.catalog.accounts[0].latest.likes.value,500);
  assert.equal(replica.catalog.accounts[0].coverage.works.status,'limited');
  assert.equal(replica.catalog.accounts[0].coverage.works.observedAt,result.raw.workObservationTimes.observations.at(-1).observedAt);
  assert.equal(replica.catalog.accounts[0].coverage.works.attemptedAt,result.raw.capturedAt);
 }finally{if(receipt)releaseCommittedTargetPublication(receipt);f.db.exec('ROLLBACK');}
});
test('a detail refusal stops further known details and never turns local references into observed list rows',()=>{
 const x=rawFixture({detailRefusal:true});assert.equal(x.calls.length,1);
 assert.equal(x.raw.workDetailEvidence.deferredCount,1);assert.deepEqual(x.raw.works.aweme_list,[]);
 assert.deepEqual(x.raw.workObservationTimes.observations,[]);assert.equal(x.raw.worksErrorCode,'blocked');
 assert.deepEqual(x.raw.knownWorksEvidence.attemptedIds,[ids[0]],'deferred IDs are not claimed as attempted');
});
test('known unavailable detail is isolated while its next bounded work is actually requested',t=>{
 for(const businessCode of [-404,62002,62012]){
  const x=rawFixture({firstFailure:{errorCode:'business_error',businessCode}});
  assert.equal(x.calls.length,2);assert.equal(x.raw.workDetailEvidence.failedCount,1);
  assert.equal(x.raw.workDetailEvidence.successfulCount,1);assert.equal(x.raw.workDetailEvidence.deferredCount,0);
  assert.deepEqual(x.raw.knownWorksEvidence.attemptedIds,ids);
  assert.deepEqual(x.raw.works.aweme_list.map(w=>w.aweme_id),[ids[1]]);
  assert.deepEqual(x.raw.workObservationTimes.observations.map(w=>w.contentId),[ids[1]]);
  const normalized=normalizeCollection({type:'account',provider:'public-web',locator:mid,metadata:{platform:'bilibili'}},x.raw);
  assert.deepEqual(normalized.posts.map(p=>p.likes),[11],'unavailable item must not become an invented zero metric');
 }
});
test('unknown business errors and explicit account refusals still stop subsequent detail requests',()=>{
 for(const firstFailure of [
  {errorCode:'business_error',businessCode:-999},{errorCode:'business_error'},
  {errorCode:'business_error',businessCode:'62002'},
  {errorCode:'business_error',businessCode:62002,httpStatus:403},
  {errorCode:'login_required',businessCode:-101},{errorCode:'blocked',httpStatus:403},
  {errorCode:'rate_limited',httpStatus:429},
 ]){
  const x=rawFixture({firstFailure});assert.equal(x.calls.length,1,JSON.stringify(firstFailure));
  assert.equal(x.raw.workDetailEvidence.deferredCount,1);assert.deepEqual(x.raw.knownWorksEvidence.attemptedIds,[ids[0]]);
  assert.deepEqual(x.raw.works.aweme_list,[]);assert.deepEqual(x.raw.workObservationTimes.observations,[]);
 }
});
test('known works cannot authorize another owner, replace a valid window or override confirmed zero inventory',()=>{
 assert.deepEqual(rawFixture({foreign:true}).raw.works.aweme_list,[]);
 for(const options of [{empty:true},{list:true}]){
  const x=rawFixture(options);assert.equal(x.raw.knownWorksEvidence.used,false);
  assert.equal(x.calls.length,options.list?1:0);
 }
 for(const values of [[...ids,ids[0]],Array(7).fill(ids[0]),['https://private.invalid/'],['BVnot-valid'],[1]]){
  const x=rawFixture({ids:values});assert.equal(x.rejected,true);assert.deepEqual(x.calls,[]);
 }
});

test('automatic daily selection updates old works even with a valid new head, retaining actual head dates without invented likes',()=>{
 const x=rawFixture({list:true,newHead:true,prefer:true});
 assert.equal(x.raw.knownWorksEvidence.used,true);assert.equal(x.calls.length,2);
 assert.deepEqual(x.raw.knownWorksEvidence.attemptedIds,ids);
 assert.deepEqual(x.raw.works.aweme_list.map(w=>w.aweme_id),[...ids,'BV9999999999']);
 const head=x.raw.works.aweme_list.at(-1);assert.equal(head.desc,'new head work');assert.equal(head.create_time,1789250010);
 assert.equal(head.statistics.digg_count,undefined,'a list fact is not a new like observation');
 assert.equal(x.raw.workObservationTimes.observations.at(-1).source,'list');
 const target={id:1,type:'account',provider:'public-web',locator:mid,metadata:{platform:'bilibili'}};
 const normalized=normalizeCollection(target,x.raw,{capturedAt:x.raw.capturedAt});
 const clocks=bilibiliWorkObservation(target,normalized);
 assert.equal(clocks.postTimes.get('BV9999999999'),x.raw.workObservationTimes.observations.at(-1).observedAt);
 assert.equal(normalized.posts.at(-1).likes,null);
 assert.deepEqual(rawFixture({list:true,newHead:true,prefer:true,foreignHead:true}).raw.works.aweme_list.map(w=>w.aweme_id),ids,'unbound head facts must not be assigned to this author');
 const empty=rawFixture({empty:true,prefer:true});assert.equal(empty.calls.length,0);assert.equal(empty.raw.knownWorksEvidence.used,false);
 const refused=rawFixture({list:true,newHead:true,prefer:true,detailRefusal:true});
 assert.equal(refused.calls.length,1,'the same refusal still stops detail requests');
 assert.deepEqual(refused.raw.works.aweme_list.map(w=>w.aweme_id),['BV9999999999'],'only the actually returned head fact survives');
});
