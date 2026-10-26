import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitorDatabase } from '../lib/database.mjs';
import { checksum } from '../lib/utils.mjs';

test('full-history HTTP uses its read-only worker, preserves all saved days, handles viewer access and rejects bad queries', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mcn-history-http-'));
  process.env.DATA_DIR = dir;
  const db = new MonitorDatabase(join(dir, 'douyin-monitor.sqlite'));
  const target = db.createTarget({ type: 'account', label: '历史隔离验收', provider: 'manual', enabled: false,
    locator: 'MS4wLjABAAAAROOTFULLHISTORYabcdefghijklmn', metadata: { platform: 'douyin' } });
  const snapshot = db.db.prepare("INSERT INTO snapshots(target_id,captured_at,followers,total_likes,total_posts,quality_status,account_status,works_coverage,source_checksum,raw_json) VALUES(?,?,?,?,?,'validated','available','limited',?,?)");
  for (let i = 0; i < 40; i++) {
    const at = new Date(Date.parse('2025-01-01T08:00:00Z') + i * 86400000).toISOString();
    const raw = { capturedAt: at, snapshot: { followers: 1000 - i, totalLikes: 3000 + i * 10, totalPosts: 20 + i }, posts: [] };
    snapshot.run(target.id, at, raw.snapshot.followers, raw.snapshot.totalLikes, raw.snapshot.totalPosts, checksum(raw), JSON.stringify(raw));
  }
  const { server } = await import('../server.mjs');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); await rm(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const auth = await fetch(`${origin}/api/auth/session`), owner = await auth.json();
  const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const path = `/api/rebuild/accounts/${target.id}/history`;
  const get = (query = '', token = cookie, route = path) => fetch(`${origin}${route}${query ? `?${query}` : ''}`, { headers: { Cookie: token } });
  const firstResponse = await get('kind=daily&pageSize=20&order=asc');
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.equal(first.version, 1); assert.equal(first.targetId, target.id);
  assert.equal(first.kind, 'daily'); assert.equal(first.pagination.total, 40);
  assert.equal(first.items.length, 20); assert.equal(first.items[0].date, '2025-01-01');
  assert.equal(first.items[1].followersDelta, -1);
  const query = new URLSearchParams({ kind: 'daily', pageSize: '20', order: 'asc', page: '2', asOf: first.asOf,
    ...Object.fromEntries(Object.entries(first.revision).map(([key, value]) => [key, String(value)])) });
  const second = await (await get(query.toString())).json();
  assert.equal(second.items.length, 20); assert.equal(second.items[0].date, '2025-01-21');
  assert.equal(second.items[0].followersDelta, -1, 'page boundary uses the preceding real calendar day');
  assert.equal(new Set([...first.items, ...second.items].map(item => item.date)).size, 40);
  assert.equal(second.pagination.total, 40);
  const missing = await get('', cookie, '/api/rebuild/accounts/9999999/history');
  assert.equal(missing.status, 404);
  for (const query of ['kind=bad', 'kind=daily&kind=works', 'kind=daily&page=0', 'pageSize=101',
    'asOf=2099-01-01T00:00:00Z', 'kind=workMetrics', 'snapshotMaxId=1', 'cookie=PRIVATE']) {
    const response = await get(query);
    assert.equal(response.status, 400, query);
    assert.equal((await response.json()).code, 'INVALID_ACCOUNT_HISTORY_QUERY');
  }
  const inviteResponse = await fetch(`${origin}/api/access/invites`, { method: 'POST', headers: {
    Cookie: cookie, Origin: origin, 'X-CSRF-Token': owner.csrfToken, 'Content-Type': 'application/json' },
  body: JSON.stringify({ role: 'viewer', hours: 1, maxUses: 1, label: '历史只读隔离验收' }) });
  assert.equal(inviteResponse.status, 201);
  const invite = await inviteResponse.json();
  const joined = await fetch(`${origin}/api/auth/join`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: invite.code, displayName: '历史查看者' }) });
  assert.equal(joined.status, 200);
  const viewer = await joined.json(), viewerCookie = joined.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.equal((await get('kind=daily', viewerCookie)).status, 200);
  const anonymous = await fetch(`${origin}${path}?kind=daily`, { headers: { 'X-Forwarded-For': '198.51.100.2' } });
  assert.equal(anonymous.status, 401, 'a read-only history route must not disable remote authentication');
  const denied = await fetch(`${origin}/api/boards`, { method: 'POST', headers: { Cookie: viewerCookie,
    Origin: origin, 'X-CSRF-Token': viewer.csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '不得写入' }) });
  assert.equal(denied.status, 403);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM snapshots').get().n, 40, 'history reads cannot collect or backfill');
});
