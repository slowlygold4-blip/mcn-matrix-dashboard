// Explicit, operator-owned admission of a checked HTTP sample. No transport,
// scheduler, credentials or models; never refreshes profile totals/coverage.
import { checksum } from './utils.mjs';
import { normalizePost } from './providers/normalize.mjs';
import { readWorksOnlyAnchor } from './works-only-observation.mjs';
import { assertPostHistoryIdentity, persistPosts } from './post-persistence.mjs';

const fail = () => { throw Object.assign(new Error('远程作品证据无效，未写入'), {code:'REMOTE_WORK_OBSERVATION_INVALID'}); };
const object = x => x && typeof x==='object' && !Array.isArray(x);
// Trust comes from the operator's separate option, never a receipt field.
// No URL is fetched here. Keep the original demo default for receipt replay.
function approvedOrigin(value) {
 if(typeof value!=='string')fail();
 let url;try{url=new URL(value);}catch{fail();}
 if(url.protocol!=='https:'||url.username||url.password||url.port
  ||url.origin!==value||url.pathname!=='/'||url.search||url.hash)fail();
 return value;
}
function time(x) {
 if(typeof x!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(x))fail();
 const n=Date.parse(x);
 if(!Number.isFinite(n)||new Date(n).toISOString().slice(0,19)!==x.slice(0,19))fail();
 return n;
}
function count(x) {
 if(x==null)return null;
 if(!Number.isSafeInteger(x)||x<0)fail();
 return x;
}

export function normalizeRemoteWorkPage(receipt, anchor, {now=Date.now(),sourceOrigin='https://demo.douyin.wtf'}={}) {
 const source=approvedOrigin(sourceOrigin);
 if(!object(receipt)||receipt.source!==source||receipt.httpStatus!==200
  ||!object(receipt.meta)||receipt.meta.endpoint!=='douyin.author_posts'||receipt.meta.cached!==false
  ||typeof receipt.meta.request_id!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(receipt.meta.request_id)
  ||!object(receipt.data)||!Array.isArray(receipt.data.items)||receipt.data.items.length<1||receipt.data.items.length>100
  ||typeof receipt.data.has_more!=='boolean'||!Number.isFinite(now))fail();
 const start=time(receipt.requestStartedAt),finish=time(receipt.requestFinishedAt);
 if(start>finish||finish>now||finish-start>60_000)fail();
 if(!/^MS4wLj[\w-]{12,220}$/.test(anchor?.secUid)||typeof anchor?.uid!=='string')fail();
 const posts=[],postTimes=new Map(),rows=new Map();
 for(const item of receipt.data.items){
  if(!object(item)||item.platform!=='douyin'||typeof item.content_id!=='string'||!/^\d{15,25}$/.test(item.content_id)
   ||!object(item.author)||item.author.sec_uid!==anchor.secUid
   // DTK deliberately uses sec_uid as author.uid. Do not compare namespaces
   // or replace the stored numeric UID with that canonical string.
   ||(item.author.uid!==anchor.secUid&&item.author.uid!==anchor.uid)
   ||item.is_deleted!==false||item.is_private!==false||!object(item.stats))fail();
  const observed=time(item.fetched_at);
  if(observed<start||observed>finish)fail();
  const published=item.created_at==null?null:time(item.created_at);
  if(published!==null&&published>observed)fail();
  const likes=count(item.stats.digg_count);
  if(likes===null)fail();
  const raw={content_id:item.content_id,title:typeof item.title==='string'?item.title.slice(0,2000):'',
   created_at:published===null?null:new Date(published).toISOString(),
   author:{sec_uid:anchor.secUid,uid:item.author.uid,
    nickname:typeof item.author.nickname==='string'?item.author.nickname.slice(0,200):''},
   stats:{digg_count:likes,comment_count:count(item.stats.comment_count),
    share_count:count(item.stats.share_count),collect_count:count(item.stats.collect_count),play_count:null},
   sourceObservation:{source:receipt.source,endpoint:receipt.meta.endpoint,requestId:receipt.meta.request_id,
    fetchedAt:new Date(observed).toISOString(),plays_source:'unavailable'}};
  if(rows.has(item.content_id)){
   if(checksum(rows.get(item.content_id))!==checksum(raw))fail();
   continue;
  }
  rows.set(item.content_id,raw);posts.push(normalizePost(raw));postTimes.set(item.content_id,new Date(observed).toISOString());
 }
 return {posts,postTimes,evidence:{version:1,kind:'remote-http-work-observation',source:receipt.source,
  endpoint:receipt.meta.endpoint,requestId:receipt.meta.request_id,
  requestStartedAt:new Date(start).toISOString(),requestFinishedAt:new Date(finish).toISOString(),
  observedAt:[...postTimes.values()].sort().at(-1),identity:{secUid:anchor.secUid,sourceUidNamespace:'sec_uid-or-numeric-uid'},
  reportedHasMore:receipt.data.has_more,coverage:'limited',dailyPublicationCountConfirmed:false,
  posts:posts.map(p=>p.raw),runtimeAI:false,automaticCollectionEnabled:false}};
}

export function recordRemoteWorkPage(db, {targetId,receipt}, {now=Date.now(),sourceOrigin='https://demo.douyin.wtf'}={}) {
 if(!Number.isSafeInteger(targetId)||targetId<1)fail();
 let started=false;
 try{
  db.exec('BEGIN IMMEDIATE');started=true;
  const anchor=readWorksOnlyAnchor(db,targetId,{now});
  const {posts,postTimes,evidence}=normalizeRemoteWorkPage(receipt,anchor,{now,sourceOrigin});
  const key=checksum([evidence.source,evidence.requestId]);
  const sourceChecksum=checksum(evidence);
  const previous=db.prepare("SELECT source_checksum FROM account_events WHERE target_id=? AND event_type='remote-work-observation' AND event_key=?").get(targetId,key);
  if(previous){
   if(previous.source_checksum!==sourceChecksum)fail();
   db.exec('COMMIT');return {duplicate:true,postCount:posts.length,coverage:'limited'};
  }
  const target=db.prepare('SELECT * FROM targets WHERE id=?').get(targetId);
  assertPostHistoryIdentity(db,target,posts,anchor.secUid);
  persistPosts(db,{target,posts,expectedAuthorId:anchor.secUid,capturedAt:evidence.observedAt,postTimes});
  db.prepare(`INSERT INTO account_events(target_id,run_id,event_type,event_key,observed_at,source_checksum,event_json,raw_json,created_at)
   VALUES(?,NULL,'remote-work-observation',?,?,?,?,?,?)`).run(targetId,key,evidence.observedAt,sourceChecksum,
    JSON.stringify({...evidence,anchorSnapshotId:anchor.snapshotId,anchorChecksum:anchor.sourceChecksum}),JSON.stringify(evidence),new Date(now).toISOString());
  db.exec('COMMIT');return {duplicate:false,postCount:posts.length,observedAt:evidence.observedAt,coverage:'limited'};
 }catch(error){if(started)db.exec('ROLLBACK');throw error;}
}
