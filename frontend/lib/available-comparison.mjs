import {fields,rowsFor,validDate} from './replica-model.mjs';

const popcount=value=>{value-=value>>>1&0x55555555;value=(value&0x33333333)+(value>>>2&0x33333333);return ((value+(value>>>4)&0x0f0f0f0f)*0x01010101)>>>24;};
/** Suggest, never substitute, a real common endpoint pair from already loaded
 * days. No reads, interpolation, carried values or invented start-day history.
 * A bounded bitset intersection avoids an account scan for every date pair. */
export function availableComparison(accounts,points,start,end){
 if(!validDate(start)||!validDate(end)||start>end)return null;
 rowsFor(accounts,points,start,end); // Shared timestamp, counter and duplicate-day validation.
 const enabled=accounts.filter(a=>a.enabled),ids=new Map(enabled.map((a,i)=>[a.id,i]));
 if(ids.size!==enabled.length)throw Error('重复的比较账号');
 const days=new Map(),size=Math.ceil(ids.size/32);
 for(const p of points){
  const i=ids.get(p.targetId);
  if(i===undefined||p.date<start||p.date>end||fields.some(k=>p[k]==null))continue;
  if(!days.has(p.date))days.set(p.date,new Uint32Array(size));
  days.get(p.date)[i>>>5]|=1<<(i&31);
 }
 // The range reader loads at most 90 consecutive trend days and endpoints.
 // A suggestion is explicitly limited to these checked days, not all history.
 const dates=[...days.keys()].sort().slice(-92);let best=null;
 for(let e=dates.length-1;e>0;e--)for(let b=0;b<e;b++){
  let count=0;const left=days.get(dates[b]),right=days.get(dates[e]);
  for(let i=0;i<size;i++)count+=popcount(left[i]&right[i]);
  if(count&&(!best||count>best.count))best={start:dates[b],end:dates[e],count,total:ids.size};
 }
 return best&&!(best.start===start&&best.end===end)?best:null;
}
