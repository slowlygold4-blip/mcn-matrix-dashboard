"use client";

import {useState, type ReactNode} from "react";
import {ChangeIndicator} from "@/components/change-indicator";
import {Button} from "./ui/button";
import {accountCoverage} from "@/lib/replica-coverage.mjs";

type Metric = {delta: number | null; comparableCount?: number};
type MetricKey = "followers" | "likes" | "posts";
type Props = {
  compact?:boolean;
  selectedMetric?:MetricKey;
  onMetricChange?:(key:MetricKey)=>void;
  metrics: Record<string, Metric>;
  accountCount: number;
  accounts: Record<string, any>[];
  asOf: string;
  rosterTotal?: number | null;
  scopeLabel?: string;
  start: string;
  end: string;
  ready: boolean;
  status?: string;
  onOpenAccounts: () => void;
  trendPreview?: ReactNode | ((metric: MetricKey) => ReactNode);
  trend: ReactNode;
};

const formatChange = (value: number | null | undefined) =>
  value == null ? "—" : `${value > 0 ? "+" : ""}${value.toLocaleString("zh-CN")}`;

export function OverviewAccountPreview({compact=false,selectedMetric,onMetricChange,metrics, accountCount, accounts, asOf, rosterTotal, scopeLabel, start, end, ready, status, onOpenAccounts, trendPreview, trend}: Props) {
  const [trendOpen, setTrendOpen] = useState(false);
  const [localMetric, setLocalMetric] = useState<MetricKey>("followers");
  const activeMetric=selectedMetric??localMetric,setActiveMetric=onMetricChange??setLocalMetric;
  const observations = accounts.map(account => accountCoverage(account, asOf, Date.parse(asOf)));
  const latestProfile = observations.map(row => row.profileObservedAt).filter((value): value is string => !!value).sort().at(-1) ?? null;
  const observedTime = (value: string | null) => value
    ? new Date(value).toLocaleString("zh-CN", {timeZone: "Asia/Shanghai", hour12: false})
    : "暂无有效采样";
  const profileFresh = observations.filter(row => row.profileFresh).length;
  const worksComplete = observations.filter(row => row.worksComplete).length;
  const worksLimited = observations.filter(row => row.worksLimited).length;
  const comparableFollowers = metrics.followers?.comparableCount;
  const cards = [
    ["followers", "粉丝净变化"],
    ["likes", "主页获赞净变化"],
    ["posts", "作品存量净变化"],
  ] as const;

  if(compact)return <section id="matrix-daily" className="overview-account-preview panel" aria-label="每日变化趋势"><div className="panel-head"><div><p className="eyebrow">从区间到每一天</p><h2>每日{cards.find(([key])=>key===activeMetric)?.[1]}趋势</h2></div><Button variant="outline" onClick={onOpenAccounts}>查看账号明细 →</Button></div><p className="meta">{start} → {end} · 最近有效采样 {observedTime(latestProfile)}（北京时间）</p>
   {!ready?<p role="status">{status||'正在核对日期范围…'}</p>:<>{typeof trendPreview==='function'?trendPreview(activeMetric):trendPreview}<details className="overview-account-preview__trend" onToggle={e=>setTrendOpen(e.currentTarget.open)}><summary>展开完整曲线、日期对比与逐日数值</summary>{trendOpen&&trend}</details></>}
   <details className="overview-account-preview__method"><summary>查看样本覆盖与数据口径</summary><p>近 8 小时主页可用 {profileFresh}/{accountCount} · 作品完整 {worksComplete}/{accountCount} · 作品有限 {worksLimited}/{accountCount}。缺测不补零，不混算不同账号的起止值。</p></details>
  </section>;
  return <section id="matrix-daily" className="overview-account-preview panel" aria-label="有每日采样账号的变化">
    <div className="panel-head">
      <div><p className="eyebrow">矩阵持续更新</p><h2>有每日采样账号的变化</h2></div>
      <Button variant="outline" onClick={onOpenAccounts}>查看账号和已保存作品 →</Button>
    </div>
    <div className="overview-account-preview__scope" aria-label="监控采样与数据截止">
      <strong>已保存的每日采样</strong>
      <span>最近有效主页采样：{observedTime(latestProfile)}（北京时间）</span>
      <span>公开数据截至：{observedTime(asOf)}（北京时间）</span>
    </div>
    <p className="meta overview-account-preview__summary">该发布截面近 8 小时：主页三指标 {profileFresh}/{accountCount}；作品列表完整核验 {worksComplete}/{accountCount}；作品列表有限观察 {worksLimited}/{accountCount}。三种覆盖分开统计；未取得不当作零。</p>
    <div className="overview-account-preview__scope" aria-label="名册和可比快照的不同口径">
      <strong>已整合资料</strong>
      <span>团团作者名册 {rosterTotal == null ? '核对中' : rosterTotal.toLocaleString("zh-CN") + ' 位'}（含仅表格作者）</span>
      <span>当前筛选 {accountCount.toLocaleString("zh-CN")} 个启用监控账号；粉丝起止可比 {Number.isSafeInteger(comparableFollowers) ? comparableFollowers + '/' + accountCount : '待核'} 个</span>
    </div>
    {scopeLabel && <p className="overview-account-preview__scope"><strong>当前账号变化范围</strong><span>{scopeLabel}</span></p>}
    <p className="meta overview-account-preview__summary">主页真实快照 · 只比较起止两天都有数据的账号。</p>
    <details className="overview-account-preview__method"><summary>口径与缺测说明</summary><p>同一作者与作品保留一条记录；本区比较有起止快照账号的期间变化，其余已知资料仍保留在名册和作品记录中。缺测不补零。</p></details>
    {!ready ? <p className="notice" role="status">{status || "当前范围的区间变化正在核对；已整合资料仍可查看。"}</p> : <>
      <p className="overview-account-preview__period">{start} → {end} · 已选 {accountCount.toLocaleString("zh-CN")} 个启用账号</p>
      <div className="overview-account-preview__grid" role="group" aria-label="选择每日曲线指标">
        {cards.map(([key, label]) => {
          const metric = metrics[key];
          const comparable = metric?.comparableCount;
          const coverage = typeof comparable === 'number' && Number.isSafeInteger(comparable) && comparable >= 0 && comparable <= accountCount;
          const coverageText = coverage ? `${comparable.toLocaleString("zh-CN")}/${accountCount.toLocaleString("zh-CN")} 个账号可比${accountCount ? `（${(comparable / accountCount * 100).toFixed(1)}%）` : ''}` : '两端可比账号数待核';
          return <button key={key} type="button" className="overview-account-preview__card" data-metric={key} data-active={activeMetric === key} aria-pressed={activeMetric === key} aria-controls={typeof trendPreview === "function" ? "overview-trend-preview" : undefined} onClick={() => setActiveMetric(key)}>
            {key === "followers" && <div className="dashboard-orbits" data-dashboard-orbit-active={activeMetric === "followers"} aria-hidden="true"><span/><span/></div>}
            <span className="overview-account-preview__mode" aria-hidden="true">{activeMetric === key ? "当前曲线" : "查看曲线"}</span>
            <small>{label} · 仅限可比账号</small>
            <strong className={metric?.delta != null && metric.delta < 0 ? "negative" : metric?.delta != null && metric.delta > 0 ? "positive" : ""}>{formatChange(metric?.delta)}</strong>
            <ChangeIndicator value={metric?.delta}/>
            <span className="overview-account-preview__coverage">{coverageText}</span>
          </button>;
        })}
      </div>
      {typeof trendPreview === "function" ? trendPreview(activeMetric) : trendPreview}
      <details className="overview-account-preview__trend" onToggle={event => setTrendOpen(event.currentTarget.open)}>
        <summary>展开每日曲线与区间对比</summary>
        {trendOpen && trend}
      </details>
    </>}
  </section>;
}
