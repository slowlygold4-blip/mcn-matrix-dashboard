import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { inspectUpdateSla } from '../lib/update-sla.mjs';
import { checksum } from '../lib/utils.mjs';

const CAPTURED = '2026-10-05T02:00:00.000Z';
function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(CAPTURED) - 2000 });
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const target = database.createTarget({ type: 'hashtag', provider: 'public-web', locator: 'isolated topic', label: '#isolated topic' });
  const run = database.beginRun('scheduled', target.id, 1);
  t.mock.timers.setTime(Date.parse(CAPTURED));
  const raw = { scope: 'douyin-official-challenge-detail', businessStatusCode: 0, challengeId: '1617668778418189',
    label: 'isolated topic', officialName: 'isolated topic', participants: 0, views: 0,
    provenance: { mode: 'douyin-official-anonymous-challenge-detail', endpoint: 'https://www.douyin.com/aweme/v1/web/challenge/detail/',
      authenticated: false, runtimeAI: false, paidAPI: false } };
  database.saveCollection(target, run, { capturedAt: CAPTURED, snapshot: { hashtagParticipants: 0, hashtagViews: 0 },
    posts: [], qualityStatus: 'validated', raw });
  t.mock.timers.setTime(Date.parse(CAPTURED) + 100);
  database.finishRun(run, { status: 'success', successCount: 1 });
  return { database, target, run, raw, now: new Date(Date.parse(CAPTURED) + 1000) };
}

const sourceRows = database => ['targets', 'snapshots', 'audits', 'runs'].map(name => database.db.prepare(`SELECT * FROM ${name} ORDER BY id`).all());

test('topic SLA accepts genuine legacy official zero counters without rewriting the persisted source', t => {
  const f = fixture(t), before = sourceRows(f.database);
  const result = inspectUpdateSla(f.database.db, { now: f.now });
  assert.equal(result.topics.daily.complete, 1); assert.equal(result.topics.fresh8h.complete, 1);
  assert.deepEqual(sourceRows(f.database), before);
});

for (const [name, mutate, rehash] of [
  ['raw checksum changed', f => f.database.db.prepare("UPDATE snapshots SET raw_json='{}'").run(), false],
  ['stored counter disagrees', f => f.database.db.prepare('UPDATE snapshots SET hashtag_views=1').run(), false],
  ['explicit payload time disagrees', f => { f.raw.capturedAt = '2026-10-05T01:59:59.999Z'; }, true],
  ['new time contract lacks payload time', f => { f.raw.topicTimeContractVersion = 1; }, true],
  ['foreign topic identity', f => { f.raw.officialName = 'another topic'; }, true],
  ['foreign endpoint', f => { f.raw.provenance.endpoint = 'https://example.invalid/'; }, true],
]) test(`topic SLA rejects ${name} even when DB audit fields still look complete`, t => {
  const f = fixture(t); mutate(f);
  if (rehash) {
    const digest = checksum(f.raw);
    f.database.db.prepare('UPDATE snapshots SET raw_json=?,source_checksum=?').run(JSON.stringify(f.raw), digest);
    f.database.db.prepare('UPDATE audits SET source_checksum=?').run(digest);
  }
  const before = sourceRows(f.database), result = inspectUpdateSla(f.database.db, { now: f.now });
  assert.equal(result.topics.daily.complete, 0); assert.equal(result.topics.fresh8h.complete, 0);
  assert.deepEqual(sourceRows(f.database), before);
});
