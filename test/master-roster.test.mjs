import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildMasterRosterSnapshot, installMasterRoster, readMasterRoster, rosterLink } from '../lib/master-roster.mjs';

const hash = 'a'.repeat(64);
const fixture = () => ({ exportedAt: '2026-10-02T19:01:23.853Z', entities: [
  { key: 'target:1', targetId: 1, enabled: true, platform: 'douyin', currentName: '旧昵称', names: ['旧昵称'], ids: ['012345678901234567890'], locators: ['MS4wLjABAAAAabcdefghijklmnop'], sources: [{ url: 'https://example.com/roster', file: '/private/path/source.xlsx', title: '来源', rows: ['2'] }], classification: { theme: { key: 'tuantuan', label: '团团' }, labels: [{ key: 'slice', label: '切片' }] }, metadata: { token: 'not-exported' } },
  { key: 'submitted:douyin:id:012345678901234567891', targetId: '', enabled: null, platform: 'douyin', names: ['=待核对'], ids: ['012345678901234567891'], locators: [], errors: ['作品作者不符'], sources: [{ url: 'javascript:alert(1)', file: 'original.xlsx' }] },
] });
function database(t) {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE targets(id INTEGER PRIMARY KEY, type TEXT, metadata_json TEXT, locator TEXT, label TEXT, enabled INTEGER); CREATE TABLE snapshots(id INTEGER, target_id INTEGER, followers INTEGER); INSERT INTO targets VALUES(1,'account','{\"platform\":\"douyin\"}','MS4wLjABAAAAabcdefghijklmnop','最新名字',0); INSERT INTO snapshots VALUES(1,1,100);");
  t.after(() => db.close()); return db;
}
test('master roster is additive, idempotent, text-preserving and uses live names/pause state without touching metrics', t => {
  const db = database(t), snapshot = buildMasterRosterSnapshot(fixture(), { fileName: '/private/master.xlsx', sha256: hash });
  const originalTargets = db.prepare('SELECT * FROM targets').all();
  assert.equal(readMasterRoster(db), null);
  const first = installMasterRoster(db, snapshot, { now: '2026-10-03T11:00:00Z' });
  const before = db.prepare('SELECT total_changes() n').get().n;
  assert.equal(installMasterRoster(db, snapshot).imported, false);
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
  assert.equal(first.count, 2);
  const read = readMasterRoster(db);
  assert.deepEqual(read.summary, { total: 2, registered: 1, enabled: 0, paused: 1, pending: 1 });
  assert.equal(read.items[0].name, '最新名字');
  assert.equal(read.items[0].accountIds[0], '012345678901234567890');
  assert.equal(read.items[0].sources[0].fileName, 'source.xlsx');
  assert.equal(read.items[1].targetId, null);
  assert.equal(read.items[1].name, '=待核对');
  assert.equal(read.items[1].monitorStatus, 'pending');
  assert.deepEqual(read.items[1].sourceLinks, []);
  assert.ok(!JSON.stringify(read).includes('not-exported'));
  assert.ok(!JSON.stringify(read).includes('/private/'));
  assert.deepEqual(db.prepare('SELECT * FROM targets').all(), originalTargets);
  assert.equal(db.prepare('SELECT * FROM snapshots').get().followers, 100);
  assert.ok(!Object.hasOwn(read.items[1], 'metrics'));
});
test('same workbook cannot silently rewrite its preserved snapshot', t => {
  const db = database(t), snapshot = buildMasterRosterSnapshot(fixture(), { fileName: 'master.xlsx', sha256: hash });
  installMasterRoster(db, snapshot);
  const modified = structuredClone(snapshot); modified.items[0].name = 'overwritten';
  assert.throws(() => installMasterRoster(db, modified), /拒绝覆盖/);
  assert.equal(readMasterRoster(db).items[0].originalNames[0], '旧昵称');
});
test('all registered anchors checked in write transaction; mismatch rolls back even schema creation', t => {
  const db = database(t), snapshot = buildMasterRosterSnapshot(fixture(), { fileName: 'master.xlsx', sha256: hash });
  snapshot.items[0].platform = 'bilibili';
  assert.throws(() => installMasterRoster(db, snapshot), /定位锚点/);
  assert.equal(readMasterRoster(db), null);
  assert.equal(db.prepare('SELECT count(*) n FROM targets').get().n, 1);
});
test('deleted or changed target locator cannot bind stale roster target IDs', t => {
  const db = database(t), snapshot = buildMasterRosterSnapshot(fixture(), { fileName: 'master.xlsx', sha256: hash });
  installMasterRoster(db, snapshot);
  db.prepare('UPDATE targets SET locator=? WHERE id=1').run('MS4wLjABAAAAdifferentidentity');
  const read = readMasterRoster(db);
  assert.equal(read.items[0].targetId, null);
  assert.equal(read.items[0].monitorStatus, 'pending');
  assert.equal(read.summary.registered, 0);
  assert.equal(read.summary.pending, 2);
});
test('duplicate keys, bad anchors, invalid platform, dates and hashes are rejected before persistence', () => {
  for (const change of [x => x.entities.push(x.entities[0]), x => x.entities[0].key = 'target:2', x => x.entities[0].locators = [], x => x.entities[0].platform = 'unknown', x => x.exportedAt = 'never']) {
    const data = fixture(); change(data);
    assert.throws(() => buildMasterRosterSnapshot(data, { fileName: 'master.xlsx', sha256: hash }));
  }
  assert.throws(() => buildMasterRosterSnapshot(fixture(), { sha256: 'bad' }));
});
test('links reject active scripts and credential-bearing URLs', () => {
  assert.equal(rosterLink('data:text/html,secret'), '');
  assert.equal(rosterLink('https://user:secret@example.com'), '');
  assert.equal(rosterLink('https://example.com?access_token=[REDACTED]'), '');
  assert.equal(rosterLink('https://example.com/table?a=1'), 'https://example.com/table?a=1');
});
test('review diagnostics do not publish nested evidence, credentials or machine paths', () => {
  const data = fixture();
  data.entities[1].errors = ['failed /Users/private/auth.json access_token=credentialValue cookie=privateCookie Bearer secretBearer'];
  data.entities[1].conflicts = [{ field: 'category', incomingSource: { token: 'nestedPrivate' } }];
  const serialized = JSON.stringify(buildMasterRosterSnapshot(data, { fileName: 'master.xlsx', sha256: hash }));
  for (const secret of ['credentialValue', 'privateCookie', 'secretBearer', 'nestedPrivate', '/Users/private']) assert.ok(!serialized.includes(secret), secret);
});
test('installer rejects promoted pending identities and unapproved metric fields', t => {
  const db = database(t), snapshot = buildMasterRosterSnapshot(fixture(), { fileName: 'master.xlsx', sha256: hash });
  const promoted = structuredClone(snapshot); promoted.items[1].monitorStatus = 'enabled';
  assert.throws(() => installMasterRoster(db, promoted), /格式无效/);
  const counters = structuredClone(snapshot); counters.items[1].metrics = { followers: 999 };
  assert.throws(() => installMasterRoster(db, counters), /未批准字段/);
  assert.equal(readMasterRoster(db), null);
});
test('row tampering with unchanged count fails both reads and idempotent imports', t => {
  const db = database(t), snapshot = buildMasterRosterSnapshot(fixture(), { fileName: 'master.xlsx', sha256: hash });
  installMasterRoster(db, snapshot);
  const changed = structuredClone(snapshot.items[1]); changed.name = 'tampered';
  db.prepare('UPDATE master_roster_entries SET payload_json=? WHERE entry_key=?').run(JSON.stringify(changed), changed.key);
  assert.throws(() => readMasterRoster(db), /校验值不一致/);
  assert.throws(() => installMasterRoster(db, snapshot), /校验值不一致/);
});
test('public roster keys and links contain no internal path, loopback or credential fragments', () => {
  const data = fixture(); data.entities[1].key = 'submitted:name:/Users/private/list.xlsx:reader';
  const snapshot = buildMasterRosterSnapshot(data, { fileName: 'master.xlsx', sha256: hash });
  assert.ok(!snapshot.items[1].key.includes('/Users/'));
  assert.equal(rosterLink('http://127.0.0.1:4188/'), '');
  assert.equal(rosterLink('https://example.com/#access_token=secret'), 'https://example.com/');
});
