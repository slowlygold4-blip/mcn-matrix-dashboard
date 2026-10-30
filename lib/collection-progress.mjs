// Compact, read-only telemetry. No network, browser, model, or raw provider data.
import { enabledCollectionTargets, platformRollingProgress, dailyStoredWorkLikes, committedProfileProgress } from './collection-platform-progress.mjs';
import {dailyProfileCoverage} from './profile-daily-coverage.mjs';
const count=v=>Math.max(0,Number(v)||0);
const WORK_ERROR_CODES=new Set(['blocked','rate_limited','login_required','network_error','business_error','upstream_changed','collector_error','unknown']);
const DIAGNOSTIC_REASONS=new Set(['page-obstruction','no-bound-request','deadline','http-rejection']);
// Normal account runs keep works failure separate from profile success.
// Return fixed codes only: stored messages or arbitrary codes are not telemetry.
function worksIssue(detail){
 const code=detail.worksErrorCode??detail.errorCode;
 if(!code)return null;
 if(code==='deferred')return 'transport-cooldown';
 if(detail.failureDiagnostics?.continuationActivation?.structure?.reason==='visible-gate')return 'page-obstruction';
 const reason=detail.failureDiagnostics?.stopReason;
 return DIAGNOSTIC_REASONS.has(reason)?reason:WORK_ERROR_CODES.has(code)?code:'unknown';
}
export function collectionProgress(db,{now=new Date().toISOString()}={}) {
 const row=db.prepare(`SELECT id,trigger_type,started_at,finished_at,status,target_count,processed_count,
 success_count,error_count,warning_count,skipped_count,heartbeat_at,current_target_id FROM runs
 WHERE julianday(started_at)<=julianday(?) AND (finished_at IS NULL OR (julianday(finished_at)>=julianday(started_at) AND julianday(finished_at)<=julianday(?)))
 ORDER BY (status='running') DESC,id DESC LIMIT 1`).get(now,now);
 const name=row?.current_target_id?db.prepare('SELECT label FROM targets WHERE id=?').get(row.current_target_id)?.label:null;
 const latest=db.prepare("SELECT id,finished_at,target_count,details_json FROM runs WHERE finished_at IS NOT NULL AND target_count>1 AND julianday(started_at)<=julianday(?) AND julianday(finished_at)>=julianday(started_at) AND julianday(finished_at)<=julianday(?) ORDER BY id DESC LIMIT 1").get(now,now);
 let details=[];try{const value=JSON.parse(latest?.details_json||'[]');if(Array.isArray(value))details=value.filter(d=>d&&typeof d==='object');}catch{}
 const queue=Object.fromEntries(db.prepare('SELECT status,COUNT(*) n FROM author_resolution_queue GROUP BY status').all().map(r=>[r.status,r.n]));
 const enabled=enabledCollectionTargets(db);
 const enabledIds=new Set(enabled.map(t=>t.id));
 const accountIds=new Set(enabled.filter(t=>t.type==='account').map(t=>t.id));
 const topicIds=new Set(enabled.filter(t=>t.type==='hashtag').map(t=>t.id));
 const since=new Date(Date.parse(now)-86400000).toISOString();
 const attempts=new Set(),profiles=new Set(),topicsSeen=new Set(),works=new Map(),failures=new Map();
 const recent=db.prepare("SELECT id,details_json FROM runs WHERE started_at>=? AND julianday(started_at)>=julianday(?) AND julianday(started_at)<=julianday(?) AND (finished_at IS NULL OR (julianday(finished_at)>=julianday(started_at) AND julianday(finished_at)<=julianday(?))) ORDER BY id").all(since.slice(0,10),since,now,now);
 for(const record of recent){let items=[];try{const value=JSON.parse(record.details_json||'[]');if(Array.isArray(value))items=value;}catch{}
  for(const d of items){if(!d||!enabledIds.has(d.targetId))continue;attempts.add(d.targetId);
   if(d.topicMetricsUsable===true&&topicIds.has(d.targetId))topicsSeen.add(d.targetId);
   const coverage=d.worksCoverage??d.coverage;if(accountIds.has(d.targetId)&&coverage&&(d.mode==='works-only'||['complete','limited','latest-public-window'].includes(coverage)))works.set(d.targetId,coverage);
   const issue=accountIds.has(d.targetId)?worksIssue(d):null;
   if(issue)failures.set(d.targetId,issue);
   else if(['complete','limited','latest-public-window'].includes(coverage))failures.delete(d.targetId);
  }
 }
 // A long batch flushes details_json on completion, but each accepted snapshot
 // and its audit are already committed atomically. Include that durable proof
 // during the batch rather than reporting zero topics/old profile coverage for
 // hours. Counter progress alone is not evidence of usable account metrics.
 if(row?.status==='running'){
  const live=db.prepare(`SELECT DISTINCT s.target_id,t.type,s.account_status,
   s.followers,s.total_likes,s.total_posts,s.hashtag_participants,s.hashtag_views,
   s.works_coverage,s.works_observed_at
   FROM audits a JOIN snapshots s ON s.target_id=a.target_id AND s.source_checksum=a.source_checksum
   JOIN targets t ON t.id=s.target_id
   WHERE a.run_id=? AND t.enabled=1 AND a.status IN ('validated','warning')
    AND s.quality_status IN ('validated','warning')
    AND s.captured_at>=? AND s.captured_at>=? AND s.captured_at<=?`)
   .all(row.id,since,row.started_at,now);
  const metric=v=>Number.isSafeInteger(v)&&v>=0;
  for(const s of live){
   attempts.add(s.target_id);
   if(s.type==='hashtag'&&[s.hashtag_participants,s.hashtag_views].every(metric))topicsSeen.add(s.target_id);
   if(s.type==='account'&&['complete','limited','latest-public-window'].includes(s.works_coverage)
    &&s.works_observed_at>=since&&s.works_observed_at<=now)works.set(s.target_id,s.works_coverage);
  }
 }
 const profileProof=committedProfileProgress(db,{runIds:[...recent.map(run=>run.id),...(row?.status==='running'?[row.id]:[])],since,now,latestRunId:latest?.id});
 for(const id of profileProof.rolling)profiles.add(id);
 const reasons=Object.entries([...failures.values()].reduce((acc,key)=>(acc[key]=(acc[key]||0)+1,acc),{})).map(([code,count])=>({code,count})).sort((a,b)=>b.count-a.count).slice(0,5);
 const rolling={since,total:enabled.length,attempted:attempts.size,profileTotal:enabled.filter(t=>t.type==='account').length,profiles:profiles.size,topics:topicsSeen.size,
  updated:profiles.size+topicsSeen.size,notUpdated:Math.max(0,enabled.length-profiles.size-topicsSeen.size),
  worksComplete:[...works.values()].filter(v=>v==='complete').length,worksLimited:[...works.values()].filter(v=>['limited','latest-public-window'].includes(v)).length,
  workIssues:failures.size,reasons,platforms:platformRollingProgress(enabled,{profiles,works,failures})};
 const targets=db.prepare("SELECT SUM(CASE WHEN enabled=1 AND type<>'hashtag' THEN 1 ELSE 0 END) accounts,SUM(CASE WHEN enabled=1 AND type='hashtag' THEN 1 ELSE 0 END) topics FROM targets").get();
 return {version:1,observedAt:now,runtimeAI:false,scope:'all',accounts:count(targets.accounts),topics:count(targets.topics),
 rolling,dailyWorkLikes:dailyStoredWorkLikes(db,enabled,now),dailyProfiles:dailyProfileCoverage(db,enabled,now),
 queue:{pending:count(queue.pending)+count(queue.retry),resolved:count(queue.resolved),rejected:count(queue.rejected)},
 run:row?{id:row.id,status:row.status,kind:row.trigger_type,startedAt:row.started_at,finishedAt:row.finished_at,
 heartbeatAt:row.heartbeat_at,total:count(row.target_count),processed:count(row.processed_count),success:count(row.success_count),
 failed:count(row.error_count),warnings:count(row.warning_count),skipped:count(row.skipped_count),current:name?String(name).slice(0,120):null}:null,
 coverage:latest?{runId:latest.id,finishedAt:latest.finished_at,total:latest.target_count,
 profiles:profileProof.latest.size,worksComplete:details.filter(d=>d.worksCoverage==='complete').length,
 worksLimited:details.filter(d=>['limited','latest-public-window'].includes(d.worksCoverage)).length,
 topics:details.filter(d=>d.topicMetricsUsable===true).length}:null};
}
