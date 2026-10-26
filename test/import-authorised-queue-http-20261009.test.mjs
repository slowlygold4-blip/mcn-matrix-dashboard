import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, ms = 7000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = check(); if (value) return value; await pause(10); }
  assert.fail(message());
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function request(f, path, body) {
  const response = await fetch(f.origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: f.origin, Cookie: f.session.cookie, 'X-CSRF-Token': f.session.csrf,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() };
}

/** Real HTTP/job/timer/lease/transaction path; the provider transport is offline. */
async function fixture(t, mode = 'ok') {
  const dir = await mkdtemp(join(tmpdir(), 'mcn-authorised-queue-http-'));
  const dataDir = join(dir, 'data'), preload = join(dir, 'offline-provider.mjs');
  await writeFile(preload, `
import { createHash } from 'node:crypto';
import { PublicWebProvider } from ${JSON.stringify(new URL('../lib/providers/public-web.mjs', import.meta.url).href)};
const emit = (kind, fields = {}) => { if (process.connected) process.send({ queuePeer: true, kind, ...fields }); };
globalThis.fetch = async () => { emit('unexpected-network'); throw new Error('Offline test prohibits network'); };
PublicWebProvider.prototype.resolveAuthors = async function() {
  emit('legacy-resolver'); throw new Error('Offline test prohibits legacy resolver');
};
for (const method of ['run','runBrowserWorks','runTopicBrowser','collect','collectAccount','collectWorksOnly',
  'collectHashtag','collectBilibiliAccount','collectXiaohongshuAccount','testConnection','testConnectionForPlatform']) {
  PublicWebProvider.prototype[method] = async function() {
    emit('unexpected-collection', { method }); throw new Error('Offline test prohibits collection');
  };
}
let callId = 0;
PublicWebProvider.prototype.resolveAuthorisedDetail = async function(payload) {
  const [input] = payload.items;
  if (payload.items.length !== 1) throw new Error('Expected one owned detail');
  const id = ++callId, requestStartedAt = new Date().toISOString();
  // The parent holds the response, so it can independently observe committed
  // original input and the existing queue lease before any success is admitted.
  await new Promise((resolve, reject) => {
    const cleanup = () => { process.off('message', complete); this.signal?.removeEventListener('abort', cancel); };
    const complete = value => {
      if (value?.queuePeer !== true || value.kind !== 'complete' || value.id !== id) return;
      cleanup(); resolve();
    };
    const cancel = () => { cleanup(); reject(Object.assign(new Error('Offline cancelled'), { code: 'ABORT_ERR' })); };
    process.on('message', complete); this.signal?.addEventListener('abort', cancel, { once: true });
    emit('authorised-started', { id, key: input.key, videoId: input.videoId, submittedId: input.submittedId });
    if (this.signal?.aborted) cancel();
  });
  if (${JSON.stringify(mode)} === 'busy') throw Object.assign(new Error('PRIVATE_PEER_SECRET'), { code: 'BROWSER_LANE_BUSY' });
  const observedAt = new Date().toISOString();
  if (${JSON.stringify(mode)} === 'gate') return { status: 'unavailable', key: input.key,
    submittedId: input.submittedId, videoId: input.videoId, requestStartedAt,
    requestFinishedAt: observedAt, errorCode: 'blocked', rawError: 'PRIVATE_PEER_SECRET' };
  const secUid = 'MS4wLjABAAAAQueueHttpFixtureAuthor0001', uid = '1234567890123456';
  const response = { status_code: 0, aweme_detail: { aweme_id: input.videoId,
    author: { sec_uid: secUid, uid, unique_id: input.submittedId } } };
  const responseSha256 = createHash('sha256').update(JSON.stringify(response)).digest('hex');
  const responseSha256Scope = 'public-identity-projection-v1';
  return { status: 'ok', key: input.key, videoId: input.videoId, submittedId: input.submittedId,
    requestStartedAt, requestFinishedAt: observedAt,
    candidate: { videoId: input.videoId, secUid, uid, uniqueId: input.submittedId, shortId: '',
      provenance: 'authorised-browser-natural-detail', observedAt, responseSha256, responseSha256Scope },
    evidence: { version: 1, kind: 'natural-main-frame-detail-response', origin: 'https://www.douyin.com',
      path: '/aweme/v1/web/aweme/detail/', method: 'GET', httpStatus: 200,
      requestedVideoId: input.videoId, observedAt, responseSha256, responseSha256Scope, response },
    provenance: { mode: 'authorised-browser-natural-detail', authorisedSessionUsed: true, authenticated: null,
      authenticationStatus: 'not-verified', noChallengeBypass: true, runtimeAI: false, paidAPI: false },
    rawError: 'PRIVATE_PEER_SECRET', cookies: 'PRIVATE_PEER_SECRET' };
};
`);
  const port = await freePort(), events = []; let logs = '', db;
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'test',
      DOUYIN_AUTHOR_RESOLVER_MODE: 'signed-only', NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      DOUYIN_CHROME_PATH: join(dir, 'disabled-browser'), PYTHON_BIN: join(dir, 'disabled-python') },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.on('message', value => { if (value?.queuePeer) events.push(value); });
  child.stdout.on('data', value => { logs += value; }); child.stderr.on('data', value => { logs += value; });
  t.after(async () => {
    db?.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const deadline = Date.now() + 6000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await pause(20);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });
  const f = { origin: `http://127.0.0.1:${port}`, events, logs: () => logs, child };
  let ready = false;
  for (let n = 0; n < 200; n++) {
    try { if ((await fetch(f.origin + '/api/health')).ok) { ready = true; break; } } catch {}
    if (child.exitCode !== null) break;
    await pause(20);
  }
  assert.ok(ready, `Isolated server failed to start: ${logs}`);
  const auth = await fetch(f.origin + '/api/auth/session'), authData = await auth.json();
  f.session = { cookie: auth.headers.get('set-cookie').split(';')[0], csrf: authData.csrfToken };
  db = new DatabaseSync(join(dataDir, 'douyin-monitor.sqlite')); f.db = db;
  f.rows = table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  f.complete = event => child.send({ queuePeer: true, kind: 'complete', id: event.id });
  f.waitStarted = () => until(() => events.find(e => e.kind === 'authorised-started'),
    () => `Authorised worker did not start: ${logs}`);
  return f;
}

function input(rows = 1) {
  return { fileName: 'offline-queue-source.xlsx', sheetName: '原始名单',
    rows: Array.from({ length: rows }, (_, index) => ({ sourceRow: index + 2,
      name: `离线作者${index + 1}`, platform: 'douyin', douyinId: `queue_http_${index + 1}`,
      videoId: `768642494805589178${6 + index}`, status: 'resolvable' })) };
}
async function submit(f, count = 1) {
  const body = input(count), response = await request(f, '/api/author-spreadsheet/auto-monitor', body);
  assert.equal(response.status, 202, JSON.stringify(response.data));
  assert.ok(response.data.id);
  return { body, id: response.data.id };
}
function assertNoFallback(f) {
  assert.equal(f.events.filter(e => e.kind === 'legacy-resolver').length, 0);
  assert.equal(f.events.filter(e => e.kind === 'unexpected-network').length, 0);
  assert.equal(f.events.filter(e => e.kind === 'unexpected-collection').length, 0);
  assert.doesNotMatch(f.logs(), /PRIVATE_PEER_SECRET/);
}

test('HTTP queued import: complete and preserve original job before one natural detail; commit through its existing lease and receipt',
  { timeout: 15000 }, async t => {
    const f = await fixture(t), job = await submit(f), event = await f.waitStarted();
    const publicJob = await request(f, `/api/author-spreadsheet/jobs/${job.id}`);
    assert.equal(publicJob.status, 200); assert.equal(publicJob.data.status, 'completed');
    const original = f.rows('author_resolution_jobs')[0];
    const originalRequest = JSON.parse(original.request_json);
    assert.equal(originalRequest.rows.length, job.body.rows.length);
    for (const [key, value] of Object.entries(job.body.rows[0])) assert.deepEqual(originalRequest.rows[0][key], value);
    assert.ok(Date.parse(original.finished_at) >= Date.parse(original.created_at));
    const queueBefore = f.rows('author_resolution_queue');
    assert.equal(queueBefore.length, 1); assert.equal(queueBefore[0].identity_key, event.key);
    assert.equal(queueBefore[0].status, 'pending'); assert.equal(queueBefore[0].attempts, 0);
    assert.ok(queueBefore[0].lease_owner); assert.ok(Date.parse(queueBefore[0].lease_until) > Date.now());
    assert.equal(queueBefore[0].verification_policy_version, 2);
    const sourcesBefore = f.rows('author_resolution_import_sources');
    assert.equal(sourcesBefore.length, 1);
    assert.equal(f.rows('targets').length, 0); assert.equal(f.rows('author_resolution_success_receipts').length, 0);
    f.complete(event);
    await until(() => f.rows('author_resolution_queue')[0]?.status === 'resolved',
      () => `Queue not resolved: ${JSON.stringify(f.rows('author_resolution_queue'))}; ${f.logs()}`);
    const queue = f.rows('author_resolution_queue')[0], proofs = f.rows('author_resolution_success_receipts');
    assert.equal(queue.attempts, 0); assert.equal(queue.lease_owner, null); assert.equal(queue.lease_until, null);
    assert.equal(proofs.length, 1); assert.equal(proofs[0].target_id, queue.resolved_target_id);
    assert.equal(f.rows('targets').length, 1); assert.equal(f.rows('targets')[0].enabled, 1);
    assert.equal(f.rows('snapshots').length, 0, 'identity proof is not a collected profile or works snapshot');
    assert.equal(f.rows('activity_log').filter(row => row.action === 'author-resolution.claimed').length, 1,
      'admission must reuse, not re-claim, the worker lease');
    assert.deepEqual(f.rows('author_resolution_import_sources'), sourcesBefore);
    assert.equal(f.rows('author_resolution_jobs')[0].request_json, original.request_json);
    assert.equal(f.events.filter(e => e.kind === 'authorised-started').length, 1);
    assert.doesNotMatch(JSON.stringify(proofs), /PRIVATE_PEER_SECRET/);
    assertNoFallback(f);
  });

for (const mode of ['gate', 'busy']) {
  test(`HTTP queued import: ${mode} safely delays both claimed authors without spending attempts or anonymous fallback`,
    { timeout: 15000 }, async t => {
      const f = await fixture(t, mode), job = await submit(f, 2), event = await f.waitStarted();
      assert.equal((await request(f, `/api/author-spreadsheet/jobs/${job.id}`)).data.status, 'completed');
      const sources = f.rows('author_resolution_import_sources');
      assert.equal(f.rows('author_resolution_queue').length, 2);
      assert.equal(f.rows('author_resolution_queue').filter(row => row.lease_owner).length, 2);
      f.complete(event);
      await until(() => f.rows('author_resolution_queue').every(row => row.lease_owner === null),
        () => `Queue leases not released after ${mode}: ${f.logs()}`);
      for (const row of f.rows('author_resolution_queue')) {
        assert.equal(row.attempts, 0); assert.equal(row.status, 'pending');
        assert.equal(row.resolved_target_id, null); assert.equal(row.lease_until, null);
        assert.ok(Date.parse(row.next_attempt_at) > Date.now() + 20 * 60_000);
        assert.doesNotMatch(row.last_error, /PRIVATE_PEER_SECRET/);
      }
      assert.equal(f.events.filter(e => e.kind === 'authorised-started').length, 1,
        'a gate or local busy result stops the remainder of this claimed batch');
      assert.equal(f.rows('targets').length, 0); assert.equal(f.rows('author_resolution_success_receipts').length, 0);
      assert.equal(f.rows('snapshots').length, 0);
      assert.deepEqual(f.rows('author_resolution_import_sources'), sources);
      const attempts = f.rows('activity_log').filter(row => row.action === 'author-resolution.authorised-attempt');
      assert.equal(attempts.length, mode === 'gate' ? 1 : 0,
        'validated gate results have an audit; local busy does not pretend a platform response');
      assert.doesNotMatch(JSON.stringify(attempts), /PRIVATE_PEER_SECRET/);
      assertNoFallback(f);
    });
}
