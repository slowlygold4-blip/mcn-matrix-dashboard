"use client";
import {useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {collectionIssueNames,collectionIssueView} from '@/lib/collection-issue-view.mjs';
type Row=Record<string,any>;
const clock=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});

export function CollectionIssueList({snapshot,initialFilter,changed,online,accounts=[],onReload,onClose,onOpenAccount}:{
 snapshot:Row;initialFilter:'missing'|'works';changed:boolean;online:boolean;accounts?:Row[];
 onReload:()=>void;onClose:()=>void;onOpenAccount?:(account:Row,trigger:HTMLButtonElement)=>void;
}){
 const [filter,setFilter]=useState<string>(initialFilter),[query,setQuery]=useState(''),[page,setPage]=useState(1);
 const heading=useRef<HTMLHeadingElement>(null);
 useEffect(()=>{heading.current?.focus({preventScroll:true});},[]);
 const view=collectionIssueView(snapshot,{filter,query,page});
 const selectedReason=filter.startsWith('reason:')?filter.slice(7):null;
 const reasonCodes=snapshot.state==='ready'?[...snapshot.codes,...(selectedReason&&!snapshot.codes.includes(selectedReason)?[selectedReason]:[])]:[];
 const byId=new Map(accounts.map(account=>[account.id,account]));
 return <section id="collection-issue-list" className="coverage-gaps" role="region" aria-label="近24小时采集问题名单"
  onKeyDown={event=>{if(event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();event.stopPropagation();onClose();}}}>
  <div className="panel-head" style={{display:'flex',flexWrap:'wrap',gap:8}}><h3 ref={heading} tabIndex={-1}>近24小时采集问题名单</h3><Button variant="outline" disabled={!online} onClick={onReload}>载入最新问题名单</Button><Button variant="outline" onClick={onClose}>关闭问题名单</Button></div>
  {snapshot.state!=='ready'?<p role="status">{snapshot.message}</p>:<>
   <p className="meta">全局已关联且启用目标 · 北京时间 {clock(snapshot.since)} 至 {clock(snapshot.asOf)}。固定打开时的上报范围，不受当前矩阵筛选影响。</p>
   <p className="meta">尚未更新目标 {snapshot.missingTotal} 个（账号 {snapshot.missingProfiles} · 话题 {snapshot.missingTopics}） · 作品采样问题 {snapshot.workIssues} 个账号。同一账号可同时有两类问题。</p>
   <p className="meta">账号详情读取已公开的数据，可能尚未同步到这次采集上报；尚未公开的目标仍保留在名单中。</p>
  </>}
  {(!online||changed)&&<div className="notice" role="status">{!online?'采集端当前未连接，保留这份已上报名单。':'已有新的问题名单上报，当前名单未自动替换。'}</div>}
  {snapshot.state==='ready'&&<>
   <div className="coverage-gap-filters"><label>查找问题目标<input type="search" maxLength={200} value={query} placeholder="名称或目标编号" onChange={event=>{setQuery(event.target.value);setPage(1);}}/></label>
    <label>问题类型<select value={filter} onChange={event=>{setFilter(event.target.value);setPage(1);}}>
     <option value="missing">尚未更新目标</option><option value="works">作品采样问题</option><option value="all">全部问题目标</option>
     {reasonCodes.map((code:string)=><option key={code} value={'reason:'+code}>{collectionIssueNames[code as keyof typeof collectionIssueNames]}{!snapshot.codes.includes(code)?'（本次 0 个）':''}</option>)}
    </select></label>
    {query&&<Button variant="outline" onClick={()=>{setQuery('');setPage(1);}}>清除目标搜索</Button>}
   </div>
   <p className="meta" role="status">符合筛选 {view.filteredCount} 个 · 显示 {view.from}–{view.to} 个</p>
   <ul aria-label="问题目标" style={{paddingInlineStart:20,overflowWrap:'anywhere'}}>{view.rows.map((row:Row)=>{
    const account=row.kind==='account'?byId.get(row.id):null;
    const linked=account&&row.catalogued&&(account.platform??'unknown')===row.platform&&onOpenAccount;
    return <li key={row.id} className="coverage-gap" style={{marginBlock:12}}><div style={{display:'flex',flexWrap:'wrap',gap:8,alignItems:'center'}}>
     <strong>{row.kind==='topic'?'话题':'账号'} · {row.label}</strong><small>目标 #{row.id}</small>
     {linked?<Button variant="link" aria-label={`查看${row.label}的账号详情`} onClick={event=>onOpenAccount?.(account,event.currentTarget)}>查看账号详情</Button>:row.kind==='account'?<small>尚未发布账号详情</small>:<small>话题独立统计</small>}
    </div><p className="meta">{[row.profileMissing?'近24小时主页尚未更新':null,row.topicMissing?'近24小时话题双指标尚未更新':null,row.workCode?collectionIssueNames[row.workCode as keyof typeof collectionIssueNames]:null].filter(Boolean).join(' · ')}</p></li>;
   })}</ul>
   {!view.filteredCount&&<p className="empty">当前问题类型或搜索没有匹配目标；这不表示其他类型没有采样缺口。</p>}
   {view.filteredCount>0&&<nav className="coverage-gap-pager" aria-label="采集问题名单分页"><Button variant="outline" disabled={view.page===1} onClick={()=>setPage(1)}>首页</Button><Button variant="outline" disabled={view.page===1} onClick={()=>setPage(view.page-1)}>上一页</Button>
    <label>第 <select aria-label="采集问题名单页码" value={view.page} onChange={event=>setPage(Number(event.target.value))}>{Array.from({length:view.pageCount},(_,i)=><option value={i+1} key={i+1}>{i+1}</option>)}</select> / {view.pageCount} 页</label>
    <Button variant="outline" disabled={view.page===view.pageCount} onClick={()=>setPage(view.page+1)}>下一页</Button><Button variant="outline" disabled={view.page===view.pageCount} onClick={()=>setPage(view.pageCount)}>末页</Button>
   </nav>}
  </>}
 </section>;
}
