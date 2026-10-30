"use client";
import {useEffect,useState} from 'react';
import {coverageTotals,accountCoverage} from '@/lib/replica-coverage.mjs';
import {Button} from '@/components/ui/button';
import {coverageGapView} from '@/lib/coverage-gap-view.mjs';

type Row=Record<string,unknown>;
type Totals={profileFresh:number;worksComplete:number;worksLimited:number;
 worksUnavailableRecent:number;topicsFresh:number;denominator:number;topicDenominator:number};
type CoverageRow={id:number;label:string;profileFresh:boolean;profileObservedAt:string|null;
 works:{status:string;attemptedAt:string|null;observedAt:string|null};worksFresh:boolean;
 worksComplete:boolean;worksUnavailableRecent:boolean};
const names:Record<string,string>={
 complete:'列表完整核验',
 limited:'列表有限观察',
 unavailable:'本轮列表未取得',
 missing:'无列表尝试记录',
 unknown:'该发布版本未提供作品覆盖证据',
};
const time=(s:string|null)=>s?new Date(s).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'无记录';
export const coverageHeadline=(totals:Totals)=>`主页新数据 ${totals.profileFresh}/${totals.denominator} · 作品完整核验 ${totals.worksComplete}/${totals.denominator} · 作品有限观察 ${totals.worksLimited}/${totals.denominator} · 最近未取得 ${totals.worksUnavailableRecent}/${totals.denominator} · 话题双指标 ${totals.topicsFresh}/${totals.topicDenominator}`;

export function CoveragePanel({accounts,topics,asOf,onAccount}:{accounts:Row[];topics:Record<string,unknown>;asOf:string;onAccount:(a:Row,trigger?:HTMLButtonElement|null)=>void}){
 const [now,setNow]=useState<number|null>(null);
 const [filter,setFilter]=useState('all'),[query,setQuery]=useState(''),[page,setPage]=useState(1);
 useEffect(()=>{const update=()=>setNow(Date.now()),first=setTimeout(update,0),interval=setInterval(update,60000);
  return()=>{clearTimeout(first);clearInterval(interval);};},[asOf]);
 const published=coverageTotals(accounts,topics,asOf,Date.parse(asOf));
 const current=now===null?null:coverageTotals(accounts,topics,asOf,now);
 const gaps=coverageGapView((current??published).rows,{filter,query,page});
 const byId=new Map(accounts.map(account=>[Number(account.id),account]));
 return <details className="panel coverage-panel" aria-label="数据完整度与新鲜度">
  <summary><strong>数据完整度</strong><span>按最近 8 小时检查</span>
   <span>{current?coverageHeadline(current):'正在核对最近 8 小时的数据状态…'}</span>
   <span>展开查看证据与账号</span></summary>
  <div className="coverage-details">
   <p className="meta">发布截面 {time(asOf)} 的近 8 小时窗口：主页 {published.profileFresh}/{published.denominator} · 作品完整核验 {published.worksComplete}/{published.denominator} · 作品有限观察 {published.worksLimited}/{published.denominator} · 话题双指标 {published.topicsFresh}/{published.topicDenominator}。作品不完整不等于没有已保存作品；有限观察也不保证列表非空或平台全集。</p>
   <section className="coverage-gaps" aria-label="采样缺口账号"><h3>完整性待核 {gaps.totalGaps} 个账号</h3>
    <p className="meta">可搜索、筛选并翻页查看全部待核账号。优先列出最近未取得或无列表观察的账号；指标与分母沿用当前选择范围。</p>
    <div className="coverage-gap-filters">
     <label>查找账号<input type="search" value={query} placeholder="账号名称或内部编号" onChange={event=>{setQuery(event.target.value);setPage(1);}}/></label>
     <label>待核问题<select value={filter} onChange={event=>{setFilter(event.target.value);setPage(1);}}>
      <option value="all">全部待核问题</option><option value="profile">主页过时或缺测</option>
      <option value="works">作品尚未完整</option><option value="unavailable">作品最近尝试未取得</option>
      <option value="unobserved">作品尚无有效观察</option><option value="limited">作品仅有限观察</option>
     </select></label>
     {(query||filter!=='all')&&<Button type="button" variant="outline" onClick={()=>{setQuery('');setFilter('all');setPage(1);}}>清除问题筛选</Button>}
    </div>
    <p className="meta" role="status">符合筛选 {gaps.filteredCount} 个 · 显示 {gaps.from}–{gaps.to} 个 · 每页 {gaps.pageSize} 个</p>
    {gaps.rows.map((row:CoverageRow)=><p className="meta coverage-gap" key={row.id}>
     <Button type="button" variant="link" className="coverage-account" aria-label={`查看${row.label}的经营详情`} onClick={event=>{const account=byId.get(row.id);if(account)onAccount(account,event?.currentTarget??null);}}>{row.label}</Button>
     <span>主页最近有效采样 {time(row.profileObservedAt)} · 作品 {names[row.works.status]} · 最近尝试 {time(row.works.attemptedAt)} · 最后有效列表观察 {time(row.works.observedAt)}{row.works.status==='unavailable'&&row.works.observedAt?'（保留此前观察，不代表本次取得）':''}{!row.worksFresh&&row.works.observedAt?'（已超 8 小时）':''}</span>
    </p>)}
    {!gaps.filteredCount&&<p className="meta">{gaps.totalGaps?'当前搜索和问题筛选没有匹配账号，可清除筛选查看全部待核账号。':'当前窗口内未发现上述采样缺口；不代表其他日期没有缺测。'}</p>}
    {gaps.filteredCount>0&&<nav className="coverage-gap-pager" aria-label="待核账号分页">
     <Button type="button" variant="outline" disabled={gaps.page===1} onClick={()=>setPage(1)}>首页</Button>
     <Button type="button" variant="outline" disabled={gaps.page===1} onClick={()=>setPage(gaps.page-1)}>上一页</Button>
     <label>第 <select aria-label="待核账号页码" value={gaps.page} onChange={event=>setPage(Number(event.target.value))}>{Array.from({length:gaps.pageCount},(_,i)=><option key={i+1} value={i+1}>{i+1}</option>)}</select> / {gaps.pageCount} 页</label>
     <Button type="button" variant="outline" disabled={gaps.page===gaps.pageCount} onClick={()=>setPage(gaps.page+1)}>下一页</Button>
     <Button type="button" variant="outline" disabled={gaps.page===gaps.pageCount} onClick={()=>setPage(gaps.pageCount)}>末页</Button>
    </nav>}
   </section>
   <details className="coverage-method"><summary>查看来源口径与作品观察说明</summary>
    <p className="meta">发布截面的最后作品状态：{Object.entries(published.statusCounts).map(([key,value])=>`${names[key]} ${value}`).join(' · ')}。近 8 小时计数与最后状态不同，过时观察不计入；“完整”仅表示该次分页和库存核验完成，不代表所有时刻或真实播放量。每日历史按观察日合并，不是全部同日原始采样。</p>
   </details>
  </div>
 </details>;
}

export function AccountCoverage({account,asOf}:{account:Row;asOf:string}){
 const coverage=accountCoverage(account,asOf,Date.parse(asOf));
 return <p className="notice">该发布截面：主页三指标采样 {time(coverage.profileObservedAt)} · 作品 {names[coverage.works.status]} · 最近作品列表尝试 {time(coverage.works.attemptedAt)} · 最后有效列表观察 {time(coverage.works.observedAt)}{coverage.works.status==='unavailable'&&coverage.works.observedAt?'（保留此前观察，不代表本次取得）':''}。发布版本固定，不表示此刻仍新鲜。</p>;
}
