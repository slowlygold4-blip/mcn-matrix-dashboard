"use client";
import {useState,cloneElement,isValidElement,type ReactNode,type ReactElement} from 'react';
import {MatrixPulse} from '@/components/matrix-pulse';
import {TuantuanRosterTable} from '@/components/tuantuan-roster';
type Row=Record<string,any>;
export function AllAuthorOverview({roster,metricRows,start,end,ready,error,scopeLabel,children,onOpenAccount,onOpenSourceWorks}:{roster:Row|null;metricRows:Row[];start:string;end:string;ready:boolean;error?:string;scopeLabel:string;children:ReactNode;onOpenAccount:(account:Row,trigger:HTMLButtonElement)=>void;onOpenSourceWorks:(source:Row,trigger:HTMLButtonElement)=>void}){
 const [metric,setMetric]=useState<'followers'|'likes'|'posts'>('followers');
 const n=(v:number|undefined)=>v==null?'核对中':v.toLocaleString('zh-CN');
 return <section className="all-author-overview" aria-label="全部作者的数据与变化">
  <header className="panel all-author-overview__head">
   <div className="roster-identity"><div><p className="eyebrow">当前矩阵</p><h2>全部作者的数据与变化</h2><p className="meta">{scopeLabel}</p></div><div className="roster-total"><strong>{n(roster?.counts.all)}</strong><span>位作者 · 全部保留</span></div></div>
   <div className="all-author-overview__coverage"><span>粉丝变化可计算 <b>{ready?n(roster?.availability.followers):'核对中'}</b></span><span>获赞变化可计算 <b>{ready?n(roster?.availability.likes):'核对中'}</b></span><span>作品变化可计算 <b>{ready?n(roster?.availability.posts):'核对中'}</b></span><span>待关联主页采样 <b>{n(roster?.availability.sourceOnly)}</b></span></div>
   <details className="roster-reading-note"><summary>{start} → {end} · 查看统计说明</summary><p>明细包含全部登记作者，采样缺失不会把作者排除。每位作者的作品、粉丝、获赞和区间变化集中在同一行；点击详情查看更新记录。可计算人数只包含起止都有可比记录的作者。</p></details>
  </header>
  {!error&&<MatrixPulse roster={roster} rows={metricRows} ready={ready} start={start} end={end} onOpen={onOpenAccount} selectedMetric={metric} onMetricChange={setMetric}/>}
  {isValidElement(children)?cloneElement(children as ReactElement<any>,{compact:true,selectedMetric:metric,onMetricChange:setMetric}):children}
  <details id="matrix-authors" className="panel all-author-overview__sampling"><summary>全部作者明细 · {n(roster?.counts.all)} 位 · 展开查找和排序</summary>
  {error?<p className="error" role="alert">完整作者数据暂不可读：{error}。不会退回仅采样账号冒充全部作者。</p>:<TuantuanRosterTable roster={roster} classification="all" metricRows={metricRows} changesReady={ready} periodLabel={`${start} → ${end}`} onOpenAccount={onOpenAccount} onOpenSourceWorks={onOpenSourceWorks}/>}
  </details>
 </section>;
}
