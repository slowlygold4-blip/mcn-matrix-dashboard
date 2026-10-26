"use client";
import {useEffect,useMemo,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Card,CardContent} from '@/components/ui/card';
import {Badge} from '@/components/ui/badge';
import {TableBody,TableCell,TableHead,TableHeader,TableRow} from '@/components/ui/table';
import {ScrollableTable as Table} from '@/components/scrollable-table';
import {GrowthPanel} from '@/components/growth-panel';
import {MetricLedger} from '@/components/metric-ledger';
import {EndpointSources} from '@/components/endpoint-sources';
import {readReplicaPart} from '@/lib/replica-reader.mjs';
import {personalPoints,personalWindow,accountShareQuery} from '@/lib/replica-account.mjs';
import {rowsFor,csv,validDate} from '@/lib/replica-model.mjs';
import {AccountCoverage} from '@/components/coverage-panel';
import {historyExport} from '@/lib/replica-export.mjs';
type Row=Record<string,any>;
const fmt=(n:any)=>n==null?'—':Number(n).toLocaleString('zh-CN');
const delta=(n:any)=>n==null?'—':(n>0?'+':'')+fmt(n);
const time=(s:string)=>s?new Date(s).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未知';
function exportCsv(rows:any[][],name:string){const u=URL.createObjectURL(new Blob([csv(rows)],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
export function AccountPanel({account,manifest,boards,request,onReturn,returnLabel='返回账号列表',onAddress,onHistory}:{account:Row|undefined;manifest:Row;boards:Row[];request:Row;onReturn:()=>void;returnLabel?:string;onAddress:(query:string)=>void;onHistory:(a:Row,trigger?:HTMLButtonElement)=>void}){
 const [records,setRecords]=useState<Row[]|null>(null),[failure,setFailure]=useState(''),[retry,setRetry]=useState(0),[start,setStart]=useState(request.start||''),[end,setEnd]=useState(request.end||''),[edited,setEdited]=useState(false),[page,setPage]=useState(1),[share,setShare]=useState(''),[status,setStatus]=useState('');
 const [comparison,setComparison]=useState<Row>(request.comparison||{compare:false,otherStart:'',otherEnd:''}),[curveOffset,setCurveOffset]=useState(0);
 useEffect(()=>{setComparison(request.comparison||{compare:false,otherStart:'',otherEnd:''});setShare('');setStatus('');},[request.comparison?.compare,request.comparison?.otherStart,request.comparison?.otherEnd]);
 useEffect(()=>{setStart(request.start||'');setEnd(request.end||'');setEdited(false);setShare('');setStatus('');},[request.start,request.end]);
 useEffect(()=>{const controller=new AbortController();let active=true;setRecords(null);setFailure('');setPage(1);if(!account)return;const part=`daily/${account.id}.json`,meta=manifest.files.find((f:Row)=>f.path===part);if(!meta){setRecords([]);return;}readReplicaPart({generation:manifest.asOf,part,meta,signal:controller.signal}).then(value=>{personalPoints(value.items,account.id,manifest.asOf);if(active){setRecords(value.items);}}).catch(e=>{if(active)setFailure(e.message);});return()=>{active=false;controller.abort();};},[account?.id,manifest.asOf,retry]);
 const points=useMemo(()=>records&&account?personalPoints(records,account.id,manifest.asOf):[],[records,account,manifest.asOf]);
 const saved=useMemo(()=>personalWindow(points,manifest.asOf),[points,manifest.asOf]);
 const actualStart=edited?start:start||saved.start||'',actualEnd=edited?end:end||saved.end||'';
 const valid=validDate(actualStart)&&validDate(actualEnd)&&actualStart<=actualEnd;
 const comparisonValid=!comparison.compare||validDate(comparison.otherStart)&&validDate(comparison.otherEnd)&&comparison.otherStart<=comparison.otherEnd;
 const shareable=valid&&comparisonValid&&records!==null&&!failure;
 const row=useMemo(()=>account&&valid?rowsFor([account],points,actualStart,actualEnd)[0]:null,[account,points,actualStart,actualEnd,valid]);
 const visible=useMemo(()=>valid?[...(records||[])].filter(x=>x.date>=actualStart&&x.date<=actualEnd).sort((a,b)=>b.date.localeCompare(a.date)):[],[records,actualStart,actualEnd,valid]);
 useEffect(()=>{setPage(1);setShare('');setStatus('');setCurveOffset(0);},[actualStart,actualEnd,comparison]);
 function change(which:'start'|'end',value:string){if(!edited){setStart(actualStart);setEnd(actualEnd);}setEdited(true);if(which==='start')setStart(value);else setEnd(value);}
 function apply(){if(shareable&&account)onAddress(accountShareQuery({id:account.id,start:actualStart,end:actualEnd,generation:manifest.asOf,comparison}));}
 function exportHistory(){if(!account||!valid)return;try{exportCsv(historyExport({rows:visible,kind:'daily',account,manifest,start:actualStart,end:actualEnd}),`${account.id}-${actualStart}-${actualEnd}-daily.csv`);setStatus('已导出账号身份、真实采样时间和来源指纹。');}catch(e){setStatus((e as Error).message);}}
 async function copy(){if(!shareable||!account)return;const url=window.location.origin+window.location.pathname+accountShareQuery({id:account.id,start:actualStart,end:actualEnd,generation:manifest.asOf,comparison});setShare(url);try{await navigator.clipboard.writeText(url);setStatus('账号链接已复制，接收者无需登录。');}catch{setStatus('浏览器未允许复制，请选中下方链接复制。');}}
 if(!account)return <section className="panel account-view"><h2>这个版本没有该账号</h2><p>请核对账号编号；不会用同名账号或其他版本替代。</p><Button onClick={onReturn}>{returnLabel}</Button></section>;
 return <section className="account-view" aria-label="独立账号数据"><div className="account-heading"><div><p className="eyebrow">ACCOUNT / {account.id}</p><h2>{account.label}</h2><p className="meta">{account.platform} · {boards.filter(b=>account.boardKeys.includes(b.key)).map(b=>b.name).join(' / ')||'无已登记矩阵'} · {account.classification.theme.label} · {account.classification.labels.map((x:Row)=>x.label).join(' / ')||'暂无确认分类'}</p></div><Badge variant="outline">{account.enabled?'启用监控':'暂停 · 保留历史'}</Badge><Button variant="outline" onClick={onReturn}>{returnLabel}</Button></div>
 <p className="notice">独立账号页不受矩阵筛选影响。此链接固定发布版本 {time(manifest.asOf)}；刷新校验同一版本，不冒充实时数据。</p>
 <AccountCoverage account={account} asOf={manifest.asOf}/>
 {failure?<div role="alert" className="error">{failure} <Button variant="outline" onClick={()=>setRetry(x=>x+1)}>重试读取历史</Button></div>:records===null?<p className="empty" role="status">正在校验这个账号的保存历史…</p>:<>
 <div className="filters"><label>个人基准观察日<Input aria-label="个人基准观察日" type="date" value={actualStart} max={actualEnd} onChange={e=>change('start',e.target.value)}/></label><label>个人截止观察日<Input aria-label="个人截止观察日" type="date" value={actualEnd} min={actualStart} onChange={e=>change('end',e.target.value)}/></label><Button variant="outline" disabled={!saved.start} onClick={()=>{setEdited(true);setStart(saved.start||'');setEnd(saved.end||'');}}>全部已保存日</Button><Button variant="outline" disabled={!shareable} onClick={apply}>保存日期到地址</Button><Button disabled={!shareable} onClick={copy}>复制账号分享链接</Button></div>
 <p className="scope">{actualStart||'暂无采样日'} → {actualEnd||'暂无采样日'} · 北京时间 · {records.length} 个已保存日（不是全部同日原始采样次数）</p>
 <div role="status" aria-live="polite">{status}</div>{share&&<Input readOnly aria-label="账号分享地址" value={share} onFocus={e=>e.currentTarget.select()}/>}
 {!comparisonValid&&<p className="error" role="status">比较日期尚未完整且有序，不能保存或分享；请补齐两个比较日期。</p>}
 {!valid?<p className="error">请选择完整且有序的两个日期；没有保存记录时不补零。</p>:row&&<><MetricLedger metrics={row.metrics} count={1} start={actualStart} end={actualEnd}/><EndpointSources metrics={row.metrics} start={actualStart} end={actualEnd}/><GrowthPanel key={account.id} accounts={[account]} points={points} manifest={manifest} start={actualStart} end={actualEnd} comparison={comparison} onComparison={setComparison} offset={curveOffset} onOffset={setCurveOffset} ready={comparisonValid} pendingError={comparisonValid?'':'请选择完整且有序的比较日期，尚未保存到地址。'}/></>}
 <section className="panel"><div className="panel-head"><h2>已保存每日统计</h2><Button variant="outline" disabled={!valid||!visible.length} onClick={exportHistory}>导出所选区间与来源</Button><Button variant="outline" onClick={event=>onHistory(row||account,event.currentTarget)}>查看全部每日、作品与指标历史</Button></div><p className="meta account-help">下表按个人所选日期过滤；全部历史另行打开，不把缺测写为零。来源指纹与真实指标采样时间随导出保留。</p><div className="pager"><span>{visible.length} 个保存日 · 第 {page}/{Math.max(1,Math.ceil(visible.length/20))} 页</span><Button variant="outline" disabled={page<=1} onClick={()=>setPage(x=>x-1)}>上一页</Button><Button variant="outline" disabled={page*20>=visible.length} onClick={()=>setPage(x=>x+1)}>下一页</Button></div><Table><TableHeader><TableRow><TableHead>观察日 / 来源</TableHead><TableHead>粉丝</TableHead><TableHead>点赞</TableHead><TableHead>作品存量</TableHead></TableRow></TableHeader><TableBody>{visible.slice((page-1)*20,page*20).map(x=><TableRow key={x.id}><TableCell><details><summary>{x.date}</summary><small>{time(x.capturedAt)}</small><small className="source-hash">SHA256 {x.sourceChecksum}</small></details></TableCell>{['followers','likes','posts'].map(k=><TableCell key={k}>{fmt(x[k])}<small>相邻日变化 {delta(x[k+'Delta'])}</small></TableCell>)}</TableRow>)}</TableBody></Table>{!visible.length&&<p className="empty">所选区间没有这个账号的保存记录。</p>}</section></>}
 </section>;
}
