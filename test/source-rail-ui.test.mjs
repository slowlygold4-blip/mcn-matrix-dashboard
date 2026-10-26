import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chartSvg, number, validateDateRanges } from '../public/product-dashboard.js';

const root = new URL('../', import.meta.url);
const read = (name) => readFile(new URL(`public/${name}`, root), 'utf8');

test('collection provenance remains accessible in updates, audit and account detail after layout replacement', async () => {
  const [html, app, product, detail] = await Promise.all([
    read('index.html'), read('app.js'), read('product-dashboard.js'), read('account-detail.js'),
  ]);
  // Navigation labels are intentionally wrapped with icon/text spans in the
  // current shell; assert the route and visible label independently so this
  // contract does not depend on a particular inline markup shape.
  assert.match(html, /href="#updates"[^>]*>/);
  assert.match(html, /导入更新/);
  assert.match(html, /href="#audit">数据检查/);
  assert.match(html, /id="updates"[^>]*data-product-page/);
  assert.match(html, /id="audit"[^>]*data-product-page/);
  assert.match(product, /后台自动采集/);
  assert.match(product, /每日自动保存，网页无需常开/);
  assert.match(product, /下次更新 ·/);
  assert.match(product, /businessTimeZoneLabel\(schedulerZone\)/);
  assert.match(product, /dateText\(scheduler\.nextRunAt, schedulerZone\)/);
  for (const source of [product, app, html]) assert.doesNotMatch(source, /America\/Los_Angeles|洛杉矶/);
  assert.match(product, /历史数据|历史与数据完整性/);
  assert.match(product, /缺少点赞时估算播放也留空/);
  assert.match(product, /不会覆盖旧日数据，也不会回填并不存在的快照/);
  assert.match(product, /单账号补采不等于完成整批/);
  assert.match(product, /sourceCards\(bootstrap\.authorSources/);
  assert.match(product, /读取新版本后仍先预览，不直接覆盖/);
  assert.match(product, /飞书来源目前按所选工作表读取，不会静默读取其他工作表/);
  assert.match(detail, /查看名单来源/);
  assert.match(detail, /原表第\$\{source\.row\}行/);
  assert.match(detail, /查看计算依据与对比日期/);
  assert.match(detail, /currentAt/);
  assert.match(detail, /baselineAt/);
  assert.match(detail, /comparisonCurrentAt/);
  assert.match(html, /后台快照 · 网页仅阅读/);
  assert.match(html, /付费 API \/ 密钥/);
  assert.match(html, /不调用付费 API 或 AI/);
  assert.match(html, /不读取个人登录 Cookie/);
  assert.match(html, /每日统计不打开浏览器页面/);
  assert.match(html, /自动核验默认走匿名 HTTP、不启动浏览器/);
  assert.match(app, /renderAudit\(\); renderSystem\(\)/, '真实渲染链保留健康与定时信息，不依赖已移除的旧侧栏');
  assert.match(app, /网络连接暂时中断，请检查工作台服务是否运行，然后重试/);
  assert.match(app, /这是局域网备用地址，公网分享前请重新确认 HTTPS 入口/);
  assert.match(app, /publicEntry: accessData\.publicEntry/);
  assert.match(await read('access-sharing.js'), /配置公网 HTTPS 入口/);
  assert.match(app, /state\.access\?\.publicBaseUrl/);
});

test('audit keeps live health, anonymous source probes, coverage and backup evidence distinguishable', async () => {
  const [html, app, css] = await Promise.all([read('index.html'), read('app.js'), read('styles.css')]);
  for (const id of [
    'lastRunStatus', 'healthBatchStatus', 'healthScheduleStatus', 'healthRetryStatus',
    'healthProbeStatus', 'healthCollectionMode', 'healthNextRun', 'healthDataCutoff',
    'healthDatabaseStatus', 'healthDataQualityStatus', 'healthBackupStatus',
    'sourceProbeHistory', 'sourceProbeHistorySummary', 'runtimeAuditStatus', 'collectorProbeResult',
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /原始响应使用 SHA-256 生成校验指纹；异常数据只警告或拒绝，不覆写历史/);
  assert.match(html, /每日整批完成后，失败对象按退避自动补采/);
  assert.match(html, /查看最近来源探针/);
  assert.match(html, /重新运行本机自检/);
  assert.match(html, /class="health-link" id="lastRunError"/);
  assert.match(app, /同一作者可有多条记录，不等于未监控作者人数/);
  assert.match(app, /setAttribute\("aria-label", description\)/);
  assert.match(app, /function refreshBoardAutomation\(/);
  assert.match(app, /state\.boardAutomation/);
  assert.match(app, /activeRecentRuns\(\)/);
  assert.match(app, /function renderCollectorProbe\(/);
  assert.match(app, /function renderSavedCollectorProbe\(/);
  assert.match(app, /sourceProbeForPlatform/);
  assert.match(app, /sourceProbeStatusText/);
  assert.match(app, /probe\.durationMs/);
  assert.match(app, /probe\.trigger === "scheduled"/);
  assert.match(app, /probe\.trigger === "manual"/);
  assert.match(app, /renderSourceProbeHistory\(\)/);
  assert.match(app, /作品端点受当前风控限制；系统只保留历史，不把空响应写成 0/);
  assert.match(app, /无密钥、无个人登录、无持久浏览器会话/);
  assert.match(app, /上次自检/);
  assert.match(app, /自动备份可恢复/);
  assert.match(app, /scheduleState === "completed"/);
  assert.match(app, /scheduleState === "partial"/);
  assert.match(app, /scheduleState === "failed"/);
  assert.match(app, /健康面板按全量计划统计/);
  assert.match(app, /\$\{batchRun\.success_count\}\/\$\{batchRun\.target_count\} 成功/);
  assert.match(app, /\$\{limitedCount\} 范围 \/ \$\{retryCount\} 重试/);
  assert.match(app, /作品列表：\$\{formatNumber\(summary\.validatedTargetCount\)\} 完整 \/ \$\{formatNumber\(summary\.limitedTargetCount\)\} 范围 \/ \$\{formatNumber\(summary\.retryTargetCount\)\} 重试/);
  assert.match(html, /主页已保存/);
  assert.match(html, /数据范围提示/);
  assert.match(app, /达到重试上限/);
  assert.match(app, /全量计划尚未开始/);
  assert.match(app, /refreshRuntimeAudit\(/);
  assert.match(app, /\/api\/system-audit/);
  assert.match(app, /本机全链路自检通过/);
  assert.match(css, /\.collector-probe/);
  assert.match(css, /\.source-probe-history-summary/);
});

test('product methodology explicitly guards aggregation, proxy plays and missing history', async () => {
  const product = await read('product-dashboard.js');
  assert.match(product, /每项“可比人数”可能不同/);
  assert.match(product, /期内首次建档不代表完整期间增长/);
  assert.match(product, /历史缺失日不填 0/);
  assert.match(product, /暂停账号不进入当前汇总/);
  assert.match(product, /板块成员按当前归属回看历史，不代表历史时点的成员名单/);
  assert.match(product, /估算播放＝累计点赞 × 100/);
  assert.match(product, /估算播放变化＝点赞净变化 × 100，不是平台实测播放/);
  assert.match(product, /作品总数净变化可能受删除、隐藏影响/);
  assert.match(product, /发布样本数只计算已收录且有真实发布时间的作品，不冒充完整投稿数/);
  assert.match(product, /截至所选区间结束已收录的作品才计入本期，之后才收录的不回填本期/);
  assert.match(product, /恢复后补采不能还原从未采到的历史/);
  assert.match(product, /再次上传不会删除本次缺席的旧账号，不会自动恢复已暂停账号/);
  assert.match(product, /每日总量/);
  assert.match(product, /每日变化/);
  assert.match(product, /两段时间按第几天对齐/);
  assert.match(product, /comparisonStartDate/);
  assert.match(product, /comparisonEndDate/);
  assert.match(product, /\/api\/topics\/history\?days=/);
  assert.match(product, /缺口不补 0，也不跨缺口计算涨跌/);
  assert.match(product, /无官方值/);
});

test('four daily curves preserve gaps and distinct comparison data without invented values', () => {
  assert.equal(number(null), '—');
  assert.equal(number(undefined), '—');
  assert.equal(number(0), '0');
  for (const metric of ['followers', 'likes', 'estimatedPlays', 'posts']) {
    const primary = [
      { date: '2026-08-01', [metric]: 100, [`${metric}Delta`]: null },
      { date: '2026-08-02', [metric]: null, [`${metric}Delta`]: null },
      { date: '2026-08-03', [metric]: 130, [`${metric}Delta`]: -5 },
    ];
    const comparison = [{ date: '2026-07-01', [metric]: 200, [`${metric}Delta`]: 7 }];
    const html = chartSvg(primary, comparison, metric);
    assert.match(html, /2026-08-01/);
    assert.match(html, /2026-07-01/);
    assert.match(html, /按第几天对齐/);
    const paths = [...html.matchAll(/<path d="([^"]*)"/g)];
    assert.equal(paths.length, 2);
    assert.equal((paths[0][1].match(/M/g) || []).length, 2, '缺测日之后必须开始新的线段');
    assert.doesNotMatch(paths[0][1], /L/, '两个孤立观测不能连接为连续增长');
    assert.doesNotMatch(html, /NaN|Infinity/);
    assert.match(chartSvg(primary, comparison, metric, 'delta'), /-5/);
    assert.match(chartSvg([{ date: '2026-08-01', [metric]: null }], [], metric), /历史空白保留，不按 0 补齐/);
  }
});

test('custom ranges reject malformed, reversed, incomplete and oversized windows independently', () => {
  assert.equal(validateDateRanges({ startDate: '2026-01-01', endDate: '2026-01-31', compare: 'on', comparisonStartDate: '2025-12-01', comparisonEndDate: '2025-12-31' }), '');
  assert.match(validateDateRanges({ startDate: '2026-02-30', endDate: '2026-03-01' }), /有效/);
  assert.match(validateDateRanges({ startDate: '2026-02-02', endDate: '2026-02-01' }), /不能晚于/);
  assert.match(validateDateRanges({ startDate: '2026-01-01', endDate: '2026-01-31', compare: 'on', comparisonStartDate: '2025-12-01' }), /完整/);
  assert.match(validateDateRanges({ startDate: '2026-01-01', endDate: '2026-01-31', compare: 'on', comparisonStartDate: '2023-01-01', comparisonEndDate: '2025-01-01' }), /366/);
});
