/** Public supplementary-source contract; no platform requests or credentials. */
import {validateTableFoundationManifest} from './table-foundation-manifest.mjs';
const groups={authors:'foundationAuthors',works:'foundationWorks',sources:'foundationSources',observations:'foundationObservations','other-authors':'foundationOtherAuthors','other-works':'foundationOtherWorks','pending-authors':'foundationPendingAuthors'};
export const FOUNDATION_GROUPS=Object.freeze(Object.keys(groups));
const fields={authors:'authors',works:'works',sources:'sources',observations:'observations','other-authors':'otherAuthors','other-works':'otherWorks','pending-authors':'pendingAuthors'};
const counts={authors:'additionalAuthors',works:'additionalWorks',sources:'sourceDocuments',observations:'sourceMetricObservations','other-authors':'otherAuthors','other-works':'otherWorks','pending-authors':'pendingAuthors'};
const record=v=>v&&typeof v==='object'&&!Array.isArray(v),keys=(v,list)=>record(v)&&Object.keys(v).length===list.length&&list.every(k=>Object.hasOwn(v,k));
const n=v=>Number.isSafeInteger(v)&&v>=0,nullable=v=>v===null||n(v),text=(v,max=300)=>typeof v==='string'&&v.length<=max&&!/[<>\u0000-\u001f\u007f]/.test(v);
const texts=v=>Array.isArray(v)&&v.every(s=>text(s));
const ids=v=>Array.isArray(v)&&v.every(id=>n(id)&&id>0)&&new Set(v).size===v.length;
const time=(v,asOf)=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&Date.parse(v)<=Date.parse(asOf);
const SHA=/^[a-f0-9]{64}$/,content=v=>typeof v==='string'&&/^\d{16,22}$/.test(v);
const STATS=['sourceDocuments','sourceRows','tuantuanRows','acceptedRows','unkeyedRows','ambiguousRows','invalidIdentityRows','baseAuthorEvidence','baseWorkEvidence','additionalAuthors','additionalWorks','otherAuthors','otherWorks','sourceMetricObservations','sourceMetricWorkIds','baseAuthorRows','reciprocalDuplicates','baseAuthors','baseWorks','sheets','pendingAuthors'];
const common=['version','asOf','timeZone'];
const group=path=>/^foundation\/([a-z-]+)\.json$/.exec(path??'')?.[1];
export const foundationFile=f=>group(f?.path)==='index'||Object.hasOwn(groups,group(f?.path)??'');
export const foundationKind=path=>group(path)==='index'?'foundationIndex':groups[group(path)]??null;
export const foundationRevisionPayload=(index,parts)=>JSON.stringify([index.linkFingerprint,index.stats,index.sheetCoverage,FOUNDATION_GROUPS.map(name=>[name,parts[fields[name]]])]);
export function foundationPartValid(part,meta,asOf){
 if(!foundationFile(meta)||foundationKind(meta.path)!==meta.kind||part?.version!==1||part.asOf!==asOf||part.timeZone!=='Asia/Shanghai'||!SHA.test(part.revision??''))return false;
 if(meta.kind==='foundationIndex'){
  try{validateTableFoundationManifest(part);}catch{return false;}
  return keys(part,[...common,'revision','generatedAt','linkMode','linkFingerprint','stats','sheetCoverage','files','semantics'])
   &&part.generatedAt===asOf&&part.linkMode==='current-strict'&&SHA.test(part.linkFingerprint)&&keys(part.stats,STATS)&&part.files.length===FOUNDATION_GROUPS.length
   &&FOUNDATION_GROUPS.every(name=>part.files.some(f=>f.path===name+'.json'&&f.generation===asOf))
   &&part.files.every(f=>keys(f,['path','count','bytes','sha256','generation']))
   &&part.files.reduce((sum,f)=>sum+f.count,0)===meta.count
   &&keys(part.semantics,['authors','pendingAuthors','works','metrics','privacy'])&&Object.values(part.semantics).every(v=>text(v));
 }
 if(!keys(part,[...common,'revision','items'])||!Array.isArray(part.items)||part.items.length!==meta.count)return false;
 const name=group(meta.path);
 const evidence=r=>n(r.evidenceRows)&&r.evidenceRows>0&&texts(r.sourceTitles);
 return part.items.every(r=>{
  if(name==='authors')return keys(r,['douyinId','name','posts','slicePosts','creationPosts','aiPosts','cupPosts','plays','likes','followers','targetIds','evidenceRows','sourceTitles'])&&text(r.douyinId,120)&&text(r.name,160)&&['posts','slicePosts','creationPosts','aiPosts','cupPosts','plays','likes','followers'].every(k=>nullable(r[k]))&&ids(r.targetIds)&&evidence(r);
  if(name==='works')return keys(r,['contentId','author','douyinId','publishDate','type','track','tracks','plays','likes','title','url','evidenceRows','sourceTitles'])&&content(r.contentId)&&text(r.author,160)&&text(r.douyinId,120)&&['publishDate','type','track','tracks','title'].every(k=>r[k]===null||text(r[k]))&&nullable(r.plays)&&nullable(r.likes)&&(r.url===null||r.url===`https://www.douyin.com/video/${r.contentId}`)&&evidence(r);
  if(name==='sources')return keys(r,['title','revision','importedAt','rows','tuantuanRows','otherRows','unkeyedRows'])&&text(r.title)&&nullable(r.revision)&&time(r.importedAt,asOf)&&['rows','tuantuanRows','otherRows','unkeyedRows'].every(k=>n(r[k]))&&r.tuantuanRows+r.otherRows===r.rows;
  if(name==='observations'){
   const base=['contentId','author','douyinId','likes','plays','observedAt','sourceRow'];
   const typed=keys(r,[...base,'recordedAt','timeBasis']);
   return (keys(r,base)||typed)&&content(r.contentId)&&text(r.author,160)&&text(r.douyinId,120)&&nullable(r.likes)&&nullable(r.plays)
    &&(r.observedAt===null||time(r.observedAt,asOf))&&n(r.sourceRow)&&r.sourceRow>0
    &&(!typed||['metric-observation','submission-time','unknown'].includes(r.timeBasis)
      &&(r.recordedAt===null||time(r.recordedAt,asOf))&&(r.timeBasis==='metric-observation'?r.observedAt!==null&&r.observedAt===r.recordedAt:r.observedAt===null));
  }
  if(name==='other-authors')return keys(r,['board','platform','platformId','name','targetIds','evidenceRows','sourceTitles'])&&text(r.board,100)&&text(r.platform,40)&&text(r.platformId,120)&&text(r.name,160)&&ids(r.targetIds)&&evidence(r);
  if(name==='other-works')return keys(r,['board','contentId','author','platformId','evidenceRows','sourceTitles'])&&text(r.board,100)&&content(r.contentId)&&text(r.author,160)&&text(r.platformId,120)&&evidence(r);
  return name==='pending-authors'&&keys(r,['rowKey','name','douyinId','submittedAccountId','identifierStatus','platform','theme','targetIds','sourceTitles','sourceRows','sourceSupplement','sourceOnly','posts','plays','likes','followers'])
   &&text(r.rowKey,200)&&text(r.name,160)&&(r.douyinId===null||text(r.douyinId,120))&&(r.submittedAccountId===null||text(r.submittedAccountId,120))
   &&['format-valid','unusable','missing'].includes(r.identifierStatus)&&r.platform==='douyin'&&r.theme==='tuantuan'&&Array.isArray(r.targetIds)&&r.targetIds.length===0&&texts(r.sourceTitles)
   &&Array.isArray(r.sourceRows)&&r.sourceRows.every(s=>keys(s,['sourceKey','title','sheetName','rows'])&&SHA.test(s.sourceKey)&&text(s.title,160)&&text(s.sheetName,100)&&Array.isArray(s.rows)&&s.rows.every(v=>/^\d+$/.test(v)))
   &&r.sourceSupplement===true&&r.sourceOnly===true&&['posts','plays','likes','followers'].every(k=>r[k]===null);
 });
}
export async function auditFoundationPublication({manifest,readPart}){
 const metas=manifest.files.filter(foundationFile);if(!metas.length)return;
 const root=metas.find(m=>m.path==='foundation/index.json');if(!root)throw Error('foundation-index-missing');
 const index=await readPart(root.path);if(!foundationPartValid(index,root,manifest.asOf))throw Error('foundation-index-invalid');
 const parts={};for(const name of FOUNDATION_GROUPS){const descriptor=index.files.find(f=>f.path===name+'.json'),meta=metas.find(f=>f.path==='foundation/'+descriptor.path);
  if(!meta||['count','bytes','sha256'].some(k=>meta[k]!==descriptor[k]))throw Error('foundation-descriptor-conflict');
  const part=await readPart(meta.path);if(!foundationPartValid(part,meta,manifest.asOf)||part.revision!==index.revision||part.items.length!==index.stats[counts[name]])throw Error('foundation-part-invalid');
  parts[fields[name]]=part.items;
 }
 if(metas.length!==FOUNDATION_GROUPS.length+1||parts.sources.reduce((sum,s)=>sum+s.rows,0)!==index.stats.sourceRows
  ||parts.sources.reduce((sum,s)=>sum+s.tuantuanRows,0)!==index.stats.tuantuanRows
  ||new Set(parts.observations.map(o=>o.contentId)).size!==index.stats.sourceMetricWorkIds
  ||new Set(parts.works.map(w=>w.contentId)).size!==parts.works.length||new Set(parts.pendingAuthors.map(a=>a.rowKey)).size!==parts.pendingAuthors.length)throw Error('foundation-total-conflict');
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(foundationRevisionPayload(index,parts)));
 if([...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('')!==index.revision)throw Error('foundation-revision-conflict');
 if(manifest.files.some(f=>f.path==='catalog.json')){
  const catalog=await readPart('catalog.json'),ids=new Set((catalog.accounts??[]).map(a=>a.id));
  if([...parts.authors,...parts.otherAuthors].some(a=>a.targetIds.some(id=>!ids.has(id))))throw Error('foundation-account-link-conflict');
 }
 if(manifest.files.some(f=>f.path==='creator/index.json')){
  const creator=await readPart('creator/index.json');
  if(index.stats.baseAuthors!==creator.stats.authors||index.stats.baseWorks!==creator.stats.works)throw Error('foundation-creator-edition-conflict');
 }
 return {revision:index.revision,authors:parts.authors.length,works:parts.works.length,observations:parts.observations.length};
}
