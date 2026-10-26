import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MonitorDatabase } from '../lib/database.mjs';
import { MonitorScheduler } from '../lib/scheduler.mjs';

test('prefetched topics persist while the first slow account is still in flight', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'topic-priority-'));
  const db = new MonitorDatabase(join(directory, 'fixture.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const account = db.createTarget({ type: 'account', provider: 'public-web', label: '慢账号', locator: 'MS4wLjABtopicPriority' });
  const topic = db.createTarget({ type: 'hashtag', provider: 'public-web', label: '#话题先保存', locator: '#话题先保存' });
  let resolveAccount, enteredAccount;
  const accountStarted = new Promise(resolve => { enteredAccount = resolve; });
  const scheduler = new MonitorScheduler(db, { providerOptions: {
    cooldownMs: 0, topicResolverMode: 'browser',
    execFileImpl: (_file, _args, _options, callback) => { resolveAccount = callback; enteredAccount(); },
  } });
  scheduler.prepareTopicBrowserBatch = async () => new Map([['话题先保存', {
    label: '话题先保存', status: 'ok', snapshot: { hashtagParticipants: 123, hashtagViews: 4567 },
    raw: { source: 'isolated-priority-fixture' }, warnings: [],
  }]]);
  const collecting = scheduler.runAll();
  await accountStarted;
  try {
    assert.equal(scheduler.running, true);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM snapshots WHERE target_id=?').get(account.id).n, 0);
    const saved = db.db.prepare('SELECT hashtag_participants,hashtag_views FROM snapshots WHERE target_id=?').get(topic.id);
    assert.deepEqual({ ...saved }, { hashtag_participants: 123, hashtag_views: 4567 });
    assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM audits WHERE target_id=?').get(topic.id).n, 1);
  } finally {
    resolveAccount(null, JSON.stringify({ ok: true, data: {
      profile: { user: { sec_uid: account.locator, follower_count: 8, total_favorited: 100, aweme_count: 0 } },
      works: { aweme_list: [] },
    } }), '');
    await collecting;
  }
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM snapshots').get().n, 2,
    JSON.stringify(db.db.prepare('SELECT message FROM audits').all()));
});
