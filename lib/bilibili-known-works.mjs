// A bounded list of this account's already-stored public works. This is not
// an inventory or a claim about new publications. The HTTP reply must still
// independently bind both the requested BV and the expected author UID.
import {canonicalAccountLocator} from './author-spreadsheet.mjs';
import {businessDateKey,checksum} from './utils.mjs';
import {normalizeCollection} from './providers/normalize.mjs';
import {bilibiliWorkObservation} from './bilibili-work-observation.mjs';
export const BILIBILI_KNOWN_WORK_LIMIT=6;
export const KNOWN_WORK_REFRESH_DELAY_MS=15*60_000;

// /x/web-interface/view only: -404 is no video, 62002 invisible, 62012
// owner-only. Skip that item without retrying it today; do not treat it as
// an account-wide refusal. Unknown codes and HTTP/auth/rate refusals stop.
// Source: https://minisheeep.github.io/bilibili-API-collect/docs/video/info.html
const BILIBILI_UNAVAILABLE_DETAIL_CODES=new Set([-404,62002,62012]);
function detailStopsDailyLane(error,attemptedIds){
 // Explicit authorization/rate refusals outrank a misclassified diagnostic.
 if([401,403,429].includes(error?.httpStatus))return true;
 if(error?.errorCode==='business_error'){
  return !(error.httpStatus==null&&Number.isInteger(error.businessCode)
   &&BILIBILI_UNAVAILABLE_DETAIL_CODES.has(error.businessCode)
   &&attemptedIds.includes(error.contentId));
 }
 return ['blocked','rate_limited','login_required'].includes(error?.errorCode);
}

function retryableNetworkFailure(raw,id){
 const details=raw.workDetailEvidence,attempted=raw.knownWorksEvidence.attemptedIds;
 // Retry only an explicit item failure in the saved detail receipt. A list
 // failure, omitted reason, business/identity refusal or HTTP 4xx cannot opt
 // into this allowance by merely lacking a successful metric.
 if(details?.version!==1||!Array.isArray(details.errors)||details.errors.length>BILIBILI_KNOWN_WORK_LIMIT
  ||details.errors.some(error=>!attempted.includes(error?.contentId))
  ||new Set(details.errors.map(error=>error.contentId)).size!==details.errors.length
  ||details.requestedCount!==attempted.length||!Number.isSafeInteger(details.failedCount)
  ||details.failedCount!==details.errors.length||!Number.isSafeInteger(details.successfulCount)
  ||details.successfulCount<0||details.successfulCount+details.failedCount!==details.requestedCount)return false;
 const errors=details.errors.filter(error=>error?.contentId===id);
 return errors.length===1&&errors[0].errorCode==='network_error'&&errors[0].businessCode===null
  &&(errors[0].httpStatus===null||(Number.isSafeInteger(errors[0].httpStatus)&&errors[0].httpStatus>=500&&errors[0].httpStatus<=599));
}

// Successes and non-transient failures settle a work for this Beijing day.
// One explicit network failure may use one later slot, after unattempted
// works. Counts come from durable verified receipts, never process memory.
export function bilibiliKnownWorkDailyState(database,target,{asOf=new Date().toISOString()}={}){
 const db=database?.db??database;
 const empty={pendingIds:[],blocked:false,lastAttemptAt:null};
 if(!db?.prepare||!Number.isSafeInteger(target?.id)||!Number.isFinite(Date.parse(asOf)))return empty;
 const canonical=canonicalAccountLocator(target.locator,'bilibili');
 if(!canonical?.startsWith('bilibili:'))return empty;
 const mid=canonical.slice(9),day=businessDateKey(asOf,'Asia/Shanghai');
 const since=new Date(day+'T00:00:00+08:00').toISOString();
 const attempted=new Set(),attemptCounts=new Map(),retryAfter=new Map();let blocked=false,lastAttemptAt=null;
 const snapshots=db.prepare(`SELECT captured_at,raw_json,source_checksum FROM snapshots
  WHERE target_id=? AND quality_status IN('validated','warning')
   AND julianday(captured_at)>=julianday(?) AND julianday(captured_at)<=julianday(?)
  ORDER BY julianday(captured_at),id`).all(target.id,since,asOf);
 for(const row of snapshots)try{
  const raw=JSON.parse(row.raw_json),known=raw.knownWorksEvidence;
  if(checksum(raw)!==row.source_checksum||raw.capturedAt!==row.captured_at
   ||known?.version!==1||known.source!=='stored-account-work-ids'||known.used!==true
   ||!Array.isArray(known.attemptedIds)||known.attemptedIds.length>BILIBILI_KNOWN_WORK_LIMIT
   ||new Set(known.attemptedIds).size!==known.attemptedIds.length
   ||!known.attemptedIds.every(id=>typeof id==='string'&&/^BV[0-9A-Za-z]{10}$/.test(id)))continue;
  const normalized=normalizeCollection(target,raw,{capturedAt:row.captured_at});
  const clock=bilibiliWorkObservation(target,normalized,{reference:Date.parse(asOf)});
  if(!clock)continue;
  for(const id of known.attemptedIds){
   const observed=clock.postTimes.get(id);
   if(observed?observed>=since:raw.workObservationTimes.startedAt>=since){
    attempted.add(id);
    const count=(attemptCounts.get(id)??0)+1;attemptCounts.set(id,count);
    // No response timestamp exists for a failed detail. Use the containing
    // request's verified completion as the conservative cooldown boundary.
    if(count===1&&!observed&&retryableNetworkFailure(raw,id))retryAfter.set(id,Date.parse(row.captured_at)+KNOWN_WORK_REFRESH_DELAY_MS);
    else retryAfter.delete(id);
   }
  }
  lastAttemptAt=row.captured_at;
  if(raw.workObservationTimes.startedAt>=since&&raw.workDetailEvidence?.errors?.some(error=>detailStopsDailyLane(error,known.attemptedIds)))blocked=true;
 }catch{ /* Unverified attempt metadata cannot settle a real work for today. */ }
 if(blocked)return {pendingIds:[],blocked,lastAttemptAt};
 const retryIds=[...retryAfter].filter(([,at])=>at<=Date.parse(asOf)).map(([id])=>id);
 const rows=db.prepare(`SELECT p.external_id FROM posts p JOIN targets t ON t.id=p.target_id
  LEFT JOIN post_metrics m ON m.post_id=p.id AND m.likes IS NOT NULL
   AND julianday(m.captured_at)<=julianday(?)
  WHERE p.target_id=? AND p.author_id=? AND t.enabled=1 AND t.type='account'
   AND t.provider='public-web' AND json_extract(t.metadata_json,'$.platform')='bilibili'
   AND length(p.external_id)=12 AND p.external_id GLOB 'BV*'
   AND p.external_id NOT GLOB '*[^0-9A-Za-z]*'
   AND (p.external_id NOT IN(SELECT value FROM json_each(?))
    OR p.external_id IN(SELECT value FROM json_each(?)))
  GROUP BY p.id HAVING COALESCE(MAX(julianday(m.captured_at)),0)<julianday(?)
  ORDER BY CASE WHEN p.external_id IN(SELECT value FROM json_each(?)) THEN 1 ELSE 0 END,
   COALESCE(MAX(julianday(m.captured_at)),0),p.id LIMIT ?`)
  .all(asOf,target.id,mid,JSON.stringify([...attempted]),JSON.stringify(retryIds),since,JSON.stringify(retryIds),BILIBILI_KNOWN_WORK_LIMIT);
 return {pendingIds:rows.map(row=>row.external_id),blocked,lastAttemptAt};
}

export function knownWorkDailyDueTargetIds(database,targets,now=new Date()){
 const asOf=now.toISOString();
 return targets.filter(target=>{
  if(!target.enabled||target.type!=='account'||target.provider!=='public-web'||target.metadata?.platform!=='bilibili')return false;
  const checked=Date.parse(target.last_checked_at);
  if(Number.isFinite(checked)&&(checked>now.getTime()||now.getTime()-checked<KNOWN_WORK_REFRESH_DELAY_MS))return false;
  return bilibiliKnownWorkDailyState(database,target,{asOf}).pendingIds.length>0;
 }).map(target=>Number(target.id));
}

export function readKnownBilibiliWorks(database,target,mid,{dailyOnly=false,asOf=new Date().toISOString()}={}){
 const db=database?.db??database;
 if(!db?.prepare||!Number.isSafeInteger(target?.id)||!/^\d{2,20}$/.test(mid??'')
  ||canonicalAccountLocator(target.locator,'bilibili')!==`bilibili:${mid}`)return [];
 if(dailyOnly)return bilibiliKnownWorkDailyState(database,target,{asOf}).pendingIds;
 const rows=db.prepare(`WITH attempts AS (
  SELECT j.value external_id,MAX(julianday(s.captured_at)) attempted_at
  FROM snapshots s,json_each(CASE WHEN json_valid(s.raw_json) THEN s.raw_json ELSE '{}' END,'$.knownWorksEvidence.attemptedIds') j
  WHERE s.target_id=? AND s.quality_status IN('validated','warning') AND j.type='text'
   AND julianday(s.captured_at)<=julianday(?)
   AND json_extract(s.raw_json,'$.knownWorksEvidence.version')=1
   AND json_extract(s.raw_json,'$.knownWorksEvidence.source')='stored-account-work-ids'
  GROUP BY j.value)
 SELECT p.external_id,MAX(COALESCE(MAX(julianday(m.captured_at)),0),COALESCE(a.attempted_at,0)) last_checked
  FROM posts p JOIN targets t ON t.id=p.target_id
  LEFT JOIN post_metrics m ON m.post_id=p.id AND m.likes IS NOT NULL
  LEFT JOIN attempts a ON a.external_id=p.external_id
  WHERE p.target_id=? AND p.author_id=? AND t.enabled=1 AND t.type='account'
   AND t.provider='public-web' AND json_extract(t.metadata_json,'$.platform')='bilibili'
   AND length(p.external_id)=12 AND p.external_id GLOB 'BV*'
  GROUP BY p.id ORDER BY last_checked,p.id LIMIT ?`)
  .all(target.id,new Date().toISOString(),target.id,mid,BILIBILI_KNOWN_WORK_LIMIT);
 return rows.map(r=>r.external_id).filter(id=>/^BV[0-9A-Za-z]{10}$/.test(id));
}
