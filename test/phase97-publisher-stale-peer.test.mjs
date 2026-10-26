// Independent diagnosis: actual publisher gate and actual public exporter.
// Synthetic in-memory database only. No real state, credentials, HTTP, timer,
// publisher entrypoint, platform collection, server or Site checkout access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { exportPublicReplica, serializePublicReplica, PUBLIC_REPLICA_EXPORT_REVISION } from '../lib/public-replica-export.mjs';
import { shouldStagePublicReplica, validatedReceipt } from '../scripts/public-replica-publisher.mjs';

const oldAsOf = '2026-10-02T01:45:02.024Z';
const confirmed = '2026-10-02T01:52:45.556Z';
const start = '2026-10-02T02:00:15.599Z';
const beforeStart = new Date(Date.parse(start) - 1).toISOString();
const now = '2026-10-02T03:24:06.050Z';
const state = { version: 1, active: null, publishedAsOf: oldAsOf,
  lastConfirmedPublishedAt: confirmed, exportRevision: PUBLIC_REPLICA_EXPORT_REVISION,
  coveredMarker: 'synthetic-covered' };

test('actual publisher gate: one scheduled run vetoes a new eligible completed receipt beyond cadence', () => {
  const run = { id: 2, trigger_type: 'works-only', status: 'partial',
    started_at: '2026-10-02T01:58:15.636Z', finished_at: '2026-10-02T01:58:47.587Z' };
  const receipt = { version: 1, runId: 2, eventId: 'collection-run-2', triggerType: run.trigger_type,
    runStatus: run.status, startedAt: run.started_at, finishedAt: run.finished_at,
    reviewedAt: '2026-10-02T01:58:47.600Z' };
  const observed = { running: true, marker: 'synthetic-changed' };
  assert.equal(validatedReceipt(run, receipt, Date.parse(now)), true);
  assert.ok(Date.parse(run.finished_at) > Date.parse(oldAsOf));
  assert.ok(Date.parse(now) - Date.parse(oldAsOf) > 30 * 60_000);
  assert.equal(shouldStagePublicReplica(state, observed, Date.parse(now)), false);
  assert.equal(shouldStagePublicReplica(state, { ...observed, running: false }, Date.parse(now)), true,
    'negative control: only the running flag differs');
  assert.equal(shouldStagePublicReplica(state, observed, Date.parse(now) + 24 * 60 * 60_000), false,
    'the whole-run veto has no age-based release');
});

function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
  const database = new MonitorDatabase(':memory:');
  t.after(() => database.close());
  const target = database.createTarget({ type: 'account', label: 'Synthetic publisher boundary',
    locator: 'MS4wLjABAAAAPhase97PublisherSynthetic', provider: 'public-web', metadata: { platform: 'douyin' } });
  const at = value => t.mock.timers.setTime(Date.parse(value));
  function sample(runId, capturedAt, followers) {
    at(capturedAt);
    const raw = { capturedAt, profile: { user: { sec_uid: target.locator, uid: '123456789',
      follower_count: followers, total_favorited: followers * 10, aweme_count: 0 } },
      works: { aweme_list: [], has_more: false } };
    database.saveCollection(target, runId, normalizeCollection(target, raw, { capturedAt }));
  }
  at('2026-10-02T01:58:00.000Z');
  const oldRun = database.beginRun('scheduled', target.id, 1);
  sample(oldRun, '2026-10-02T01:58:01.000Z', 10);
  at('2026-10-02T01:58:02.000Z');
  database.finishRun(oldRun, { status: 'success', successCount: 1 });
  at(start);
  const runningRun = database.beginRun('scheduled', target.id, 1);
  sample(runningRun, start, 20);
  at(now);
  function read(asOf = now) {
    const before = database.db.prepare('SELECT total_changes() n').get().n;
    database.db.exec('BEGIN');
    try {
      const result = exportPublicReplica(database, { asOf });
      assert.equal(database.db.prepare('SELECT total_changes() n').get().n, before);
      const serialized = serializePublicReplica(result);
      assert.equal(JSON.stringify(serialized).includes(target.locator), false);
      return result;
    } finally { database.db.exec('ROLLBACK'); }
  }
  return { database, target, runningRun, at, sample, read };
}

test('actual exporter: deleting the running gate alone would expose new daily numbers while strict coverage stays old', t => {
  const { database, runningRun, read } = fixture(t);
  const result = read();
  const account = result.catalog.accounts[0];
  assert.equal(database.db.prepare('SELECT status FROM runs WHERE id=?').get(runningRun).status, 'running');
  assert.equal(account.latest.followers.value, 20);
  assert.equal(account.latest.followers.observedAt, start);
  assert.equal(account.coverage.profileObservedAt, '2026-10-02T01:58:01.000Z');
  const daily = result.partitions.find(part => part.kind === 'daily').items;
  assert.equal(daily.length, 1);
  assert.equal(daily[0].followers, 20);
  assert.equal(daily[0].sampleCount, 2);
  assert.equal(result.policy.independentlyVerified, false);
  assert.equal(result.policy.platformComplete, false);
});

test('actual exporter: a strict pre-running cutoff excludes even a sample captured exactly at scheduled start', t => {
  const { read } = fixture(t);
  const result = read(beforeStart), account = result.catalog.accounts[0];
  assert.equal(result.asOf, beforeStart);
  assert.equal(account.latest.followers.value, 10);
  assert.equal(account.latest.followers.observedAt, '2026-10-02T01:58:01.000Z');
  assert.equal(account.coverage.profileObservedAt, '2026-10-02T01:58:01.000Z');
  assert.ok(Date.parse(account.latest.followers.observedAt) > Date.parse(oldAsOf));
  assert.equal(result.partitions.find(part => part.kind === 'daily').items[0].sampleCount, 1);
});

test('actual exporter: run completion changes coverage, never retroactively relabels the old cutoff', t => {
  const { database, runningRun, at, read } = fixture(t);
  const before = read(beforeStart);
  at('2026-10-02T03:23:00.000Z');
  database.finishRun(runningRun, { status: 'partial', successCount: 1 });
  at(now);
  const after = read();
  assert.equal(after.catalog.accounts[0].latest.followers.value, 20);
  assert.equal(after.catalog.accounts[0].coverage.profileObservedAt, start);
  assert.deepEqual(serializePublicReplica(read(beforeStart)), serializePublicReplica(before));
});

test('actual publisher gate keeps marker, active generation and rolled-back clock protections independent of running', () => {
  const observed = { running: false, marker: 'synthetic-changed' };
  assert.equal(shouldStagePublicReplica(state, { ...observed, marker: state.coveredMarker }, Date.parse(now)), false);
  assert.equal(shouldStagePublicReplica({ ...state, active: { asOf: oldAsOf } }, observed, Date.parse(now)), false);
  assert.equal(shouldStagePublicReplica(state, observed, Date.parse(confirmed) - 1), false);
  const original = JSON.stringify({ state, observed });
  shouldStagePublicReplica(state, observed, Date.parse(now));
  assert.equal(JSON.stringify({ state, observed }), original);
});
