// Compact, read-only telemetry. No network, browser, model, or raw provider data.
const count=v=>Math.max(0,Number(v)||0);
export function collectionProgress(db,{now=new Date().toISOString()}={}) {
 const row=db.prepare(`SELECT id,trigger_type,started_at,finished_at,status,target_count,processed_count,
 success_count,error_count,warning_count,skipped_count,heartbeat_at,current_target_id FROM runs
 ORDER BY (status='running') DESC,id DESC LIMIT 1`).get();
 const name=row?.current_target_id?db.prepare('SELECT label FROM targets WHERE id=?').get(row.current_target_id)?.label:null;
 const latest=db.prepare("SELECT id,finished_at,target_count,details_json FROM runs WHERE finished_at IS NOT NULL AND target_count>1 ORDER BY id DESC LIMIT 1").get();
 let details=[];try{details=JSON.parse(latest?.details_json||'[]');}catch{}
 const queue=Object.fromEntries(db.prepare('SELECT status,COUNT(*) n FROM author_resolution_queue GROUP BY status').all().map(r=>[r.status,r.n]));
 const enabled=db.prepare("SELECT id,type FROM targets WHERE enabled=1").all();
 const enabledIds=new Set(enabled.map(t=>t.id));
 const since=new Date(Date.parse(now)-86400000).toISOString();
 const attempts=new Set(),profiles=new Set(),topicsSeen=new Set(),works=new Map(),failures=new Map();
 const recent=db.prepare("SELECT id,details_json FROM runs WHERE started_at>=? ORDER BY id").all(since);
 for(const record of recent){let items=[];try{items=JSON.parse(record.details_json||'[]');}catch{}
  for(const d of items){if(!enabledIds.has(d.targetId))continue;attempts.add(d.targetId);
   if(d.profileUsable===true)profiles.add(d.targetId);if(d.topicMetricsUsable===true)topicsSeen.add(d.targetId);
   const coverage=d.worksCoverage??d.coverage;if(coverage&&(d.mode==='works-only'||['complete','limited','latest-public-window'].includes(coverage)))works.set(d.targetId,coverage);
   if(d.errorCode)failures.set(d.targetId,d.failureDiagnostics?.continuationActivation?.structure?.reason==='visible-gate'?'page-obstruction':d.failureDiagnostics?.stopReason??d.errorCode);
   else if(coverage==='complete')failures.delete(d.targetId);
  }
 }
 const reasons=Object.entries([...failures.values()].reduce((acc,key)=>(acc[key]=(acc[key]||0)+1,acc),{})).map(([code,count])=>({code,count})).sort((a,b)=>b.count-a.count).slice(0,5);
 const rolling={since,total:enabled.length,attempted:attempts.size,profileTotal:enabled.filter(t=>t.type==='account').length,profiles:profiles.size,topics:topicsSeen.size,
  updated:profiles.size+topicsSeen.size,notUpdated:Math.max(0,enabled.length-profiles.size-topicsSeen.size),
  worksComplete:[...works.values()].filter(v=>v==='complete').length,worksLimited:[...works.values()].filter(v=>['limited','latest-public-window'].includes(v)).length,
  workIssues:failures.size,reasons};
 const targets=db.prepare("SELECT SUM(CASE WHEN enabled=1 AND type<>'hashtag' THEN 1 ELSE 0 END) accounts,SUM(CASE WHEN enabled=1 AND type='hashtag' THEN 1 ELSE 0 END) topics FROM targets").get();
 return {version:1,observedAt:now,runtimeAI:false,scope:'all',accounts:count(targets.accounts),topics:count(targets.topics),
 rolling,
 queue:{pending:count(queue.pending)+count(queue.retry),resolved:count(queue.resolved),rejected:count(queue.rejected)},
 run:row?{id:row.id,status:row.status,kind:row.trigger_type,startedAt:row.started_at,finishedAt:row.finished_at,
 heartbeatAt:row.heartbeat_at,total:count(row.target_count),processed:count(row.processed_count),success:count(row.success_count),
 failed:count(row.error_count),warnings:count(row.warning_count),skipped:count(row.skipped_count),current:name?String(name).slice(0,120):null}:null,
 coverage:latest?{runId:latest.id,finishedAt:latest.finished_at,total:latest.target_count,
 profiles:details.filter(d=>d.profileUsable===true).length,worksComplete:details.filter(d=>d.worksCoverage==='complete').length,
 worksLimited:details.filter(d=>['limited','latest-public-window'].includes(d.worksCoverage)).length,
 topics:details.filter(d=>d.topicMetricsUsable===true).length}:null};
}
