import {validDate,rowsFor} from './replica-model.mjs';
import {growthSeries} from './replica-trends.mjs';
import {summaryMetricLookup} from './compact-summary-points.mjs';

const DAY_MS=86400000;
const MAX_DAYS=14;

/** A small, strictly observed metric trend for the currently selected account scope.
 * The cohort is selected once using the selected range's real start/end samples.
 * The visible tail never recalculates its baseline or silently borrows other accounts.
 * @param {Array<object>} accounts
 * @param {Iterable<object>} points
 * @param {{start:string,end:string,ready?:boolean,metric?:'followers'|'likes'|'posts'}} options
 */
export function buildOverviewTrendPreview(accounts,points,{start,end,ready=true,metric='followers'}={}){
 if(!ready)return {state:'loading',cohortCount:0,totalCount:Array.isArray(accounts)?accounts.length:0,samples:[]};
 try{
  if(!validDate(start)||!validDate(end)||start>end)throw Error('无效采样范围');
  const totalDays=(Date.parse(end)-Date.parse(start))/DAY_MS+1;
  const visibleDays=Math.min(MAX_DAYS,totalDays);
  const series=growthSeries(accounts,points,{start,end,metric,visibleOffset:totalDays-visibleDays,visibleDays});
  const samples=series.points.map(point=>({date:point.currentDate,value:point.current,known:point.currentKnown}));
  return {
   state:series.cohortCount?'ready':'empty',
   baselineDate:start,
   firstVisibleDate:samples[0]?.date??null,
   lastVisibleDate:samples.at(-1)?.date??null,
   cohortCount:series.cohortCount,
   totalCount:series.totalCount,
   completeDays:samples.filter(sample=>sample.value!==null).length,
   samples,
   endpointValue:samples.at(-1)?.value??null,
  };
 }catch(error){
  return {state:'error',cohortCount:0,totalCount:Array.isArray(accounts)?accounts.length:0,samples:[],reason:error instanceof Error?error.message:String(error)};
 }
}

/** Adjacent Beijing-day differences remain readable even without the 9/12 baseline.
 * Each day reports its own paired-account coverage; gaps are never bridged. */
export function buildDailyOverviewTrend(accounts,points,{start,end,ready=true,metric='followers'}={}){
 const totalCount=Array.isArray(accounts)?accounts.length:0;
 if(!ready)return {state:'loading',cohortCount:0,totalCount,samples:[]};
 try{
  if(!['followers','likes','posts'].includes(metric)||new Set(accounts.map(a=>a.id)).size!==accounts.length)throw Error('无效账号或指标');
  rowsFor(accounts,points,start,end);
  const ids=new Set(accounts.map(a=>a.id)),get=summaryMetricLookup(points,metric);
  const samples=[],first=Math.max(Date.parse(start),Date.parse(end)-(MAX_DAYS-1)*DAY_MS);
  for(let t=first;t<=Date.parse(end);t+=DAY_MS){
   const date=new Date(t).toISOString().slice(0,10),previous=new Date(t-DAY_MS).toISOString().slice(0,10);let known=0,value=0;
   if(previous>=start)for(const id of ids){const a=get(id,previous),b=get(id,date);if(a!=null&&b!=null){known++;value+=b-a;}}
   samples.push({date,value:known?value:null,known});
  }
  return {state:samples.some(p=>p.value!==null)?'ready':'empty',baselineDate:null,firstVisibleDate:samples[0]?.date,lastVisibleDate:samples.at(-1)?.date,cohortCount:samples.at(-1)?.known??0,totalCount,completeDays:samples.filter(p=>p.value!==null).length,samples,endpointValue:samples.at(-1)?.value??null};
 }catch(error){return {state:'error',cohortCount:0,totalCount,samples:[],reason:String(error)};}
}

/** SVG segments never cross a null or non-finite day. Single observed days remain dots. */
export function overviewTrendGeometry(samples,{width=320,height=82,padding=7}={}){
 if(!Array.isArray(samples)||!Number.isFinite(width)||!Number.isFinite(height)||!Number.isFinite(padding)||width<=2*padding||height<=2*padding)throw Error('无效曲线范围');
 const known=samples.filter(sample=>Number.isFinite(sample?.value));
 const lowest=Math.min(0,...known.map(sample=>sample.value));
 const highest=Math.max(0,...known.map(sample=>sample.value));
 const min=lowest===highest?lowest-1:lowest;
 const max=lowest===highest?highest+1:highest;
 const x=index=>samples.length<=1?width/2:padding+index*(width-2*padding)/(samples.length-1);
 const y=value=>padding+(max-value)*(height-2*padding)/(max-min);
 const dots=[];
 const segments=[];
 let active=[];
 for(const [index,sample] of samples.entries()){
  if(!Number.isFinite(sample?.value)){
   if(active.length)segments.push(active);
   active=[];
   continue;
  }
  const dot={date:sample.date,value:sample.value,known:sample.known,x:Number(x(index).toFixed(2)),y:Number(y(sample.value).toFixed(2))};
  dots.push(dot);
  active.push(dot);
 }
 if(active.length)segments.push(active);
 return {
  width,height,
  zeroY:Number(y(0).toFixed(2)),
  paths:segments.map(segment=>segment.map((dot,index)=>`${index?'L':'M'}${dot.x} ${dot.y}`).join(' ')),
  dots,
  min,max,
 };
}
