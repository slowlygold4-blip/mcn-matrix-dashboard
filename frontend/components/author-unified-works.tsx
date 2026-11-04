"use client";
import {useEffect,useMemo,useRef,useState} from 'react';
import {Dialog,DialogContent,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {UnifiedWorkMetric} from '@/components/unified-work-metric';
import {AuthorDailyPublishing} from '@/components/author-daily-publishing';
import {WorkLikesHistory} from '@/components/work-likes-history';
import {authorDailyPublication,publicationBusinessDay} from '@/lib/author-daily-publication.mjs';
import {readSourceParts,sourcePartsIdentity} from '@/lib/source-part-reader.mjs';
import {readReplicaPart} from '@/lib/replica-reader.mjs';
import {mergeAuthorWorks,orderAuthorWorks,authorWorkExportRows} from '@/lib/author-unified-works.mjs';
import {summarizeAdoptedWorks} from '@/lib/work-metric-adoption.mjs';
import {readLiveSourceWorkOwners,readLiveFoundationWorkOwners} from '@/lib/source-work-owner-contract.mjs';
import {csv} from '@/lib/replica-model.mjs';
type Row=Record<string,any>;
type HistorySelection={generation:string;work:Row;account:Row};
type HistoryRead={scope:string;items:Row[]|null;error:string};
export function AuthorUnifiedWorks({author,accounts=[],manifest,source,foundation,preverified,workOwnerProjection,onOpenAccount,returnFocus,onClose}:{author:Row;accounts?:Row[];manifest:Row;source:Row|null;foundation:Row|null;preverified:Row|null;workOwnerProjection?:Row|null;onOpenAccount?:(targetId:number)=>void;returnFocus?:HTMLButtonElement|null;onClose:()=>void}){
 const [storedItems,setItems]=useState<Row[]|null>(null),[loadedGeneration,setLoadedGeneration]=useState(''),[error,setError]=useState(''),[retry,setRetry]=useState(0),[query,setQuery]=useState(''),[sort,setSort]=useState('publicationDay'),[direction,setDirection]=useState('desc'),[page,setPage]=useState(1);
 const items=loadedGeneration===manifest.asOf?storedItems:null;
 const [publicationDate,setPublicationDate]=useState(''),[onlyDay,setOnlyDay]=useState(false);
 const [readProgress,setReadProgress]=useState<{verifiedParts:number;totalParts:number}|null>(null);
 const [historySelection,setHistorySelection]=useState<HistorySelection|null>(null),[historyRead,setHistoryRead]=useState<HistoryRead|null>(null),[historyRetry,setHistoryRetry]=useState(0);
 const dialogRef=useRef<HTMLDivElement>(null),listTableRef=useRef<HTMLDivElement>(null),historyBackRef=useRef<HTMLButtonElement>(null);
 const listPosition=useRef({top:0,left:0,trigger:null as HTMLButtonElement|null}),pendingFocus=useRef<'history'|'list'|null>(null);
 const selected=items&&historySelection?.generation===manifest.asOf?historySelection:null;
 const historyMeta=selected?manifest.files.find((f:Row)=>f.path===`work-metrics/${selected.account.id}.json`):null;
 const historyScope=selected?[manifest.asOf,selected.account.id,selected.work.id,selected.work.externalId,historyMeta?.sha256??'absent'].join('|'):'';
 const currentHistory=historyRead?.scope===historyScope?historyRead:null;
 useEffect(()=>{const c=new AbortController();setItems(null);setError('');setPage(1);setReadProgress(null);setHistorySelection(null);setHistoryRead(null);pendingFocus.current=null;
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
 useEffect(()=>{
  if(!selected)return;
  const controller=new AbortController(),scope=historyScope;setHistoryRead({scope,items:null,error:''});
  if(!historyMeta){setHistoryRead({scope,items:[],error:''});return()=>controller.abort();}
  readReplicaPart({generation:selected.generation,part:historyMeta.path,meta:historyMeta,signal:controller.signal}).then((part:Row)=>{
   if(controller.signal.aborted)return;
   if(part.items.some((row:Row)=>row.workId===selected.work.id&&row.externalId!==selected.work.externalId))throw Error('作品历史与所选作品身份不一致，已停止显示');
   setHistoryRead({scope,items:part.items,error:''});
  }).catch((e:Error)=>{if(!controller.signal.aborted)setHistoryRead({scope,items:null,error:e.message});});
  return()=>controller.abort();
 },[selected,historyScope,historyMeta,historyRetry]);
 useEffect(()=>{
  if(pendingFocus.current==='history'&&selected){pendingFocus.current=null;historyBackRef.current?.focus({preventScroll:true});if(dialogRef.current)dialogRef.current.scrollTop=0;}
  else if(pendingFocus.current==='list'&&!selected){pendingFocus.current=null;listPosition.current.trigger?.focus({preventScroll:true});if(dialogRef.current)dialogRef.current.scrollTop=listPosition.current.top;if(listTableRef.current)listTableRef.current.scrollLeft=listPosition.current.left;}
 },[selected]);
 const daily=useMemo(()=>{if(!items)return {model:null,error:''};try{return {model:authorDailyPublication(items,{asOf:manifest.asOf,date:publicationDate||publicationBusinessDay(manifest.asOf)}),error:''};}catch(e){return {model:null,error:(e as Error).message};}},[items,manifest.asOf,publicationDate]);
 const rows:Row[]=useMemo(()=>orderAuthorWorks(onlyDay?daily.model?.rows||[]:items||[],sort,direction,query),[items,daily.model,onlyDay,sort,direction,query]);
 const totals=useMemo(()=>summarizeAdoptedWorks(rows.filter(row=>!row.ownershipClaimOnly)),[rows]);
 const claims=items?.filter(row=>row.ownershipClaimOnly).length||0;
 function historyAccount(row:Row){
  if(row.ownershipClaimOnly||row.source==='creator-source'||!Number.isSafeInteger(row.id)||row.id<1||!Number.isSafeInteger(row.targetId)||row.targetId<1
   ||!(author.targetIds||[]).includes(row.targetId)||!/^\d{15,25}$/.test(row.externalId??'')||row.canonicalOwnerTargetId!=null&&row.canonicalOwnerTargetId!==row.targetId)return null;
  return accounts.find(account=>account.id===row.targetId&&account.platform==='douyin'&&typeof account.label==='string'&&account.label.length>0)??null;
 }
 function inspectHistory(row:Row,trigger:HTMLButtonElement){
  const account=historyAccount(row);if(!account)return;
  listPosition.current={top:dialogRef.current?.scrollTop||0,left:listTableRef.current?.scrollLeft||0,trigger};pendingFocus.current='history';
  setHistoryRead(null);setHistoryRetry(0);setHistorySelection({generation:manifest.asOf,work:row,account});
 }
 function returnToWorks(){pendingFocus.current='list';setHistorySelection(null);setHistoryRead(null);}
 function rank(field:string){setDirection(sort===field&&direction==='desc'?'asc':'desc');setSort(field);setPage(1);}
 function exportRows(){const table=authorWorkExportRows(rows);const url=URL.createObjectURL(new Blob([csv(table)],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='作者全部作品.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 return <Dialog open onOpenChange={open=>{if(!open)onClose();}}><DialogContent ref={dialogRef} className="history-dialog" onCloseAutoFocus={event=>{if(returnFocus?.isConnected){event.preventDefault();returnFocus.focus({preventScroll:true});}}}><DialogTitle>{author.name} · {selected?'作品每日点赞':'全部已保存作品'}</DialogTitle><DialogDescription>{selected?'展示此作品截至固定数据版本的全部点赞采样，不按作品发布日期筛选采样。':'相同作品 ID 只显示一次；已有作品与后续更新集中查看。累计指标不等于当天增长。'}</DialogDescription>
 {selected&&<div aria-label="所选作品点赞历史"><div className="panel-head"><Button ref={historyBackRef} variant="outline" onClick={returnToWorks}>返回作者作品列表</Button><strong>{selected.work.caption||selected.work.externalId}</strong></div><p className="meta">公开作品 ID {selected.work.externalId} · 账号 {selected.account.label} · 数据版本 {selected.generation}</p>
  {currentHistory?.error?<div role="alert" className="error">{currentHistory.error}<Button variant="outline" onClick={()=>setHistoryRetry(value=>value+1)}>重试点赞历史</Button></div>:!currentHistory?.items?<p role="status">正在核验此作品的点赞历史…</p>:<WorkLikesHistory key={historyScope} records={currentHistory.items} account={selected.account} manifest={manifest} workId={selected.work.id}/>}
 </div>}
 <div hidden={!!selected}>
 <div className="panel-head"><span>{items?`共 ${items.length.toLocaleString('zh-CN')} 条 · 当前匹配 ${rows.length} 条`:'正在合并并核验作品…'}</span><Button variant="outline" disabled={!items||!!error} onClick={exportRows}>导出全部筛选作品</Button></div>
 {!!claims&&<p className="notice" role="status">全部记录中有 {claims.toLocaleString('zh-CN')} 条为原登记的归属声明，已核验发布者属于其他账号。记录保留在列表和导出中，未计入此作者的指标合计与每日发布数。</p>}
 {items&&!error&&(daily.model?<AuthorDailyPublishing model={daily.model} onlyDay={onlyDay} onDate={date=>{setPublicationDate(date);setPage(1);}} onFilter={enabled=>{setOnlyDay(enabled);setPage(1);}}/>:<p role="alert" className="error">{daily.error}<Button variant="outline" onClick={()=>{setPublicationDate('');setOnlyDay(false);setPage(1);}}>恢复版本截止日</Button></p>)}
 <Input aria-label="搜索此作者的全部作品" placeholder="搜索标题或作品 ID" value={query} onChange={e=>{setQuery(e.target.value);setPage(1);}}/>
 {items&&!error&&<div className="period-toolbar" aria-label="当前筛选作品指标合计">{[['likes','已知累计点赞'],['plays','已知播放字段']].map(([key,label])=>{const value=(totals as Row)[key];return <span key={key}>{label} <strong>{value.value===null?'—':value.value.toLocaleString('zh-CN')}</strong> · {value.known}/{totals.works} 条有值{value.conflicts?` · ${value.conflicts} 条待核对`:''}{value.overflow?' · 合计超出安全数值范围':''}</span>;})}</div>}
 {error?<div role="alert" className="error">{error}<Button variant="outline" onClick={()=>setRetry(n=>n+1)}>重试作品读取</Button></div>:!items?<p role="status">正在读取已保存的作品，未启动新采集。{readProgress&&<><br/>来源作品分区已核验 {readProgress.verifiedParts}/{readProgress.totalParts}{readProgress.verifiedParts===readProgress.totalParts?'；正在核对账号作品与合并结果。':''}</>}</p>:<><div ref={listTableRef} className="table-scroll-shell"><table className="source-table"><thead><tr><th>作品</th>{[['publicationDay','发布日期'],['adoptedLikes','点赞'],['adoptedPlays','播放字段']].map(([key,label])=><th key={key} aria-sort={sort===key?(direction==='asc'?'ascending':'descending'):'none'}><Button variant="ghost" onClick={()=>rank(key)}>{label}{sort===key?(direction==='asc'?' ↑':' ↓'):' ↕'}</Button></th>)}</tr></thead><tbody>{rows.slice((page-1)*20,page*20).map((r:Row)=><tr key={r.externalId}><td><a href={`https://www.douyin.com/video/${r.externalId}`} target="_blank" rel="noopener noreferrer">{r.caption||'未记录标题'}</a><small>ID {r.externalId}</small>{r.ownershipClaimOnly&&<small>原登记归属声明 · 未计入此作者统计</small>}{r.canonicalOwnerTargetId&&onOpenAccount&&<Button variant="link" onClick={()=>onOpenAccount(r.canonicalOwnerTargetId)}>查看已核验发布者 →</Button>}{historyAccount(r)?<Button variant="link" data-author-work-history={r.id} onClick={event=>inspectHistory(r,event.currentTarget)}>查看每日点赞</Button>:<small>暂无逐作品采样历史</small>}</td><td>{r.publicationDay||'未记录'}</td><td><UnifiedWorkMetric work={r} metric="likes"/></td><td><UnifiedWorkMetric work={r} metric="plays"/></td></tr>)}</tbody></table></div>{!rows.length&&<p>没有符合当前条件的已保存作品。</p>}<div className="pager"><Button variant="outline" disabled={page<=1} onClick={()=>setPage(p=>p-1)}>上一页</Button><span>第 {page}/{Math.max(1,Math.ceil(rows.length/20))} 页</span><Button variant="outline" disabled={page*20>=rows.length} onClick={()=>setPage(p=>p+1)}>下一页</Button></div></>}
 <p className="meta">只展示已保存记录；有作品但缺少某项指标时显示 —。来源与观察时间可在各指标详情中核对。</p>
 </div>
 </DialogContent></Dialog>;
}
