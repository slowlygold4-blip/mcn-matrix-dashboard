import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { checksum } from '../lib/utils.mjs';
import { OFFICIAL_DOUYIN_PROFILE_ENDPOINT } from '../lib/official-profile-evidence.mjs';
import { mergeRosterIdentityLinks } from '../lib/roster-profile-links.mjs';
import { readStoredDouyinProfileIdentityMatches } from '../lib/profile-identity-proof.mjs';
import { validateMasterRoster } from '../public/master-roster.js';

const SEC = 'MS4wLjABAAAAIndependentPeerProfileOwner12345';
const OTHER = 'MS4wLjABAAAAIndependentPeerProfileOther12345';
const NOW = '2026-10-09T15:00:00.000Z';
const AT = '2026-10-09T12:00:00.000Z';
function fixture(t, enabled = 1) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE targets(id INTEGER PRIMARY KEY,type TEXT,provider TEXT,locator TEXT,enabled INTEGER,metadata_json TEXT);
    CREATE TABLE snapshots(id INTEGER PRIMARY KEY,target_id INTEGER,captured_at TEXT,quality_status TEXT,account_status TEXT,source_checksum TEXT,raw_json TEXT);
    CREATE TABLE audits(id INTEGER PRIMARY KEY,target_id INTEGER,run_id INTEGER,created_at TEXT,provider TEXT,status TEXT,source_checksum TEXT);
    CREATE TABLE runs(id INTEGER PRIMARY KEY,target_id INTEGER,started_at TEXT,finished_at TEXT,status TEXT);
    CREATE TABLE account_events(id INTEGER PRIMARY KEY,target_id INTEGER,event_type TEXT,observed_at TEXT,event_json TEXT);
    CREATE TABLE author_resolution_queue(id INTEGER PRIMARY KEY,resolved_target_id INTEGER,suspended_target_enabled INTEGER,status TEXT,last_error TEXT);`);
  const raw = { capturedAt: AT, profile: { user: { sec_uid: SEC, uid: '123456789012345', unique_id: 'PeerNewId', short_id: '123456789', nickname: '公开新名' } },
    accountStatus: 'validated', accountError: null, works: { aweme_list: [] },
    provenance: { mode: 'guest-ttwid-unsigned-profile-a-bogus-posts', profileMode: 'guest-ttwid-unsigned-profile', profileEndpoint: OFFICIAL_DOUYIN_PROFILE_ENDPOINT,
      accountLocator: 'sec_uid', cookiePersisted: false, runtimeAI: false, paidAPI: false } };
  const hash = checksum(raw);
  db.prepare('INSERT INTO targets VALUES(1,?,?,?,?,?)').run('account', 'public-web', SEC, enabled, '{"platform":"douyin","douyinId":"old-id"}');
  db.prepare('INSERT INTO snapshots VALUES(10,1,?,?,?,?,?)').run(AT, 'warning', 'available', hash, JSON.stringify(raw));
  db.prepare('INSERT INTO audits VALUES(20,1,30,?,?,?,?)').run('2026-10-09T12:00:00.015Z', 'public-web', 'warning', hash);
  db.prepare('INSERT INTO runs VALUES(30,NULL,?,?,?)').run('2026-10-09T11:00:00.000Z', '2026-10-09T13:00:00.000Z', 'completed');
  const base = { platform: 'douyin', name: '原始名', originalNames: [], accountIds: [], sourceTitles: [], sourceLinks: [], profileLinks: [], sources: [], evidenceLinks: [],
    reviewReasons: [], classifications: [], boards: [], identityStatus: '', theme: { key: 'tuantuan', label: '团团' } };
  const target = { ...structuredClone(base), key: 'target:1', targetId: 1, monitorStatus: enabled ? 'enabled' : 'paused', accountIds: ['old-id'], profileLinks: [`https://www.douyin.com/user/${SEC}`] };
  const pending = { ...structuredClone(base), key: 'source:peer', targetId: null, monitorStatus: 'pending', accountIds: ['PeerNewId'],
    name: '上传名', originalNames: ['上传别名'], sourceTitles: ['用户作品登记表'], sources: [{ fileName: '作品登记表.xlsx', sheetName: '表1', rows: ['314'] }],
    evidenceLinks: ['https://v.douyin.com/ExamplePeer/'], classifications: [{ key: 'slice', label: '切片' }], boards: [{ name: '一条小团团切片矩阵' }] };
  // Exercise the pure merge with independent validated identity fixtures.
  // Production uses durable alias events; those are integration-tested separately.
  return { db, target, pending, read: items => mergeRosterIdentityLinks(items,
    readStoredDouyinProfileIdentityMatches(db, items.filter(i => !i.targetId).flatMap(i => i.accountIds), { reference: NOW })) };
}

test('peer: merges exact current handle without mutating DB or supplied original entries', t => {
  const f = fixture(t), inputs = [f.target, f.pending], before = JSON.stringify(inputs), changes = f.db.prepare('SELECT total_changes() n').get().n;
  const result = f.read(inputs);
  assert.equal(result.linkedEntryCount, 1); assert.equal(result.items.length, 1);
  assert.equal(result.items[0].targetId, 1); assert.equal(result.items[0].monitorStatus, 'enabled');
  assert.deepEqual(result.items[0].accountIds, ['old-id', 'PeerNewId']);
  assert.equal(result.items[0].linkedSourceEntries[0].key, 'source:peer');
  assert.deepEqual(result.items[0].linkedSourceEntries[0].boards, f.pending.boards);
  assert.deepEqual(result.items[0].linkedSourceEntries[0].classifications, f.pending.classifications);
  assert.equal(result.items[0].sources[0].rows[0], '314');
  assert.equal(result.items[0].linkedSourceEntries[0].proofs[0].submittedWorksVerified, false);
  assert.equal(JSON.stringify(inputs), before); assert.equal(f.db.prepare('SELECT total_changes() n').get().n, changes);
});

test('peer: paused target stays paused after linking, with no enable side effect', t => {
  const f = fixture(t, 0), result = f.read([f.target, f.pending]);
  assert.equal(result.linkedEntryCount, 1); assert.equal(result.items[0].monitorStatus, 'paused');
  assert.equal(f.db.prepare('SELECT enabled FROM targets WHERE id=1').get().enabled, 0);
});

test('peer: wrong canonical link, explicit conflict, ambiguous target projection and unproved extra ID do not merge', t => {
  const f = fixture(t);
  for (const pending of [
    { ...f.pending, profileLinks: [`https://www.douyin.com/user/${OTHER}`] },
    { ...f.pending, reviewReasons: ['作者身份冲突'] },
    { ...f.pending, supplement: { status: 'conflict' } },
    { ...f.pending, accountIds: ['PeerNewId', 'unproved-other'] },
  ]) assert.equal(f.read([f.target, pending]).linkedEntryCount, 0);
  assert.equal(f.read([f.target, { ...f.target, key: 'duplicate-target' }, f.pending]).linkedEntryCount, 0);
});

test('peer: two source entries become one monitored target while all source keys remain discoverable', t => {
  const f = fixture(t), second = structuredClone(f.pending); second.key = 'source:peer2'; second.sources[0].rows = ['400'];
  const result = f.read([f.target, f.pending, second]);
  assert.equal(result.linkedEntryCount, 2); assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0].linkedSourceEntries.map(x => x.key), ['source:peer', 'source:peer2']);
  assert.deepEqual(result.items[0].sources[0].rows, ['314', '400']);
});

test('peer: resulting projection passes frontend validation with exact count and preserved nested proof', t => {
  const f = fixture(t), linked = f.read([f.target, f.pending]);
  const result = validateMasterRoster({ items: linked.items, summary: { total: 1, registered: 1, enabled: 1, paused: 0, pending: 0 },
    snapshotAt: AT, workbook: { fileName: 'fixture.xlsx', sha256: 'a'.repeat(64) },
    liveSources: { sourceJobCount: 1, sourceRowCount: 2, addedEntryCount: 0, aliasedEntryCount: 1, profileLinkedEntryCount: 1, latestSourceAt: AT } });
  assert.equal(result.items[0].linkedSourceEntries[0].proofs[0].snapshotId, 10);
  assert.equal(result.summary.pending, 0);
});

test('peer: an explicitly invalidated original anchor is not silently rebound using a later handle match', t => {
  const f = fixture(t), invalidated = { ...f.pending, key: 'target:99', identityStatus: '既有定位锚点已变，需重新核对', reviewReasons: ['未使用旧表条目键绑定当前账号。'] };
  assert.equal(f.read([f.target, invalidated]).linkedEntryCount, 0);
});

test('peer: merging known identity retains source-confirmed same-theme classifications for visible filters', t => {
  const f = fixture(t);
  f.target.classifications = [{ key: 'slice', label: '切片' }];
  f.pending.classifications = [{ key: 'slice', label: '切片' }, { key: 'ai-remix', label: 'AI二创' }];
  const result = f.read([f.target, f.pending]);
  assert.equal(result.linkedEntryCount, 1);
  assert.ok(result.items[0].classifications.some(x => x.key === 'ai-remix'), 'the merged account must remain visible in its explicit AI-remix source classification');
  assert.equal(result.items[0].classifications.filter(x => x.key === 'slice').length, 1);
});

test('peer: shared board name cannot discard distinct source classifications or silently replace a theme', t => {
  const f = fixture(t);
  f.target.boards = [{ name: '团团', category: '切片' }, { name: '团团', category: '原创' }];
  f.pending.boards = [{ name: '团团', category: 'AI二创' }];
  assert.equal(f.read([f.target, f.pending]).items[0].boards.length, 3);
  f.pending.theme = { key: 'another', label: '另一主题' };
  assert.equal(f.read([f.target, f.pending]).linkedEntryCount, 0);
});
