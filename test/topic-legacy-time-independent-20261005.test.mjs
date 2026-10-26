import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { MonitorDatabase } from '../lib/database.mjs';
import { validateTopicSnapshot } from '../lib/topic-snapshot-integrity.mjs';

// Fixed pre-version anonymous-writer evidence, captured read-only on 2026-10-05.
// Public identity/counters and ledger bindings only: no cookies, storage state,
// headers or authentication material. These exact raw strings retain their
// ORIGINAL hashes and do not depend on a live DB or a local backup at runtime.
const FIXED = {
  "target": {
    "id": 2361,
    "type": "hashtag",
    "provider": "public-web",
    "locator": "一条小团团OvO",
    "label": "#一条小团团OvO",
    "enabled": 1
  },
  "rows": [
    {
      "id": 61827,
      "target_id": 2361,
      "captured_at": "2026-10-03T10:00:28.446Z",
      "hashtag_participants": 331487,
      "hashtag_views": 12529392339,
      "quality_status": "validated",
      "source_checksum": "8486ce0450650817c33ef421da765e2dc02fc2c95781140c1dce483af243a7bf",
      "raw_json": "{\"scope\":\"douyin-official-challenge-detail\",\"businessStatusCode\":0,\"challengeId\":\"1617668778418189\",\"label\":\"一条小团团OvO\",\"officialName\":\"一条小团团ovo\",\"participants\":331487,\"views\":12529392339,\"provenance\":{\"mode\":\"douyin-official-anonymous-challenge-detail\",\"endpoint\":\"https://www.douyin.com/aweme/v1/web/challenge/detail/\",\"authenticated\":false,\"runtimeAI\":false,\"paidAPI\":false},\"identityReuse\":{\"scope\":\"historical-identity-only\",\"snapshotId\":61126,\"auditId\":49294,\"runId\":4081,\"capturedAt\":\"2026-10-03T02:00:53.500Z\",\"sourceChecksum\":\"09b7497b96ae014202eee18dd9f83a28bdd88a937e0a66b7fa656a7c14fad8a2\"}}",
      "audit_id": 49999,
      "audit_target_id": 2361,
      "audit_provider": "public-web",
      "audit_status": "validated",
      "audit_checksum": "8486ce0450650817c33ef421da765e2dc02fc2c95781140c1dce483af243a7bf",
      "audit_created_at": "2026-10-03T10:00:28.452Z",
      "run_id": 4577,
      "run_target_id": null,
      "run_status": "success",
      "started_at": "2026-10-03T10:00:26.021Z",
      "finished_at": "2026-10-03T10:24:36.663Z"
    },
    {
      "id": 63930,
      "target_id": 2361,
      "captured_at": "2026-10-04T10:00:24.210Z",
      "hashtag_participants": 332158,
      "hashtag_views": 12546135492,
      "quality_status": "validated",
      "source_checksum": "a4e0d58d71cdeab26562dca815a03dc35e8e3f5a74961a9bb713e3221ba28231",
      "raw_json": "{\"scope\":\"douyin-official-challenge-detail\",\"businessStatusCode\":0,\"challengeId\":\"1617668778418189\",\"label\":\"一条小团团OvO\",\"officialName\":\"一条小团团ovo\",\"participants\":332158,\"views\":12546135492,\"provenance\":{\"mode\":\"douyin-official-anonymous-challenge-detail\",\"endpoint\":\"https://www.douyin.com/aweme/v1/web/challenge/detail/\",\"authenticated\":false,\"runtimeAI\":false,\"paidAPI\":false},\"identityReuse\":{\"scope\":\"historical-identity-only\",\"snapshotId\":63229,\"auditId\":51413,\"runId\":5583,\"capturedAt\":\"2026-10-04T02:00:13.217Z\",\"sourceChecksum\":\"c0d5f72369a9fd3b8be3e7528d76e372496b1b4b959cb53120cf9c859237c7ce\"}}",
      "audit_id": 52118,
      "audit_target_id": 2361,
      "audit_provider": "public-web",
      "audit_status": "validated",
      "audit_checksum": "a4e0d58d71cdeab26562dca815a03dc35e8e3f5a74961a9bb713e3221ba28231",
      "audit_created_at": "2026-10-04T10:00:24.238Z",
      "run_id": 6041,
      "run_target_id": null,
      "run_status": "success",
      "started_at": "2026-10-04T10:00:21.643Z",
      "finished_at": "2026-10-04T10:24:58.766Z"
    }
  ]
};
const AS_OF = Date.parse('2026-10-05T01:30:00.000Z');
const ENDPOINT = 'https://www.douyin.com/aweme/v1/web/challenge/detail/';
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);

function instant(value) {
  assert.equal(typeof value, 'string');
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const result = Date.parse(value);
  assert.equal(new Date(result).toISOString(), value);
  return result;
}

// Independent old-writer oracle, not derived from validateTopicSnapshot.
// The old collect_hashtag_detail raw contract was scope/status/identity/vector/
// anonymous provenance. PublicWebProvider added identityReuse; saveCollection
// hashed that full raw and bound its top-level observation to audit + run.
// It never wrote a payload-level time or time-contract version.
function oldAnonymousWriterOracle(row, target) {
  const raw = JSON.parse(row.raw_json);
  assert.deepEqual(Object.keys(raw).sort(), [
    'scope', 'businessStatusCode', 'challengeId', 'label', 'officialName',
    'participants', 'views', 'provenance', 'identityReuse',
  ].sort());
  assert.equal(Object.hasOwn(raw, 'capturedAt'), false);
  assert.equal(Object.hasOwn(raw, 'topicTimeContractVersion'), false);
  assert.equal(raw.scope, 'douyin-official-challenge-detail');
  assert.equal(raw.businessStatusCode, 0);
  assert.equal(raw.challengeId, '1617668778418189');
  assert.equal(raw.label.toLowerCase(), target.locator.toLowerCase());
  assert.equal(raw.officialName.toLowerCase(), target.locator.toLowerCase());
  assert.deepEqual(raw.provenance, {
    mode: 'douyin-official-anonymous-challenge-detail', endpoint: ENDPOINT,
    authenticated: false, runtimeAI: false, paidAPI: false,
  });
  assert.deepEqual(Object.keys(raw.identityReuse).sort(),
    ['scope', 'snapshotId', 'auditId', 'runId', 'capturedAt', 'sourceChecksum'].sort());
  assert.equal(raw.identityReuse.scope, 'historical-identity-only');
  assert.ok(instant(raw.identityReuse.capturedAt) < instant(row.captured_at));
  assert.match(raw.identityReuse.sourceChecksum, /^[a-f0-9]{64}$/);
  for (const field of ['participants', 'views']) {
    assert.ok(Number.isSafeInteger(raw[field]) && raw[field] >= 0);
    assert.equal(row[field === 'participants' ? 'hashtag_participants' : 'hashtag_views'], raw[field]);
  }
  assert.match(row.source_checksum, /^[a-f0-9]{64}$/);
  assert.equal(sha(raw), row.source_checksum, 'complete original raw SHA-256');
  assert.equal(row.audit_checksum, row.source_checksum, 'original audit SHA-256');
  assert.equal(target.type, 'hashtag');
  assert.equal(target.provider, 'public-web');
  assert.equal(row.target_id, target.id);
  assert.equal(row.audit_target_id, target.id);
  assert.equal(row.audit_provider, 'public-web');
  assert.equal(row.quality_status, 'validated');
  assert.equal(row.audit_status, row.quality_status);
  for (const field of ['id', 'audit_id', 'run_id']) assert.ok(Number.isSafeInteger(row[field]) && row[field] > 0);
  assert.equal(row.run_status, 'success');
  assert.equal(row.run_target_id, null, 'original scheduled multi-target run');
  assert.ok(instant(row.started_at) <= instant(row.captured_at));
  assert.ok(instant(row.captured_at) <= instant(row.audit_created_at));
  assert.ok(instant(row.audit_created_at) <= instant(row.finished_at));
  assert.ok(instant(row.finished_at) <= AS_OF);
  return { valid: true, reason: null, participants: raw.participants, views: raw.views,
    timeBinding: 'ledger-audit-legacy' };
}

function rawVariant(row, mutate, { rehash = true } = {}) {
  const copy = clone(row);
  const raw = JSON.parse(copy.raw_json);
  mutate(raw);
  copy.raw_json = JSON.stringify(raw);
  if (rehash) copy.source_checksum = copy.audit_checksum = sha(raw);
  return copy;
}

function checked(row, target = FIXED.target, asOf = AS_OF) {
  return validateTopicSnapshot(row, target, { asOf });
}

test('fixed original two-day anonymous writer hashes/vectors independently prove the legacy contract', () => {
  const counters = [[331487, 12529392339], [332158, 12546135492]];
  const expectedHashes = [
    '8486ce0450650817c33ef421da765e2dc02fc2c95781140c1dce483af243a7bf',
    'a4e0d58d71cdeab26562dca815a03dc35e8e3f5a74961a9bb713e3221ba28231',
  ];
  for (const [index, row] of FIXED.rows.entries()) {
    const expected = oldAnonymousWriterOracle(row, FIXED.target);
    assert.deepEqual([expected.participants, expected.views], counters[index]);
    assert.equal(row.source_checksum, expectedHashes[index]);
    const before = JSON.stringify(row);
    assert.deepEqual(checked(row), expected);
    assert.equal(JSON.stringify(row), before, 'reader must not retrofit time or change source evidence');
  }
});

test('version 1 and existing unversioned payload times remain separate from ledger-audit legacy', () => {
  for (const row of FIXED.rows) {
    const expected = oldAnonymousWriterOracle(row, FIXED.target);
    for (const versioned of [false, true]) {
      const copy = rawVariant(row, raw => {
        raw.capturedAt = row.captured_at;
        if (versioned) raw.topicTimeContractVersion = 1;
      });
      assert.notEqual(copy.source_checksum, row.source_checksum);
      assert.deepEqual(checked(copy), { ...expected, timeBinding: 'payload-observation-time' });
    }
  }
});

const base = FIXED.rows[1];
const shift = (value, millis) => new Date(Date.parse(value) + millis).toISOString();
const invalid = [
  ['present null capture is not absent legacy', rawVariant(base, raw => { raw.capturedAt = null; }), 'time-binding'],
  ['present empty capture is not absent legacy', rawVariant(base, raw => { raw.capturedAt = ''; }), 'time-binding'],
  ['malformed capture stays rejected', rawVariant(base, raw => { raw.capturedAt = 'invalid'; }), 'time-binding'],
  ['one millisecond payload mismatch stays rejected', rawVariant(base, raw => { raw.capturedAt = shift(base.captured_at, 1); }), 'time-binding'],
  ['null version is not absent legacy', rawVariant(base, raw => { raw.topicTimeContractVersion = null; }), 'time-contract-version'],
  ['unknown version is not legacy', rawVariant(base, raw => { raw.topicTimeContractVersion = 2; }), 'time-contract-version'],
  ['string version is not numeric version one', rawVariant(base, raw => { raw.topicTimeContractVersion = '1'; }), 'time-contract-version'],
  ['version one requires payload capture', rawVariant(base, raw => { raw.topicTimeContractVersion = 1; }), 'time-binding'],
  ['version one requires valid payload capture', rawVariant(base, raw => { raw.topicTimeContractVersion = 1; raw.capturedAt = null; }), 'time-binding'],
  ['browser absence cannot borrow legacy ledger time', rawVariant(base, raw => {
    raw.provenance.mode = 'douyin-authenticated-browser-search-and-detail'; raw.provenance.authenticated = true;
  }), 'time-binding'],
  ['public hashtag mode absence cannot borrow legacy ledger time', rawVariant(base, raw => {
    raw.provenance.mode = 'douyin-public-hashtag-search-and-detail';
  }), 'time-binding'],
  ['new raw time cannot retain the old full-payload hash', rawVariant(base, raw => { raw.capturedAt = base.captured_at; }, { rehash: false }), 'source-payload'],
  ['counter mutation is not justified by legacy identity', { ...base, hashtag_views: base.hashtag_views + 1 }, 'source-payload'],
  ['raw vector mutation plus rehash still differs from stored vector', rawVariant(base, raw => { raw.participants += 1; }), 'source-payload'],
  ['raw byte/content mutation without new hash is rejected', rawVariant(base, raw => { raw.identityReuse.snapshotId += 1; }, { rehash: false }), 'source-payload'],
  ['foreign official name remains rejected even with a new hash', rawVariant(base, raw => { raw.officialName = '不同话题'; }), 'source-identity'],
  ['foreign topic label remains rejected even with a new hash', rawVariant(base, raw => { raw.label = '不同话题'; }), 'source-identity'],
  ['foreign endpoint remains rejected even with a new hash', rawVariant(base, raw => { raw.provenance.endpoint = 'https://example.invalid/detail'; }), 'source-payload'],
  ['failed business response remains rejected even with a new hash', rawVariant(base, raw => { raw.businessStatusCode = 403; }), 'source-payload'],
  ['anonymous authenticated flag remains rejected', rawVariant(base, raw => { raw.provenance.authenticated = true; }), 'source-provenance'],
  ['audit checksum mismatch stays rejected', { ...base, audit_checksum: '0'.repeat(64) }, 'checksum-binding'],
  ['replacement source and audit digest cannot match original raw', { ...base, source_checksum: '0'.repeat(64), audit_checksum: '0'.repeat(64) }, 'source-payload'],
  ['foreign audit target remains rejected', { ...base, audit_target_id: 9999 }, 'target-audit-binding'],
  ['foreign run target remains rejected', { ...base, run_target_id: 9999 }, 'run-binding'],
  ['missing audit remains rejected', { ...base, audit_id: null }, 'run-binding'],
  ['missing run remains rejected', { ...base, run_id: null }, 'run-binding'],
  ['manual audit remains rejected', { ...base, audit_provider: 'manual' }, 'target-audit-binding'],
  ['rejected audit remains rejected', { ...base, audit_status: 'rejected' }, 'quality'],
  ['run begins after sample remains rejected', { ...base, started_at: shift(base.captured_at, 1) }, 'time'],
  ['audit precedes sample remains rejected', { ...base, audit_created_at: shift(base.captured_at, -1) }, 'time'],
  ['run ends before audit remains rejected', { ...base, finished_at: shift(base.audit_created_at, -1) }, 'time'],
  ['running run with finished time remains rejected', { ...base, run_status: 'running' }, 'run-state'],
];
for (const [name, row, reason] of invalid) {
  test(name, () => {
    assert.deepEqual(checked(row), { valid: false, reason, participants: null, views: null });
  });
}

test('a later request cutoff cannot lend audit/run evidence to an earlier asOf', () => {
  const row = FIXED.rows[1];
  assert.equal(checked(row).valid, true);
  assert.equal(checked(row, FIXED.target, Date.parse(row.audit_created_at) - 1).reason, 'time');
  assert.equal(checked(row, FIXED.target, Date.parse(row.finished_at) - 1).reason, 'time');
  assert.equal(checked(row).valid, true);
});

function memoryHistory(t, rows = FIXED.rows) {
  t.mock.timers.enable({ apis: ['Date'], now: AS_OF });
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE targets(id INTEGER PRIMARY KEY,type TEXT,provider TEXT,locator TEXT,label TEXT,enabled INTEGER);
    CREATE TABLE snapshots(id INTEGER PRIMARY KEY,target_id INTEGER,captured_at TEXT,
      hashtag_participants INTEGER,hashtag_views INTEGER,quality_status TEXT,warnings_json TEXT,
      source_checksum TEXT,raw_json TEXT);
    CREATE TABLE audits(id INTEGER PRIMARY KEY,target_id INTEGER,run_id INTEGER,created_at TEXT,
      provider TEXT,status TEXT,source_checksum TEXT);
    CREATE TABLE runs(id INTEGER PRIMARY KEY,target_id INTEGER,status TEXT,started_at TEXT,finished_at TEXT);
  `);
  const target = FIXED.target;
  db.prepare('INSERT INTO targets VALUES(?,?,?,?,?,?)').run(target.id, target.type, target.provider,
    target.locator, target.label, target.enabled);
  for (const row of rows) {
    db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?,?,?,?,?)').run(row.id, row.target_id,
      row.captured_at, row.hashtag_participants, row.hashtag_views, row.quality_status, '[]', row.source_checksum, row.raw_json);
    db.prepare('INSERT INTO audits VALUES(?,?,?,?,?,?,?)').run(row.audit_id, row.audit_target_id, row.run_id,
      row.audit_created_at, row.audit_provider, row.audit_status, row.audit_checksum);
    db.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run(row.run_id, row.run_target_id, row.run_status,
      row.started_at, row.finished_at);
  }
  return (startDate, endDate = startDate) =>
    MonitorDatabase.prototype.listTopicHistory.call({ db }, { startDate, endDate }).topics[0];
}

test('fixed original adjacent-day baseline is verified but not returned or counted as the requested day', t => {
  const previous = oldAnonymousWriterOracle(FIXED.rows[0], FIXED.target);
  const current = oldAnonymousWriterOracle(FIXED.rows[1], FIXED.target);
  const history = memoryHistory(t)('2026-10-04');
  assert.equal(history.points.length, 1);
  assert.equal(history.sampledCount, 1);
  assert.equal(history.observedCount, 1);
  assert.equal(history.missingCount, 0);
  assert.equal(history.points[0].sourceVerified, true);
  assert.equal(history.points[0].sourceChecksum, FIXED.rows[1].source_checksum);
  assert.equal(history.points[0].snapshotId, FIXED.rows[1].id);
  assert.equal(history.points[0].baselineDate, '2026-10-03');
  assert.equal(history.points[0].baselineSourceChecksum, FIXED.rows[0].source_checksum);
  assert.equal(history.points[0].participantsDelta, current.participants - previous.participants);
  assert.equal(history.points[0].participantsDelta, 671);
  assert.equal(history.points[0].viewsDelta, current.views - previous.views);
  assert.equal(history.points[0].viewsDelta, 16743153);
  for (const field of ['participants', 'views']) {
    assert.equal(history.latestKnown[field].value, current[field]);
    assert.equal(history.latestKnown[field].date, '2026-10-04');
    assert.equal(history.latestKnown[field].sourceChecksum, FIXED.rows[1].source_checksum);
  }
});

test('missing requested day does not inherit old counters as a daily observation', t => {
  const history = memoryHistory(t)('2026-10-05');
  assert.equal(history.observedCount, 0);
  assert.equal(history.sampledCount, 0);
  assert.equal(history.missingCount, 1);
  assert.equal(history.points[0].capturedAt, null);
  assert.equal(history.points[0].participants, null);
  assert.equal(history.points[0].views, null);
  assert.equal(history.points[0].participantsDelta, null);
  assert.equal(history.points[0].viewsDelta, null);
  assert.equal(history.latestKnown.participants.date, '2026-10-04');
  assert.equal(history.latestKnown.views.date, '2026-10-04');
});

test('no adjacent day means no manufactured baseline or delta', t => {
  const history = memoryHistory(t, [FIXED.rows[1]])('2026-10-04');
  assert.equal(history.observedCount, 1);
  assert.equal(history.points[0].baselineDate, null);
  assert.equal(history.points[0].participantsDelta, null);
  assert.equal(history.points[0].viewsDelta, null);
});

test('a corrupt original prior-day vector cannot become a verified baseline', t => {
  const previous = { ...FIXED.rows[0], hashtag_views: FIXED.rows[0].hashtag_views + 1 };
  const history = memoryHistory(t, [previous, FIXED.rows[1]])('2026-10-04');
  assert.equal(history.observedCount, 1);
  assert.equal(history.points[0].baselineQualityStatus, 'unverified');
  assert.equal(history.points[0].participantsDelta, null);
  assert.equal(history.points[0].viewsDelta, null);
  assert.equal(history.latestKnown.views.delta, null);
});

