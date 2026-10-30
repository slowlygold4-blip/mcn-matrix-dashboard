import {projectCollectionPlatforms} from '@/lib/collection-platform-view.mjs';
type Row=Record<string,any>;
const names:Record<string,string>={douyin:'抖音',bilibili:'B站',xiaohongshu:'小红书',kuaishou:'快手',unknown:'未标注平台'};
const n=(value:number)=>value.toLocaleString('zh-CN');
/** Daily account counters and adjacent-day readiness are independent of rolling coverage. */
export function CollectionProfileDailyNotice({status}:{status:Row|null|undefined}){
 const {dailyProfiles}=projectCollectionPlatforms(status);
 if(!dailyProfiles)return <p className="collection-sampling-notice" data-state="unknown" role="status"><strong>当天粉丝与总获赞覆盖尚未上报</strong><span>近24小时更新不代表当天已采到。</span></p>;
 return <div className="collection-sampling-notice" data-state="profiles" aria-label="当天粉丝和总获赞采样覆盖"><strong>{dailyProfiles.date} · 当天账号观测</strong>
 {dailyProfiles.platforms.map((row:Row)=><span key={row.platform}>{names[row.platform]}：粉丝 {n(row.followers.observed)}/{n(row.accounts)}（{n(row.followers.comparable)} 可比） · 总获赞 {n(row.totalLikes.observed)}/{n(row.accounts)}（{n(row.totalLikes.comparable)} 可比）</span>)}
 <span>可比指本日与前一北京日均有有效末次观测。</span></div>;
}
/** Keep missing work observations visible even while diagnostics are closed. */
export function CollectionDailyNotice({status}:{status:Row|null|undefined}){
 const {daily}=projectCollectionPlatforms(status);
 if(!daily)return <p className="collection-sampling-notice" data-state="unknown" role="status"><strong>作品点赞采样状态尚未上报</strong><span>主页更新不代表作品指标已更新。</span></p>;
 const missing=daily.platforms.filter((row:Row)=>row.storedWorks>0&&row.observedWorks===0);
 if(missing.length)return <p className="collection-sampling-notice" data-state="missing" role="status"><strong>{daily.date} · {missing.map((row:Row)=>names[row.platform]).join('、')}尚无作品点赞观测</strong><span>单作品点赞日变化待采样；展开采集详情可查看各平台情况。</span></p>;
 const observed=daily.platforms.reduce((sum:number,row:Row)=>sum+row.observedWorks,0);
 if(!observed)return <p className="collection-sampling-notice" data-state="unknown" role="status"><strong>{daily.date} · 尚无已保存作品可核对点赞</strong><span>这不代表当日没有发布。</span></p>;
 const comparable=daily.comparability?.platforms.reduce((sum:number,row:Row)=>sum+row.comparableWorks,0);
 return <p className="collection-sampling-notice" data-state="observed" role="status"><strong>{daily.date} · 已保存 {n(observed)} 条作品点赞观测</strong><span>{comparable===undefined?'日变化可比情况尚未上报。':`${n(comparable)} 条可计算日变化。`}详情按平台分别核对，尚不代表完整采集。</span></p>;
}
/** Existing progress panel; source freshness is never pooled across platforms. */
export function CollectionPlatformSummary({status}:{status:Row|null|undefined}){
 const parsed=projectCollectionPlatforms(status);
 if(!parsed.rolling)return <p className="collection-feedback">分平台采样状态尚未上报，不能根据全站数字判断抖音是否已更新。</p>;
 return <div aria-label="按平台的采样覆盖"><p className="collection-caption">按平台核对 · 近24小时主页与作品列表分别统计</p>
 <div className="collection-more__grid">{parsed.rolling.map((row:Row)=>{
  const daily:Row|undefined=parsed.daily?.platforms.find((item:Row)=>item.platform===row.platform);
  const change:Row|undefined=parsed.daily?.comparability?.platforms.find((item:Row)=>item.platform===row.platform);
  const profile:Row|undefined=parsed.dailyProfiles?.platforms.find((item:Row)=>item.platform===row.platform);
  const missing=daily&&daily.storedWorks>0&&daily.observedWorks===0;
  return <div key={row.platform} data-platform={row.platform}><strong>{names[row.platform]}</strong>
   <p>主页更新 {n(row.profiles)}/{n(row.accounts)} · 作品列表完整 {n(row.worksComplete)}/{n(row.accounts)} · 有限 {n(row.worksLimited)}/{n(row.accounts)}</p>
   {profile?<><p>{parsed.dailyProfiles!.date} 粉丝观测 {n(profile.followers.observed)}/{n(profile.accounts)} · 日变化可比 {n(profile.followers.comparable)} · 缺前日基线 {n(profile.followers.missingBaseline)} · 当日末次冲突 {n(profile.followers.conflicting)}</p><p>当天总获赞观测 {n(profile.totalLikes.observed)}/{n(profile.accounts)} · 日变化可比 {n(profile.totalLikes.comparable)} · 缺前日基线 {n(profile.totalLikes.missingBaseline)} · 当日末次冲突 {n(profile.totalLikes.conflicting)}</p></>:<p>当天粉丝与总获赞覆盖尚未上报</p>}
   {daily?<p className={missing?'negative':''}>{parsed.daily!.date} 作品点赞观测 <b>{n(daily.observedWorks)}</b> / {n(daily.storedWorks)} 条已保存作品 · 涉及 {n(daily.observedAccounts)} 个账号档案{missing&&<strong> · 今日尚无作品点赞观测</strong>}</p>:<p>今日作品点赞观测尚未上报</p>}
   {change?<p>点赞日变化可计算 <b>{n(change.comparableWorks)}</b> 条 · 缺有效前日基线 {n(change.missingBaselineWorks)} 条 · 当日末次观测冲突 {n(change.conflictingWorks)} 条</p>:<p>点赞日变化的可比覆盖尚未上报</p>}
  </div>;
 })}</div><p className="collection-feedback">点赞观测为脚本保存记录的去重计数，不代表平台作品全集或独立来源核验。日变化只采用相邻北京日的有效末次点赞，缺基线或冲突不计为0。其他平台的成功不会计为抖音成功；0条观测不等于没有发布。</p>
 </div>;
}
