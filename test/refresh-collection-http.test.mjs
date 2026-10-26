import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitorDatabase } from '../lib/database.mjs';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';

test('refresh HTTP admits editors with CSRF, returns asynchronously and preserves exact read-only receipts', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'refresh-http-'));
  const previousData = process.env.DATA_DIR; process.env.DATA_DIR = directory;
  const database = new MonitorDatabase(join(directory, 'douyin-monitor.sqlite'));
  database.createTarget({ type: 'account', provider: 'public-web', label: 'offline refresh', locator: 'MS4wLjABrefreshHTTP' });
  let release; const gate = new Promise(resolve => { release = resolve; }); let calls = 0;
  t.mock.method(PublicWebProvider.prototype, 'collect', async () => {
    calls++; await gate;
    return { snapshot: { followers: 1, totalLikes: 2, totalPosts: 0 }, posts: [],
      raw: { source: 'isolated-refresh-http' }, qualityStatus: 'validated', warnings: [], accountStatus: 'available', worksCoverage: 'complete' };
  });
  const { server } = await import('../server.mjs');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    release(); await new Promise(resolve => server.close(resolve)); database.close();
    if (previousData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousData;
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const authResponse = await fetch(`${origin}/api/auth/session`), auth = await authResponse.json();
  const cookieOf = response => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const owner = { cookie: cookieOf(authResponse), csrf: auth.csrfToken };
  async function request(path, { user = owner, method = 'GET', body, csrf = user.csrf, requestOrigin = origin } = {}) {
    const response = await fetch(`${origin}${path}`, { method, headers: { Cookie: user.cookie, Origin: requestOrigin,
      'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { response, payload: await response.json() };
  }
  async function member(role) {
    const invite = await request('/api/access/invites', { method: 'POST', body: { role } });
    const joined = await request('/api/auth/join', { method: 'POST', body: { code: invite.payload.code, displayName: `refresh ${role}` } });
    assert.equal(joined.response.status, 200);
    return { cookie: cookieOf(joined.response), csrf: joined.payload.csrfToken };
  }
  const viewer = await member('viewer'), editor = await member('editor');
  assert.deepEqual((await request('/api/refresh-collection')).payload, { job: null });
  for (const options of [{ csrf: 'wrong' }, { user: viewer }, { requestOrigin: 'https://foreign.example' }]) {
    assert.equal((await request('/api/refresh-collection', { method: 'POST', body: {}, ...options })).response.status, 403);
  }
  assert.equal((await request('/api/refresh-collection', { user: viewer })).response.status, 403);
  for (const body of [null, [], 'bad', { board: 'current' }, { targetId: 1 }, { scope: 'all' }]) {
    assert.equal((await request('/api/refresh-collection', { method: 'POST', body })).response.status, 400);
  }
  assert.equal((await request('/api/sync', { method: 'POST', body: {} })).response.status, 400, 'old single-target contract remains strict');
  assert.equal(database.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 0);
  const started = await request('/api/refresh-collection', { method: 'POST', user: editor, body: {} });
  assert.equal(started.response.status, 202); assert.equal(started.payload.reused, false);
  assert.ok(['queued', 'running'].includes(started.payload.job.status));
  const jobId = started.payload.job.id;
  const replay = await request('/api/refresh-collection', { method: 'POST', body: {} });
  assert.equal(replay.response.status, 202); assert.equal(replay.payload.reused, true); assert.equal(replay.payload.job.id, jobId);
  const running = await request(`/api/refresh-collection?jobId=${jobId}`, { user: editor });
  assert.equal(running.payload.job.status, 'running'); assert.equal(running.payload.job.progress.targetCount, 1);
  assert.equal(calls, 1); release();
  let completed;
  for (let attempt = 0; attempt < 160; attempt++) {
    completed = (await request(`/api/refresh-collection?jobId=${jobId}`)).payload.job;
    if (!['queued', 'running'].includes(completed.status)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(completed.status, 'completed'); assert.equal(completed.result.successCount, 1);
  assert.equal(completed.result.warningCount, 0); assert.equal(completed.result.worksCompleteCount, 1);
  assert.equal((await request('/api/refresh-collection?jobId=not-an-id')).response.status, 400);
  assert.equal((await request('/api/refresh-collection?jobId=00000000-0000-0000-0000-000000000000')).response.status, 404);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 1);
  assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action='refresh.collection.start'").get().n, 1);
});
