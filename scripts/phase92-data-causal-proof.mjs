// Phase92 independent causal readback of one real MCN inventory/publication question.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {checksum,businessDateKey} from '../lib/utils.mjs';
import {normalizeCollection,normalizePost} from '../lib/providers/normalize.mjs';
import {getAccountHistory} from '../lib/account-history.mjs';
const root=new URL('../',import.meta.url),read=p=>readFileSync(new URL(p,root));
const sha=b=>createHash('sha256').update(b).digest('hex'),epoch=v=>Date.parse(v);
const fields=['likes','comments','shares','collects','plays'],vector=o=>Object.fromEntries(fields.map(k=>[k,o[k]??null]));
const cutoff='2026-10-02T01:21:47.929Z',start='2026-09-12',end='2026-10-02';
const endpointBytes=read('data/maintenance-journal/2026-10-02-phase92-data-mcn-endpoints.json');
assert.equal(sha(endpointBytes),'410f032066840d47c977a968bf5168701c6d4fd3301773ee9e362661b31066bb');
const endpointAudit=JSON.parse(endpointBytes),sample=endpointAudit.checks[7].topContributions.find(a=>a.targetId===285);
const db=new DatabaseSync(new URL('data/douyin-monitor.sqlite',root).pathname,{readOnly:true});
let out;
try{
 db.exec('PRAGMA query_only=ON;BEGIN');
 const target=db.prepare('SELECT * FROM targets WHERE id=285').get(),sources=[];
 for(const endpoint of sample.endpoints){
  const row=db.prepare('SELECT * FROM snapshots WHERE id=?').get(endpoint.id),raw=JSON.parse(row.raw_json),normalized=normalizeCollection(target,raw,{capturedAt:row.captured_at});
  assert.equal(row.target_id,285);assert.equal(checksum(raw),row.source_checksum);assert.equal(sha(row.raw_json),endpoint.rawBytesSha256);
  assert.equal(normalized.snapshot.totalPosts,row.total_posts);assert.equal(normalized.snapshot.totalLikes,row.total_likes);
  assert.equal(raw.profile.user.sec_uid,target.locator);
 }
 assert.equal(sample.endpoints[1].posts-sample.endpoints[0].posts,-59);
 assert.equal(sample.endpoints[1].likes-sample.endpoints[0].likes,179426);
 const history=getAccountHistory(db,285,{kind:'works',startDate:start,endDate:end,pageSize:100,asOf:cutoff,order:'asc'});
 assert.equal(history.pagination.total,34);assert.equal(history.items.length,34);assert.equal(history.coverage.platformComplete,false);
 const add=(p,observedAt,sourceKind,sourceId,sourceSha,identityUid)=>{
  if(p.authorId!==target.locator)return;
  sources.push({post:p,observedAt,sourceKind,sourceId,sourceSha,identityUid});
 };
 for(const row of db.prepare('SELECT * FROM snapshots WHERE target_id=285 AND julianday(captured_at)<=julianday(?)').all(cutoff)){
  const raw=JSON.parse(row.raw_json);assert.equal(checksum(raw),row.source_checksum);
  const n=normalizeCollection(target,raw,{capturedAt:row.captured_at});
  for(const p of n.posts)add(p,row.works_observed_at??row.captured_at,'snapshot',row.id,row.source_checksum,raw.profile?.user?.uid??null);
 }
 for(const row of db.prepare('SELECT * FROM works_observations WHERE target_id=285 AND julianday(request_finished_at)<=julianday(?)').all(cutoff)){
  const raw=JSON.parse(row.raw_json);assert.equal(checksum(raw),row.source_checksum);let off=0;
  for(const page of raw.pagination?.pages??[]){for(const p of raw.posts.slice(off,off+page.acceptedCount))add(normalizePost(p),page.observedAt,'works_observation',row.id,row.source_checksum,raw.identity.uid);off+=page.acceptedCount;}
 }
 const works=history.items.map(item=>{
  const candidates=sources.filter(s=>s.post.externalId===item.externalId&&epoch(s.observedAt)===epoch(item.lastObservedAt)
   &&epoch(s.post.publishedAt)===epoch(item.publishedAt)&&JSON.stringify(vector(s.post))===JSON.stringify(vector(item)));
  assert.ok(candidates.length,'exact source missing for work '+item.id);
  const source=candidates[0];assert.equal(source.post.raw.author.sec_uid,target.locator);assert.equal(source.post.raw.author.uid,source.identityUid);
  assert.ok(epoch(item.firstSeenAt)<=epoch(cutoff));assert.ok(businessDateKey(item.publishedAt)>=start&&businessDateKey(item.publishedAt)<=end);
  return {postId:item.id,publishedAt:item.publishedAt,firstSeenAt:item.firstSeenAt,observedAt:item.lastObservedAt,
   sourceKind:source.sourceKind,sourceId:source.sourceId,sourceSha256:source.sourceSha,rawPostSha256:checksum(source.post.raw),
   metricVectorSha256:checksum(vector(item)),actualPlaysVerified:item.playsEvidence.actualCountVerified,
   sourceReportedPlays:item.plays,mayBePlaceholder:item.playsEvidence.mayBePlaceholder};
 });
 const freshAudit=JSON.parse(read('data/maintenance-journal/2026-10-02-phase92-data-audit.json')),emptyProof=freshAudit.proofs.find(p=>p.runId===2522);
 const emptyNextWorks=emptyProof.sourceVectors.filter(v=>v.observedAt===emptyProof.pages[2].observedAt).map(v=>{
  const row=db.prepare('SELECT id,published_at,first_seen_at FROM posts WHERE id=?').get(v.postId);
  assert.equal(row.first_seen_at,v.observedAt);assert.ok(row.published_at.startsWith('2024-'));return {...row};
 });
 const dailyHistory=getAccountHistory(db,264,{kind:'daily',startDate:'2026-09-01',endDate:'2026-09-30',pageSize:100,asOf:cutoff});
 assert.equal(dailyHistory.items.length,28);assert.equal(dailyHistory.coverage.missingDatesFilled,false);
 assert.ok(!dailyHistory.items.some(v=>['2026-09-18','2026-09-19'].includes(v.date)));
 out={checkedAt:new Date().toISOString(),cutoff,endpointAuditSha256:sha(endpointBytes),targetId:285,
  realBusinessQuestion:'Why inventory falls while saved published works remain positive',
  endpoints:sample.endpoints,postsInventoryDelta:-59,likesDelta:179426,estimatedPlaysDelta:17942600,
  estimatedPlaysIsActual:false,publishedSamples:34,verifiedSourceBoundSamples:works,
  allSamplePlayCountsVerified:false,allSamplesSourceReportedZero:works.every(w=>w.sourceReportedPlays===0),
  conclusion:'Inventory is a net platform counter; positive publication samples and negative inventory can coexist. No deletion, privacy change or actual play count causal claim is justified.',
  sourceCauseOfInventoryDecrease:'not established by saved sources',
  emptyAdvancing:{runId:2522,sourceSha256:emptyProof.sourceSha256,pages:emptyProof.pages,firstSeenWorks:emptyNextWorks,
    allPublishedIn2024:true,newlyDiscoveredNotNewlyPublished:true,noPerRunCodeHash:true},
  missingHistoricalDates:{targetId:264,actualSavedDates:28,missing:['2026-09-18','2026-09-19'],filled:false},
  queryOnly:db.prepare('PRAGMA query_only').get().query_only,totalChanges:db.prepare('SELECT total_changes() n').get().n,
  noNetwork:true,noSampling:true,noReviewCompletion:true,noDatabaseWrites:true};
 assert.equal(out.queryOnly,1);assert.equal(out.totalChanges,0);db.exec('ROLLBACK');
}finally{db.close();}
out.scriptSha256=sha(read('scripts/phase92-data-causal-proof.mjs'));
const text=JSON.stringify(out,null,2)+'\n';assert.doesNotMatch(text,/https?:\/\/|Bearer\s|Authorization\s*[:=]|Cookie\s*[:=]|MS4wLj/i);
const file=new URL('data/maintenance-journal/2026-10-02-phase92-data-causal-proof.json',root);writeFileSync(file,text,{flag:'wx',mode:0o600});
console.log(JSON.stringify({path:file.pathname,sha256:sha(text),count:out.verifiedSourceBoundSamples.length,inventory:out.postsInventoryDelta,estimated:out.estimatedPlaysDelta,zeroSourcePlays:out.allSamplesSourceReportedZero,emptyAdvancing:out.emptyAdvancing}));

