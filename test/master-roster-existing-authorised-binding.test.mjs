import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { buildMasterRosterSnapshot, installMasterRoster, readMasterRoster } from '../lib/master-roster.mjs';
import { buildAuthorEvidenceRequests } from '../lib/author-resolution.mjs';
import { readImportMonitoringStatus } from '../lib/import-monitoring-status.mjs';

const ID = '80336194274', VIDEO = '7686424948055891786', SEC = 'MS4wLjABAAAAexistingFrozenAuthor123456';
const OTHER = 'MS4wLjABAAAAexistingOtherAuthor123456';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture(t, { receipt = true, badHash = false, submittedId = ID, proofId = submittedId, existingTarget = false,
  conflict = false, duplicate = false, sourceMismatch = false, paused = false, short = false, conflictingLocator = false,
  duplicateId = submittedId, duplicateTarget = false, duplicateConflict = false, duplicateLocator = false,
  duplicateExtraId = false, legacyProof = false } = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE targets(id INTEGER PRIMARY KEY,type TEXT,metadata_json TEXT,locator TEXT,label TEXT,enabled INTEGER);
    CREATE TABLE author_resolution_jobs(id TEXT PRIMARY KEY,file_name TEXT,sheet_name TEXT,status TEXT,created_at TEXT,finished_at TEXT,request_json TEXT,result_json TEXT);
    CREATE TABLE author_resolution_success_receipts(id INTEGER PRIMARY KEY,queue_id INTEGER,evidence_version INTEGER,identity_key TEXT,target_id INTEGER,platform TEXT,canonical_account_id TEXT,verified_at TEXT,receipt_sha256 TEXT,payload_json TEXT);`);
  db.prepare('INSERT INTO targets VALUES(?,?,?,?,?,?)').run(1, 'account', '{"platform":"douyin"}', SEC, '平台当前名称', paused ? 0 : 1);
  db.prepare('INSERT INTO targets VALUES(?,?,?,?,?,?)').run(2, 'account', '{"platform":"douyin"}', OTHER, '不可覆盖的账号', 1);
  const entity = { key: existingTarget ? 'target:2' : 'submitted:original', ...(existingTarget ? { targetId: 2, locators: [OTHER], enabled: true } : {}),
    ...(conflictingLocator ? { locators: [OTHER] } : {}),
    platform: 'douyin', names: ['原登记姓名'], ids: [submittedId], errors: conflict ? ['账号身份冲突，待核对'] : [],
    sources: [{ url: 'https://example.feishu.cn/wiki/original', title: '原资料', rows: ['9'] }] };
  installMasterRoster(db, buildMasterRosterSnapshot({ exportedAt: '2026-10-02T00:00:00.000Z', entities: [entity,
    ...(duplicate ? [{ ...entity, key: duplicateTarget ? 'target:2' : 'submitted:second',
      ids: duplicateExtraId ? [duplicateId, 'different-handle'] : [duplicateId],
      ...(duplicateTarget ? { targetId: 2, locators: [OTHER], enabled: true } : {}),
      ...(duplicateLocator ? { locators: [OTHER] } : {}),
      ...(duplicateConflict ? { errors: ['作者身份不一致，待核对'] } : {}) }] : [])] }, { fileName: 'frozen.xlsx', sha256: 'a'.repeat(64) }));
  const shareUrl = short ? 'https://v.douyin.com/ExactToken/' : '';
  const row = { sourceRow: 682, platform: 'douyin', name: '原登记姓名', douyinId: submittedId, videoId: short ? '' : VIDEO,
    shareUrl, videoLink: shareUrl || `https://www.douyin.com/video/${VIDEO}`, status: 'resolvable' };
  const request = { fileName: 'uploaded.xlsx', sourceType: 'author-spreadsheet', uploadSha256: 'b'.repeat(64), rows: [row] };
  db.prepare('INSERT INTO author_resolution_jobs VALUES(?,?,?,?,?,?,?,?)').run('current-job', 'uploaded.xlsx', '作者', 'completed',
    '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:01.000Z', JSON.stringify(request), '{}');
  db.prepare('INSERT INTO author_resolution_jobs VALUES(?,?,?,?,?,?,?,?)').run('another-source', 'another.xlsx', '作者', 'completed',
    '2026-10-08T00:00:00.000Z', '2026-10-08T00:00:01.000Z', JSON.stringify({ ...request, fileName: 'another.xlsx', uploadSha256: 'c'.repeat(64) }), '{}');
  if (receipt) {
    const key = buildAuthorEvidenceRequests([row])[0].key;
    const verified = [{ sourceRow: row.sourceRow, videoId: row.videoId, shareUrl, sourceEvidenceUrl: shareUrl, canonicalAccountId: SEC }];
    const proof = { format: 'mcn-author-resolution-success-v1', queueId: 12, evidenceVersion: 2, identityKey: key,
      targetId: 1, platform: 'douyin', canonicalAccountId: SEC, verificationPolicyVersion: 2,
      verifiedAt: '2026-10-09T01:00:00.000Z', committedAt: '2026-10-09T01:00:01.000Z',
      evidence: { douyinId: proofId, videoIds: short ? [] : [VIDEO], shareUrls: short ? [shareUrl] : [] },
      resolution: { mode: 'public-video-detail', platform: 'douyin', canonicalAccountId: SEC, publicDouyinId: proofId,
        verificationPolicy: 'all-submitted-evidence-v2', resolvedAt: '2026-10-09T01:00:00.000Z', verifiedEvidenceCount: 1,
        verifiedEvidence: verified, verifiedEvidenceSha256: hash(verified),
        ...(legacyProof ? {} : { authorisedDetailReceipt: { source: { jobId: sourceMismatch ? 'wrong-job' : 'current-job', sourceRow: row.sourceRow,
          evidenceRequestKey: key, sourceRowSha256: hash(row) } } }) } };
    db.prepare('INSERT INTO author_resolution_success_receipts VALUES(?,?,?,?,?,?,?,?,?,?)').run(1, 12, 2, key, 1, 'douyin', SEC,
      proof.verifiedAt, badHash ? '0'.repeat(64) : hash(proof), JSON.stringify(proof));
  }
  return db;
}
function readWithoutMutation(db) {
  const before = db.prepare('SELECT total_changes() n').get().n;
  const frozen = db.prepare('SELECT * FROM master_roster_entries ORDER BY entry_key').all();
  const result = readMasterRoster(db);
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
  assert.deepEqual(db.prepare('SELECT * FROM master_roster_entries ORDER BY entry_key').all(), frozen);
  return result;
}

test('existing frozen submitted item follows later same-source authorised proof only in derived view', t => {
  const result = readWithoutMutation(fixture(t)), item = result.items[0];
  assert.equal(result.items.length, 1); assert.equal(item.targetId, 1); assert.equal(item.monitorStatus, 'enabled');
  assert.equal(item.name, '平台当前名称'); assert.deepEqual(item.accountIds, [ID]);
  assert.deepEqual(item.originalNames, ['原登记姓名']); assert.equal(item.liveSource, undefined);
  assert.equal(item.liveSourceBinding.jobId, 'current-job');
  assert.equal(item.sources.length, 3); assert.ok(item.sources.some(s => s.title === '原资料'));
  assert.deepEqual(new Set(item.sources.filter(s => s.liveJobId).map(s => s.liveJobId)), new Set(['current-job', 'another-source']));
});

test('an older valid binding remains visible after more than 10,000 unrelated receipts', t => {
  const db = fixture(t);
  db.exec(`WITH RECURSIVE seq(n) AS (SELECT 2 UNION ALL SELECT n+1 FROM seq WHERE n<10002)
    INSERT INTO author_resolution_success_receipts
      (id,queue_id,evidence_version,identity_key,target_id,platform,canonical_account_id,verified_at,receipt_sha256,payload_json)
    SELECT n,n,1,'unrelated:'||n,2,'douyin','${OTHER}','2026-10-09T01:00:00.000Z','invalid','{}' FROM seq`);
  const item = readWithoutMutation(db).items[0];
  assert.equal(item.targetId, 1);
  assert.equal(item.liveSourceBinding.jobId, 'current-job');
});

test('short-ID proof and current paused target are reflected without enabling it', t => {
  const item = readWithoutMutation(fixture(t, { short: true, paused: true })).items[0];
  assert.equal(item.targetId, 1); assert.equal(item.monitorStatus, 'paused');
});

for (const [name, options] of [['missing proof', { receipt: false }], ['bad checksum', { badHash: true }],
  ['different public ID', { proofId: 'other_id' }], ['different source job', { sourceMismatch: true }],
  ['historical identity conflict', { conflict: true }], ['contradicting frozen canonical locator', { conflictingLocator: true }]]) {
  test(`existing frozen submitted item is not promoted with ${name}`, t => {
    const item = readWithoutMutation(fixture(t, options)).items[0];
    assert.equal(item.targetId, null); assert.equal(item.monitorStatus, 'pending');
  });
}

test('an existing different target is never silently replaced', t => {
  const existing = readWithoutMutation(fixture(t, { existingTarget: true }));
  assert.equal(existing.items[0].targetId, 2); assert.equal(existing.items[0].name, '不可覆盖的账号');
});

test('duplicate same-ID frozen sources stay separate but follow the exact same-job proof', t => {
  const duplicates = readWithoutMutation(fixture(t, { duplicate: true }));
  assert.equal(duplicates.items.length, 2); assert.ok(duplicates.items.every(item => item.targetId === 1));
  assert.equal(new Set(duplicates.items.map(item => item.key)).size, 2);
});

test('case-only duplicate frozen sources bind together but current import counts one identity', t => {
  const db = fixture(t, { submittedId: 'shimenliuge7', duplicate: true, duplicateId: 'Shimenliuge7' });
  db.exec("ALTER TABLE targets ADD COLUMN provider TEXT DEFAULT 'public-web'; CREATE TABLE snapshots(id INTEGER PRIMARY KEY,target_id INTEGER,captured_at TEXT)");
  const result = readWithoutMutation(db);
  assert.equal(result.items.length, 2);
  assert.ok(result.items.every(item => item.targetId === 1 && item.monitorStatus === 'enabled'));
  assert.deepEqual(result.items.map(item => item.accountIds), [['shimenliuge7'], ['Shimenliuge7']]);
  const stored = db.prepare('SELECT * FROM author_resolution_jobs WHERE id=?').get('current-job');
  const job = { id: stored.id, status: stored.status, request: JSON.parse(stored.request_json) };
  const before = db.prepare('SELECT total_changes() n').get().n;
  const status = readImportMonitoringStatus(db, job);
  assert.equal(status.counts.submittedIdentities, 1); assert.equal(status.counts.enabled, 1);
  assert.equal(status.items[0].targetId, 1); assert.equal(status.counts.missingProfiles, 1);
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
});

test('case-only duplicates reflect a paused proved target without resuming it', t => {
  const result = readWithoutMutation(fixture(t, { submittedId: 'xingzai2222', duplicate: true, duplicateId: 'XINGZAI2222', paused: true }));
  assert.ok(result.items.every(item => item.targetId === 1 && item.monitorStatus === 'paused'));
});

for (const [name, options] of [
  ['different frozen canonical', { duplicateLocator: true }],
  ['historical identity conflict in one sibling', { duplicateConflict: true }],
  ['multiple IDs in one sibling', { duplicateExtraId: true }],
  ['wrong original source job', { sourceMismatch: true }],
  ['legacy proof without exact job/row/hash', { legacyProof: true }],
]) {
  test(`case-duplicate group stays unbound with ${name}`, t => {
    const result = readWithoutMutation(fixture(t, { submittedId: 'shimenliuge7', duplicate: true, duplicateId: 'Shimenliuge7', ...options }));
    assert.equal(result.items.length, 2); assert.ok(result.items.every(item => item.targetId === null));
  });
}

test('one already-bound different target prevents the whole duplicate promotion without replacing it', t => {
  const result = readWithoutMutation(fixture(t, { submittedId: 'xingzai2222', duplicate: true, duplicateId: 'XINGZAI2222', duplicateTarget: true }));
  assert.equal(result.items.length, 2);
  assert.equal(result.items.find(item => item.key === 'target:2').targetId, 2);
  assert.equal(result.items.find(item => item.key !== 'target:2').targetId, null);
});
