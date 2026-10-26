import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { number, validateDateRanges, chartSvg, csvCell, snapshotReadout, boardPulse, topicHistorySnapshotKey, verifiedTopicLatestMetrics } from '../public/product-dashboard.js';

test('CSV preserves numeric declines while neutralizing formulas in imported strings', () => {
  assert.equal(csvCell(-125.5), '"-125.5"');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell('=SUM(A1:A2)'), '"\'=SUM(A1:A2)"');
  assert.equal(csvCell('00123'), '"00123"');
  assert.equal(csvCell('a"b'), '"a""b"');
});

test('daily publication chart uses observed publish counts, not post inventory changes', () => {
  const html = chartSvg([{ date: '2025-01-01', publishedSamples: 3, postsDelta: -20 }], [], 'publishedSamples', 'delta');
  assert.match(html, /发布量（已收录）每日计数趋势/);
  assert.match(html, /发布量（已收录） 3/);
  assert.doesNotMatch(html, /-20/);
});

test('product numeric presentation preserves missing, zero and signed declines', () => {
  assert.equal(number(null), '—');
  assert.equal(number(undefined), '—');
  assert.equal(number(0), '0');
  assert.equal(number(-25, true), '-25');
  assert.equal(number(10000000), '10,000,000');
});
test('reading summary distinguishes an incomplete daily run from stale accounts and keeps missing deltas unknown', () => {
  const html = snapshotReadout({ enabledCount: 10, updatedCount: 0, staleCount: 10, metrics: {
    followers: { delta: null, gainedCount: null, lostCount: null, comparableCount: 0 },
    likes: { delta: null }, estimatedPlays: { delta: null },
  } }, '示例板块', { scheduledTargetCount: 10, scheduledCompletedTargetCount: 4 }, 'Asia/Shanghai');
  assert.match(html, /今日采集 4\/10，尚未完成/);
  assert.match(html, /尚无可比涨跌/);
  assert.match(html, /— 涨粉 · — 掉粉/);
  assert.match(html, /北京时间（Asia\/Shanghai）/);
});
test('reading summary distinguishes historical coverage from current freshness', () => {
  const html = snapshotReadout({ enabledCount: 10, updatedCount: 0, staleCount: 0, metrics: {
    followers: { delta: 120, gainedCount: 3, lostCount: 1, comparableCount: 8 },
    likes: { delta: 80 }, estimatedPlays: { delta: 8000 },
  } }, '历史板块', null, 'Asia/Shanghai');
  assert.match(html, /近36小时资料 0\/10/);
  assert.match(html, /历史可用/);
  assert.match(html, /当前区间有可比历史；等待下一次自动采集/);
});
test('board pulse reports unknown member changes as unknown rather than zero', () => {
  const html = boardPulse({ enabledCount: 3, metrics: { followers: { gainedCount: null, lostCount: null, comparableCount: 0 } } });
  assert.match(html, /↑ — 涨粉/);
  assert.match(html, /↓ — 掉粉/);
  assert.match(html, /0\/3 可比/);
});
test('product range inputs reject invalid, reversed, future and overly long selections', () => {
  assert.equal(validateDateRanges({ startDate: '2025-01-01', endDate: '2025-01-31', compare: true, comparisonStartDate: '2025-02-02', comparisonEndDate: '2025-02-28' }), '');
  for (const range of [{ startDate: '2025-02-30', endDate: '2025-03-01' }, { startDate: '2025-02-02', endDate: '2025-01-01' }, { startDate: '2099-01-01', endDate: '2099-01-31' }, { startDate: '2024-01-01', endDate: '2025-02-01' }, { startDate: '2025-01-01', endDate: '2025-01-02', compare: true }]) assert.notEqual(validateDateRanges(range), '');
});
test('daily chart breaks absent days, keeps true zeros and independent second-period positions', () => {
  const html = chartSvg([{ date: '2025-01-01', followers: 0 }, { date: '2025-01-02', followers: null }, { date: '2025-01-03', followers: 15 }], [{ date: '2025-02-01', followers: 4 }], 'followers');
  assert.match(html, /M[^L]+M/);
  assert.match(html, /第 1 天/);
  assert.match(html, /stroke-dasharray="7 5"/);
  assert.match(html, /粉丝数 0/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});
test('trend tooltips escape untrusted labels and daily changes show comparable account counts', () => {
  const html = chartSvg([{ date: '<img src=x onerror=alert(1)>', likesDelta: 2, likesObservedCount: 20, likesComparableCount: 5 }], [], 'likes', 'delta');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /5 个账号可比/);
  assert.match(chartSvg([{ date: '2025-01-01', followers: null }], [], 'followers'), /暂无/);
});

test('aggregate curves never draw false growth between different observed account sets', () => {
  const points = [{ date: '2025-01-01', followers: 100, followersCohortKey: 'a' }, { date: '2025-01-02', followers: 900, followersCohortKey: 'b' }, { date: '2025-01-03', followers: 950, followersCohortKey: 'b' }];
  const html = chartSvg(points, [], 'followers');
  const path = html.match(/<path d="([^"]+)"/)[1];
  assert.equal((path.match(/M/g) || []).length, 2);
  assert.equal((path.match(/L/g) || []).length, 1);
  assert.doesNotMatch(html, /<text[^>]*>-/, 'non-negative stock does not have a negative axis');
  assert.equal(validateDateRanges({ startDate: '2025-01-02', endDate: '2025-01-02' }, { today: '2025-01-01' }), '结束日期不能晚于今天。');
});
test('single workspace scope and exclusive real pages replace duplicate long dashboard sections', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.equal((html.match(/data-board-select/g) || []).length, 1);
  for (const id of ['overview', 'boards', 'targets', 'updates', 'reports', 'audit']) assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1);
  assert.match(html, /product-dashboard\.css/);
  assert.match(html, /account-detail\.css/);
});

test('topic panel exposes saved 7/30-day history without converting gaps to zero', () => {
  const source = readFileSync(new URL('../public/product-dashboard.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../public/product-dashboard.css', import.meta.url), 'utf8');
  assert.match(source, /\/api\/topics\/history\?days=.*startDate=/);
  assert.match(source, /data-topic-history-days="7"/);
  assert.match(source, /data-topic-history-days="30"/);
  assert.match(source, /缺口不补 0，也不跨缺口计算涨跌/);
  assert.match(source, /参与人数有值 \$\{number\(participantsObserved\)\}/);
  assert.match(source, /播放量有值 \$\{number\(viewsObserved\)\}/);
  assert.match(source, /部分指标缺失/);
  assert.match(source, /point\.qualityStatus === 'warning'/);
  assert.match(styles, /product-topic-history-status--warning, \.product-topic-history-status--partial/);
  assert.match(source, /verifiedTopicLatestMetrics\(historyTopic\)/);
  assert.doesNotMatch(source, /topic\.latestHashtagParticipants, topic\.latestHashtagParticipantsDelta/);
  assert.match(source, /sourceVerified !== true/);
  const rebuild = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8');
  assert.match(rebuild, /p\.sourceVerified === true/);
  assert.match(rebuild, /known\.sourceVerified === true/);
  assert.match(rebuild, /p\.sourceVerified !== true/);
});

test('topic summary accepts only verified latest-known platform metrics and preserves real zero', () => {
  const invalid = verifiedTopicLatestMetrics({ latestKnown: {
    participants: { value: 999999, delta: 10, sourceVerified: false, qualityStatus: 'unverified' },
    views: { value: 99999999, delta: 100, sourceVerified: true, qualityStatus: 'unverified' },
  } });
  assert.deepEqual(invalid, { participants: null, views: null });
  const valid = verifiedTopicLatestMetrics({ latestKnown: {
    participants: { value: 0, delta: -2, baselineDate: '2026-09-27', sourceVerified: true, qualityStatus: 'validated' },
    views: null,
  } });
  assert.equal(valid.participants.value, 0);
  assert.equal(valid.participants.delta, -2);
  assert.equal(valid.views, null);
  assert.deepEqual(verifiedTopicLatestMetrics(null), { participants: null, views: null });
});

test('topic cache identity changes when the latest or comparison sample quality changes', () => {
  const before = topicHistorySnapshotKey([{ id: 7, type: 'hashtag', latestHashtagQualityStatus: 'validated', previousHashtagQualityStatus: 'warning', latestHashtagParticipants: 10 }]);
  assert.notEqual(topicHistorySnapshotKey([{ id: 7, type: 'hashtag', latestHashtagQualityStatus: 'rejected', previousHashtagQualityStatus: 'warning', latestHashtagParticipants: null }]), before);
  assert.notEqual(topicHistorySnapshotKey([{ id: 7, type: 'hashtag', latestHashtagQualityStatus: 'validated', previousHashtagQualityStatus: 'rejected', latestHashtagParticipants: 10 }]), before);
});
