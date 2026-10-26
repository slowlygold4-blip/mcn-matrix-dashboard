import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { checksum } from '../lib/utils.mjs';
import { OFFICIAL_DOUYIN_PROFILE_ENDPOINT } from '../lib/official-profile-evidence.mjs';
import { verifyStoredDouyinProfileIdentity, readStoredDouyinProfileIdentityMatches } from '../lib/profile-identity-proof.mjs';

const SEC = 'MS4wLjABAAAAStoredProfileIdentityOwner12345';
const OTHER = 'MS4wLjABAAAAStoredProfileIdentityOther12345';
const NOW = '2026-10-09T15:00:00.000Z';
const AT = '2026-10-09T12:00:00.000Z';
function fixture() {
  const raw = { capturedAt: AT, profile: { user: { sec_uid: SEC, uid: '123456789012345',
    unique_id: 'Example_A', short_id: '543211234', nickname: '名字不参与匹配' } },
  accountStatus: 'validated', accountError: null, works: { aweme_list: [] },
  provenance: { mode: 'guest-ttwid-unsigned-profile-a-bogus-posts', profileMode: 'guest-ttwid-unsigned-profile',
    profileEndpoint: OFFICIAL_DOUYIN_PROFILE_ENDPOINT, accountLocator: 'sec_uid', cookiePersisted: false, runtimeAI: false, paidAPI: false } };
  const value = { target: { id: 1, type: 'account', provider: 'public-web', locator: SEC, enabled: 1, metadata_json: JSON.stringify({ platform: 'douyin', douyinId: 'UntrustedOther' }) },
    snapshot: { id: 10, target_id: 1, captured_at: AT, quality_status: 'warning', account_status: 'available', source_checksum: checksum(raw), raw_json: JSON.stringify(raw) },
    audit: { id: 20, target_id: 1, run_id: 30, provider: 'public-web', status: 'warning', source_checksum: checksum(raw), created_at: '2026-10-09T12:00:00.015Z' },
    run: { id: 30, target_id: null, started_at: '2026-10-09T11:00:00.000Z', finished_at: '2026-10-09T13:00:00.000Z', status: 'completed' },
    submittedAccountId: ' @Ｅxample_A ', reference: NOW };
  return { value, raw, rehash() { value.snapshot.raw_json = JSON.stringify(raw); value.snapshot.source_checksum = checksum(raw); value.audit.source_checksum = checksum(raw); } };
}

test('stored profile proof is exact, read-only and separate from video receipts or new samples', () => {
  const { value } = fixture(), before = JSON.stringify(value);
  const result = verifyStoredDouyinProfileIdentity(value);
  assert.equal(result.type, 'stored-public-profile-identity');
  assert.equal(result.submittedAccountId, 'example_a');
  assert.equal(result.publicAccountId, 'Example_A');
  assert.equal(result.matchedField, 'unique_id');
  assert.equal(result.canonicalAccountId, SEC);
  assert.equal(result.snapshotId, 10); assert.equal(result.auditId, 20); assert.equal(result.runId, 30);
  assert.equal(result.observedAt, AT); assert.equal(result.checkedAt, NOW);
  assert.equal(result.newPublicCollection, false); assert.equal(result.submittedWorksVerified, false);
  assert.equal(result.identityOnly, true); assert.equal(result.resolution, undefined);
  assert.equal(JSON.stringify(value), before);
});

test('accepts exact textual short_id, never nickname, uid, numeric coercion or metadata assertions', () => {
  const { value } = fixture();
  assert.equal(verifyStoredDouyinProfileIdentity({ ...value, submittedAccountId: '543211234' }).matchedField, 'short_id');
  for (const submittedAccountId of ['名字不参与匹配', '123456789012345', '0543211234', 543211234, '5.43211234e8', 'UntrustedOther', '0', '', null]) {
    assert.equal(verifyStoredDouyinProfileIdentity({ ...value, submittedAccountId }), null, String(submittedAccountId));
  }
});

test('paused targets remain paused and explicit identity or lifecycle holds fail closed', () => {
  const { value } = fixture(); value.target.enabled = 0;
  assert.equal(verifyStoredDouyinProfileIdentity(value).targetEnabled, false);
  for (const field of ['identityConflict', 'lifecycleBlocked']) assert.equal(verifyStoredDouyinProfileIdentity({ ...value, [field]: true }), null);
});

test('raw checksum, canonical identity, quality and audit/run bindings are mandatory', () => {
  const base = fixture().value;
  for (const [object, field, changed] of [
    ['snapshot', 'source_checksum', 'a'.repeat(64)], ['snapshot', 'raw_json', '{}'], ['snapshot', 'target_id', 2],
    ['snapshot', 'account_status', 'unknown'], ['snapshot', 'quality_status', 'rejected'], ['target', 'locator', OTHER],
    ['target', 'provider', 'manual'], ['target', 'metadata_json', '{'], ['target', 'metadata_json', '{"platform":"bilibili"}'],
    ['audit', 'run_id', 99], ['audit', 'source_checksum', 'b'.repeat(64)], ['audit', 'target_id', 2], ['audit', 'provider', 'manual'],
    ['audit', 'status', 'rejected'], ['run', 'target_id', 2], ['run', 'started_at', '2026-10-09T12:01:00.000Z'],
    ['run', 'finished_at', '2026-10-09T11:59:59.999Z'],
  ]) { const value = structuredClone(base); value[object][field] = changed; assert.equal(verifyStoredDouyinProfileIdentity(value), null, `${object}.${field}`); }
});

test('stale, future, impossible, unqualified and raw-mismatched sample times are rejected', () => {
  const { value } = fixture();
  for (const reference of ['2026-10-10T12:00:00.001Z', '2026-10-09T11:59:59.999Z', 'invalid', '2026-02-30T15:00:00.000Z']) {
    assert.equal(verifyStoredDouyinProfileIdentity({ ...value, reference }), null);
  }
  for (const captured_at of ['2026-10-09T12:00:01.000Z', '2026-10-09', '2026-10-09T12:00:00', '2026-02-30T12:00:00Z']) {
    assert.equal(verifyStoredDouyinProfileIdentity({ ...value, snapshot: { ...value.snapshot, captured_at } }), null);
  }
  assert.equal(verifyStoredDouyinProfileIdentity({ ...value, maxAgeMs: 172800000 }), null, 'caller cannot silently relax freshness above one day');
});

test('untrusted envelopes, deleted accounts and explicit access challenges never establish identity', () => {
  for (const mutate of [r => { r.profile.user.user_deleted = true; }, r => { r.profile.user.uid = 123456789012345; },
    r => { r.profile.user.sec_uid = OTHER; }, r => { r.provenance.profileEndpoint = 'https://example.com/profile'; },
    r => { r.provenance.runtimeAI = true; }, r => { r.provenance.mode = 'manual-import'; }, r => { r.source = 'uploaded'; },
    r => { r.roster = {}; }, r => { r.snapshot = {}; }, r => { r.need_login = true; }, r => { r.status_code = 1; },
    r => { r.accountStatus = 'failed'; }, r => { r.accountError = '403'; }, r => { r.profile.user_info = { ...r.profile.user }; },
  ]) { const f = fixture(); mutate(f.raw); f.rehash(); assert.equal(verifyStoredDouyinProfileIdentity(f.value), null); }
});

test('original profileResponse must agree on all identity fields and remain challenge-free', () => {
  const f = fixture(); f.raw.profileResponse = { status_code: 0, user: { ...f.raw.profile.user } }; f.rehash();
  assert.ok(verifyStoredDouyinProfileIdentity(f.value));
  for (const mutate of [r => { r.profileResponse.status_code = 7; }, r => { r.profileResponse.verify_required = true; },
    r => { r.profileResponse.user.unique_id = 'other'; }, r => { r.profileResponse.user.short_id = '111'; },
    r => { r.profileResponse.user_info = { ...r.profile.user }; },
  ]) { const c = fixture(); c.raw.profileResponse = { status_code: 0, user: { ...c.raw.profile.user } }; mutate(c.raw); c.rehash(); assert.equal(verifyStoredDouyinProfileIdentity(c.value), null); }
});

test('recognized deferred works retain profile evidence without claiming works coverage', () => {
  const f = fixture(); f.raw.provenance.mode = f.raw.provenance.profileMode;
  Object.assign(f.raw, { worksCoverage: 'unavailable', worksErrorCode: 'deferred', works: { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } } });
  f.rehash(); assert.ok(verifyStoredDouyinProfileIdentity(f.value));
  f.raw.works.pagination.requestCount = 1; f.rehash(); assert.equal(verifyStoredDouyinProfileIdentity(f.value), null);
});

function database(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE targets(id INTEGER PRIMARY KEY,type TEXT,provider TEXT,locator TEXT,enabled INTEGER,metadata_json TEXT);
    CREATE TABLE snapshots(id INTEGER PRIMARY KEY,target_id INTEGER,captured_at TEXT,quality_status TEXT,account_status TEXT,source_checksum TEXT,raw_json TEXT);
    CREATE TABLE audits(id INTEGER PRIMARY KEY,target_id INTEGER,run_id INTEGER,created_at TEXT,provider TEXT,status TEXT,source_checksum TEXT);
    CREATE TABLE runs(id INTEGER PRIMARY KEY,target_id INTEGER,started_at TEXT,finished_at TEXT,status TEXT);
    CREATE TABLE account_events(id INTEGER PRIMARY KEY,target_id INTEGER,event_type TEXT,observed_at TEXT,event_json TEXT);
    CREATE TABLE author_resolution_queue(id INTEGER PRIMARY KEY,resolved_target_id INTEGER,suspended_target_enabled INTEGER,status TEXT,last_error TEXT);`);
  const save = value => {
    const t = value.target, s = value.snapshot, a = value.audit, r = value.run;
    db.prepare('INSERT INTO targets VALUES(?,?,?,?,?,?)').run(t.id, t.type, t.provider, t.locator, t.enabled, t.metadata_json);
    db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?,?,?)').run(s.id, s.target_id, s.captured_at, s.quality_status, s.account_status, s.source_checksum, s.raw_json);
    db.prepare('INSERT INTO audits VALUES(?,?,?,?,?,?,?)').run(a.id, a.target_id, a.run_id, a.created_at, a.provider, a.status, a.source_checksum);
    db.prepare('INSERT OR IGNORE INTO runs VALUES(?,?,?,?,?)').run(r.id, r.target_id, r.started_at, r.finished_at, r.status);
  };
  save(fixture().value);
  return { db, save, read: ids => readStoredDouyinProfileIdentityMatches(db, ids ?? ['Example_A', '543211234', 'missing'], { reference: NOW }) };
}

test('database batch lookup returns both exact IDs and changes no rows', t => {
  const f = database(t), before = f.db.prepare('SELECT total_changes() n').get().n;
  const result = f.read();
  assert.equal(result.status, 'ok'); assert.equal(result.matches.length, 2);
  assert.deepEqual(result.unmatchedIds, ['missing']); assert.deepEqual(result.ambiguousIds, []);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before);
});

test('multiple canonical owners make every overlapping submitted ID ambiguous', t => {
  const f = database(t), other = fixture();
  other.value.target.id = 2; other.value.target.locator = OTHER; other.raw.profile.user.sec_uid = OTHER;
  other.value.snapshot.id = 11; other.value.snapshot.target_id = 2; other.value.audit.id = 21; other.value.audit.target_id = 2;
  other.rehash(); f.save(other.value);
  const result = f.read(); assert.equal(result.matches.length, 0);
  assert.deepEqual(result.ambiguousIds, ['example_a', '543211234']);
});

test('a corrupted latest snapshot cannot be replaced by an older favorable sample', t => {
  const f = database(t), bad = fixture().value.snapshot;
  f.db.prepare('INSERT INTO snapshots VALUES(11,1,?,?,?,?,?)').run('2026-10-09T12:01:00.000Z', 'warning', 'available', 'f'.repeat(64), bad.raw_json);
  const result = f.read(); assert.equal(result.matches.length, 0); assert.deepEqual(result.unverifiedIds, ['example_a', '543211234']);
});

test('newer lifecycle and real identity conflicts hold but unrelated blocked video requests do not', t => {
  const f = database(t);
  f.db.prepare('INSERT INTO author_resolution_queue VALUES(1,1,1,?,?)').run('rejected', '公开详情未完成 blocked HTTP403');
  assert.equal(f.read().matches.length, 2);
  f.db.prepare('UPDATE author_resolution_queue SET last_error=?').run('公开视频作者与提交的抖音号/昵称不一致，已拒绝自动加入');
  assert.equal(f.read().matches.length, 0);
  f.db.prepare('DELETE FROM author_resolution_queue').run();
  f.db.prepare('INSERT INTO account_events VALUES(1,1,?,?,?)').run('lifecycle', '2026-10-09T12:05:00.000Z', '{"state":"deleted"}');
  assert.equal(f.read().matches.length, 0);
});

test('absent audit, absent tables and invalid input fail closed', t => {
  const f = database(t); f.db.prepare('DELETE FROM audits').run(); assert.equal(f.read().matches.length, 0);
  f.db.exec('DROP TABLE snapshots'); assert.equal(f.read().status, 'unavailable');
  assert.equal(readStoredDouyinProfileIdentityMatches(f.db, [100], { reference: NOW }).status, 'invalid-input');
});

test('invalid submitted handles are explicitly accounted for rather than silently disappearing', t => {
  const f = database(t);
  const result = f.read(['Example_A', '名字不是抖音号', '?!', 543211234]);
  assert.equal(result.matches.length, 1);
  assert.equal(result.requestedIdentityCount, 1);
  assert.equal(result.invalidSubmittedItemCount, 3);
  assert.deepEqual(result.invalidSubmittedIds, ['名字不是抖音号', '?!']);
});
