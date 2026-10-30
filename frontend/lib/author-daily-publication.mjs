import {validDate} from './replica-date-value.mjs';
import {workPublicationDay} from './replica-work-publication.mjs';

export function publicationBusinessDay(asOf) {
 if(typeof asOf!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d\d:\d\d)$/.test(asOf)||!Number.isFinite(Date.parse(asOf)))throw Error('发布记录版本时间无效');
 if(!validDate(asOf.slice(0,10)))throw Error('发布记录版本时间无效');
 const date=new Date(Date.parse(asOf)+28_800_000).toISOString().slice(0,10);
 if(!validDate(date))throw Error('发布记录版本时间无效');
 return date;
}

/** Already identity-scoped unified works only. Missing list coverage never proves absence. */
export function authorDailyPublication(rows,{asOf,date=publicationBusinessDay(asOf)}) {
 const end=publicationBusinessDay(asOf);
 if(!Array.isArray(rows)||!validDate(date)||date<'2026-09-12'||date>end)throw Error('请选择监控开始日至版本截止日之间的日期');
 const works=new Map();
 for(const row of rows){
  if(!row||typeof row.externalId!=='string'||!/^\d{15,25}$/.test(row.externalId))throw Error('作品身份无效，停止统计发布数');
  const published=workPublicationDay(row),previous=works.get(row.externalId);
  if(previous&&previous.date!==published)throw Error('同一作品的发布日期冲突，停止统计发布数');
  const timestampBasis=row.publicationDateBasis==null||row.publicationDateBasis==='platform-timestamp';
  const futureTime=timestampBasis&&typeof row.publishedAt==='string'&&Date.parse(row.publishedAt)>Date.parse(asOf);
  if(previous&&previous.futureTime!==futureTime)throw Error('同一作品的发布时间冲突，停止统计发布数');
  if(!previous)works.set(row.externalId,{row,date:published,futureTime});
 }
 const selected=[],undated=[],future=[];
 for(const entry of works.values()){
  if(entry.futureTime||entry.date>end)future.push(entry.row.externalId);
  else if(entry.date===null)undated.push(entry.row.externalId);
  else if(entry.date===date)selected.push(entry.row);
 }
 return {date,end,status:selected.length?'published':'unknown',knownWorks:selected.length,rows:selected,
  undatedWorks:undated.length,futureDatedWorks:future.length,complete:false,currentDay:date===end};
}
