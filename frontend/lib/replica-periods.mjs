import {isCompactSummary} from './compact-summary-points.mjs';
import {defaultWindow,fields,rowsFor,validDate} from './replica-model.mjs';
import {summaryPointValid} from './replica-summary.mjs';
export const BUSINESS_START='2026-09-12';
export const periodNames={day:'最近1日净变',week:'近7天净变',month:'本月已采净变',since:'9/12起观察',observed:'共同已采窗口',custom:'自选日期'};
const moveDay=(date,n)=>new Date(Date.parse(date+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
function checkWindowInputs(key,accounts,asOf){
 if(!Object.hasOwn(periodNames,key)||key==='custom')throw Error('请选择有效的统计周期');
 if(!Array.isArray(accounts)||accounts.some(a=>!Number.isSafeInteger(a?.id)||a.id<1)||new Set(accounts.map(a=>a.id)).size!==accounts.length)throw Error('无效或重复账号队列');
 if(typeof asOf!=='string'||!Number.isFinite(Date.parse(asOf))||new Date(asOf).toISOString()!==asOf)throw Error('无效已保存观察或数据截止');
}
function requestedWindow(key,end,asOf){
 if(!end)return {start:null,end:null,anchor:null,clipped:false,requestedEnd:null,note:'所选范围暂无真实已保存观察，保留原日期。'};
 let start=BUSINESS_START,clipped=false;
 if(key==='day')start=moveDay(end,-1);
 if(key==='week')start=moveDay(end,-7);
 const cutoffDay=new Date(Date.parse(asOf)+28800000).toISOString().slice(0,10);
 let finish=end,requestedEnd=end;
 if(key==='month'){
  const monthStart=cutoffDay.slice(0,8)+'01';start=moveDay(monthStart,-1);if(start<BUSINESS_START){start=BUSINESS_START;clipped=true;}
  requestedEnd=cutoffDay;finish=end>=monthStart?end:cutoffDay;
 }
 const note=key==='month'?(clipped?'请求9/12采样作基准，不覆盖9/1–9/11；不是完整自然月。':'以上月末真实采样作基准；缺基准不计净变，不是自然月终盘。')+` 请求自然月截至 ${requestedEnd}；`+(end>=cutoffDay.slice(0,8)+'01'?`实际已采截至 ${finish}。`:'本月尚无样本，不借上月值或补零。'):key==='since'?'请求9/12采样作固定基准；缺少起止值的账号不会补零。':`相差${key==='day'?1:7}个自然日，按保存观察相减，不代表全天事件总量。`;
 return {start,end:finish,anchor:end,clipped,requestedEnd,note:note+(key==='since'?` 持续统计 ${start} → ${finish}；结束日随最新已保存观察推进。`:` 固定统计 ${start} → ${finish}；所选账号最近真实观察日 ${end}，筛选与刷新不自动改日期。`)};
}
/** Catalog latest dates are audited source observations, not local wall-clock dates or windowed curve points. */
export function periodWindowFromCatalog(key,accounts,asOf){
 checkWindowInputs(key,accounts,asOf);
 if(key==='observed')throw Error('按日期读取时，局部窗口不能证明全历史共同覆盖。请选择固定或自选周期。');
 const dates=[];
 for(const account of accounts.filter(a=>a.enabled===true))for(const field of fields){
  const m=account.latest?.[field];if(!m||m.value===null)continue;
  if(!Number.isSafeInteger(m.value)||m.value<0||!validDate(m.date)||typeof m.observedAt!=='string'||!Number.isFinite(Date.parse(m.observedAt))||new Date(m.observedAt).toISOString()!==m.observedAt||m.observedAt>asOf||new Date(Date.parse(m.observedAt)+28800000).toISOString().slice(0,10)!==m.date)throw Error('最近统计的采样时间与日期不一致');
  if(m.date>=BUSINESS_START)dates.push(m.date);
 }
 return requestedWindow(key,dates.sort().at(-1),asOf);
}
/** Derive a requested window only on an explicit user action, never from wall-clock time. */
export function periodWindow(key,accounts,points,asOf){
 checkWindowInputs(key,accounts,asOf);
 if(!isCompactSummary(points,asOf)&&(!Array.isArray(points)||points.some(p=>!summaryPointValid(p,asOf))))throw Error('无效已保存观察或数据截止');
 rowsFor([],points,BUSINESS_START,BUSINESS_START);
 const enabled=accounts.filter(a=>a.enabled===true),ids=new Set(enabled.map(a=>a.id));
 const observed=new Set();for(const p of points)if(ids.has(p.targetId)&&p.date>=BUSINESS_START&&fields.some(k=>p[k]!==null))observed.add(p.date);const dates=[...observed].sort();
 const end=dates.at(-1),result=requestedWindow(key,end,asOf);
 if(key==='observed'&&end){const w=defaultWindow(enabled,(function*(){for(const p of points)if(p.date>=BUSINESS_START)yield p;})());result.start=w.start||dates[0];result.end=w.end||end;result.requestedEnd=result.end;result.note='首尾90%账号三项有值的日期优先；不足时保留实际观察窗口。不是完整9/12起区间，也不保证窗口内每天完整。'+` 固定请求 ${result.start} → ${result.end}；实际观察截止 ${end}。`;}
 return result;
}
