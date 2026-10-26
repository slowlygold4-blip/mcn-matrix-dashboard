import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildMasterRosterSnapshot, installMasterRoster } from '../lib/master-roster.mjs';
import { readImportMonitoringStatus } from '../lib/import-monitoring-status.mjs';
import { buildAuthorEvidenceRequests } from '../lib/author-resolution.mjs';
import { checksum } from '../lib/utils.mjs';

const now = new Date('2026-10-09T15:00:00.000Z');
const locator = 'MS4wLjABAAAAabcdefghijklmnop';
function fixture(t, { rows, ids = ['abc'], enabled = 1, snapshots = true } = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE targets(id INTEGER PRIMARY KEY,type TEXT,provider TEXT,metadata_json TEXT,locator TEXT,label TEXT,enabled INTEGER);
    CREATE TABLE target_boards(target_id INTEGER,board_name TEXT);
    CREATE TABLE author_resolution_jobs(id TEXT PRIMARY KEY,file_name TEXT,sheet_name TEXT,status TEXT,created_at TEXT,finished_at TEXT,request_json TEXT,result_json TEXT);
    CREATE TABLE author_resolution_queue(identity_key TEXT PRIMARY KEY,status TEXT);
    CREATE TABLE snapshots(id INTEGER PRIMARY KEY,target_id INTEGER,captured_at TEXT,followers INTEGER,total_likes INTEGER,total_posts INTEGER,quality_status TEXT,source_checksum TEXT,raw_json TEXT,account_status TEXT DEFAULT 'available');
    CREATE INDEX snapshot_time ON snapshots(target_id,captured_at DESC,id DESC);`);
  db.prepare('INSERT INTO targets VALUES(?,?,?,?,?,?,?)').run(1, 'account', 'public-web', '{"platform":"douyin"}', locator, '现在名称', enabled);
  db.prepare('INSERT INTO target_boards(target_id,board_name) VALUES(?,?)').run(1, '一条小团团切片矩阵');
  installMasterRoster(db, buildMasterRosterSnapshot({ exportedAt: '2026-10-02T19:00:00Z', entities: [
    { key: 'target:1', targetId: 1, platform: 'douyin', currentName: '原名称', names: ['原名称'], ids, locators: [locator], enabled: Boolean(enabled) },
  ] }, { fileName: 'frozen.xlsx', sha256: 'a'.repeat(64) }));
  const job = { id: '11111111-1111-4111-8111-111111111111', status: 'completed', request: {
    fileName: '上传.xlsx', sheetName: '作品登记', sourceType: 'author-spreadsheet', uploadSha256: 'b'.repeat(64),
    defaultBoard: '一条小团团切片矩阵',
    rows: rows || [{ sourceRow: 2, platform: 'douyin', name: '作者甲', douyinId: 'ABC' },
      { sourceRow: 3, platform: 'douyin', name: '另一个名称', douyinId: 'abc' },
      { sourceRow: 4, platform: 'douyin', name: '作者甲', douyinId: 'pending-id' }],
  } };
  db.prepare('INSERT INTO author_resolution_jobs VALUES(?,?,?,?,?,?,?,?)').run(job.id, '上传.xlsx', '作品登记', 'completed', '2026-10-09T12:00:00Z', '2026-10-09T12:01:00Z', JSON.stringify(job.request), '{"ok":true}');
  if (snapshots) addSnapshot(db);
  return { db, job, read: options => readImportMonitoringStatus(db, job, { now, ...options }) };
}
function addSnapshot(db, { at = '2026-10-09T14:59:00.000Z', followers = 0, uid = '123456789', secUid = locator, quality = 'validated', corrupt = false, stored = followers } = {}) {
  const raw = { capturedAt: at, user: { uid, sec_uid: secUid, follower_count: followers, total_favorited: 1, aweme_count: 2 } };
  db.prepare('INSERT INTO snapshots(target_id,captured_at,followers,total_likes,total_posts,quality_status,source_checksum,raw_json) VALUES(?,?,?,?,?,?,?,?)')
    .run(1, at, stored, 1, 2, quality, corrupt ? 'bad' : checksum(raw), JSON.stringify(raw));
}

test('distinct identities, not work rows or names; enabled sampling is read-only and source-bound', t => {
  const { db, job, read } = fixture(t);
  const before = db.prepare('SELECT total_changes() n').get().n;
  const request = db.prepare('SELECT request_json,result_json FROM author_resolution_jobs WHERE id=?').get(job.id);
  const result = read();
  assert.equal(result.inputRows, 3); assert.equal(result.sourceAvailable, true);
  assert.deepEqual(result.counts, { submittedIdentities: 2, enabled: 1, paused: 0, pending: 1, conflict: 0, unknown: 0,
    freshProfiles: 1, staleProfiles: 0, missingProfiles: 0, invalidProfiles: 0 });
  assert.deepEqual(result.resolutionCounts, { retrying: 0, evidence_exhausted: 0, evidence_missing: 1 });
  assert.equal(result.items[0].sourceRows, 2); assert.equal(result.items[0].targetId, 1);
  assert.equal(result.items[0].sampledAt, '2026-10-09T14:59:00.000Z');
  assert.equal(result.items[1].targetId, null); assert.equal(result.items[1].profileStatus, 'not_enabled');
  assert.deepEqual(result.matrixScope, { available: true, boardNames: ['一条小团团切片矩阵'], boardCount: 1,
    totalAccounts: 1, enabledAccounts: 1, pausedAccounts: 0,
    scope: 'current-union-of-submitted-board-account-memberships-not-this-job-only' });
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
  assert.deepEqual(db.prepare('SELECT request_json,result_json FROM author_resolution_jobs WHERE id=?').get(job.id), request);
});
test('pending identities expose exact live retry, exhausted and missing-evidence states', t => {
  const rows = [
    { sourceRow: 2, platform: 'douyin', name: '重试作者', douyinId: 'retry-id', videoId: '7123456789012345678' },
    { sourceRow: 3, platform: 'douyin', name: '耗尽作者', douyinId: 'exhausted-id', videoId: '7123456789012345679' },
    { sourceRow: 4, platform: 'douyin', name: '缺证作者', douyinId: 'missing-id', status: 'needs_locator' },
  ];
  const { db, read } = fixture(t, { rows });
  for (const [row, status] of [[rows[0], 'retry'], [rows[1], 'rejected']]) {
    const request = buildAuthorEvidenceRequests([row])[0];
    db.prepare('INSERT INTO author_resolution_queue(identity_key,status) VALUES(?,?)').run(request.key, status);
  }
  // A same-name but different submitted identity/evidence key is not source-bound
  // to this job and must not turn the missing author into a retry.
  const unrelated = buildAuthorEvidenceRequests([{ ...rows[2], status: 'resolvable', douyinId: 'other-id', videoId: '7123456789012345680' }])[0];
  db.prepare('INSERT INTO author_resolution_queue(identity_key,status) VALUES(?,?)').run(unrelated.key, 'retry');
  const result = read();
  assert.deepEqual(result.resolutionCounts, { retrying: 1, evidence_exhausted: 1, evidence_missing: 1 });
  assert.deepEqual(Object.fromEntries(result.items.map(item => [item.submittedId, item.resolutionState])), {
    'retry-id': 'retrying', 'exhausted-id': 'evidence_exhausted', 'missing-id': 'evidence_missing',
  });
});
test('pause is not reversed and a valid zero remains a real sample, not missing', t => {
  const { read } = fixture(t, { enabled: 0 });
  assert.equal(read().counts.paused, 1); assert.equal(read().counts.freshProfiles, 0);
});
test('filtering paginates identities while totals remain for the whole job', t => {
  const { read } = fixture(t);
  const first = read({ limit: 1 }); assert.equal(first.pagination.hasMore, true);
  assert.equal(read({ offset: 1, limit: 1 }).items[0].status, 'pending');
  const pending = read({ status: 'pending' }); assert.equal(pending.items.length, 1); assert.equal(pending.counts.enabled, 1);
  assert.equal(read({ offset: 999 }).pagination.offset, 0);
  assert.equal(read({ offset: 999 }).items.length, 2);
  for (const options of [{ limit: 101 }, { offset: -1 }, { limit: 'x' }, { status: 'anything' }]) assert.throws(() => read(options), TypeError);
});
test('later source replay makes old job unknown, not all pending or falsely completed', t => {
  const { db, job, read } = fixture(t);
  db.prepare('INSERT INTO author_resolution_jobs SELECT ?,file_name,sheet_name,status,?, ?,request_json,result_json FROM author_resolution_jobs WHERE id=?')
    .run('22222222-2222-4222-8222-222222222222', '2026-10-09T13:00:00Z', '2026-10-09T13:01:00Z', job.id);
  const result = read(); assert.equal(result.sourceAvailable, false); assert.equal(result.counts.unknown, 2);
  assert.equal(result.counts.enabled, 0); assert.equal(result.counts.pending, 0);
});
test('nickname-only rows are not invented as distinct accounts or linked by equal name', t => {
  const { read } = fixture(t, { rows: [{ sourceRow: 1, name: '现在名称' }, { sourceRow: 2, name: '现在名称' }] });
  const result = read(); assert.equal(result.counts.submittedIdentities, 0);
  assert.equal(result.identitySummary.unknownIdentityItemCount, 2); assert.equal(result.identitySummary.distinctAccountCount, null);
});
test('a submitted handle plus a contradicting canonical locator cannot adopt another target', t => {
  const { read } = fixture(t, { rows: [{ sourceRow: 2, name: '甲', douyinId: 'abc', locator: 'MS4wLjABAAAAdifferentcanonical' }] });
  assert.equal(read().items[0].status, 'conflict'); assert.equal(read().counts.enabled, 0);
});
test('explicit canonical-only and matching handle rows share one submitted identity', t => {
  const { read } = fixture(t, { rows: [{ sourceRow: 2, name: '甲', douyinId: 'abc', locator }, { sourceRow: 3, name: '乙', locator }] });
  const result = read(); assert.equal(result.counts.submittedIdentities, 1); assert.equal(result.items[0].sourceRows, 2);
});
test('no last snapshot is missing, not a zero observation', t => {
  const { read } = fixture(t, { snapshots: false }); assert.equal(read().counts.missingProfiles, 1);
});
test('latest persisted failure cannot be masked by an older valid snapshot', t => {
  const { db, read } = fixture(t); addSnapshot(db, { at: '2026-10-09T15:00:00.000Z', quality: 'rejected' });
  assert.equal(read().counts.invalidProfiles, 1); assert.equal(read().counts.freshProfiles, 0);
});
for (const [name, options] of Object.entries({ future: { at: '2026-10-09T15:01:00.000Z' }, identity: { secUid: 'MS4wLjABAAAAdifferentcanonical' },
  checksum: { corrupt: true }, vector: { stored: 12 }, partial: { followers: null } })) {
  test(`snapshot ${name} is not advertised as fresh`, t => {
    const { db, read } = fixture(t, { snapshots: false }); addSnapshot(db, options);
    assert.equal(read().counts.invalidProfiles, 1); assert.equal(read().items[0].sampledAt, null);
  });
}
test('8-hour freshness is based on actual sampling timestamp', t => {
  const { db, read } = fixture(t, { snapshots: false }); addSnapshot(db, { at: '2026-10-09T07:00:00.000Z' });
  assert.equal(read().counts.freshProfiles, 1);
  assert.equal(read({ now: new Date('2026-10-09T15:00:00.001Z') }).counts.staleProfiles, 1);
});
test('latest sample is ordered by time instant, including offsets and fractional precision', t => {
  const { db, read } = fixture(t, { snapshots: false });
  addSnapshot(db, { at: '2026-10-09T13:00:00+08:00' });
  addSnapshot(db, { at: '2026-10-09T12:00:00.001Z' });
  addSnapshot(db, { at: '2026-10-09T12:00:00Z' });
  // raw capturedAt requires canonical UTC if present; offset source is omitted.
  assert.equal(read().items[0].sampledAt, '2026-10-09T12:00:00.001Z');
  assert.equal(read().counts.freshProfiles, 1);
});
for (const [name, change] of Object.entries({ unavailable: db => db.exec("UPDATE snapshots SET account_status='unavailable'"),
  deleted: raw => { raw.user.user_deleted = true; }, challenge: raw => { raw.captcha_required = true; } })) {
  test(`${name} profile cannot claim current monitoring success`, t => {
    const { db, read } = fixture(t);
    if (name === 'unavailable') change(db);
    else { const row = db.prepare('SELECT * FROM snapshots').get(); const raw = JSON.parse(row.raw_json); change(raw);
      db.prepare('UPDATE snapshots SET raw_json=?,source_checksum=?').run(JSON.stringify(raw), checksum(raw)); }
    assert.equal(read().counts.invalidProfiles, 1);
  });
}
test('shared grouping retains platform aliases and inferred evidence platform', t => {
  const { db, job } = fixture(t);
  // No live source for this synthetic read: identity grouping still has exactly
  // the same semantics as the original receipt, without defaulting to Douyin.
  job.id = '22222222-2222-4222-8222-222222222222';
  for (const row of [{ platform: '抖音', douyinId: 'ABC' }, { platform: 'b站', bilibiliId: '123' },
    { bilibiliId: '456', douyinId: 'not-douyin', shareUrl: 'https://b23.tv/identity' }]) {
    job.request.rows = [row]; const result = readImportMonitoringStatus(db, job, { now });
    assert.equal(result.counts.submittedIdentities, 1);
    assert.equal(result.items[0].platform, row.bilibiliId ? 'bilibili' : 'douyin');
  }
});
