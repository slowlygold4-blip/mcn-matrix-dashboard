/** One work row can retain both the source table and the latest platform value. */
import {adoptWorkMetric} from './work-metric-adoption.mjs';
const known=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
const instant=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value?value:null;
const SOURCE_NOTE='表格累计值；表格刷新时间不是这项指标的采样时间，也不是发布日期当天增长。';

/**
 * A source cumulative counter and a platform observation describe the same
 * work. Never add them or describe their difference as daily growth.
 */
export function presentUnifiedWorkMetric(work,metric){
 if(!work||!['likes','plays'].includes(metric))throw Error('作品指标类型无效');
 const synthetic=typeof work.id==='string'&&/^creator-source:[1-9]\d*:[1-9]\d*$/.test(work.id);
 const platform=Number.isSafeInteger(work.id)&&work.id>0;
 if(!synthetic&&!platform||synthetic&&work.source==='platform-and-creator-source'||platform&&work.source==='creator-source')throw Error('作品来源与身份冲突');
 const sourcePresent=synthetic||work.source==='platform-and-creator-source';
 const sourceField=metric==='likes'?'sourceCumulativeLikes':'sourceCumulativePlays';
 const providedSourceValue=sourcePresent?known(work[sourceField])??(synthetic?known(work[metric]):null):null;
 const sourceClaimValue=known(work[metric==='likes'?'sourceClaimedCumulativeLikes':'sourceClaimedCumulativePlays']);
 const ownershipConflict=work.sourceOwnershipConflict===true,claimOnly=work.ownershipClaimOnly===true;
 const sourceValue=ownershipConflict?null:providedSourceValue;
 const platformValue=platform?known(work[metric]):null;
 const mayBePlaceholder=metric==='plays'&&work.playsEvidence?.mayBePlaceholder===true;
 const platformObservedAt=platform?instant(work.lastObservedAt):null;
 // An undated observation cannot establish that it supersedes the table.
 // Keep undated platform-only history visible, with its missing time explicit.
 let adopted=adoptWorkMetric({metric,sourceValue,platformValue,platformObservedAt,platformMayBePlaceholder:mayBePlaceholder,
  observations:work.sourceObservations||[],asOf:work.metricAsOf});
 if(claimOnly||ownershipConflict&&adopted.value===null&&sourceClaimValue!==null)adopted={...adopted,value:null,origin:'conflict',conflict:true,platformUsable:false};
 const {value,origin}=adopted,usablePlatform=adopted.platformUsable;
 const sourceRefreshedAt=sourcePresent?instant(work.sourceRefreshedAt):null;
 const note=claimOnly?'这条作品已核验为另一账号发布；保留原登记声明，不计入本作者的指标或每日发布数。'
  :ownershipConflict&&origin==='conflict'?'原登记作者与已核验发布者不同；累计值保留待核对，未用它替代缺失的有效指标。'
  :origin==='conflict'?'同一作品存在无法判定先后的不同数值，需核对后采用；未选取较大值。'
  :origin==='source-observation'?'采用同一作品最近有日期的观测；保留原表与平台记录，不重复累加。'
  :origin==='source-record'?'采用已保存的累计记录；提交时间不是指标采样时间，不能据此计算每日增长。'
  :metric==='plays'&&mayBePlaceholder
  ?'公开来源播放字段为 0，可能是占位；未将其当作实际播放。'
  :platformValue!==null&&!platformObservedAt?'平台指标未记录有效采样时间；有表格值时保留表格值，不将无日期记录认作最新。'
  :origin==='platform'&&metric==='plays'?work.playsEvidence?.note||'平台返回的播放字段，未独立核验为实际播放。'
  :origin==='source'?SOURCE_NOTE
  :null;
 return {value,origin,observedAt:adopted.observedAt,conflict:adopted.conflict,
  sourceObservationValue:adopted.sourceObservationValue,sourceObservedAt:adopted.sourceObservedAt,sourceRows:adopted.sourceRows,
  sourceRecordValue:adopted.sourceRecordValue,sourceRecordedAt:adopted.sourceRecordedAt,sourceRecordCount:adopted.sourceRecordCount,sourceTimeBasis:adopted.sourceTimeBasis,
  sourceValue,sourceClaimValue,sourceRefreshedAt,sourceNote:sourcePresent?SOURCE_NOTE:null,
  platformValue,platformObservedAt,platformUsable:usablePlatform,note};
}
