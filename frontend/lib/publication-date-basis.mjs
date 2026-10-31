/** Date authority is independent of metric freshness and work ownership. */
export const PUBLICATION_DATE_MODE='publication-date-basis-v1';
export const PUBLICATION_DATE_BASES=Object.freeze(['platform-timestamp','source-explicit-date','source-inferred-date','source-date-conflict','unverified-date','missing']);
export const publicationDateTracks=Object.freeze(['all','slice','original','ai-remix','contest','unclassified']);
const day=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\d$/.test(value)
 &&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const own=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const count=n=>Number.isSafeInteger(n)&&n>=0;
export const publicationDateBasisValid=(basis,date)=>PUBLICATION_DATE_BASES.includes(basis)
 &&(basis==='missing'?date===''||date===null:day(date));
/** Public work partitions and CSV use one date contract. Legacy timestamp-only
 * records stay readable; a source day never becomes an invented midnight. */
export function savedPublicationDateValid(work,asOf,{allowLegacy=false}={}){
 const validTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))
  &&new Date(value).toISOString()===value&&Date.parse(value)<=Date.parse(asOf);
 if(!work||!Number.isFinite(Date.parse(asOf))||work.publishedOn!=null&&!day(work.publishedOn)
  ||work.publishedAt!=null&&!validTime(work.publishedAt))return false;
 const basis=work.publicationDateBasis;
 if(basis==null)return allowLegacy&&work.publishedOn==null;
 if(basis==='platform-timestamp')return validTime(work.publishedAt);
 if(basis==='missing')return work.publishedAt==null&&work.publishedOn==null;
 return (basis==='creator-source-date-only'||publicationDateBasisValid(basis,work.publishedOn))
  &&work.publishedAt==null&&day(work.publishedOn);
}
export function sourcePublicationDateBasis(work){
 if(!day(work.publishedOn))return 'missing';
 if(work.dateSource==='platform-published-at')return 'platform-timestamp';
 if(['source-explicit-publication-date','source-publication-day'].includes(work.dateSource))return 'source-explicit-date';
 if(work.dateSource==='source_inferred_publication_date')return 'source-inferred-date';
 if(work.dateSource==='source-publication-date-conflict')return 'source-date-conflict';
 return 'unverified-date';
}
export const publicationDateIsConfirmed=basis=>['platform-timestamp','source-explicit-date'].includes(basis);
export const publicationDateBasisLabel=basis=>({'platform-timestamp':'平台发布时间','source-explicit-date':'明确填报日期',
 'source-inferred-date':'推算日期，待核验','source-date-conflict':'填报日期冲突','unverified-date':'日期依据待核验','missing':'未记录日期'}[basis]??'日期依据待核验');
const selected=(rows,track)=>track==='all'?rows:rows.filter(r=>track==='unclassified'?!r.classifications.length:r.classifications.includes(track));
export function publicationDateCounts(rows){
 return Object.fromEntries(publicationDateTracks.map(track=>{
  const value={confirmed:0,unverified:0,missing:0};
  for(const row of selected(rows,track)){
   if(!publicationDateBasisValid(row.dateBasis,row.date))throw Error('publication-date-basis-invalid');
   value[row.dateBasis==='missing'?'missing':publicationDateIsConfirmed(row.dateBasis)?'confirmed':'unverified']++;
  }
  return [track,value];
 }));
}
export function publicationDateCountsValid(summary,works,tracks){
 return own(summary,publicationDateTracks)&&publicationDateTracks.every(track=>{
  const s=summary[track];return own(s,['confirmed','unverified','missing'])&&Object.values(s).every(count)
   &&s.confirmed+s.unverified+s.missing===(track==='all'?works:tracks[track]??0);
 });
}
export function sumPublicationDateCounts(items){
 const result=Object.fromEntries(publicationDateTracks.map(track=>[track,{confirmed:0,unverified:0,missing:0}]));
 for(const item of items)for(const track of publicationDateTracks)for(const key of ['confirmed','unverified','missing']){
  const next=result[track][key]+item[track][key];if(!count(next))throw Error('publication-date-count-overflow');result[track][key]=next;
 }
 return result;
}
