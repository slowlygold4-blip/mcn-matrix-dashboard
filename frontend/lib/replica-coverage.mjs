const fields=['followers','likes','posts'];
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));
const timestamp=(s,cutoff)=>typeof s==='string'&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===s&&Date.parse(s)<=Date.parse(cutoff);
const fresh=(s,now)=>s!==null&&Date.parse(s)<=now&&now-Date.parse(s)<=8*3600000;
export function validCoverage(c,asOf){
 return exact(c,['version','profileObservedAt','works'])&&c.version===1
  &&(c.profileObservedAt===null||timestamp(c.profileObservedAt,asOf))
  &&exact(c.works,['status','attemptedAt','observedAt'])
  &&['complete','limited','unavailable','missing'].includes(c.works.status)
  &&['attemptedAt','observedAt'].every(k=>c.works[k]===null||timestamp(c.works[k],asOf))
  &&(!['complete','limited'].includes(c.works.status)||(c.works.observedAt!==null&&c.works.attemptedAt!==null))
  &&(c.works.status!=='missing'||(c.works.observedAt===null&&c.works.attemptedAt===null))
  &&(c.works.attemptedAt===null||c.works.observedAt===null||Date.parse(c.works.observedAt)<=Date.parse(c.works.attemptedAt));
}
export function accountCoverage(account,asOf,now=Date.now()){
 if(!timestamp(asOf,asOf)||!Number.isFinite(now))throw Error('覆盖统计时刻无效');
 const c=account.coverage;if(c!==undefined&&!validCoverage(c,asOf))throw Error('账号覆盖证据无效，已停止显示');
 const vector=fields.map(k=>account.latest?.[k]);
 const legacy=vector.every(m=>Number.isSafeInteger(m?.value)&&m.value>=0&&timestamp(m.observedAt,asOf)&&/^[a-f0-9]{64}$/.test(m.sourceChecksum))
  &&new Set(vector.map(m=>m.observedAt)).size===1&&new Set(vector.map(m=>m.sourceChecksum)).size===1?vector[0].observedAt:null;
 const profileObservedAt=c?c.profileObservedAt:legacy;
 const works=c?.works??{status:'unknown',attemptedAt:null,observedAt:null};
 const worksFresh=fresh(works.observedAt,now);
 return {profileObservedAt,profileFresh:fresh(profileObservedAt,now),works,worksFresh,
  worksComplete:works.status==='complete'&&worksFresh,
  worksLimited:works.status==='limited'&&worksFresh,
  worksUnavailableRecent:works.status==='unavailable'&&fresh(works.attemptedAt,now)};
}
export function coverageTotals(accounts,topics,asOf,now=Date.now()){
 const enabled=accounts.filter(a=>a.enabled),rows=enabled.map(a=>({id:a.id,label:a.label,...accountCoverage(a,asOf,now)}));
 const statusCounts={complete:0,limited:0,unavailable:0,missing:0,unknown:0};for(const r of rows)statusCounts[r.works.status]++;
 const activeTopics=topics.topics.filter(t=>t.enabled),topicRows=activeTopics.map(t=>{const p=topics.items.filter(p=>p.targetId===t.id).sort((a,b)=>String(b.capturedAt).localeCompare(String(a.capturedAt)))[0];
  const verified=p?.metricsEvidence==='topic-identity-source-run-time-vector-bound'&&['validated','warning'].includes(p.qualityStatus)
   &&Number.isSafeInteger(p.participants)&&p.participants>=0&&Number.isSafeInteger(p.views)&&p.views>=0&&timestamp(p.capturedAt,asOf)&&/^[a-f0-9]{64}$/.test(p.sourceChecksum);
  return {id:t.id,label:t.label,observedAt:verified?p.capturedAt:null,fresh:verified&&fresh(p.capturedAt,now)};});
 return {denominator:rows.length,profileFresh:rows.filter(r=>r.profileFresh).length,
  worksComplete:rows.filter(r=>r.worksComplete).length,
  worksLimited:rows.filter(r=>r.worksLimited).length,
  worksUnavailableRecent:rows.filter(r=>r.worksUnavailableRecent).length,
  statusCounts,rows,topicDenominator:topicRows.length,topicsFresh:topicRows.filter(r=>r.fresh).length,topicRows};
}
