"use client";
import {useEffect,useState,useRef} from 'react';
import {Button} from '@/components/ui/button';
import {CollectionPlatformSummary,CollectionDailyNotice} from '@/components/collection-platform-summary';
type Row=Record<string,any>;
const num=(v:number|null|undefined)=>v==null?'—':v.toLocaleString('zh-CN');
const worksReason:Row={
 'page-obstruction':'页面出现遮挡或验证提示','no-bound-request':'页面未返回作品请求',deadline:'作品分页未完成','http-rejection':'作品接口拒绝请求',
 blocked:'作品接口拒绝访问（401/403）',rate_limited:'作品接口限流（429）',login_required:'作品采集需要登录授权',
 'transport-cooldown':'接口冷却中，作品请求暂缓（非本次请求失败）',network_error:'作品请求网络异常',business_error:'作品接口返回业务错误',upstream_changed:'作品响应格式变化',collector_error:'作品采集程序异常',unknown:'作品采集原因待核验',
};
const clock=(v:string|null)=>v?new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'尚未收到';
export function CollectionConsole(){
 const [data,setData]=useState<Row|null>(null),[error,setError]=useState(''),[feedback,setFeedback]=useState(''),[busy,setBusy]=useState(false),[help,setHelp]=useState(false);
 const requestId=useRef<string|null>(null);
 const load=async()=>{try{const r=await fetch('/api/collection',{cache:'no-store'});const x:Row=await r.json() as Row;if(!r.ok)throw Error(x.error);setData(x);setError('');}catch{setError('进度连接暂时中断，保留上次状态');}};
 useEffect(()=>{
  let dead=false,active=false;const controller=new AbortController();
  const poll=async()=>{if(active||document.hidden||dead)return;active=true;try{const r=await fetch('/api/collection',{cache:'no-store',signal:controller.signal});const x:Row=await r.json() as Row;if(!r.ok)throw Error();if(!dead){setData(x);setError('');}}catch{if(!dead)setError('进度连接暂时中断，保留上次状态');}finally{active=false;}};
  const boot=async()=>{
   if(location.hash.startsWith('#collection-access=')){
    const code=location.hash.slice('#collection-access='.length);history.replaceState(null,'',location.pathname+location.search+'#overview');
    try{const r=await fetch('/api/collection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'pair',code})});const x:Row=await r.json() as Row;if(!r.ok)throw Error(x.error);setFeedback('管理连接已开启。本浏览器可以下达全量采集指令。');}catch(e){setFeedback(e instanceof Error?e.message:'管理连接未成功');}
   }await poll();
  };void boot();const timer=setInterval(()=>void poll(),15000);document.addEventListener('visibilitychange',poll);
  return()=>{dead=true;controller.abort();clearInterval(timer);document.removeEventListener('visibilitychange',poll);};
 },[]);
 const run=data?.status?.run;
 const rolling=data?.status?.rolling;
 const primaryTotal=rolling?.total??run?.total,primaryDone=rolling?.updated??run?.processed;
 const coverageLabel=rolling?'近24小时 · 已更新主页 / 话题':'当前批次已处理';
 const online=!!data?.online&&!error;
 const command=data?.command;
 const pending=command&&['queued','running'].includes(command.status);
 const running=online&&run?.status==='running';
 const percent=primaryTotal>0?Math.min(100,Math.max(0,primaryDone/primaryTotal*100)):null;
 const stateLabel=!data?'连接采集脚本':!online?'采集端未连接':pending&&command.status==='queued'?'全量指令已排队':running?'脚本正在采集':'脚本在线 · 等待下一批';
 const trigger=async()=>{
  if(!data?.canControl){setHelp(true);return;}
  if(busy)return;setBusy(true);setFeedback('');requestId.current??=crypto.randomUUID();
  try{const r=await fetch('/api/collection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'trigger',id:requestId.current})});const x:Row=await r.json() as Row;if(!r.ok)throw Error(x.error);requestId.current=null;setFeedback(x.reused?'已复用正在执行的全量指令，未重复启动。':'全量指令已送达，采集电脑将在下一次通信时接收（通常 15 秒内）。');await load();}
  catch(e){setFeedback(e instanceof Error?e.message:'指令发送失败，请重试');}finally{setBusy(false);}
 };
 return <section className="collection-console" aria-label="脚本采集进度" data-running={running} data-online={online}>
  <div className="collection-console__top"><div className="collection-console__state"><span className="collection-signal" aria-hidden="true"/><strong>{stateLabel}</strong><span className="collection-runtime">脚本运行 · 无模型调用</span></div><Button className="collection-trigger" onClick={trigger} disabled={busy||!!pending|| (!!data?.canControl&&!online)}>{busy?'正在下达…':pending?'全量采集已下达':'全量采集 ↗'}</Button></div>
  <div className="collection-console__body"><div><span className="collection-caption">{rolling?coverageLabel:run?`批次 #${run.id} · ${run.kind==='works-only'?'作品补采':run.kind==='manual-refresh'?'主动全量采集':'自动采集'}`:'等待真实任务状态'}</span><div className="collection-counter"><strong>{num(primaryDone)}</strong><span> / {num(primaryTotal)} 个已关联目标已有更新</span>{percent!=null&&<b>{percent.toFixed(1)}%</b>}</div></div><div className="collection-details"><span className="positive">主页更新 <b>{num(rolling?.profiles)}</b></span><span className="negative">尚未更新 <b>{num(rolling?.notUpdated)}</b></span><span>作品完整 <b>{num(rolling?.worksComplete)}</b></span><span>作品部分取得 <b>{num(rolling?.worksLimited)}</b></span></div></div>
  <div className="collection-progress" role="progressbar" aria-label="近24小时主页及话题更新覆盖，不代表作品采集完整" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent??undefined} aria-valuetext={percent==null?'等待真实进度':`${num(primaryDone)} / ${num(primaryTotal)} 个目标已更新`}><span style={{width:percent==null?'0%':percent+'%'}}/></div>
  <CollectionDailyNotice status={data?.status}/>
  <div className="collection-console__foot"><span>{running?(run.current?'当前：'+run.current:'正在准备下一账号'):online?'持续采集已开启':'离线期间不显示假进度'} · 全局范围，不随页面筛选变化</span><span>脚本上报 {clock(data?.status?.observedAt)}</span></div>
  <details className="collection-more"><summary><span>采集详情与问题</span><span className="collection-issue-count">{rolling?.workIssues?`${num(rolling.workIssues)} 个作品采样提示`:'查看范围与回执'}</span></summary><CollectionPlatformSummary status={data?.status}/><p className="collection-feedback">{run&&`当前执行：${run.kind==='works-only'?'作品补采':run.kind==='manual-refresh'?'主动全量采集':'自动采集'} #${run.id} · ${num(run.processed)}/${num(run.total)} · 返回成功 ${num(run.success)} · 失败 ${num(run.failed)} · 需关注 ${num(run.warnings)}`}。全量作者的身份关联仍在继续，未关联作者尚不在上方采集分母中。</p>
  {rolling?.reasons?.length>0&&<p className="collection-feedback">作品采样情况：{rolling.reasons.map((r:Row)=>`${worksReason[r.code]||worksReason.unknown} ${num(r.count)} 个`).join('；')}。已有主页数值会保留，作品未采全不会标成完成。</p>}
<div className="collection-more__grid"><p>已启用账号 <b>{num(data?.status?.accounts)}</b> · 话题 <b>{num(data?.status?.topics)}</b><br/>身份关联待处理任务 <b>{num(data?.status?.queue?.pending)}</b> · 已拒绝任务 <b>{num(data?.status?.queue?.rejected)}</b></p><p>最近完成批次 #{data?.status?.coverage?.runId??'—'}：主页可用 <b>{num(data?.status?.coverage?.profiles)}</b> · 作品完整 <b>{num(data?.status?.coverage?.worksComplete)}</b> · 作品有限 <b>{num(data?.status?.coverage?.worksLimited)}</b> · 话题双指标 <b>{num(data?.status?.coverage?.topics)}</b></p></div><p>全量指令采集全部已关联且启用的账号与话题；未关联作者由身份队列继续处理。任务数可能含同一作者的多份证据。处理完成包含失败和跳过，主页成功不代表作品完整。</p>{command&&<p>最近指令：{({queued:'等待采集电脑接收 / 等待当前批次结束',running:'采集中',completed:'处理结束',failed:'执行失败',interrupted:'已中断',expired:'未及时接收，指令已过期'} as Row)[command.status]||command.status} · {clock(command.createdAt)}{command.receipt?.runId?` · 批次 #${command.receipt.runId}`:''}</p>}<p>每 15 秒读取脚本状态；采集电脑关闭或网络中断后停止动态效果。仪表盘数据发布时间与采集进度分别显示。</p>{data?.canControl&&<button className="collection-text-button" onClick={async()=>{await fetch('/api/collection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'logout'})});await load();}}>退出本浏览器的采集管理</button>}</details>
  {(error||feedback)&&<p className="collection-feedback" role="status">{error||feedback}</p>}
  {help&&<div className="collection-help" role="region" aria-label="开启采集管理"><strong>先连接你的采集电脑</strong><p>公开访客可以看进度；只有授权浏览器可以下达指令。在运行采集脚本的电脑上打开下面的管理连接，确认一次即可返回这里。</p><a href="http://127.0.0.1:4188/collection-control.html" target="_blank" rel="noreferrer">在本机开启管理 →</a><button onClick={()=>setHelp(false)} aria-label="关闭管理说明">关闭</button></div>}
 </section>;
}
