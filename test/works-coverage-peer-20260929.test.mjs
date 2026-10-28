import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MonitorDatabase } from '../lib/database.mjs';
import { getProductInsights, getAccountInsight } from '../lib/product-insights.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';

// Offline counterexamples for interpreting coverage, not real platform samples.
function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-01T02:00:00.000Z') });
  const directory = mkdtempSync(join(tmpdir(), 'works-coverage-peer-'));
  const database = new MonitorDatabase(join(directory, 'fixture.sqlite'));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  const target = database.createTarget({ type: 'account', label: 'offline-peer',
    locator: 'MS4wLjABAAAAofflinepeerabcdefghijklmnop', provider: 'public-web', metadata: { platform: 'douyin' } });
  const sample = (date, inventory, coverage, count = null) => {
    const capturedAt = `${date}T02:00:00.000Z`;
    t.mock.timers.setTime(Date.parse(capturedAt));
    const raw = { capturedAt, accountStatus: 'validated', accountError: null,
      profile: { user: { sec_uid: target.locator, uid: '123456789', follower_count: 100,
        total_favorited: 1000, aweme_count: inventory } },
      worksCoverage: coverage, worksErrorCode: count === null ? 'deferred' : null,
      works: count === null ? { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } }
        : { aweme_list: Array.from({ length: count }, (_, n) => ({
          aweme_id: String(7000000000000000000n + BigInt(n)), create_time: 1789257600,
          author: { sec_uid: target.locator, uid: '123456789' }, statistics: { digg_count: 0 },
        })), has_more: false, stopReason: 'browser-end-of-list' },
      provenance: { mode: 'guest-ttwid-unsigned-profile', profileMode: 'guest-ttwid-unsigned-profile',
        profileEndpoint: 'https://www.douyin.com/aweme/v1/web/user/profile/other/',
        accountLocator: 'sec_uid', cookiePersisted: false, runtimeAI: false, paidAPI: false } };
    // Save synthetic source through the normal identity/hash/counter contract;
    // arbitrary SQL counters with fake hashes must not be accepted by readers.
    database.saveCollection(target, null, normalizeCollection(target, raw, { capturedAt }));
  };
  const options = { period: 'day', timeZone: 'Asia/Shanghai', reference: new Date('2026-09-29T03:00:00.000Z') };
  return { database, target, sample, options };
}

test('daily profile inventory delta remains available when current works detail is unavailable', t => {
  const { database, sample, options } = fixture(t);
  sample('2026-09-28', 20, 'limited', 10);
  sample('2026-09-29', 21, 'unavailable');
  const result = getProductInsights(database, options);
  assert.equal(result.summary.metrics.posts.delta, 1);
  assert.equal(result.summary.metrics.posts.dailyComparableCount, 1);
  assert.equal(result.summary.collectionCoverage.works.complete, 0);
  assert.equal(result.summary.collectionCoverage.works.unavailable, 1);
  assert.equal(result.accounts[0].worksObservation.carriedForward, true);
  assert.equal(result.accounts[0].worksObservation.sampleCount, 10);
});

test('a fresh profile inventory alone does not invent a daily delta across a missing baseline', t => {
  const { database, sample, options } = fixture(t);
  sample('2026-09-16', 20, 'limited', 10);
  sample('2026-09-29', 21, 'unavailable');
  const result = getProductInsights(database, options);
  assert.equal(result.summary.metrics.posts.endObservedCount, 1);
  assert.equal(result.summary.metrics.posts.delta, null);
  assert.equal(result.summary.metrics.posts.dailyComparableCount, 0);
});

test('complete current zero inventory can coexist with retained historical works and does not certify an archive', t => {
  const { database, target, sample, options } = fixture(t);
  sample('2026-09-28', 1, 'complete', 1);
  sample('2026-09-29', 0, 'complete', 0);
  assert.equal(database.db.prepare('SELECT COUNT(*) n FROM posts WHERE target_id=?').get(target.id).n, 1,
    'the earlier synthetic source already persisted this historical work');
  const result = getAccountInsight(database, target.id, options);
  assert.equal(result.account.collection.worksState, 'complete');
  assert.equal(result.account.worksObservation.sampleCount, 0);
  assert.equal(result.account.worksObservation.evidenceScope, 'stored-public-sample');
  assert.equal(result.account.metrics.posts.delta, -1);
  assert.equal(result.recentWorks.length, 1, 'old work remains; current inventory does not replace history');
  assert.match(result.account.worksObservation.reason, /0条样本不等于没有发布/);
});
