// Coverage of accepted local HTTP receipts, not a new platform request or a
// completeness verdict. A receipt without its matching saved vectors is not
// counted. Iterate a bounded time window; never load the whole metrics table.
import {checksum} from './utils.mjs';

const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const instant=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const count=x=>Number.isSafeInteger(x)&&x>=0;

// The coverage summary and historical metadata share this exact admission
// proof. Yield every validated page: keeping only the latest page per target
// would lose the evidence for an earlier metric observation.
export function* readVerifiedRemoteWorkPages(db,{since,now,targetIds=null,anchorSnapshotMaxId=null,includeDisabled=false}){
 if(!instant(since)||!instant(now)||since>now)throw Error('invalid remote coverage window');
 if(targetIds!==null&&(!Array.isArray(targetIds)||targetIds.length>20_000
  ||targetIds.some(id=>!Number.isSafeInteger(id)||id<1)||new Set(targetIds).size!==targetIds.length))throw Error('invalid remote target scope');
 if(anchorSnapshotMaxId!==null&&(!Number.isSafeInteger(anchorSnapshotMaxId)||anchorSnapshotMaxId<0))throw Error('invalid remote snapshot cap');
 if(typeof includeDisabled!=='boolean')throw Error('invalid remote target state');
 if(targetIds?.length===0)return;
 const required={account_events:['target_id','run_id','event_type','event_key','observed_at','source_checksum','raw_json','event_json','created_at'],
  targets:['id','type','provider','enabled','locator','metadata_json'],posts:['id','target_id','external_id','author_id'],
  post_metrics:['post_id','captured_at','likes','comments','shares','collects','plays'],
  snapshots:['id','target_id','raw_json','captured_at','source_checksum','quality_status','account_status'],
  audits:['target_id','source_checksum','provider','status','created_at']};
 for(const [table,names]of Object.entries(required)){
  const columns=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(x=>x.name));
  if(names.some(name=>!columns.has(name)))return [];
 }
 const metrics=db.prepare(`SELECT p.external_id,m.captured_at,m.likes,m.comments,m.shares,m.collects,m.plays
  FROM posts p JOIN post_metrics m ON m.post_id=p.id WHERE p.target_id=? AND p.author_id=?
   AND p.external_id IN(SELECT value FROM json_each(?)) AND m.captured_at>=? AND m.captured_at<=?`);
 const anchors=db.prepare(`SELECT s.raw_json,s.captured_at FROM snapshots s
  WHERE s.id=? AND s.target_id=? AND s.source_checksum=? AND s.quality_status IN('validated','warning')
   AND s.account_status IN('available','partial') AND EXISTS(SELECT 1 FROM audits a WHERE a.target_id=s.target_id
    AND a.source_checksum=s.source_checksum AND a.provider='public-web' AND a.status IN('validated','warning')
    AND julianday(a.created_at)>=julianday(s.captured_at) AND julianday(a.created_at)<=julianday(?))`);
 const hasAttempts=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='remote_work_attempts'").get());
 const attemptById=hasAttempts?db.prepare('SELECT * FROM remote_work_attempts WHERE id=?'):null;
 const rows=db.prepare(`SELECT e.*,t.locator,t.metadata_json FROM account_events e JOIN targets t ON t.id=e.target_id
  WHERE e.event_type='remote-work-observation' AND e.run_id IS NULL AND t.type='account'
   ${includeDisabled?'':'AND t.enabled=1'} AND t.provider='public-web'
   ${targetIds===null?'':'AND e.target_id IN(SELECT value FROM json_each(?))'}
   AND e.observed_at>=? AND e.observed_at<=? AND julianday(e.observed_at)<=julianday(e.created_at)
   AND julianday(e.created_at)<=julianday(?) ORDER BY e.observed_at,e.id`).iterate(...(targetIds===null?[]:[JSON.stringify(targetIds)]),since,now,now);
 for(const row of rows){
  try{
   const e=JSON.parse(row.raw_json),event=JSON.parse(row.event_json),metadata=JSON.parse(row.metadata_json||'{}');
   if(!object(e)||!object(event)||!object(metadata)||!Number.isSafeInteger(row.target_id)||row.target_id<1
    ||(metadata.platform!=null&&metadata.platform!=='douyin')||checksum(e)!==row.source_checksum
    ||!Number.isSafeInteger(event.anchorSnapshotId)||event.anchorSnapshotId<1||!/^[a-f\d]{64}$/.test(event.anchorChecksum)
    ||(anchorSnapshotMaxId!==null&&event.anchorSnapshotId>anchorSnapshotMaxId))continue;
   const {anchorSnapshotId,anchorChecksum,...facts}=event;
   const manual=e.version===1&&e.automaticCollectionEnabled===false&&!Object.hasOwn(e,'execution');
   const automatic=e.version===2&&e.automaticCollectionEnabled===true&&object(e.execution);
   if(!manual&&!automatic)continue;
   if(automatic){
    const a=typeof e.execution.attemptId==='string'?attemptById?.get(e.execution.attemptId):null;
    if(!a||a.status!=='success'||a.target_id!==row.target_id||a.source!==e.source||a.event_key!==row.event_key
     ||a.started_at!==e.execution.startedAt||a.day!==e.execution.day||!instant(a.started_at)||!instant(a.finished_at)
     ||a.started_at>e.requestStartedAt||a.finished_at!==row.created_at||a.post_count!==e.posts?.length
     ||!Number.isSafeInteger(a.request_count)||a.request_count<1||a.request_count>4||a.error_code!==null)continue;
   }
   if(checksum(facts)!==row.source_checksum||e.kind!=='remote-http-work-observation'
    ||e.coverage!=='limited'||e.dailyPublicationCountConfirmed!==false||e.runtimeAI!==false
    ||e.endpoint!=='douyin.author_posts'||typeof e.requestId!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(e.requestId)
    ||checksum([e.source,e.requestId])!==row.event_key||!/^MS4wLj[\w-]{12,220}$/.test(row.locator)
    ||e.identity?.secUid!==row.locator||!instant(e.requestStartedAt)||!instant(e.requestFinishedAt)
    ||e.requestStartedAt>e.requestFinishedAt||Date.parse(e.requestFinishedAt)-Date.parse(e.requestStartedAt)>60_000
    ||!instant(row.created_at)||e.requestFinishedAt>row.created_at||!instant(e.observedAt)||e.observedAt!==row.observed_at
    ||!Array.isArray(e.posts)||e.posts.length<1||e.posts.length>100)continue;
   const url=new URL(e.source);
   if(url.protocol!=='https:'||url.username||url.password||url.port||url.origin!==e.source)continue;
   const anchor=anchors.get(anchorSnapshotId,row.target_id,anchorChecksum,row.created_at);
   if(!anchor||!instant(anchor.captured_at)||anchor.captured_at>row.created_at
    ||Date.parse(row.created_at)-Date.parse(anchor.captured_at)>8*3600_000)continue;
   const profile=JSON.parse(anchor.raw_json);
   if(checksum(profile)!==anchorChecksum||profile.profile?.user?.sec_uid!==row.locator
    ||typeof profile.profile.user.uid!=='string'||!/^[1-9]\d{1,24}$/.test(profile.profile.user.uid))continue;
   const expected=new Map();let valid=true;
   for(const p of e.posts){
    const s=p?.sourceObservation,at=s?.fetchedAt;
    if(typeof p?.content_id!=='string'||!/^\d{15,25}$/.test(p.content_id)||expected.has(p.content_id)
     ||p.author?.sec_uid!==row.locator||(p.author.uid!==row.locator&&p.author.uid!==profile.profile.user.uid)
     ||!object(p.stats)||!count(p.stats.digg_count)||p.stats.play_count!==null
     ||!instant(at)||at<e.requestStartedAt||at>e.requestFinishedAt
     ||s.source!==e.source||s.endpoint!==e.endpoint||s.requestId!==e.requestId||s.plays_source!=='unavailable'
     ||['comment_count','share_count','collect_count'].some(k=>p.stats[k]!==null&&!count(p.stats[k]))){valid=false;break;}
    expected.set(p.content_id,{at,vector:[p.stats.digg_count,p.stats.comment_count,p.stats.share_count,p.stats.collect_count,null]});
   }
   if(!valid||[...expected.values()].map(x=>x.at).sort().at(-1)!==e.observedAt)continue;
   const found=new Set();
   for(const m of metrics.iterate(row.target_id,row.locator,JSON.stringify([...expected.keys()]),e.requestStartedAt,e.requestFinishedAt)){
    const p=expected.get(m.external_id);
    if(m.captured_at===p.at&&[m.likes,m.comments,m.shares,m.collects,m.plays].every((v,i)=>v===p.vector[i]))found.add(m.external_id);
   }
   if(found.size!==expected.size)continue;
   yield {targetId:row.target_id,observedAt:e.observedAt,coverage:'limited',posts:e.posts,
    identity:{secUid:row.locator,uid:profile.profile.user.uid}};
  }catch{ /* Malformed or incomplete local evidence cannot claim coverage. */ }
 }
}

export function readRemoteWorkCoverage(db,{since,now}){
 const accepted=new Map();
 for(const row of readVerifiedRemoteWorkPages(db,{since,now}))
  accepted.set(row.targetId,{targetId:row.targetId,observedAt:row.observedAt,coverage:row.coverage});
 return [...accepted.values()];
}
