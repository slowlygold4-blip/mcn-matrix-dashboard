/** Explicit submitted publication dates. Never derive a date from a work ID. */
import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
const day=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\d$/.test(value)
 &&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const beijing=value=>new Date(Date.parse(value)+28_800_000).toISOString().slice(0,10);
/** Yearless input needs one unique date in the source's declared period. */
export function submittedPublicationDay(value,{start,end,asOf}={}){
 if(!Number.isFinite(Date.parse(asOf)))return null;
 if(typeof value==='number'){
  if(!Number.isFinite(value)||value<=0)return null;
  const raw=String(value);
  if(Number.isSafeInteger(value)&&/^\d{8}$/.test(raw))value=raw;
  else{
   const decimal=raw.match(/^(\d{1,2})\.(\d{1,2})$/);if(!decimal)return null;
   // Excel may have removed a trailing zero: 9.1 can mean Sep 1 or Sep 10.
   if(decimal[2].length===1&&+decimal[2]>=1&&+decimal[2]<=3)return null;
   value=raw;
  }
 }
 if(typeof value!=='string')return null;
 let text=value.normalize('NFKC').trim(),result;
 if(/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(text)){
  if(!day(text.slice(0,10))||+text.slice(11,13)>23||+text.slice(14,16)>59
   ||text[16]===':'&&+text.slice(17,19)>59||!Number.isFinite(Date.parse(text)))return null;result=beijing(text);
 }else{
  text=text.replace(/^(\d{4})\s+(\d{2})(\d{2})(?=\s|$)/,'$1-$2-$3')
   .replace(/^(\d{4})(\d{2})(\d{2})(?=\s|$)/,'$1-$2-$3')
   .replace(/[日号]/g,' ').replace(/[年月]/g,'.').trim();
  const match=text.match(/^(?:(\d{4}|\d{2})[./-])?(\d{1,2})[./-](\d{1,2})(?:[ T.-]+(\d{1,2})(?:[:.;](\d{1,2})(?:[:.;](\d{1,2}))?)?)?\.?$/);
  if(!match||match[4]!=null&&(+match[4]>23||+(match[5]??0)>59||+(match[6]??0)>59))return null;
  const make=year=>`${year}-${match[2].padStart(2,'0')}-${match[3].padStart(2,'0')}`;
  if(match[1]?.length===4)result=make(match[1]);
  else{
   if(!day(start)||!day(end)||start>end||+end.slice(0,4)-+start.slice(0,4)>2)return null;
   const options=[];for(let year=+start.slice(0,4);year<=+end.slice(0,4);year++){
    if(match[1]&&!String(year).endsWith(match[1]))continue;
    const candidate=make(year);if(day(candidate)&&(start.slice(0,4)===end.slice(0,4)||candidate>=start&&candidate<=end))options.push(candidate);
   }
   if(options.length!==1)return null;result=options[0];
  }
 }
 return day(result)&&result<=beijing(asOf)?result:null;
}
const roles=[['10','视频ID','原填发布时间'],['15','视频ID','原填日期']];
export function projectSourcePublicationDates({imported,sheets,overview,sourceRows,works}){
 const period=new Map(overview.map(row=>{const values=JSON.parse(row.values_json);return [values[0],values[1]];}));
 const context={start:period.get('统计开始'),end:period.get('统计结束'),asOf:imported.imported_at};
 const knownIds=new Set(works.map(w=>w.contentId)),claims=new Map();let invalidRows=0,matchedRows=0;
 for(const [sheetId,idRole,dateRole]of roles){
  const sheet=sheets.find(s=>s.sheet_id===sheetId);if(!sheet)continue;const headers=JSON.parse(sheet.headers_json);
  if(!Array.isArray(headers)||headers.filter(h=>h===idRole).length!==1||headers.filter(h=>h===dateRole).length!==1)continue;
  const idColumn=headers.indexOf(idRole),dateColumn=headers.indexOf(dateRole);
  for(const row of sourceRows.filter(row=>row.sheet_id===sheetId)){
   const values=JSON.parse(row.values_json),contentId=values[idColumn];
   if(typeof contentId!=='string'||!/^\d{15,25}$/.test(contentId)||!knownIds.has(contentId))continue;
   const publishedOn=submittedPublicationDay(values[dateColumn],context);if(!publishedOn){invalidRows++;continue;}
   const proof={sheet:sheetId,row:row.row_number,rowSha256:hash(row.values_json),headersSha256:hash(sheet.headers_json),
    contentId,originalValue:values[dateColumn],publishedOn,declaredPeriod:{start:context.start??null,end:context.end??null}};
   const entries=claims.get(contentId)??[];entries.push(proof);claims.set(contentId,entries);matchedRows++;
  }
 }
 let adopted=0,changedDays=0,conflicting=0;
 const projected=works.map(work=>{
  const evidence=claims.get(work.contentId);if(!evidence)return work;
  const dates=[...new Set(evidence.map(row=>row.publishedOn))];
  if(dates.length!==1){conflicting++;return {...work,dateSource:'source-publication-date-conflict',sourcePublicationDateEvidence:evidence};}
  adopted++;if(work.publishedOn&&work.publishedOn!==dates[0])changedDays++;
  return {...work,sourceInferredPublishedOn:work.publishedOn||null,publishedOn:dates[0],
   dateSource:'source-explicit-publication-date',sourcePublicationDateEvidence:evidence};
 });
 return {works:projected,summary:{matchedRows,adopted,changedDays,conflicting,invalidRows},fingerprint:hash(JSON.stringify([...claims]))};
}
