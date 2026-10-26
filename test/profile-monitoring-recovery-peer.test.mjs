import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { checksum } from '../lib/utils.mjs';
import { OFFICIAL_DOUYIN_PROFILE_ENDPOINT } from '../lib/official-profile-evidence.mjs';
import { validateProfileMonitoringRecovery, applyProfileMonitoringRecovery } from '../lib/profile-monitoring-recovery.mjs';

const NOW = '2026-10-09T15:25:00.000Z';
const AT = '2026-10-09T15:20:50.000Z';
const OLD = '2026-09-08T12:00:00.000Z';
const SEC = 'MS4wLjABAAAAIndependentRecoveryCanonical123456';
const UID = '12345678901234567';
const hash = value => createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE targets(id INTEGER PRIMARY KEY,type,provider,enabled,locator,metadata_json,updated_at,last_checked_at,last_status,last_error);
    CREATE TABLE snapshots(id INTEGER PRIMARY KEY,target_id,captured_at,followers,total_likes,total_posts,quality_status,account_status,works_coverage,account_error,works_error,warnings_json,source_checksum,raw_json);
    CREATE TABLE audits(id INTEGER PRIMARY KEY,target_id,run_id,created_at,provider,status,normalized_post_count,warnings_json,source_checksum,message);
    CREATE TABLE runs(id INTEGER PRIMARY KEY,trigger_type,target_id,started_at,finished_at,status,target_count,success_count,error_count,details_json,processed_count,skipped_count,warning_count,heartbeat_at);
    CREATE TABLE account_events(id INTEGER PRIMARY KEY,target_id,run_id,event_type,event_key,observed_at,source_checksum,event_json,raw_json,created_at);
    CREATE TABLE author_resolution_queue(id INTEGER PRIMARY KEY,resolved_target_id,suspended_target_enabled,status,lease_owner,lease_until,last_error,evidence_version,douyin_id,account_locator,source_metadata_json);
    CREATE TABLE author_resolution_jobs(id INTEGER PRIMARY KEY,status);
    CREATE TABLE activity_log(id INTEGER PRIMARY KEY,user_id,actor_name,action,resource_type,resource_id,created_at,details_json);
  `);
  const user = { sec_uid: SEC, uid: UID, unique_id: 'CaseSensitivePublicId', short_id: '0', follower_count: 12, total_favorited: 34, aweme_count: 5 };
  const raw = { capturedAt: AT, profile: { user }, accountStatus: 'validated', accountError: null,
    worksCoverage: 'unavailable', worksErrorCode: 'deferred', worksError: '未请求作品',
    works: { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } },
    provenance: { mode: 'guest-ttwid-unsigned-profile', profileMode: 'guest-ttwid-unsigned-profile', profileEndpoint: OFFICIAL_DOUYIN_PROFILE_ENDPOINT,
      accountLocator: 'sec_uid', cookiePersisted: false, runtimeAI: false, paidAPI: false } };
  const probe = { targetId: 7, enabledAtProbe: 0, requestedSecUid: SEC, submittedId: 'casesensitivepublicid',
    startedAt: '2026-10-09T15:20:49.000Z', finishedAt: '2026-10-09T15:20:51.000Z', operation: 'account', worksMode: 'deferred',
    signedFallbackDisabled: true, newDatabaseSnapshot: false, exitStatus: 0, rawResponse: { ok: true, data: raw } };
  const oldRaw = { ...structuredClone(raw), capturedAt: OLD };
  db.prepare("INSERT INTO targets VALUES(7,'account','public-web',0,?,?,?,NULL,'error',?)")
    .run(SEC, JSON.stringify({ platform: 'douyin', douyinId: 'casesensitivepublicid', importSource: 'untouched-source' }), OLD, 'HTTP 403 原作品失败');
  db.prepare('INSERT INTO snapshots(id,target_id,captured_at,raw_json,source_checksum) VALUES(1,7,?,?,?)').run(OLD, JSON.stringify(oldRaw), checksum(oldRaw));
  db.prepare("INSERT INTO audits(id,target_id,created_at,message) VALUES(1,7,?,'严格身份复核：历史记录含未通过作品，原监控已暂停')").run(OLD);
  db.prepare("INSERT INTO author_resolution_queue VALUES(1,7,1,'rejected',NULL,NULL,'HTTP 403 blocked',3,'casesensitivepublicid',?,'original-source')").run(SEC);
  return { db, raw, probe, input() {
    const evidenceText = JSON.stringify(probe, null, 2) + '\n';
    return { evidenceText, sourcePath: 'test-only-generated-fixture.json', sourceReceipt: { targetId: 7, evidenceFile: 'test-only-generated-fixture.json',
      evidenceFileSha256: hash(evidenceText), parsedResponseJsonSha256: checksum(probe.rawResponse), parsedDataJsonSha256: checksum(raw) } };
  } };
}
const options = { reference: NOW };
function counts(db) {
  return ['runs', 'snapshots', 'audits', 'account_events', 'activity_log'].map(table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);
}

test('peer: profile recovery preserves source, failed work evidence, true sample time and replay idempotence', t => {
  const f = fixture(t), before = f.db.prepare('SELECT * FROM targets WHERE id=7').get();
  const oldHold = f.db.prepare('SELECT * FROM author_resolution_queue WHERE id=1').get();
  const input = f.input(), checked = validateProfileMonitoringRecovery(f.db, input, options);
  assert.equal(checked.status, 'ready', checked.reason);
  const result = applyProfileMonitoringRecovery(f.db, input, { ...options, expectedPlanSha256: checked.planSha256 });
  assert.equal(result.status, 'applied'); assert.equal(result.worksVerified, false);
  const after = f.db.prepare('SELECT * FROM targets WHERE id=7').get();
  assert.equal(after.metadata_json, before.metadata_json);
  assert.equal(after.last_error, before.last_error, 'profile identity cannot erase unresolved work failures');
  const hold = f.db.prepare('SELECT * FROM author_resolution_queue WHERE id=1').get();
  assert.deepEqual({ ...hold, suspended_target_enabled: oldHold.suspended_target_enabled }, { ...oldHold });
  assert.equal(hold.suspended_target_enabled, null);
  const snapshot = f.db.prepare('SELECT * FROM snapshots WHERE id=?').get(result.snapshotId);
  assert.equal(snapshot.captured_at, AT); assert.equal(snapshot.works_coverage, 'unavailable');
  assert.equal(snapshot.quality_status, 'warning'); assert.equal(snapshot.total_likes, 34);
  const currentCounts = counts(f.db);
  assert.equal(applyProfileMonitoringRecovery(f.db, input, { ...options, expectedPlanSha256: checked.planSha256 }).status, 'already-applied');
  assert.deepEqual(counts(f.db), currentCounts);
  f.db.prepare('UPDATE targets SET enabled=0 WHERE id=7').run();
  assert.equal(applyProfileMonitoringRecovery(f.db, input, { ...options, expectedPlanSha256: checked.planSha256 }).currentlyEnabled, false);
  assert.equal(f.db.prepare('SELECT enabled FROM targets WHERE id=7').get().enabled, 0, 'replay must not undo a later pause');
});

test('peer: a lifecycle hold after sampling prevents resurrection', t => {
  const f = fixture(t);
  f.db.prepare("INSERT INTO account_events(target_id,event_type,event_key,observed_at,event_json,raw_json) VALUES(7,'lifecycle','deleted',?,?,?)")
    .run('2026-10-09T15:21:00.000Z', JSON.stringify({ type: 'deleted', accountStatus: 'unavailable' }), JSON.stringify({ user_deleted: true }));
  assert.equal(validateProfileMonitoringRecovery(f.db, f.input(), options).status, 'blocked');
});

test('peer: later manual pause and previously-user-disabled holds are never recovered', t => {
  const f = fixture(t);
  f.db.prepare("INSERT INTO activity_log(user_id,actor_name,action,resource_type,resource_id,created_at,details_json) VALUES(42,'用户','target.state','target','7',?,?)")
    .run('2026-09-09T00:00:00.000Z', JSON.stringify({ enabled: false }));
  assert.equal(validateProfileMonitoringRecovery(f.db, f.input(), options).status, 'blocked');
  f.db.exec('DELETE FROM activity_log; UPDATE author_resolution_queue SET suspended_target_enabled=0');
  assert.equal(validateProfileMonitoringRecovery(f.db, f.input(), options).status, 'blocked');
});

test('peer: original deleted or challenged response cannot be hidden by its normalized profile', t => {
  const f = fixture(t);
  f.raw.profileResponse = { status_code: 0, user: { ...f.raw.profile.user, user_deleted: true } };
  assert.equal(validateProfileMonitoringRecovery(f.db, f.input(), options).status, 'blocked');
  f.raw.profileResponse = { status_code: 0, user: { ...f.raw.profile.user }, captcha_required: true };
  assert.equal(validateProfileMonitoringRecovery(f.db, f.input(), options).status, 'blocked');
});

test('peer: historical uid conflict, future/stale observations and modified source bytes fail closed', t => {
  const f = fixture(t), input = f.input();
  assert.equal(validateProfileMonitoringRecovery(f.db, { ...input, evidenceText: input.evidenceText + ' ' }, options).status, 'blocked');
  assert.equal(validateProfileMonitoringRecovery(f.db, input, { reference: '2026-10-09T15:20:49.000Z' }).status, 'blocked');
  assert.equal(validateProfileMonitoringRecovery(f.db, input, { reference: '2026-10-09T16:00:00.000Z' }).status, 'blocked');
  const old = JSON.parse(f.db.prepare('SELECT raw_json FROM snapshots WHERE id=1').get().raw_json);
  old.profile.user.uid = '87654321098765432';
  f.db.prepare('UPDATE snapshots SET raw_json=?,source_checksum=? WHERE id=1').run(JSON.stringify(old), checksum(old));
  assert.equal(validateProfileMonitoringRecovery(f.db, f.input(), options).status, 'blocked');
});

test('peer: stale plan caused by another metadata update rolls back without writes', t => {
  const f = fixture(t), input = f.input();
  const checked = validateProfileMonitoringRecovery(f.db, input, options);
  f.db.prepare('UPDATE targets SET metadata_json=? WHERE id=7').run(JSON.stringify({ platform: 'douyin', douyinId: 'casesensitivepublicid', userEdited: true }));
  const before = counts(f.db);
  assert.throws(() => applyProfileMonitoringRecovery(f.db, input, { ...options, expectedPlanSha256: checked.planSha256 }), /状态已变化|恢复计划/);
  assert.deepEqual(counts(f.db), before);
  assert.equal(f.db.prepare('SELECT enabled FROM targets WHERE id=7').get().enabled, 0);
});

test('peer: failure on final target CAS rolls back all inserted provenance and hold changes', t => {
  const f = fixture(t), input = f.input(), before = counts(f.db);
  const checked = validateProfileMonitoringRecovery(f.db, input, options);
  assert.equal(checked.status, 'ready', checked.reason);
  f.db.exec("CREATE TRIGGER simulate_late_failure BEFORE UPDATE ON targets BEGIN SELECT RAISE(ABORT,'late failure'); END;");
  assert.throws(() => applyProfileMonitoringRecovery(f.db, input, { ...options, expectedPlanSha256: checked.planSha256 }), /late failure/);
  assert.deepEqual(counts(f.db), before);
  assert.equal(f.db.prepare('SELECT suspended_target_enabled FROM author_resolution_queue').get().suspended_target_enabled, 1);
  assert.equal(f.db.prepare('SELECT enabled FROM targets').get().enabled, 0);
});
