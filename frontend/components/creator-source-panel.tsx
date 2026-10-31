"use client";
import {sourceRegistrationLabel} from '@/lib/tuantuan-roster.mjs';
import {useEffect,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {TableScrollFrame} from '@/components/table-scroll-frame';
import {filterSourceLedgerRows,sourceDateRangeError,sourceLedgerCsv,sourcePublicationDate,sourceLedgerRowKey} from '@/lib/source-ledger-filters.mjs';
import {sourceLedgerDefaults,sourceLedgerSelection,sourceLedgerSelectionPath,sourceLedgerShareLink} from '@/lib/source-ledger-navigation.mjs';
import {readSourcePart,readSourceParts,sourcePartsIdentity} from '@/lib/source-part-reader.mjs';
import './creator-source-filters.css';
import {sourceContentFilterOptions,sourceWorkClassificationLabel} from '@/lib/source-work-classification.mjs';

type RecordRow=Record<string,any>;
type SourceSelection={view:'authors'|'works';query:string;track:string;linkage:'all'|'linked'|'sourceOnly';sort:string;page:number;startDate:string;endDate:string;mainTableOnly:boolean;authorFocus:{name:string;douyinId:string;douyinIds?:string[]}|null;returnSelection:SourceSelection|null};
type SourceFocusRequest={selection:SourceSelection;href:string;revision:string;trigger:Element|null;authorId:string;rowKey:string|null;returnPosition:{x:number;y:number}|null};
const fmt=(value:number|null|undefined)=>value==null?'—':value.toLocaleString('zh-CN');
const date=(value:string)=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未知';
const sourceRoot='/creator-source/';
export async function readCreatorSourcePart(file:RecordRow,revision:string,signal:AbortSignal,root=sourceRoot){
 return readSourcePart(file,revision,signal,root) as Promise<RecordRow[]>;
}
export function CreatorSourceSummary({source,onOpen}:{source:RecordRow|null;onOpen:()=>void}){
 if(!source)return <section className="source-summary panel"><p className="meta">正在核对团团表格来源…</p></section>;
 return <section className="source-summary panel" aria-label="团团表格来源数据"><div className="panel-head"><div><p className="eyebrow">TUANTUAN · SOURCE LEDGER</p><h2>团团作者与作品</h2></div><Button onClick={onOpen}>查看全部作者与作品</Button></div>
 <p className="meta">表格修订 {source.revision} · 入库 {date(source.importedAt)}（北京）· 与平台每日采样并列，不把累计成绩当作今日增长。</p>
 <div className="source-stat-grid"><div><small>总表登记身份</small><strong>{fmt(source.stats.authors)}</strong></div><div><small>去重作品</small><strong>{fmt(source.stats.works)}</strong></div><div><small>作品累计播放·表格</small><strong>{fmt(source.stats.cumulativePlays)}</strong></div><div><small>作品累计点赞·表格</small><strong>{fmt(source.stats.cumulativeLikes)}</strong></div></div>
 <div className="source-tracks">{source.tracks.map((track:RecordRow)=><span key={track.name}>{track.name} <b>{fmt(track.works)}</b> 条</span>)}</div>
 <p className="meta">赛道按来源标签归属统计，同一作品可能出现在多类中；全部作品仍按 ID 去重。</p>
 <p className="meta">{fmt(source.stats.linkedAuthors)} 位登记身份与平台监控账号有精确关联；其余保留表格原始身份，不凭昵称强行合并。登记身份数不等于跨表去重作者数，作品累计播放不是区间新增播放。</p></section>;
}
export function CreatorSourceLedger({source,sourceError='',onRetrySource,foundation:providedFoundation,foundationState,foundationError='',onRetryFoundation,accounts,onOpenAccount,authorDirectory,preverified,rosterReturn,focus,addressMode=false,active=true}:{source:RecordRow|null;sourceError?:string;onRetrySource?:()=>void;foundation:RecordRow|null;foundationState?:'loading'|'ready'|'error';foundationError?:string;onRetryFoundation?:()=>void;accounts:RecordRow[];onOpenAccount:(account:RecordRow,trigger:HTMLButtonElement)=>void;authorDirectory?:RecordRow[];preverified?:{authors:{identity:string;items:RecordRow[]};works:{identity:string;items:RecordRow[]}}|null;rosterReturn?:{authorId:string;onReturn:()=>void};addressMode?:boolean;active?:boolean;focus?:{view:'authors'|'works';query?:string;track?:string;linkage?:'all'|'linked'|'sourceOnly';startDate?:string;endDate?:string;mainTableOnly?:boolean;author?:{name:string;douyinId:string;douyinIds?:string[]}}|null}){
 const [selection,setSelection]=useState<SourceSelection>({...sourceLedgerDefaults} as SourceSelection);
 const {view,query,track,linkage,sort,page,startDate,endDate,mainTableOnly,authorFocus}=selection;
 const [authors,setAuthors]=useState<{identity:string;items:RecordRow[]}|null>(null),[works,setWorks]=useState<{identity:string;items:RecordRow[]}|null>(null);
 const foundation=foundationState!==undefined&&foundationState!=='ready'?null:providedFoundation;
 const supplementalPending=foundationState!==undefined&&(foundationState!=='ready'||!foundation);
 const mainOnly=view==='works'&&mainTableOnly;
 const datasetIncomplete=supplementalPending&&!mainOnly;
 const selectedFiles=useMemo(()=>(source?.files as RecordRow[]??[]).filter(file=>view==='authors'?file.path==='authors.json':file.path.startsWith('works-')),[source,view]);
 const partsIdentity=useMemo(()=>source?sourcePartsIdentity(selectedFiles,String(source.revision),sourceRoot):'',[source,selectedFiles]);
 const authorFiles=useMemo(()=>(source?.files as RecordRow[]??[]).filter(file=>file.path==='authors.json'),[source]);
 const authorIdentity=source?sourcePartsIdentity(authorFiles,String(source.revision),sourceRoot):'';
 const authorParts=preverified?.authors?.identity===authorIdentity?preverified.authors:authors;
 const workParts=view==='works'&&preverified?.works?.identity===partsIdentity?preverified.works:works;
 const [error,setError]=useState(''),[retry,setRetry]=useState(0),[exportStatus,setExportStatus]=useState(''),[addressError,setAddressError]=useState(''),[copyStatus,setCopyStatus]=useState(''),[manualLink,setManualLink]=useState('');
 const currentSelection=useRef(selection);currentSelection.current=selection;
 const ledgerRef=useRef<HTMLElement|null>(null),authorContextRef=useRef<HTMLDivElement|null>(null);
 const pendingFocus=useRef<SourceFocusRequest|null>(null),activeRef=useRef(active);activeRef.current=active;
 const authorReturn=useRef<{authorId:string;rowKey:string;selectionKey:string;x:number;y:number}|null>(null);
 function changeSelection(patch:Partial<SourceSelection>,mode:'replace'|'push'='replace',resetPage=true){
  pendingFocus.current=null;
  const next={...currentSelection.current,...(resetPage?{page:1}:{}),...patch};
  if(next.view==='authors'||!next.authorFocus){next.authorFocus=null;next.returnSelection=null;}
  if(addressMode){try{const path=sourceLedgerSelectionPath(window.location.pathname+window.location.search+window.location.hash,next);window.history[mode==='push'?'pushState':'replaceState'](window.history.state,'',path);}catch(e){setAddressError((e as Error).message);return;}}
  currentSelection.current=next;setSelection(next);setAddressError('');setExportStatus('');setCopyStatus('');setManualLink('');
  return next;
 }
 const setQuery=(value:string)=>changeSelection({query:value}),setTrack=(value:string)=>changeSelection({track:value}),setLinkage=(value:SourceSelection['linkage'])=>changeSelection({linkage:value}),setSort=(value:string)=>changeSelection({sort:value}),setPage=(value:number)=>changeSelection({page:value},'replace',false);
 const setStartDate=(value:string)=>changeSelection({startDate:value}),setEndDate=(value:string)=>changeSelection({endDate:value}),setMainTableOnly=(value:boolean)=>changeSelection({mainTableOnly:value});
 useEffect(()=>{if(!addressMode||!active)return;const restore=()=>{pendingFocus.current=null;try{const next=sourceLedgerSelection(window.location.search) as SourceSelection;currentSelection.current=next;setSelection(next);setAddressError('');setExportStatus('');setCopyStatus('');setManualLink('');}catch(e){setAddressError((e as Error).message);}};restore();window.addEventListener('popstate',restore);window.addEventListener('hashchange',restore);return()=>{window.removeEventListener('popstate',restore);window.removeEventListener('hashchange',restore);};},[addressMode,active]);
 useEffect(()=>{if(!focus)return;changeSelection({...sourceLedgerDefaults,...focus,authorFocus:focus.author??null,returnSelection:null} as SourceSelection);},[focus]);
 function requestFocus(next:SourceSelection|undefined,authorId:string,trigger:Element|null,returnPosition:SourceFocusRequest['returnPosition']=null,rowKey:string|null=null){
  if(next&&activeRef.current)pendingFocus.current={selection:next,href:window.location.href,revision:String(source?.revision??''),trigger,authorId,rowKey,returnPosition};
 }
 function showAuthorWorks(row:RecordRow,trigger:HTMLButtonElement){
  const douyinId=String(row.douyinId??'').trim();if(!douyinId)return;
  const previous={...selection,returnSelection:null};
  authorReturn.current={authorId:douyinId,rowKey:sourceLedgerRowKey(row,'authors'),selectionKey:JSON.stringify(previous),x:window.scrollX,y:window.scrollY};
  const next=changeSelection({authorFocus:{name:String(row.name||row.author||'未命名作者'),douyinId,...(Array.isArray(row.douyinIds)?{douyinIds:row.douyinIds}:{})},returnSelection:previous,query:'',view:'works'},'push');
  requestFocus(next,douyinId,trigger);
 }
 function returnToAuthor(){
  if(!authorFocus)return;
  const authorId=authorFocus.douyinId,trigger=document.activeElement,saved=authorReturn.current;
  const next=changeSelection(selection.returnSelection??{...sourceLedgerDefaults,query:authorId} as SourceSelection,'push',false);
  const sameReturn=saved?.authorId===authorId&&JSON.stringify(next)===saved.selectionKey;
  requestFocus(next,authorId,trigger,sameReturn?{x:saved.x,y:saved.y}:null,sameReturn?saved.rowKey:null);
 }
 // Cancel deferred focus as soon as another user action or route takes ownership.
 // Capture listeners run before the click that creates a new request.
 useEffect(()=>{
  const cancel=()=>{pendingFocus.current=null;};
  const changedFocus=(event:FocusEvent)=>{if(pendingFocus.current&&event.target!==pendingFocus.current.trigger)cancel();};
  const hidden=()=>{if(document.hidden)cancel();};
  document.addEventListener('focusin',changedFocus,true);document.addEventListener('pointerdown',cancel,true);document.addEventListener('keydown',cancel,true);document.addEventListener('visibilitychange',hidden);
  document.addEventListener('wheel',cancel,{capture:true,passive:true});document.addEventListener('touchstart',cancel,{capture:true,passive:true});
  window.addEventListener('popstate',cancel);window.addEventListener('hashchange',cancel);
  return()=>{cancel();document.removeEventListener('focusin',changedFocus,true);document.removeEventListener('pointerdown',cancel,true);document.removeEventListener('keydown',cancel,true);document.removeEventListener('visibilitychange',hidden);document.removeEventListener('wheel',cancel,true);document.removeEventListener('touchstart',cancel,true);window.removeEventListener('popstate',cancel);window.removeEventListener('hashchange',cancel);};
 },[]);
 async function copySelection(){try{const href=sourceLedgerShareLink(window.location.href,selection);setManualLink(href);try{await navigator.clipboard.writeText(href);setCopyStatus('已复制，打开链接可恢复当前筛选与页码。');setManualLink('');}catch{setCopyStatus('浏览器未允许自动复制，请选中下方链接手动复制。');}}catch(e){setCopyStatus((e as Error).message);}}
 useEffect(()=>{if(!source)return;let active=true;const controller=new AbortController();const files=selectedFiles;
 if((view==='authors'?authorParts:workParts)?.identity===partsIdentity){setError('');return;}
 setError('');(async()=>{try{const all=await readSourceParts(files,String(source.revision),controller.signal,sourceRoot);const expected=view==='authors'?source.stats.authors:source.stats.works;if(all.length!==expected)throw Error('来源记录总数不符');if(active)(view==='authors'?setAuthors:setWorks)({identity:partsIdentity,items:all});}catch(e){if(active&&!controller.signal.aborted)setError((e as Error).message);}})();return()=>{active=false;controller.abort();};},[source,view,authorParts,workParts,retry,selectedFiles,partsIdentity]);
 const list=useMemo(()=>{
  const loaded=view==='authors'?authorParts:workParts;
  if(!loaded||loaded.identity!==partsIdentity)return null;
  const base=loaded.items;
  const extra=view==='authors'?foundation?.authors:foundation?.works;
  return extra?[...base,...extra.map((row:RecordRow,index:number)=>({...row,row:base.length+index+1,sourceSupplement:true}))]:base;
 },[view,authorParts,workParts,foundation,partsIdentity]);
 const filteredWithoutDates=useMemo(()=>filterSourceLedgerRows(list??[],{view,query,track,linkage,sort,mainTableOnly,authorIds:authorFocus?(authorFocus.douyinIds??[authorFocus.douyinId]):[]}),[list,query,view,track,linkage,sort,mainTableOnly,authorFocus]);
 const dateError=view==='works'?sourceDateRangeError(startDate,endDate):'';
 const filtered=useMemo(()=>view==='authors'?filteredWithoutDates:filterSourceLedgerRows(filteredWithoutDates,{startDate,endDate,sort}),[filteredWithoutDates,view,startDate,endDate,sort]);
 const undatedCount=useMemo(()=>filteredWithoutDates.filter((row:RecordRow)=>!sourcePublicationDate(row.publishDate)).length,[filteredWithoutDates]);
 const pages=Math.max(1,Math.ceil(filtered.length/30)),selected=page;
 const waitingForPage=datasetIncomplete&&!!list&&page>pages;
 const selectionError=addressError||(source&&track!=='all'&&track!=='__unclassified__'&&!sourceContentFilterOptions.some(item=>item.key===track)&&!source.tracks.some((item:RecordRow)=>item.name===track)?'链接中的内容赛道不存在，请重新选择赛道。':'')||(list&&page>pages&&!waitingForPage?`当前筛选只有 ${pages} 页，链接请求第 ${page} 页。`:'');
 const shown=selectionError||dateError||error?[]:filtered.slice((selected-1)*30,selected*30);
 const observationsByWork=useMemo(()=>{const result=new Map<string,RecordRow[]>();for(const item of foundation?.observations||[]){const records=result.get(item.contentId)||[];records.push(item);result.set(item.contentId,records);}return result;},[foundation]);
 const pageHasObservations=!!list&&shown.some((row:RecordRow)=>(observationsByWork.get(row.contentId)?.length??0)>0);
 const accountById=useMemo(()=>new Map(accounts.map(account=>[account.id,account])),[accounts]);
 const focusedAuthorIds=useMemo(()=>new Set((authorFocus?[authorFocus.douyinId,...(authorFocus.douyinIds??[])]:[]).map(id=>String(id).trim()).filter(Boolean)),[authorFocus]);
 const authorContext=useMemo(()=>{
  if(!authorFocus||view!=='works')return null;
  // Never derive a whole-author count from the date, track, search, or page subset.
  const complete=!!list&&!error&&!selectionError&&!!foundation&&Array.isArray(foundation.works)&&(foundationState===undefined||foundationState==='ready');
  const archived=complete?new Set(list!.filter(row=>focusedAuthorIds.has(String(row.douyinId??'').trim())).map(row=>String(row.contentId??'').trim()).filter(Boolean)).size:null;
  const cachedAuthorsReady=source&&authorParts?.identity===authorIdentity;
  const directoryReady=authorDirectory!==undefined||cachedAuthorsReady;
  const directory=authorDirectory??(cachedAuthorsReady?authorParts!.items:[]);
  const matched=[...directory,...(foundation?.authors??[])].filter(row=>[row.douyinId,...(Array.isArray(row.douyinIds)?row.douyinIds:[])].some(id=>focusedAuthorIds.has(String(id??'').trim())));
  const targetIds=[...new Set<number>(matched.flatMap(row=>Array.isArray(row.targetIds)?row.targetIds:[]))];
  const linked=targetIds.map(id=>accountById.get(id)).filter((account):account is RecordRow=>!!account);
  return {archived,linked,missingAccounts:targetIds.length-linked.length,hasTarget:targetIds.length>0,associationPending:!directoryReady||!foundation||supplementalPending};
 },[authorFocus,view,list,error,selectionError,foundation,foundationState,source,authorParts,authorIdentity,authorDirectory,focusedAuthorIds,accountById,supplementalPending]);
 const canReturnToRoster=!!rosterReturn&&!!authorFocus&&!selection.returnSelection&&focusedAuthorIds.has(String(rosterReturn.authorId).trim());
 useEffect(()=>{
  const request=pendingFocus.current;if(!request)return;
  const current=()=>pendingFocus.current===request&&activeRef.current&&currentSelection.current===request.selection&&window.location.href===request.href&&String(source?.revision??'')===request.revision&&!document.hidden;
  if(!current()||error||selectionError){pendingFocus.current=null;return;}
  const frame=requestAnimationFrame(()=>{
   if(!current()||!ledgerRef.current||ledgerRef.current.closest('[hidden]')){pendingFocus.current=null;return;}
   const focused=document.activeElement;
   if(focused!==document.body&&focused!==document.documentElement&&focused!==request.trigger){pendingFocus.current=null;return;}
   let target:HTMLElement|null=selection.view==='works'?authorContextRef.current:null;
   if(selection.view==='authors'){
    const buttons=Array.from(ledgerRef.current.querySelectorAll<HTMLButtonElement>('[data-source-author]'));
    const candidates=buttons.filter(button=>button.dataset.sourceAuthor===request.authorId);
    target=request.rowKey?buttons.find(button=>button.dataset.sourceAuthorRow===request.rowKey)??null:candidates.length===1?candidates[0]:null;
    // A fresh/reloaded link may need to fetch authors first. Never focus a stale row.
    if(!target&&(!list||datasetIncomplete))return;
    target??=ledgerRef.current.querySelector<HTMLElement>('h2');
   }
   if(!target)return;
   pendingFocus.current=null;target.focus({preventScroll:true});
   if(document.activeElement!==target)return;
   if(request.returnPosition)window.scrollTo({left:request.returnPosition.x,top:request.returnPosition.y,behavior:'instant'});
   else target.scrollIntoView({block:'start',behavior:'instant'});
  });
  return()=>cancelAnimationFrame(frame);
 },[selection,list,active,source?.revision,error,selectionError,datasetIncomplete]);
 function exportFiltered(){
  if(!source||!list||dateError||error||selectionError||datasetIncomplete)return;
  const bytes=sourceLedgerCsv(filtered,view,{revision:String(source.revision),importedAt:String(source.importedAt??'')});
  const url=URL.createObjectURL(new Blob([bytes],{type:'text/csv;charset=utf-8'}));
  const anchor=document.createElement('a');anchor.href=url;anchor.download=`团团${view==='authors'?'作者':'作品'}-${mainOnly&&foundationState!==undefined?'总表-':''}${view==='works'&&(startDate||endDate)?`${startDate||'最早'}至${endDate||'最新'}`:'全部日期'}-筛选结果.csv`;anchor.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);setExportStatus(`已生成${mainOnly&&foundationState!==undefined?'总表':''}全部 ${fmt(filtered.length)} 条筛选结果的 CSV，包含所有分页。空白代表原表未提供数据。`);
 }
 useEffect(()=>{setExportStatus('');},[foundationState,foundation,partsIdentity]);
 if(!source)return sourceError?<div className="error" role="alert">总表读取失败：{sourceError}{onRetrySource&&<Button variant="outline" onClick={onRetrySource}>重新读取总表</Button>}</div>:<p className="empty" role="status">正在读取来源索引…</p>;
 return <section ref={ledgerRef} className="source-ledger panel" data-source-view={view} aria-label={datasetIncomplete?'团团作者作品（已读总表）':'团团作者作品全量来源'}><div className="panel-head"><div><p className="eyebrow">已导入的原表 · 修订 {source.revision}</p><h2 tabIndex={-1}>团团作者与作品</h2></div><div className="source-actions"><span className="meta">{supplementalPending?'已读总表身份':'原表身份'} {fmt((source.stats.authors||0)+(foundation?.authors?.length||0))} · 作品 {fmt((source.stats.works||0)+(foundation?.works?.length||0))}</span><Button variant="outline" disabled={!list||!!error||!!dateError||!!selectionError||datasetIncomplete||!filtered.length} onClick={exportFiltered}>{mainOnly&&foundationState!==undefined?'导出总表筛选结果':'导出全部筛选结果'}</Button>{addressMode&&<Button variant="outline" disabled={!!selectionError||!!dateError} onClick={copySelection}>复制当前筛选链接</Button>}</div></div>
 {exportStatus&&<p className="source-export-status" role="status">{exportStatus}</p>}
 {supplementalPending&&<div className="source-completeness" aria-label="补充表读取状态" role={foundationState==='error'?'alert':'status'}><p className="meta">{foundationState==='error'?'补充表暂未读到，目前仅显示已验证的总表。':'补充表正在读取，目前仅显示已验证的总表。'} {mainOnly?'当前仅查看总表，可导出总表筛选结果。':'补充表合并前，作者数、作品数与页数均只是已读部分，完整筛选结果暂不能导出。'}{foundationError&&` 原因：${foundationError}`}</p>{onRetryFoundation&&foundationState==='error'&&<Button variant="outline" onClick={onRetryFoundation}>重新读取补充表</Button>}</div>}
 {copyStatus&&<div className="source-share-link"><p role="status">{copyStatus}</p>{manualLink&&<Input readOnly aria-label="当前筛选分享链接" value={manualLink} onFocus={event=>event.currentTarget.select()} />}</div>}
 <p className="meta">输入作者名或作品关键词，再按内容类型、发布日期缩小范围。这里的播放和点赞是表格累计成绩，不是每日增长；“—”表示没有记录。</p>
 <details className="source-ledger-method"><summary>查看数据来源与去重说明</summary><p className="meta">作者按抖音号整理，作品按 ID 去重；跨表别名保留，去重后的作者人数见“账号变化”里的团团统一名册。补充登记不等同平台每日采样。</p>{foundation&&<p className="meta">已索引总表 {foundation.index.stats.sheets} 张工作表、其他来源最新入库 {foundation.index.stats.sourceDocuments} 份；原表作者 {source.stats.rawAuthorRows} 行中 {source.stats.reciprocalDuplicates} 行为姓名与抖音号对调的镜像重复，已在展示层折叠，原始行未删除。严格新增作者 {foundation.index.stats.additionalAuthors} 位、作品 ID {foundation.index.stats.additionalWorks} 条；另有 {foundation.index.stats.unkeyedRows} 行缺少可严格去重的 ID，仍保存在原库。</p>}<p className="meta">一位作者或一件作品可属于多种内容，分类结果不能相加。{source.semantics.plays}；{source.semantics.likes}。空值不补零。</p></details>
 <div className="source-controls"><div role="group" aria-label="来源数据类型"><Button variant={view==='authors'?'secondary':'outline'} onClick={()=>changeSelection({authorFocus:null,view:'authors'})}>登记身份{supplementalPending?'（已读总表）':''} {fmt((source.stats.authors||0)+(foundation?.authors?.length||0))}</Button><Button variant={view==='works'?'secondary':'outline'} onClick={()=>changeSelection({authorFocus:null,view:'works'})}>作品{supplementalPending?'（已读总表）':''} {fmt((source.stats.works||0)+(foundation?.works?.length||0))}</Button></div><Input aria-label="搜索来源作者或作品" placeholder={view==='authors'?'搜索作者或抖音号':'搜索作者、作品标题或ID'} value={query} onChange={event=>setQuery(event.target.value)} /><label>内容 / 赛道 <select value={track} onChange={event=>setTrack(event.target.value)}><option value="all">全部内容与赛道</option><optgroup label="内容分类">{sourceContentFilterOptions.map(item=><option key={item.key} value={item.key}>{item.label}</option>)}</optgroup>{source.tracks.map((item:RecordRow)=><option key={item.name} value={item.name}>{item.name}</option>)}<option value="__unclassified__">未关联明确赛道</option></select></label>{view==='authors'&&<label>采样关联 <select value={linkage} onChange={event=>setLinkage(event.target.value as 'all'|'linked'|'sourceOnly')}><option value="all">全部作者</option><option value="linked">已关联目标 ID</option><option value="sourceOnly">仅来源表</option></select></label>}<label>排序 <select value={sort} onChange={event=>setSort(event.target.value)}><option value="plays">累计播放</option><option value="likes">累计点赞</option><option value="row">原表顺序</option></select></label></div>
 {view==='works'&&<div className="source-date-filters" role="group" aria-label="按作品发布日期筛选">
  <label>开始日期<Input type="date" aria-label="作品发布日期开始" value={startDate} onChange={event=>setStartDate(event.target.value)} /></label>
  <label>结束日期<Input type="date" aria-label="作品发布日期结束" value={endDate} onChange={event=>setEndDate(event.target.value)} /></label>
  {(startDate||endDate)&&<Button variant="outline" onClick={()=>{setStartDate('');setEndDate('');}}>清除日期</Button>}
  {mainTableOnly&&<Button variant="outline" onClick={()=>setMainTableOnly(false)}>仅总表作品 ×</Button>}
  <p>按原表记录的作品发布日期筛选，包含开始和结束当天；不是采样日或当天新增播放。{(startDate||endDate)?`当前为 ${startDate||'最早记录'} 至 ${endDate||'最新记录'}。`:'当前显示全部日期。'}{undatedCount>0?`其中 ${fmt(undatedCount)} 条未记录有效发布日期，清除日期后可查看。`:''}{mainTableOnly?'当前与首页发布趋势一致，仅查看总表作品；点击“仅总表作品 ×”可纳入补充登记。':''}</p>
  {dateError&&<p role="alert">{dateError}</p>}
 </div>}
 {authorFocus&&view==='works'&&authorContext&&<div ref={authorContextRef} tabIndex={-1} className="source-author-focus" aria-label="当前作者作品与主页数据"><div><strong>{authorFocus.name}</strong><span>抖音号 {[...focusedAuthorIds].join(' / ')} · 仅按已核对账号 ID 关联，不凭昵称合并。</span><p role="status">{authorContext.archived===null?'已归档作品数待核：请等待总表与补充表完整读取。':`已归档作品 ${fmt(authorContext.archived)} · 总表与补充登记按作品 ID 去重，包含全部日期与赛道。`}</p>{authorContext.archived!==null&&!dateError&&!selectionError&&<p className="meta">当前筛选 {fmt(filtered.length)} 条；下方只显示筛选结果，不代表作者全部作品。原表登记作品数保持原值，可能尚未包含补充登记。</p>}<div className="source-actions">{authorContext.linked.map(account=><Button key={account.id} variant="outline" onClick={event=>onOpenAccount(account,event.currentTarget)}>查看粉丝、点赞变化{authorContext.linked.length>1?` · ${account.label}`:''}</Button>)}{authorContext.missingAccounts>0&&<span>账号信息暂未读到{authorContext.linked.length>0?`（${authorContext.missingAccounts} 个）`:''}</span>}{!authorContext.hasTarget&&<span>{authorContext.associationPending?'作者关联信息待核':'未关联主页账号'}</span>}</div></div><Button variant="outline" onClick={canReturnToRoster?rosterReturn!.onReturn:returnToAuthor}>{canReturnToRoster?'返回团团名册':'返回作者记录'}</Button></div>}
 {selectionError?<div className="error" role="alert">{selectionError}<Button variant="outline" onClick={()=>changeSelection({...sourceLedgerDefaults} as SourceSelection)}>重置来源筛选</Button>{list&&page>pages&&!addressError&&<Button variant="outline" onClick={()=>setPage(1)}>回到第一页</Button>}</div>:error?<div className="error" role="alert">{error}<Button variant="outline" onClick={()=>{setError('');setRetry(value=>value+1);}}>重试</Button></div>:!list?<p className="empty" role="status">正在校验并读取 {view==='authors'?'作者':'作品'}记录…</p>:waitingForPage?<p className="empty" role="status">正在等待补充表，暂时不能确认第 {page} 页的完整记录。{foundationState==='error'?'请重新读取补充表后继续。':''}</p>:<><div className="source-pager"><span>{datasetIncomplete?'已读总表符合条件':'符合条件'} {fmt(filtered.length)} 条 · 第 {selected}/{pages} 页</span><Button variant="outline" disabled={selected<=1} onClick={()=>setPage(selected-1)}>上一页</Button><Button variant="outline" disabled={selected>=pages} onClick={()=>setPage(selected+1)}>下一页</Button></div><TableScrollFrame scrollLabel={view==='authors'?'来源作者数据表':'来源作品数据表'} scrollSelector=".source-table-wrap"><div className="source-table-wrap"><table className="source-table"><thead><tr>{(view==='authors'?['作者 / 抖音号','原表登记作品','累计播放·表格','累计点赞·表格','平台关联']:['作品 / 作者','发布日期','内容分类 / 赛道','累计播放·表格','累计点赞·表格']).map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{shown.map((row:RecordRow)=>view==='authors'?<tr key={sourceLedgerRowKey(row,view)}><td><strong>{row.name||'未命名'}</strong><small>{row.douyinId||'未登记抖音号'}</small>{sourceRegistrationLabel(row)&&<small>登记类别：{sourceRegistrationLabel(row)}</small>}{row.sourceSupplement&&<small>补充登记 · {row.evidenceRows} 行证据 · {row.sourceTitles?.join('、')}</small>}{row.douyinId&&<Button variant="link" data-source-author={String(row.douyinId)} data-source-author-row={sourceLedgerRowKey(row,'authors')} onClick={event=>showAuthorWorks(row,event.currentTarget)}>查看此作者的来源作品 →</Button>}</td><td>{fmt(row.posts)}<small>{row.posts===0?'来源表未关联作品':'切片 '+fmt(row.slicePosts)+' · 创作 '+fmt(row.creationPosts)+' · 即梦 '+fmt(row.aiPosts)}</small></td><td>{row.posts===0?'—':fmt(row.plays)}</td><td>{row.posts===0?'—':fmt(row.likes)}</td><td>{row.targetIds.length?row.targetIds.map((id:number)=>{const account=accountById.get(id);return account?<Button key={id} variant="link" onClick={event=>onOpenAccount(account,event.currentTarget)}>{account.label} · 主页采样</Button>:<span key={id}>已关联 #{id}</span>;}):'仅来源表'}</td></tr>:<tr key={sourceLedgerRowKey(row,view)}><td>{row.url?<a href={row.url} target="_blank" rel="noopener noreferrer">{row.title||row.contentId||'无标题作品'}</a>:<strong>{row.title||row.contentId||'无标题作品'}</strong>}<small>{row.author||'作者未记录'} · {row.douyinId||'账号未记录'}</small>{row.sourceSupplement&&<small>补充登记 · {row.evidenceRows} 行证据 · {row.sourceTitles?.join('、')}</small>}{row.douyinId&&<Button variant="link" onClick={()=>changeSelection({query:String(row.douyinId),authorFocus:null,view:'authors'},'push')}>查看作者记录 →</Button>}</td><td>{row.publishDate||'未记录'}</td><td>{sourceWorkClassificationLabel(row)||'未标注内容分类'}<small>{row.track||'未标注赛道'}</small></td><td>{fmt(row.plays)}</td><td>{fmt(row.likes)}</td></tr>)}</tbody></table></div></TableScrollFrame>{!shown.length&&<p className="empty">{dateError?'请先调整发布日期范围。':datasetIncomplete?'已读总表中没有符合条件的记录；补充表尚未合并，暂不能判断全部来源是否有匹配。':'没有符合当前条件的记录。可清除日期、调整赛道或搜索内容后再试。'}</p>}<div className="source-pager"><span>{datasetIncomplete?'已读总表共':'共'} {fmt(filtered.length)} 条 · 第 {selected}/{pages} 页</span><Button variant="outline" disabled={selected<=1} onClick={()=>setPage(selected-1)}>上一页</Button><Button variant="outline" disabled={selected>=pages} onClick={()=>setPage(selected+1)}>下一页</Button></div></>}
 {view==='works'&&pageHasObservations&&!!foundation?.observations?.length&&<div className="source-observations"><h3>本页作品的补充表格观测</h3><p className="meta">原表第 10 张工作表按来源行保存 {fmt(foundation.index.stats.sourceMetricObservations)} 条指标观测，涉及 {fmt(foundation.index.stats.sourceMetricWorkIds)} 个作品 ID。这里不取代上表去重作品累计值，也不把两次来源差额当作日增长。</p>{shown.map((row:RecordRow)=>{const records=observationsByWork.get(row.contentId)||[];return records.length?<details key={row.contentId}><summary>{row.contentId} · {records.length} 条来源观测</summary><TableScrollFrame scrollLabel={`作品 ${row.contentId} 的补充观测表`} scrollSelector=".source-table-wrap"><div className="source-table-wrap"><table className="source-table"><thead><tr><th>来源行</th><th>观测时间</th><th>点赞</th><th>播放</th></tr></thead><tbody>{records.map((item:RecordRow)=><tr key={item.sourceRow}><td>表格 10 · 第 {item.sourceRow} 行</td><td>{item.observedAt?date(item.observedAt):'未记录'}</td><td>{fmt(item.likes)}</td><td>{fmt(item.plays)}</td></tr>)}</tbody></table></div></TableScrollFrame></details>:null;})}</div>}
 <p className="meta">仅发布必要字段；授权、奖金及原始来源行证据仍只在本机管理员端。表格修订 {source.revision}，入库时间 {date(source.importedAt)}（北京）。</p></section>;
}
