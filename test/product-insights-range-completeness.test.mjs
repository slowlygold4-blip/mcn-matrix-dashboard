import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MonitorDatabase } from '../lib/database.mjs';
import { getProductInsights, getAccountInsight } from '../lib/product-insights.mjs';
import { checksum } from '../lib/utils.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'range-completeness-'));
  const database = new MonitorDatabase(join(directory, 'test.sqlite'));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  const target = database.createTarget({ type: 'account', label: '日期范围测试作者',
    locator: 'MS4wLjABAAAArangecompletenessexample', provider: 'public-web', metadata: { platform: 'douyin' } });
  database.db.prepare('UPDATE targets SET created_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z', target.id);
  for (const [capturedAt, followers] of [
    ['2026-09-24T02:00:00.000Z', 100], ['2026-09-25T02:00:00.000Z', 110],
    ['2026-09-26T02:00:00.000Z', 120], ['2026-09-26T12:00:00.000Z', 999],
  ]) {
    const raw = { capturedAt, profile: { user: { sec_uid: target.locator, uid: '222523170759696',
      follower_count: followers, total_favorited: followers * 10, aweme_count: 10 } }, works: { aweme_list: [] } };
    database.db.prepare(`INSERT INTO snapshots(target_id,captured_at,followers,total_likes,total_posts,
      quality_status,account_status,works_coverage,source_checksum,raw_json) VALUES(?,?,?,?,?,'validated','available','unknown',?,?)`)
      .run(target.id, capturedAt, followers, followers * 10, 10, checksum(raw), JSON.stringify(raw));
  }
  const read = (options = {}) => getProductInsights(database, {
    period: 'custom', timeZone: 'Asia/Shanghai', startDate: '2026-09-26', endDate: '2026-09-26',
    reference: new Date('2026-09-26T08:00:00.000Z'), ...options,
  });
  return { database, target, read };
}

test('Beijing current custom day remains partial until its actual end, not host midnight', (t) => {
  const { read } = fixture(t);
  const result = read();
  assert.equal(result.range.partialEndDay, true);
  assert.equal(result.range.start, '2026-09-25T16:00:00.000Z');
  assert.equal(result.range.end, '2026-09-26T08:00:00.000Z');
  assert.equal(result.end, result.range.end);
  assert.equal(result.summary.metrics.followers.value, 120, 'later same-day snapshots remain excluded');
});

test('Beijing previous custom day is complete and capped at its own end', (t) => {
  const { read } = fixture(t);
  const result = read({ startDate: '2026-09-25', endDate: '2026-09-25' });
  assert.equal(result.range.partialEndDay, false);
  assert.equal(result.range.start, '2026-09-24T16:00:00.000Z');
  assert.equal(result.range.end, '2026-09-25T15:59:59.999Z');
  assert.equal(result.summary.metrics.followers.value, 110);
});

test('UTC 16:00 changes the Beijing day without marking the new day complete', (t) => {
  const { read } = fixture(t);
  const before = read({ startDate: '2026-09-25', endDate: '2026-09-25', reference: new Date('2026-09-25T15:59:59.998Z') });
  assert.equal(before.range.partialEndDay, true);
  assert.equal(before.range.end, '2026-09-25T15:59:59.998Z');
  const boundary = read({ reference: new Date('2026-09-25T16:00:00.000Z') });
  assert.equal(boundary.range.partialEndDay, true);
  assert.equal(boundary.range.start, boundary.range.end);
  assert.equal(boundary.range.end, '2026-09-25T16:00:00.000Z');
  const previous = read({ startDate: '2026-09-25', endDate: '2026-09-25', reference: new Date('2026-09-25T16:00:00.000Z') });
  assert.equal(previous.range.partialEndDay, false);
});

test('the exact final millisecond is complete and an earlier millisecond is partial', (t) => {
  const { read } = fixture(t);
  for (const [timestamp, partial] of [['2026-09-26T15:59:59.998Z', true], ['2026-09-26T15:59:59.999Z', false]]) {
    const result = read({ reference: new Date(timestamp) });
    assert.equal(result.range.partialEndDay, partial);
    assert.equal(result.range.end, timestamp);
  }
});

test('a multi-day range ending today still marks only the ending day as partial', (t) => {
  const { read } = fixture(t);
  const result = read({ startDate: '2026-09-12' });
  assert.equal(result.range.days, 15);
  assert.equal(result.range.start, '2026-09-11T16:00:00.000Z');
  assert.equal(result.range.end, '2026-09-26T08:00:00.000Z');
  assert.equal(result.range.partialEndDay, true);
});

test('main and comparison ranges calculate ending-day completeness independently', (t) => {
  const { read } = fixture(t);
  const current = read({ comparisonStartDate: '2026-09-24', comparisonEndDate: '2026-09-25' });
  assert.equal(current.range.partialEndDay, true);
  assert.equal(current.comparison.range.partialEndDay, false);
  assert.equal(current.comparison.range.end, '2026-09-25T15:59:59.999Z');
  const historical = read({ startDate: '2026-09-24', endDate: '2026-09-25',
    comparisonStartDate: '2026-09-26', comparisonEndDate: '2026-09-26' });
  assert.equal(historical.range.partialEndDay, false);
  assert.equal(historical.comparison.range.partialEndDay, true);
  assert.equal(historical.comparison.range.end, historical.referenceAt);
});

test('default host-timezone custom ranges retain their prior local-day semantics', (t) => {
  const { read } = fixture(t);
  const reference = new Date(2026, 8, 26, 14, 30, 0, 0);
  const current = read({ timeZone: undefined, reference });
  assert.equal(current.range.partialEndDay, true);
  assert.equal(current.range.start, new Date(2026, 8, 26, 0, 0, 0, 0).toISOString());
  assert.equal(current.range.end, reference.toISOString());
  const previous = read({ timeZone: undefined, reference, startDate: '2026-09-25', endDate: '2026-09-25' });
  assert.equal(previous.range.partialEndDay, false);
  assert.equal(previous.range.end, new Date(2026, 8, 25, 23, 59, 59, 999).toISOString());
});

test('range reads never exceed reference or rewrite raw snapshots, including account comparisons', (t) => {
  const { database, target, read } = fixture(t);
  const before = database.db.prepare('SELECT * FROM snapshots ORDER BY id').all();
  const changes = database.db.prepare('SELECT total_changes() AS count').get().count;
  for (const reference of ['2026-09-25T16:00:00.000Z', '2026-09-26T08:00:00.000Z', '2026-09-26T15:59:59.999Z']) {
    const result = read({ reference: new Date(reference), comparisonStartDate: '2026-09-24', comparisonEndDate: '2026-09-25' });
    assert.ok(Date.parse(result.end) <= Date.parse(reference));
    assert.ok(Date.parse(result.comparison.end) <= Date.parse(reference));
  }
  const detail = getAccountInsight(database, target.id, { period: 'custom', timeZone: 'Asia/Shanghai',
    reference: new Date('2026-09-26T08:00:00.000Z'), startDate: '2026-09-26', endDate: '2026-09-26',
    comparisonStartDate: '2026-09-25', comparisonEndDate: '2026-09-25' });
  assert.equal(detail.range.partialEndDay, true);
  assert.equal(detail.comparison.range.partialEndDay, false);
  assert.equal(detail.account.metrics.followers.value, 120);
  assert.deepEqual(database.db.prepare('SELECT * FROM snapshots ORDER BY id').all(), before);
  assert.equal(database.db.prepare('SELECT total_changes() AS count').get().count, changes);
});
