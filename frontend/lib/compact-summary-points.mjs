import {summaryPointValid} from './replica-summary.mjs';

// Private storage cannot be changed through a returned row or typed-array view.
// Float64 preserves every safe integer counter and millisecond timestamp; NaN
// represents null, so real zero never becomes missing. 64 retained bytes/row.
const stored=new WeakMap(),DAY=86400000,BYTES=64;
export const SUMMARY_RETAINED_BYTES=64_000_000;
export const isCompactSummary=(value,asOf)=>stored.has(value)&&(asOf===undefined||stored.get(value).asOf===asOf);
export const summaryCollection=value=>Array.isArray(value)||isCompactSummary(value);
const fail=()=>{throw Error('日期历史紧凑存储无效，保留已读取数据');};

/** Append strictly ordered, validated date/account points, then seal once.
 * No typed-array references or mutators escape finish(). */
export function compactSummaryBuilder(capacity,asOf){
 if(!Number.isSafeInteger(capacity)||capacity<0||capacity*BYTES>SUMMARY_RETAINED_BYTES)fail();
 const target=new Uint32Array(capacity),date=new Int32Array(capacity);
 const columns=Array.from({length:7},()=>new Float64Array(capacity));
 const names=['capturedAt','followers','followersAt','likes','likesAt','posts','postsAt'];
 const ranges=new Map();let length=0,previousDay=-Infinity,previousId=0,sealed=false;
 return {
  append(p){
   if(sealed||length>=capacity||!summaryPointValid(p,asOf))fail();
   const day=Date.parse(p.date+'T00:00:00Z')/DAY;
   if(day<previousDay||day===previousDay&&p.targetId<=previousId)fail();
   target[length]=p.targetId;date[length]=day;
   for(let i=0;i<names.length;i++){const value=p[names[i]];columns[i][length]=value===null?NaN:names[i].endsWith('At')?Date.parse(value):value;}
   if(day!==previousDay)ranges.set(p.date,{start:length,end:length+1});else ranges.get(p.date).end=length+1;
   previousDay=day;previousId=p.targetId;length++;
  },
  finish(){
   if(sealed)fail();sealed=true;
   const at=i=>{
    const row={targetId:target[i],date:new Date(date[i]*DAY).toISOString().slice(0,10)};
    for(let j=0;j<names.length;j++){const value=columns[j][i];row[names[j]]=Number.isNaN(value)?null:names[j].endsWith('At')?new Date(value).toISOString():value;}
    return row;
   };
   const find=(id,day)=>{const range=ranges.get(day);if(!range)return -1;let lo=range.start,hi=range.end;
     while(lo<hi){const middle=(lo+hi)>>>1;if(target[middle]<id)lo=middle+1;else hi=middle;}
     return lo<range.end&&target[lo]===id?lo:-1;
   };
   const result=Object.freeze({
    length,byteLength:capacity*BYTES,
    get(id,day){const index=find(id,day);return index<0?undefined:at(index);},
    metric(id,day,name){const column={followers:1,likes:3,posts:5}[name];if(column===undefined)fail();
     const index=find(id,day);if(index<0)return undefined;const value=columns[column][index];return Number.isNaN(value)?null:value;
    },
    values(id,day){const index=find(id,day);if(index<0)return undefined;
     return Object.fromEntries(['followers','likes','posts'].map((name,i)=>{const value=columns[i*2+1][index];return [name,Number.isNaN(value)?null:value];}));
    },
    *[Symbol.iterator](){for(let i=0;i<length;i++)yield at(i);},
   });
   stored.set(result,{asOf});return result;
  },
 };
}

/** Consumers use an exact indexed lookup rather than copying the whole range. */
export function summaryLookup(points){
 if(isCompactSummary(points))return (id,date)=>points.get(id,date);
 const rows=new Map();for(const p of points)rows.set(p.targetId+'/'+p.date,p);
 return (id,date)=>rows.get(id+'/'+date);
}
export function summaryMetricLookup(points,metric){
 if(isCompactSummary(points))return (id,date)=>points.metric(id,date,metric);
 const get=summaryLookup(points);return (id,date)=>get(id,date)?.[metric];
}
