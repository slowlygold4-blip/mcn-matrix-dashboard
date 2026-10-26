import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitorDatabase } from '../lib/database.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { recordWorksOnlyObservation } from '../lib/works-only-observation.mjs';
import * as scheduling from '../lib/works-only-scheduler.mjs';

const BASE = Date.parse('2026-09-29T03:00:00.000Z');
const slot = { startsAt: '2026-09-29T02:00:00.000Z', endsAt: '2026-09-29T10:00:00.000Z' };
const iso = ms => new Date(ms).toISOString();
function fixture(t, { disk = false } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: BASE });
  const directory = disk ? mkdtempSync(join(tmpdir(), 'works-failure-peer-')) : null;
  const path = directory ? join(directory, 'fixture.sqlite') : ':memory:';
  const database = new MonitorDatabase(path);
  t.after(() => { database.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  const targets = Array.from({ length: 12 }, (_, i) => database.createTarget({ type: 'account', provider: 'public-web',
    locator: `MS4wLjABAAAAFailureIndependentAccount${1000 + i}`, label: 'offline-only', metadata: { platform: 'douyin' } }));
  function attempt(index, at = BASE, { attempted = true, errorCode = 'collector_error', status = 'error', trigger = 'works-only', wrongTarget = false } = {}) {
    const target = targets[index]; t.mock.timers.setTime(at);
    const id = database.beginRun(trigger, target.id, 1);
    t.mock.timers.setTime(at + 1);
    database.finishRun(id, { status, successCount: status === 'partial' ? 1 : 0, errorCount: status === 'error' ? 1 : 0,
      processedCount: 1, details: [{ targetId: wrongTarget ? targets[(index + 1) % targets.length].id : target.id,
        mode: 'works-only', attempted, errorCode, ...(status === 'partial' ? { coverage: 'limited', observationId: 999 } : {}) }] });
    return id;
  }
  function failures(count = 5) { return Array.from({ length: count }, (_, i) => attempt(i, BASE + i * 1000)); }
  function accepted(index, at) {
    const target = targets[index], uid = String(100000000 + index), capturedAt = iso(at - 1000);
    t.mock.timers.setTime(at - 1000);
    const raw = { capturedAt, accountStatus: 'validated', accountError: null,
      profile: { user: { sec_uid: target.locator, uid, follower_count: 1, total_favorited: 2, aweme_count: 1 } },
      worksCoverage: 'unavailable', worksErrorCode: 'deferred', works: { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } },
      provenance: { mode: 'guest-ttwid-unsigned-profile', profileMode: 'guest-ttwid-unsigned-profile',
        profileEndpoint: 'https://www.douyin.com/aweme/v1/web/user/profile/other/', accountLocator: 'sec_uid', cookiePersisted: false, runtimeAI: false, paidAPI: false } };
    const profileRun = database.beginRun('manual', target.id, 1);
    database.saveCollection(target, profileRun, normalizeCollection(target, raw, { capturedAt }));
    database.finishRun(profileRun, { status: 'success', successCount: 1 });
    const anchor = database.db.prepare('SELECT id,source_checksum FROM snapshots WHERE target_id=?').get(target.id);
    t.mock.timers.setTime(at); const runId = database.beginRun('works-only', target.id, 1);
    t.mock.timers.setTime(at + 1000);
    recordWorksOnlyObservation(database.db, { targetId: target.id, runId, anchorSnapshotId: anchor.id, anchorChecksum: anchor.source_checksum,
      requestStartedAt: iso(at), requestFinishedAt: iso(at + 1000), result: { status: 'ok', hasMore: false, maxCursor: 0,
        posts: [{ aweme_id: '7200000000000000001', author: { sec_uid: target.locator, uid }, statistics: { digg_count: 1 } }],
        pagination: { version: 1, maxPages: 3, requestCount: 1, collectedCount: 1, stopReason: 'end-of-list', errorCode: null,
          pages: [{ requestCursor: 0, response: { max_cursor: 0, has_more: false }, rawCount: 1, acceptedCount: 1,
            duplicateCount: 0, filteredCount: 0, truncated: false, observedAt: iso(at + 500) }] } } }, { now: at + 1000 });
    t.mock.timers.setTime(at + 1001);
    database.finishRun(runId, { status: 'partial', successCount: 1, warningCount: 1,
      details: [{ targetId: target.id, mode: 'works-only', attempted: true, errorCode: null, coverage: 'limited' }] });
    return runId;
  }
  const gate = (at = BASE + 60_000) => scheduling.worksOnlyRetryGate(database, { now: new Date(at), slot });
  return { database, targets, attempt, failures, accepted, gate, path };
}

test('failure peer: five actual distinct failures persist a 15-minute transport-only pause, without writes', t => {
  const f = fixture(t); f.failures();
  const before = f.database.db.prepare('SELECT total_changes() n').get().n;
  const result = f.gate();
  assert.equal(result.deferred, true); assert.equal(result.failureCount, 5);
  assert.equal(result.nextEligibleAt, iso(BASE + 4001 + 15 * 60_000));
  assert.equal(typeof result.reason, 'string');
  assert.deepEqual(f.gate(), result, 'reading again does not clear persisted failure evidence');
  assert.equal(f.database.db.prepare('SELECT total_changes() n').get().n, before);
});

test('failure peer: four distinct failures or repeated same author cannot claim a shared five-author failure', t => {
  const f = fixture(t); f.failures(4);
  for (let i = 0; i < 8; i++) f.attempt(0, BASE + 10_000 + i * 1000);
  const result = f.gate(); assert.equal(result.deferred, false); assert.equal(result.failureCount, 4);
});

test('failure peer: explicit no-request, unknown, wrong-target and non-transient errors do not fill quota', t => {
  const f = fixture(t); f.failures(4);
  f.attempt(4, BASE + 10_000, { attempted: false }); f.attempt(5, BASE + 11_000, { attempted: null });
  f.attempt(6, BASE + 12_000, { wrongTarget: true }); f.attempt(7, BASE + 13_000, { errorCode: 'blocked' });
  assert.equal(f.gate().deferred, false); assert.equal(f.gate().failureCount, 4);
});

test('failure peer: skipped or unknown work does not clear an already-open circuit', t => {
  const f = fixture(t); f.failures();
  f.attempt(5, BASE + 10_000, { attempted: false, status: 'success' });
  f.attempt(6, BASE + 11_000, { attempted: null });
  assert.equal(f.gate().deferred, true); assert.equal(f.gate().failureCount, 5);
});

test('failure peer: expired pause admits probe, another actual failed probe extends the pause', t => {
  const f = fixture(t); f.failures();
  const eligible = BASE + 4001 + 15 * 60_000;
  assert.equal(f.gate(eligible - 1).deferred, true);
  assert.equal(f.gate(eligible).deferred, false);
  f.attempt(5, eligible + 1000, { errorCode: 'network_error' });
  assert.equal(f.gate(eligible + 2000).deferred, true);
  assert.equal(f.gate(eligible + 2000).nextEligibleAt, iso(eligible + 1001 + 15 * 60_000));
});

test('failure peer: old slot, future and ordinary profile failures cannot contaminate works-only budget', t => {
  const f = fixture(t);
  for (let i = 0; i < 5; i++) f.attempt(i, Date.parse(slot.startsAt) - 10000 + i * 1000);
  for (let i = 0; i < 5; i++) f.attempt(i, BASE + 120_000 + i * 1000);
  for (let i = 0; i < 5; i++) f.attempt(i, BASE + i * 1000, { trigger: 'scheduled' });
  assert.equal(f.gate().deferred, false); assert.equal(f.gate().failureCount, 0);
});

test('failure peer: self-described partial success without validated ledger cannot reset circuit', t => {
  const f = fixture(t); f.failures(); f.attempt(5, BASE + 10_000, { status: 'partial', errorCode: null });
  assert.equal(f.gate().deferred, true);
});

test('failure peer: only genuine completed accepted observation resets, four later failures remain below threshold', t => {
  const f = fixture(t); f.failures(); f.accepted(5, BASE + 10_000);
  assert.equal(f.gate().deferred, false); assert.equal(f.gate().failureCount, 0);
  for (let i = 0; i < 4; i++) f.attempt(i + 6, BASE + 20_000 + i * 1000);
  assert.equal(f.gate().deferred, false); assert.equal(f.gate().failureCount, 4);
});

test('failure peer: persisted gate survives a new native readonly connection without any write', t => {
  const f = fixture(t, { disk: true }); f.failures();
  const expected = f.gate();
  const db = new DatabaseSync(f.path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    assert.deepEqual(scheduling.worksOnlyRetryGate({ db }, { now: new Date(BASE + 60_000), slot }), expected);
    assert.equal(db.prepare('SELECT total_changes() n').get().n, 0);
  } finally { db.close(); }
});

test('failure peer: late inserted old successful run cannot reset five chronologically newer failures', t => {
  const f = fixture(t); f.failures(); f.accepted(5, BASE - 10_000);
  assert.equal(f.gate().deferred, true); assert.equal(f.gate().failureCount, 5);
});
