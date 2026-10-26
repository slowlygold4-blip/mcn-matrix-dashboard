import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  businessDateKey, businessTimeZoneLabel, formatBusinessTimestamp, resolveBusinessTimeZone,
} from '../public/business-time.js';

const applicationRoot = new URL('../', import.meta.url).href;
const asOfCopy = '截至所选区间结束已收录的作品才计入本期，之后才收录的不回填本期';

test('business time resolves an explicit server zone without falling back to the browser', () => {
  assert.equal(resolveBusinessTimeZone('Invalid/Zone', 'UTC'), 'UTC');
  assert.equal(resolveBusinessTimeZone(null, undefined, ''), 'Asia/Shanghai');
  assert.equal(businessTimeZoneLabel('Asia/Shanghai'), '北京时间（Asia/Shanghai）');
  assert.equal(businessTimeZoneLabel('UTC'), 'UTC');
  const original = new Date('2026-09-13T16:00:00Z');
  assert.equal(businessDateKey('2026-09-13T15:59:59Z', 'Asia/Shanghai'), '2026-09-13');
  assert.equal(businessDateKey(original, 'Asia/Shanghai'), '2026-09-14');
  assert.equal(businessDateKey(original, 'UTC'), '2026-09-13');
  assert.equal(original.toISOString(), '2026-09-13T16:00:00.000Z');
  assert.match(formatBusinessTimestamp('2026-09-14T02:00:00Z', { timeZone: 'Asia/Shanghai' }), /09\/14 10:00/);
  assert.equal(formatBusinessTimestamp(null), '尚未更新');
  assert.equal(formatBusinessTimestamp('invalid'), '时间无效');
  assert.equal(businessDateKey('invalid'), '');
});

// Each child models an independent browser's local time zone. Only in-memory DOM fixtures
// and imported renderers are exercised: no server, source requests, browser, or data writes.
async function renderInClientZone(rootUrl) {
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  const helpers = await import(new URL('public/business-time.js', rootUrl));
  const sharing = await import(new URL('public/access-sharing.js', rootUrl));
  const { createProductDashboard, validateDateRanges } = await import(new URL('public/product-dashboard.js', rootUrl));
  const { renderAccountDetail } = await import(new URL('public/account-detail.js', rootUrl));
  const instant = '2026-09-13T16:30:00Z';
  const NativeDate = Date;
  globalThis.Date = class FixedDate extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [instant])); }
    static now() { return NativeDate.parse(instant); }
  };
  const nodes = new Map();
  const listeners = new Map();
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, {
      id: selector.replace(/^#/, ''), innerHTML: '', textContent: '', hidden: false,
      setAttribute() {}, removeAttribute() {}, focus() {},
      insertAdjacentHTML(_position, html) { this.innerHTML += html; },
    });
    return nodes.get(selector);
  };
  const pages = ['overview', 'boards', 'targets', 'updates', 'reports', 'audit'].map((id) => node(`#${id}`));
  globalThis.document = {
    activeElement: null, querySelector: node, getElementById: (id) => node(`#${id}`),
    querySelectorAll: (selector) => selector === '[data-product-page]' ? pages : [],
    addEventListener: (type, handler) => listeners.set(type, handler),
  };
  globalThis.window = { addEventListener() {} };
  globalThis.location = new URL('http://127.0.0.1:4188/#targets');
  const metric = { value: 100, delta: 2, percent: 2, comparable: true, observedCount: 1, comparableCount: 1, currentAt: instant, baselineAt: '2026-09-12T16:30:00Z' };
  const metrics = Object.fromEntries(['followers', 'likes', 'posts', 'estimatedPlays'].map((key) => [key, { ...metric }]));
  const account = {
    id: 1, label: '时区测试作者', platform: 'douyin', publicId: '00123', enabled: true,
    metrics, status: { label: '监控中' }, boards: [], sources: [], trend: [],
    publishedSamples: { value: 2, asOf: instant, reason: '截至区间结束已收录，按实际发布时间计数' },
  };
  const payload = {
    timeZone: 'Asia/Shanghai', referenceAt: instant, boards: [], accounts: [account],
    summary: { enabledCount: 1, pausedCount: 0, inactiveCount: 0, metrics, trend: [] },
  };
  const scheduler = {
    timeZone: 'Asia/Shanghai', scheduleTime: '10:00', nextRunAt: '2026-09-14T02:00:00Z',
    scheduledTargetCount: 630, scheduledCompletedTargetCount: 455, scheduledInactiveTargetCount: 0,
    scheduledPendingTargetCount: 169, scheduledExhaustedTargetCount: 0, scheduledManualTargetCount: 6,
  };
  const bootstrap = {
    scheduler, auth: { permissions: { edit: true, administer: true } },
    authorSources: [{ title: '测试表', readAt: instant }],
    continuity: {
      timeZone: 'Asia/Shanghai', schedulerReady: true,
      latestPlan: { date: '2026-09-13', targetCount: 461, completedTargetCount: 455, inactiveTargetCount: 0, manualTargetCount: 6, retryTargetCount: 0, runCount: 2, denominatorComplete: true },
      freshness: { metrics: { followers: { latestAt: instant } } },
    },
  };
  const dashboard = createProductDashboard({ api: async () => payload });
  await dashboard.load({ bootstrap, force: true });
  const result = {
    feedback: node('#productFeedback').innerHTML,
    updates: node('#productUpdates').innerHTML,
    historicPlan: node('#productContinuitySummary').innerHTML,
    controls: node('#productControls').innerHTML,
    accounts: node('#targets').innerHTML,
    overview: node('#overview').innerHTML,
    detail: renderAccountDetail({ ...payload, account, period: 'day', recentWorks: [] }, { trendMetric: 'publishedSamples' }),
  };
  listeners.get('click')({ target: { closest: () => ({ dataset: { chartMetric: 'publishedSamples' }, hasAttribute: () => false }) } });
  result.publicationChart = node('#overview').innerHTML;
  const form = { elements: Object.fromEntries(['startDate', 'endDate', 'comparisonStartDate', 'comparisonEndDate'].map((key) => [key, { value: '' }])) };
  form.elements.startDate.value = '2026-03-08';
  form.elements.endDate.value = '2026-03-10';
  listeners.get('change')({ target: { name: 'compare', checked: true, form, closest: () => form } });
  result.comparisonDates = [form.elements.comparisonStartDate.value, form.elements.comparisonEndDate.value];
  result.invalidDate = validateDateRanges({ startDate: '2026-02-30', endDate: '2026-03-01' }, { today: '2026-09-14' });
  result.validToday = validateDateRanges({ startDate: '2026-09-14', endDate: '2026-09-14' });

  // Execute the app's actual formatting, day-key and settings renderer without its boot side effects.
  const appSource = readFileSync(new URL('public/app.js', rootUrl), 'utf8');
  const functionSource = ['businessTimeZone', 'formatDate', 'localDateKey', 'renderSystem'].map((name) => {
    const match = appSource.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`));
    if (!match) throw new Error(`App function missing: ${name}`);
    return match[0];
  }).join('\n');
  node('#settingsForm').scheduleTime = {};
  node('#settingsForm').viralLikeThreshold = {};
  node('#settingsForm').viralRelativeMultiplier = {};
  node('#settingsForm').publicPostsPerAccount = {};
  result.app = runInNewContext(`${functionSource}\nrenderSystem(); ({ formatted: formatDate(${JSON.stringify(instant)}), day: localDateKey(${JSON.stringify(instant)}), defaultDay: localDateKey(), footer: $('#footerStatus').textContent, settings: $('#settingsAutomationSummary').textContent, label: $('#settingsTimeZoneLabel').textContent });`, {
    ...helpers, ...sharing, Date, location: globalThis.location, state: { data: { scheduler, targets: [account], settings: {} } },
    $: node, renderAuthorQueueButton() {},
  });

  // If the server declares a different zone on refresh, reused data and controls must update.
  payload.timeZone = 'UTC';
  scheduler.timeZone = 'UTC';
  bootstrap.continuity.timeZone = 'UTC';
  await dashboard.load({ bootstrap, force: true });
  result.changedZone = { controls: node('#productControls').innerHTML, accounts: node('#targets').innerHTML, updates: node('#productUpdates').innerHTML };
  bootstrap.continuity.latestPlan.denominatorComplete = false;
  bootstrap.continuity.latestPlan.running = true;
  await dashboard.load({ bootstrap });
  result.runningPlan = node('#productContinuitySummary').innerHTML;
  bootstrap.continuity.latestPlan.running = false;
  await dashboard.load({ bootstrap });
  result.incompleteHistoricalPlan = node('#productContinuitySummary').innerHTML;
  return result;
}

for (const clientZone of ['America/Los_Angeles', 'UTC', 'Asia/Shanghai']) {
  test(`real frontend renderers use server Shanghai dates and 10:00 in client zone ${clientZone}`, () => {
    const script = `const result = await (${renderInClientZone.toString()})(${JSON.stringify(applicationRoot)}); process.stdout.write(JSON.stringify(result));`;
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, TZ: clientZone }, encoding: 'utf8', timeout: 10000,
    }));
    assert.equal(result.feedback, '', 'rendering completed without a swallowed load error');
    assert.match(result.updates, /下次更新 · 北京时间（Asia\/Shanghai）<\/span><strong>09\/14 10:00<\/strong>/);
    assert.doesNotMatch(result.updates, /洛杉矶|America\/Los_Angeles|<small>北京时间/);
    assert.match(result.updates, /上次读取 09\/14 00:30/);
    assert.match(result.controls, /name="startDate"[^>]+value="2026-09-14"/);
    assert.match(result.controls, /name="endDate"[^>]+value="2026-09-14"/);
    assert.match(result.controls, /日期按 北京时间（Asia\/Shanghai） 切日/);
    assert.match(result.accounts, /粉丝记录 09\/14 00:30/);
    assert.match(result.detail, /统计时区 Asia\/Shanghai/);
    assert.match(result.detail, /09\/14 00:30/);
    assert.match(result.app.formatted, /09\/14 00:30/);
    assert.equal(result.app.day, '2026-09-14');
    assert.equal(result.app.defaultDay, '2026-09-14');
    assert.match(result.app.footer, /每天 10:00 · 北京时间（Asia\/Shanghai）自动采集/);
    assert.match(result.app.footer, /本机后台/);
    assert.match(result.app.settings, /统计与定时时区：北京时间（Asia\/Shanghai）；下次 09\/14 10:00/);
    assert.match(result.app.label, /每天自动采集时间 · 北京时间/);
    assert.deepEqual(result.comparisonDates, ['2026-03-05', '2026-03-07'], 'preceding equal window is calendar arithmetic even at a DST boundary');
    assert.notEqual(result.invalidDate, '');
    assert.equal(result.validToday, '');
    for (const html of [result.overview, result.publicationChart, result.detail]) assert.ok(html.includes(asOfCopy));
    assert.match(result.updates, /今日当前名单 630：455 份自动指标、0 个注销复查、169 个待补采/);
    assert.match(result.updates, /6 条当时身份未通过记录，当前状态以账号详情为准/);
    assert.match(result.historicPlan, /最近日计划 2026-09-13（历史实际任务范围）/);
    assert.match(result.historicPlan, /455\/461/);
    assert.match(result.historicPlan, /0 个当时待补采/);
    assert.match(result.historicPlan, /当前名单进度见上方/);
    assert.match(result.runningPlan, /批次进行中，目标记录尚未齐/);
    assert.doesNotMatch(result.runningPlan, /历史分母记录不完整/);
    assert.match(result.runningPlan, /455\/461/);
    assert.match(result.incompleteHistoricalPlan, /历史分母记录不完整/);
    assert.doesNotMatch(result.incompleteHistoricalPlan, /批次进行中，目标记录尚未齐/);
    assert.match(result.incompleteHistoricalPlan, /455\/461/);
    assert.match(result.changedZone.controls, /日期按 UTC 切日/);
    assert.match(result.changedZone.controls, /name="startDate"[^>]+value="2026-09-13"/);
    assert.match(result.changedZone.accounts, /粉丝记录 09\/13 16:30/);
    assert.match(result.changedZone.updates, /下次更新 · UTC<\/span><strong>09\/14 02:00<\/strong><small>北京时间 09\/14 10:00/);
  });
}
