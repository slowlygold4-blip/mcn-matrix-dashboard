import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { checksum } from '../lib/utils.mjs';
import { OFFICIAL_DOUYIN_PROFILE_ENDPOINT } from '../lib/official-profile-evidence.mjs';
import { readStoredDouyinAliasMatches } from '../lib/roster-alias-history.mjs';
import { linkRosterProfiles } from '../lib/roster-profile-links.mjs';

const SEC = 'MS4wLjABAAAARunningAliasOwner12345', OTHER = 'MS4wLjABAAAARunningAliasOther12345', UID = '123456789012345';
const OLD = '2026-09-23T12:00:00.000Z', AT = '2026-09-24T12:00:00.000Z', CURRENT = '2026-10-09T12:00:00.000Z';
const NOW = '2026-10-09T12:01:00.000Z';
function raw(at, handle, sec = SEC, uid = UID) {
  return { capturedAt: at, profile: { user: { sec_uid: sec, uid, unique_id: handle, short_id: '0' } },
    accountStatus: 'validated', accountError: null, works: { aweme_list: [] }, provenance: {
      mode: 'guest-ttwid-unsigned-profile-a-bogus-posts', profileMode: 'guest-ttwid-unsigned-profile',
      profileEndpoint: OFFICIAL_DOUYIN_PROFILE_ENDPOINT, accountLocator: 'sec_uid', cookiePersisted: false, runtimeAI: false, paidAPI: false } };
}
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE targets(id INTEGER PRIMARY KEY,type TEXT,provider TEXT,locator TEXT,enabled INTEGER,metadata_json TEXT);
    CREATE TABLE snapshots(id INTEGER PRIMARY KEY,target_id INTEGER,captured_at TEXT,quality_status TEXT,account_status TEXT,source_checksum TEXT,raw_json TEXT);
    CREATE TABLE audits(id INTEGER PRIMARY KEY,target_id INTEGER,run_id INTEGER,created_at TEXT,provider TEXT,status TEXT,source_checksum TEXT);
    CREATE TABLE runs(id INTEGER PRIMARY KEY,target_id INTEGER,started_at TEXT,finished_at TEXT,status TEXT);
    CREATE TABLE account_events(id INTEGER PRIMARY KEY,target_id INTEGER,run_id INTEGER,event_type TEXT,event_key TEXT,observed_at TEXT,source_checksum TEXT,event_json TEXT,raw_json TEXT,created_at TEXT);
    CREATE TABLE author_resolution_queue(id INTEGER PRIMARY KEY,resolved_target_id INTEGER,suspended_target_enabled INTEGER,status TEXT,last_error TEXT);`);
  db.prepare('INSERT INTO targets VALUES(1,?,?,?,?,?)').run('account', 'public-web', SEC, 1, '{"platform":"douyin","douyinId":"old-id"}');
  const oldRaw = raw(OLD, 'old-id'), eventRaw = raw(AT, 'NewId'), currentRaw = raw(CURRENT, 'NewId');
  for (const [id, body] of [[10, oldRaw], [11, eventRaw], [12, currentRaw]]) {
    db.prepare('INSERT INTO snapshots VALUES(?,1,?,?,?,?,?)').run(id, body.capturedAt, 'warning', 'available', checksum(body), JSON.stringify(body));
  }
  db.prepare('INSERT INTO runs VALUES(30,NULL,?,?,?)').run('2026-09-24T11:00:00.000Z', '2026-09-24T13:00:00.000Z', 'partial');
  db.prepare('INSERT INTO runs VALUES(31,NULL,?,NULL,?)').run('2026-10-09T11:00:00.000Z', 'running');
  db.prepare('INSERT INTO audits VALUES(20,1,30,?,?,?,?)').run('2026-09-24T12:00:00.020Z', 'public-web', 'warning', checksum(eventRaw));
  db.prepare('INSERT INTO audits VALUES(21,1,31,?,?,?,?)').run('2026-10-09T12:00:00.020Z', 'public-web', 'warning', checksum(currentRaw));
  const proof = { type: 'douyin-account-alias-change', version: 1, mode: 'verified-snapshot-dual-id-continuity',
    targetId: 1, platform: 'douyin', submittedAccountId: 'old-id', previousPublicAccountId: 'old-id', currentPublicAccountId: 'NewId',
    canonicalAccountId: SEC, uid: UID, priorSnapshotId: 10, priorSnapshotCapturedAt: OLD, priorSourceChecksum: checksum(oldRaw),
    priorMatchField: 'unique_id', currentRawSha256: checksum(eventRaw), observedAt: AT, verifiedAt: '2026-09-24T12:00:00.010Z',
    historicalSnapshotCount: 1, historyEvidenceSha256: checksum([{ snapshotId: 10, capturedAt: OLD, sourceChecksum: checksum(oldRaw) }]) };
  db.prepare('INSERT INTO account_events VALUES(1,1,30,?,?,?,?,?,?,?)').run('alias', checksum([1, 'old-id', 'old-id', 'NewId', SEC, UID]), AT,
    checksum(eventRaw), JSON.stringify(proof), JSON.stringify(eventRaw), '2026-09-24T12:00:00.015Z');
  const updateCurrent = body => {
    db.prepare('UPDATE snapshots SET raw_json=?,source_checksum=? WHERE id=12').run(JSON.stringify(body), checksum(body));
    db.prepare('UPDATE audits SET source_checksum=? WHERE id=21').run(checksum(body));
  };
  return { db, currentRaw, updateCurrent, read: () => readStoredDouyinAliasMatches(db, ['NewId'], { reference: NOW }) };
}

test('running latest batch preserves historical alias without inventing a finished run, sample or write', t => {
  const f = fixture(t), before = f.db.prepare('SELECT total_changes() n').get().n;
  const result = f.read(); assert.equal(result.status, 'ok'); assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].observedAt, AT); assert.equal(result.matches[0].eventId, 1);
  assert.equal(result.matches[0].runId, 30); assert.equal(result.matches[0].snapshotId, 11);
  assert.equal(result.matches[0].identityOnly, true); assert.equal(result.matches[0].newPublicCollection, false);
  assert.equal(result.matches[0].submittedWorksVerified, false);
  assert.equal(f.db.prepare('SELECT finished_at FROM runs WHERE id=31').get().finished_at, null);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before);
  f.db.exec("UPDATE runs SET status='partial',finished_at='2026-10-09T12:00:30.000Z' WHERE id=31");
  assert.equal(f.read().matches.length, 1, 'normal completed run still accepted');
});

test('running latest alias continuity read projection preserves pause and source membership', t => {
  const f = fixture(t); f.db.exec('UPDATE targets SET enabled=0 WHERE id=1');
  const base = { platform: 'douyin', theme: { key: 'tuantuan' }, boards: [], classifications: [], reviewReasons: [], profileLinks: [], sourceLinks: [], sourceTitles: [], evidenceLinks: [], sources: [] };
  const rows = [{ ...base, key: 'target:1', targetId: 1, name: 'old', monitorStatus: 'paused', accountIds: ['old-id'] },
    { ...base, key: 'submitted:new', targetId: null, name: 'new', monitorStatus: 'pending', accountIds: ['NewId'],
      sources: [{ liveJobId: 'original-job', rows: ['12'] }] }];
  const result = linkRosterProfiles(f.db, rows, { reference: NOW });
  assert.equal(result.linkedEntryCount, 1); assert.equal(result.items.length, 1);
  assert.equal(result.items[0].monitorStatus, 'paused'); assert.equal(result.items[0].sources[0].rows[0], '12');
  assert.equal(f.db.prepare('SELECT enabled FROM targets').get().enabled, 0);
});

for (const [label, sql] of [
  ['missing current audit', 'DELETE FROM audits WHERE id=21'],
  ['duplicate current audit', 'INSERT INTO audits SELECT 22,target_id,run_id,created_at,provider,status,source_checksum FROM audits WHERE id=21'],
  ['current audit hash mismatch', "UPDATE audits SET source_checksum='bad' WHERE id=21"],
  ['current audit future', "UPDATE audits SET created_at='2026-10-09T13:00:00.000Z' WHERE id=21"],
  ['current audit before sample', "UPDATE audits SET created_at='2026-10-09T11:59:59.999Z' WHERE id=21"],
  ['current audit quality mismatch', "UPDATE audits SET status='validated' WHERE id=21"],
  ['current audit wrong provider', "UPDATE audits SET provider='other' WHERE id=21"],
  ['current run missing', 'DELETE FROM runs WHERE id=31'],
  ['current run starts after sample', "UPDATE runs SET started_at='2026-10-09T12:00:00.001Z' WHERE id=31"],
  ['current run wrong target', 'UPDATE runs SET target_id=2 WHERE id=31'],
  ['current run malformed start', "UPDATE runs SET started_at='broken' WHERE id=31"],
  ['running with finish recorded', "UPDATE runs SET finished_at='2026-10-09T12:00:30.000Z' WHERE id=31"],
  ['running with empty finish instead of null', "UPDATE runs SET finished_at='' WHERE id=31"],
  ['failed latest run', "UPDATE runs SET status='failed' WHERE id=31"],
  ['interrupted latest run', "UPDATE runs SET status='interrupted' WHERE id=31"],
  ['queued latest run', "UPDATE runs SET status='queued' WHERE id=31"],
  ['completed latest missing finish', "UPDATE runs SET status='success' WHERE id=31"],
  ['completed latest future finish', "UPDATE runs SET status='success',finished_at='2026-10-09T13:00:00.000Z' WHERE id=31"],
  ['historical alias run still running', "UPDATE runs SET status='running',finished_at=NULL WHERE id=30"],
  ['historical alias run failed', "UPDATE runs SET status='failed' WHERE id=30"],
  ['historical alias audit missing', 'DELETE FROM audits WHERE id=20'],
  ['historical raw corruption', "UPDATE snapshots SET raw_json='{}' WHERE id=10"],
  ['latest raw corruption', "UPDATE snapshots SET raw_json='{}' WHERE id=12"],
]) test(`running allowance still rejects ${label}`, t => {
  const f = fixture(t); f.db.exec(sql); assert.equal(f.read().matches.length, 0);
});

for (const [label, mutate] of [
  ['UID drift', r => { r.profile.user.uid = '888888888888888'; }],
  ['canonical drift', r => { r.profile.user.sec_uid = OTHER; }],
  ['capture time mismatch', r => { r.capturedAt = '2026-10-09T11:59:59.000Z'; }],
  ['untrusted provenance', r => { r.provenance.mode = 'metadata'; }],
  ['login gate', r => { r.need_login = true; }],
  ['deleted user', r => { r.profile.user.user_deleted = true; }],
]) test(`running latest profile rejects recomputed-hash ${label}`, t => {
  const f = fixture(t), changed = structuredClone(f.currentRaw); mutate(changed); f.updateCurrent(changed);
  assert.equal(f.read().matches.length, 0);
});
