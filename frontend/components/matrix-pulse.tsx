"use client";
import {useMemo,useState} from 'react';
import {matrixPulse} from '@/lib/matrix-pulse.mjs';
import {ArrowUpRight,ArrowDownRight,Minus,Users,Heart,Layers} from 'lucide-react';
type Row=Record<string,any>;
const fields=[['followers','粉丝',Users],['likes','获赞',Heart],['posts','作品存量',Layers]] as const;
const n=(v:number|null|undefined,sign=false)=>v==null?'—':`${sign&&v>0?'+':''}${v.toLocaleString('zh-CN')}`;
export function MatrixPulse({roster,rows,ready,start,end,onOpen,selectedMetric,onMetricChange}:{roster:Row|null;rows:Row[];ready:boolean;start:string;end:string;onOpen:(a:Row,trigger:HTMLButtonElement)=>void;selectedMetric?:"followers"|"likes"|"posts";onMetricChange?:(k:"followers"|"likes"|"posts")=>void}){
 const [localMetric,setLocalMetric]=useState<'followers'|'likes'|'posts'>('followers');
 const metric=selectedMetric??localMetric;const setMetric=onMetricChange??setLocalMetric;
 const summaries=useMemo(()=>Object.fromEntries(fields.map(([key])=>[key,matrixPulse(roster,rows,key)])),[roster,rows]);
 const p=summaries[metric];const label=fields.find(([key])=>key===metric)![1];
 return <section id="matrix-growth" tabIndex={-1} className="matrix-pulse" aria-label="矩阵增长与贡献分析">
  <header className="matrix-pulse__header"><div><p className="eyebrow">变化一眼看清</p><h2>这段时间，矩阵发生了什么</h2><p>{start} — {end} · 当前筛选全部 {n(roster?.counts.all)} 位作者</p></div><span className="matrix-pulse__coverage">{ready?`${n(p.known)} / ${n(p.total)} 个已启用账号可计算${label}变化`:'正在核对区间快照'}</span></header>
  <div className="matrix-pulse__metrics" role="group" aria-label="选择增长分析指标">{fields.map(([key,title,Icon])=>{const x=summaries[key],value=ready?x.net:null;return <button key={key} data-active={metric===key} className="matrix-pulse__metric" onClick={()=>setMetric(key)} aria-pressed={metric===key}><span><Icon size={17}/>{title}净变化</span><strong className={value==null?'':value<0?'negative':value>0?'positive':''}>{n(value,true)}</strong><small>{ready?`${n(x.growing)} 个增长 · ${n(x.falling)} 个下降 · ${n(x.missing)} 个缺少对比`:'等待真实数据，不显示模拟数字'}</small></button>;})}</div>
  {!ready?<p className="meta" role="status">正在核对起止日期，完成后展示真实增减。</p>:<><div className="matrix-pulse__breakdown"><div><ArrowUpRight aria-hidden="true"/><span>增加合计</span><b className="positive">{n(p.positive,true)}</b></div><div><ArrowDownRight aria-hidden="true"/><span>减少合计</span><b className="negative">{n(p.negative,true)}</b></div><div><Minus aria-hidden="true"/><span>净变化</span><b>{n(p.net,true)}</b></div><div><span>前 5 名占增加量</span><b>{p.topFiveShare==null?'—':(p.topFiveShare*100).toFixed(1)+'%'}</b></div></div>
   <div className="matrix-pulse__distribution" aria-label={`${p.growing} 个增长，${p.falling} 个下降，${p.flat} 个持平，${p.missing} 个缺测`}>{[['gain',p.growing],['loss',p.falling],['flat',p.flat],['missing',p.missing]].map(([k,v])=><span key={k} className={String(k)} style={{flexGrow:Number(v)}}/>)}</div><p className="matrix-pulse__legend"><span>↑ 增长 {n(p.growing)}</span><span>↓ 下降 {n(p.falling)}</span><span>＝ 持平 {n(p.flat)}</span><span>— 缺少对比 {n(p.missing)}</span></p>
   <div className="matrix-pulse__rankings">{[['gains','增长贡献',p.gains],['losses','下降关注',p.losses]].map(([key,title,list])=><section key={String(key)}><h3>{String(title)} <small>TOP 5 · 点击查看账号</small></h3>{!(list as Row[]).length?<p className="empty">{p.known?`当前可比账号没有${key==='gains'?'增长':'下降'}。`:'暂无可比快照。'}</p>:<ol>{(list as Row[]).map((r:Row,i:number)=>{const value=r.metrics[metric].delta,denominator=key==='gains'?p.positive:Math.abs(p.negative??0),share=denominator?Math.abs(value)/denominator*100:0;return <li key={r.id}><button onClick={e=>onOpen(r,e.currentTarget)}><span className="matrix-rank-number">{i+1}</span><span className="matrix-rank-name">{r.label}<span className="matrix-rank-track"><i style={{width:share+'%'}} data-negative={value<0}/></span></span><span className={value<0?'negative':'positive'}>{n(value,true)}<small>占{value<0?'减少':'增加'} {share.toFixed(1)}%</small></span></button></li>;})}</ol>}</section>)}</div>
   <p className="matrix-pulse__note">{label}净变化 = 增加合计 + 减少合计。只合计同一账号起止均有记录的变化；未取得快照的作者仍保留在全部名册，缺测不计为零。作品存量变化包含删除影响，不等同于新发布量。</p>
  </>}
 </section>;
}
