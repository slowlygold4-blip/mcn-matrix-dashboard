import {rowsFor,validDate} from './replica-model.mjs';
const day=86400000;
function calendar(start,end){if(!validDate(start)||!validDate(end)||start>end)throw Error('无效比较日期');const n=(Date.parse(end)-Date.parse(start))/day+1;if(n>366)throw Error('单条曲线最多366个日点，请缩短范围');return Array.from({length:n},(_,i)=>new Date(Date.parse(start)+i*day).toISOString().slice(0,10));}
/** Each metric uses one fixed endpoint cohort. A missing interior observation breaks the line.
 * @param {Array<object>} accounts
 * @param {Array<object>} points
 * @param {{start:string,end:string,metric?:string,otherStart?:string|null,otherEnd?:string|null,visibleOffset?:number|null,visibleDays?:number}} options
 */
export function growthSeries(accounts,points,{start,end,metric='followers',otherStart=null,otherEnd=null,visibleOffset=null,visibleDays=90}){
 if(!!otherStart!==!!otherEnd)throw Error('请选择比较区间的两个日期');
 if(new Set(accounts.map(a=>a.id)).size!==accounts.length)throw Error('重复账号队列');
 const field=metric==='estimated'?'likes':metric;if(!['followers','likes','posts'].includes(field))throw Error('无效趋势指标');
 const window=(s,e)=>{if(visibleOffset===null)return calendar(s,e);if(!validDate(s)||!validDate(e)||s>e||!Number.isSafeInteger(visibleOffset)||visibleOffset<0||!Number.isSafeInteger(visibleDays)||visibleDays<1||visibleDays>90)throw Error('无效曲线窗口');const n=Math.max(0,Math.min(visibleDays,(Date.parse(e)-Date.parse(s))/day+1-visibleOffset));return Array.from({length:n},(_,i)=>new Date(Date.parse(s)+(i+visibleOffset)*day).toISOString().slice(0,10));};
 const dates=window(start,end),other=otherStart&&otherEnd?window(otherStart,otherEnd):[];
 const rows=rowsFor(accounts,points,start,end),otherRows=otherStart&&otherEnd?new Map(rowsFor(accounts,points,otherStart,otherEnd).map(r=>[r.id,r])):null;
 const cohort=rows.filter(r=>r.metrics[field].delta!==null&&(!otherRows||otherRows.get(r.id)?.metrics[field].delta!=null));
 const ids=new Set(cohort.map(r=>r.id)),index=new Map(points.filter(p=>ids.has(p.targetId)).map(p=>[`${p.targetId}/${p.date}`,p]));
 const series=(ds,base)=>ds.map(date=>{let total=0,known=0;for(const a of cohort){const value=index.get(`${a.id}/${date}`)?.[field],b=index.get(`${a.id}/${base}`)?.[field];if(value!=null&&b!=null){total+=value-b;known++;}}return {date,value:cohort.length&&known===cohort.length?total*(metric==='estimated'?100:1):null,known};});
 const current=series(dates,start),comparison=series(other,otherStart);
 return {cohortCount:cohort.length,cohortTargetIds:[...ids].sort((a,b)=>a-b),totalCount:accounts.length,points:Array.from({length:Math.max(current.length,comparison.length)},(_,i)=>({day:i+(visibleOffset??0),currentDate:current[i]?.date??null,current:current[i]?.value??null,currentKnown:current[i]?.known??0,comparisonDate:comparison[i]?.date??null,comparison:comparison[i]?.value??null,comparisonKnown:comparison[i]?.known??0}))};
}
