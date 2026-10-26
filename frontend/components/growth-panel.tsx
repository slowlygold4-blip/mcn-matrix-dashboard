"use client";
import {useId,useMemo,useState} from 'react';
import dynamic from 'next/dynamic';
import {GrowthChartLoading} from '@/components/growth-chart-loading';
import {Button} from '@/components/ui/button';import {Input} from '@/components/ui/input';
import {ToggleGroup,ToggleGroupItem} from '@/components/ui/toggle-group';
import {TableBody,TableCell,TableHead,TableHeader,TableRow} from '@/components/ui/table';
import {ScrollableTable as Table} from '@/components/scrollable-table';
import {growthSeries} from '@/lib/replica-trends.mjs';import {csv} from '@/lib/replica-model.mjs';
import {trendExport} from '@/lib/replica-export.mjs';
import {trendEndpoint,trendPoint,trendSelectionScope} from '@/lib/replica-trend-presentation.mjs';
const GrowthChart=dynamic(()=>import('@/components/growth-chart'),{ssr:false,loading:GrowthChartLoading});
type Row=Record<string,any>;
const names:Record<string,string>={followers:'粉丝',likes:'点赞',posts:'作品存量',estimated:'估算播放'};
const units:Record<string,string>={followers:'人',likes:'次',posts:'条',estimated:'次（估算）'};
const number=(n:number|null)=>n===null?'缺测':(n>0?'+':'')+n.toLocaleString('zh-CN');
export function GrowthPanel({accounts,points,manifest,start,end,comparison:controlledComparison,onComparison:controlledChange,offset:controlledOffset,onOffset:controlledOffsetChange,ready=true,pendingError='',suspended=false,scopeKey=''}:{accounts:Row[];points:Row[];manifest:Row;start:string;end:string;comparison?:Row;onComparison?:(x:Row)=>void;offset?:number;onOffset?:(x:number)=>void;ready?:boolean;pendingError?:string;suspended?:boolean;scopeKey?:string}){
 const [localComparison,setLocalComparison]=useState<Row>({compare:false,otherStart:'',otherEnd:''}),[localOffset,setLocalOffset]=useState(0);
 const comparison=controlledComparison??localComparison,onComparison=controlledChange??setLocalComparison,offset=controlledOffset??localOffset,onOffset=controlledOffsetChange??setLocalOffset;
 const [metric,setMetric]=useState('followers'),[exportError,setExportError]=useState('');const {compare,otherStart,otherEnd}=comparison;
 const [editingComparison,setEditingComparison]=useState(false),[comparisonDraft,setComparisonDraft]=useState({otherStart:'',otherEnd:''});
 const draftStart=editingComparison?comparisonDraft.otherStart:otherStart,draftEnd=editingComparison?comparisonDraft.otherEnd:otherEnd;
 const comparisonDraftValid=!!draftStart&&!!draftEnd&&Date.parse(draftStart)<=Date.parse(draftEnd);
 function editComparison(field:'otherStart'|'otherEnd',value:string){
  setComparisonDraft(previous=>({...(editingComparison?previous:{otherStart:otherStart||'',otherEnd:otherEnd||''}),[field]:value}));
  setEditingComparison(true);
 }
 function toggleComparison(){
  if(compare){onComparison({compare:false,otherStart:'',otherEnd:''});setEditingComparison(false);onOffset(0);return;}
  if(editingComparison){setEditingComparison(false);return;}
  setComparisonDraft({otherStart:'',otherEnd:''});setEditingComparison(true);
 }
 const readingId=useId(),selectionScope=trendSelectionScope({accountIds:accounts.map(a=>a.id),scope:scopeKey,start,end,metric,compare,otherStart,otherEnd,offset});
 const [selection,setSelection]=useState<{scope:string;day:number|null}>({scope:selectionScope,day:null});
 if(selection.scope!==selectionScope)setSelection({scope:selectionScope,day:null});
 const totalDays=Math.max((Date.parse(end)-Date.parse(start))/86400000+1,compare&&otherStart&&otherEnd?(Date.parse(otherEnd)-Date.parse(otherStart))/86400000+1:0);
 const result=useMemo(()=>{if(!ready)return {data:null,error:pendingError||'正在核对日期；完成前不显示旧范围曲线，也不允许导出。'};try{return {data:growthSeries(accounts,points,{start,end,metric,otherStart:compare?otherStart:null,otherEnd:compare?otherEnd:null,visibleOffset:offset,visibleDays:90}),error:null};}catch(e){return {data:null,error:(e as Error).message};}},[accounts,points,start,end,metric,compare,otherStart,otherEnd,offset,ready,pendingError]);
 const series=result.data,invalidComparison=compare&&(!otherStart||!otherEnd),hasValues=!!series?.points.some((p:Row)=>p.current!==null||p.comparison!==null);
 const currentEnd=trendEndpoint(series?.points),comparisonEnd=trendEndpoint(series?.points,'comparison');
 const selected=trendPoint(series?.points,selection.scope===selectionScope?selection.day:null);
 const readingSides:Array<'current'|'comparison'>=compare?['current','comparison']:['current'];
 function selectDay(day:number){if(series?.points.some((p:Row)=>p.day===day))setSelection(current=>current.scope===selectionScope&&current.day===day?current:{scope:selectionScope,day});}
 function exportTrend(){if(!series||invalidComparison)return;try{const rows=trendExport({accounts,points,manifest,options:{start,end,metric,otherStart:compare?otherStart:null,otherEnd:compare?otherEnd:null,visibleOffset:offset,visibleDays:90}});const url=URL.createObjectURL(new Blob([csv(rows)],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=`${names[metric]}-增长曲线.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setExportError('');}catch(e){setExportError((e as Error).message);}}
 return <section className="panel growth-panel" aria-label="每日增长与区间对比"><div className="panel-head"><div><h2>每日增长与区间对比</h2><p className="meta">从各区间起点归零，观察增长节奏；不是账户历史累计总量。曲线每屏90日，统计基线不变。</p></div><Button variant="outline" aria-pressed={compare||editingComparison} onClick={toggleComparison}>{compare?'关闭区间对比':editingComparison?'取消比较':'比较另一段日期'}</Button><Button variant="outline" disabled={!series||invalidComparison||!hasValues} onClick={exportTrend}>导出本屏曲线记录</Button></div>
 <ToggleGroup className="trend-metrics" type="single" value={metric} onValueChange={value=>{if(Object.hasOwn(names,value))setMetric(value);}} aria-label="趋势指标">{Object.entries(names).map(([key,label])=><ToggleGroupItem key={key} value={key} aria-label={label+'趋势'}>{label}{key==='estimated'&&<small>非实际</small>}</ToggleGroupItem>)}</ToggleGroup>
 {series&&!invalidComparison&&<div className="trend-reading" aria-label="本屏真实末日读数"><div><p className="meta">当前区间 · 本屏末日 {currentEnd?.date||'无记录'}</p><strong className={currentEnd?.value<0?'negative':currentEnd?.value>0?'positive':''}>{number(currentEnd?.value??null)}</strong><span>{names[metric]}累计净变化</span></div>{compare&&<div><p className="meta">比较区间 · 本屏末日 {comparisonEnd?.date||'无记录'}</p><strong>{number(comparisonEnd?.value??null)}</strong><span>{names[metric]}累计净变化</span></div>}<p className="meta">{metric==='estimated'?'获赞净变化 × 100 · 非实际播放量':'固定同账号队列 · 缺日保留断线'}</p></div>}
 {series&&!invalidComparison&&selected&&<div className="trend-selected"><div className="trend-selected-controls"><label>查看日期<select aria-label="曲线选中日期" value={selected.day} onChange={e=>selectDay(Number(e.target.value))}>{series.points.map((p:Row)=><option key={p.day} value={p.day}>{compare?`第 ${p.day} 天 · `:''}{p.currentDate||'当前区间外'}{compare&&` / ${p.comparisonDate||'比较区间外'}`}</option>)}</select></label><span className="meta">点击曲线选日，或聚焦后用 ← →、Home、End</span></div><div className="trend-selected-reading" id={readingId} aria-label="选中日期累计净变化" aria-live="polite" aria-atomic="true"><p className="meta">相对第 {selected.day} 天 · {names[metric]}累计净变化</p>{readingSides.map(key=>{const side=selected[key];return <div key={key}><span>{key==='current'?'当前区间':'比较区间'} · {side.date||'区间外'}</span><strong className={side.value<0?'negative':side.value>0?'positive':''}>{side.state==='outside'?'区间外':number(side.value)}</strong><small>{side.state==='known'?units[metric]:side.state==='outside'?'这个相对日没有对应日期，不借用相邻值':'当日缺测，不补零'}{side.date&&` · 已采 ${side.known??'—'}/${series.cohortCount} 账号`}</small></div>;})}{metric==='estimated'&&<p className="meta">获赞净变化 × 100 · 非实际播放量</p>}</div></div>}
 <p className="chart-legend"><span>━━ 当前区间</span>{compare&&<span>┄┄ 比较区间</span>}<small>导出保留真实端点与来源</small></p>{exportError&&<p className="error" role="alert">{exportError}</p>}
 {(compare||editingComparison)&&<div className="filters comparison-controls"><label>比较起点<Input type="date" value={draftStart} max={draftEnd||undefined} onChange={e=>editComparison('otherStart',e.target.value)}/></label><label>比较终点<Input type="date" value={draftEnd} min={draftStart||undefined} onChange={e=>editComparison('otherEnd',e.target.value)}/></label>{editingComparison&&<Button type="button" disabled={!comparisonDraftValid} onClick={()=>{onComparison({compare:true,otherStart:draftStart,otherEnd:draftEnd});setEditingComparison(false);onOffset(0);}}>应用比较</Button>}{compare&&editingComparison&&<Button type="button" variant="ghost" onClick={()=>setEditingComparison(false)}>取消修改</Button>}<span className="meta">{editingComparison&&!comparisonDraftValid?'选好比较起点与终点后再应用；当前数据保持显示。':'按第0天、第1天对齐。两曲线使用四个端点均已采的同一队列，可能少于上方单区间卡片；口径不可混用。'}</span></div>}
 {totalDays>90&&<div className="pager"><span>曲线相对第 {offset}–{Math.min(offset+89,totalDays-1)} 天 · 区间端点与基线保持不变</span><Button variant="outline" disabled={offset===0} onClick={()=>onOffset(Math.max(0,offset-90))}>前90日</Button><Button variant="outline" disabled={offset+90>=totalDays} onClick={()=>onOffset(offset+90)}>后90日</Button></div>}
 {result.error||invalidComparison?<p className="scope" role="status">{result.error||'请选择比较区间的两个日期。'}</p>:series&&<><p className="scope">固定可比 {series.cohortCount}/{series.totalCount} 账号 · 当前 {start} → {end}{compare&&` · 比较 ${otherStart} → ${otherEnd}`} · 缺日断线，未补零{metric==='estimated'&&' · 点赞净变化 ×100，非实际播放量'}</p>
 {hasValues?(!suspended&&<GrowthChart points={series.points} compare={compare} metric={metric} label={names[metric]} cohortCount={series.cohortCount} selectedDay={selected?.day??null} onSelectDay={selectDay} readingId={readingId}/>):<p className="empty" role="status">没有同时满足起止端点的可比账号。请选择其他真实日期，缺测没有当作0增长。</p>}
 <details className="trend-details"><summary>查看逐日数值与缺测（{series.points.length} 日）</summary><Table><TableHeader><TableRow><TableHead>当前日期</TableHead><TableHead>累计净变化</TableHead><TableHead>已采/固定队列</TableHead>{compare&&<><TableHead>比较日期</TableHead><TableHead>累计净变化</TableHead><TableHead>已采/固定队列</TableHead></>}</TableRow></TableHeader><TableBody>{series.points.map((p:Row)=><TableRow key={p.day}><TableCell>{p.currentDate||'区间外'}</TableCell><TableCell>{p.currentDate?number(p.current):'区间外'}</TableCell><TableCell>{p.currentDate?`${p.currentKnown}/${series.cohortCount}`:'—'}</TableCell>{compare&&<><TableCell>{p.comparisonDate||'区间外'}</TableCell><TableCell>{p.comparisonDate?number(p.comparison):'区间外'}</TableCell><TableCell>{p.comparisonDate?`${p.comparisonKnown}/${series.cohortCount}`:'—'}</TableCell></>}</TableRow>)}</TableBody></Table></details></>}
 </section>;
}
