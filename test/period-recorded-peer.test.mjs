import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitorDatabase } from '../lib/database.mjs';
import { getProductInsights } from '../lib/product-insights.mjs';
import { buildRecordedWindowAlternative, projectRecordedWindow } from '../public/console-model.js';

function fixture(t, count = 1) {
  const directory = mkdtempSync(join(tmpdir(), 'recorded-peer-'));
  const database = new MonitorDatabase(join(directory, 'test.sqlite'));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  const targets = Array.from({ length: count }, (_, i) => database.createTarget({ type: 'account', label: `peer-${i}`,
    locator: `MS4wLjABAAAApeer${i}abcdefghijklmnop`, provider: 'public-web', metadata: { platform: 'douyin' } }));
  database.db.prepare('UPDATE targets SET created_at=?').run('2020-01-01T00:00:00.000Z');
  const sample = (index, capturedAt, values = [100, 1000, 10], quality = 'validated') => database.db.prepare(`INSERT INTO snapshots
    (target_id,captured_at,followers,total_likes,total_posts,quality_status,account_status,works_coverage,source_checksum)
    VALUES(?,?,?,?,?,?,'available','complete',?)`).run(targets[index].id, capturedAt, ...values, quality, `peer-${index}-${capturedAt}`);
  const result = (options = {}) => getProductInsights(database, { period: 'custom', startDate: '2026-09-23', endDate: '2026-09-29',
    reference: new Date('2026-09-28T16:01:00Z'), timeZone: 'Asia/Shanghai', ...options });
  return { database, targets, sample, result };
}

test('peer: Beijing midnight preserves last complete recorded date without rewriting strict endpoints or raw samples', t => {
  const { database, sample, result } = fixture(t);
  sample(0, '2026-09-22T15:59:00Z', [100, 1000, 10]);
  sample(0, '2026-09-28T15:59:00Z', [110, 1200, 12]);
  sample(0, '2026-09-28T16:02:00Z', [999, 9999, 99]); // future relative to reference
  const before = database.db.prepare('SELECT * FROM snapshots ORDER BY id').all();
  const value = result();
  assert.equal(value.summary.metrics.followers.delta, null);
  assert.equal(value.recordedWindow.baselineDate, '2026-09-22');
  assert.equal(value.recordedWindow.endDate, '2026-09-28');
  assert.equal(value.recordedWindow.metrics.followers.delta, 10);
  assert.equal(value.recordedWindow.metrics.estimatedPlays.delta, 20000);
  assert.equal(value.recordedWindow.accounts[0].metrics.followers.currentAt, '2026-09-28T15:59:00.000Z');
  assert.deepEqual(database.db.prepare('SELECT * FROM snapshots ORDER BY id').all(), before);
});

test('peer: missing month baseline uses common actual dates, not mixed per-account first observation windows', t => {
  const { sample, result } = fixture(t, 2);
  sample(0, '2026-09-02T02:00:00Z', [1, 10, 1]);
  sample(1, '2026-09-05T02:00:00Z', [10, 100, 1]);
  for (let index = 0; index < 2; index++) {
    sample(index, '2026-09-12T02:00:00Z', [100, 1000, 10]);
    sample(index, '2026-09-28T02:00:00Z', [120, 1100, 11]);
  }
  const value = result({ startDate: '2026-09-01' });
  assert.equal(value.summary.metrics.followers.delta, null);
  assert.equal(value.recordedWindow.baselineDate, '2026-09-12');
  assert.equal(value.recordedWindow.endDate, '2026-09-28');
  assert.equal(value.recordedWindow.metrics.followers.delta, 40);
  assert.equal(value.recordedWindow.metrics.followers.baseline, 200);
  assert.equal(value.recordedWindow.metrics.followers.percent, 20);
});

test('peer: exactly 90 percent common complete cohort is accepted; unpaired values remain only in strict source data', t => {
  const { sample, result } = fixture(t, 10);
  for (let index = 0; index < 10; index++) {
    sample(index, '2026-09-22T02:00:00Z');
    sample(index, '2026-09-28T02:00:00Z', [110, index === 9 ? null : 1100, 11]);
  }
  const value = result();
  assert.equal(value.recordedWindow.comparableCount, 9);
  for (const name of ['followers', 'likes', 'posts', 'estimatedPlays']) {
    assert.equal(value.recordedWindow.metrics[name].comparableCount, 9);
    assert.equal(value.recordedWindow.metrics[name].deltaReliable, true);
  }
  assert.equal(value.accounts[9].metrics.followers.value, 110);
  assert.equal(value.recordedWindow.accounts[9].metrics.followers.delta, null);
});

test('peer: below 90 percent is not upgraded from unrelated metric cohorts or rejected samples', t => {
  const { sample, result } = fixture(t, 10);
  for (let index = 0; index < 10; index++) {
    sample(index, '2026-09-22T02:00:00Z');
    sample(index, '2026-09-28T02:00:00Z', [110, index === 8 ? null : 1100, 11], index === 9 ? 'rejected' : 'validated');
  }
  assert.equal(result().recordedWindow, null);
});

test('peer: latest low-coverage date cannot replace earlier sufficiently observed shared end', t => {
  const { sample, result } = fixture(t, 10);
  for (let index = 0; index < 10; index++) {
    sample(index, '2026-09-22T02:00:00Z');
    sample(index, '2026-09-27T02:00:00Z', [110, 1100, 11]);
  }
  sample(0, '2026-09-28T02:00:00Z', [9999, 99999, 999]);
  const value = result();
  assert.equal(value.recordedWindow.endDate, '2026-09-27');
  assert.equal(value.recordedWindow.metrics.followers.delta, 100);
  assert.equal(value.accounts[0].metrics.followers.value, 9999);
});

test('peer: paused accounts excluded, real zero and negative changes preserved', t => {
  const { database, targets, sample, result } = fixture(t, 2);
  database.db.prepare('UPDATE targets SET enabled=0 WHERE id=?').run(targets[1].id);
  sample(0, '2026-09-22T02:00:00Z', [100, 0, 10]);
  sample(0, '2026-09-28T02:00:00Z', [100, 10, 9]);
  sample(1, '2026-09-22T02:00:00Z', [999, 999, 999]);
  sample(1, '2026-09-28T02:00:00Z', [99999, 99999, 99999]);
  const value = result();
  assert.equal(value.recordedWindow.enabledCount, 1);
  assert.equal(value.recordedWindow.metrics.followers.delta, 0);
  assert.equal(value.recordedWindow.metrics.likes.percent, null);
  assert.equal(value.recordedWindow.metrics.likes.delta, 10);
  assert.equal(value.recordedWindow.metrics.posts.delta, -1);
});

test('peer: one calendar date cannot manufacture observed growth and day remains strict', t => {
  const { sample, result } = fixture(t);
  sample(0, '2026-09-28T02:00:00Z');
  sample(0, '2026-09-28T10:00:00Z', [110, 1100, 11]);
  assert.equal(result().recordedWindow, null);
  assert.equal(result({ period: 'day', startDate: '2026-09-29', endDate: '2026-09-29' }).recordedWindow, null);
});

test('peer: explicit range comparison retains both strict endpoint results without current fallback', t => {
  const { sample, result } = fixture(t);
  sample(0, '2026-09-22T02:00:00Z');
  sample(0, '2026-09-25T02:00:00Z', [105, 1050, 10]);
  sample(0, '2026-09-28T02:00:00Z', [110, 1100, 11]);
  const value = result({ comparisonStartDate: '2026-09-20', comparisonEndDate: '2026-09-27' });
  assert.equal(value.recordedWindow, null);
  assert.equal(value.summary.metrics.followers.delta, null);
  assert.equal(value.comparison.summary.metrics.followers.delta, null);
  assert.equal(value.comparison.recordedWindow, null, 'comparison subtree also stays strict');
});

test('peer: strict week stays intact and common-window evidence is kept separate from unpaired accounts', t => {
  const { database, targets, sample, result } = fixture(t, 11);
  database.db.prepare('UPDATE targets SET enabled=0 WHERE id=?').run(targets[10].id);
  for (let index = 0; index < 10; index++) {
    sample(index, '2026-09-22T02:00:00Z');
    sample(index, '2026-09-28T02:00:00Z', [110, index === 9 ? null : 1100, 11]);
  }
  sample(10, '2026-09-24T02:00:00Z', [90, 900, 9]);
  const raw = result();
  const projected = projectRecordedWindow(raw, { period: 'week' });
  assert.equal(projected, raw, 'weekly main metrics are not silently replaced');
  const alternative = buildRecordedWindowAlternative(raw, { period: 'week' });
  assert.ok(alternative);
  assert.equal(alternative.comparableCount, 9);
  for (const index of [9, 10]) {
    const actual = projected.accounts[index].metrics.followers;
    const original = raw.accounts[index].metrics.followers;
    assert.equal(actual.value, original.value, `preserve stock for account ${index}`);
    assert.equal(actual.currentAt, original.currentAt, `preserve actual source time for account ${index}`);
    assert.equal(actual.delta, null);
    assert.equal(actual.comparable, false);
  }
  assert.equal(projected.summary.metrics.followers.delta, null, 'exact range keeps missing start baseline unknown');
  assert.equal(raw.summary.metrics.followers.delta, null, 'original strict data unmodified');
});
