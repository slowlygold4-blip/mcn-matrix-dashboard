"use client";
import {useEffect,useState} from 'react';
import {coverageTotals,accountCoverage} from '@/lib/replica-coverage.mjs';
import {Button} from '@/components/ui/button';

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

// Recently unsuccessful attempts and accounts with no observation are more
// actionable than older partial observations. Do not mutate the catalog order.
function gapPriority(row:CoverageRow){
 if(row.worksUnavailableRecent)return 0;
 if(!row.works.observedAt)return 1;
 if(row.works.status==='unavailable')return 2;
 if(row.works.status==='limited'&&!row.worksFresh)return 3;
 if(row.works.status==='limited')return 4;
 if(!row.worksComplete)return 5;
 return 6;
}

export function CoveragePanel({accounts,topics,asOf,onAccount}:{accounts:Row[];topics:Record<string,unknown>;asOf:string;onAccount:(a:Row,trigger?:HTMLButtonElement|null)=>void}){
 const [now,setNow]=useState<number|null>(null);
 useEffect(()=>{const update=()=>setNow(Date.now()),first=setTimeout(update,0),interval=setInterval(update,60000);
  return()=>{clearTimeout(first);clearInterval(interval);};},[asOf]);
 const published=coverageTotals(accounts,topics,asOf,Date.parse(asOf));
 const current=now===null?null:coverageTotals(accounts,topics,asOf,now);
 const gaps=(current??published).rows.filter((row:CoverageRow)=>!row.profileFresh||!row.worksComplete)
  .sort((a:CoverageRow,b:CoverageRow)=>gapPriority(a)-gapPriority(b)
   ||(b.works.attemptedAt||'').localeCompare(a.works.attemptedAt||'')||a.id-b.id);
 const byId=new Map(accounts.map(account=>[Number(account.id),account]));
 return <details className="panel coverage-panel" aria-label="数据完整度与新鲜度">
  <summary><strong>数据完整度</strong><span>按最近 8 小时检查</span>
   <span>{current?coverageHeadline(current):'正在核对最近 8 小时的数据状态…'}</span>
   <span>展开查看证据与账号</span></summary>
  <div className="coverage-details">
   <p className="meta">发布截面 {time(asOf)} 的近 8 小时窗口：主页 {published.profileFresh}/{published.denominator} · 作品完整核验 {published.worksComplete}/{published.denominator} · 作品有限观察 {published.worksLimited}/{published.denominator} · 话题双指标 {published.topicsFresh}/{published.topicDenominator}。作品不完整不等于没有已保存作品；有限观察也不保证列表非空或平台全集。</p>
   <section className="coverage-gaps" aria-label="采样缺口账号"><h3>完整性待核 {gaps.length} 个账号 · 当前显示{gaps.length>20?'前':''} {Math.min(gaps.length,20)} 个</h3>
    <p className="meta">优先列出最近未取得或无列表观察的账号，再列出有限观察与过时观察。主页超时也计入；完整账号目录仍在账号页。</p>
    {gaps.slice(0,20).map((row:CoverageRow)=><p className="meta coverage-gap" key={row.id}>
     <Button type="button" variant="link" className="coverage-account" aria-label={`查看${row.label}的经营详情`} onClick={event=>{const account=byId.get(row.id);if(account)onAccount(account,event?.currentTarget??null);}}>{row.label}</Button>
     <span>主页最近有效采样 {time(row.profileObservedAt)} · 作品 {names[row.works.status]} · 最近尝试 {time(row.works.attemptedAt)} · 最后有效列表观察 {time(row.works.observedAt)}{row.works.status==='unavailable'&&row.works.observedAt?'（保留此前观察，不代表本次取得）':''}{!row.worksFresh&&row.works.observedAt?'（已超 8 小时）':''}</span>
    </p>)}
    {!gaps.length&&<p className="meta">当前窗口内未发现上述采样缺口；不代表其他日期没有缺测。</p>}
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
