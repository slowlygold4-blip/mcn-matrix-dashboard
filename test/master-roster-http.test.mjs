import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitorDatabase } from '../lib/database.mjs';
import { buildMasterRosterSnapshot, installMasterRoster } from '../lib/master-roster.mjs';

test('authenticated roster GET returns full roster without promoting candidates or changing operating statistics', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mcn-master-roster-http-')); process.env.DATA_DIR = dir;
  const db = new MonitorDatabase(join(dir, 'douyin-monitor.sqlite'));
  const account = db.createTarget({ type: 'account', label: '当前昵称', locator: 'MS4wLjABAAAAabcdefghijklmnop', provider: 'public-web', metadata: { platform: 'douyin' } });
  db.db.prepare('UPDATE targets SET enabled=0 WHERE id=?').run(account.id);
  const { server } = await import('../server.mjs');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); await rm(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const session = await fetch(`${origin}/api/auth/session`);
  const cookie = session.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const get = path => fetch(`${origin}${path}`, { headers: { Cookie: cookie } });
  assert.equal((await get('/api/master-roster')).status, 404);
  installMasterRoster(db.db, buildMasterRosterSnapshot({ exportedAt: '2026-10-02T19:01:23Z', entities: [
    { key: `target:${account.id}`, targetId: account.id, enabled: true, currentName: '原表昵称', platform: 'douyin', names: ['原表昵称'], ids: ['000123'], locators: [account.locator], sources: [], classification: { theme: { key: 'tuantuan', label: '团团' } } },
    { key: 'submitted:douyin:id:000124', platform: 'douyin', names: ['待核对'], ids: ['000124'], locators: [], sources: [], errors: ['作品作者不一致'] },
  ] }, { fileName: 'master.xlsx', sha256: 'a'.repeat(64) }));
  const before = await (await get('/api/rebuild/insights?period=week')).json();
  const response = await get('/api/master-roster'); assert.equal(response.status, 200);
  const roster = await response.json();
  assert.deepEqual(roster.summary, { total: 2, registered: 1, enabled: 0, paused: 1, pending: 1 });
  assert.equal(roster.items[0].name, '当前昵称'); assert.equal(roster.items[0].monitorStatus, 'paused');
  assert.equal(roster.items[1].targetId, null); assert.ok(!Object.hasOwn(roster.items[1], 'metrics'));
  const after = await (await get('/api/rebuild/insights?period=week')).json();
  assert.deepEqual(before.summary, after.summary);
  // The current product intentionally includes preserved source-only authors
  // beside monitored accounts. Their presence must not promote them to targets
  // or change operating totals; counting only the monitor would hide the row.
  assert.equal(after.accounts.filter(row => !row.sourceOnly).length, 1);
  assert.equal(after.accounts.find(row => !row.sourceOnly).id, account.id);
  assert.equal(after.accounts.filter(row => row.sourceOnly).length, 1);
  assert.equal(db.db.prepare('SELECT count(*) n FROM snapshots').get().n, 0);
  const anonymous = await fetch(`${origin}/api/master-roster`, { headers: { 'X-Forwarded-For': '203.0.113.5' } });
  assert.equal(anonymous.status, 401);
});
