import {presentUnifiedWorkMetric} from '@/lib/unified-work-presentation.mjs';

type Work=Record<string,unknown>;
type Metric='likes'|'plays';

const number=(value:number|null)=>value===null?'—':value.toLocaleString('zh-CN');
const beijing=(value:string|null)=>value?new Date(value).toLocaleString('zh-CN',{
 timeZone:'Asia/Shanghai',hour12:false,
}):'未记录';

/** One adopted value per work; the other source is provenance, never an addend. */
export function UnifiedWorkMetric({work,metric}:{work:Work;metric:Metric}){
 const value=presentUnifiedWorkMetric(work,metric);
 const label=metric==='plays'?'播放字段':'点赞';
 const origin=value.origin==='platform'?'平台已存观测':value.origin==='source-observation'?'有采样日期的已存观测':value.origin==='source-record'?'累计记录（采样时间未记录）':value.origin==='source'?'原始累计记录':value.origin==='conflict'?'记录冲突待核对':'暂无可用值';
 return <div className="unified-work-metric" data-metric={metric} data-origin={value.origin}>
  <strong className="unified-work-metric-value">{number(value.value)}</strong>
  {value.observedAt&&<small>{beijing(value.observedAt)} 更新</small>}
  <details>
   <summary>查看{label}口径与来源</summary>
   <div className="unified-work-metric-evidence"><p>采用记录：{origin}</p>
    <p>平台{label}：{number(value.platformValue)}{value.platformValue!==null&&!value.platformUsable?'（未采用）':''}{value.platformObservedAt?` · ${value.platformValue!==null&&value.platformUsable?'指标采样':'作品记录'} ${beijing(value.platformObservedAt)}（北京）`:''}</p>
    <p>原表{label}累计：{number(value.sourceValue)}{value.sourceRefreshedAt?` · 表格版本刷新 ${beijing(value.sourceRefreshedAt)}（北京）`:''}</p>
    {value.sourceObservedAt&&<p>有日期的已存{label}：{number(value.sourceObservationValue)} · 指标采样 {beijing(value.sourceObservedAt)}（北京）{value.sourceRows.length?` · 来源行 ${value.sourceRows.join('、')}`:''}</p>}
    {value.sourceRecordCount>0&&<p>提交记录{label}：{number(value.sourceRecordValue)}{value.sourceRecordedAt?` · ${value.sourceTimeBasis==='submission-time'?'提交':'原记录'}时间 ${beijing(value.sourceRecordedAt)}（北京）`:''}；该时间不是指标采样时间，未据此覆盖有效观测。</p>}
    {value.sourceNote&&value.sourceNote!==value.note&&<small>{value.sourceNote}</small>}
    {value.note&&<small>{value.note}</small>}
    {metric==='plays'&&<small>播放字段未经独立核验为实际播放量。</small>}
   </div>
  </details>
 </div>;
}
