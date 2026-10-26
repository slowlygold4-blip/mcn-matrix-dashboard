import assert from 'node:assert/strict';
import test from 'node:test';
import { MonitorDatabase } from '../lib/database.mjs';
import { getAccountHistory } from '../lib/account-history.mjs';
import { getProductInsights } from '../lib/product-insights.mjs';
import { normalizeCollection, normalizeManualCollection } from '../lib/providers/normalize.mjs';
import { checksum } from '../lib/utils.mjs';

const AS_OF = '2026-09-12T12:00:00.000Z';
const locator = 'MS4wLjABAAAAaaaaaaaaaaaaaaaa';

function fixture(t) {
  const database = new MonitorDatabase(':memory:');
  t.after(() => database.close());
  const target = (provider, label) => {
    const account = database.createTarget({ type: 'account', provider, label,
      locator, metadata: { platform: 'douyin' } });
    // Historical observations belong to a target that already existed then,
    // independent of the calendar date on which this fixture runs.
    const createdAt = '2026-09-10T00:00:00.000Z';
    database.db.prepare('UPDATE targets SET created_at=?,updated_at=? WHERE id=?')
      .run(createdAt, createdAt, account.id);
    return account;
  };
  const manualSample = (account, date, followers) => {
    const capturedAt = `${date}T02:00:00.000Z`;
    const collection = normalizeManualCollection(account, { capturedAt, posts: [],
      // Even a rehashed/manual payload that copies the target ID must retain
      // its server-owned manual marker and stay out of public-source totals.
      profile: { user: { sec_uid: locator, uid: '222523170759696', follower_count: followers,
        total_favorited: 1000 + followers, aweme_count: 0 } },
      snapshot: { followers, totalLikes: 1000 + followers, totalPosts: 0 } });
    database.saveCollection(account, null, collection);
  };
  const publicSample = (account, date, followers) => {
    const capturedAt = `${date}T02:00:00.000Z`;
    const raw = { capturedAt, profile: { user: { sec_uid: locator, uid: '222523170759696',
      follower_count: followers, total_favorited: 1000 + followers, aweme_count: 0 } },
      works: { aweme_list: [] } };
    database.saveCollection(account, null, normalizeCollection(account, raw, { capturedAt }));
  };
  const legacyManualSample = (account, date, followers) => {
    const capturedAt = `${date}T02:00:00.000Z`;
    const raw = { capturedAt, profile: { user: { sec_uid: locator, uid: '222523170759696',
      follower_count: followers, total_favorited: 1000 + followers, aweme_count: 0 } },
      snapshot: { followers, totalLikes: 1000 + followers, totalPosts: 0 } };
    database.db.prepare(`INSERT INTO snapshots(target_id,captured_at,followers,total_likes,total_posts,
      quality_status,account_status,works_coverage,source_checksum,raw_json) VALUES(?,?,?,?,?,'warning','available','unknown',?,?)`)
      .run(account.id, capturedAt, followers, 1000 + followers, 0, checksum(raw), JSON.stringify(raw));
  };
  const read = account => getProductInsights(database, { period: 'day', reference: new Date(AS_OF),
    timeZone: 'Asia/Shanghai' }).accounts.find(item => item.id === account.id);
  return { database, target, manualSample, legacyManualSample, publicSample, read };
}

test('manual snapshots on a public-web target are excluded consistently from overview and daily history', t => {
  const { target, manualSample, read, database } = fixture(t);
  const account = target('public-web', '未核验平台账号');
  manualSample(account, '2026-09-11', 100);
  manualSample(account, '2026-09-12', 120);

  const overview = read(account);
  const history = getAccountHistory(database, account.id, { kind: 'daily', asOf: AS_OF });
  assert.equal(overview.metrics.followers.delta, null,
    'manual numbers must not appear as public-platform growth');
  assert.equal(overview.collection.profileObserved, false,
    'an unverified import must not inflate daily profile coverage');
  assert.equal(overview.status.provenanceWarning, '存在来源或指标未通过校验的已保存快照；未纳入平台趋势、增长与覆盖统计');
  assert.equal(history.pagination.total, 0);
  assert.equal(history.coverage.excludedCount, 2);
});

test('identity-bound public observations remain in overview and daily history', t => {
  const { target, publicSample, read, database } = fixture(t);
  const account = target('public-web', '已绑定平台账号');
  publicSample(account, '2026-09-11', 100);
  publicSample(account, '2026-09-12', 120);

  const overview = read(account);
  const history = getAccountHistory(database, account.id, { kind: 'daily', asOf: AS_OF });
  assert.equal(overview.metrics.followers.delta, 20);
  assert.equal(overview.collection.profileObserved, true);
  assert.equal(overview.status.provenanceWarning, null);
  assert.equal(history.pagination.total, 2);
  assert.equal(history.coverage.excludedCount, 0);
});

test('older root-snapshot imports are excluded even if they contain a copied public identity', t => {
  const { target, legacyManualSample, read, database } = fixture(t);
  const account = target('public-web', '旧格式手工导入');
  legacyManualSample(account, '2026-09-11', 100);
  legacyManualSample(account, '2026-09-12', 120);

  const overview = read(account);
  const history = getAccountHistory(database, account.id, { kind: 'daily', asOf: AS_OF });
  assert.equal(overview.metrics.followers.delta, null);
  assert.equal(overview.collection.profileObserved, false);
  assert.equal(overview.status.provenanceWarning, '存在来源或指标未通过校验的已保存快照；未纳入平台趋势、增长与覆盖统计');
  assert.equal(history.pagination.total, 0);
  assert.equal(history.coverage.excludedCount, 2);
});

test('manual-provider observations remain available as explicitly manual records', t => {
  const { target, manualSample, read, database } = fixture(t);
  const account = target('manual', '手工维护账号');
  manualSample(account, '2026-09-11', 100);
  manualSample(account, '2026-09-12', 120);

  const overview = read(account);
  const history = getAccountHistory(database, account.id, { kind: 'daily', asOf: AS_OF });
  assert.equal(overview.metrics.followers.delta, 20);
  assert.equal(overview.collection.profileObserved, true);
  assert.equal(history.pagination.total, 2);
  assert.equal(history.coverage.excludedCount, 0);
});
