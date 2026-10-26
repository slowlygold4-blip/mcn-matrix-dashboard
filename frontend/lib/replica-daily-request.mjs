import {validDate} from './replica-model.mjs';
import {normalizeDateRequest,trendRangeRequest} from './replica-date-range.mjs';
const move=(date,n)=>new Date(Date.parse(date+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
/** Same bounded window as the curve, plus its exact preceding Beijing day. */
export function dailyCoverageWindow({start,end,offset=0}) {
 if(!validDate(start)||!validDate(end)||start>end||!Number.isSafeInteger(offset)||offset<0)throw Error('无效每日覆盖日期');
 const first=move(start,offset);if(first>end)return null;
 return {start:first,end:move(first,89)<end?move(first,89):end};
}
export function dailyCoverageRequest(options) {
 const trend=trendRangeRequest(options),window=dailyCoverageWindow(options);
 return normalizeDateRequest({ranges:trend.ranges,dates:[...trend.dates,...(window?[move(window.start,-1)]:[])]});
}
