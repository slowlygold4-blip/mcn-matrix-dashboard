import {projectCollectionPlatforms} from '@/lib/collection-platform-view.mjs';
type Row=Record<string,any>;
const names:Record<string,string>={douyin:'抖音',bilibili:'B站',xiaohongshu:'小红书',kuaishou:'快手',unknown:'未标注平台'};
const n=(value:number)=>value.toLocaleString('zh-CN');
/** Existing progress panel; source freshness is never pooled across platforms. */
export function CollectionPlatformSummary({status}:{status:Row|null|undefined}){
 const parsed=projectCollectionPlatforms(status);
 if(!parsed.rolling)return <p className="collection-feedback">分平台采样状态尚未上报，不能根据全站数字判断抖音是否已更新。</p>;
 return <div aria-label="按平台的采样覆盖"><p className="collection-caption">按平台核对 · 近24小时主页与作品列表分别统计</p>
 <div className="collection-more__grid">{parsed.rolling.map((row:Row)=>{
  const daily:Row|undefined=parsed.daily?.platforms.find((item:Row)=>item.platform===row.platform);
  const change:Row|undefined=parsed.daily?.comparability?.platforms.find((item:Row)=>item.platform===row.platform);
  const missing=daily&&daily.storedWorks>0&&daily.observedWorks===0;
  return <div key={row.platform} data-platform={row.platform}><strong>{names[row.platform]}</strong>
   <p>主页更新 {n(row.profiles)}/{n(row.accounts)} · 作品列表完整 {n(row.worksComplete)}/{n(row.accounts)} · 有限 {n(row.worksLimited)}/{n(row.accounts)}</p>
   {daily?<p className={missing?'negative':''}>{parsed.daily!.date} 作品点赞观测 <b>{n(daily.observedWorks)}</b> / {n(daily.storedWorks)} 条已保存作品 · 涉及 {n(daily.observedAccounts)} 个账号档案{missing&&<strong> · 今日尚无作品点赞观测</strong>}</p>:<p>今日作品点赞观测尚未上报</p>}
   {change?<p>点赞日变化可计算 <b>{n(change.comparableWorks)}</b> 条 · 缺有效前日基线 {n(change.missingBaselineWorks)} 条 · 当日末次观测冲突 {n(change.conflictingWorks)} 条</p>:<p>点赞日变化的可比覆盖尚未上报</p>}
  </div>;
 })}</div><p className="collection-feedback">点赞观测为脚本保存记录的去重计数，不代表平台作品全集或独立来源核验。日变化只采用相邻北京日的有效末次点赞，缺基线或冲突不计为0。其他平台的成功不会计为抖音成功；0条观测不等于没有发布。</p>
 </div>;
}
