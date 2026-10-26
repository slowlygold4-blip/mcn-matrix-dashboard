// Presentation only: never calculate a new cohort, fill a gap or select older data.
export function trendEndpoint(points, side='current') {
  const key=side==='comparison'?'comparison':'current';
  const point=points?.findLast(p=>typeof p[key+'Date']==='string'&&p[key+'Date']);
  return point?{date:point[key+'Date'],value:point[key]??null,known:point[key+'Known']??null}:null;
}
export function trendTick(points, day, compare) {
  if(compare)return `第${day}天`;
  const date=points?.find(p=>p.day===day)?.currentDate;
  return date?`${Number(date.slice(5,7))}/${Number(date.slice(8,10))}`:'';
}

// A selected row is an exact relative-day match, never the nearest known sample.
/** @param {Array<Record<string,any>>|null|undefined} points @param {number|null} day */
export function trendPoint(points, day=null) {
  if(!points?.length)return null;
  const index=day===null?points.length-1:points.findIndex(p=>p.day===day);
  if(index<0)return null;
  const point=points[index];
  const side=key=>{
    const date=point[key+'Date']||null,value=point[key]??null;
    return {date,value:date?value:null,known:date?(point[key+'Known']??null):null,state:!date?'outside':value===null?'missing':'known'};
  };
  return {day:point.day,index,current:side('current'),comparison:side('comparison')};
}

export function trendMove(points, day, key) {
  const point=trendPoint(points,day);
  if(!point)return null;
  const moves={ArrowLeft:Math.max(0,point.index-1),ArrowRight:Math.min(points.length-1,point.index+1),Home:0,End:points.length-1};
  return Object.hasOwn(moves,key)?points[moves[key]].day:null;
}

// Stable across refreshed payload objects, but not a new metric/range/scope/page.
/** @param {{accountIds?:Array<string|number>,scope?:string,start:string,end:string,metric:string,compare?:boolean,otherStart?:string,otherEnd?:string,offset?:number}} options */
export function trendSelectionScope({accountIds=[],scope='',start,end,metric,compare=false,otherStart='',otherEnd='',offset=0}) {
  return JSON.stringify([scope,[...accountIds].sort((a,b)=>String(a).localeCompare(String(b))),start,end,metric,compare,compare?otherStart:'',compare?otherEnd:'',offset]);
}
