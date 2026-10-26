import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';

const now = Date.parse('2026-09-28T00:00:00Z');
const target = { id: 1, type: 'hashtag', provider: 'public-web', locator: '#离线时间核验', metadata: {} };
function fixture(capturedAt) {
  return new PublicWebProvider({}, {
    database: { listAccountPostsForPool: () => [] }, topicResolverMode: 'browser',
    topicBrowserBatch: new Map([['离线时间核验', { status: 'ok', capturedAt,
      snapshot: { hashtagParticipants: 12, hashtagViews: 345 }, warnings: [], raw: {} }]]),
  });
}
test('prefetched topic keeps the time of observation rather than delayed persistence', async t => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const observed = '2026-09-27T23:57:12.000Z';
  const result = await fixture(observed).collectHashtag(target);
  assert.equal(result.capturedAt, observed);
  assert.equal(result.raw.capturedAt, observed);
  assert.equal(result.raw.timestampSource, 'resolver-observation-time');
  assert.equal(result.snapshot.hashtagParticipants, 12);
  assert.equal(result.snapshot.hashtagViews, 345);
});
test('invalid or future topic timestamps never become valid official measurements', async t => {
  t.mock.timers.enable({ apis: ['Date'], now });
  for (const timestamp of ['invalid', '2026-09-28T00:00:01.000Z', '2026-02-30T00:00:00.000Z', '2026-09-26T12:00:00', '0']) {
    const result = await fixture(timestamp).collectHashtag(target);
    assert.equal(result.snapshot.hashtagParticipants, null);
    assert.equal(result.snapshot.hashtagViews, null);
    assert.match(result.warnings.join(' '), /采样时间无效/);
  }
});
test('legacy resolver without timestamp remains compatible at receive time', async t => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const result = await fixture(undefined).collectHashtag(target);
  assert.equal(result.capturedAt, new Date(now).toISOString());
  assert.equal(result.raw.timestampSource, 'legacy-receive-time');
  assert.equal(result.snapshot.hashtagViews, 345);
});
