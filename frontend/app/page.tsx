"use client";
import {applyLiveAuthorLinks} from "@/lib/live-author-links.mjs";
import {ChangeIndicator} from "@/components/change-indicator";
import {AuthorUnifiedWorks} from '@/components/author-unified-works';
import {AuthorDailyPublishing} from '@/components/author-daily-publishing';
import {accountDailyPublication,publicationBusinessDay} from '@/lib/author-daily-publication.mjs';
import {ContinuousPublishing} from '@/components/continuous-publishing';
import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {LayoutDashboard,ChartNoAxesCombined,UsersRound,Hash} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Card,CardContent} from '@/components/ui/card';
import {Badge} from '@/components/ui/badge';
import {Dialog,DialogContent,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {TableBody,TableCell,TableHead,TableHeader,TableRow} from '@/components/ui/table';
import {ScrollableTable as Table} from '@/components/scrollable-table';
import {rowsFor,aggregate,orderRows,csv} from '@/lib/replica-model.mjs';
import {availableComparison} from '@/lib/available-comparison.mjs';
import {loadReplicaView} from '@/lib/replica-view.mjs';
import {withReplicaReadDeadline} from '@/lib/replica-read-deadline.mjs';
import {GrowthPanel} from '@/components/growth-panel';
import {GroupSummary} from '@/components/group-summary';
import {MetricLedger} from '@/components/metric-ledger';
import {periodWindow,periodWindowFromCatalog,periodNames} from '@/lib/replica-periods.mjs';
import {EndpointSources} from '@/components/endpoint-sources';
import {AccountPanel} from '@/components/account-panel';
import {WorkLikesHistory} from '@/components/work-likes-history';
import {readReplicaPart} from '@/lib/replica-reader.mjs';
import {parseAccountRequest} from '@/lib/replica-account.mjs';
import {accountCoverage} from '@/lib/replica-coverage.mjs';
import {CoveragePanel} from '@/components/coverage-panel';
import {DailyCoveragePanel} from '@/components/daily-coverage-panel';
import {dailyCoverageRequest} from '@/lib/replica-daily-request.mjs';
import {captureWorkspaceReturn,workspaceReturnPath} from '@/lib/replica-return.mjs';
import {workspaceNavigation,workspacePath,navigationNeedsLoad,workspaceSelection,workspaceSelectionScope,workspaceSelectionPath,workspaceListSelection,workspaceSortLabels,workspaceComparisonSelection} from '@/lib/replica-navigation.mjs';
import {accountExport,historyExport} from '@/lib/replica-export.mjs';
import {loadSummaryRange,trendRangeRequest,catalogDateWindow} from '@/lib/replica-date-range.mjs';
import {classificationMenu} from '@/lib/replica-classification-menu.mjs';
import {AccountClassification} from '@/components/account-classification';
import {TopicHistory} from '@/components/topic-history';
import {CreatorSourceLedger,readCreatorSourcePart} from '@/components/creator-source-panel';
import {TuantuanRosterSummary,TuantuanRosterTable} from '@/components/tuantuan-roster';
import {OtherSourceCatalog} from '@/components/other-source-catalog';
import {SourceOperations} from '@/components/source-operations';
import {CollectionConsole} from '@/components/collection-console';
import {ObservatoryAtmosphere,MotionPreference,OverviewWayfinder} from '@/components/observatory-atmosphere';
import {AllAuthorOverview} from '@/components/all-author-overview';
import {matchesMatrixScope} from '@/lib/matrix-scope.mjs';
import {allAuthorOverview} from '@/lib/all-author-overview.mjs';
import {OverviewAccountPreview} from '@/components/overview-account-preview';
import {OverviewTrendPreview} from '@/components/overview-trend-preview';
import {UnifiedWorkMetric} from '@/components/unified-work-metric';
import {presentUnifiedWorkMetric} from '@/lib/unified-work-presentation.mjs';
import {buildTuantuanRoster,includeOtherMatrixAccounts} from '@/lib/tuantuan-roster.mjs';
import {preserveSourceSelection} from '@/lib/source-ledger-navigation.mjs';
import {rosterSelection,rosterSelectionPath,rosterPanelSelection,rosterPanelPath,preserveRosterSelection} from '@/lib/tuantuan-roster-navigation.mjs';
import {validateTableFoundationManifest} from '@/lib/table-foundation-manifest.mjs';
import {validateCreatorInsights} from '@/lib/creator-insights-validation.mjs';
import {readSourceIndex,sourcePartsIdentity} from '@/lib/source-part-reader.mjs';
import {validateCreatorSourceIndex,sourceEditionIdentity,foundationEditionIdentity,loadCreatorSourceEdition,loadTableFoundationEdition} from '@/lib/source-edition-loader.mjs';
import {compareWorkPublication,workPublicationDisplay} from '@/lib/replica-work-publication.mjs';
type Row=Record<string,any>;
function renderClassificationFilter(menu:Row,value:string,onValueChange:(value:string)=>void,id='classification-menu-help'){
 const option=(choice:Row)=><option key={choice.key} value={choice.key} title={`监控名册：${choice.enabled} 个启用，${choice.paused} 个暂停；不含仅表格作者`}>{choice.label}</option>;
 return <label>内容分类<select value={value} onChange={event=>onValueChange(event.target.value)} aria-describedby={id}>
  <option value="all">全部分类</option>
  {!!menu.primary.length&&<optgroup label="常用内容类型">{menu.primary.map(option)}</optgroup>}
  {!!menu.source.length&&<optgroup label="来源标签">{menu.source.map(option)}</optgroup>}
  {menu.retainedSelected&&<optgroup label="当前选择（不在此范围）">{option(menu.retainedSelected)}</optgroup>}
 </select><small id={id}>作者名册与可计算变化的账号分别计数 · 多标签可重叠</small></label>;
}
const fmt=(n:any)=>n==null?'—':Number(n).toLocaleString('zh-CN');
const diff=(n:any)=>n==null?'—':(n>0?'+':'')+fmt(n);
const bj=(s:string)=>s?new Date(s).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未知';
function workDateCell(work:Row){const publication=workPublicationDisplay(work);return <TableCell>{publication.value}<small>{publication.note}</small></TableCell>;}
const readableLoadError=(error:unknown)=>{
 const message=error instanceof Error?error.message:String(error||'');
 return /failed to fetch|networkerror|load failed|network request failed/i.test(message)
  ?'网络暂时无法读取已保存数据，请检查连接后重试'
  :message||'暂时无法读取已保存数据，请稍后重试';
};
function download(rows:any[][],name:string){const url=URL.createObjectURL(new Blob([csv(rows)],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function read(g:string,part:string,meta:Row,signal?:AbortSignal){return readReplicaPart({generation:g,part,meta,signal});}
// Keep a user's own paging control reachable when that action disables it.
function Pager({count,page,change,scope}:{count:number;page:number;change:(page:number)=>void;scope:string}){
 const region=useRef<HTMLDivElement|null>(null),pending=useRef<{button:HTMLButtonElement;page:number;scope:string}|null>(null);
 useLayoutEffect(()=>{
  const request=pending.current;pending.current=null;
  if(!request||request.page!==page||request.scope!==scope||!request.button.disabled
   ||!region.current?.isConnected||region.current.closest('[hidden]')
   ||!region.current.contains(request.button)
   ||document.activeElement!==request.button&&document.activeElement!==document.body)return;
  // Chromium may blur a newly disabled button only after the event completes.
  let moved=false;
  const watch=(event:FocusEvent)=>{if(event.target!==request.button)moved=true;};
  document.addEventListener('focusin',watch);
  const frame=requestAnimationFrame(()=>{
   document.removeEventListener('focusin',watch);
   if(moved||document.activeElement!==document.body&&document.activeElement!==request.button||!request.button.disabled
    ||!region.current?.isConnected||region.current.closest('[hidden]')
    ||!region.current.contains(request.button))return;
   region.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({preventScroll:true});
  });
  return()=>{cancelAnimationFrame(frame);document.removeEventListener('focusin',watch);};
 },[count,page,scope]);
 function move(button:HTMLButtonElement,next:number){
  pending.current=document.activeElement===button?{button,page:next,scope}:null;
  change(next);
 }
 return <div className="pager" ref={region}><span>共 {count} 条 · 第 {page}/{Math.max(1,Math.ceil(count/20))} 页</span><Button variant="outline" disabled={page<=1} onClick={event=>move(event.currentTarget,page-1)}>上一页</Button><Button variant="outline" disabled={page*20>=count} onClick={event=>move(event.currentTarget,page+1)}>下一页</Button></div>;
}
export default function Home(){
 const [data,setData]=useState<Row|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[tab,setTab]=useState('overview');
 const [authorWorks,setAuthorWorks]=useState<Row|null>(null);
 const authorWorksTrigger=useRef<HTMLButtonElement|null>(null);
 const [sourceIndex,setSourceIndex]=useState<Row|null>(null),[sourceAuthors,setSourceAuthors]=useState<Row|null>(null),[sourceIndexError,setSourceIndexError]=useState(''),[sourceAuthorsError,setSourceAuthorsError]=useState('');
 const sourceError=sourceIndexError||sourceAuthorsError;
 const [sourceRetry,setSourceRetry]=useState(0),[foundationRetry,setFoundationRetry]=useState(0);
 const [sourceInsights,setSourceInsights]=useState<Row|null>(null),[sourceInsightsError,setSourceInsightsError]=useState('');
 const [sourceInsightsIdentity,setSourceInsightsIdentity]=useState(''),[sourceVerifiedParts,setSourceVerifiedParts]=useState<{authors:{identity:string;items:Row[]};works:{identity:string;items:Row[]}}|null>(null);
 const [sourceUpdateError,setSourceUpdateError]=useState(''),[sourceUpdateRetry,setSourceUpdateRetry]=useState(0);
 const [sourceFocus,setSourceFocus]=useState<{view:'authors'|'works';query?:string;track?:string;linkage?:'all'|'linked'|'sourceOnly';startDate?:string;endDate?:string;mainTableOnly?:boolean;author?:{name:string;douyinId:string;douyinIds?:string[]}}|null>(null);
 const [foundation,setFoundation]=useState<Row|null>(null),[foundationError,setFoundationError]=useState('');
 const [foundationState,setFoundationState]=useState<'loading'|'ready'|'error'>('loading');
 const [sourceVisited,setSourceVisited]=useState(false);
 const [rosterPanel,setRosterPanel]=useState('authors');
 const [rosterReturn,setRosterReturn]=useState<{authorId:string;path:string;scrollY:number}|null>(null);
 const [board,setBoard]=useState('all'),[theme,setTheme]=useState('all'),[tag,setTag]=useState('all'),[query,setQuery]=useState(''),[start,setStart]=useState(''),[end,setEnd]=useState(''),[sort,setSort]=useState('followers.delta'),[order,setOrder]=useState('desc'),[page,setPage]=useState(1);
 const [account,setAccount]=useState<Row|null>(null),[history,setHistory]=useState<Row|null>(null),[hError,setHError]=useState(''),[hRetry,setHRetry]=useState(0),[kind,setKind]=useState('daily'),[hPage,setHPage]=useState(1),[hSort,setHSort]=useState('date'),[hOrder,setHOrder]=useState('desc'),[work,setWork]=useState<number|null>(null);
 const [publicationSelection,setPublicationSelection]=useState({scope:'',date:'',onlyDay:false});
 const publicationScope=account&&data?account.id+'@'+data.manifest.asOf:'';
 const publicationDate=publicationSelection.scope===publicationScope?publicationSelection.date:'';
 const publicationOnlyDay=publicationSelection.scope===publicationScope&&publicationSelection.onlyDay;
 const historyScope=useRef(''),historyViews=useRef<Record<string,Row>>({}),historyRestore=useRef<Row|null>(null),historyDialog=useRef<HTMLDivElement|null>(null),historyBack=useRef<HTMLButtonElement|null>(null);
 function rememberHistory(){if(kind==='workMetrics')return;const dialog=historyDialog.current;historyViews.current[kind]={page:hPage,sort:hSort,order:hOrder,scrollTop:dialog?.scrollTop||0,scrollLeft:dialog?.querySelector<HTMLElement>('[data-history-table] [data-slot="table-container"]')?.scrollLeft||0};}
 function chooseHistory(next:string){if(next===kind)return;rememberHistory();const saved=historyViews.current[next];historyRestore.current=next==='works'&&kind==='workMetrics'?{scope:historyScope.current,workId:work,...saved,active:document.activeElement}:null;setHistory(null);setHError('');setKind(next);setHPage(saved?.page||1);setHSort(saved?.sort||(next==='daily'?'date':'publishedAt'));setHOrder(saved?.order||'desc');setWork(null);}
 function inspectWork(id:number){rememberHistory();historyRestore.current={scope:historyScope.current,enter:true,active:document.activeElement};setHistory(null);setHError('');setWork(id);setKind('workMetrics');setHPage(1);setHSort('capturedAt');setHOrder('desc');}
 const [rosterStatus,setRosterStatus]=useState('enabled'),[available,setAvailable]=useState(''),[autoRetryTick,setAutoRetryTick]=useState(0);const authorReturnFocus=useRef<HTMLButtonElement|null>(null),searchRef=useRef<HTMLInputElement|null>(null),headingRef=useRef<HTMLHeadingElement|null>(null),loadEpoch=useRef(0),loadController=useRef<AbortController|null>(null),autoAdoptAttempt=useRef<{generation:string;after:number}|null>(null);
 const [periodDraft,setPeriodDraft]=useState('since'),[periodNote,setPeriodNote]=useState('9/12采样作为固定基线；缺测不补零。');
 const [personal,setPersonal]=useState<Row|null>(null),[linkError,setLinkError]=useState('');const initialized=useRef(false),globalScroll=useRef(0);
 const dataRef=useRef<Row|null>(null),addressSeen=useRef(''),lastRoute=useRef<Row|null>(null),workspaceReturn=useRef<Row|null>(null),editionReadEpoch=useRef(0);
 const workspaceJump=useRef(false),workspaceReturnFocus=useRef<HTMLButtonElement|null>(null),navigationEpoch=useRef(0);
 const selectionRef=useRef<Row|null>(null),selectionSearch=useRef<string|null>(null),appliedPeriod=useRef('since');
 const [comparison,setComparison]=useState<Row>({compare:false,otherStart:'',otherEnd:''}),[curveOffset,setCurveOffset]=useState(0),[rangeError,setRangeError]=useState(''),[rangeRetry,setRangeRetry]=useState(0);
 const [advancedOpen,setAdvancedOpen]=useState(false),scopeFocus=useRef<HTMLParagraphElement|null>(null);
 function clearScope(dimension:'theme'|'tag'){const epoch=navigationEpoch.current;if(dimension==='theme')setTheme('all');else setTag('all');requestAnimationFrame(()=>{if(navigationEpoch.current===epoch)scopeFocus.current?.focus({preventScroll:true});});}
 const rangePlan=useMemo(()=>{try{if(!start||!end)throw Error('请选择完整的基准观察日和截止观察日。');if(comparison.compare&&(!comparison.otherStart||!comparison.otherEnd))throw Error('请选择比较区间的两个日期。');return {request:dailyCoverageRequest({start,end,offset:curveOffset,...(comparison.compare?{otherStart:comparison.otherStart,otherEnd:comparison.otherEnd}:{})}),error:''};}catch{return {request:null,error:'请选择完整且有序的日期：起点不能晚于终点。日期无效时尚未发送读取请求。'};}},[start,end,curveOffset,comparison]);
 const requestedRange=rangePlan.request,dateValidationError=rangePlan.error;
 const rangeReady=!dateValidationError&&(!data?.dateIndexed||!!requestedRange&&data.receipt?.requestKey===requestedRange.key);
 useEffect(()=>{dataRef.current=data;},[data]);
 async function load(view='global',expectedGeneration?:string){
  const epoch=++loadEpoch.current;loadController.current?.abort();const controller=new AbortController();loadController.current=controller;setLoading(true);setError('');
  try{
   await withReplicaReadDeadline({controller,operation:async()=>{
   let request:Row|null;try{request=workspaceNavigation(window.location.search,window.location.hash).personal;}catch(e){setLinkError((e as Error).message);setPersonal(null);return;}
   setLinkError('');setPersonal(request);
   const r=await fetch('/api/replica'+(request?.generation?'?'+new URLSearchParams({generation:request.generation}):''),{cache:'no-store',signal:controller.signal});
   if(!r.ok)throw Error('这个已发布版本暂不可读，请重试或返回最新账号列表');
   const meta=await r.json() as Row,g=meta.manifest?.asOf,cutoff=Date.parse(g);
   if(!Number.isFinite(cutoff))throw Error('发布清单的采样时间无效，未替换已读取数据');
   if(request?.generation&&g!==request.generation)throw Error('账号链接版本不一致，已停止读取');
   if(!request){
    const shown=Date.parse(dataRef.current?.manifest?.asOf),expected=Date.parse(expectedGeneration||'');
    if(Number.isFinite(shown)&&cutoff<shown)throw Error('本次返回了比当前更早的版本，仍保留已校验数据');
    if(expectedGeneration&&(!Number.isFinite(expected)||cutoff<expected))throw Error('新版清单尚未同步到此网络，仍保留已校验数据');
   }
   const readPart=(part:string)=>{const f=meta.manifest.files.find((f:Row)=>f.path===part);if(!f)throw Error('历史分区不在发布清单');return read(g,part,f,controller.signal);};
   const loaded=await loadReplicaView({manifest:meta.manifest,readPart,personal:!!request,topicsOnly:view==='topics',directoryOnly:view==='source'&&!request,signal:controller.signal,rangeRequest:requestedRange,workspace:selectionRef.current,comparison:selectionRef.current?.comparison});
   if(epoch!==loadEpoch.current||controller.signal.aborted)return;
   if(expectedGeneration&&view==='global'&&!loaded.summaryLoaded)throw Error('新版账号日历史尚未完整核验，仍保留已校验数据：'+(loaded.summaryError||'请稍后自动重试'));
   if(expectedGeneration&&view==='topics'&&!loaded.topicsLoaded)throw Error('新版话题记录尚未完整核验，仍保留已校验数据');
   classificationMenu(loaded.accounts);
   rowsFor(loaded.accounts,loaded.points,'2026-09-12','2026-09-12');loaded.accounts.forEach((a:Row)=>accountCoverage(a,g,Date.parse(g)));const next:Row={...meta,...loaded};
   if(!request){let selected:Row[];try{selected=workspaceSelectionScope(selectionRef.current,next.accounts,next.boards);}catch(e){if(expectedGeneration)throw Error('新版与当前矩阵、主题或分类不兼容，仍保留已校验数据：'+(e as Error).message);setLinkError((e as Error).message);return;}
    if(!initialized.current&&loaded.summaryLoaded){const s=selectionRef.current,key=s?.period||'since',w=key!=='since'&&s?.start?{start:s.start,end:s.end,note:'链接保存的真实观察日；缺少端点不补零。'}:loaded.dateIndexed?periodWindowFromCatalog(key,selected,g):periodWindow(key,selected,next.points,g);setStart(w.start||'');setEnd(w.end||'');setPeriodDraft(key);appliedPeriod.current=key;setPeriodNote(w.note);initialized.current=true;}}
   if(request&&!request.generation){const pinned={...request,generation:g};window.history.replaceState(null,'',window.location.pathname+'?'+new URLSearchParams({account:String(request.id),...(request.start?{start:request.start,end:request.end}:{}),generation:g,...(request.comparison?.compare?{compareStart:request.comparison.otherStart,compareEnd:request.comparison.otherEnd}:{})}));addressSeen.current=window.location.pathname+window.location.search+window.location.hash;setPersonal(pinned);}
   if(!request&&initialized.current&&appliedPeriod.current==='since'){const w=periodWindowFromCatalog('since',next.accounts,g);setStart('2026-09-12');setEnd(w.end);setPeriodNote('从 9/12 持续积累，截止日随最新采样推进；缺测不补零。');}
   setData(next);setAvailable(old=>old&&Date.parse(old)>cutoff?old:'');setAccount(null);setHistory(null);
   }});
  }catch(e){controller.abort();if(epoch===loadEpoch.current)setError(readableLoadError(e));}finally{if(epoch===loadEpoch.current)setLoading(false);}
 }
 function synchronizeAddress(){
  const key=window.location.pathname+window.location.search+window.location.hash;
  if(addressSeen.current===key)return;addressSeen.current=key;
  const epoch=++navigationEpoch.current;
  const moveToTop=workspaceJump.current;workspaceJump.current=false;
  if(moveToTop)workspaceReturnFocus.current=null;
  authorReturnFocus.current=null;
  let route:Row;try{route=workspaceNavigation(window.location.search,window.location.hash);
   if(!route.personal&&selectionSearch.current!==window.location.search){selectionSearch.current=window.location.search;const list=workspaceListSelection(window.location.search);setSort(list.sort);setOrder(list.order);setQuery(list.query);setRosterStatus(list.rosterStatus);const restoredComparison=workspaceComparisonSelection(window.location.search);if(lastRoute.current||!dataRef.current||restoredComparison.compare){setComparison(current=>current.compare===restoredComparison.compare&&current.otherStart===restoredComparison.otherStart&&current.otherEnd===restoredComparison.otherEnd?current:restoredComparison);setCurveOffset(0);}const s=workspaceSelection(window.location.search);selectionRef.current=s?{...s,comparison:restoredComparison}:restoredComparison.compare?{board:'all',theme:'all',tag:'all',period:'since',start:null,end:null,comparison:restoredComparison}:null;
    if(s){setBoard(s.board);setTheme(s.theme);setTag(s.tag);setPeriodDraft(s.period);appliedPeriod.current=s.period;initialized.current=false;
     if(dataRef.current?.summaryLoaded){const d=dataRef.current,scope=workspaceSelectionScope(s,d.accounts,d.boards),w=s.period!=='since'&&s.start?{start:s.start,end:s.end,note:'链接保存的真实观察日；缺少端点不补零。'}:d.dateIndexed?periodWindowFromCatalog(s.period,scope,d.manifest.asOf):periodWindow(s.period,scope,d.points,d.manifest.asOf);setStart(w.start||'');setEnd(w.end||'');setPeriodNote(w.note);initialized.current=true;}}}
  }catch(e){lastRoute.current=null;setTab('overview');setPersonal(null);setLinkError((e as Error).message);setLoading(false);loadEpoch.current++;loadController.current?.abort();return;}
  const returning=!!lastRoute.current?.personal&&!route.personal;lastRoute.current=route;
  setTab(route.tab);setPersonal(route.personal);setLinkError('');setError('');setAccount(null);
  if(!route.personal){try{setRosterPanel(rosterPanelSelection(window.location.search));}catch{setRosterPanel('authors');}}
  if(route.tab==='source'&&!route.personal)setSourceVisited(true);
  if(navigationNeedsLoad(route,dataRef.current))void load(route.loadView);
  else{loadEpoch.current++;loadController.current?.abort();setLoading(false);}
  if(returning&&!moveToTop)requestAnimationFrame(()=>{if(navigationEpoch.current!==epoch)return;window.scrollTo({top:globalScroll.current,behavior:'instant'});if(!document.querySelector('[role="dialog"]')){const preferred=workspaceReturnFocus.current;if(preferred?.isConnected&&!preferred.disabled)preferred.focus({preventScroll:true});if(!preferred||document.activeElement!==preferred)(route.tab==='accounts'?searchRef.current:headingRef.current)?.focus({preventScroll:true});}});
  else if(moveToTop)requestAnimationFrame(()=>{if(navigationEpoch.current!==epoch)return;window.scrollTo({top:0,behavior:'instant'});if(!document.querySelector('[role="dialog"]'))headingRef.current?.focus({preventScroll:true});});
 }
 function navigateWorkspace(name:string,reset=false,panel?:'changes'|'authors'){
  if(!reset&&!personal&&!linkError&&tab===name){try{if(!panel||rosterPanelSelection(window.location.search)===panel)return;}catch{}}
  let path=workspacePath(window.location.pathname,name,reset||personal?'':window.location.search);
  const saved=!reset&&personal&&data?workspaceReturnPath(workspaceReturn.current,{pathname:window.location.pathname,generation:data.manifest.asOf}):null;
  if(saved){const search=new URL(saved,window.location.origin).search;path=preserveRosterSelection(preserveSourceSelection(path,search),search);}
  if(panel)path=rosterPanelPath(path,panel);
  if(window.location.pathname+window.location.search+window.location.hash===path)return;
  workspaceJump.current=true;
  window.history.pushState(null,'',path);
  addressSeen.current='';synchronizeAddress();
 }
 function inspectSource(focus:{view:'authors'|'works';query?:string;track?:string;linkage?:'all'|'linked'|'sourceOnly';startDate?:string;endDate?:string;mainTableOnly?:boolean;author?:{name:string;douyinId:string;douyinIds?:string[]}}){setSourceFocus({...focus});navigateWorkspace('source');}
 function selectRosterPanel(panel:'changes'|'authors'){
  if(!personal&&tab==='accounts'){try{if(rosterPanelSelection(window.location.search)===panel)return;}catch{}}
  const path=rosterPanelPath(workspacePath(window.location.pathname,'accounts',window.location.search),panel);
  if(window.location.pathname+window.location.search+window.location.hash===path)return;
  if(tab!=='accounts'||personal)workspaceJump.current=true;
  window.history.pushState(null,'',path);addressSeen.current='';synchronizeAddress();
 }
 function chooseClassification(value:string){
  try{const selection=rosterSelection(window.location.search);window.history.replaceState(null,'',rosterSelectionPath(window.location.pathname+window.location.search+window.location.hash,{...selection,page:1}));}catch{}
  setTag(value);
 }
 function inspectRosterWorks(source:Row,trigger?:HTMLButtonElement){authorWorksTrigger.current=trigger??null;setAuthorWorks(source);}

 function returnToRoster(){
  if(!rosterReturn)return;const saved=rosterReturn;setSourceFocus(null);window.history.pushState(null,'',saved.path);addressSeen.current='';synchronizeAddress();
  const epoch=navigationEpoch.current;requestAnimationFrame(()=>{if(navigationEpoch.current!==epoch)return;window.scrollTo({top:saved.scrollY,behavior:'instant'});headingRef.current?.focus({preventScroll:true});});
 }
 function openTuantuanRoster(){
  const path=rosterSelectionPath(workspaceSelectionPath(window.location.pathname,'accounts',{board:'all',theme:'tuantuan',tag:'all',period:appliedPeriod.current,start:null,end:null},{sort,order,query:'',rosterStatus:'enabled'},{compare:false,otherStart:'',otherEnd:''}),{...rosterSelection(''),panel:'authors'});
  workspaceJump.current=true;window.history.pushState(null,'',path);addressSeen.current='';synchronizeAddress();
 }
 function returnToAccounts(){
  if(linkError){workspaceReturn.current=null;selectionRef.current=null;selectionSearch.current=null;initialized.current=false;appliedPeriod.current='since';setBoard('all');setTheme('all');setTag('all');setQuery('');setStart('');setEnd('');setComparison({compare:false,otherStart:'',otherEnd:''});setCurveOffset(0);const reload=!!dataRef.current?.summaryLoaded;navigateWorkspace('accounts',true);if(reload)void load('global');return;}
  const path=workspaceReturnPath(workspaceReturn.current,{pathname:window.location.pathname,generation:data?.manifest.asOf});if(!path){navigateWorkspace('accounts');return;}window.history.pushState(null,'',path);addressSeen.current='';synchronizeAddress();
 }
 function personalAddress(query:string){const request=parseAccountRequest(query);if(!request||request.id!==personal?.id||request.generation!==data?.manifest.asOf)throw Error('账号分享身份或版本不一致');window.history.replaceState(null,'',window.location.pathname+query);addressSeen.current=window.location.pathname+window.location.search+window.location.hash;setPersonal(request);}
 function standalone(a:Row,trigger?:HTMLButtonElement|null){if(!data)return;if(!personal){workspaceReturn.current=captureWorkspaceReturn({pathname:window.location.pathname,search:window.location.search,hash:window.location.hash,generation:data.manifest.asOf});workspaceReturnFocus.current=trigger??null;globalScroll.current=window.scrollY;}const query='?'+new URLSearchParams({account:String(a.id),...(a.enabled&&start&&end?{start,end}:{}),generation:data.manifest.asOf,...(a.enabled&&data.summaryLoaded&&rangeReady&&comparison.compare?{compareStart:comparison.otherStart,compareEnd:comparison.otherEnd}:{})});window.history.pushState(null,'',window.location.pathname+query);addressSeen.current='';synchronizeAddress();window.scrollTo({top:0,behavior:'instant'});const epoch=navigationEpoch.current;requestAnimationFrame(()=>{if(navigationEpoch.current===epoch&&!document.querySelector('[role="dialog"]'))headingRef.current?.focus({preventScroll:true});});}

 useEffect(()=>{synchronizeAddress();window.addEventListener('popstate',synchronizeAddress);window.addEventListener('hashchange',synchronizeAddress);return()=>{loadEpoch.current++;loadController.current?.abort();addressSeen.current='';window.removeEventListener('popstate',synchronizeAddress);window.removeEventListener('hashchange',synchronizeAddress);};},[]);
 function refreshSavedData(){editionReadEpoch.current++;setSourceIndex(null);setSourceInsights(null);setSourceInsightsIdentity('');setSourceVerifiedParts(null);setSourceUpdateError('');setSourceIndexError('');setSourceAuthorsError('');setSourceInsightsError('');setFoundation(null);setFoundationError('');setFoundationState('loading');setSourceRetry(value=>value+1);void load(personal?'account':tab);}
 useEffect(()=>{
  if(!(tab==='overview'||tab==='source'||tab==='accounts')||tab==='overview'&&window.location.hash==='#accounts'||window.location.search.includes('account='))return;
  // Tab changes reuse the verified edition. Explicit refresh clears it first;
  // removing the ledger on ordinary return would lose its focus target.
  if(sourceIndex)return;
  let active=true;const controller=new AbortController();setSourceIndexError('');setSourceAuthorsError('');setSourceInsights(null);
  readSourceIndex('/creator-source/index.json',{signal:controller.signal,preferReplica:true,manifest:dataRef.current?.manifest}).then(body=>{
   validateCreatorSourceIndex(body);
   if(active)setSourceIndex(body);
  }).catch(error=>{if(active&&!controller.signal.aborted)setSourceIndexError(error.message);});
  return()=>{active=false;controller.abort();};
 },[tab,theme,sourceRetry,!!personal,sourceIndex,data?.manifest?.asOf]);
 useEffect(()=>{if(tab!=='overview'||!sourceIndex)return;let active=true;const controller=new AbortController();const file=sourceIndex.files.find((item:Row)=>item.path==='insights.json');if(!file){setSourceInsightsError('当前来源版本没有经营分析分区');return;}const identity=sourcePartsIdentity([file],String(sourceIndex.revision));if(sourceInsights&&sourceInsightsIdentity===identity){setSourceInsightsError('');return;}setSourceInsights(null);setSourceInsightsError('');readCreatorSourcePart(file,String(sourceIndex.revision),controller.signal).then(items=>{const insight=validateCreatorInsights(items,sourceIndex);if(active){setSourceInsights(insight);setSourceInsightsIdentity(identity);setSourceInsightsError('');}}).catch(error=>{if(active&&!controller.signal.aborted)setSourceInsightsError(error.message);});return()=>{active=false;controller.abort();};},[tab,sourceIndex,sourceInsightsIdentity]);
 const sourceAuthorsKey=sourceIndex?sourcePartsIdentity(sourceIndex.files.filter((file:Row)=>file.path==='authors.json'),String(sourceIndex.revision)):'';
 useEffect(()=>{
  if(!sourceIndex||!(tab==='overview'||tab==='source'||tab==='accounts'))return;
  setSourceAuthorsError('');if(sourceAuthors?.identity===sourceAuthorsKey)return;
  let active=true;const controller=new AbortController();const file=sourceIndex.files.find((item:Row)=>item.path==='authors.json');
  readCreatorSourcePart(file,String(sourceIndex.revision),controller.signal).then(items=>{if(active)setSourceAuthors({identity:sourceAuthorsKey,items});}).catch(error=>{if(active&&!controller.signal.aborted)setSourceAuthorsError(error.message);});
  return()=>{active=false;controller.abort();};
 },[sourceIndex,sourceAuthorsKey,sourceAuthors?.identity,tab,theme,sourceRetry]);
 useEffect(()=>{if(!(tab==='overview'||tab==='source'||tab==='accounts')||foundation)return;let active=true;const controller=new AbortController();setFoundationError('');setFoundationState('loading');(async()=>{try{
  const index=validateTableFoundationManifest(await readSourceIndex('/table-foundation/index.json',{signal:controller.signal,preferReplica:true,manifest:dataRef.current?.manifest})) as Row;
  const verified=await loadTableFoundationEdition(index,(file:Row,revision:string)=>readCreatorSourcePart(file,revision,controller.signal,'/table-foundation/'));
  if(active){setFoundation(verified);setFoundationError('');setFoundationState('ready');}
 }catch(error){if(active&&!controller.signal.aborted){setFoundationError((error as Error).message);setFoundationState('error');}}})();return()=>{active=false;controller.abort();};},[tab,theme,sourceRetry,foundationRetry,foundation]);
useEffect(()=>{if(!data?.dateIndexed||personal||['topics','source'].includes(tab)||!requestedRange||data.receipt?.requestKey===requestedRange.key)return;let active=true;const controller=new AbortController(),manifest=data.manifest;setRangeError('');const readPart=(part:string)=>read(manifest.asOf,part,manifest.files.find((f:Row)=>f.path===part),controller.signal);loadSummaryRange({manifest,readPart,request:requestedRange,signal:controller.signal}).then(loaded=>{if(active)setData(old=>old?.manifest.asOf===manifest.asOf?{...old,...loaded}:old);}).catch(e=>{if(active&&!controller.signal.aborted)setRangeError(e.message);});return()=>{active=false;controller.abort();};},[data?.manifest.asOf,data?.dateIndexed,data?.receipt?.requestKey,requestedRange?.key,personal,tab,rangeRetry]);
 const sourceEditionKey=sourceIndex?sourceEditionIdentity(sourceIndex):'';
 const foundationEditionKey=foundation?foundationEditionIdentity(foundation.index):'';
 useEffect(()=>{if(!data?.manifest?.asOf)return;let active=true,checking=false;const controller=new AbortController(),epoch=editionReadEpoch.current;const check=async()=>{if(checking||document.visibilityState!=='visible')return;checking=true;try{let sourceManifest=data.manifest;
  try{
   const r=await fetch('/api/replica',{cache:'no-store',signal:controller.signal});
   if(r.ok){const m=await r.json() as Row,g=m.manifest?.asOf;if(active&&Number.isFinite(Date.parse(g))){sourceManifest=m.manifest;if(Date.parse(g)>Date.parse(data.manifest.asOf))setAvailable(old=>!old||Date.parse(g)>Date.parse(old)?g:old);setAutoRetryTick(n=>n+1);}}
  }catch{if(controller.signal.aborted)return;}
  // Reuse the existing visibility/one-minute check. A same-generation source
  // publication is independent of the account replica's asOf timestamp.
  if(personal||!sourceIndex&&!foundation)return;
  const [nextSource,nextFoundation]=await Promise.all([
   sourceIndex?readSourceIndex('/creator-source/index.json',{signal:controller.signal,preferReplica:true,manifest:sourceManifest}).then(validateCreatorSourceIndex):Promise.resolve(null),
   foundation?readSourceIndex('/table-foundation/index.json',{signal:controller.signal,preferReplica:true,manifest:sourceManifest}).then(validateTableFoundationManifest):Promise.resolve(null),
  ]);
  const sourceChanged=!!nextSource&&sourceEditionIdentity(nextSource)!==sourceEditionKey;
  const foundationChanged=!!nextFoundation&&foundationEditionIdentity(nextFoundation)!==foundationEditionKey;
  if(!sourceChanged&&!foundationChanged){if(active)setSourceUpdateError('');return;}
  const [nextSourceParts,nextFoundationParts]=await Promise.all([
   sourceChanged?loadCreatorSourceEdition(nextSource,(file:Row,revision:string)=>readCreatorSourcePart(file,revision,controller.signal)):Promise.resolve(null),
   foundationChanged?loadTableFoundationEdition(nextFoundation,(file:Row,revision:string)=>readCreatorSourcePart(file,revision,controller.signal,'/table-foundation/')):Promise.resolve(null),
  ]);
  if(sourceChanged&&sourceIndex?.files.some((file:Row)=>file.path==='insights.json')&&!nextSourceParts?.insights)throw Error('新版来源缺少经营分析分区');
  if(!active||controller.signal.aborted||editionReadEpoch.current!==epoch)return;
  // React batches the verified index and all its parts. Search, sort, page,
  // scope and selected author live in separate state and remain untouched.
  if(nextSourceParts){setSourceIndex(nextSource);setSourceAuthors(nextSourceParts.authors);setSourceVerifiedParts(nextSourceParts);setSourceAuthorsError('');setSourceIndexError('');setSourceInsights(nextSourceParts.insights?.items??null);setSourceInsightsIdentity(nextSourceParts.insights?.identity??'');setSourceInsightsError('');}
  if(nextFoundationParts){setFoundation(nextFoundationParts);setFoundationError('');setFoundationState('ready');}
  setSourceUpdateError('');
 }catch(error){if(active&&!controller.signal.aborted&&(sourceIndex||foundation))setSourceUpdateError(readableLoadError(error));}finally{checking=false;}};void check();const timer=setInterval(check,60000);document.addEventListener?.('visibilitychange',check);return()=>{active=false;controller.abort();clearInterval(timer);document.removeEventListener?.('visibilitychange',check);};},[data?.manifest?.asOf,sourceEditionKey,foundationEditionKey,!!personal,sourceUpdateRetry]);
 useEffect(()=>{if(!available||!data||personal||account||loading||linkError||document.visibilityState!=='visible'||Date.parse(available)<=Date.parse(data.manifest.asOf))return;const previous=autoAdoptAttempt.current,now=Date.now();if(previous?.generation===available&&now<previous.after)return;autoAdoptAttempt.current={generation:available,after:now+55000};void load(tab==='topics'?'topics':tab==='source'?'source':'global',available);},[available,data?.manifest?.asOf,personal,account,loading,linkError,tab,autoRetryTick]);
 const roster=useMemo(()=>data?.accounts.filter((a:Row)=>matchesMatrixScope(a,{board,theme,tag}))||[],[data,board,theme,tag]);
 const scope=useMemo(()=>roster.filter((a:Row)=>a.enabled),[roster]);
 const rosterRows=useMemo(()=>data&&start&&end&&start<=end?rowsFor(roster,data.points,start,end):[],[data,roster,start,end]);
 const rows=useMemo(()=>rosterRows.filter((a:Row)=>a.enabled),[rosterRows]);const totals=useMemo(()=>aggregate(rows),[rows]);
 const comparableSuggestion=useMemo(()=>data?.summaryLoaded&&rangeReady?availableComparison(scope,data.points,start,end):null,[data,rangeReady,scope,start,end]);
 function chooseComparableSuggestion(){if(!comparableSuggestion)return;setStart(comparableSuggestion.start);setEnd(comparableSuggestion.end);setPeriodDraft('custom');appliedPeriod.current='custom';setCurveOffset(0);setComparison({compare:false,otherStart:'',otherEnd:''});setPeriodNote(`已切换到已核对的可比区间：${comparableSuggestion.start} → ${comparableSuggestion.end}，${comparableSuggestion.count} 个账号三项均有真实起止采样；不是完整9/12起历史。`);requestAnimationFrame(()=>document.getElementById('matrix-growth')?.focus({preventScroll:true}));}
 const sorted=useMemo(()=>orderRows(rosterRows.filter((a:Row)=>(rosterStatus==='all'||a.enabled===(rosterStatus==='enabled'))&&(!query||a.label.toLowerCase().includes(query.toLowerCase()))),sort,order),[rosterRows,rosterStatus,query,sort,order]);
 const themes=useMemo(()=>Array.from(new Map((data?.accounts||[]).map((a:Row)=>[a.classification.theme.key,a.classification.theme.label])).entries()) as [string,string][],[data]);
 const currentAuthorDirectory=useMemo(()=>{if(!sourceIndex||sourceAuthors?.identity!==sourceAuthorsKey)return {items:undefined,error:''};try{return {items:applyLiveAuthorLinks(sourceAuthors.items,data?.creatorSourceLinks,sourceIndex),error:''};}catch(error){return {items:undefined,error:(error as Error).message};}},[sourceIndex,sourceAuthors,sourceAuthorsKey,data?.creatorSourceLinks]);
 const tuantuanRosterState=useMemo(()=>{if(currentAuthorDirectory.error)return {roster:null,error:currentAuthorDirectory.error};if(!data||!currentAuthorDirectory.items||!foundation)return {roster:null,error:''};try{return {roster:buildTuantuanRoster(currentAuthorDirectory.items,data.accounts,foundation.authors,foundation.pendingAuthors),error:''};}catch(error){return {roster:null,error:(error as Error).message};}},[data,currentAuthorDirectory,foundation]);
 const tuantuanRoster=tuantuanRosterState.roster;
 const tags=useMemo(()=>Array.from(new Map((data?.accounts||[]).flatMap((a:Row)=>a.classification.labels.map((x:Row)=>[x.key,x.label]))).entries()) as [string,string][],[data]);
 const classificationState=useMemo(()=>{if(!data||linkError)return {menu:classificationMenu([]),error:''};try{return {menu:classificationMenu(data.accounts,{board,theme,selected:tag}),error:''};}catch(e){return {menu:classificationMenu([]),error:(e as Error).message};}},[data,board,theme,tag,linkError]);
 useEffect(()=>{setPage(1);},[board,theme,tag,query,rosterStatus,start,end,sort,order]);
 useEffect(()=>{if(!data||personal||loading||linkError||!initialized.current||!rangeReady)return;
  const selection={board,theme,tag,period:appliedPeriod.current,start,end};let path:string;try{path=preserveRosterSelection(preserveSourceSelection(workspaceSelectionPath(window.location.pathname,tab,selection,{sort,order,query,rosterStatus},comparison),window.location.search),window.location.search);}catch{return;}
  if(path===window.location.pathname+window.location.search+window.location.hash)return;
  window.history.replaceState(null,'',path);selectionRef.current={...selection,comparison};selectionSearch.current=window.location.search;addressSeen.current=path;
 },[data?.manifest.asOf,personal,loading,linkError,rangeReady,board,theme,tag,start,end,tab,periodNote,sort,order,query,rosterStatus,comparison]);
 useEffect(()=>{setPage(p=>Math.min(p,Math.max(1,Math.ceil(sorted.length/20))));},[sorted.length]);
 useEffect(()=>{let active=true;const controller=new AbortController();if(!account||!data)return;const scope=account.id+'@'+data.manifest.asOf;if(historyScope.current!==scope){historyScope.current=scope;historyViews.current={};historyRestore.current=null;setHPage(1);setHSort(kind==='daily'?'date':kind==='works'?'publishedAt':'capturedAt');setHOrder('desc');}setHistory(null);setHError('');const part=(kind==='daily'?'daily':kind==='works'?'works':'work-metrics')+'/'+account.id+'.json';if(!data.manifest.files.some((f:Row)=>f.path===part)){setHistory({items:[]});return;}read(data.manifest.asOf,part,data.manifest.files.find((f:Row)=>f.path===part),controller.signal).then(x=>{if(active)setHistory(x);}).catch(e=>{if(active)setHError(e.message);});return()=>{active=false;controller.abort();};},[account?.id,kind,data,hRetry]);
 const workPublication=useMemo(()=>{
  if(kind!=='works'||!history||!account||!data)return {model:null,error:''};
  try{return {model:accountDailyPublication(history.items,{targetId:account.id,platform:account.platform,
   asOf:data.manifest.asOf,date:publicationDate||publicationBusinessDay(data.manifest.asOf)}),error:''};}
  catch(error){return {model:null,error:(error as Error).message};}
 },[history,kind,account?.id,account?.platform,data?.manifest.asOf,publicationDate]);
 const publicationControls=kind==='works'&&(workPublication.model?<AuthorDailyPublishing key={publicationScope} model={workPublication.model} onlyDay={publicationOnlyDay}
  onDate={date=>{setPublicationSelection({scope:publicationScope,date,onlyDay:publicationOnlyDay});setHPage(1);}}
  onFilter={onlyDay=>{setPublicationSelection({scope:publicationScope,date:publicationDate,onlyDay});setHPage(1);}}/>
  :workPublication.error?<div className="error" role="alert">{workPublication.error}<Button variant="outline" onClick={()=>{setPublicationSelection({scope:publicationScope,date:'',onlyDay:false});setHPage(1);}}>恢复全部作品与版本截止日</Button></div>:null);
 const hRows=useMemo(()=>{
  let items=history?.items||[];
  if(kind==='works'&&publicationOnlyDay)items=workPublication.model?.rows??[];
  if(kind==='workMetrics'&&work)items=items.filter((x:Row)=>x.workId===work);
  return [...items].sort((a:Row,b:Row)=>{
   if(kind==='works'&&hSort==='publishedAt')return compareWorkPublication(a,b,hOrder);
   const idOrder=String(a.id).localeCompare(String(b.id),'zh-CN',{numeric:true});
   const workMetric=kind==='works'&&(hSort==='likes'||hSort==='plays');
   const x=workMetric?presentUnifiedWorkMetric(a,hSort).value:a[hSort];
   const y=workMetric?presentUnifiedWorkMetric(b,hSort).value:b[hSort];
   if(x==null||y==null)return x==null&&y==null?idOrder:x==null?1:-1;
   return (typeof x==='number'?x-y:String(x).localeCompare(String(y)))*(hOrder==='asc'?1:-1)||idOrder;
  });
 },[history,kind,work,hSort,hOrder,publicationOnlyDay,workPublication.model]);
 useEffect(()=>{if(!history)return;const last=Math.max(1,Math.ceil(hRows.length/20));if(hPage>last){setHPage(last);return;}const pending=historyRestore.current;if(!pending||pending.scope!==historyScope.current||!account||pending.scope!==account.id+'@'+data?.manifest.asOf)return;historyRestore.current=null;const active=document.activeElement,dialog=historyDialog.current;if(!dialog||active!==pending.active&&active!==document.body&&active!==dialog)return;if(pending.enter&&kind==='workMetrics'){historyBack.current?.focus({preventScroll:true});dialog.scrollTop=0;}else if(!pending.enter&&kind==='works'){const target=dialog.querySelector<HTMLButtonElement>('[data-work-history="'+pending.workId+'"]');target?.focus({preventScroll:true});dialog.scrollTop=pending.scrollTop||0;const table=dialog.querySelector<HTMLElement>('[data-history-table] [data-slot="table-container"]');if(table)table.scrollLeft=pending.scrollLeft||0;}},[history,hRows,hPage,account?.id,data?.manifest.asOf,kind]);
 function rank(key:string){if(sort===key)setOrder(order==='asc'?'desc':'asc');else{setSort(key);setOrder('desc');}}
 function hRank(key:string){if(hSort===key)setHOrder(hOrder==='asc'?'desc':'asc');else{setHSort(key);setHOrder('desc');}setHPage(1);}
 function open(a:Row,button:HTMLButtonElement|null){authorReturnFocus.current=button;historyScope.current='';historyViews.current={};historyRestore.current=null;setHistory(null);setHError('');setHPage(1);setKind('daily');setHSort('date');setHOrder('desc');setWork(null);setAccount(a);}
 function applyPeriod(){if(!data)return;try{const w=data.dateIndexed?periodWindowFromCatalog(periodDraft,scope,data.manifest.asOf):periodWindow(periodDraft,scope,data.points,data.manifest.asOf);setCurveOffset(0);setPeriodNote(w.note);if(w.start&&w.end){appliedPeriod.current=periodDraft;setStart(w.start);setEnd(w.end);}}catch(e){setPeriodNote((e as Error).message);}}
 function chooseDate(which:'start'|'end',value:string){setCurveOffset(0);setPeriodDraft('custom');appliedPeriod.current='custom';setPeriodNote('自选的真实观察日；缺少端点不补零，刷新与切换分类不会改变日期。');if(which==='start')setStart(value);else setEnd(value);}
 const returnPath=personal&&data?workspaceReturnPath(workspaceReturn.current,{pathname:window.location.pathname,generation:data.manifest.asOf}):null;
 const globalTab=returnPath?returnPath.split('#')[1]:tab;
 const rosterEligible=globalTab==='accounts'&&((theme==='all'&&board==='all')||(theme==='tuantuan'&&(board==='all'||board==='一条小团团切片矩阵')));
 const matrixRoster=theme==='all'?includeOtherMatrixAccounts(tuantuanRoster,data?.accounts??[]):tuantuanRoster;
 const overviewFullRoster=((theme==='all'&&board==='all')||(theme==='tuantuan'&&(board==='all'||board==='一条小团团切片矩阵')))?allAuthorOverview(matrixRoster,rosterRows,tag):null;
 const overviewUsesFullRoster=(theme==='all'&&board==='all')||(theme==='tuantuan'&&(board==='all'||board==='一条小团团切片矩阵'));
 const showRoster=rosterEligible&&rosterPanel==='authors';
 const activeNavigation=personal?'accounts':tab;
 const nav=(name:string,label:string)=>{const Icon=({overview:LayoutDashboard,accounts:ChartNoAxesCombined,source:UsersRound,topics:Hash} as const)[name as 'overview'|'accounts'|'source'|'topics'];return <Button key={name} variant={activeNavigation===name?'secondary':'ghost'} onClick={()=>navigateWorkspace(name,false,name==='accounts'?'authors':undefined)} aria-current={activeNavigation===name?'page':undefined}>{Icon&&<Icon size={17} strokeWidth={1.6} aria-hidden="true"/>}{label}</Button>;};
 const pager=(n:number,p:number,change:(x:number)=>void)=><Pager count={n} page={p} change={change} scope={JSON.stringify([tab,personal?.id,account?.id,kind,work,data?.manifest.asOf,loading,board,theme,tag,query,rosterStatus,start,end,sort,order,hSort,hOrder])}/>;
 const workspaceGrowth=data&&<GrowthPanel key="workspace-growth" accounts={scope} points={data.points} manifest={data.manifest} start={start} end={end} comparison={comparison} onComparison={setComparison} offset={curveOffset} onOffset={setCurveOffset} ready={rangeReady} pendingError={dateValidationError||rangeError} suspended={!!personal||!!linkError} scopeKey={JSON.stringify([board,theme,tag,globalTab])}/>;
 const workspaceGroups=data&&<div key="workspace-groups" hidden={!rangeReady}>{globalTab==='overview'&&<GroupSummary rows={rows} start={start} end={end} tuantuanRosterCount={tuantuanRoster?.counts.all} onSelect={(dimension,key)=>{if(dimension==='theme'&&key==='tuantuan'){openTuantuanRoster();return;}if(dimension==='theme')setTheme(key);else setTag(key);navigateWorkspace('accounts');const epoch=navigationEpoch.current;requestAnimationFrame(()=>{if(navigationEpoch.current!==epoch)return;searchRef.current?.focus({preventScroll:true});searchRef.current?.scrollIntoView({block:'center',behavior:'instant'});});}}/>}</div>;
 const workspaceDaily=data&&globalTab==='overview'&&<DailyCoveragePanel key={[data.manifest.asOf,board,theme,tag,start,end,curveOffset].join('/')} accounts={scope} points={data.points} manifest={data.manifest} start={start} end={end} offset={curveOffset} onOffset={setCurveOffset} onAccount={standalone} ready={rangeReady} suspended={!!personal||!!linkError}/>;
 const runtimeStatus=<div className="status-strip"><span>公开只读 · 非实时数据</span><span>采集仍需本机在线；关机可浏览已保存数据</span><details><summary>运行口径</summary><p>采样截止与实际发布时间分别保留。公开发布不是新采集，不保存登录凭据。</p></details></div>;
 const accountHeadingMeta=rosterEligible&&matrixRoster?`全部矩阵作者 ${fmt(matrixRoster.counts.all)} 位 · 其中 ${fmt(scope.length)} 个已启用主页监控 · 表格与监控身份按证据合并`:`当前范围 ${fmt(scope.length)} 个启用监控账号`;
 const overviewAccountScope=[board==='all'?'全部矩阵（不含独立主播）':data?.boards.find((b:Row)=>b.key===board)?.name||board,theme==='all'?'全部主题':themes.find(([key])=>key===theme)?.[1]||theme,tag==='all'?'全部内容分类':tags.find(([key])=>key===tag)?.[1]||tag].join(' · ');
 const overviewSampling=data&&<OverviewAccountPreview metrics={totals} accountCount={scope.length} accounts={scope} asOf={data.manifest.asOf} rosterTotal={tuantuanRoster?.counts.all??null} scopeLabel={overviewAccountScope} start={start} end={end} ready={!!data.summaryLoaded&&rangeReady} status={data.summaryError||dateValidationError||rangeError||undefined} onOpenAccounts={()=>navigateWorkspace('accounts',false,'changes')} trendPreview={metric=><OverviewTrendPreview accounts={scope} points={data.points} start={start} end={end} ready={!!data.summaryLoaded&&rangeReady} metric={metric}/>} trend={workspaceGrowth}/>;
 const workspaceAccounts=data&&<div className="account-ledger" key="workspace-accounts" hidden={!rangeReady}>
 {board!=='all'&&board!=='一条小团团切片矩阵'&&<OtherSourceCatalog foundation={foundation} accounts={data.accounts} board={board} onOpenAccount={standalone}/>}
 <section className="panel"><div className="panel-head"><h2>账号数据</h2><label>账号状态<select value={rosterStatus} onChange={e=>setRosterStatus(e.target.value)}><option value="enabled">启用账号</option><option value="paused">暂停账号（历史）</option><option value="all">全部账号</option></select></label><Input ref={searchRef} className="search" maxLength={200} value={query} placeholder="搜索作者名称" aria-label="搜索作者" onChange={e=>setQuery(e.target.value)}/><Button variant="outline" onClick={()=>download(accountExport(sorted,data.manifest,start,end),'矩阵账号-'+start+'-'+end+'.csv')}>导出全部结果</Button></div><p className="meta">名称搜索与账号状态只筛选下方列表和导出；经营卡片始终统计所选矩阵、主题、分类的启用账号。导出包含稳定账号编号、平台、真实端点时间与公开日历史分区指纹。</p><div className="list-context" aria-label="当前列表排序"><div className="follower-sort-shortcuts" role="group" aria-label="粉丝变化快捷排序" aria-describedby="follower-sort-help">{([["desc","涨粉优先"],["asc","掉粉优先"]] as const).map(([direction,label])=><Button key={direction} type="button" variant={sort==='followers.delta'&&order===direction?'secondary':'outline'} aria-pressed={sort==='followers.delta'&&order===direction} onClick={()=>{setSort('followers.delta');setOrder(direction);}}>{label}</Button>)}</div><span>当前排序 <strong>{(workspaceSortLabels as Record<string,string>)[sort]} · {order==='asc'?'升序 ↑':'降序 ↓'}</strong></span><small id="follower-sort-help">按所选区间粉丝净变化排序，不筛掉账号 · 缺测始终置后</small></div>{pager(sorted.length,page,setPage)}<Table bounded className="account-metrics-table" scrollResetKey={JSON.stringify([page,board,theme,tag,query,rosterStatus,start,end,sort,order])} scrollLabel="账号数据，方向键与 PageUp、PageDown 滚动当前页" staticLabel="账号数据表"><colgroup><col className="account-metrics-author-column"/><col span={6}/></colgroup><TableHeader><TableRow><TableHead scope="col" data-column="author" aria-sort={sort==='label'?(order==='asc'?'ascending':'descending'):'none'}><Button variant="ghost" onClick={()=>rank('label')}>作者{sort==='label'?(order==='asc'?' ↑':' ↓'):''}</Button></TableHead>{[['followers.value','粉丝'],['followers.delta','粉丝变化'],['likes.value','点赞'],['likes.delta','点赞变化'],['posts.value','作品存量'],['posts.delta','作品变化']].map(([key,label])=><TableHead key={key} scope="col" data-column={key} aria-sort={sort===key?(order==='asc'?'ascending':'descending'):'none'}><Button variant="ghost" onClick={()=>rank(key)}>{label}{sort===key?(order==='asc'?' ↑':' ↓'):''}</Button></TableHead>)}</TableRow></TableHeader><TableBody>{sorted.slice((page-1)*20,page*20).map((a:Row)=><TableRow key={a.id}><TableCell data-column="author"><Button type="button" className="author" variant="link" aria-label={`查看${a.label}的经营详情`} onClick={e=>standalone(a,e.currentTarget)}>{a.label}</Button><div className="account-row-meta"><span className="account-row-context"><span>{a.enabled?'启用':'暂停 · 仅历史'}</span><span>{a.classification.theme.label}</span></span><Button type="button" className="account-row-history" variant="ghost" aria-label={`查看${a.label}的历史`} onClick={e=>open(a,e.currentTarget)}>历史</Button></div><AccountClassification classification={a.classification} showTheme={false}/></TableCell>{['followers','likes','posts'].flatMap(k=>[<TableCell key={k+'v'} data-column={k+'.value'}><span className="account-metric-number">{fmt(a.metrics[k].value)}</span></TableCell>,<TableCell key={k+'d'} data-column={k+'.delta'} className={a.metrics[k].delta<0?'negative':a.metrics[k].delta>0?'positive':''}><span className="account-metric-value"><span className="account-metric-number">{diff(a.metrics[k].delta)}</span><ChangeIndicator value={a.metrics[k].delta}/></span></TableCell>])}</TableRow>)}</TableBody></Table>{!sorted.length&&<p className="empty">当前范围没有账号，请调整筛选。</p>}{pager(sorted.length,page,setPage)}</section></div>;
 return <div className="workspace"><button className="observatory-skip" onClick={()=>{document.getElementById('main')?.focus();}}>跳到工作区</button><aside className="sidebar"><a className="wordmark" href="/#overview" onClick={e=>{if(e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;e.preventDefault();navigateWorkspace('overview');}}>矩阵<span>OBSERVATORY / MCN</span></a><nav><span className="nav-section-label">工作区</span>{nav('overview','总览')}{nav('accounts','矩阵账号')}{nav('source','作者与作品')}{nav('topics','话题数据')}</nav><div className="side-note">公开只读<small>数据不是实时采集；管理权限不公开</small></div></aside><main id="main" tabIndex={-1}><CollectionConsole/><header className="topbar"><MotionPreference/><Badge variant="outline">已保存数据</Badge>{data?<span className="sample-status"><span>公开数据截至</span> <time dateTime={data.manifest.asOf}>{bj(data.manifest.asOf)}</time><span> · 北京时间</span></span>:<span>连接公开数据</span>}<Button variant="outline" disabled={loading} onClick={refreshSavedData}>{loading?'读取中…':'重新读取已保存数据'}</Button></header><div className="content"><div className="heading"><ObservatoryAtmosphere/><div><p className="eyebrow">MATRIX OBSERVATORY <span>/ 矩阵经营工作台</span></p><h1 ref={headingRef} tabIndex={-1}>{personal?'账号详情':tab==='topics'?'话题数据':tab==='source'?'作者与作品':tab==='accounts'?(showRoster?(theme==='all'?'全部矩阵作者':'团团全部矩阵作者'):'账号变化'):'矩阵数据总览'}</h1></div>{data&&<span className="meta">{personal?'查看这个账号的已保存数据与变化':tab==='overview'?'查看全部作者、已保存作品与每日变化':tab==='source'?'按作者、内容类型、作品发布日期查找':tab==='topics'?'参与人数与实际播放量 · 独立于账号筛选':accountHeadingMeta}</span>}</div>
 {linkError&&<div className="error" role="alert">{linkError} <Button variant="outline" onClick={returnToAccounts}>返回账号列表</Button></div>}
 {error&&tab==='source'&&!personal&&<p className="meta" role="alert">新版账号关联暂未通过核验：{error}。{data?'仍显示上次成功读取的账号版本；来源表的筛选和搜索保持不变。':'表格作者和作品可继续搜索、筛选和导出。'}</p>}
 {error&&tab==='overview'&&!personal&&<div className="error dashboard-error" role="alert"><p>本次读取已保存数据失败：{error}。{data?`仍显示上次成功读取的 ${bj(data.manifest.asOf)} 版本，不能视为最新数据。`:'尚无可展示的账号快照。'}</p><div className="dashboard-error__actions"><Button variant="outline" disabled={loading} onClick={()=>void load()}>重新读取数据</Button></div></div>}
 {error&&tab!=='overview'&&(tab!=='source'||personal)&&<div className="error dashboard-error" role="alert"><p>{error} {data&&!personal&&'保留上次已加载的数据。'} {data&&personal&&personal.generation===data.manifest.asOf&&'保留已校验的同一发布版本详情；本次刷新没有取得新数据。'}</p><div className="dashboard-error__actions"><Button variant="outline" disabled={loading} onClick={()=>void load()}>重试读取</Button>{personal&&<Button variant="outline" onClick={returnToAccounts}>返回账号列表</Button>}</div></div>}
 {available&&<div className="notice" role="status" aria-live="polite">新的保存数据已发布（{bj(available)}）。{personal?'当前账号详情固定在分享版本，返回列表后会自动核验新版。':loading?'正在核验；通过后自动更新，原筛选与已应用日期保持不变。':'后台将自动重试核验；未通过前继续显示旧版。'}{!personal&&<Button variant="outline" disabled={loading} onClick={refreshSavedData}>立即重试</Button>}</div>}
 {sourceUpdateError&&!personal&&<div className="notice" role="alert">新版表格来源核验失败，仍显示上一版已核验数据：{sourceUpdateError}。<Button variant="outline" onClick={()=>{setSourceUpdateError('');setSourceUpdateRetry(value=>value+1);}}>重新核验新版</Button></div>}
 {data&&!personal&&tab==='overview'&&<section className="overview-scope-controls" aria-label="总览范围与日期"><div className="filters"><label>矩阵<select value={board} onChange={e=>setBoard(e.target.value)}><option value="all">全部矩阵</option>{data.boards.map((item:Row)=><option key={item.key} value={item.key}>{item.name}</option>)}</select></label><label>大主题<select value={theme} onChange={e=>setTheme(e.target.value)}><option value="all">全部主题</option>{themes.map(([key,name])=><option key={key} value={key}>{name}</option>)}</select></label>{renderClassificationFilter(classificationState.menu,tag,chooseClassification,'overview-classification-help')}<label>统计周期<select value={periodDraft} onChange={e=>setPeriodDraft(e.target.value)}>{Object.entries(periodNames).map(([key,name])=><option key={key} value={key} disabled={data.dateIndexed&&key==='observed'}>{name}</option>)}</select></label><Button variant="outline" disabled={periodDraft==='custom'} onClick={applyPeriod}>应用周期</Button><label>起点<Input type="date" value={start} max={end||undefined} onChange={e=>chooseDate('start',e.target.value)}/></label><label>终点<Input type="date" value={end} min={start||undefined} onChange={e=>chooseDate('end',e.target.value)}/></label></div><p className="meta" role="status">{periodNote}{periodDraft!==appliedPeriod.current?' · 周期尚未应用':''}{dateValidationError?' · '+dateValidationError:''}</p></section>}
 {!personal&&tab==='overview'&&<><OverviewWayfinder ready={!!data} fullRoster={overviewUsesFullRoster}/>{sourceAuthorsError&&!sourceIndexError&&!sourceInsightsError&&!foundationError&&<div className="notice" role="alert">作者关联信息暂未读到：{sourceAuthorsError}。跨表名册去重待核，不影响作品与图表的独立读取。<Button variant="outline" onClick={()=>{setSourceAuthorsError('');setSourceRetry(value=>value+1);}}>重新读取作者关联</Button></div>}<SourceOperations insights={sourceInsights} source={sourceIndex} foundation={foundation} sourceRosterCount={sourceAuthorsError||!tuantuanRoster?null:tuantuanRoster.counts.source-(tuantuanRoster.counts.pendingSource??0)} error={sourceInsightsError||sourceIndexError} foundationError={foundationError} accountPreview={data&&(overviewUsesFullRoster?<AllAuthorOverview availableComparison={comparableSuggestion} onChooseComparison={chooseComparableSuggestion} roster={overviewFullRoster} metricRows={rosterRows} ready={!!data.summaryLoaded&&rangeReady} error={sourceError||foundationError||tuantuanRosterState.error} start={start} end={end} scopeLabel={overviewAccountScope} onOpenAccount={standalone} onOpenSourceWorks={inspectRosterWorks}>{overviewSampling}</AllAuthorOverview>:overviewSampling)} onInspect={inspectSource} onNavigateAccounts={()=>{selectRosterPanel('changes');}}/>{data&&<ContinuousPublishing manifest={data.manifest} startDate={start} endDate={end} board={board} theme={theme} tag={tag} scopeLabel={overviewAccountScope}/>}</>}
 {(sourceVisited||tab==='source')&&<div key="source-workspace" hidden={!!personal||tab!=='source'||!!linkError}>
 {(board!=='all'||theme!=='all'||tag!=='all')&&<div className="notice" role="status">账号页当前选择的矩阵、主题和内容分类不用于筛选下方表格；这里展示团团来源表的完整记录。请用本页“赛道”查看来源分类。<Button variant="outline" onClick={()=>navigateWorkspace('accounts')}>返回账号分类</Button></div>}
 {sourceAuthorsError&&<div role="alert" className="error">作者关联信息暂未读到：{sourceAuthorsError}。作品记录仍可查看。<Button variant="outline" onClick={()=>{setSourceAuthorsError('');setSourceRetry(value=>value+1);}}>重新读取作者关联</Button></div>}
 <CreatorSourceLedger source={sourceIndex} sourceError={sourceIndexError} onRetrySource={()=>{setSourceIndexError('');setSourceRetry(value=>value+1);}} foundation={foundation} foundationState={foundationState} foundationError={foundationError} onRetryFoundation={()=>{setFoundationError('');setFoundationState('loading');setFoundationRetry(value=>value+1);}} accounts={data?.accounts??[]} authorDirectory={currentAuthorDirectory.items} preverified={sourceVerifiedParts} rosterReturn={rosterReturn?{authorId:rosterReturn.authorId,onReturn:returnToRoster}:undefined} onOpenAccount={standalone} focus={sourceFocus} addressMode={true} active={!personal&&tab==='source'}/>
 <OtherSourceCatalog foundation={foundation} accounts={data?.accounts??[]} onOpenAccount={standalone}/></div>}
 {data&&personal&&!linkError&&personal.generation===data.manifest.asOf&&<AccountPanel key={personal.id+'-'+data.manifest.asOf} account={data.accounts.find((a:Row)=>a.id===personal.id)} manifest={data.manifest} boards={data.boards} request={personal} onReturn={returnToAccounts} returnLabel={returnPath?'返回原核对页':'返回账号列表'} onAddress={personalAddress} onHistory={(a,trigger)=>open(a,trigger??null)}/>}
 {data&&!['overview','source'].includes(globalTab)&&<div hidden={!!personal||!!linkError}>{globalTab!=='topics'&&runtimeStatus}
 {globalTab==='overview'&&<>{sourceError&&<p className="error" role="alert">团团名册暂未合并：{sourceError}</p>}{foundationError&&<p className="error" role="alert">其他表格暂未合并：{foundationError}</p>}{tuantuanRosterState.error&&<p className="error" role="alert">团团名册无法核对：{tuantuanRosterState.error}</p>}<TuantuanRosterSummary source={sourceIndex} roster={tuantuanRoster} foundation={foundation} selectTheme={openTuantuanRoster} openAccounts={openTuantuanRoster}/></>}
 {rosterEligible&&<section className="account-task-switch" aria-label="账号页查看方式"><div><strong>矩阵作者总览{matrixRoster?' · '+fmt(matrixRoster.counts.all)+' 位':''}</strong><p>全部登记作者都在这里。已采集账号的涨跌是其中一部分，不代表矩阵总人数。</p></div><div role="group" aria-label="选择查看任务"><Button variant={!showRoster?'secondary':'outline'} aria-pressed={!showRoster} onClick={()=>selectRosterPanel('changes')}>只看已采集账号变化</Button><Button variant={showRoster?'secondary':'outline'} aria-pressed={showRoster} onClick={()=>selectRosterPanel('authors')}>全部矩阵作者{matrixRoster?' · '+fmt(matrixRoster.counts.all):''}</Button></div></section>}
 {rosterEligible&&<div hidden={!showRoster}><div className="roster-scope">{renderClassificationFilter(classificationState.menu,tag,chooseClassification,'roster-classification-help')}<p>名册包含表格登记与主页监控账号。这里只按内容类型筛选，不受账号观察日期影响。</p></div>{(sourceError||foundationError||tuantuanRosterState.error)?<div role="alert" className="error">完整名册暂不可读：{sourceError||foundationError||tuantuanRosterState.error}<Button variant="outline" disabled={loading} onClick={refreshSavedData}>重试完整名册</Button></div>:<TuantuanRosterTable roster={matrixRoster} classification={tag} metricRows={rosterRows} changesReady={!!data.summaryLoaded&&rangeReady} periodLabel={`${start} → ${end}`} addressMode={true} active={!personal&&tab==='accounts'&&showRoster} onOpenAccount={standalone} onOpenSourceWorks={inspectRosterWorks}/>}</div>}
 {globalTab!=='source'&&globalTab!=='topics'&&!showRoster&&<CoveragePanel accounts={data.accounts} topics={data.topics} asOf={data.manifest.asOf} onAccount={standalone}/>}
 {!['topics','source'].includes(globalTab)&&!showRoster&&!data.summaryLoaded&&<section className="panel"><p className="error" role="status">{data.summaryError||'矩阵日历史尚未加载；独立账号与话题不依赖全局历史。'}</p><Button variant="outline" disabled={loading} onClick={()=>void load()}>读取矩阵日历史</Button><h2>账号目录</h2><Input className="search" maxLength={200} placeholder="搜索作者名称" aria-label="搜索目录作者" value={query} onChange={e=>setQuery(e.target.value)}/>{pager(roster.filter((a:Row)=>!query||a.label.toLowerCase().includes(query.toLowerCase())).length,page,setPage)}{roster.filter((a:Row)=>!query||a.label.toLowerCase().includes(query.toLowerCase())).slice((page-1)*20,page*20).map((a:Row)=><p key={a.id}><Button variant="link" onClick={e=>standalone(a,e.currentTarget)}>{a.label}</Button><span className="meta">{a.classification.theme.label} · {a.enabled?'启用':'暂停历史'}</span></p>)}</section>}
{!['topics','source'].includes(globalTab)&&!showRoster&&data.summaryLoaded&&<><section className="scope-toolbar"><div className="period-toolbar"><label>选择周期<select value={periodDraft} onChange={e=>setPeriodDraft(e.target.value)}>{Object.entries(periodNames).map(([k,n])=><option key={k} value={k} disabled={data.dateIndexed&&k==='observed'}>{n}{data.dateIndexed&&k==='observed'?'（需全历史覆盖审查）':''}</option>)}</select></label><Button variant="outline" disabled={periodDraft==='custom'} onClick={applyPeriod}>应用周期</Button><span className="meta">筛选与刷新保留日期；重新应用才更新周期。</span></div><div className="period-state" aria-live="polite"><div><small>{dateValidationError?'日期无效，统计已隐藏':rangeReady?'当前已应用':'正在核对日期'}</small><strong>{(periodNames as Record<string,string>)[appliedPeriod.current]}</strong><span>{start||'尚无起点'} → {end||'尚无终点'}</span></div>{periodDraft!==appliedPeriod.current&&<p className="period-pending">待应用：{(periodNames as Record<string,string>)[periodDraft]}<small>尚未改变统计；点击“应用周期”后生效。</small></p>}</div><p className="period-note" role="status">{periodNote}</p><details className="advanced-scope" open={advancedOpen} onToggle={event=>setAdvancedOpen(event.currentTarget.open)}><summary>高级筛选<span>矩阵 · 大主题 · 内容分类 · 自选日期</span></summary><section className="filters" aria-label="数据筛选"><label>矩阵<select value={board} onChange={e=>setBoard(e.target.value)}><option value="all">全部矩阵</option>{data.boards.map((b:Row)=><option key={b.key} value={b.key}>{b.name}</option>)}</select></label><label>大主题<select value={theme} onChange={e=>setTheme(e.target.value)}><option value="all">全部主题</option>{themes.map(([k,l])=><option key={k} value={k}>{l}</option>)}</select></label>{classificationState.error?<p className="error" role="alert">{classificationState.error}</p>:renderClassificationFilter(classificationState.menu,tag,chooseClassification)}<label>基准观察日<Input type="date" value={start} max={end} onChange={e=>chooseDate('start',e.target.value)}/></label><label>截止观察日<Input type="date" value={end} min={start} max={new Date(Date.parse(data.manifest.asOf)+28800000).toISOString().slice(0,10)} onChange={e=>chooseDate('end',e.target.value)}/></label></section></details></section>
 {!rangeReady&&<div className={(dateValidationError||rangeError)?'error':'notice'} role="status">{dateValidationError||rangeError||'正在核对所选日期与比较端点，完成后再显示和导出统计。'}{!dateValidationError&&rangeError&&<Button variant="outline" onClick={()=>setRangeRetry(n=>n+1)}>重试日期读取</Button>}<Button variant="outline" onClick={()=>{setComparison({compare:false,otherStart:'',otherEnd:''});setCurveOffset(0);}}>取消比较，返回首屏曲线</Button></div>}
 <p className="active-scope" aria-label="当前生效范围" ref={scopeFocus} tabIndex={-1}><strong>{board==='all'?'全部矩阵（不含独立主播）':data.boards.find((b:Row)=>b.key===board)?.name||board}</strong><span className="scope-dimension">{theme==='all'?'全部主题':themes.find(([key])=>key===theme)?.[1]||theme}{theme!=='all'&&<Button type="button" variant="ghost" aria-label="清除大主题筛选，保留其他条件" onClick={()=>clearScope('theme')}>清除主题</Button>}</span><span className="scope-dimension">{tag==='all'?'全部分类':tags.find(([key])=>key===tag)?.[1]||tag}{tag!=='all'&&<Button type="button" variant="ghost" aria-label="清除内容分类筛选，保留其他条件" onClick={()=>clearScope('tag')}>清除分类</Button>}</span><span>当前 {start} → {end}</span>{comparison.compare&&<span>比较 {comparison.otherStart||'待选起点'} → {comparison.otherEnd||'待选终点'}</span>}{!rangeReady&&<span>待核对，尚未应用</span>}</p>
 <div hidden={!rangeReady}>
 <p className="scope">{start} 采样 → {end} 采样 · {scope.length} 个启用账号 · 同账号两个真实端点相减，缺测不补零</p><MetricLedger metrics={totals} count={scope.length} start={start} end={end}/>
 </div>{globalTab==='accounts'?[workspaceAccounts,workspaceGrowth]:[workspaceGrowth,workspaceGroups,workspaceDaily,workspaceAccounts]}</>}
 {globalTab==='topics'&&<><p className="scope topic-intro">话题独立于矩阵筛选 · 只看参与人数与实际播放量 · 缺测不补零</p><div className="topics">{data.topics.topics.map((t:Row)=><TopicHistory key={t.id} topic={{id:t.id,label:t.label}} items={data.topics.items}/>)}</div><div className="topic-trust" aria-label="数据来源与完整度">{runtimeStatus}<CoveragePanel accounts={data.accounts} topics={data.topics} asOf={data.manifest.asOf} onAccount={standalone}/></div></>}
 <footer>已发布 {bj(data.publishedAt)} · 已保存作品不代表平台作品全集，主页和作品覆盖分开核验。</footer></div>}{loading&&!data&&!error&&!linkError&&<section className="dashboard-loading" role="status" aria-live="polite"><div><span>正在核对</span><h2>读取已保存的数据</h2><p>账号、作品与话题会在来源校验后显示；尚未读到的数字不会临时填入。</p></div><div className="dashboard-loading__preview" aria-hidden="true"><i/><i/><i/></div></section>}
 </div></main>{authorWorks&&data&&<AuthorUnifiedWorks key={authorWorks.douyinId||authorWorks.rowKey} author={authorWorks} manifest={data.manifest} source={sourceIndex} foundation={foundation} preverified={sourceVerifiedParts?.works??null} workOwnerProjection={data.creatorSourceLinks} onOpenAccount={id=>{const owner=data.accounts.find((item:Row)=>item.id===id);if(owner){setAuthorWorks(null);standalone(owner,authorWorksTrigger.current);}}} returnFocus={authorWorksTrigger.current} onClose={()=>setAuthorWorks(null)}/>}<Dialog open={!!account} onOpenChange={x=>{if(!x)setAccount(null);}}><DialogContent ref={historyDialog} className="history-dialog" onCloseAutoFocus={event=>{event.preventDefault();const preferred=authorReturnFocus.current;if(preferred?.isConnected&&!preferred.disabled)preferred.focus({preventScroll:true});if(!preferred||document.activeElement!==preferred){const fallback=searchRef.current?.isConnected?searchRef.current:headingRef.current;fallback?.focus({preventScroll:true});if(document.activeElement!==fallback)headingRef.current?.focus({preventScroll:true});}}}><DialogTitle>{account?.label}</DialogTitle><DialogDescription>已保存每日合并统计与作品历史 · 固定截止 {bj(data?.manifest.asOf)} · 缺测不补零</DialogDescription>{account&&<Button variant="outline" onClick={()=>personal?setAccount(null):standalone(account,authorReturnFocus.current)}>打开独立账号页面</Button>}{!personal&&account?.metrics&&<EndpointSources metrics={account.metrics} start={start} end={end}/>}<div className="history-tabs">{[['daily','每日统计'],['works','全部保存作品']].map(([k,l])=><Button variant={kind===k?'secondary':'outline'} key={k} onClick={()=>chooseHistory(k)}>{l}</Button>)}{kind==='workMetrics'&&<><Button variant="secondary">作品指标历史</Button><Button ref={historyBack} variant="outline" onClick={()=>chooseHistory('works')}>返回作品列表</Button></>}</div><p className="meta">{kind==='daily'?'日观察校验来源哈希、账号身份和指标向量；变化只比较相邻北京日，缺日不补零。作品存量变化不等于当天发布数，发片记录见“全部保存作品”。':'已保存作品指标，未经独立核验，不代表平台全集或可靠实际播放证明。'}</p>{hError?<div role="alert" className="error">{hError} <Button variant="outline" onClick={()=>{setHistory(null);setHError('');setHRetry(x=>x+1);}}>重试读取当前历史</Button></div>:!history?<p role="status">读取历史…</p>:kind==='workMetrics'&&account&&data&&work!==null?<WorkLikesHistory key={account.id+':'+work+':'+data?.manifest.asOf} records={history.items} account={account} manifest={data.manifest} workId={work}/>:<>{publicationControls}<div className="panel-head"><span>{kind==='works'?(publicationOnlyDay?'所选日期已保存':'全部已保存'):'全部'} {hRows.length} 条</span><Button variant="outline" disabled={kind==='works'&&publicationOnlyDay&&(!workPublication.model||!hRows.length)} onClick={()=>{try{download(historyExport({rows:hRows,kind,account,manifest:data?.manifest}),account?.id+'-'+kind+(kind==='works'&&publicationOnlyDay?'-'+workPublication.model?.date:'')+'.csv');}catch(e){setHError((e as Error).message);}}}>{kind==='works'&&publicationOnlyDay?'导出所选日期作品':'导出全部历史'}</Button></div>{pager(hRows.length,hPage,setHPage)}<div data-history-table className="table-scroll-shell"><Table><TableHeader><TableRow>{(kind==='daily'?[['date','观察日'],['followers','粉丝'],['followersDelta','粉丝变化'],['likes','点赞'],['likesDelta','点赞变化'],['posts','作品存量'],['postsDelta','作品存量变化']]:kind==='works'?[['publishedAt','作品日期 / 来源'],['caption','作品'],['likes','点赞采用值'],['comments','评论'],['plays','播放字段采用值']]:[['capturedAt','观察时间'],['likes','点赞'],['comments','评论'],['shares','分享'],['plays','来源播放字段']]).map(([k,l])=><TableHead key={k} aria-sort={hSort===k?(hOrder==='asc'?'ascending':'descending'):'none'}><Button variant="ghost" onClick={()=>hRank(k)}>{l}{hSort===k?(hOrder==='asc'?' ↑':' ↓'):''}</Button></TableHead>)}</TableRow></TableHeader><TableBody>{hRows.slice((hPage-1)*20,hPage*20).map((x:Row)=>kind==='daily'?<TableRow key={x.id}><TableCell><details><summary>{x.date}</summary><p>{bj(x.capturedAt)}</p><small>SHA256 {x.sourceChecksum}</small></details></TableCell>{['followers','likes','posts'].flatMap(k=>[<TableCell key={k}>{fmt(x[k])}{k==='plays'&&<small>{x.playsEvidence?.note}</small>}</TableCell>,<TableCell key={k+'d'} className={x[k+'Delta']<0?'negative':x[k+'Delta']>0?'positive':''}>{diff(x[k+'Delta'])}</TableCell>])}</TableRow>:kind==='works'?<TableRow key={x.id}>{workDateCell(x)}<TableCell>{x.url?<a href={x.url} target="_blank" rel="noopener noreferrer">{x.caption||'无已核验标题'}</a>:x.caption||'未知标题'}{Number.isSafeInteger(x.id)&&x.id>0?<Button data-work-history={x.id} variant="link" onClick={()=>inspectWork(x.id)}>查看指标历史</Button>:<small>仅来源表作品，暂无逐条采样历史</small>}</TableCell><TableCell><UnifiedWorkMetric work={x} metric="likes"/></TableCell><TableCell>{fmt(x.comments)}</TableCell><TableCell><UnifiedWorkMetric work={x} metric="plays"/></TableCell></TableRow>:<TableRow key={x.id}><TableCell>{bj(x.capturedAt)}</TableCell>{['likes','comments','shares','plays'].map(k=><TableCell key={k}>{fmt(x[k])}{k==='plays'&&<small>{x.playsEvidence?.note}</small>}</TableCell>)}</TableRow>)}</TableBody></Table></div>{!hRows.length&&<p className="empty">暂无符合身份与来源条件的保存记录。</p>}{pager(hRows.length,hPage,setHPage)}</>}</DialogContent></Dialog></div>;
}
