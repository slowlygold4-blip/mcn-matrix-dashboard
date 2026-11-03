// A bounded list of this account's already-stored public works. This is not
// an inventory or a claim about new publications. The HTTP reply must still
// independently bind both the requested BV and the expected author UID.
import {canonicalAccountLocator} from './author-spreadsheet.mjs';
import {businessDateKey,checksum} from './utils.mjs';
import {normalizeCollection} from './providers/normalize.mjs';
import {bilibiliWorkObservation} from './bilibili-work-observation.mjs';
export const BILIBILI_KNOWN_WORK_LIMIT=6;
export const KNOWN_WORK_REFRESH_DELAY_MS=15*60_000;

// Existing public HTTP capability only. A successful stored metric and an
// unsuccessful attempt are distinct, but neither should be requested twice
// during this Beijing day by the automatic known-work lane.
export function bilibiliKnownWorkDailyState(database,target,{asOf=new Date().toISOString()}={}){
 const db=database?.db??database;
 const empty={pendingIds:[],blocked:false,lastAttemptAt:null};
 if(!db?.prepare||!Number.isSafeInteger(target?.id)||!Number.isFinite(Date.parse(asOf)))return empty;
 const canonical=canonicalAccountLocator(target.locator,'bilibili');
 if(!canonical?.startsWith('bilibili:'))return empty;
 const mid=canonical.slice(9),day=businessDateKey(asOf,'Asia/Shanghai');
 const since=new Date(day+'T00:00:00+08:00').toISOString();
 const attempted=new Set();let blocked=false,lastAttemptAt=null;
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
   if(observed?observed>=since:raw.workObservationTimes.startedAt>=since)attempted.add(id);
  }
  lastAttemptAt=row.captured_at;
  if(raw.workObservationTimes.startedAt>=since&&raw.workDetailEvidence?.errors?.some(error=>['blocked','rate_limited','login_required','business_error'].includes(error?.errorCode)))blocked=true;
 }catch{ /* Unverified attempt metadata cannot settle a real work for today. */ }
 if(blocked)return {pendingIds:[],blocked,lastAttemptAt};
 const rows=db.prepare(`SELECT p.external_id FROM posts p JOIN targets t ON t.id=p.target_id
  LEFT JOIN post_metrics m ON m.post_id=p.id AND m.likes IS NOT NULL
   AND julianday(m.captured_at)<=julianday(?)
  WHERE p.target_id=? AND p.author_id=? AND t.enabled=1 AND t.type='account'
   AND t.provider='public-web' AND json_extract(t.metadata_json,'$.platform')='bilibili'
   AND length(p.external_id)=12 AND p.external_id GLOB 'BV*'
   AND p.external_id NOT GLOB '*[^0-9A-Za-z]*'
   AND p.external_id NOT IN(SELECT value FROM json_each(?))
  GROUP BY p.id HAVING COALESCE(MAX(julianday(m.captured_at)),0)<julianday(?)
  ORDER BY COALESCE(MAX(julianday(m.captured_at)),0),p.id LIMIT ?`)
  .all(asOf,target.id,mid,JSON.stringify([...attempted]),since,BILIBILI_KNOWN_WORK_LIMIT);
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
