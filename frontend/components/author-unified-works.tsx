"use client";
import {useEffect,useMemo,useState} from 'react';
import {Dialog,DialogContent,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {UnifiedWorkMetric} from '@/components/unified-work-metric';
import {AuthorDailyPublishing} from '@/components/author-daily-publishing';
import {authorDailyPublication,publicationBusinessDay} from '@/lib/author-daily-publication.mjs';
import {readSourceParts,sourcePartsIdentity} from '@/lib/source-part-reader.mjs';
import {readReplicaPart} from '@/lib/replica-reader.mjs';
import {mergeAuthorWorks,orderAuthorWorks,authorWorkExportRows} from '@/lib/author-unified-works.mjs';
import {summarizeAdoptedWorks} from '@/lib/work-metric-adoption.mjs';
import {readLiveSourceWorkOwners,readLiveFoundationWorkOwners} from '@/lib/source-work-owner-contract.mjs';
import {csv} from '@/lib/replica-model.mjs';
type Row=Record<string,any>;
export function AuthorUnifiedWorks({author,manifest,source,foundation,preverified,workOwnerProjection,onOpenAccount,returnFocus,onClose}:{author:Row;manifest:Row;source:Row|null;foundation:Row|null;preverified:Row|null;workOwnerProjection?:Row|null;onOpenAccount?:(targetId:number)=>void;returnFocus?:HTMLButtonElement|null;onClose:()=>void}){
 const [storedItems,setItems]=useState<Row[]|null>(null),[loadedGeneration,setLoadedGeneration]=useState(''),[error,setError]=useState(''),[retry,setRetry]=useState(0),[query,setQuery]=useState(''),[sort,setSort]=useState('publicationDay'),[direction,setDirection]=useState('desc'),[page,setPage]=useState(1);
 const items=loadedGeneration===manifest.asOf?storedItems:null;
 const [publicationDate,setPublicationDate]=useState(''),[onlyDay,setOnlyDay]=useState(false);
 const [readProgress,setReadProgress]=useState<{verifiedParts:number;totalParts:number}|null>(null);
 useEffect(()=>{const c=new AbortController();setItems(null);setError('');setPage(1);setReadProgress(null);
  if(!source||!foundation){setError('作者资料正在读取，请稍后重试。');return;}
  (async()=>{
   const files=source.files.filter((f:Row)=>f.path.startsWith('works-'));
   const identity=sourcePartsIdentity(files,String(source.revision),'/creator-source/');
   const base:Row[]=[];
   if(preverified?.identity===identity){base.push(...preverified.items);setReadProgress({verifiedParts:files.length,totalParts:files.length});}
   else base.push(...await readSourceParts(files,String(source.revision),c.signal,'/creator-source/',{
    onProgress:(progress:{verifiedParts:number;totalParts:number})=>{if(!c.signal.aborted)setReadProgress(progress);},
   }));
   if(base.length!==source.stats.works)throw Error('作品目录条数校验失败');
   const workOwners=readLiveSourceWorkOwners(workOwnerProjection,source,base);
   const foundationWorkOwners=readLiveFoundationWorkOwners(workOwnerProjection,foundation,manifest.asOf);
   const platform:Row[]=[];
   for(const id of [...new Set(author.targetIds||[])]){
    const meta=manifest.files.find((f:Row)=>f.path===`works/${id}.json`);
    if(meta)platform.push(...(await readReplicaPart({generation:manifest.asOf,part:meta.path,meta,signal:c.signal})).items);
   }
   const rows=mergeAuthorWorks({author,sourceWorks:[...base,...(foundation.works||[])],platformWorks:platform,
    sourceObservations:foundation.observations||[],workOwners,foundationWorkOwners,asOf:manifest.asOf});
   if(!c.signal.aborted){setItems(rows);setLoadedGeneration(manifest.asOf);}
  })().catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();
 },[author,manifest,source,foundation,preverified,workOwnerProjection,retry]);
 const daily=useMemo(()=>{if(!items)return {model:null,error:''};try{return {model:authorDailyPublication(items,{asOf:manifest.asOf,date:publicationDate||publicationBusinessDay(manifest.asOf)}),error:''};}catch(e){return {model:null,error:(e as Error).message};}},[items,manifest.asOf,publicationDate]);
 const rows:Row[]=useMemo(()=>orderAuthorWorks(onlyDay?daily.model?.rows||[]:items||[],sort,direction,query),[items,daily.model,onlyDay,sort,direction,query]);
 const totals=useMemo(()=>summarizeAdoptedWorks(rows.filter(row=>!row.ownershipClaimOnly)),[rows]);
 const claims=items?.filter(row=>row.ownershipClaimOnly).length||0;
 function rank(field:string){setDirection(sort===field&&direction==='desc'?'asc':'desc');setSort(field);setPage(1);}
 function exportRows(){const table=authorWorkExportRows(rows);const url=URL.createObjectURL(new Blob([csv(table)],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='作者全部作品.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 return <Dialog open onOpenChange={open=>{if(!open)onClose();}}><DialogContent className="history-dialog" onCloseAutoFocus={event=>{if(returnFocus?.isConnected){event.preventDefault();returnFocus.focus({preventScroll:true});}}}><DialogTitle>{author.name} · 全部已保存作品</DialogTitle><DialogDescription>相同作品 ID 只显示一次；已有作品与后续更新集中查看。累计指标不等于当天增长。</DialogDescription>
 <div className="panel-head"><span>{items?`共 ${items.length.toLocaleString('zh-CN')} 条 · 当前匹配 ${rows.length} 条`:'正在合并并核验作品…'}</span><Button variant="outline" disabled={!items||!!error} onClick={exportRows}>导出全部筛选作品</Button></div>
 {!!claims&&<p className="notice" role="status">全部记录中有 {claims.toLocaleString('zh-CN')} 条为原登记的归属声明，已核验发布者属于其他账号。记录保留在列表和导出中，未计入此作者的指标合计与每日发布数。</p>}
 {items&&!error&&(daily.model?<AuthorDailyPublishing model={daily.model} onlyDay={onlyDay} onDate={date=>{setPublicationDate(date);setPage(1);}} onFilter={enabled=>{setOnlyDay(enabled);setPage(1);}}/>:<p role="alert" className="error">{daily.error}<Button variant="outline" onClick={()=>{setPublicationDate('');setOnlyDay(false);setPage(1);}}>恢复版本截止日</Button></p>)}
 <Input aria-label="搜索此作者的全部作品" placeholder="搜索标题或作品 ID" value={query} onChange={e=>{setQuery(e.target.value);setPage(1);}}/>
 {items&&!error&&<div className="period-toolbar" aria-label="当前筛选作品指标合计">{[['likes','已知累计点赞'],['plays','已知播放字段']].map(([key,label])=>{const value=(totals as Row)[key];return <span key={key}>{label} <strong>{value.value===null?'—':value.value.toLocaleString('zh-CN')}</strong> · {value.known}/{totals.works} 条有值{value.conflicts?` · ${value.conflicts} 条待核对`:''}{value.overflow?' · 合计超出安全数值范围':''}</span>;})}</div>}
 {error?<div role="alert" className="error">{error}<Button variant="outline" onClick={()=>setRetry(n=>n+1)}>重试作品读取</Button></div>:!items?<p role="status">正在读取已保存的作品，未启动新采集。{readProgress&&<><br/>来源作品分区已核验 {readProgress.verifiedParts}/{readProgress.totalParts}{readProgress.verifiedParts===readProgress.totalParts?'；正在核对账号作品与合并结果。':''}</>}</p>:<><div className="table-scroll-shell"><table className="source-table"><thead><tr><th>作品</th>{[['publicationDay','发布日期'],['adoptedLikes','点赞'],['adoptedPlays','播放字段']].map(([key,label])=><th key={key} aria-sort={sort===key?(direction==='asc'?'ascending':'descending'):'none'}><Button variant="ghost" onClick={()=>rank(key)}>{label}{sort===key?(direction==='asc'?' ↑':' ↓'):' ↕'}</Button></th>)}</tr></thead><tbody>{rows.slice((page-1)*20,page*20).map((r:Row)=><tr key={r.externalId}><td><a href={`https://www.douyin.com/video/${r.externalId}`} target="_blank" rel="noopener noreferrer">{r.caption||'未记录标题'}</a><small>ID {r.externalId}</small>{r.ownershipClaimOnly&&<small>原登记归属声明 · 未计入此作者统计</small>}{r.canonicalOwnerTargetId&&onOpenAccount&&<Button variant="link" onClick={()=>onOpenAccount(r.canonicalOwnerTargetId)}>查看已核验发布者 →</Button>}</td><td>{r.publicationDay||'未记录'}</td><td><UnifiedWorkMetric work={r} metric="likes"/></td><td><UnifiedWorkMetric work={r} metric="plays"/></td></tr>)}</tbody></table></div>{!rows.length&&<p>没有符合当前条件的已保存作品。</p>}<div className="pager"><Button variant="outline" disabled={page<=1} onClick={()=>setPage(p=>p-1)}>上一页</Button><span>第 {page}/{Math.max(1,Math.ceil(rows.length/20))} 页</span><Button variant="outline" disabled={page*20>=rows.length} onClick={()=>setPage(p=>p+1)}>下一页</Button></div></>}
 <p className="meta">只展示已保存记录；有作品但缺少某项指标时显示 —。来源与观察时间可在各指标详情中核对。</p>
 </DialogContent></Dialog>;
}
