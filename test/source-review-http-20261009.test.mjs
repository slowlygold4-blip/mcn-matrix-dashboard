import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MonitorDatabase } from '../lib/database.mjs';

test('source review HTTP retains ownership, historical provenance, filtering and finite paging', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mcn-source-review-'));
  process.env.DATA_DIR = dir;
  const db = new MonitorDatabase(join(dir, 'douyin-monitor.sqlite'));
  const { server } = await import('../server.mjs');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); await rm(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(origin + '/api/auth/session'); const auth = await response.json();
  const owner = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  async function call(path, { cookie = owner, method = 'GET', body, csrf = auth.csrfToken } = {}) {
    const response = await fetch(origin + path, { method, headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { response, body: await response.json().catch(() => null) };
  }
  const id = randomUUID(), skipped = Array.from({ length: 63 }, (_, i) => ({ sourceRow: i + 2, sourceRecordId: `recRecord${i}`,
    name: `作者${i}`, douyinId: `author${i}`, platform: 'douyin', status: i % 2 ? 'needs_locator' : 'unresolved', reason: i % 2 ? '缺少主页' : 'HTTP403' }));
  db.createAuthorResolutionJob({ id, userId: auth.user.id, actorName: 'fixture', fileName: '来源.csv', sheetName: 'CSV', request: { rows: [] } });
  db.db.prepare("UPDATE author_resolution_jobs SET status='completed',result_json=?,finished_at=? WHERE id=?").run(JSON.stringify({ skipped }), new Date().toISOString(), id);
  const original = db.db.prepare('SELECT * FROM author_resolution_jobs WHERE id=?').get(id);
  const first = await call(`/api/author-spreadsheet/jobs/${id}/skipped?limit=20&offset=20`);
  assert.equal(first.response.status, 200); assert.equal(first.body.items[0].name, '作者20'); assert.equal(first.body.originalTotal, 63);
  const search = await call(`/api/author-spreadsheet/jobs/${id}/skipped?q=author62&status=unresolved&limit=20`);
  assert.equal(search.body.total, 1); assert.equal(search.body.items[0].sourceRecordId, 'recRecord62');
  const infinite = await call(`/api/author-spreadsheet/jobs/${id}/skipped?offset=Infinity&limit=NaN`);
  assert.equal(infinite.body.offset, 0); assert.equal(infinite.body.limit, 20);
  assert.equal((await call(`/api/author-spreadsheet/jobs/${randomUUID()}/skipped`)).response.status, 404);
  async function joinAs(role) {
    const invite = await call('/api/access/invites', { method: 'POST', body: { role, hours: 1, maxUses: 1, label: 'fixture' } });
    assert.equal(invite.response.status, 201);
    const login = await call('/api/auth/join', { method: 'POST', cookie: '', body: { code: invite.body.code, displayName: `测试${role}` } });
    assert.equal(login.response.status, 200, JSON.stringify(login.body));
    return login.response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  }
  const editor = await joinAs('editor'), viewer = await joinAs('viewer');
  assert.equal((await call(`/api/author-spreadsheet/jobs/${id}/skipped`, { cookie: editor })).response.status, 403);
  assert.equal((await call(`/api/author-spreadsheet/jobs/${id}/skipped`, { cookie: viewer })).response.status, 403);
  assert.deepEqual(db.db.prepare('SELECT * FROM author_resolution_jobs WHERE id=?').get(id), original);
  assert.equal(db.db.prepare('SELECT count(*) n FROM targets').get().n, 0);
  assert.equal(db.db.prepare('SELECT count(*) n FROM snapshots').get().n, 0);
});
