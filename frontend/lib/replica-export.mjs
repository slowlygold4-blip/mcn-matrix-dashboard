import {isCompactSummary} from './compact-summary-points.mjs';
import {fields,validDate,rowsFor} from './replica-model.mjs';
import {personalPoints} from './replica-account.mjs';
import {growthSeries} from './replica-trends.mjs';
import {summaryPointValid} from './replica-summary.mjs';
import {presentUnifiedWorkMetric} from './unified-work-presentation.mjs';
import {validateUnifiedWorksPart} from './replica-reader.mjs';
const names={followers:'粉丝',likes:'点赞',posts:'作品存量'};
/** Fixed publication + public partition hashes, not a claim of per-platform source verification. */
export function accountExport(rows,manifest,start,end){
 if(!validDate(start)||!validDate(end)||start>end||!manifest?.asOf||!Array.isArray(manifest.files))throw Error('未取得可导出的固定日期与版本');
 const header=['asOf','targetId','platform','作者','账号状态','主题','起点采样日','终点采样日',
  ...fields.flatMap(k=>[names[k]+'基准',names[k],names[k]+'净变',k+'BaselineAt',k+'CurrentAt']),
  'dailyPart','dailyPartSha256','来源说明'];
 return [header,...rows.map(a=>{const path='daily/'+a.id+'.json',part=manifest.files.find(f=>f.path===path&&f.kind==='daily'&&f.targetId===a.id);
  return [manifest.asOf,a.id,a.platform,a.label,a.enabled?'启用':'暂停（仅历史）',a.classification.theme.label,start,end,
   ...fields.flatMap(k=>{const m=a.metrics[k];return [m.baseline,m.value,m.delta,m.baseline===null?null:m.baselineAt,m.value===null?null:m.currentAt];}),
   part?path:null,part?.sha256??null,'dailyPartSha256为公开日历史分区指纹；平台原始来源哈希见每日历史导出'];})];
}

const historyFields={
 daily:['id','date','capturedAt','sampleCount',...fields.flatMap(k=>[k,k+'Delta',k+'At',k+'Checksum',k+'BaselineAt',k+'BaselineChecksum']),'sourceChecksum'],
 works:['id','externalId','caption','url','publishedAt','publishedOn','publicationDateBasis','firstSeenAt','lastObservedAt',
  'workSource','likes','likesOrigin','likesPlatformValue','likesPlatformObservedAt','sourceCumulativeLikes','likesBasis',
  'comments','shares','collects','plays','playsOrigin','playsPlatformValue','playsPlatformObservedAt',
  'sourceCumulativePlays','sourceRefreshedAt','sourceRefreshTimeBasis','playsBasis','playsNote'],
 workMetrics:['id','workId','externalId','capturedAt','likes','comments','shares','collects','plays','playsNote']
};
function publication(manifest){
 if(manifest?.timeZone!=='Asia/Shanghai'||typeof manifest.asOf!=='string'||!Number.isFinite(Date.parse(manifest.asOf))||new Date(manifest.asOf).toISOString()!==manifest.asOf||!Array.isArray(manifest.files))throw Error('导出缺少有效的固定发布版本');
 return [manifest.asOf,manifest.timeZone];
}
function identity(account){if(!Number.isSafeInteger(account?.id)||account.id<1||typeof account.platform!=='string'||!account.platform||typeof account.label!=='string')throw Error('导出缺少稳定账号身份');}
function sourcePart(manifest,account,kind){
 identity(account);const path=(kind==='workMetrics'?'work-metrics':kind)+'/'+account.id+'.json',matches=manifest.files.filter(f=>f.path===path);
 if(matches.length!==1||matches[0].kind!==kind||matches[0].targetId!==account.id||!/^[a-f0-9]{64}$/.test(matches[0].sha256)||!Number.isSafeInteger(matches[0].count)||matches[0].count<0)throw Error('导出来源分区身份或指纹无效');
 return {path,...matches[0]};
}
function workUrl(value,externalId,platform){
 if(typeof value!=='string'||typeof externalId!=='string')return null;
 const links={douyin:{domain:'douyin.com',paths:[`/video/${externalId}`,`/share/video/${externalId}`],path:`/video/${externalId}`,id:/^\d{15,25}$/},bilibili:{domain:'bilibili.com',paths:[`/video/${externalId}`],path:`/video/${externalId}`,id:/^BV[0-9A-Za-z]{10}$/},xiaohongshu:{domain:'xiaohongshu.com',paths:[`/explore/${externalId}`,`/discovery/item/${externalId}`],path:`/explore/${externalId}`,id:/^[a-f\d]{24}$/i}};
 const link=links[platform];if(!link||!link.id.test(externalId))return null;
 try{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.port||!(url.hostname===link.domain||url.hostname===`www.${link.domain}`)||!link.paths.includes(url.pathname.replace(/\/$/,'')))return null;return `https://www.${link.domain}${link.path}`;}catch{return null;}
}
function workMetricExport(row){
 const likes=presentUnifiedWorkMetric(row,'likes'),plays=presentUnifiedWorkMetric(row,'plays');
 const basis=(metric,name)=>metric.origin==='platform'
  ?`当前采用已存平台${name}字段；采样时刻见对应 PlatformObservedAt，非日增长。`
  :metric.origin==='source'
   ?`当前采用原表累计${name}；来源刷新时间不是逐作品采样时刻，非日增长。`
   :`${name}缺测，未补零。`;
 return {
  workSource:['creator-source','platform-and-creator-source'].includes(row.source)
   ?row.source:typeof row.id==='string'?'creator-source':'platform',
  likes:likes.value,likesOrigin:likes.origin,likesPlatformValue:likes.platformValue,
  likesPlatformObservedAt:likes.platformObservedAt,sourceCumulativeLikes:likes.sourceValue,
  likesBasis:basis(likes,'点赞'),
  plays:plays.value,playsOrigin:plays.origin,playsPlatformValue:plays.platformValue,
  playsPlatformObservedAt:plays.platformObservedAt,sourceCumulativePlays:plays.sourceValue,
  sourceRefreshedAt:likes.sourceRefreshedAt??plays.sourceRefreshedAt,
  sourceRefreshTimeBasis:likes.sourceNote??plays.sourceNote,
  playsBasis:basis(plays,'播放')+(plays.note??''),
  playsNote:plays.note??'来源播放字段未经独立核验为实际播放',
 };
}
/** Whitelist public record fields; partition hashes never pretend to be platform source hashes. */
export function historyExport({rows,kind,account,manifest,start=null,end=null}){
 const fixed=publication(manifest),keys=historyFields[kind];identity(account);
 if(!keys||!Array.isArray(rows)||(start===null)!==(end===null)||start!==null&&(kind!=='daily'||!validDate(start)||!validDate(end)||start>end))throw Error('无效历史导出范围');
 const part=sourcePart(manifest,account,kind),ids=new Set();
 if(rows.length>part.count)throw Error('历史导出超出已校验分区条数');
 if(kind==='works')validateUnifiedWorksPart(rows,manifest.asOf);
 for(const row of rows){const idValid=kind==='works'
   ? Number.isSafeInteger(row.id)&&row.id>0||typeof row.id==='string'&&/^creator-source:[1-9]\d*:[1-9]\d*$/.test(row.id)
   : Number.isSafeInteger(row.id)&&row.id>0;
  if(row.targetId!==account.id||!idValid||ids.has(String(row.id)))throw Error('历史导出记录归属或编号无效');ids.add(String(row.id));
  for(const key of keys){const value=row[key];
   if((key.endsWith('At')||key==='capturedAt')&&value!=null&&(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value||Date.parse(value)>Date.parse(manifest.asOf)))throw Error('历史导出采样时间无效或超出固定版本');
   if(key.endsWith('Checksum')&&value!=null&&(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value)))throw Error('历史导出来源指纹无效');
  }
  if(kind==='works'){
   const basis=row.publicationDateBasis;
   if(basis!=null&&!['platform-timestamp','creator-source-date-only','missing'].includes(basis)
    ||row.publishedOn!=null&&!validDate(row.publishedOn)
    ||basis==='platform-timestamp'&&!row.publishedAt
    ||basis==='creator-source-date-only'&&(row.publishedAt!=null||!validDate(row.publishedOn))
    ||basis==='missing'&&(row.publishedAt!=null||row.publishedOn!=null)
    ||basis==null&&row.publishedOn!=null)throw Error('来源表作品日期口径无效');
  }
 }
 if(kind==='daily'){personalPoints(rows,account.id,manifest.asOf);if(start!==null&&rows.some(row=>row.date<start||row.date>end))throw Error('日历史记录超出导出的所选日期');}
 const note=kind==='daily'?'指标采样时间与原有来源指纹保留；sourcePartSha256为公开日历史分区指纹':kind==='works'
  ?'同一作品只占一行；当前值优先采用有效的已存平台字段，缺测回退原表累计，二者不相加。Origin与Basis列说明逐字段口径；sourceRefreshedAt只代表来源版本刷新，不是指标采样。publishedAt为已保存精确时间；publicationDateBasis=creator-source-date-only时publishedOn仅为表格作品日期（未核验），不是平台精确发布时间或播放观察日；来源播放字段不是可靠实际播放证明'
  :'sourcePartSha256为公开历史分区指纹；作品指标未经逐条独立核验，来源播放字段不是可靠实际播放证明';
 const header=['asOf','timeZone','targetId','platform','label','requestedStart','requestedEnd','sourcePart','sourcePartSha256','provenanceNote',...keys];
 return [header,...rows.map(row=>{const derived=kind==='works'?workMetricExport(row):null;return [...fixed,account.id,account.platform,account.label,start,end,part.path,part.sha256,note,...keys.map(k=>k==='url'?workUrl(row.url,row.externalId,account.platform):derived&&Object.hasOwn(derived,k)?derived[k]:k==='playsNote'?row.playsEvidence?.note??'来源播放字段未经独立核验':row[k]??null)];})];
}

/** Compact CSV: one metadata row, one row per fixed cohort member, then visible curve points. */
export function trendExport({accounts,points,manifest,options}){
 const fixed=publication(manifest);
 if(!isCompactSummary(points,manifest.asOf)&&(!Array.isArray(points)||points.some(p=>!summaryPointValid(Object.fromEntries(['targetId','date','capturedAt',...fields.flatMap(k=>[k,k+'At'])].map(k=>[k,p[k]])),manifest.asOf))))throw Error('曲线导出采样超出固定版本或来源日期不一致');
 const series=growthSeries(accounts,points,options),field=options.metric==='estimated'?'likes':options.metric??'followers';
 accounts.forEach(identity);const cohort=new Set(series.cohortTargetIds),selectedIds=accounts.map(a=>a.id).sort((a,b)=>a-b);
 const current=new Map(rowsFor(accounts,points,options.start,options.end).map(a=>[a.id,a.metrics[field]]));
 const comparison=options.otherStart&&options.otherEnd?new Map(rowsFor(accounts,points,options.otherStart,options.otherEnd).map(a=>[a.id,a.metrics[field]])):null;
 const header=['recordType','asOf','timeZone','metric','metricPolicy','start','end','otherStart','otherEnd','visibleOffset','cohortCount','selectedCount','cohortTargetIds','selectedTargetIds','targetId','platform','label','dailyPart','dailyPartSha256','currentBaseline','currentEnd','currentBaselineAt','currentEndAt','comparisonBaseline','comparisonEnd','comparisonBaselineAt','comparisonEndAt','day','currentDate','currentNetChange','currentKnown','comparisonDate','comparisonNetChange','comparisonKnown','provenanceNote'];
 const policy=options.metric==='estimated'?'net-like-change-times-100-not-actual-views':'fixed-endpoint-cohort-net-change-null-not-zero';
 const common={asOf:fixed[0],timeZone:fixed[1],metric:options.metric??'followers',metricPolicy:policy};
 const out=row=>header.map(key=>row[key]??null);
 const rows=[header,out({...common,recordType:'metadata',start:options.start,end:options.end,otherStart:options.otherStart,otherEnd:options.otherEnd,visibleOffset:options.visibleOffset??0,cohortCount:series.cohortCount,selectedCount:series.totalCount,cohortTargetIds:JSON.stringify(series.cohortTargetIds),selectedTargetIds:JSON.stringify(selectedIds),provenanceNote:'metadata记录固定队列；cohort行记录各账号真实端点及公开日历史分区指纹；point行只对应本屏，缺测不补零'})];
 for(const account of [...accounts].filter(a=>cohort.has(a.id)).sort((a,b)=>a.id-b.id)){const part=sourcePart(manifest,account,'daily'),a=current.get(account.id),b=comparison?.get(account.id);rows.push(out({...common,recordType:'cohort',targetId:account.id,platform:account.platform,label:account.label,dailyPart:part.path,dailyPartSha256:part.sha256,currentBaseline:a.baseline,currentEnd:a.value,currentBaselineAt:a.baselineAt,currentEndAt:a.currentAt,comparisonBaseline:b?.baseline,comparisonEnd:b?.value,comparisonBaselineAt:b?.baselineAt,comparisonEndAt:b?.currentAt,provenanceNote:'公开分区指纹可回查逐日来源，非原平台逐点来源校验；指标原始采样时间未改为午夜'}));}
 for(const p of series.points)rows.push(out({...common,recordType:'point',day:p.day,currentDate:p.currentDate,currentNetChange:p.current,currentKnown:p.currentKnown,comparisonDate:p.comparisonDate,comparisonNetChange:p.comparison,comparisonKnown:p.comparisonKnown}));
 return rows;
}
