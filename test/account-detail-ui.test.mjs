import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountInsightPath, buildAccountTrend, createAccountDetail,
  normalizeAccountInsight, renderAccountDetail,
} from '../public/account-detail.js';

function fixture(id = 1) {
  const metric = (value, delta) => ({
    value, baseline: value - delta, delta, percent: 5, comparable: true,
    currentAt: '2026-09-13T02:00:00Z', comparisonCurrentAt: '2026-09-13T02:00:00Z',
    baselineAt: '2026-09-12T02:00:00Z', comparisonLabel: '较前日',
  });
  return {
    period: 'day', referenceAt: '2026-09-13T03:00:00Z', timeZone: 'Asia/Shanghai',
    account: {
      id, label: `完整作者姓名-${id}`, platform: 'douyin', publicId: '005551234567890123',
      enabled: true, profileUrl: 'https://www.douyin.com/user/valid',
      boards: [{ key: '玉麒麟', name: '玉麒麟切片矩阵' }],
      metrics: {
        followers: metric(1234567, 40), likes: metric(0, -20),
        posts: metric(17, -2), estimatedPlays: { ...metric(0, -2000), proxy: true, formula: '新增点赞 × 100' },
      },
      trend: [
        { date: '2026-09-11', followers: 10, likes: 4, estimatedPlays: 400, posts: 5 },
        { date: '2026-09-12', followers: null, likes: null, estimatedPlays: null, posts: null },
        { date: '2026-09-13', followers: 20, likes: 5, estimatedPlays: 500, posts: 4 },
      ],
      status: { label: '正常监控', worksCoverage: 'limited', warnings: ['只取得最近公开范围'] },
      sources: [{ fileName: '玉麒麟来源表', sheetName: '8月', row: 143, url: 'https://my.feishu.cn/wiki/source' }],
      publishedSamples: { value: 2, reason: '按已取得的公开作品发布时间计数' },
    },
    recentWorks: [{ id: 2, caption: '完整作品说明', likes: 0, plays: null, url: 'https://www.douyin.com/video/123' }],
  };
}

test('preserves public ID strings, unknown metrics and explicit enabled state', () => {
  const data = fixture();
  data.account.enabled = 0;
  data.account.metrics.followers.value = null;
  const result = normalizeAccountInsight(data);
  assert.equal(result.account.publicId, '005551234567890123');
  assert.equal(result.account.enabled, false);
  assert.equal(result.account.metrics.followers.value, null);
  assert.throws(() => normalizeAccountInsight({}), /不完整/);
});

test('renders exact current numbers, signed growth and stock/estimate semantics', () => {
  const html = renderAccountDetail(fixture(), { trendMetric: 'estimatedPlays' });
  assert.match(html, /完整作者姓名-1/);
  assert.match(html, /005551234567890123/);
  assert.match(html, /1,234,567/);
  assert.match(html, /\+40/);
  assert.match(html, /-20/);
  assert.match(html, /-2,000/);
  assert.match(html, /累计点赞代理/);
  assert.match(html, /新增估算播放/);
  assert.doesNotMatch(html, /累计估算播放/);
  assert.match(html, /不是平台实测播放量/);
  assert.match(html, /作品变化表示存量净变化，不等于新增投稿/);
  assert.match(html, /原表第143行/);
  assert.match(html, /估算播放<\/dt><dd>0/);
  assert.match(html, /估算播放＝该作品点赞 × 100，不是平台真实播放/);
});

test('renderer separates cumulative likes proxy from incremental estimated plays', () => {
  const html = renderAccountDetail(fixture(), { trendMetric: 'estimatedPlays' });
  assert.match(html, /累计点赞代理＝累计获赞 × 100/);
  assert.match(html, /新增估算播放＝新增点赞 × 100/);
  assert.match(html, /<span>新增估算播放<\/span>/);
  assert.match(html, /<th scope="col">累计点赞代理<\/th>/);
  assert.match(html, /<th scope="col">新增估算播放<\/th>/);
  assert.doesNotMatch(html, /累计估算播放/);
});

test('work plays use likes-times-100 estimate while anonymous source zeros stay in evidence only', () => {
  const data = fixture();
  data.recentWorks = [{ caption: '有赞样本', likes: 25, plays: 0 }, { caption: '缺赞样本', likes: null, plays: 0 }];
  const html = renderAccountDetail(data);
  assert.match(html, /估算播放<\/dt><dd>2,500/);
  assert.match(html, /估算播放<\/dt><dd>—/);
  assert.doesNotMatch(html, /<dt>实测播放|估算播放<\/dt><dd>0/);
  assert.match(html, /<details><summary>查看来源播放字段<\/summary><p[^>]*>公开来源返回：0；0可能是匿名占位/);
});

test('unknown and zero are different; incomparable changes never leak into cards', () => {
  const data = fixture();
  data.account.metrics.followers = { value: null, delta: 999999, percent: 777, comparable: false };
  data.account.metrics.likes = { value: 0, baseline: 0, delta: 0, percent: null, comparable: true };
  const html = renderAccountDetail(data);
  assert.match(html, /metric-value">—/);
  assert.match(html, /metric-value">0/);
  assert.match(html, /基数为0，比例不可算/);
  assert.doesNotMatch(html, /999,999|777%/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test('metric-level staleness is visible and normal range response cannot create an unusable custom tab', () => {
  const data = fixture();
  data.range = { startDate: '2026-09-13', endDate: '2026-09-13' };
  data.account.metrics.likes.stale = true;
  const html = renderAccountDetail(data);
  assert.match(html, /此项数据偏旧/);
  assert.doesNotMatch(html, /data-detail-period="custom"/);
});

test('escapes every external surface and rejects unsafe outbound URLs', () => {
  const data = fixture();
  data.account.label = '<script>alert(1)</script>';
  data.account.publicId = '<img src=x onerror=1>';
  data.account.profileUrl = 'javascript:alert(1)';
  data.account.boards[0] = { key: '"><img src=x>', name: '<svg onload=1>' };
  data.account.status.error = '<script>error</script>';
  data.account.status.warnings = ['<img src=x>'];
  data.account.sources[0] = { fileName: '<source>', row: '<row>', url: 'https://name:secret@example.com' };
  data.recentWorks[0] = { caption: '<b>caption</b>', url: 'https://example.com:8080/work' };
  const html = renderAccountDetail(data);
  assert.doesNotMatch(html, /<script|<img|<b>|<source>|<row>/);
  assert.doesNotMatch(html, /href="javascript:|href="https:\/\/name:|href="https:\/\/example.com:8080/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;b&gt;caption&lt;\/b&gt;/);
});

test('explains paused, missing, stale, empty works and last update failures', () => {
  const data = fixture();
  data.account.enabled = false;
  data.account.status.stale = true;
  data.account.status.error = '公开接口暂未返回数据';
  data.recentWorks = [];
  let html = renderAccountDetail(data);
  assert.match(html, /监控已暂停/);
  assert.match(html, /以下是已保存的历史观测，不代表当前实时值/);
  assert.match(html, /最近一次更新未完成/);
  assert.match(html, /这不等于作者没有发布作品/);
  data.account.metrics = {};
  html = renderAccountDetail(data);
  assert.match(html, /尚无可展示的账号快照/);
  assert.match(html, /不会按0计算/);
});

test('official deletion preserves historical metrics and stays separate from monitoring controls', () => {
  const data = fixture();
  data.account.status = {
    key: 'deleted', label: '官方主页显示已注销', stale: true, worksCoverage: 'retry',
    error: '旧作品接口暂未返回数据', warnings: ['原作品列表读取未完成'],
    lastSuccessAt: '2026-09-12T02:00:00Z',
  };
  data.account.lifecycle = {
    state: 'deleted', observedAt: '2026-09-13T02:30:00Z', reason: '官方主页明确回传注销状态',
    sourceChecksum: 'official-status-checksum', requestedAccountId: 'stable-sec-uid', reportedUid: '00123',
  };
  const original = structuredClone(data);
  const html = renderAccountDetail(data, { canManage: true });
  assert.match(html, /官方主页显示已注销/);
  assert.match(html, /监控设置：启用/);
  assert.match(html, /已保存的历史指标/);
  assert.match(html, /已保存的历史作品/);
  assert.match(html, /metric-value">1,234,567/);
  assert.match(html, /metric-value">17/);
  assert.match(html, /metric-value">0/);
  assert.match(html, /历史数据：09\/13 10:00/);
  assert.match(html, /启用监控时每天检查主页状态，不再反复获取不可用作品/);
  assert.match(html, /data-detail-enabled="false"[^>]*>暂停监控/);
  assert.match(html, /启停只控制主页状态检查，不改变平台注销状态/);
  assert.doesNotMatch(html, /数据需要更新|最近一次更新未完成|作品列表待重试|data-detail-retry/);
  const evidence = html.match(/<details class="account-detail__lifecycle-evidence">([\s\S]*?)<\/details>/)?.[1];
  assert.ok(evidence);
  for (const expected of ['状态观测时间', 'official-status-checksum', 'stable-sec-uid', '00123', '官方主页明确回传注销状态']) {
    assert.ok(evidence.includes(expected));
  }
  assert.match(html, /<details class="account-detail__warnings">[\s\S]*查看历史采集记录[\s\S]*旧作品接口暂未返回数据/);
  assert.match(html, /以下保留历史诊断，不是当前待办/);
  assert.deepEqual(data, original, 'render must not clear values, change enabled or rewrite evidence');
});

test('paused deleted accounts retain both facts and missing history remains unknown, not zero', () => {
  const data = fixture();
  data.account.enabled = false;
  data.account.lifecycle = { state: 'deleted' };
  data.account.status = { key: 'paused', label: '已暂停监控', stale: true, worksCoverage: 'retry' };
  data.account.metrics = {};
  data.account.trend = [];
  data.recentWorks = [];
  const html = renderAccountDetail(data, { canManage: true });
  assert.match(html, /account-detail__badge">官方主页显示已注销/);
  assert.match(html, /监控设置：暂停/);
  assert.match(html, /监控已暂停/);
  assert.match(html, /暂停期间不会自动更新/);
  assert.match(html, /data-detail-enabled="true"[^>]*>启用监控/);
  assert.match(html, /尚无可展示的账号快照/);
  assert.match(html, /暂无已保存的历史作品/);
  assert.equal((html.match(/metric-value">—/g) || []).length, 4);
  assert.doesNotMatch(html, /metric-value">0|data-detail-enabled="false"/);
  assert.doesNotMatch(renderAccountDetail(data), /data-detail-enabled=/);
});

test('deletion is never inferred from an author name or old error text', () => {
  const data = fixture();
  data.account.label = '已注销作者';
  data.account.lifecycle = { state: 'available', reason: '过去显示已注销' };
  data.account.status = { key: 'retry', label: '更新待重试', error: '未确认是否已注销', stale: true };
  const html = renderAccountDetail(data);
  assert.match(html, /更新待重试/);
  assert.match(html, /最近一次更新未完成/);
  assert.doesNotMatch(html, /查看注销判定证据|已保存的历史指标|监控设置：启用/);
});

test('identity aliases preserve submitted strings and source evidence without replacing the current account', () => {
  const data = fixture();
  data.account.publicId = 'Current_public_3';
  data.account.identityAliases = [{
    type: 'douyin-account-alias-change', submittedAccountId: ' @ＯＬＤ_Account ',
    previousPublicAccountId: 'Old_Account', currentPublicAccountId: 'Older_observation_2',
    canonicalAccountId: 'verified-sec-uid', uid: '000987654321', priorSnapshotId: 81,
    priorSnapshotCapturedAt: '2026-09-01T01:00:00Z', priorSourceChecksum: 'prior-proof',
    currentRawSha256: 'current-proof', observedAt: '2026-09-12T02:00:00Z',
    verifiedAt: '2026-09-12T03:00:00Z', reason: '公开稳定身份连续一致，仅展示号变化',
  }];
  const original = structuredClone(data);
  const html = renderAccountDetail(data);
  assert.match(html, /当前平台号<\/dt><dd>Current_public_3/);
  assert.match(html, /<h2[^>]*>完整作者姓名-1<\/h2>/);
  const history = html.match(/<details class="account-detail__identity-history">([\s\S]*?)<\/details>/)?.[1];
  assert.ok(history);
  for (const expected of [' @ＯＬＤ_Account ', 'Old_Account', 'Older_observation_2', 'verified-sec-uid',
    '000987654321', '81', 'prior-proof', 'current-proof', '公开稳定身份连续一致', '原来源快照 ID']) {
    assert.ok(history.includes(expected));
  }
  assert.match(html, /原表第143行/);
  assert.match(history, /历史改号记录不覆盖原始导入信息/);
  assert.deepEqual(data, original);
});

test('submitted name and account remain distinct from current identity and are shown only when supplied', () => {
  const data = fixture();
  data.account.submittedName = ' 原表作者<旧名> ';
  data.account.submittedAccountId = '000000012345678901';
  data.account.publicId = 'Verified_current_id';
  const original = structuredClone(data);
  const html = renderAccountDetail(data);
  assert.match(html, /原提交姓名<\/dt><dd> 原表作者&lt;旧名&gt; /);
  assert.match(html, /原提交账号<\/dt><dd>000000012345678901/);
  assert.match(html, /当前平台号<\/dt><dd>Verified_current_id/);
  assert.match(html, /<h2[^>]*>完整作者姓名-1<\/h2>/);
  assert.doesNotMatch(html, /<旧名>/);
  assert.deepEqual(data, original);
  for (const value of [null, undefined, '', '   ']) {
    data.account.submittedName = value;
    data.account.submittedAccountId = value;
    const withoutOriginal = renderAccountDetail(data);
    assert.doesNotMatch(withoutOriginal, /<dt>原提交姓名<\/dt>|<dt>原提交账号<\/dt>/);
    assert.match(withoutOriginal, /当前平台号<\/dt><dd>Verified_current_id/);
  }
});

test('source-video identity proof is separate from aliases and preserves the full original/current mapping', () => {
  const data = fixture();
  data.account.publicId = 'Current_public';
  data.account.submittedName = '原提交名字';
  data.account.submittedAccountId = '001234567890';
  data.account.identityEvidence = [{
    submittedAccountId: '001234567890', currentPublicAccountId: 'Observed_public',
    canonicalAccountId: 'stable-source-sec-uid', uid: '000123456789012345',
    sourceVideoId: '7771234567890123456', sourceMatchField: 'author.short_id',
    detailResponseChecksum: 'detail-response-hash', currentRawSha256: 'current-profile-hash',
    observedAt: '2026-09-13T02:00:00Z', verifiedAt: '2026-09-13T02:01:00Z',
    reason: '原作品作者的公开 short_id 命中原提交号，稳定身份与主页一致',
  }];
  const original = structuredClone(data);
  const html = renderAccountDetail(data);
  const evidence = html.match(/<details class="account-detail__identity-evidence">([\s\S]*?)<\/details>/)?.[1];
  assert.ok(evidence);
  assert.match(evidence, /原作品身份凭据（1）/);
  assert.match(evidence, /这是身份凭据，不表示账号发生改号/);
  for (const expected of ['001234567890', 'Observed_public', 'stable-source-sec-uid', '000123456789012345',
    '7771234567890123456', 'author.short_id', 'detail-response-hash', 'current-profile-hash', '核验依据']) {
    assert.ok(evidence.includes(expected));
  }
  assert.match(evidence, /href="https:\/\/www\.douyin\.com\/video\/7771234567890123456" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /当前平台号<\/dt><dd>Current_public/);
  assert.match(html, /原提交姓名<\/dt><dd>原提交名字/);
  assert.doesNotMatch(html, /公开账号曾变更|查看改号记录/);
  assert.deepEqual(data, original);
});

test('source-video proof links accept only 15–25 digit IDs and all external evidence is escaped', () => {
  for (const videoId of ['123456789012345', '1234567890123456789012345']) {
    const data = fixture();
    data.account.identityEvidence = [{ sourceVideoId: videoId }];
    const html = renderAccountDetail(data);
    assert.ok(html.includes(`href="https://www.douyin.com/video/${videoId}"`));
  }
  for (const sourceVideoId of ['12345678901234', '12345678901234567890123456', ' 123456789012345',
    '1e15', 'https://evil.example/123456789012345', '123456789012345?x=1', '<img src=x>', 123456789012345]) {
    const data = fixture();
    data.account.identityEvidence = [{
      sourceVideoId, submittedAccountId: '<old>', currentPublicAccountId: '<public>',
      canonicalAccountId: '<sec>', uid: '<uid>', sourceMatchField: '<script>field</script>',
      detailResponseChecksum: '<detail>', currentRawSha256: '<raw>', reason: '<svg onload=1>',
    }];
    const evidence = renderAccountDetail(data)
      .match(/<details class="account-detail__identity-evidence">([\s\S]*?)<\/details>/)?.[1];
    assert.ok(evidence);
    assert.doesNotMatch(evidence, /href=|<img|<old>|<public>|<sec>|<uid>|<script|<detail>|<raw>|<svg/);
    for (const expected of ['&lt;old&gt;', '&lt;public&gt;', '&lt;sec&gt;', '&lt;uid&gt;',
      '&lt;script&gt;field&lt;/script&gt;', '&lt;detail&gt;', '&lt;raw&gt;', '&lt;svg onload=1&gt;']) {
      assert.ok(evidence.includes(expected));
    }
  }
});

test('missing source identity fields are not fabricated and malformed or empty records stay hidden', () => {
  const data = fixture();
  for (const identityEvidence of [null, undefined, {}, 'not-an-array', [null, [], 'bad', {}]]) {
    data.account.identityEvidence = identityEvidence;
    assert.doesNotMatch(renderAccountDetail(data), /原作品身份凭据/);
  }
  data.account.identityEvidence = [{ sourceVideoId: '7771234567890123456' }];
  const evidence = renderAccountDetail(data)
    .match(/<details class="account-detail__identity-evidence">([\s\S]*?)<\/details>/)?.[1];
  assert.match(evidence, /来源作品/);
  assert.doesNotMatch(evidence, /<dt>原提交账号|<dt>观测时间|<dt>核验时间|<dt>稳定身份|<dt>平台 uid|<dt>作品详情校验值/);
  assert.doesNotMatch(evidence, /暂无时间记录|005551234567890123/);
});

test('new lifecycle and alias evidence escape external text and reject malformed event collections', () => {
  const data = fixture();
  data.account.lifecycle = {
    state: 'deleted', reason: '<script>reason</script>', sourceChecksum: '<proof>',
    requestedAccountId: '<img src=x>', reportedUid: '<uid>',
  };
  data.account.identityAliases = [{
    type: 'douyin-account-alias-change', submittedAccountId: '<old>', currentPublicAccountId: '<new>',
    canonicalAccountId: '<sec>', uid: '<uid>', priorSnapshotId: '<snapshot>',
    priorSourceChecksum: '<prior>', currentRawSha256: '<raw>', reason: '<svg onload=x>',
  }, null, { type: 'unverified-candidate', currentPublicAccountId: 'unverified-secret-candidate' }];
  const html = renderAccountDetail(data);
  assert.doesNotMatch(html, /<script|<img|<old>|<new>|<sec>|<uid>|<snapshot>|<prior>|<raw>|<svg onload/);
  assert.match(html, /&lt;script&gt;reason&lt;\/script&gt;/);
  assert.match(html, /&lt;old&gt;/);
  assert.match(html, /查看改号记录（1）/);
  assert.doesNotMatch(html, /unverified-secret-candidate/);
  data.account.identityAliases = { currentPublicAccountId: 'not-an-event-array' };
  data.account.lifecycle = ['deleted'];
  assert.equal(normalizeAccountInsight(data).account.lifecycle, null);
  assert.doesNotMatch(renderAccountDetail(data), /查看改号记录/);
});

test('trends preserve null gaps, calendar gaps and a single observation', () => {
  const model = buildAccountTrend(fixture().account.trend);
  assert.equal(model.points.length, 3);
  assert.deepEqual(model.segments.map((segment) => segment.length), [1, 1]);
  assert.equal(model.points[1].value, null);
  const gap = buildAccountTrend([{ date: '2026-09-10', followers: 0 }, { date: '2026-09-13', followers: 1 }]);
  assert.deepEqual(gap.segments.map((segment) => segment.length), [1, 1]);
  const data = fixture();
  data.account.trend = [{ date: '2026-09-10', followers: 0 }];
  const html = renderAccountDetail(data);
  assert.match(html, /仅1天有观测/);
  assert.match(html, /<circle /);
  assert.doesNotMatch(html, /<path /);
});

test('all four trend fields and full custom ranges are supported without proxy fill', () => {
  for (const metric of ['followers', 'likes', 'estimatedPlays', 'posts']) {
    const model = buildAccountTrend(fixture().account.trend, { metric });
    assert.equal(model.metric, metric);
    assert.equal(model.observations.length, 2);
    assert.equal(model.points[1].value, null);
  }
  const points = Array.from({ length: 60 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10), estimatedPlays: i * 100,
  }));
  assert.equal(buildAccountTrend(points, { days: 'range' }).points.length, 60);
  assert.equal(buildAccountTrend(points, { days: 7 }).points.length, 7);
  assert.equal(buildAccountTrend(points).points.length, 30);
});

test('daily publication trend uses collected timestamp samples, never stock deltas or missing-value zero fill', () => {
  const data = fixture();
  data.account.trend = [
    { date: '2026-09-11', posts: 80, postsDelta: -20, publishedSamples: 3 },
    { date: '2026-09-12', posts: 100, postsDelta: 20, publishedSamples: null },
    { date: '2026-09-13', posts: 100, postsDelta: 0, publishedSamples: 0 },
  ];
  const model = buildAccountTrend(data.account.trend, { metric: 'publishedSamples' });
  assert.equal(model.metric, 'publishedSamples');
  assert.deepEqual(model.points.map((point) => point.value), [3, null, 0]);
  assert.deepEqual(model.segments.map((segment) => segment.length), [1, 1]);
  const html = renderAccountDetail(data, { trendMetric: 'publishedSamples' });
  assert.match(html, /data-detail-metric="publishedSamples"[^>]*aria-pressed="true">发布量（已收录）/);
  assert.match(html, /按已收录作品的真实发布时间分日计数/);
  assert.match(html, /截至所选区间结束已收录的作品才计入本期，之后才收录的不回填本期/);
  assert.match(html, /不代表完整发布量/);
  assert.match(html, /0仅表示尚未收录当日发布样本，不代表作者没有发布/);
  assert.match(html, /2026-09-11<\/th><td>3<\/td>/);
  assert.match(html, /2026-09-12<\/th><td>—<\/td>/);
  assert.match(html, /2026-09-13<\/th><td>0<\/td>/);
  assert.equal((html.match(/<article class="account-detail__metric">/g) || []).length, 4);
  const stockHtml = renderAccountDetail(data, { trendMetric: 'posts' });
  assert.match(stockHtml, /较前一日存量净变化/);
  assert.match(stockHtml, /每日发布量（已收录）<\/th>/);
  assert.match(stockHtml, /2026-09-11<\/th><td>80<\/td><td[^>]*>-20<\/td><td>3<\/td>/);
});

test('validates complete custom ranges and forwards both windows without interpolation', () => {
  const query = accountInsightPath(7, {
    period: 'day', startDate: '2026-08-01', endDate: '2026-08-31',
    comparisonStartDate: '2026-07-01', comparisonEndDate: '2026-07-31',
  });
  assert.equal(query, '/api/accounts/7/insights?period=custom&startDate=2026-08-01&endDate=2026-08-31&comparisonStartDate=2026-07-01&comparisonEndDate=2026-07-31');
  assert.throws(() => accountInsightPath('../1', {}), /ID/);
  assert.throws(() => accountInsightPath(1, { period: 'custom' }), /起止日期/);
  assert.throws(() => accountInsightPath(1, { startDate: '2026-02-30', endDate: '2026-03-01' }), /有效/);
  assert.throws(() => accountInsightPath(1, { startDate: '2026-02-01' }), /完整/);
  assert.throws(() => accountInsightPath(1, { startDate: '2026-03-01', endDate: '2026-02-01' }), /不能早于/);
  assert.throws(() => accountInsightPath(1, { comparisonStartDate: '2026-01-01', comparisonEndDate: '2026-01-02' }), /主时段/);
});

test('renders independently computed range comparison with its own labels and series', () => {
  const data = fixture();
  data.period = 'custom';
  data.range = { startDate: '2026-08-01', endDate: '2026-08-31' };
  data.comparison = { range: { startDate: '2026-07-01', endDate: '2026-07-31' }, account: fixture().account };
  const html = renderAccountDetail(data, { trendDays: 'range', trendMetric: 'posts' });
  assert.match(html, /2026-08-01 至 2026-08-31/);
  assert.match(html, /2026-07-01 至 2026-07-31/);
  assert.match(html, /两组指标分别按各自时段计算/);
  assert.match(html, /两图纵轴独立/);
  assert.match(html, /对比时段真实趋势/);
  assert.match(html, /存量净变化不是新增投稿数/);
});

test('trend range labels follow the displayed 30/7 days without changing the weekly metric window', () => {
  const data = fixture();
  data.period = 'week';
  data.range = { startDate: '2026-09-07', endDate: '2026-09-13' };
  data.account.trend = Array.from({ length: 30 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 7, 15 + index)).toISOString().slice(0, 10),
    followers: index % 3 ? index : null, publishedSamples: index % 4,
  }));
  for (const trendMetric of ['followers', 'publishedSamples']) {
    const html = renderAccountDetail(data, { trendMetric });
    const metrics = html.split('aria-labelledby="account-detail-metrics"')[1].split('</section>')[0];
    const trend = html.split('aria-labelledby="account-detail-trend"')[1].split('</section>')[0];
    assert.match(metrics, /account-detail__range-label">2026-09-07 至 2026-09-13/);
    assert.match(trend, /account-detail__range-label">2026-08-15 至 2026-09-13/);
    assert.doesNotMatch(trend, /account-detail__range-label">2026-09-07 至 2026-09-13/);
    const weekTrend = renderAccountDetail(data, { trendMetric, trendDays: 7 })
      .split('aria-labelledby="account-detail-trend"')[1].split('</section>')[0];
    assert.match(weekTrend, /account-detail__range-label">2026-09-07 至 2026-09-13/);
  }
});

test('custom and comparison trends each label their actual visible endpoints, including shortened windows', () => {
  const data = fixture();
  data.period = 'custom';
  data.range = { startDate: '2026-08-01', endDate: '2026-08-31' };
  const daily = (month, days) => Array.from({ length: days }, (_, index) => ({
    date: new Date(Date.UTC(2026, month, index + 1)).toISOString().slice(0, 10),
    followers: index, publishedSamples: index % 2,
  }));
  data.account.trend = daily(7, 31);
  data.comparison = { range: { startDate: '2026-07-01', endDate: '2026-07-31' }, account: { ...fixture().account, trend: daily(6, 31) } };
  const full = renderAccountDetail(data, { trendDays: 'range' });
  const primary = full.split('aria-labelledby="account-detail-trend"')[1].split('</section>')[0];
  const comparison = full.split('aria-labelledby="account-detail-comparison-trend"')[1].split('</section>')[0];
  assert.match(primary, /account-detail__range-label">2026-08-01 至 2026-08-31/);
  assert.match(comparison, /account-detail__range-label">2026-07-01 至 2026-07-31/);
  const short = renderAccountDetail(data, { trendDays: 7, trendMetric: 'publishedSamples' });
  const shortPrimary = short.split('aria-labelledby="account-detail-trend"')[1].split('</section>')[0];
  const shortComparison = short.split('aria-labelledby="account-detail-comparison-trend"')[1].split('</section>')[0];
  assert.match(shortPrimary, /account-detail__range-label">2026-08-25 至 2026-08-31/);
  assert.match(shortComparison, /account-detail__range-label">2026-07-25 至 2026-07-31/);
  assert.match(shortComparison, /两图纵轴独立/);
});

// A minimal DOM harness covers lifecycle and event contracts without network, browser or DB writes.
class FakeElement {
  constructor(document, tagName = 'button', attributes = {}) {
    this.document = document;
    this.tagName = tagName;
    this.attributes = new Map(Object.entries(attributes));
    this.listeners = new Map();
    this.style = {};
    this.children = [];
    this.controls = [];
    this.isConnected = true;
    this.tabIndex = 0;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  get open() { return this.hasAttribute('open'); }
  get disabled() { return this.hasAttribute('disabled'); }
  showModal() { this.setAttribute('open', ''); }
  close() { this.removeAttribute('open'); }
  append(element) { this.children.push(element); }
  remove() { this.isConnected = false; }
  focus() { this.document.activeElement = this; }
  contains(element) { return this === element || this.controls.includes(element); }
  getClientRects() { return [{}]; }
  getBoundingClientRect() { return { left: 0, right: 760, top: 0, bottom: 800 }; }
  closest(name) { return name === this.tagName ? this : null; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  emit(name, event) { this.listeners.get(name)?.({ preventDefault() {}, ...event }); }
  querySelectorAll(selector) { return selector === '[data-detail-focus]' ? this.controls.filter((item) => item.hasAttribute('data-detail-focus')) : this.controls; }
  insertAdjacentHTML(position, html) { this.innerHTML = html + this.innerHTML; }
  get innerHTML() { return this.html ?? ''; }
  set innerHTML(html) {
    this.html = html;
    this.controls = [...html.matchAll(/<button\b([^>]*)>/g)].map(([, text]) => {
      const attributes = Object.fromEntries([...text.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(([, key, value]) => [key, value ?? '']));
      return new FakeElement(this.document, 'button', attributes);
    });
  }
}

function dom() {
  const document = { createElement(tag) { return new FakeElement(this, tag); } };
  document.body = new FakeElement(document, 'body');
  document.body.style.overflow = 'auto';
  document.activeElement = new FakeElement(document);
  return document;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('opening is read-only, stale requests are aborted and late author replies cannot win', async () => {
  const document = dom();
  const originalFocus = document.activeElement;
  const calls = [];
  const pending = [];
  const actions = [];
  const detail = createAccountDetail({ document, api: (path, options) => {
    calls.push({ path, ...options });
    return new Promise((resolve) => pending.push(resolve));
  }, onAction: (action) => actions.push(action) });
  const first = detail.open(1);
  const second = detail.open(2, { period: 'week' });
  assert.equal(calls[0].signal.aborted, true);
  pending[1](fixture(2));
  await second;
  pending[0](fixture(1));
  await first;
  const dialog = document.body.children[0];
  assert.match(dialog.innerHTML, /完整作者姓名-2/);
  assert.doesNotMatch(dialog.innerHTML, /完整作者姓名-1/);
  assert.equal(actions.length, 0);
  detail.close();
  assert.equal(calls[1].signal.aborted, true);
  assert.equal(document.activeElement, originalFocus);
  assert.equal(document.body.style.overflow, 'auto');
  assert.equal(await detail.refresh(), null);
  assert.equal(calls.length, 2);
});

test('failed load can retry and mismatched response identity is never displayed', async () => {
  const document = dom();
  let attempts = 0;
  const detail = createAccountDetail({ document, api: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('<接口暂不可用>');
    return fixture(attempts === 2 ? 2 : 1);
  } });
  await detail.open(1);
  const dialog = document.body.children[0];
  assert.match(dialog.innerHTML, /&lt;接口暂不可用&gt;/);
  assert.match(dialog.innerHTML, /data-detail-retry/);
  await detail.refresh();
  assert.match(dialog.innerHTML, /返回账号与请求不一致/);
  assert.doesNotMatch(dialog.innerHTML, /完整作者姓名-2/);
  await detail.refresh();
  assert.match(dialog.innerHTML, /完整作者姓名-1/);
  assert.doesNotMatch(dialog.innerHTML, /data-detail-enabled/);
  detail.destroy();
  assert.equal(dialog.isConnected, false);
});

test('date windows reach API and enabled mutations only occur on explicit callback action', async () => {
  const document = dom();
  const calls = [];
  const actions = [];
  const detail = createAccountDetail({ document,
    api: async (path) => { calls.push(path); return fixture(); },
    onAction: async (action) => { actions.push(action); throw new Error('没有管理权限'); },
  });
  await detail.open(1, { startDate: '2026-08-01', endDate: '2026-08-31', comparisonStartDate: '2026-07-01', comparisonEndDate: '2026-07-31' });
  assert.match(calls[0], /period=custom/);
  assert.match(calls[0], /comparisonEndDate=2026-07-31/);
  assert.equal(actions.length, 0);
  const dialog = document.body.children[0];
  const actionButton = dialog.controls.find((item) => item.hasAttribute('data-detail-enabled'));
  dialog.emit('click', { target: actionButton });
  await settle();
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'set-enabled');
  assert.equal(actions[0].targetId, 1);
  assert.equal(actions[0].enabled, false);
  assert.match(dialog.innerHTML, /没有管理权限/);
  assert.match(dialog.innerHTML, /暂停监控/);
  assert.equal(calls.length, 1);
  detail.close();
});

test('Escape and keyboard loop keep focus usable; board callbacks return context', async () => {
  const document = dom();
  const originalFocus = document.activeElement;
  const selected = [];
  const detail = createAccountDetail({ document, api: async () => fixture(), onBoardSelect: (...args) => selected.push(args) });
  await detail.open(1);
  const dialog = document.body.children[0];
  document.activeElement = dialog.controls.at(-1);
  dialog.emit('keydown', { key: 'Tab' });
  assert.equal(document.activeElement, dialog.controls[0]);
  dialog.emit('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(document.activeElement, dialog.controls.at(-1));
  const board = dialog.controls.find((item) => item.hasAttribute('data-detail-board'));
  dialog.emit('click', { target: board });
  await settle();
  assert.deepEqual(selected, [['玉麒麟', { targetId: 1 }]]);
  assert.equal(document.activeElement, originalFocus);
  await detail.open(1);
  dialog.emit('keydown', { key: 'Escape' });
  assert.equal(dialog.open, false);
  assert.equal(document.activeElement, originalFocus);
});

test('viewer permission predicate hides mutations and is re-evaluated before action', async () => {
  const document = dom();
  let permission = false;
  let actions = 0;
  const detail = createAccountDetail({ document, api: async () => fixture(), canManage: () => permission, onAction: () => { actions += 1; } });
  await detail.open(1);
  const dialog = document.body.children[0];
  assert.doesNotMatch(dialog.innerHTML, /data-detail-enabled/);
  permission = true;
  await detail.refresh();
  const button = dialog.controls.find((item) => item.hasAttribute('data-detail-enabled'));
  assert.ok(button);
  permission = false;
  dialog.emit('click', { target: button });
  await settle();
  assert.equal(actions, 0);
  detail.close();
});

test('closing restores the matching author button even after the main list has refreshed', async () => {
  const document = dom();
  const original = document.activeElement;
  original.setAttribute('data-account', '1');
  const detail = createAccountDetail({ document, api: async () => fixture() });
  await detail.open(1);
  original.isConnected = false;
  const replacement = new FakeElement(document, 'button', { 'data-account': '1' });
  document.querySelectorAll = () => [replacement];
  detail.close();
  assert.equal(document.activeElement, replacement);
});
