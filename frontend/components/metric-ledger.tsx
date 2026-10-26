"use client";
import {ChangeIndicator,ChangeLegend} from "@/components/change-indicator";
type Metrics=Record<string,{value:number|null;delta:number|null;knownCount?:number;comparableCount?:number}>;
const fmt=(n:number|null|undefined)=>n==null?'—':n.toLocaleString('zh-CN');
const change=(n:number|null|undefined)=>n==null?'—':(n>0?'+':'')+fmt(n);
const coverage=(value:number|undefined,total:number)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=total?`${value}/${total} 个账号`:'账号数待核';
export function MetricLedger({metrics,count,start,end}:{metrics:Metrics;count:number;start:string;end:string}){
 return <section className="metric-ledger" aria-label="经营指标">
  <div className="metric-ledger__head"><h2>截至 {end}，这些账号共有多少</h2><p>{count} 个已选账号 · 只合计当天有数据的账号</p></div>
  <div className="metric-grid metric-grid--stock">{[['followers','粉丝总数'],['likes','主页获赞总数'],['posts','作品总数']].map(([key,label])=>{const m=metrics[key];return <article className="metric-cell" key={key}><p className="metric-cell__label">{label}</p><strong className="metric-cell__value">{fmt(m?.value)}</strong><p className="metric-cell__note">有数据 {coverage(m?.knownCount,count)}</p></article>;})}</div>
  <div className="metric-ledger__head metric-ledger__head--change"><h2>从 {start} 到 {end} 变化了多少</h2><p>只比较起止两天都有真实数据的账号</p></div>
  <div className="metric-grid metric-grid--change">{[['followers','粉丝变化'],['likes','主页获赞变化'],['estimated','估算播放变化（非实测）'],['posts','作品数变化']].map(([key,label])=>{const m=metrics[key==='estimated'?'likes':key],d=key==='estimated'?(m?.delta==null?null:m.delta*100):m?.delta;return <article className="metric-cell" data-metric-kind={key} key={key}><p className="metric-cell__label">{label}</p><strong className={'metric-cell__value '+(d!=null&&d<0?'negative':d!=null&&d>0?'positive':'')}>{change(d)}</strong><ChangeIndicator value={d}/><p className="metric-cell__note">两天都有数据 {coverage(m?.comparableCount,count)}</p>{key==='estimated'&&<p className="metric-cell__note">获赞变化 × 100 · 非实际播放</p>}</article>;})}</div>
  <ChangeLegend/>
  <p className="metric-ledger__footnote">估算播放 = 获赞净变化 × 100，非平台实际播放量。缺测不补零，作品净变化不等于新发布量。</p>
 </section>;
}
