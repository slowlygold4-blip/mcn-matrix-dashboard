/** Merge source editions into the same work corpus. Never add duplicate counters. */
import { createHash } from 'node:crypto';
import { readKnownWorkSourceFacts, readWorkSourceEditions } from './work-source-store.mjs';
import { bindWorkFactsToStoredSourceIds } from './work-source-workbook.mjs';
import {readWorkLinkReceipts,bindWorkFactsToRedirects} from './work-source-link-receipts.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const norm=value=>String(value ?? '').normalize('NFKC').trim().toLowerCase();
const count=value=>Number.isSafeInteger(value) && value>=0 ? value : null;
const titles=new Map([['切片激励计划排名公示','切片激励'],['即梦二创大赛排名公示','即梦二创'],['创作激励计划排名公示','创作激励']]);
const tracks={'切片激励':'slice','即梦二创':'ai-remix','创作激励':'original'};
// This user-supplied register explicitly records slice works. Keep content
// classification separate from claiming participation in an incentive track.
const registerClassifications=new Map([['一条小团团ovo切片发布登记表','slice'],
 ['切片作者视频数据登记表','slice'],['创作者视频数据登记表','original'],['AI作者视频数据登记表','ai-remix']]);

export function workSourceFingerprint(db,asOf){
  return hash(JSON.stringify([readWorkSourceEditions(db,{asOf}).map(v=>[v.id,v.factsSha256]),
    readWorkLinkReceipts(db,{asOf}).filter(r=>r.status==='resolved').map(r=>r.sha256)]));
}

export function storedWorkLinkEvidence(db,importId){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='creator_source_sheets'").get())return [];
  const evidence=[];
  for(const [sheetId,idColumn,urlColumn] of [['10',5,7],['13',5,6]]){
    const sheet=db.prepare('SELECT headers_json FROM creator_source_sheets WHERE import_id=? AND sheet_id=?').get(importId,sheetId);
    const headers=sheet?JSON.parse(sheet.headers_json):[];
    if(headers[idColumn]!=='视频ID' || headers[urlColumn]!=='作品链接')continue;
    for(const row of db.prepare('SELECT row_number,values_json FROM creator_source_rows WHERE import_id=? AND sheet_id=?').iterate(importId,sheetId)){
      const values=JSON.parse(row.values_json);
      if(typeof values[idColumn]==='number' && !Number.isSafeInteger(values[idColumn]))continue;
      evidence.push({contentId:String(values[idColumn] ?? ''),url:values[urlColumn],provenance:{importId,sheetId,row:row.row_number,rowSha256:hash(row.values_json)}});
    }
  }
  return evidence;
}

/** Version time orders source editions, not platform measurement instants.
 * Only editions newer than the consolidated base can replace its counter.
 * Equally recent conflicting values remain unresolved; missing never becomes 0.
 */
function metric(baseValue,facts,field,baseModifiedAt){
  const known=facts.filter(f=>count(f[field])!==null);
  const newer=known.filter(f=>Date.parse(f.sourceModifiedAt)>Date.parse(baseModifiedAt));
  const pool=newer.length?newer.filter(f=>f.sourceModifiedAt===newer.map(f=>f.sourceModifiedAt).sort().at(-1))
    : baseValue==null?known:[];
  const values=[...new Set(pool.map(f=>f[field]))];
  return values.length===1 ? values[0] : baseValue;
}

export function mergeWorkSourceFacts(works,authors,source,{baseModifiedAt,storedLinks=[],linkReceipts=[]}={}){
  const canonicalIds=new Set(works.map(w=>w.contentId).filter(Boolean));
  const binding=bindWorkFactsToStoredSourceIds(source.facts,storedLinks,canonicalIds);
  const redirects=bindWorkFactsToRedirects(binding.facts,linkReceipts);
  const versions=new Map(source.versions.map(v=>[v.sourceUrl,v]));
  const grouped=new Map(),unresolved=[];
  for(const fact of redirects.facts){
    if(!/^\d{16,22}$/.test(fact.contentId || '') || fact.bindingIssues?.length){unresolved.push(fact);continue;}
    if(!grouped.has(fact.contentId))grouped.set(fact.contentId,[]);
    grouped.get(fact.contentId).push(fact);
  }
  const authorIds=new Map();
  for(const author of authors){const id=norm(author.accountId);if(!id)continue;
    if(!authorIds.has(id))authorIds.set(id,[]);authorIds.get(id).push(author);}
  const result=works.map(w=>({...w})),byId=new Map(result.map(w=>[w.contentId,w]));
  const usedRows=new Map(result.map(w=>[w.sourceRow,w.contentId]));
  let added=0,updated=0;
  for(const [id,facts] of grouped){
    let work=byId.get(id);
    if(!work){
      const handles=[...new Set(facts.map(f=>norm(f.accountId)).filter(Boolean))];
      const candidates=handles.length===1 ? authorIds.get(handles[0]) || [] : [];
      const author=candidates.length===1 ? candidates[0] : null;
      // A deterministic positive row surrogate keeps existing API detail keys
      // stable without mutating the immutable consolidated workbook rows.
      const sourceRow=Number.parseInt(hash(id).slice(0,13),16)+1_000_000;
      if(usedRows.has(sourceRow) && usedRows.get(sourceRow)!==id)throw Error('work-source-row-key-collision');
      usedRows.set(sourceRow,id);
      const names=[...new Set(facts.map(f=>f.authorName).filter(Boolean))];
      work={key:id,contentId:id,sourceRow,authorKey:author?.key ?? null,authorName:author?.name || (names.length===1?names[0]:''),
        accountId:author?.accountId || (handles.length===1?handles[0]:''),targetId:author?.targetId ?? null,
        publishedOn:'',dateSource:'unknown',contentType:'video',primaryTrack:'',tracks:[],classifications:[],
        cumulativePlays:null,cumulativeLikes:null,title:'',url:`https://www.douyin.com/video/${id}`,
        sourceRecordCount:0,sourceReferences:[],sourceUrl:null,recordOrigin:'source-only'};
      result.push(work);byId.set(id,work);added++;
    }
    const before=[work.cumulativePlays,work.cumulativeLikes];
    work.cumulativePlays=metric(work.cumulativePlays,facts,'plays',baseModifiedAt);
    work.cumulativeLikes=metric(work.cumulativeLikes,facts,'likes',baseModifiedAt);
    if(before[0]!==work.cumulativePlays || before[1]!==work.cumulativeLikes)updated++;
    const dates=[...new Set(facts.map(f=>f.publishedOn).filter(Boolean))];
    if(dates.length===1&&(!work.publishedOn||['unknown','source_inferred_publication_date'].includes(work.dateSource))){
      if(work.publishedOn)work.sourceInferredPublishedOn??=work.publishedOn;
      work.publishedOn=dates[0];work.dateSource='source-explicit-publication-date';
    }else if(work.publishedOn&&(dates.length>1||dates.length===1&&work.dateSource==='source-explicit-publication-date'&&dates[0]!==work.publishedOn)){
      work.sourcePublicationDateConflict=true;
      if(work.dateSource!=='platform-published-at')work.dateSource='source-publication-date-conflict';
    }
    const explicitTracks=facts.map(f=>titles.get(versions.get(f.sourceUrl)?.report?.source?.title)).filter(Boolean);
    work.tracks=[...new Set([...work.tracks,...explicitTracks])];
    work.classifications=[...new Set([...work.classifications,...explicitTracks.map(t=>tracks[t])])];
    const registeredTypes=facts.map(f=>registerClassifications.get(versions.get(f.sourceUrl)?.report?.source?.title)).filter(Boolean);
    work.classifications=[...new Set([...work.classifications,...registeredTypes])];
    if(!work.primaryTrack && work.tracks.length===1)work.primaryTrack=work.tracks[0];
    if(!work.title){const names=[...new Set(facts.map(f=>f.title).filter(Boolean))];if(names.length===1)work.title=names[0];}
    work.sourceEditionEvidence=facts.map(f=>({versionId:f.sourceVersionId,url:f.sourceUrl,revision:f.sourceRevision,
      sheet:f.sheet,row:f.row,rowSha256:f.rowSha256,readAt:f.sourceReadAt,modifiedAt:f.sourceModifiedAt,
      measurementDate:f.metricDate,publishedOn:f.publishedOn,plays:f.plays,likes:f.likes,
      presentInLatestEdition:f.presentInLatestEdition,representation:f.representation,
      metricIssues:f.metricIssues,identityIssues:f.identityIssues,
      ...(f.dateIssues?.length?{dateIssues:f.dateIssues,rawDateValues:f.rawDateValues}:{}),
      ...(f.publicationDateResolution?{publicationDateResolution:f.publicationDateResolution}:{}),
      ...(f.contentIdEvidence?{contentIdEvidence:f.contentIdEvidence}:{})}));
    work._search=norm([work.contentId,work.authorName,work.accountId,work.title].join(' '));
  }
  return {works:result,summary:{versions:source.versions.length,sourceFacts:source.facts.length,identifiedWorks:grouped.size,
    addedWorks:added,updatedWorks:updated,unresolvedFacts:unresolved.length,binding:binding.summary,
    redirectBinding:redirects.summary},fingerprint:hash(JSON.stringify([source.fingerprint,
      linkReceipts.filter(r=>r.status==='resolved').map(r=>r.sha256)]))};
}

export function readWorkSourceOverlay(db,{imported,works,authors,asOf}){
  const source=readKnownWorkSourceFacts(db,{asOf});
  return mergeWorkSourceFacts(works,authors,source,{baseModifiedAt:imported.source_modified_at,
    storedLinks:storedWorkLinkEvidence(db,imported.id),linkReceipts:readWorkLinkReceipts(db,{asOf})});
}
