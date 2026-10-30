// One work, one value per metric. A source is evidence, never a new addend.
import { metricInstant } from './work-metric-clock.mjs';
const known=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
export const workOwnerKey=value=>typeof value==='string'?value.trim().normalize('NFKC').toLowerCase():'';
export function workMetricInstant(value){
 return metricInstant(value);
}
export function indexWorkObservations(rows,asOf){
 const cutoff=workMetricInstant(asOf);if(!Array.isArray(rows)||rows.length&&!cutoff)throw Error('作品观测截止时间无效');
 const index=new Map();
 for(const row of rows){
  const basis=['metric-observation','submission-time'].includes(row.timeBasis)?row.timeBasis:'unknown';
  const at=basis==='metric-observation'?workMetricInstant(row.observedAt):null;
  const recordedAt=workMetricInstant(row.recordedAt)||workMetricInstant(row.observedAt),owner=workOwnerKey(row.douyinId),id=row.contentId;
  if(typeof id!=='string'||!/^\d{1,25}$/.test(id)||!owner||basis==='metric-observation'&&!at
    ||(at||recordedAt)&&Date.parse(at||recordedAt)>Date.parse(cutoff))continue;
  const items=index.get(id)||[];items.push({owner,likes:known(row.likes),plays:known(row.plays),observedAt:at,
   recordedAt,timeBasis:basis,sourceRow:row.sourceRow??null});index.set(id,items);
 }
 return index;
}
export function observationsForWork(index,contentId,owners){
 const keys=new Set(owners.map(workOwnerKey).filter(Boolean));
 return (index.get(contentId)||[]).filter(row=>keys.has(row.owner));
}
function lastPoint(points){
 if(!points.length)return null;
 const newest=Math.max(...points.map(p=>Date.parse(p.observedAt))),at=points.filter(p=>Date.parse(p.observedAt)===newest);
 const values=new Set(at.map(p=>p.value));
 const conflict=at.some(p=>p.conflict===true)||values.size>1;
 // A same-time conflict cannot be resolved by choosing the largest counter.
 return {value:conflict?null:at[0].value,origin:conflict?'conflict':(at.find(p=>p.origin==='platform')||at[0]).origin,
  observedAt:new Date(newest).toISOString(),conflict,sourceRows:[...new Set(at.filter(p=>p.origin==='source-observation').map(p=>p.sourceRow).filter(row=>row!=null))]};
}
export function adoptWorkMetric({metric,sourceValue,platformValue,platformObservedAt,platformConflict=false,platformMayBePlaceholder=false,observations=[],asOf}){
 if(!['likes','plays'].includes(metric))throw Error('作品指标类型无效');
 const source=known(sourceValue),platform=known(platformValue),at=workMetricInstant(platformObservedAt),cutoff=asOf==null?null:workMetricInstant(asOf);
 if(asOf!=null&&!cutoff)throw Error('作品观测截止时间无效');
 const sourcePoints=observations.filter(row=>row.timeBasis==='metric-observation'&&known(row[metric])!==null&&workMetricInstant(row.observedAt)
  &&(!cutoff||Date.parse(row.observedAt)<=Date.parse(cutoff)))
  .map(row=>({value:row[metric],observedAt:row.observedAt,origin:'source-observation',sourceRow:row.sourceRow}));
 const records=observations.filter(row=>row.timeBasis!=='metric-observation'&&known(row[metric])!==null);
 const recordValues=new Set(records.map(row=>row[metric]));
 const recordValue=recordValues.size===1?[...recordValues][0]:null;
 const reference=source??recordValue;
 const conflictAt=platformConflict===true&&at&&(!cutoff||Date.parse(at)<=Date.parse(cutoff));
 const platformUsable=!conflictAt&&platform!==null&&!platformMayBePlaceholder&&(!at?reference===null:!cutoff||Date.parse(at)<=Date.parse(cutoff));
 const points=[...sourcePoints,...(conflictAt?[{value:null,observedAt:at,origin:'platform',conflict:true}]
  :platformUsable&&at?[{value:platform,observedAt:at,origin:'platform'}]:[])];
 const picked=lastPoint(points),sourcePoint=lastPoint(sourcePoints);
 const recordConflict=source===null&&recordValues.size>1;
 return {...(picked||{value:reference!==null?reference:platformUsable?platform:null,
  origin:source!==null?'source':recordValue!==null?'source-record':platformUsable?'platform':recordConflict?'conflict':'unavailable',
  observedAt:null,conflict:!platformUsable&&recordConflict,sourceRows:[]}),
  sourceRecordValue:recordValue,sourceRecordCount:records.length,
  sourceRecordedAt:records.map(row=>row.recordedAt).filter(Boolean).sort().at(-1)||null,
  sourceTimeBasis:records.length&&records.every(row=>row.timeBasis==='submission-time')?'submission-time':'unknown',
  sourceObservationValue:sourcePoint?.value??null,sourceObservedAt:sourcePoint?.observedAt??null,sourceObservationConflict:sourcePoint?.conflict??false,
  platformUsable:!!(platformUsable&&(!picked||picked.origin==='platform'))};
}
export function summarizeAdoptedWorks(rows){
 const ids=new Set(),state={likes:{sum:0n,known:0,conflicts:0},plays:{sum:0n,known:0,conflicts:0}};
 for(const row of rows){
  const id=String(row.externalId??row.contentId??'');if(!id||ids.has(id))throw Error('作品汇总存在重复或缺失 ID');ids.add(id);
  for(const metric of ['likes','plays']){
   const value=known(row[metric==='likes'?'adoptedLikes':'adoptedPlays']);
   if(value!==null){state[metric].sum+=BigInt(value);state[metric].known++;}
   if(row[metric+'Origin']==='conflict')state[metric].conflicts++;
  }
 }
 return Object.fromEntries([['works',ids.size],...['likes','plays'].map(metric=>{
  const s=state[metric],overflow=s.sum>BigInt(Number.MAX_SAFE_INTEGER);
  return [metric,{value:s.known&&!overflow?Number(s.sum):null,known:s.known,missing:ids.size-s.known,conflicts:s.conflicts,overflow}];
 })]);
}
