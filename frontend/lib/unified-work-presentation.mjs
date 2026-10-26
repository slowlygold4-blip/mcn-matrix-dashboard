/** One work row can retain both the source table and the latest platform value. */
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
 const sourceValue=sourcePresent?known(work[sourceField])??(synthetic?known(work[metric]):null):null;
 const platformValue=platform?known(work[metric]):null;
 const mayBePlaceholder=metric==='plays'&&work.playsEvidence?.mayBePlaceholder===true;
 const platformObservedAt=platform?instant(work.lastObservedAt):null;
 // An undated observation cannot establish that it supersedes the table.
 // Keep undated platform-only history visible, with its missing time explicit.
 const usablePlatform=platformValue!==null&&!mayBePlaceholder&&(platformObservedAt!==null||sourceValue===null);
 const origin=usablePlatform?'platform':sourceValue!==null?'source':'unavailable';
 const value=origin==='platform'?platformValue:origin==='source'?sourceValue:null;
 const sourceRefreshedAt=sourcePresent?instant(work.sourceRefreshedAt):null;
 const note=metric==='plays'&&mayBePlaceholder
  ?'公开来源播放字段为 0，可能是占位；未将其当作实际播放。'
  :platformValue!==null&&!platformObservedAt?'平台指标未记录有效采样时间；有表格值时保留表格值，不将无日期记录认作最新。'
  :origin==='platform'&&metric==='plays'?work.playsEvidence?.note||'平台返回的播放字段，未独立核验为实际播放。'
  :origin==='source'?SOURCE_NOTE
  :null;
 return {value,origin,observedAt:origin==='platform'?platformObservedAt:null,
  sourceValue,sourceRefreshedAt,sourceNote:sourcePresent?SOURCE_NOTE:null,
  platformValue,platformObservedAt,platformUsable:usablePlatform,note};
}
