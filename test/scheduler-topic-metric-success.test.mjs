import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MonitorDatabase } from '../lib/database.mjs';
import { MonitorScheduler } from '../lib/scheduler.mjs';
import { buildPostIngestionReview } from '../lib/post-ingestion-review.mjs';

for (const [participants, views, usable] of [[null,null,false],[12,null,false],[null,34,false],[0,0,true],[12,34,true]]) {
  test(`topic run success requires both actual counters: ${participants}/${views}`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'topic-success-'));
    const db = new MonitorDatabase(join(directory, 'fixture.sqlite'));
    t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
    const target = db.createTarget({ type:'hashtag', provider:'public-web', label:'#话题计数契约', locator:'#话题计数契约' });
    const scheduler = new MonitorScheduler(db, { providerOptions: { cooldownMs:0, topicResolverMode:'browser',
      execFileImpl: () => { throw new Error('Fixture must not start external collection'); } } });
    scheduler.prepareTopicBrowserBatch = async () => new Map([['话题计数契约', {
      label:'话题计数契约', status:'ok', snapshot:{hashtagParticipants:participants,hashtagViews:views},
      raw:{source:'isolated-topic-metric-fixture'}, warnings:['限定来源说明'],
    }]]);
    const result = await scheduler.runAll();
    assert.equal(result.successCount, Number(usable));
    assert.equal(result.errorCount, Number(!usable));
    assert.equal(result.status, usable ? 'success' : 'error');
    assert.equal(result.details[0].topicMetricsUsable, usable);
    if (!usable) assert.equal(result.details[0].reviewState, 'retry');
    const stored = db.db.prepare('SELECT hashtag_participants,hashtag_views FROM snapshots WHERE target_id=?').get(target.id);
    assert.deepEqual({...stored}, {hashtag_participants:participants,hashtag_views:views}, 'keep partial evidence; never manufacture zeros');
    const review = buildPostIngestionReview({ database:db, runId:result.runId });
    assert.equal(review.topics.usable, Number(usable), 'run counts and immutable metric review must agree');
    assert.equal(review.topics.missing, Number(!usable));
  });
}
