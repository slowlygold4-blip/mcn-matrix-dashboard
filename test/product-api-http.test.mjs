import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitorDatabase } from '../lib/database.mjs';
import { checksum } from '../lib/utils.mjs';

test('product read APIs expose real dated metrics, validate dates, preserve data and respect viewer permissions', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'product-api-'));
  process.env.DATA_DIR = dir;
  const db = new MonitorDatabase(join(dir, 'douyin-monitor.sqlite'));
  const target = db.createTarget({ type: 'account', label: '隔离验收作者', locator: 'MS4wLjABAAAAPRODUCTAPITESTabcdefghijklmn', provider: 'public-web', metadata: { platform: 'douyin' } });
  db.db.prepare('UPDATE targets SET created_at = ? WHERE id = ?').run('2024-12-31T00:00:00.000Z', target.id);
  const topic = db.createTarget({ type: 'hashtag', label: '#验收话题', locator: '#验收话题', provider: 'public-web' });
  db.assignTargetsToBoard([target.id], '验收板块');
  db.db.prepare('UPDATE target_boards SET created_at = ? WHERE target_id = ?').run('2024-12-31T00:00:00.000Z', target.id);
  for (const [date, followers, likes, posts] of [['2025-01-01', 100, 1000, 10], ['2025-01-02', 90, 1200, 12], ['2025-02-01', 50, 500, 4], ['2025-02-02', 70, 700, 3]]) {
    const capturedAt = new Date(`${date}T12:00:00+08:00`).toISOString();
    const raw = { capturedAt, profile: { user: { sec_uid: target.locator, uid: '222523170759696',
      follower_count: followers, total_favorited: likes, aweme_count: posts } }, aweme_list: [] };
    db.db.prepare("INSERT INTO snapshots(target_id,captured_at,followers,total_likes,total_posts,quality_status,account_status,works_coverage,source_checksum,raw_json) VALUES(?,?,?,?,?,'validated','available','complete',?,?)")
      .run(target.id, capturedAt, followers, likes, posts, checksum(raw), JSON.stringify(raw));
  }
  const insertTopicObservation = (date, participants, views, qualityStatus) => {
    const capturedAt = new Date(`${date}T12:00:00Z`).toISOString();
    const runId = db.beginRun('scheduled', topic.id, 1);
    db.db.prepare('UPDATE runs SET started_at=? WHERE id=?').run(new Date(Date.parse(capturedAt) - 60_000).toISOString(), runId);
    const name = topic.locator.replace(/^#/, '');
    const raw = { scope: 'douyin-official-challenge-detail', businessStatusCode: 0, challengeId: '7684603502',
      label: name, officialName: name, participants, views, capturedAt,
      provenance: { mode: 'douyin-official-anonymous-challenge-detail',
        endpoint: 'https://www.douyin.com/aweme/v1/web/challenge/detail/', authenticated: false, runtimeAI: false, paidAPI: false } };
    const sourceChecksum = checksum(raw);
    db.db.prepare(`INSERT INTO snapshots(target_id,captured_at,hashtag_participants,hashtag_views,quality_status,
      account_status,works_coverage,source_checksum,raw_json,warnings_json)
      VALUES(?,?,?,?,?,'unknown','not-applicable',?,?,'[]')`).run(topic.id, capturedAt, participants, views, qualityStatus, sourceChecksum, JSON.stringify(raw));
    db.db.prepare(`INSERT INTO audits(target_id,run_id,created_at,provider,status,source_checksum,message)
      VALUES(?,?,?,'public-web',?,?,?)`).run(topic.id, runId, new Date(Date.parse(capturedAt) + 1000).toISOString(), qualityStatus, sourceChecksum, 'topic fixture');
    db.finishRun(runId, { status: 'success', successCount: 1, processedCount: 1 });
  };
  insertTopicObservation('2025-01-01', 20, 500, 'validated');
  insertTopicObservation('2025-01-02', 25, 800, 'validated');
  insertTopicObservation('2025-01-03', 30, null, 'warning');
  const { server } = await import('../server.mjs');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); db.close(); await rm(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const auth = await fetch(`${origin}/api/auth/session`);
  const owner = await auth.json();
  const cookie = auth.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const request = (path) => fetch(`${origin}${path}`, { headers: { Cookie: cookie } });
  const query = 'period=custom&startDate=2025-01-02&endDate=2025-01-02&comparisonStartDate=2025-02-02&comparisonEndDate=2025-02-02';
  const response = await request(`/api/insights?${query}&board=${encodeURIComponent('验收板块')}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('vary'), 'Accept-Encoding');
  assert.equal(response.headers.get('content-encoding'), 'gzip', 'large JSON responses should be compressed for remote team access');
  const data = await response.json();
  assert.equal(data.summary.metrics.followers.delta, -10);
  assert.equal(data.comparison.summary.metrics.followers.delta, 20);
  assert.equal(data.summary.metrics.estimatedPlays.delta, 20000);
  assert.equal(data.comparison.summary.metrics.posts.delta, -1);
  assert.ok(Array.isArray(data.comparison.accounts), 'existing full comparison API remains backward compatible');
  const projected = await request(`/api/rebuild/insights?${query}&board=${encodeURIComponent('验收板块')}&comparisonProjection=summary`);
  assert.equal(projected.status, 200);
  const projectedData = await projected.json();
  assert.deepEqual(projectedData.comparison.summary, data.comparison.summary, 'summary projection must not change historical B metrics');
  assert.deepEqual(projectedData.comparison.range, data.comparison.range);
  assert.equal(Object.hasOwn(projectedData.comparison, 'accounts'), false, 'overview opt-in omits only unused B accounts');
  assert.deepEqual(projectedData.accounts, data.accounts, 'A account list is never narrowed by the comparison projection');
  assert.equal((await request(`/api/rebuild/insights?${query}&comparisonProjection=accounts`)).status, 400);
  assert.equal((await request(`/api/rebuild/insights?${query}&comparisonProjection=`)).status, 400);
  const fixedDay = await request('/api/rebuild/insights?period=day&startDate=2025-01-02&endDate=2025-01-02');
  assert.equal(fixedDay.status, 200);
  const fixedDayData = await fixedDay.json();
  assert.equal(fixedDayData.period, 'day');
  assert.equal(fixedDayData.scopeBasis.targetCreated, 'period-end');
  assert.equal(fixedDayData.scopeBasis.boardMembershipRemoval, 'not-historized');
  assert.equal(fixedDayData.scopeBasis.boardCatalog, 'current-catalog');
  assert.equal(fixedDayData.scopeBasis.targetCreated, 'period-end');
  assert.equal(fixedDayData.scopeBasis.boardMembershipRemoval, 'not-historized');
  assert.equal(fixedDayData.accounts[0].metrics.followers.dailyComparable, true);
  assert.equal(fixedDayData.summary.metrics.followers.delta, -10);
  assert.equal(fixedDayData.summary.trend.length, 30);
  assert.equal(fixedDayData.summary.trend.at(-1).date, '2025-01-02');
  const multiDay = await request('/api/rebuild/insights?period=day&startDate=2025-01-01&endDate=2025-01-02');
  assert.equal((await multiDay.json()).period, 'custom', 'a multi-day interval must not claim daily semantics');
  const datedReport = await request('/api/reports/day?date=2025-01-02');
  assert.equal(datedReport.status, 200);
  assert.equal((await datedReport.json()).summary.followersComparableTargetCount, 1,
    'date-only report references must include the complete Beijing calendar date');
  const detail = await request(`/api/accounts/${target.id}/insights?${query}`);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).account.id, target.id);
  const topicHistory = await request('/api/topics/history?startDate=2025-01-01&endDate=2025-01-03');
  assert.equal(topicHistory.status, 200);
  const topicHistoryData = await topicHistory.json();
  assert.equal(topicHistoryData.timeZone, 'Asia/Shanghai');
  assert.deepEqual(topicHistoryData.topics.map((item) => item.label), ['#验收话题']);
  assert.equal(topicHistoryData.topics[0].points[1].participantsDelta, 5);
  assert.equal(topicHistoryData.topics[0].points[1].sourceVerified, true);
  assert.equal(topicHistoryData.topics[0].participantsObservedCount, 3);
  assert.equal(topicHistoryData.topics[0].viewsObservedCount, 2);
  assert.equal(topicHistoryData.topics[0].points[2].qualityStatus, 'warning');
  const targetRead = await (await request('/api/targets')).json();
  const topicTarget = targetRead.targets.find((item) => item.id === topic.id);
  assert.equal(topicTarget.topicMetricsReadSource, 'verified-history-only');
  assert.equal(topicTarget.latestHashtagQualityStatus, 'unverified');
  assert.equal(topicTarget.latestHashtagParticipants, null);
  assert.equal(topicTarget.latestHashtagViews, null,
    'generic target/bootstrap projection must not expose counters outside the verified history boundary');
  assert.equal((await request('/api/accounts/99999999/insights')).status, 404);
  for (const suffix of ['period=bad', 'period=custom', 'period=custom&startDate=2025-02-30&endDate=2025-03-01', 'startDate=2025-01-03&endDate=2025-01-02', 'startDate=2024-01-01&endDate=2025-12-31', 'comparisonStartDate=2025-01-01', 'endDate=2099-01-01&startDate=2025-01-01']) assert.equal((await request(`/api/insights?${suffix}`)).status, 400, suffix);
  const continuity = await request('/api/continuity');
  assert.equal(continuity.status, 200);
  assert.deepEqual((await continuity.json()).authorSources, []);
  const monitoring = await request('/api/monitoring-status');
  assert.equal(monitoring.status, 200);
  const monitoringData = await monitoring.json();
  assert.equal(monitoringData.scheduler.scheduleMode, 'continuous');
  assert.equal(monitoringData.scheduler.scheduleIntervalHours, null);
  assert.deepEqual(monitoringData.browserLane, {
    busy: false, locked: false, reason: null, lockedAt: null, recoveryEligible: false, lastRecoveredAt: null,
  }, 'monitoring exposes lifecycle health without leaking process identifiers or claiming data coverage');
  assert.deepEqual(monitoringData.scheduler.slotTimes, []);
  assert.equal(monitoringData.scheduler.nextRunAt, null, 'continuous mode must not report an invented scheduled slot');
  assert.ok(Object.hasOwn(monitoringData.scheduler, 'scheduledTopicTargetCount'),
    'the async monitoring endpoint must preserve the enabled-topic denominator field');
  assert.ok(Object.hasOwn(monitoringData.scheduler, 'scheduledTopicMetricCompletedTargetCount'),
    'the async monitoring endpoint must preserve the two-metric topic completion field');
  assert.deepEqual(Object.keys(monitoringData.ingestionReview).filter(key => key.endsWith('RunIds')), [],
    'viewer status should expose review counts without enumerating run IDs');
  const emptyReview = await request('/api/ingestion-reviews');
  assert.equal(emptyReview.status, 200);
  assert.equal((await emptyReview.json()).status, 'empty');
  assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM snapshots').get().count, 7, 'read endpoints must not fabricate snapshots');
  const invitation = await fetch(`${origin}/api/access/invites`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': owner.csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'viewer', hours: 1, maxUses: 1, label: '隔离验收' }) });
  assert.equal(invitation.status, 201);
  const invited = await invitation.json();
  const joined = await fetch(`${origin}/api/auth/join`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: invited.code, displayName: '只读验收者' }) });
  assert.equal(joined.status, 200);
  const viewer = await joined.json();
  const viewerCookie = joined.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  assert.equal((await fetch(`${origin}/api/insights?${query}`, { headers: { Cookie: viewerCookie } })).status, 200);
  const blocked = await fetch(`${origin}/api/boards`, { method: 'POST', headers: { Cookie: viewerCookie, Origin: origin, 'X-CSRF-Token': viewer.csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '不应创建' }) });
  assert.equal(blocked.status, 403);
  assert.equal((await fetch(`${origin}/api/ingestion-reviews`, { headers: { Cookie: viewerCookie } })).status, 403);
  assert.equal((await fetch(`${origin}/api/ingestion-reviews?order=newest&limit=0`, { headers: { Cookie: viewerCookie } })).status, 403,
    'paging never grants a viewer access or leaks admin query validation');
  assert.equal((await fetch(`${origin}/api/monitoring-status`, { headers: { Cookie: viewerCookie } })).status, 200);
  const ingested = await fetch(`${origin}/api/ingest`, { method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': owner.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetId: target.id, data: { snapshot: { followers: 100, totalLikes: 1200, totalPosts: 0 } } }) });
  assert.equal(ingested.status, 200);
  const receipt = await ingested.json();
  const reviewReadback = await (await request('/api/ingestion-reviews')).json();
  const receiptReview = reviewReadback.reviews.find(item => item.runId === receipt.runId);
  assert.ok(receiptReview, 'the just-ingested source has a durable review receipt');
  assert.equal(receiptReview.productReviewStatus, 'pending', 'rule receipt is not a completed AI review');
  assert.equal(reviewReadback.queue.lastRecordedRunId, receipt.runId);
  assert.equal(reviewReadback.queue.lastRecordMode, 'single-committed-run', 'normal ingestion must not rescan all historical receipt files');
  const recentReview=await request(`/api/ingestion-reviews?state=pending&order=newest&limit=1&beforeRunId=${receipt.runId+1}`);
  assert.equal(recentReview.status,200);const recentBody=await recentReview.json();
  assert.equal(recentBody.reviews[0].runId,receipt.runId);assert.equal(recentBody.pagination.returned,1);
  assert.equal(recentBody.totalPending,reviewReadback.totalPending);
  assert.equal(recentBody.reviews[0].productReviewStatus,'pending','listing a page never completes the product review');
  for(const query of ['limit=0','limit=1&limit=2','beforeRunId=9007199254740992','state=unknown']){
    const invalid=await request('/api/ingestion-reviews?'+query);assert.equal(invalid.status,400);
    assert.equal((await invalid.json()).code,'INVALID_REVIEW_SELECTION');
  }
  assert.deepEqual(Object.keys(reviewReadback.queue).filter(key => key.endsWith('RunIds')), [],
    'admin queue summary should expose counts without duplicating every run ID');
  assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM snapshots').get().count, 8,
    'only the explicit owner ingest may append a snapshot before the forged-row test');
  db.db.prepare(`INSERT INTO snapshots(target_id,captured_at,hashtag_participants,hashtag_views,quality_status,
    account_status,works_coverage,warnings_json,source_checksum,raw_json)
    VALUES(?,?,999999,99999999,'validated','available','not-applicable','[]','unbound-topic-fixture','{}')`)
    .run(topic.id, '2025-01-03T13:00:00.000Z');
  const forgedTopicHistory = await (await request('/api/topics/history?startDate=2025-01-03&endDate=2025-01-03')).json();
  const forgedPoint = forgedTopicHistory.topics[0].points[0];
  assert.equal(forgedPoint.qualityStatus, 'unverified');
  assert.equal(forgedPoint.sourceVerified, false);
  assert.equal(forgedPoint.participants, null);
  assert.equal(forgedPoint.views, null);
  assert.equal(forgedTopicHistory.topics[0].observedCount, 0);
  assert.equal(forgedTopicHistory.topics[0].sampledCount, 1);
  assert.equal(forgedTopicHistory.topics[0].latestKnown.participants.value, 25,
    'an unverified later row must not become the displayed latest actual value');
  assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM snapshots').get().count, 9);

  const activeRun = db.beginRun('manual', target.id, 1);
  const identityConflict = await fetch(`${origin}/api/targets/${target.id}`, {
    method: 'PATCH',
    headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': owner.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ locator: 'replacement-account-id' }),
  });
  assert.equal(identityConflict.status, 409, 'identity edits must be rejected while an active collection can still return data');
  const identityConflictBody = await identityConflict.json();
  assert.equal(identityConflictBody.code, 'target_identity_in_progress');
  assert.equal(db.getTarget(target.id).locator, 'MS4wLjABAAAAPRODUCTAPITESTabcdefghijklmn',
    'the blocked identity edit must not mutate the account locator');

  const displayEdit = await fetch(`${origin}/api/targets/${target.id}`, {
    method: 'PATCH',
    headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': owner.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: '隔离验收作者（名称修正）' }),
  });
  assert.equal(displayEdit.status, 200, 'display-name corrections remain available during collection');
  assert.equal((await displayEdit.json()).label, '隔离验收作者（名称修正）');
  db.finishRun(activeRun, { status: 'success', successCount: 1 });
});
