"use client";
import {TableBody,TableCell,TableHead,TableHeader,TableRow} from '@/components/ui/table';
import {ScrollableTable as Table} from '@/components/scrollable-table';
type Endpoint={baseline:number|null,value:number|null,delta:number|null,baselineAt:string|null,currentAt:string|null};
const names={followers:'粉丝',likes:'获赞',posts:'作品存量'};
const value=(n:number|null)=>n===null?'缺测':n.toLocaleString('zh-CN');
const time=(at:string|null,n:number|null)=>n===null||!at?'未取得此指标':new Date(at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
export function EndpointSources({metrics,start,end}:{metrics:Record<string,Endpoint>;start:string;end:string}){
 return <details className="endpoint-sources"><summary>查看本区间的原始端点与采样时间</summary><p className="meta">请求基准日 {start} → 请求截止日 {end}；实际取得的指标端点与时间见下表，缺测不补零，不是统一瞬时或当天终盘。完整来源哈希在下方每日历史及导出中保留。</p><Table><TableHeader><TableRow><TableHead>指标</TableHead><TableHead>基准值 / 时间</TableHead><TableHead>截止值 / 时间</TableHead><TableHead>净变化</TableHead></TableRow></TableHeader><TableBody>{Object.entries(names).map(([k,n])=>{const m=metrics[k];return <TableRow key={k}><TableCell>{n}</TableCell><TableCell>{value(m.baseline)}<small>{time(m.baselineAt,m.baseline)}</small></TableCell><TableCell>{value(m.value)}<small>{time(m.currentAt,m.value)}</small></TableCell><TableCell>{m.delta===null?'缺测':(m.delta>0?'+':'')+value(m.delta)}</TableCell></TableRow>;})}</TableBody></Table></details>;
}
