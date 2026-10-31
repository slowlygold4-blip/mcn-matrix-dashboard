"use client";
import {useMemo,useState,type ReactNode} from 'react';
import {Button} from '@/components/ui/button';
import {summarizeSourceObservations} from '@/lib/creator-intelligence.mjs';

type Row=Record<string,any>;
const number=(value:number|null|undefined)=>value==null?'—':value.toLocaleString('zh-CN');
const pct=(part:number|null|undefined,total:number|null|undefined)=>total&&part!=null?`${(part/total*100).toFixed(1)}%`:'—';
const shortDate=(date:string)=>date?.slice(5).replace('-','/')||'—';

export function SourceOperations({insights,source,foundation,sourceRosterCount,error,foundationError='',accountPreview,onInspect,onNavigateAccounts}:{insights:Row|null;source:Row|null;foundation:Row|null;sourceRosterCount:number|null;error:string;foundationError?:string;accountPreview?:ReactNode;onInspect:(focus:{view:'authors'|'works';query?:string;track?:string;linkage?:'all'|'linked'|'sourceOnly';startDate?:string;endDate?:string;mainTableOnly?:boolean})=>void;onNavigateAccounts:()=>void}){
 const [track,setTrack]=useState('all');
 const supplement=useMemo(()=>foundation?summarizeSourceObservations(foundation.observations):null,[foundation]);
 if(error&&(!insights||!source||foundation))return <><section className="intelligence-unavailable" role="alert"><h2>表格分析暂不可读</h2><p>{error}。原始表格和监控快照未改动，请稍后刷新已发布数据。</p></section>{accountPreview}</>;
 if(!insights||!source)return <><section className="intelligence-unavailable" role="status"><h2>正在核对表格分析</h2><p>读取已保存来源、校验文件与修订号…</p></section>{accountPreview}</>;
 const supplementalGap=!foundation;
 const supplementalFailure=foundationError||(supplementalGap?error:'');
 const all=insights.counts;
  // Older sealed analyses may encode missing aggregates as zero. A recorded
  // zero remains zero, while no recorded value must render as missing.
  const totalPlays=all.playsKnown>0?all.cumulativePlays:null;
  const totalLikes=all.likesKnown>0?all.cumulativeLikes:null;
 const selected=track==='all'?null:insights.tracks.find((item:Row)=>item.track===track);
 const mainWorks=source.stats.works;
 const selectedWorks=selected?.works??mainWorks;
 const leaders=insights.leaderboards[track]??insights.leaderboards.all;
  const mostOutput=insights.tracks[0],mostPlayback=[...insights.tracks].filter((item:Row)=>item.playsKnown>0).sort((a:Row,b:Row)=>b.cumulativePlays-a.cumulativePlays)[0];
 const sourceAuthorCount=source.stats.authors+(foundation?.authors.length??0);
 const linkedSourceIdentities=source.stats.linkedAuthors+(foundation?.authors.filter((author:Row)=>author.targetIds?.length>0).length??0);
 // The roster only merges aliases backed by the same persisted target ID.
 // A source-only identity cannot be removed by that reconciliation.
 const completeRosterCount=foundation?sourceRosterCount:null;
 const aliasCount=completeRosterCount==null?null:sourceAuthorCount-completeRosterCount;
 const linkedSourceAuthors=aliasCount!=null&&aliasCount>=0&&aliasCount<=linkedSourceIdentities?linkedSourceIdentities-aliasCount:null;
 const sourceOnlyAuthors=foundation?sourceAuthorCount-linkedSourceIdentities:null;
 const jumpTo=(id:string)=>{
  const target=document.getElementById(id);
  if(!target)return;
  target.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});
  target.focus({preventScroll:true});
 };
 const boardCounts=new Map<string,{authors:number;works:number}>();
 for(const item of foundation?.otherAuthors??[]){const entry=boardCounts.get(item.board)??{authors:0,works:0};entry.authors++;boardCounts.set(item.board,entry);}
 for(const item of foundation?.otherWorks??[]){const entry=boardCounts.get(item.board)??{authors:0,works:0};entry.works++;boardCounts.set(item.board,entry);}
 const boards=[...boardCounts].sort((a,b)=>b[1].authors-a[1].authors);
 return <div className="source-ops">
  {accountPreview}
  <details className="source-ops-archive">
   <summary><strong>原始登记与来源核对</strong><span>{number(completeRosterCount??sourceAuthorCount)} 位作者 · {number(all.tableWorks+(foundation?.works.length??0))} 条去重作品记录</span><small>原表作品日期至 {insights.lastDate}，不是监控截止 · 展开看分类、发片与来源记录</small></summary>
   <div className="source-ops-archive-body">
  <section className="source-ops-hero" aria-labelledby="source-ops-title">
   <div><p className="source-ops-kicker">来源表 · 团团矩阵</p><h2 id="source-ops-title">作品数据，<br/>都有来处。</h2><p className="source-ops-intro">这是原始表格的作品档案。按记录日期查看作品；日期依据在明细中列出。每天的粉丝、获赞和作品存量变化在上方账号采样区。</p><div className="source-ops-basis"><span>原表作品日期：{insights.firstDate}—{insights.lastDate}</span><span>原表截止日不是账号监控截止日</span></div></div>
   <div className="source-ops-hero-action"><div className="dashboard-orbits" aria-hidden="true"><span/><span/></div><small className="source-ops-hero-action-context">原始表格作品档案 · 截至 {insights.lastDate}<br/>平台采样仍按上方时间继续</small><strong>{number(all.tableWorks+(foundation?.works.length??0))}</strong><span>{supplementalGap?'条已去重的总表作品 · 补充表待核':'条已去重的作品记录'}</span><Button variant="outline" onClick={()=>onInspect({view:'works'})}>查看{supplementalGap?'已读总表':'全部'}作品 ↗</Button></div>
  </section>
  <div className="source-ops-proofline" aria-label="作品数据口径"><span><strong>来源表累计</strong>，不是期间新增播放</span><span>团团总表有日期作品 {number(all.datedWorks)} / {number(mainWorks)}</span><span>播放有值 {number(all.playsKnown)} / {number(mainWorks)}，未经逐条平台核验</span></div>
  {supplementalGap&&<div className="notice" role={supplementalFailure?'alert':'status'}>补充表{supplementalFailure?'读取失败':'正在读取'}；下方仅展示已校验的团团总表数据。补充作者、作品、其他板块与后续观测暂不计入，不能把当前数量当作全量。{supplementalFailure&&<small>原因：{supplementalFailure}</small>}</div>}
  <section className="source-ops-wayfinder" aria-label="从这里开始查看数据"><div><strong>你想看什么？</strong><span>表格成绩与每日账号变化分开，避免把累计值当成新增。</span></div><Button variant="outline" onClick={()=>onInspect({view:'authors'})}>找作者 →</Button><Button variant="outline" onClick={()=>onInspect({view:'works'})}>找作品 →</Button><Button onClick={onNavigateAccounts}>看粉丝、点赞变化 →</Button></section>
  <nav className="source-ops-index" aria-label="本页快速定位"><span>本页跳转</span><button type="button" onClick={()=>jumpTo('source-ops-publishing')}>发片趋势</button><button type="button" onClick={()=>jumpTo('source-ops-tracks')}>内容类型</button><button type="button" onClick={()=>jumpTo('source-ops-rankings')}>作者与作品榜</button><button type="button" onClick={()=>jumpTo('source-ops-quality')}>数据可信度</button></nav>
  <section className="source-ops-kpis" aria-label="来源表经营概览">
   <div><small>{supplementalGap?'总表登记身份（补充表待核）':completeRosterCount==null?'表格登记身份（去重待核）':'团团表格作者（跨表去重）'}</small><strong>{number(completeRosterCount??sourceAuthorCount)}</strong><span>{number(all.datedWorkAuthors??all.activeWorkAuthors)} 位有日期作品记录；{supplementalGap?'补充表作者尚未计入':'其余仍保留在名册'}</span></div>
   <div><small>团团总表有发布日期作品</small><strong>{number(all.datedWorks)}</strong><span>可用于按发布日期查看发片趋势；未填日期的作品仍保留</span></div>
   <div><small>表格最后 7 天发布作品</small><strong>{number(insights.lastDate?all.sevenDayWorks:null)}</strong><span>{insights.lastDate?`${shortDate(insights.sevenDayStart)}—${shortDate(insights.lastDate)}，按发布日期`:'尚无发布日期，无法计算发片区间'}</span></div>
   <div><small>原表有播放值的作品</small><strong>{number(all.playsKnown)}<em> / {number(mainWorks)}</em></strong><span>团团总表作品；缺少发布日期也保留成绩</span></div>
  </section>
  <details className="source-ops-method"><summary>这些数字如何计算？</summary><p>{supplementalGap?'已核验的团团总表登记': '原表登记'} {number(sourceAuthorCount)} 个账号身份，{supplementalGap?'补充表未读到，跨表作者去重及全量身份数待核':completeRosterCount==null?'跨表去重仍在核对':`其中 ${number(aliasCount)} 组同目标同名别名已合并，跨表去重后有 ${number(completeRosterCount)} 位可按表检索的团团作者`}；原始记录不删除。{foundation?.pendingAuthors?.length?`另有 ${number(foundation.pendingAuthors.length)} 位旧来源独立身份保留在「团团作者名册」，不冒充已核验作者或采集目标。`:''}作品按 ID 去重。最近 7 天以表格最晚作品日期为终点，不是以今天为终点。下方曲线按记录日期归集<strong>每日作品记录</strong>，推算日期和待核验日期不等于已确认发布；播放与点赞是原表填报的累计值，采样时间可能不同，未经平台逐条独立核验，更不是每日新增。一个作品可登记多个内容类型，各类型不可相加。</p><p>来源：总表修订 {source.revision}；{foundation?`另有 ${foundation.index.stats.sheets} 张工作表和 ${foundation.index.stats.sourceDocuments} 份来源。`:'补充表尚未核验，此处的数量只覆盖团团总表。'}原始记录可在“作者与作品”中逐条查验；旧来源独立身份见「团团作者名册」。</p></details>
  {mostOutput&&<section className="source-ops-signal" aria-label="内容结构提示"><span>快速发现</span><p>登记作品最多的是<strong>{mostOutput.track}</strong>（占总表作品的 {pct(mostOutput.works,mainWorks)}）；{mostPlayback?<>表格填报播放值合计最多的是<strong>{mostPlayback.track}</strong>（占已记录播放值合计的 {pct(mostPlayback.cumulativePlays,totalPlays)}）</>:'暂无有值的播放记录，不能排列播放成绩'}。一条作品可有多个标签，比例不能相加。</p></section>}
  <section className="source-ops-grid">

   <div className="source-ops-panel source-ops-track-panel" id="source-ops-tracks" tabIndex={-1}><div className="source-ops-panel-head"><div><p className="source-ops-kicker">内容类型</p><h3>内容类型结构</h3><span>点击一类，图表与榜单同步切换 · 标签可重叠</span></div></div><div className="source-ops-track-list"><button className={track==='all'?'selected':''} onClick={()=>setTrack('all')} aria-pressed={track==='all'}><span>全部内容<small>{number(all.activeWorkAuthors)} 位有作品作者 · 表格播放 {number(totalPlays)}</small></span><strong>{number(mainWorks)}</strong><small>作品 {pct(mainWorks,mainWorks)}<br/>表格播放 {pct(totalPlays,totalPlays)}</small></button>{insights.tracks.map((item:Row)=><button key={item.track} className={track===item.track?'selected':''} onClick={()=>setTrack(item.track)} aria-pressed={track===item.track}><span>{item.track}<small>{number(item.authors)} 位作者 · 表格播放 {number(item.playsKnown>0?item.cumulativePlays:null)}</small></span><strong>{number(item.works)}</strong><small>作品 {pct(item.works,mainWorks)}<br/>表格播放 {pct(item.playsKnown>0?item.cumulativePlays:null,totalPlays)}</small></button>)}</div><div className="source-ops-track-note">当前类别：{number(selectedWorks)} 条作品，{number(selected?.authors??all.activeWorkAuthors)} 位作者；原表有播放值 {number(selected?.playsKnown??all.playsKnown)} 条。同一作品可进多个类别，类别不是作者永久归属，赛道数不可相加。{all.undatedWorks>0?`总表 ${number(all.undatedWorks)} 条未记录发布日期，保留在作品列表与累计成绩中，不放入日期曲线。`:''}</div></div>
  </section>
  <section className="source-ops-achievement" aria-label="表格记录的历史成绩"><div><p className="source-ops-kicker">表格记录的历史成绩</p><h3>这些是来源表累计值，不是本周或本月新增</h3><p>来自团团总表中已记录成绩的作品。作品填表时间可能不同，播放值未经平台逐条独立核验，不能据此推算每日播放、每日获赞。</p></div><div><small>有记录作品的表格播放值合计</small><strong>{number(totalPlays)}</strong><span>{number(all.playsKnown)} / {number(mainWorks)} 条有播放值</span></div><div><small>有记录作品的表格点赞值合计</small><strong>{number(totalLikes)}</strong><span>{number(all.likesKnown)} / {number(mainWorks)} 条有点赞值</span></div></section>
  <section className="source-ops-rankings" id="source-ops-rankings" tabIndex={-1}><div className="source-ops-panel"><div className="source-ops-panel-head"><div><p className="source-ops-kicker">按表格累计播放排序</p><h3>哪些作者的作品表现突出</h3><span>仅依据已记录的作品播放值，不是涨粉榜</span></div><Button variant="ghost" onClick={()=>onInspect({view:'authors'})}>全部作者 →</Button></div><div className="source-ops-rank-list">{leaders.authors.filter((item:Row)=>item.playsKnown>0).slice(0,10).map((item:Row,index:number)=><button key={item.douyinId} onClick={()=>onInspect({view:'authors',query:item.douyinId})}><span className="source-ops-rank-no">{String(index+1).padStart(2,'0')}</span><span className="source-ops-rank-name"><strong>{item.name}</strong><small>{item.douyinId} · {number(item.works)} 条作品</small></span><span className="source-ops-rank-value">{number(item.cumulativePlays)}<small>累计播放·表格</small></span></button>)}</div></div>
   <div className="source-ops-panel"><div className="source-ops-panel-head"><div><p className="source-ops-kicker">作品表现</p><h3>代表作品</h3><span>同作品 ID 只出现一次 · 点击看原视频</span></div><Button variant="ghost" onClick={()=>onInspect({view:'works',track})}>全部作品 →</Button></div><div className="source-ops-rank-list">{leaders.works.slice(0,10).map((item:Row,index:number)=><div key={item.contentId}><span className="source-ops-rank-no">{String(index+1).padStart(2,'0')}</span><span className="source-ops-rank-name">{item.url?<a href={item.url} target="_blank" rel="noopener noreferrer">{item.title||item.contentId}</a>:<strong>{item.title||item.contentId}</strong>}<small>{item.author} · {item.date}</small></span><span className="source-ops-rank-value">{number(item.plays)}<small>累计播放·表格</small></span></div>)}</div></div></section>
  {supplement?<section className="source-ops-panel source-ops-observations" aria-label="补充来源作品记录"><div className="source-ops-panel-head"><div><p className="source-ops-kicker">后续来源记录</p><h3>已收录的作品记录</h3><span>{supplement.latestAt?new Date(supplement.latestAt).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'}):'采样时间未注明'} · {number(supplement.rows)} 条记录覆盖 {number(supplement.uniqueWorks)} 个作品 ID</span></div><Button variant="ghost" onClick={()=>onInspect({view:'works'})}>逐条查来源 →</Button></div><p className="source-ops-observation-note">这批是较后登记的局部样本，不是整个矩阵的同步快照；不与上面的总表累计播放相加。只有明确的指标采样时间才能判定先后；提交时间不代表采样时间。没有采样时间且数值不一致时保留待核；{number(supplement.ambiguousWorks)} 个作品的记录无法确定唯一数值，暂不进入下方样本榜。</p><div className="source-ops-observation-grid"><div className="source-ops-observation-stat"><strong>{number(supplement.usableWorks)}</strong><span>有一致数值的作品记录</span></div>{supplement.topWorks.slice(0,6).map((item:Row,index:number)=><button key={item.contentId} onClick={()=>onInspect({view:'works',query:item.contentId})}><small>{String(index+1).padStart(2,'0')} · {item.author||'未署名'} · {item.contentId}</small><strong>{number(item.plays)}</strong><span>来源记录播放 · 点赞 {number(item.likes)}</span></button>)}</div></section>:<section className="source-ops-panel source-ops-observations" aria-label="补充来源作品记录"><h3>补充来源观测待核</h3><p className="meta">补充表尚未完整读取，此处不显示观测数量或榜单；上方总表累计成绩仍可查看。</p></section>}
  <section className="source-ops-footer-grid"><div className="source-ops-panel"><p className="source-ops-kicker">其他来源板块</p><h3>其他板块也保留在同一数据基石</h3>{foundation?<><p>以下是原表明确板块的身份与作品记录，尚无相同口径的作品累计成绩；不与团团榜单混算。</p><div className="source-ops-board-list">{boards.map(([name,count])=><div key={name}><strong>{name}</strong><span>{number(count.authors)} 位作者 · {number(count.works)} 个作品 ID</span></div>)}</div><Button variant="outline" onClick={()=>onInspect({view:'authors'})}>打开完整来源索引 →</Button></>:<p className="meta">其他板块保存在补充表中；本次未读到补充表，不能判断作者或作品数量。</p>}</div><div className="source-ops-panel" id="source-ops-quality" tabIndex={-1}><p className="source-ops-kicker">数据可信度</p><h3>哪些数字能用，哪些还不能</h3><div className="source-ops-quality"><div><strong>{number(all.datedWorks)}</strong><span>总表作品有日期记录，包含待核验日期</span></div><div><strong>{number(all.playsKnown)}</strong><span>作品有来源表播放值，可看累计表现</span></div><div><strong>{number(linkedSourceAuthors)}</strong><span>{linkedSourceAuthors==null?(supplementalGap?'跨表去重待核；已关联采样目标的原始身份数不能当作作者数':'去重待核；已关联采样目标的原始身份数不能当作作者数'):'去重后来源作者关联了稳定采样目标 ID'}</span></div><div><strong>{number(sourceOnlyAuthors)}</strong><span>{supplementalGap?'补充表未读，全部仅来源作者数待核':'仅来源表，未关联采样目标 ID'}</span></div><div><strong>{number(source.stats.reciprocalDuplicates)}</strong><span>总表姓名与抖音号对调的重复行已折叠</span></div><div><strong>{number(foundation?.index.stats.unkeyedRows)}</strong><span>{supplementalGap?'补充表未读，缺可靠 ID 行数待核':'来源行缺可靠 ID，仍在原库待核'}</span></div></div><p>目标 ID 关联不等于采样成功；仅 {number(all.authorFollowersKnown)} 位总表作者有粉丝数，不能把其余填零。发布日期不是播放发生日；表格播放是原表填报的累计字段，并非平台逐条核验的实际播放。账号主页快照仍在「账号采样」中单独核验。</p><Button variant="outline" onClick={()=>onInspect({view:'authors',linkage:'sourceOnly'})}>查看{supplementalGap?'已读总表未关联身份':'仅来源表作者'} →</Button></div></section>
   </div>
  </details>
 </div>;
}
