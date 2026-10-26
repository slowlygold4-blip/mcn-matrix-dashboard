import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { checksum } from '../lib/utils.mjs';
import { OFFICIAL_DOUYIN_PROFILE_ENDPOINT } from '../lib/official-profile-evidence.mjs';
import { readStoredDouyinAliasMatches } from '../lib/roster-alias-history.mjs';
import { linkRosterProfiles } from '../lib/roster-profile-links.mjs';

const SEC = 'MS4wLjABAAAAHistoricalAliasOwner12345';
const OTHER = 'MS4wLjABAAAAHistoricalAliasOther12345';
const UID = '123456789012345';
const OLD = '2026-09-23T12:00:00.000Z', AT = '2026-09-24T12:00:00.000Z', CURRENT = '2026-10-09T12:00:00.000Z';
const NOW = '2026-10-15T12:00:00.000Z';
function raw(at, handle, sec = SEC, uid = UID) {
  return { capturedAt: at, profile: { user: { sec_uid: sec, uid, unique_id: handle, short_id: '0', nickname: 'ignored' } },
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
  const snapshot = (id, body, target = 1) => db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?,?,?)').run(id, target, body.capturedAt, 'warning', 'available', checksum(body), JSON.stringify(body));
  snapshot(10, oldRaw); snapshot(11, eventRaw); snapshot(12, currentRaw);
  db.prepare('INSERT INTO runs VALUES(30,NULL,?,?,?)').run('2026-09-24T11:00:00.000Z', '2026-09-24T13:00:00.000Z', 'partial');
  db.prepare('INSERT INTO runs VALUES(31,NULL,?,?,?)').run('2026-10-09T11:00:00.000Z', '2026-10-09T13:00:00.000Z', 'success');
  db.prepare('INSERT INTO audits VALUES(20,1,30,?,?,?,?)').run('2026-09-24T12:00:00.020Z', 'public-web', 'warning', checksum(eventRaw));
  db.prepare('INSERT INTO audits VALUES(21,1,31,?,?,?,?)').run('2026-10-09T12:00:00.020Z', 'public-web', 'warning', checksum(currentRaw));
  const proof = { type: 'douyin-account-alias-change', version: 1, mode: 'verified-snapshot-dual-id-continuity',
    targetId: 1, platform: 'douyin', submittedAccountId: 'old-id', previousPublicAccountId: 'old-id', currentPublicAccountId: 'NewId',
    canonicalAccountId: SEC, uid: UID, priorSnapshotId: 10, priorSnapshotCapturedAt: OLD, priorSourceChecksum: checksum(oldRaw),
    priorMatchField: 'unique_id', currentRawSha256: checksum(eventRaw), observedAt: AT, verifiedAt: '2026-09-24T12:00:00.010Z',
    historicalSnapshotCount: 1, historyEvidenceSha256: checksum([{ snapshotId: 10, capturedAt: OLD, sourceChecksum: checksum(oldRaw) }]) };
  const saveProof = () => db.prepare('UPDATE account_events SET event_json=? WHERE id=1').run(JSON.stringify(proof));
  db.prepare('INSERT INTO account_events VALUES(1,1,30,?,?,?,?,?,?,?)').run('alias', checksum([1, 'old-id', 'old-id', 'NewId', SEC, UID]), AT,
    checksum(eventRaw), JSON.stringify(proof), JSON.stringify(eventRaw), '2026-09-24T12:00:00.015Z');
  return { db, proof, saveProof, snapshot, read: (ids = ['NewId'], reference = NOW) => readStoredDouyinAliasMatches(db, ids, { reference }) };
}

test('historical identity remains linked after 24 hours without creating a fresh observation or changing rows', t => {
  const f = fixture(t), before = f.db.prepare('SELECT total_changes() n').get().n, result = f.read();
  assert.equal(result.status, 'ok'); assert.equal(result.matches.length, 1);
  const p = result.matches[0]; assert.equal(p.submittedAccountId, 'newid'); assert.equal(p.proofType, 'historical-alias');
  assert.equal(p.observedAt, AT); assert.equal(p.eventId, 1); assert.equal(p.targetId, 1); assert.equal(p.targetEnabled, true);
  assert.equal(p.identityOnly, true); assert.equal(p.newPublicCollection, false); assert.equal(p.submittedWorksVerified, false);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before);
});

test('production roster integration links only the verified durable alias and retains sources when offline', t => {
  const f = fixture(t), base = { platform: 'douyin', theme: { key: 'tuantuan', label: '团团' },
    boards: [], classifications: [], reviewReasons: [], profileLinks: [], sourceLinks: [], sourceTitles: [], evidenceLinks: [], sources: [] };
  const rows = [{ ...base, key: 'target:1', targetId: 1, name: 'original', monitorStatus: 'enabled', accountIds: ['old-id'] },
    { ...base, key: 'submitted:new', targetId: null, name: 'new', monitorStatus: 'pending', accountIds: ['NewId'],
      sources: [{ fileName: 'source.xlsx', sheetName: 'Sheet1', rows: ['3'] }] }];
  const actual = linkRosterProfiles(f.db, rows, { reference: NOW });
  assert.equal(actual.linkedEntryCount, 1); assert.equal(actual.items.length, 1);
  assert.equal(actual.items[0].sources[0].rows[0], '3');
  assert.equal(actual.items[0].linkedSourceEntries[0].proofs[0].proofType, 'historical-alias');
  assert.equal(linkRosterProfiles(f.db, rows, { reference: '2026-11-15T12:00:00.000Z' }).linkedEntryCount, 1);
  f.db.exec('DELETE FROM account_events');
  assert.equal(linkRosterProfiles(f.db, rows, { reference: NOW }).linkedEntryCount, 0, 'a matching latest profile alone must not masquerade as a durable binding');
});

test('a later valid snapshot does not alter the event-time historical chain', t => {
  const f = fixture(t); assert.equal(f.read().matches.length, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM snapshots').get().n, 3);
});

test('paused account remains paused and no enabling is performed', t => {
  const f = fixture(t); f.db.prepare('UPDATE targets SET enabled=0 WHERE id=1').run();
  assert.equal(f.read().matches[0].targetEnabled, false); assert.equal(f.db.prepare('SELECT enabled FROM targets').get().enabled, 0);
});

for (const [label, field, value] of [
  ['mode', 'mode', 'metadata-asserted'], ['type', 'type', 'other'], ['target', 'targetId', 2], ['canonical', 'canonicalAccountId', OTHER],
  ['uid', 'uid', '22222222'], ['old-id', 'previousPublicAccountId', 'unproved'], ['prior-snapshot', 'priorSnapshotId', 12],
  ['history-count', 'historicalSnapshotCount', 2], ['history-hash', 'historyEvidenceSha256', 'a'.repeat(64)],
  ['event-raw-hash', 'currentRawSha256', 'b'.repeat(64)], ['future-proof', 'verifiedAt', '2027-01-01T00:00:00.000Z'],
]) test(`rejects invalid immutable event ${label}`, t => {
  const f = fixture(t); f.proof[field] = value; f.saveProof(); assert.equal(f.read().matches.length, 0);
});

test('rejects altered event key', t => {
  const f = fixture(t); f.db.prepare("UPDATE account_events SET event_key='bad'").run(); assert.equal(f.read().matches.length, 0);
});

test('rejects altered event raw bytes even when event metadata remains intact', t => {
  const f = fixture(t); f.db.prepare("UPDATE account_events SET raw_json='{}'").run(); assert.equal(f.read().matches.length, 0);
});

test('rejects corrupted prior snapshot rather than trusting its saved hash field', t => {
  const f = fixture(t); f.db.prepare("UPDATE snapshots SET raw_json='{}' WHERE id=10").run(); assert.equal(f.read().matches.length, 0);
});

test('requires original source ID to remain anchored in the target metadata', t => {
  const f = fixture(t); f.db.prepare('UPDATE targets SET metadata_json=?').run('{"platform":"douyin","douyinId":"edited-other"}');
  assert.equal(f.read().matches.length, 0);
});

test('rejects absent or failed historical run and missing historical audit', t => {
  const f = fixture(t); f.db.prepare("UPDATE runs SET status='interrupted' WHERE id=30").run(); assert.equal(f.read().matches.length, 0);
  f.db.prepare("UPDATE runs SET status='partial' WHERE id=30").run(); f.db.prepare('DELETE FROM audits WHERE id=20').run(); assert.equal(f.read().matches.length, 0);
});

test('rejects current canonical drift, UID drift or unverifiable latest profile', t => {
  const f = fixture(t); f.db.prepare('UPDATE targets SET locator=?').run(OTHER); assert.equal(f.read().matches.length, 0);
  f.db.prepare('UPDATE targets SET locator=?').run(SEC); const body = raw(CURRENT, 'NewId', SEC, '99999999');
  f.db.prepare('UPDATE snapshots SET raw_json=?,source_checksum=? WHERE id=12').run(JSON.stringify(body), checksum(body));
  f.db.prepare('UPDATE audits SET source_checksum=? WHERE id=21').run(checksum(body)); assert.equal(f.read().matches.length, 0);
});

test('explicit ownership conflicts block, transport failures do not rewrite historical identity', t => {
  const f = fixture(t); f.db.prepare('INSERT INTO author_resolution_queue VALUES(1,1,1,?,?)').run('rejected', '403 blocked');
  assert.equal(f.read().matches.length, 1);
  f.db.prepare('UPDATE author_resolution_queue SET last_error=?').run('作品发布者身份不一致'); assert.equal(f.read().matches.length, 0);
});

test('a second canonical account claiming the same handle makes the historical handle ambiguous', t => {
  const f = fixture(t); f.db.prepare('INSERT INTO targets VALUES(2,?,?,?,?,?)').run('account', 'public-web', OTHER, 1, '{}');
  f.snapshot(40, raw(CURRENT, 'NewId', OTHER, '88888888'), 2);
  const result = f.read(); assert.equal(result.matches.length, 0); assert.deepEqual(result.ambiguousIds, ['newid']);
});

test('does not resolve nicknames, old source ID, coerced numeric IDs or absent proof tables', t => {
  const f = fixture(t); assert.equal(f.read(['ignored', 'old-id', 123, null]).matches.length, 0);
  f.db.exec('DROP TABLE account_events'); assert.equal(f.read().status, 'unavailable');
});
