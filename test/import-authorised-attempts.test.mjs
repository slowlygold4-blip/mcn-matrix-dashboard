import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { prepareImportAuthorisedDetail } from '../lib/import-authorised-detail.mjs';
import { recordImportAuthorisedAttempt, readImportAuthorisedAttempts } from '../lib/import-authorised-attempts.mjs';

const start = '2026-10-09T17:00:00.000Z', end = '2026-10-09T17:00:04.000Z', at = '2026-10-09T17:01:00.000Z';
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE author_resolution_jobs(id TEXT,status TEXT,request_json TEXT,created_at TEXT,finished_at TEXT);
    CREATE TABLE activity_log(id INTEGER PRIMARY KEY,actor_name TEXT,action TEXT,resource_type TEXT,resource_id TEXT,created_at TEXT,details_json TEXT);`);
  const job = { id: 'test-job', status: 'completed', fileName: '上传.xlsx', sheetName: '工作表', request: {
    rows: [{ sourceRow: 2, platform: 'douyin', name: '甲', douyinId: 'abc', videoId: '7685308686524676594' }] } };
  db.prepare('INSERT INTO author_resolution_jobs VALUES(?,?,?,?,?)').run(job.id, job.status, JSON.stringify(job.request),
    '2026-10-09T16:00:00.000Z', '2026-10-09T16:01:00.000Z');
  const input = prepareImportAuthorisedDetail(job, { sourceRow: 2 });
  const attempt = { sourceRow: 2, startedAt: start, finishedAt: end, recordedAt: at, result: { ...input, status: 'unavailable',
    requestStartedAt: start, requestFinishedAt: end, errorCode: 'invalid_evidence',
    diagnostic: { version: 1, stage: 'detail_fields', reason: 'detail_invalid_shape' },
    cookie: 'PRIVATE_VALUE', rawError: 'PRIVATE_PROVIDER_FAILURE' } };
  return { db, job, attempt, read: () => readImportAuthorisedAttempts(db, job, { now: new Date(at) }) };
}
test('append-only fixed projection is source-bound and does not alter historical job or target', t => {
  const { db, job, attempt, read } = fixture(t);
  assert.equal(recordImportAuthorisedAttempt(db, job, attempt), true);
  assert.equal(recordImportAuthorisedAttempt(db, job, attempt), false);
  const output = read().get(2);
  assert.equal(output.origin, 'authorised-work'); assert.equal(output.finishedAt, end);
  assert.match(output.reason, /不代表账号已删除/);
  const text = db.prepare('SELECT details_json FROM activity_log').get().details_json;
  assert.doesNotMatch(text, /PRIVATE_|cookie|rawError/);
  assert.equal(db.prepare('SELECT request_json FROM author_resolution_jobs').get().request_json, JSON.stringify(job.request));
  const before = db.prepare('SELECT total_changes() n').get().n;
  read(); assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
});
test('retained attempt keeps original sampling time and is idempotent', t => {
  const { db, job, attempt, read } = fixture(t);
  const historical = { ...attempt, recordingMode: 'retained-local-response' };
  assert.equal(recordImportAuthorisedAttempt(db, job, historical), true);
  assert.equal(recordImportAuthorisedAttempt(db, job, historical), false);
  assert.equal(read().get(2).startedAt, start);
});
test('stale source, altered identity and invalid observation windows cannot be appended', t => {
  const { db, job, attempt } = fixture(t);
  for (const mutate of [a => { a.result.submittedId = 'different'; }, a => { a.result.requestFinishedAt = '2026-10-09T17:00:50.000Z'; },
    a => { a.result.candidate = {}; }, a => { a.recordedAt = start; }]) {
    const changed = structuredClone(attempt); mutate(changed);
    assert.throws(() => recordImportAuthorisedAttempt(db, job, changed));
  }
  db.exec("UPDATE author_resolution_jobs SET request_json='{}'");
  assert.throws(() => recordImportAuthorisedAttempt(db, job, attempt));
  assert.equal(db.prepare('SELECT count(*) n FROM activity_log').get().n, 0);
});
test('corrupt checksum, changed source row and future log records are ignored', t => {
  const { db, job, attempt, read } = fixture(t);
  recordImportAuthorisedAttempt(db, job, attempt);
  const original = db.prepare('SELECT details_json FROM activity_log').get().details_json;
  db.prepare('UPDATE activity_log SET details_json=?').run(original.replace('invalid_evidence', 'identity_mismatch'));
  assert.equal(read().size, 0);
  db.prepare('UPDATE activity_log SET details_json=?,created_at=?').run(original, '2026-10-10T17:01:00.000Z');
  assert.equal(read().size, 0);
  db.prepare('UPDATE activity_log SET created_at=?').run(at);
  job.request.rows[0].douyinId = 'different'; assert.equal(read().size, 0);
});
test('unknown diagnostic text is not persisted or displayed', t => {
  const { db, job, attempt, read } = fixture(t);
  attempt.result.diagnostic = { version: 1, stage: 'detail_fields', reason: 'PRIVATE_SECRET' };
  recordImportAuthorisedAttempt(db, job, attempt);
  assert.doesNotMatch(JSON.stringify(read().get(2)), /PRIVATE|删除/);
  assert.doesNotMatch(db.prepare('SELECT details_json FROM activity_log').get().details_json, /PRIVATE/);
});
test('an attempt predating the completed source job cannot be replayed or displayed', t => {
  const { db, job, attempt, read } = fixture(t);
  recordImportAuthorisedAttempt(db, job, attempt);
  assert.equal(read().size, 1);
  db.prepare('UPDATE author_resolution_jobs SET finished_at=?').run('2026-10-09T17:00:01.000Z');
  assert.equal(read().size, 0);
  assert.throws(() => recordImportAuthorisedAttempt(db, job, { ...attempt, recordingMode: 'retained-local-response' }), /Stale/);
  assert.equal(db.prepare('SELECT count(*) n FROM activity_log').get().n, 1);
});
