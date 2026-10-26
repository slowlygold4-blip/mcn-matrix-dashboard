"use client";
import {useEffect,useId,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {TableScrollFrame} from '@/components/table-scroll-frame';
import {filterTuantuanRoster,rosterModeCounts,sourceRosterMetric,tuantuanRosterExport} from '@/lib/tuantuan-roster.mjs';
import {resolveRosterPage,sortTuantuanRoster} from '@/lib/tuantuan-roster-view.mjs';
import {rosterDefaults,rosterSelection,rosterSelectionPath} from '@/lib/tuantuan-roster-navigation.mjs';
import {ChangeIndicator} from '@/components/change-indicator';
import {csv} from '@/lib/replica-model.mjs';

type Row=Record<string,any>;
type RosterSelection={panel:'changes'|'authors';query:string;mode:'all'|'monitored'|'paused'|'source-only';sort:'plays'|'likes'|'posts'|'name';direction:'asc'|'desc';page:number};
const number=(value:number|null|undefined)=>value==null?'—':value.toLocaleString('zh-CN');
function LatestProfileCell({accounts,field,source}:{accounts:Row[];field:string;source?:Row|null}){
 const known=accounts.filter(account=>Number.isSafeInteger(account.latest?.[field]?.value)&&account.latest[field].value>=0);
 return <td>{known.length?known.map(account=><div key={account.id}>{known.length>1&&<small>{account.label}</small>}<strong>{number(account.latest[field].value)}</strong><small>{account.latest[field].date} 采样</small></div>):field==='followers'&&Number.isSafeInteger(source?.followers)&&source!.followers>=0?<><strong>{number(source!.followers)}</strong><small>已记录值 · 观察日期未记录</small></>:'—'}</td>;
}

function AuthorChangeCell({accounts,field,byId,ready}:{accounts:Row[];field:string;byId:Map<number,Row>;ready:boolean}){
 if(!accounts.length)return <td><small>尚无主页采样</small><small>已有数据见本行</small></td>;
 if(!ready)return <td>区间数据核对中</td>;
 return <td>{accounts.map(account=>{const metric=byId.get(account.id)?.metrics?.[field];const delta=metric?.delta;const valid=typeof delta==='number'&&Number.isFinite(delta);return <div key={account.id}>{accounts.length>1&&<small>{account.label}</small>}<strong>{valid?`${delta>0?'+':''}${number(delta)}`:'—'}</strong><ChangeIndicator value={delta}/>{valid?<small>{number(metric.baseline)} → {number(metric.value)}</small>:<small>缺少所选区间的起止采样</small>}</div>;})}</td>;
}

function RosterPageJump({position,page,pages,scope,onPageChange}:{position:string;page:number;pages:number;scope:string;onPageChange:(page:number)=>void}){
 const [draft,setDraft]=useState(String(page)),[error,setError]=useState('');
 const errorId=useId();
 useEffect(()=>{setDraft(String(page));setError('');},[page,pages,scope]);
 function submit(event:React.FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(!/^[1-9]\d{0,5}$/.test(draft)||Number(draft)>pages){setError(`请输入 1–${pages} 的页码。`);return;}
  setError('');onPageChange(Number(draft));
 }
 return <form className="flex flex-wrap items-center gap-2" onSubmit={submit} noValidate><label className="flex items-center gap-2">跳至 <Input type="text" inputMode="numeric" autoComplete="off" maxLength={6} className="w-20 shrink-0 text-center" aria-label={`${position}页码`} aria-invalid={!!error} aria-describedby={error?errorId:undefined} value={draft} disabled={pages<=1} onChange={event=>{setDraft(event.target.value);setError('');}}/> / {pages} 页</label><Button variant="outline" type="submit" disabled={pages<=1}>跳转到该页</Button>{error&&<small id={errorId} role="alert">{error}</small>}</form>;
}

export function TuantuanRosterSummary({roster,source,foundation,selectTheme,openAccounts}:{roster:Row|null;source:Row|null;foundation:Row|null;selectTheme:()=>void;openAccounts:()=>void}){
 if(!source)return null;
 const counts=roster?.counts;
 return <section className="panel tuantuan-roster-summary" aria-label="团团统一名册"><div className="panel-head"><div><p className="eyebrow">TUANTUAN · UNIFIED ROSTER</p><h2>团团全部作者</h2></div><Button onClick={roster?openAccounts:selectTheme}>查看团团名册</Button></div>
 <div className="source-stat-grid"><div><small>去重后团团作者</small><strong>{number(counts?.all)}</strong></div><div><small>已启用主页监控</small><strong>{number(counts?.monitoredEnabled)}</strong></div><div><small>表格来源作者</small><strong>{number(counts?.source)}</strong></div><div><small>去重作品 ID</small><strong>{number(source.stats.works+(foundation?.works?.length||0))}</strong></div></div>
 <p className="meta">{counts?`${number(counts.baseSource)} 位总表作者 + ${number(counts.supplementSource)} 位其他登记表新增身份 + ${number(counts.pendingSource)} 位保留的旧来源身份，${number(counts.reconciledAliases)} 组经同一监控目标与同名证据合并；${number(counts.linkedSource)} 位来源作者已关联 ${number(counts.linkedTargets)} 个主页目标。`:'正在按抖音号与已保存目标 ID 核对重复作者。'}“已启用主页监控”才有可比的日变化；其他来源记录只补身份与作品证据。</p>{foundation&&<><p className="meta">数据基石：总表 {foundation.index.stats.sheets} 张工作表 + 其他最新入库来源 {foundation.index.stats.sourceDocuments} 份；不能核定身份的 {foundation.index.stats.unkeyedRows} 行仍保留原始数据，不凭昵称硬并。</p><details className="source-coverage"><summary>查看表格来源覆盖与受限原始表</summary><p className="meta">受限表只用于本机审查；公开页仅展示去敏的身份、作品 ID 和来源观测。</p><div className="source-coverage-list">{foundation.index.sheetCoverage.map((sheet:Row)=><span key={sheet.id}>{sheet.id} · {sheet.name} · {number(sheet.rows)} 行{sheet.restricted?' · 本机保留':''}</span>)}</div></details></>}</section>;
}

export function TuantuanRosterTable({roster,classification,onOpenAccount,onOpenSourceWorks,addressMode=false,active=true,metricRows=[],changesReady=false,periodLabel=""}:{roster:Row|null;classification:string;onOpenAccount:(account:Row,trigger:HTMLButtonElement)=>void;onOpenSourceWorks:(source:Row,trigger:HTMLButtonElement)=>void;addressMode?:boolean;active?:boolean;metricRows?:Row[];changesReady?:boolean;periodLabel?:string}){
 const metricById=useMemo(()=>new Map(metricRows.map(row=>[row.id,row])),[metricRows]);
 const [selection,setSelection]=useState<RosterSelection>({...rosterDefaults} as RosterSelection);
 const [addressError,setAddressError]=useState(''),[addressReady,setAddressReady]=useState(!addressMode);
 const {query,mode,sort,direction}=selection;
 const selectionRef=useRef(selection);selectionRef.current=selection;
 const [pagination,setPagination]=useState({scope:'',page:1});
 function changeSelection(patch:Partial<RosterSelection>,resetPage=true){
  if(addressMode&&!active)return;
  let next={...selectionRef.current,...(resetPage?{page:1}:{}),...patch};
  if(addressMode){try{
   // Home owns this panel switch; never overwrite it with an older component copy.
   const panel=patch.panel??new URLSearchParams(window.location.search).get('rosterPanel')??rosterDefaults.panel;
   next={...next,panel:panel as RosterSelection['panel']};
   const path=rosterSelectionPath(window.location.pathname+window.location.search+window.location.hash,next);
   window.history.replaceState(window.history.state,'',path);
  }catch(error){setAddressError((error as Error).message);return;}}
  selectionRef.current=next;setSelection(next);setAddressError('');
 }
 useEffect(()=>{if(!addressMode||!active)return;const restore=()=>{try{const next=rosterSelection(window.location.search) as RosterSelection;selectionRef.current=next;setSelection(next);setAddressError('');}catch(error){setAddressError((error as Error).message);}setAddressReady(true);};restore();window.addEventListener('popstate',restore);window.addEventListener('hashchange',restore);return()=>{window.removeEventListener('popstate',restore);window.removeEventListener('hashchange',restore);};},[addressMode,active,classification]);
 const filtered=useMemo(()=>{
  if(!roster)return [];
  return sortTuantuanRoster(filterTuantuanRoster(roster.rows,{query,mode,classification}),sort,direction);
 },[roster,query,mode,sort,direction,classification]);
 const counts=useMemo(()=>rosterModeCounts(roster?.rows??[],classification) as Record<string,number>,[roster,classification]);
 const scope=useMemo(()=>JSON.stringify([query,mode,classification,sort,direction,filtered.map((row:Row)=>row.key)]),[query,mode,classification,sort,direction,filtered]);
 const pageState=addressMode?{pages:Math.max(1,Math.ceil(filtered.length/30)),page:selection.page,start:filtered.length?(selection.page-1)*30+1:0,end:Math.min(filtered.length,selection.page*30)}:resolveRosterPage(pagination,scope,filtered.length);
 // Missing while loading is not an empty roster: keep the saved page until real data returns.
 if(!addressMode&&roster&&(pagination.scope!==scope||pagination.page!==pageState.page))setPagination({scope,page:pageState.page});
 const {pages,page:current,start,end}=pageState;
 const selectionError=addressError||(roster&&addressReady&&current>pages?`当前名册筛选只有 ${pages} 页，链接请求第 ${current} 页。`:'');
 const visible=selectionError?[]:filtered.slice(start?start-1:0,end);
 function setPage(page:number){if(addressMode)changeSelection({page},false);else setPagination({scope,page});}
 function changeSort(next:string){
  changeSelection({direction:next===sort?(direction==='desc'?'asc':'desc'):next==='name'?'asc':'desc',sort:next as RosterSelection['sort']});
 }
 function sortableHeader(field:string,label:string){
  return <th aria-sort={sort===field?(direction==='asc'?'ascending':'descending'):'none'}><Button variant="ghost" onClick={()=>changeSort(field)} title={`按${label}排序，再点一次切换顺序`}>{label}{sort===field?(direction==='asc'?' ↑':' ↓'):' ↕'}</Button></th>;
 }
 function pager(position:string){
  return <nav className="source-pager" aria-label={`团团名册${position}分页`}><span role="status">显示 {number(start)}–{number(end)} / {number(filtered.length)} 位 · 第 {current}/{pages} 页</span><Button variant="outline" disabled={current<=1} onClick={()=>setPage(current-1)}>上一页</Button><RosterPageJump position={position} page={current} pages={pages} scope={scope} onPageChange={setPage}/><Button variant="outline" disabled={current>=pages} onClick={()=>setPage(current+1)}>下一页</Button></nav>;
 }
 function exportFiltered(){
  if(!roster||!addressReady||selectionError)return;
  const bytes=csv(tuantuanRosterExport(filtered));
  const url=URL.createObjectURL(new Blob([bytes],{type:'text/csv;charset=utf-8'}));
  const anchor=document.createElement('a');anchor.href=url;anchor.download='团团作者名册-当前筛选.csv';anchor.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 const reset=()=>changeSelection({...rosterDefaults,panel:addressMode?(new URLSearchParams(window.location.search).get('rosterPanel')==='changes'?'changes':'authors'):selection.panel} as RosterSelection);
 const problem=selectionError&&<div className="error" role="alert">{selectionError}<Button variant="outline" onClick={reset}>重置名册筛选</Button>{!addressError&&current>pages&&<Button variant="outline" onClick={()=>setPage(1)}>回到第一页</Button>}</div>;
 if(!roster||!addressReady)return <section className="panel tuantuan-roster-table" aria-label="团团统一作者名册">{problem}<p role="status">正在核对团团全部作者名册…</p></section>;
 return <section className="panel tuantuan-roster-table" aria-label="团团统一作者名册"><div className="panel-head"><div><p className="eyebrow">一位作者只显示一行</p><h2>全部作者明细 <span>{number(roster.counts.all)}</span></h2></div><div className="source-actions"><span className="meta">当前搜索与范围匹配 {number(filtered.length)} 位</span><Button variant="outline" onClick={exportFiltered} disabled={!filtered.length||!!selectionError}>导出当前筛选</Button></div></div>
 <p className="meta">全部作者统一展示。可搜索、排序、翻页查看每个人的已记录数据；点击作品或详情继续查看明细。</p><details className="roster-method"><summary>人数和作品数量怎么统计？</summary><p className="meta">总表身份 {number(roster.counts.baseSource)} + 其他表新增身份 {number(roster.counts.supplementSource)} + 旧来源独立身份 {number(roster.counts.pendingSource)} − 同目标同名别名 {number(roster.counts.reconciledAliases)} + 监控名册 {number(roster.counts.monitored)} − 已关联监控目标 {number(roster.counts.linkedTargets)} = 去重后 {number(roster.fullCount??roster.counts.all)} 位（全量名册）。表格累计播放和点赞不是每日增长。</p>
 <p className="meta">范围人数按当前内容分类统计，不随搜索词变化；启用、暂停、未关联三个范围互不重复。</p>
 <p className="meta">原表登记作品保留来源表填写的数量；后来补充的作品数量见作者作品页的“已归档作品”，两者统计范围不同。</p>
 {classification!=='all'&&<p className="meta">当前内容分类仅使用表格明确的作品类别列或监控名册已有标签；不能从昵称猜类别。</p>}</details>
 <div className="source-controls"><div role="group" aria-label="团团作者范围">{[['all','全部作者'],['monitored','启用监控'],['paused','暂停监控'],['source-only','未关联监控']].map(([key,label])=><Button key={key} variant={mode===key?'secondary':'outline'} aria-pressed={mode===key} onClick={()=>changeSelection({mode:key as RosterSelection['mode']})}>{label} {number(counts[key])}</Button>)}</div><Input aria-label="搜索团团全部作者" maxLength={200} placeholder="搜索作者或抖音号" value={query} onChange={event=>changeSelection({query:event.target.value})}/>{query&&<Button variant="outline" onClick={()=>changeSelection({query:''})}>清空搜索</Button>}<label>排序 <select aria-label="团团名册排序指标" value={sort} onChange={event=>changeSort(event.target.value)}><option value="plays">作品累计播放</option><option value="likes">作品累计点赞</option><option value="posts">已登记作品</option><option value="name">作者名称</option></select></label><label>顺序 <select aria-label="团团名册排序顺序" value={direction} onChange={event=>changeSelection({direction:event.target.value as RosterSelection['direction']})}><option value="desc">{sort==='name'?'名称倒序':'从多到少'}</option><option value="asc">{sort==='name'?'名称正序':'从少到多'}</option></select></label></div>
 <p className="meta">点击列名也可切换排名顺序；没有记录的数据始终排在最后。导出包含当前筛选的所有作者。</p>
 {problem}
 {!selectionError&&pager('上方')}
 <TableScrollFrame scrollLabel="团团作者名册数据表" scrollSelector=".source-table-wrap"><div className="source-table-wrap"><table className="source-table"><thead><tr>{sortableHeader('name','作者 / 抖音号')}<th>监控状态</th>{sortableHeader('posts','已登记作品')}{sortableHeader('plays','作品累计播放')}{sortableHeader('likes','作品累计点赞')}<th>粉丝数</th><th>主页获赞</th>{periodLabel&&["粉丝变化","主页获赞变化","作品存量变化"].map(label=><th key={label}>{label}<small>{periodLabel}</small></th>)}<th>来源 / 更新详情</th></tr></thead><tbody>{visible.map((row:Row)=>{const source=row.source,accounts=row.accounts;return <tr key={row.key}><td><strong>{source?.name||accounts[0]?.label||'未命名'}</strong><small>{source?.douyinIds?.join(' / ')||source?.douyinId||(source?.identifierStatus==='unusable'?`原表账号号待核验：${source.submittedAccountId}`:source?'账号 ID 待补全':'主页账号已登记')}</small>{source?.douyinIds&&<small>同一监控目标已核对两个表格账号 ID</small>}{source?.douyinId&&!source?.sourceOnly&&<Button variant="link" onClick={event=>onOpenSourceWorks(source,event.currentTarget)}>查看作品 →</Button>}</td><td>{accounts.some((account:Row)=>account.enabled)?'已启用采集计划':accounts.length?'采集计划已暂停':'未关联监控账号'}</td><td>{number(sourceRosterMetric(source,'posts'))}</td><td>{number(sourceRosterMetric(source,'plays'))}</td><td>{number(sourceRosterMetric(source,'likes'))}</td><LatestProfileCell accounts={accounts} field="followers" source={source}/><LatestProfileCell accounts={accounts} field="likes"/>{periodLabel&&["followers","likes","posts"].map(field=><AuthorChangeCell key={field} accounts={accounts} field={field} byId={metricById} ready={changesReady}/>)}<td><details><summary>来源和更新情况</summary><p>{source?`来源：${source.sourceTitles?.join(" / ")||"已保存登记表"}`:"仅主页监控记录"}</p>{source?.row&&<p>原表行号：{source.row}</p>}<p>{accounts.length?accounts.some((a:Row)=>a.enabled)?"已启用采样；实际日期见本行":"采样计划已暂停，保留历史数据":"已有表格资料，尚未关联可采样的主页身份"}</p></details>{accounts.length?accounts.map((account:Row)=><Button key={account.id} variant="link" aria-label={`${account.label} · 查看账号变化`} onClick={event=>onOpenAccount(account,event.currentTarget)}>查看账号变化</Button>):'暂无主页采样；已有数据见本行'}</td></tr>;})}</tbody></table></div></TableScrollFrame>
 {!!visible.length&&pager('下方')}
 {!visible.length&&!selectionError&&<p className="empty">当前筛选没有可核验作者，请调整条件。</p>}
 <p className="meta">全部已登记作者都保留在此。缺少某项指标不影响其他已有数据的展示，未取得的变化不补零。</p></section>;
}
