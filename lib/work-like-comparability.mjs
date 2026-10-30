// Daily readiness, not a platform completeness verdict. No network or model.
const DAY=86400000;
const platformOf=value=>['douyin','bilibili','xiaohongshu','kuaishou'].includes(value)?value:'unknown';
const count=value=>Number.isSafeInteger(value)&&value>=0;
const stamp=value=>{const ms=typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(ms)?new Date(ms).toISOString():null;};
const day=at=>new Date(Date.parse(at)+8*3600000).toISOString().slice(0,10);

export function summarizeWorkLikeComparability(records,{enabled,asOf}={}){
 const at=stamp(asOf);if(at!==asOf||!Array.isArray(records)||!Array.isArray(enabled))throw Error('invalid daily work comparability input');
 const date=day(at),previousDate=new Date(Date.parse(date+'T00:00:00Z')-DAY).toISOString().slice(0,10);
 const targets=new Map(enabled.filter(t=>t.type==='account').map(t=>[t.id,platformOf(t.platform)]));
 const platforms=new Map([...new Set(targets.values())].map(platform=>[platform,{platform,knownTodayWorks:0,comparableWorks:0,missingBaselineWorks:0,conflictingWorks:0}]));
 const works=new Map();
 for(const row of records){
  const platform=targets.get(row.target_id),capturedAt=stamp(row.captured_at);
  if(!platform||!capturedAt||capturedAt>at||!count(row.likes)||typeof row.external_id!=='string'||!row.external_id)continue;
  const dateKey=day(capturedAt);if(dateKey!==date&&dateKey!==previousDate)continue;
  // One platform/work ID is one work even if a historical account copy exists.
  const key=JSON.stringify([platform,row.external_id]);let work=works.get(key);
  if(!work){work={platform,days:new Map()};works.set(key,work);}
  const old=work.days.get(dateKey);
  if(!old||capturedAt>old.at)work.days.set(dateKey,{at:capturedAt,values:new Set([row.likes])});
  else if(capturedAt===old.at)old.values.add(row.likes);
 }
 for(const work of works.values()){
  const row=platforms.get(work.platform),current=work.days.get(date),baseline=work.days.get(previousDate);
  if(!current)continue;
  if(current.values.size!==1){row.conflictingWorks++;continue;}
  row.knownTodayWorks++;
  if(baseline?.values.size===1)row.comparableWorks++;
  else row.missingBaselineWorks++;
 }
 return {version:1,previousDate,platforms:[...platforms.values()]};
}

export function readWorkLikeComparability(db,enabled,now){
 const at=stamp(now);if(at!==now)throw Error('invalid daily comparability clock');
 const date=day(at),start=new Date(Date.parse(date+'T00:00:00Z')-DAY-8*3600000).toISOString();
 // A two-day scan only. Missing, malformed, future and paused-target records
 // cannot turn into a successful daily baseline. No raw values leave the model.
 const rows=db.prepare(`SELECT p.target_id,p.external_id,m.captured_at,m.likes
   FROM post_metrics m JOIN posts p ON p.id=m.post_id JOIN targets t ON t.id=p.target_id
   WHERE t.type='account' AND t.enabled=1 AND p.external_id<>''
     AND julianday(p.first_seen_at)<=julianday(?) AND m.captured_at>=?
     AND julianday(m.captured_at)>=julianday(?) AND julianday(m.captured_at)<=julianday(?)
     AND typeof(m.likes)='integer' AND m.likes>=0 AND m.likes<=9007199254740991
   GROUP BY p.target_id,p.external_id,m.captured_at,m.likes`).all(now,start.slice(0,10),start,now);
 return summarizeWorkLikeComparability(rows,{enabled,asOf:now});
}
