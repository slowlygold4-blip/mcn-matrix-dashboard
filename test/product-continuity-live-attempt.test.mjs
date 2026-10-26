import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitorDatabase } from '../lib/database.mjs';
import { getProductContinuity } from '../lib/product-continuity.mjs';

const now = new Date('2026-09-27T03:00:00Z');
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'continuity-live-attempt-'));
  const database = new MonitorDatabase(join(directory, 'fixture.sqlite'));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  const target = database.createTarget({ type: options.type || 'account', provider: 'public-web', label: '测试作者', locator: 'MS4wLjTEST' });
  const run = database.beginRun('scheduled', null, options.count ?? 1);
  database.db.prepare('UPDATE runs SET started_at=?,finished_at=?,details_json=? WHERE id=?').run(
    '2026-09-27T02:00:00Z', options.finishedAt ?? null,
    JSON.stringify(options.detail ? [{ targetId: target.id, ...options.detail }] : []), run);
  const insertSnapshot = (overrides = {}) => {
    const s = { at: '2026-09-27T02:01:00Z', checksum: 'exact', quality: 'warning', account: 'available', works: 'unavailable', followers: 0, likes: 0, posts: 0, participants: null, views: null, ...overrides };
    database.db.prepare(`INSERT INTO snapshots(target_id,captured_at,source_checksum,quality_status,account_status,works_coverage,followers,total_likes,total_posts,hashtag_participants,hashtag_views,warnings_json,raw_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'[]','{}')`).run(target.id,s.at,s.checksum,s.quality,s.account,s.works,s.followers,s.likes,s.posts,s.participants,s.views);
  };
  if (options.snapshot !== false) insertSnapshot(options.snapshot);
  database.db.prepare(`INSERT INTO audits(target_id,run_id,created_at,provider,status,warnings_json,source_checksum,message)
    VALUES(?,?,?,'public-web',?,'["作品接口 HTTP 403"]',?,'作品访问受限')`).run(
      target.id,run,options.auditAt || '2026-09-27T02:02:00Z',options.status || 'warning',options.checksum ?? 'exact');
  const plan = () => getProductContinuity(database, { running: true }, { now, timeZone: 'Asia/Shanghai' }).todayPlan;
  return { database, target, run, plan, insertSnapshot };
}

test('active works retry retains exact same-attempt zero-valued profile without claiming complete works', t => {
  const f = fixture(t, { count: 2 });
  const p = f.plan();
  assert.equal(p.profileSuccessfulTargetCount, 1);
  assert.equal(p.completedTargetCount, 0);
  assert.equal(p.retryTargetCount, 1);
  assert.equal(p.denominatorComplete, false);
  assert.equal(p.profileCoveragePercent, null);
  assert.match(p.denominatorReason, /仍在运行中/);
});

test('incomplete counters and rejected snapshots cannot promote available account status to profile success', t => {
  for (const snapshot of [{ followers: null }, { likes: null }, { posts: null }, { likes: -1 }, { quality: 'rejected' }]) {
    const f = fixture(t, { snapshot });
    assert.equal(f.plan().profileSuccessfulTargetCount, 0, JSON.stringify(snapshot));
  }
});

test('snapshot binding rejects mismatched or blank checksum and out-of-attempt capture times', t => {
  for (const options of [
    { checksum: 'different' }, { checksum: '', snapshot: { checksum: '' } },
    { snapshot: { at: '2026-09-27T01:59:59Z' } },
    { snapshot: { at: '2026-09-27T02:02:01Z' } },
    { finishedAt: '2026-09-27T02:00:30Z' },
  ]) assert.equal(fixture(t, options).plan().profileSuccessfulTargetCount, 0, JSON.stringify(options));
});

test('error and rejected audits cannot reuse a same-checksum valid snapshot', t => {
  for (const status of ['error', 'rejected']) {
    const p = fixture(t, { status }).plan();
    assert.equal(p.profileSuccessfulTargetCount, 0);
    assert.equal(p.completedTargetCount, 0);
  }
});

test('future audit does not affect an earlier continuity reference', t => {
  const p = fixture(t, { auditAt: '2026-09-27T03:00:01Z' }).plan();
  assert.equal(p.profileSuccessfulTargetCount, 0);
  assert.equal(p.recordedTargetCount, 0);
});

test('explicit detail false and detail errors override same-run successful audit evidence', t => {
  for (const detail of [
    { status: 'warning', profileUsable: false, accountStatus: 'available', reviewState: 'retry' },
    { status: 'error' }, { status: 'rejected' }, { status: 'skipped' },
    { status: 'warning', accountStatus: 'unavailable' },
  ]) assert.equal(fixture(t, { detail }).plan().profileSuccessfulTargetCount, 0, JSON.stringify(detail));
});

test('omitted detail counters can recover only the matching audit evidence', t => {
  const p = fixture(t, { detail: { status: 'warning', reviewState: 'retry' } }).plan();
  assert.equal(p.profileSuccessfulTargetCount, 1);
  assert.equal(p.completedTargetCount, 0);
});

test('topic zero values complete, but a missing or rejected real topic counter remains retry', t => {
  for (const [snapshot, expected] of [
    [{ participants: 0, views: 0 }, 1],
    [{ participants: 0, views: null }, 0],
    [{ participants: null, views: 0 }, 0],
    [{ participants: 0, views: 0, quality: 'rejected' }, 0],
  ]) {
    const p = fixture(t, { type: 'hashtag', snapshot: { account: 'unknown', works: 'unknown', ...snapshot },
      detail: { status: 'warning', accountStatus: 'unknown', worksCoverage: 'unknown', profileUsable: false } }).plan();
    assert.equal(p.completedTargetCount, expected, JSON.stringify(snapshot));
    assert.equal(p.retryTargetCount, 1 - expected);
  }
});

test('new failed attempt replaces earlier same-day success without borrowing its snapshot', t => {
  const f = fixture(t);
  const next = f.database.beginRun('scheduled', null, 1);
  f.database.db.prepare('UPDATE runs SET started_at=? WHERE id=?').run('2026-09-27T02:30:00Z', next);
  f.database.db.prepare(`INSERT INTO audits(target_id,run_id,created_at,provider,status,warnings_json,source_checksum,message)
    VALUES(?,?,?,'public-web','error','[]','exact','network error')`).run(f.target.id,next,'2026-09-27T02:31:00Z');
  const p = f.plan();
  assert.equal(p.profileSuccessfulTargetCount, 0);
  assert.equal(p.retryTargetCount, 1);
});

test('validated topic audit without an exactly matched snapshot cannot manufacture metrics completion', t => {
  for (const options of [{ snapshot: false }, { checksum: 'different' }, { checksum: '', snapshot: { checksum: '', participants: 0, views: 0 } }]) {
    const p = fixture(t, { type: 'hashtag', status: 'validated', ...options,
      detail: { status: 'validated', reviewState: 'complete', profileUsable: false } }).plan();
    assert.equal(p.completedTargetCount, 0);
    assert.equal(p.profileSuccessfulTargetCount, 0);
    assert.equal(p.retryTargetCount, 1);
  }
});
