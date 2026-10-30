import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { metricInstant } from '../lib/work-metric-clock.mjs';
import { workMetricInstant, indexWorkObservations, adoptWorkMetric } from '../lib/work-metric-adoption.mjs';
import { summarizeWorkLikeComparability, readWorkLikeComparability } from '../lib/work-like-comparability.mjs';

test('impossible metric clocks cannot roll into a different publication or observation day', () => {
  for (const clock of ['2026-10-29T24:00:00Z', '2026-02-30T12:00:00Z', '2026-10-29T12:60:00Z',
    '2026-10-29T12:00:60Z', '2026-10-29', '10/29/2026', '2026-10-29T12:00:00+24:00', null, 1793260800000]) {
    assert.equal(metricInstant(clock), null, String(clock));
    assert.equal(workMetricInstant(clock), null, String(clock));
    assert.equal(metricInstant(clock, { legacyUtc: true }), null, String(clock));
  }
  assert.equal(metricInstant('2024-02-29T23:59:59.123+08:00'), '2024-02-29T15:59:59.123Z');
  assert.equal(metricInstant('2026-10-29T15:59:59.123456Z'), '2026-10-29T15:59:59.123Z');
  assert.equal(metricInstant('2026-10-29 15:59:59'), null, 'only the legacy storage reader opts into UTC');
  assert.equal(metricInstant('2026-10-29T15:59:59'), null, 'external source time needs a zone');
});

test('SQLite legacy UTC and zoned clocks produce the same Beijing baseline on every host timezone', () => {
  const module = new URL('../lib/work-like-comparability.mjs', import.meta.url).href;
  const code = `import {summarizeWorkLikeComparability as summarize} from ${JSON.stringify(module)};
    const enabled=[{id:1,type:'account',platform:'douyin'}];
    const row=(captured_at,likes)=>({external_id:'work',target_id:1,captured_at,likes});
    console.log(JSON.stringify(summarize([row('2026-10-29 15:59:59',1),row('2026-10-29T16:00:00Z',2)],
      {enabled,asOf:'2026-10-29T17:00:00.000Z'})));`;
  const results = ['UTC', 'America/Los_Angeles', 'Asia/Shanghai'].map(TZ => JSON.parse(execFileSync(process.execPath,
    ['--input-type=module', '-e', code], { env: { ...process.env, TZ }, encoding: 'utf8' })));
  for (const result of results) assert.deepEqual(result.platforms, [{ platform: 'douyin', knownTodayWorks: 1,
    comparableWorks: 1, missingBaselineWorks: 0, conflictingWorks: 0 }]);
  assert.deepEqual(results[0], results[1]); assert.deepEqual(results[1], results[2]);
});

test('invalid observed clocks cannot displace a dated value or become a daily change baseline', () => {
  const asOf = '2026-10-30T05:00:00.000Z', bad = '2026-10-29T24:00:00Z';
  const observations = indexWorkObservations([{ contentId: '123', douyinId: 'owner', likes: 99,
    observedAt: bad, timeBasis: 'metric-observation' }], asOf);
  assert.equal(observations.size, 0);
  const adopted = adoptWorkMetric({ metric: 'likes', sourceValue: 3, platformValue: 99,
    platformObservedAt: bad, asOf });
  assert.equal(adopted.value, 3); assert.equal(adopted.platformUsable, false);
  const result = summarizeWorkLikeComparability([{ external_id: '123', target_id: 1, likes: 99, captured_at: bad }],
    { enabled: [{ id: 1, type: 'account', platform: 'douyin' }], asOf });
  assert.equal(result.platforms[0].knownTodayWorks, 0);
});

test('daily DB reader agrees with SQLite instants, preserves real zero and rejects rolling clocks without writes', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE targets(id INTEGER,type TEXT,enabled INTEGER);
    CREATE TABLE posts(id INTEGER,target_id INTEGER,external_id TEXT,first_seen_at TEXT);
    CREATE TABLE post_metrics(post_id INTEGER,captured_at TEXT,likes);
    INSERT INTO targets VALUES(1,'account',1);
    INSERT INTO posts VALUES(1,1,'real','2026-09-12T00:00:00Z'),(2,1,'bad','2026-09-12T00:00:00Z');
    INSERT INTO post_metrics VALUES(1,'2026-10-29 15:59:59',0),(1,'2026-10-29T16:00:00Z',0),
      (2,'2026-10-28T16:00:00Z',1),(2,'2026-10-29T24:00:00Z',99);`);
  const old = db.prepare('SELECT total_changes() n').get().n;
  for (const clock of ['2026-10-29 15:59:59', '2026-10-30T00:00:00+08:00']) {
    const sql = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ',?) instant").get(clock).instant;
    assert.equal(metricInstant(clock, { legacyUtc: true }), sql);
  }
  const result = readWorkLikeComparability(db, [{ id: 1, type: 'account', platform: 'douyin' }], '2026-10-30T05:00:00.000Z');
  assert.deepEqual(result.platforms[0], { platform: 'douyin', knownTodayWorks: 1, comparableWorks: 1,
    missingBaselineWorks: 0, conflictingWorks: 0 });
  assert.equal(db.prepare('SELECT total_changes() n').get().n, old);
  assert.equal(db.prepare('SELECT count(*) n FROM post_metrics').get().n, 4);
});
