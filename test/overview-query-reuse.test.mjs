import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MonitorDatabase } from '../lib/database.mjs';

// Roster reuse compares observations from one business day, not fixed UTC
// instants that straddle midnight under a different supported service timezone.
const localAt = (value) => new Date(value).toISOString();
const NOW = new Date('2026-09-13T19:00:00');
const BOARD_A = '测试甲板块';
const BOARD_B = '测试乙板块';
const UNASSIGNED = '__unassigned__';
const BASELINE = localAt('2026-08-31T19:00:00');
const FIRST_TODAY = localAt('2026-09-13T15:00:00');
const LATEST_TODAY = localAt('2026-09-13T18:00:00');

function saveMetrics(database, target, runId, at, { followers, likes, postLikes = null, includePost = true, limited = false }) {
  database.saveCollection(target, runId, {
    capturedAt: at,
    snapshot: { followers, totalLikes: likes, totalPosts: 1 },
    posts: includePost ? [{
      externalId: `isolated-post-${target.id}`, authorId: `isolated-author-${target.id}`,
      authorName: target.label, caption: `隔离测试作品 ${target.id}`,
      publishedAt: localAt('2026-09-13T14:00:00'), likes: postLikes,
      comments: 2, shares: 1, url: `https://example.com/post/${target.id}`,
    }] : [],
    accountStatus: 'available', worksCoverage: limited ? 'limited' : 'complete',
    qualityStatus: limited ? 'warning' : 'validated', warnings: limited ? ['仅有最近公开作品范围'] : [],
    raw: { source: 'isolated-query-reuse-fixture', capturedAt: at, works: { aweme_list: [] } },
  });
}

function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const directory = mkdtempSync(join(tmpdir(), 'overview-query-reuse-'));
  const database = new MonitorDatabase(join(directory, 'test.sqlite'));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  const create = (key, boards) => database.createTarget({
    type: 'account', provider: 'manual', locator: `isolated-${key}`, label: key,
    boards, metadata: { platform: 'douyin' },
  });
  const targets = {
    shared: create('跨板块作者', [BOARD_A, BOARD_B]),
    alpha: create('甲板块掉粉作者', [BOARD_A]),
    beta: create('乙板块作者', [BOARD_B]),
    unassigned: create('未分板块缺失数据作者', []),
    paused: create('甲板块暂停作者', [BOARD_A]),
  };
  const values = {
    shared: [100, 125, 1000, 1050], alpha: [200, 180, 2000, 1980],
    beta: [500, 530, 5000, 5070], unassigned: [null, null, null, null],
    paused: [99900, 99999, 999000, 999999],
  };
  const runId = database.beginRun('scheduled', null, Object.keys(targets).length);
  for (const [key, target] of Object.entries(targets)) {
    const [baseFollowers, currentFollowers, baseLikes, currentLikes] = values[key];
    saveMetrics(database, target, runId, BASELINE, {
      followers: baseFollowers, likes: baseLikes, includePost: false,
    });
    saveMetrics(database, target, runId, FIRST_TODAY, {
      followers: baseFollowers, likes: baseLikes, postLikes: key === 'unassigned' ? null : 10,
    });
    saveMetrics(database, target, runId, LATEST_TODAY, {
      followers: currentFollowers, likes: currentLikes,
      postLikes: key === 'unassigned' ? null : 18, limited: key === 'beta',
    });
  }
  database.finishRun(runId, {
    status: 'success', successCount: 5, processedCount: 5,
    details: Object.values(targets).map((target) => ({
      targetId: target.id, status: 'validated', reviewState: 'complete',
      profileUsable: true, accountStatus: 'available', worksCoverage: 'complete',
    })),
  });
  database.updateTarget(targets.paused.id, { enabled: false });
  return { database, targets, runId };
}

function countedOverview(database, options = {}, { hasCompletedDay = true } = {}) {
  const originalList = database.listTargets;
  const originalReport = database.getReport;
  const rosters = [];
  const reports = [];
  database.listTargets = function listTargets(...args) {
    const result = originalList.apply(this, args);
    rosters.push({ args, result });
    return result;
  };
  database.getReport = function getReport(period, reference, reportOptions) {
    reports.push({ period, reference, options: reportOptions });
    return originalReport.call(this, period, reference, reportOptions);
  };
  try {
    const overview = database.getOverview(options);
    assert.equal(rosters.length, 1, 'one overview request must perform exactly one live roster read');
    assert.equal(reports.length, hasCompletedDay ? 4 : 3,
      'reuse applies to all generated reports, including a completed daily report when the active scope has one');
    if (hasCompletedDay) assert.ok(overview.reports.latestCompletedDay,
      'scheduled batch must not silently skip the fourth report');
    else assert.equal(overview.reports.latestCompletedDay, null,
      'a fully paused scope cannot invent an active completed daily report');
    for (const report of reports) {
      assert.strictEqual(report.options.scopedTargets, rosters[0].result,
        'each synchronous report receives the same request-scoped roster, not a copied or global roster');
      assert.equal(report.options.board, options.board?.trim() || '');
    }
    return { overview, roster: rosters[0].result };
  } finally {
    database.listTargets = originalList;
    database.getReport = originalReport;
  }
}

function businessMetrics(report) {
  return {
    period: report.period, start: report.start, end: report.end,
    selectedBoard: report.selectedBoard,
    // Compare every summary metric, including nulls, coverage denominators, negative changes and estimates.
    summary: report.summary,
    contributors: report.contributors.map((item) => ({
      targetId: item.targetId, followersDelta: item.followersDelta,
      accountLikesDelta: item.accountLikesDelta, estimatedPlaysDelta: item.estimatedPlaysDelta,
    })),
    viral: report.viral.slice(0, 6).map((post) => ({
      author_name: post.author_name, caption: post.caption, published_at: post.published_at,
      likes: post.likes, url: post.url,
    })),
  };
}

function assertIndependentReports(database, overview, board) {
  for (const [key, period] of [['day', 'day'], ['latestCompletedDay', 'day'], ['week', 'week'], ['month', 'month']]) {
    const compact = overview.reports[key];
    if (key === 'latestCompletedDay' && compact === null) continue;
    const independent = database.getReport(period, new Date(compact.end), { board });
    assert.deepEqual(businessMetrics(compact), businessMetrics(independent), `${key}: reusable roster must not change report semantics`);
  }
}

for (const scope of [null, BOARD_A, UNASSIGNED]) {
  test(`overview reads its roster once and matches independent reports for ${scope || 'all boards'}`, (t) => {
    const { database, targets } = fixture(t);
    const { overview } = countedOverview(database, { board: scope });
    assertIndependentReports(database, overview, scope);
    const expected = scope === BOARD_A ? [targets.shared.id, targets.alpha.id, targets.paused.id]
      : scope === UNASSIGNED ? [targets.unassigned.id] : Object.values(targets).map((target) => target.id);
    assert.deepEqual(overview.targets.map((target) => target.id).sort((a, b) => a - b), expected.sort((a, b) => a - b));
    assert.equal(overview.reports.day.summary.targetCount, scope === BOARD_A ? 2 : scope === UNASSIGNED ? 1 : 4);
    if (scope === UNASSIGNED) {
      assert.equal(overview.reports.day.summary.followersDelta, null);
      assert.equal(overview.reports.day.summary.accountLikesDelta, null);
      assert.equal(overview.reports.day.summary.estimatedPlaysDelta, null);
      assert.equal(overview.reports.day.summary.likesMissingPostCount, 1);
    }
    if (scope === BOARD_A) {
      assert.equal(overview.reports.day.summary.followersDelta, 5, 'positive and negative changes net without paused author');
      assert.equal(overview.reports.day.summary.accountLikesDelta, 30);
      assert.equal(overview.reports.day.summary.estimatedPlaysDelta, 3000);
    }
  });
}

test('request-scoped rosters do not leak between global, named and unassigned overview requests', (t) => {
  const { database, targets } = fixture(t);
  const all = countedOverview(database);
  const named = countedOverview(database, { board: BOARD_A });
  const unassigned = countedOverview(database, { board: UNASSIGNED });
  const other = countedOverview(database, { board: BOARD_B });
  assert.notStrictEqual(all.roster, named.roster);
  assert.notStrictEqual(named.roster, unassigned.roster);
  assert.notStrictEqual(unassigned.roster, other.roster);
  assert.deepEqual(unassigned.overview.targets.map((target) => target.id), [targets.unassigned.id]);
  assert.deepEqual(other.overview.targets.map((target) => target.id).sort((a, b) => a - b), [targets.shared.id, targets.beta.id]);
  assert.equal(all.overview.reports.day.summary.targetCount, 4, 'shared board membership counts once globally');
  assert.equal(other.overview.reports.day.summary.followersDelta, 55);
  assertIndependentReports(database, named.overview, BOARD_A);
  assertIndependentReports(database, unassigned.overview, UNASSIGNED);
  assertIndependentReports(database, other.overview, BOARD_B);
});

test('the next overview immediately reflects pause, resume and new snapshots without cross-request caching', (t) => {
  const { database, targets } = fixture(t);
  const first = countedOverview(database, { board: BOARD_A });
  database.updateTarget(targets.alpha.id, { enabled: false });
  const paused = countedOverview(database, { board: BOARD_A });
  assert.notStrictEqual(first.roster, paused.roster);
  assert.equal(first.overview.targets.find((target) => target.id === targets.alpha.id).enabled, true,
    'a later request cannot mutate an already returned response');
  assert.equal(paused.overview.targets.find((target) => target.id === targets.alpha.id).enabled, false);
  assert.equal(paused.overview.reports.day.summary.targetCount, 1);
  assert.equal(paused.overview.reports.day.summary.followersDelta, 25);
  assertIndependentReports(database, paused.overview, BOARD_A);
  assert.equal(countedOverview(database).overview.reports.day.summary.targetCount, 3);

  database.updateTarget(targets.alpha.id, { enabled: true });
  const resumed = countedOverview(database, { board: BOARD_A });
  assert.equal(resumed.overview.reports.day.summary.targetCount, 2);
  assert.equal(resumed.overview.reports.day.summary.followersDelta, 5);
  const newRun = database.beginRun('fixture', targets.alpha.id, 1);
  saveMetrics(database, database.getTarget(targets.alpha.id), newRun, NOW.toISOString(), {
    followers: 250, likes: 2150, postLikes: 45,
  });
  const refreshed = countedOverview(database, { board: BOARD_A });
  assert.notStrictEqual(refreshed.roster, resumed.roster);
  assert.equal(refreshed.overview.reports.day.summary.followersDelta, 75);
  assert.equal(refreshed.overview.reports.day.summary.accountLikesDelta, 200);
  assert.equal(refreshed.overview.reports.day.summary.estimatedPlaysDelta, 20000);
  assert.equal(refreshed.overview.reports.day.summary.snapshotCount, resumed.overview.reports.day.summary.snapshotCount + 1);
  assert.equal(refreshed.overview.targets.find((target) => target.id === targets.alpha.id).last_checked_at, NOW.toISOString());
  assert.equal(resumed.overview.reports.day.summary.followersDelta, 5);
  assertIndependentReports(database, refreshed.overview, BOARD_A);

  database.updateTarget(targets.unassigned.id, { enabled: false });
  const empty = countedOverview(database, { board: UNASSIGNED }, { hasCompletedDay: false });
  assert.equal(empty.overview.reports.day.summary.targetCount, 0);
  assert.equal(empty.overview.reports.day.summary.followersDelta, null);
  assert.equal(empty.overview.reports.day.summary.postCount, 0);
  assertIndependentReports(database, empty.overview, UNASSIGNED);
});
