/** Read-only supplementary source projection from one monitor DB snapshot. */
import {clean,contentId,digest,identity,pendingSourceAuthors,tableFoundation} from './table-foundation.mjs';
import {canonicalSourceAuthors} from './creator-intelligence.mjs';
import {readCurrentCreatorSourceLinks} from './creator-source-current-links.mjs';
import {readStoredDouyinProfileIdentityMatches} from './profile-identity-proof.mjs';
import {readLatestSourceJobs} from './table-source-jobs.mjs';
import {readSupplementProfileIdentityLinks,submittedIdentity} from './supplement-profile-identity-links.mjs';
import {mergeUnifiedAccountRoster} from './unified-account-roster.mjs';
import {createPublicTextRedactor} from './public-text.mjs';
import {readUnifiedCreatorSourceCorpus} from './creator-source-corpus.mjs';
import {FOUNDATION_GROUPS,foundationRevisionPayload,foundationKind} from './replica-foundation.mjs';

const has=(db,table)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
const number=value=>{
 if(value==null||typeof value==='boolean'||typeof value==='object'||typeof value==='string'&&!value.trim())return null;
 const n=Number(value);return Number.isSafeInteger(n)&&n>=0?n:null;
};
const clock=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const safeStrings=(value,redact)=>{
 if(typeof value==='string')return (redact(value,300)||'').replace(/[<>]/g,' ').replace(/\/(?:Users|home|tmp|var)\/[^\s;,，；]+/g,'[本机路径已隐藏]');
 if(Array.isArray(value))return value.map(item=>safeStrings(item,redact));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,safeStrings(item,redact)]));
 return value;
};

/** The returned data is an output projection, not a new platform observation. */
export function readPublicTableFoundation(db,asOf,{rosterAccounts,sourceCorpus,masterRoster}={}) {
 const cutoff=clock(asOf);if(!cutoff||new Date(cutoff).toISOString()!==asOf)throw Error('invalid-foundation-clock');
 if(!has(db,'creator_source_imports'))return null;
 const imported=db.prepare('SELECT * FROM creator_source_imports WHERE julianday(imported_at)<=julianday(?) ORDER BY id DESC LIMIT 1').get(asOf);
 if(!imported)return null;
 const rows=sheet=>db.prepare('SELECT row_number,values_json FROM creator_source_rows WHERE import_id=? AND sheet_id=? ORDER BY row_number').all(imported.id,sheet);
 const rawBaseAuthors=rows('08').map(item=>{const row=JSON.parse(item.values_json);return {row:item.row_number,name:row[0],douyinId:row[1],posts:number(row[6]),plays:number(row[11]),likes:number(row[12]),targetIds:[]};});
 const unified=sourceCorpus?{source:sourceCorpus}:readUnifiedCreatorSourceCorpus(db,asOf);
 const baseWorks=(unified?.source.works??[]).map(work=>({contentId:work.contentId}));
 const {authors:baseAuthors,collapsed}=canonicalSourceAuthors(rawBaseAuthors);
 const sources=has(db,'author_resolution_jobs')?readLatestSourceJobs(db,asOf):[],targetIds=new Map();
 const append=(handle,id)=>{const key=submittedIdentity(handle);if(!key)return;const ids=targetIds.get(key)||[];if(!ids.includes(id))ids.push(id);targetIds.set(key,ids);};
 const currentLinks=sourceCorpus?.currentLinks??readCurrentCreatorSourceLinks(db,{imported,reference:asOf});
 for(const link of currentLinks.accountLinks)append(link.matched_id,link.target_id);
 const saved=readSupplementProfileIdentityLinks(db,{sources,reference:asOf,baseLinks:currentLinks.accountLinks});
 for(const link of saved.links)append(link.matched_id,link.target_id);
 const recorded=new Set(saved.recordedIds);
 const submitted=[...new Set(sources.flatMap(source=>source.request.rows.filter(row=>row?.platform==='douyin').map(row=>row.douyinId)).filter(value=>typeof value==='string'&&value.trim()))]
  .filter(value=>!recorded.has(submittedIdentity(value)));
 if(submitted.length){const proofs=readStoredDouyinProfileIdentityMatches(db,submitted,{reference:asOf});for(const proof of proofs.matches)append(proof.submittedAccountId,proof.targetId);}
 const foundation=tableFoundation({sources,baseAuthors,baseWorks,targetIds});
 if(rosterAccounts===undefined&&has(db,'master_roster_imports')){
  // Pending identities need the canonical roster, never every account's metric
  // history. Reuse its existing deduplication without building a whole report.
  const monitored=db.prepare("SELECT id,label,locator,enabled,metadata_json FROM targets WHERE type='account'").all().map(target=>{
   let metadata;try{metadata=JSON.parse(target.metadata_json||'{}');}catch{metadata={};}
   if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))metadata={};
   return {...target,platform:metadata.platform||'douyin',publicId:metadata.douyinId||'',enabled:!!target.enabled};
  });
  rosterAccounts=mergeUnifiedAccountRoster(db,monitored,masterRoster===undefined?{}:{roster:masterRoster}).accounts;
 }
 const pendingAuthors=pendingSourceAuthors({rosterAccounts:rosterAccounts??[],baseAuthors,supplementAuthors:foundation.authors});
 const observations=[],baseIds=new Set(baseWorks.map(row=>contentId(row.contentId)).filter(Boolean)),extraIds=new Set(foundation.works.map(row=>row.contentId));
 const sheet=has(db,'creator_source_sheets')?db.prepare("SELECT headers_json FROM creator_source_sheets WHERE import_id=? AND sheet_id='10'").get(imported.id):null;
 let header;try{header=JSON.parse(sheet?.headers_json||'[]')[13];}catch{header=null;}
 const timeBasis=['指标采样时间','数据采样时间','采样时间','观测时间'].includes(header)?'metric-observation'
  :['提交时间','登记时间'].includes(header)?'submission-time':'unknown';
 for(const entry of rows('10')){
  const row=JSON.parse(entry.values_json),id=contentId(row[5]);if(!id)continue;
  const recordedAt=clock(row[13]),observedAt=timeBasis==='metric-observation'?recordedAt:null;
  // A future or absent measurement clock is never replaced by this export's clock.
  if(recordedAt&&Date.parse(recordedAt)>Date.parse(asOf))continue;
  observations.push({contentId:id,author:clean(row[2],160),douyinId:clean(row[3],120),likes:number(row[8]),plays:number(row[9]),observedAt,recordedAt,timeBasis,sourceRow:entry.row_number});
  if(!baseIds.has(id)&&!extraIds.has(id)){
   foundation.works.push({contentId:id,author:clean(row[2],160),douyinId:clean(row[3],120),publishDate:null,type:null,track:null,tracks:null,plays:null,likes:null,title:null,url:null,evidenceRows:1,sourceTitles:['10_切片激励来源观测']});extraIds.add(id);
  }
 }
 foundation.works.sort((a,b)=>a.contentId.localeCompare(b.contentId));
 Object.assign(foundation.stats,{additionalWorks:foundation.works.length,sourceMetricObservations:observations.length,sourceMetricWorkIds:new Set(observations.map(row=>row.contentId)).size});
 const sheetCoverage=has(db,'creator_source_sheets')?db.prepare('SELECT sheet_id,sheet_name,row_count,restricted FROM creator_source_sheets WHERE import_id=? ORDER BY sheet_id').all(imported.id).map(sheet=>({id:sheet.sheet_id,name:sheet.restricted?'受限原始表':clean(sheet.sheet_name,100),rows:sheet.row_count,restricted:!!sheet.restricted})):[];
 const locators=has(db,'targets')?db.prepare("SELECT locator FROM targets WHERE type='account'").all().map(t=>String(t.locator??'')).filter(Boolean):[];
 const redact=createPublicTextRedactor(locators);
 const items=safeStrings({authors:foundation.authors,works:foundation.works,sources:foundation.sources,observations,otherAuthors:foundation.otherAuthors,otherWorks:foundation.otherWorks,pendingAuthors},redact);
 const stats={...foundation.stats,baseAuthorRows:rawBaseAuthors.length,reciprocalDuplicates:collapsed.length,baseAuthors:baseAuthors.length,baseWorks:baseWorks.length,sheets:sheetCoverage.length,pendingAuthors:pendingAuthors.length};
 const output={generatedAt:asOf,linkMode:'current-strict',linkFingerprint:currentLinks.fingerprint,stats,sheetCoverage:safeStrings(sheetCoverage,redact),...items};
 return {revision:digest(foundationRevisionPayload(output,items)),...output};
}

export function tableFoundationPartitions(db,asOf,options){
 const corpus=options&&Object.hasOwn(options,'foundation')?options.foundation:readPublicTableFoundation(db,asOf,options);if(!corpus)return [];
 if(corpus.generatedAt!==asOf)throw Error('invalid-foundation-clock');
 const fields={authors:'authors',works:'works',sources:'sources',observations:'observations','other-authors':'otherAuthors','other-works':'otherWorks','pending-authors':'pendingAuthors'};
 const parts=[],files=[];
 for(const name of FOUNDATION_GROUPS){const items=corpus[fields[name]],path='foundation/'+name+'.json',body={revision:corpus.revision,items};
  const content=JSON.stringify({version:1,asOf,timeZone:'Asia/Shanghai',...body})+'\n';
  parts.push({path,kind:foundationKind(path),count:items.length,...body});
  files.push({path:name+'.json',count:items.length,bytes:Buffer.byteLength(content),sha256:digest(content),generation:asOf});
 }
 const count=files.reduce((sum,f)=>sum+f.count,0);
 parts.unshift({path:'foundation/index.json',kind:'foundationIndex',count,revision:corpus.revision,generatedAt:asOf,
  linkMode:corpus.linkMode,linkFingerprint:corpus.linkFingerprint,stats:corpus.stats,sheetCoverage:corpus.sheetCoverage,files,
  semantics:{authors:'补充来源按明确账号标识去重并进入统一名册；昵称不作为身份依据',pendingAuthors:'保留尚未监控的来源作者及原始行证据；缺测不补零',works:'按作品ID与主作品集去重；无作品ID的原始记录仍保留在私有来源',metrics:'按原始表头区分采样、提交与未知时间；提交或读取时间不是指标采样时间，未定时累计值不冒充每日增长',privacy:'仅公开必要身份、来源标题与作品指标；不公开原始行、授权、奖金或登录态'}});
 return parts;
}
