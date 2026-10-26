import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { checksum } from '../lib/utils.mjs';
import { OFFICIAL_DOUYIN_PROFILE_ENDPOINT } from '../lib/official-profile-evidence.mjs';
import { validateProfileMonitoringRecovery, applyProfileMonitoringRecovery } from '../lib/profile-monitoring-recovery.mjs';

const SEC = 'MS4wLjABAAAARecoveryFixtureOwner123456';
const NOW = '2026-10-09T15:25:00.000Z';
const digest = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE targets(id INTEGER PRIMARY KEY,type TEXT,label TEXT,provider TEXT,locator TEXT,enabled INTEGER,metadata_json TEXT,created_at TEXT,updated_at TEXT,last_checked_at TEXT,last_status TEXT,last_error TEXT);
    CREATE TABLE snapshots(id INTEGER PRIMARY KEY,target_id INTEGER,captured_at TEXT,followers INTEGER,total_likes INTEGER,total_posts INTEGER,quality_status TEXT,account_status TEXT,works_coverage TEXT,account_error TEXT,works_error TEXT,warnings_json TEXT,source_checksum TEXT,raw_json TEXT,UNIQUE(target_id,captured_at));
    CREATE TABLE audits(id INTEGER PRIMARY KEY,target_id INTEGER,run_id INTEGER,created_at TEXT,provider TEXT,status TEXT,normalized_post_count INTEGER,warnings_json TEXT,source_checksum TEXT,message TEXT);
    CREATE TABLE runs(id INTEGER PRIMARY KEY,trigger_type TEXT,target_id INTEGER,started_at TEXT,finished_at TEXT,status TEXT,target_count INTEGER,success_count INTEGER,error_count INTEGER,details_json TEXT,processed_count INTEGER,skipped_count INTEGER,warning_count INTEGER,heartbeat_at TEXT);
    CREATE TABLE account_events(id INTEGER PRIMARY KEY,target_id INTEGER,run_id INTEGER,event_type TEXT,event_key TEXT,observed_at TEXT,source_checksum TEXT,event_json TEXT,raw_json TEXT,created_at TEXT,UNIQUE(target_id,event_type,event_key));
    CREATE TABLE author_resolution_queue(id INTEGER PRIMARY KEY,resolved_target_id INTEGER,suspended_target_enabled INTEGER,status TEXT,last_error TEXT,lease_owner TEXT,lease_until TEXT,douyin_id TEXT,account_locator TEXT,evidence_version INTEGER,source_metadata_json TEXT);
    CREATE TABLE author_resolution_jobs(id INTEGER PRIMARY KEY,status TEXT);
    CREATE TABLE activity_log(id INTEGER PRIMARY KEY,user_id INTEGER,actor_name TEXT,action TEXT,resource_type TEXT,resource_id TEXT,created_at TEXT,details_json TEXT);`);
  db.prepare('INSERT INTO targets VALUES(1,?,?,?,?,?,?,?,?,?,?,?)').run('account', '历史名', 'public-web', SEC, 0, '{"platform":"douyin","douyinId":"ExampleId"}',
    '2026-09-01T00:00:00.000Z', '2026-09-08T12:00:00.000Z', '2026-09-07T12:00:00.000Z', 'warning', null);
  const old = { capturedAt: '2026-09-07T12:00:00.000Z', profile: { user: { sec_uid: SEC, uid: '123456789' } } };
  db.prepare('INSERT INTO snapshots(id,target_id,captured_at,source_checksum,raw_json) VALUES(1,1,?,?,?)').run(old.capturedAt, checksum(old), JSON.stringify(old));
  db.prepare("INSERT INTO audits(id,target_id,created_at,message) VALUES(1,1,?,?)").run('2026-09-08T12:00:00.000Z', '严格身份复核：历史记录含 2 项作品证据，原监控已暂停；全部证据确认同一作者后才会自动恢复');
  db.prepare('INSERT INTO author_resolution_queue VALUES(1,1,1,?,?,NULL,NULL,?,?,2,?)').run('rejected', '达到公开核验重试上限；HTTP 403 blocked', 'ExampleId', SEC, '{"file":"original.xlsx"}');
  const probe = { targetId: 1, enabledAtProbe: 0, requestedSecUid: SEC, submittedId: 'exampleid', startedAt: '2026-10-09T15:19:33.794Z',
    finishedAt: '2026-10-09T15:19:34.525Z', operation: 'account', worksMode: 'deferred', signedFallbackDisabled: true, newDatabaseSnapshot: false, exitStatus: 0,
    rawResponse: { ok: true, data: { capturedAt: '2026-10-09T15:19:34.520Z', profile: { user: { sec_uid: SEC, uid: '123456789', unique_id: 'ExampleId', short_id: '0', nickname: '历史名', follower_count: 223, total_favorited: 13896, aweme_count: 32 } },
      accountStatus: 'validated', accountError: null, worksCoverage: 'unavailable', worksErrorCode: 'deferred', worksError: '作品未请求',
      works: { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } }, warnings: [],
      provenance: { mode: 'guest-ttwid-unsigned-profile', profileMode: 'guest-ttwid-unsigned-profile', profileEndpoint: OFFICIAL_DOUYIN_PROFILE_ENDPOINT, accountLocator: 'sec_uid', cookiePersisted: false, runtimeAI: false, paidAPI: false } } } };
  const input = () => { const evidenceText = JSON.stringify(probe); return { evidenceText, sourcePath: '/fixture/probe.json', sourceReceipt: {
    targetId: 1, evidenceFile: '/fixture/probe.json', evidenceFileSha256: digest(evidenceText), parsedResponseJsonSha256: checksum(probe.rawResponse), parsedDataJsonSha256: checksum(probe.rawResponse.data) } }; };
  const validate = () => validateProfileMonitoringRecovery(db, input(), { reference: NOW });
  return { db, probe, input, validate, apply: plan => applyProfileMonitoringRecovery(db, input(), { reference: NOW, expectedPlanSha256: plan.planSha256 }) };
}

test('validate is read-only; explicit apply preserves source and work failure, uses actual sampled time and is idempotent', t => {
  const f = fixture(t), before = f.db.prepare('SELECT total_changes() n').get().n, plan = f.validate();
  assert.equal(plan.status, 'ready', plan.reason); assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before);
  const oldQueue = f.db.prepare('SELECT * FROM author_resolution_queue').get(), metadata = f.db.prepare('SELECT metadata_json FROM targets').get().metadata_json;
  const result = f.apply(plan); assert.equal(result.status, 'applied');
  const saved = f.db.prepare('SELECT * FROM snapshots WHERE id=?').get(result.snapshotId);
  assert.equal(saved.captured_at, f.probe.rawResponse.data.capturedAt); assert.equal(saved.followers, 223); assert.equal(saved.works_coverage, 'unavailable');
  assert.equal(f.db.prepare('SELECT metadata_json FROM targets').get().metadata_json, metadata);
  assert.deepEqual({ ...f.db.prepare('SELECT * FROM author_resolution_queue').get(), suspended_target_enabled: 1 }, { ...oldQueue });
  const run = f.db.prepare('SELECT * FROM runs WHERE id=?').get(result.runId); assert.equal(run.started_at, f.probe.startedAt); assert.equal(run.finished_at, NOW);
  const event = JSON.parse(f.db.prepare('SELECT event_json FROM account_events').get().event_json);
  assert.equal(event.stdoutByteHashVerified, false); assert.equal(event.worksVerified, false); assert.equal(event.originalHolds[0].last_error, oldQueue.last_error);
  const after = f.db.prepare('SELECT total_changes() n').get().n; assert.equal(f.apply(plan).status, 'already-applied'); assert.equal(f.db.prepare('SELECT total_changes() n').get().n, after);
});

test('rejects missing/different file or semantic checksum', t => {
  const f = fixture(t), input = f.input(); input.sourceReceipt.evidenceFileSha256 = 'a'.repeat(64);
  assert.equal(validateProfileMonitoringRecovery(f.db, input, { reference: NOW }).status, 'blocked');
  input.sourceReceipt.evidenceFileSha256 = digest(input.evidenceText); input.sourceReceipt.parsedDataJsonSha256 = 'b'.repeat(64);
  assert.equal(validateProfileMonitoringRecovery(f.db, input, { reference: NOW }).status, 'blocked');
});

test('does not restore an explicitly manual pause or any unverified pause', t => {
  const f = fixture(t); f.db.prepare('INSERT INTO activity_log VALUES(1,5,?,?,?,?,?,?)').run('管理者', 'target.update', 'target', '1', '2026-10-08T00:00:00.000Z', '{"enabled":false}');
  assert.equal(f.validate().status, 'blocked');
  f.db.prepare('DELETE FROM activity_log').run(); f.db.prepare('UPDATE author_resolution_queue SET suspended_target_enabled=0').run(); assert.equal(f.validate().status, 'blocked');
});

test('null metrics remain null and are never replaced with zero', t => {
  const f = fixture(t); f.probe.rawResponse.data.profile.user.follower_count = null;
  const plan = f.validate(); assert.equal(plan.status, 'ready', plan.reason); const result = f.apply(plan);
  const s = f.db.prepare('SELECT followers,account_status FROM snapshots WHERE id=?').get(result.snapshotId);
  assert.equal(s.followers, null); assert.equal(s.account_status, 'partial');
});

test('rejects negative, fractional or rounded numeric values, login challenges and work requests', t => {
  for (const mutate of [p => p.rawResponse.data.profile.user.follower_count = -1, p => p.rawResponse.data.profile.user.total_favorited = 1.5,
    p => p.rawResponse.data.profile.user.aweme_count = Number.MAX_SAFE_INTEGER + 1, p => p.rawResponse.data.need_login = true,
    p => p.rawResponse.data.works.pagination.requestCount = 1, p => p.signedFallbackDisabled = false]) {
    const f = fixture(t); mutate(f.probe); assert.equal(f.validate().status, 'blocked');
  }
});

test('rejects stale probes, unmatched current handle and same canonical with a different historical UID', t => {
  const f = fixture(t); assert.equal(validateProfileMonitoringRecovery(f.db, f.input(), { reference: '2026-10-09T16:00:00.000Z' }).status, 'blocked');
  f.probe.rawResponse.data.profile.user.unique_id = 'different'; assert.equal(f.validate().status, 'blocked');
  f.probe.rawResponse.data.profile.user.unique_id = 'ExampleId'; f.probe.rawResponse.data.profile.user.uid = '22222222'; assert.equal(f.validate().status, 'blocked');
});

test('active leases, active import/collection, and identity mismatch cannot be recovered', t => {
  const f = fixture(t); f.db.prepare("UPDATE author_resolution_queue SET lease_owner='worker'").run(); assert.equal(f.validate().status, 'blocked');
  f.db.prepare("UPDATE author_resolution_queue SET lease_owner=NULL,last_error='作者身份不一致'").run(); assert.equal(f.validate().status, 'blocked');
  f.db.prepare("UPDATE author_resolution_queue SET last_error='403 blocked'").run(); f.db.prepare("INSERT INTO author_resolution_jobs VALUES(1,'running')").run(); assert.equal(f.validate().status, 'blocked');
});

test('CAS plan detects intervening user edits and rolls back without any new evidence', t => {
  const f = fixture(t), plan = f.validate(); f.db.prepare("UPDATE targets SET label='用户改名'").run();
  assert.throws(() => f.apply(plan), /计划或数据库状态已变化/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM snapshots').get().n, 1); assert.equal(f.db.prepare('SELECT count(*) n FROM runs').get().n, 0);
  assert.equal(f.db.prepare('SELECT enabled FROM targets').get().enabled, 0);
});

test('SQL failure after snapshot insertion rolls back run, snapshot, event, holds and enabled together', t => {
  const f = fixture(t), plan = f.validate(); f.db.exec("CREATE TRIGGER abort_recovery BEFORE INSERT ON account_events BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  assert.throws(() => f.apply(plan), /test failure/); assert.equal(f.db.prepare('SELECT count(*) n FROM runs').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM snapshots').get().n, 1); assert.equal(f.db.prepare('SELECT suspended_target_enabled flag FROM author_resolution_queue').get().flag, 1);
  assert.equal(f.db.prepare('SELECT enabled FROM targets').get().enabled, 0);
});
