import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildAuthorEvidenceRequests } from '../lib/author-resolution.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = check(); if (value) return value; await pause(10); }
  assert.fail(message);
}
async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve)); return port;
}
async function json(instance, path, { body, signal, session = instance.session } = {}) {
  const response = await fetch(instance.origin + path, {
    method: body === undefined ? 'GET' : 'POST', signal,
    headers: { Origin: instance.origin, ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() };
}

async function fixture(t, { abortDelayMs = 0, successfulDetail = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'douyin-authorised-http-peer-'));
  const dataDir = join(dir, 'data'), preload = join(dir, 'offline-peer.mjs');
  await writeFile(preload, `
import { createHash } from 'node:crypto';
import { PublicWebProvider } from ${JSON.stringify(new URL('../lib/providers/public-web.mjs', import.meta.url).href)};
globalThis.fetch = async () => { throw new Error('External network prohibited in offline peer fixture'); };
process.on('message', async value => {
  if (value?.peer !== true || value.kind !== 'close-server') return;
  const { server } = await import(${JSON.stringify(new URL('../server.mjs', import.meta.url).href)});
  server.close(() => { if (process.connected) process.send({ peer: true, kind: 'server-close-complete' }, () => process.exit(0)); });
});
const real = PublicWebProvider.prototype.resolveAuthorisedDetail;
let callId = 0;
PublicWebProvider.prototype.resolveAuthorisedDetail = function(payload) {
  this.execFileImpl = (file, args, options, callback) => {
    if (!args[0].endsWith('/douyin_authorised_detail.mjs') || options.timeout !== 45000) throw new Error('Unexpected collector contract');
    let input, startedAt, settled = false, id;
    const emit = kind => { if (process.connected) process.send({ peer: true, kind, id }); };
    const cleanup = () => { options.signal?.removeEventListener('abort', abort); process.off('message', command); };
    const finish = error => {
      if (settled) return; settled = true; cleanup(); emit('collector-settled');
      let data = { status: 'unavailable', ...input, requestStartedAt: startedAt,
        requestFinishedAt: new Date().toISOString(), errorCode: 'blocked' };
      if (${successfulDetail}) {
        const observedAt = new Date().toISOString(), secUid = 'MS4wLjABAAAAPeerHttpAuthor000000001', uid = '1234567890123456';
        const response = { status_code: 0, aweme_detail: { aweme_id: input.videoId,
          author: { sec_uid: secUid, uid, unique_id: input.submittedId } } };
        const responseSha256 = createHash('sha256').update(JSON.stringify(response)).digest('hex');
        const responseSha256Scope = 'public-identity-projection-v1';
        data = { status: 'ok', ...input, requestStartedAt: startedAt, requestFinishedAt: observedAt,
          candidate: { videoId: input.videoId, secUid, uid, uniqueId: input.submittedId, shortId: '',
            provenance: 'authorised-browser-natural-detail', observedAt, responseSha256, responseSha256Scope },
          evidence: { version: 1, kind: 'natural-main-frame-detail-response', origin: 'https://www.douyin.com',
            path: '/aweme/v1/web/aweme/detail/', method: 'GET', httpStatus: 200, requestedVideoId: input.videoId,
            observedAt, responseSha256, responseSha256Scope, response },
          provenance: { mode: 'authorised-browser-natural-detail', authorisedSessionUsed: true, authenticated: null,
            authenticationStatus: 'not-verified', noChallengeBypass: true, runtimeAI: false, paidAPI: false },
          rawError: 'PRIVATE_PEER_COLLECTOR_ERROR', cookies: 'SENSITIVE_PEER_TOKEN=fixture-only' };
        data.evidence.response.aweme_detail.author.cookie = 'SENSITIVE_PEER_TOKEN=author-extra';
      }
      callback(error, JSON.stringify({ ok: true, data }), 'PRIVATE_PEER_STDERR');
    };
    const abort = () => { emit('collector-aborted'); setTimeout(() => finish(Object.assign(new Error('PRIVATE_PEER_ABORT'), { name: 'AbortError', code: 'ABORT_ERR' })), ${abortDelayMs}); };
    const command = value => { if (value?.peer === true && value.kind === 'complete' && value.id === id) finish(null); };
    return { stdin: { end(value) {
      input = JSON.parse(value).items[0]; startedAt = new Date().toISOString(); id = ++callId;
      process.on('message', command); options.signal?.addEventListener('abort', abort, { once: true });
      emit('collector-started'); if (options.signal?.aborted) abort();
    } } };
  };
  return real.call(this, payload);
};
`);
  const port = await freePort(), events = []; let logs = '';
  const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url),
    env: { ...process.env, DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'test',
      DOUYIN_AUTHOR_RESOLVER_MODE: 'signed-only', NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.on('message', value => { if (value?.peer) events.push(value); });
  child.stdout.on('data', value => { logs += value; }); child.stderr.on('data', value => { logs += value; });
  let db;
  t.after(async () => {
    db?.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const deadline = Date.now() + 6000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await pause(20);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });
  const instance = { origin: `http://127.0.0.1:${port}`, child, events, logs: () => logs };
  let ready = false;
  for (let n = 0; n < 200; n++) {
    try { if ((await fetch(instance.origin + '/api/health')).ok) { ready = true; break; } } catch {}
    if (child.exitCode !== null) break; await pause(20);
  }
  assert.ok(ready, `Offline fixture did not start: ${logs}`);
  const auth = await fetch(instance.origin + '/api/auth/session'), authData = await auth.json();
  instance.session = { cookie: auth.headers.get('set-cookie').split(';')[0], csrf: authData.csrfToken };
  db = new DatabaseSync(join(dataDir, 'douyin-monitor.sqlite'));
  const jobId = randomUUID(), now = new Date().toISOString();
  // The only fixture writes are to this test's isolated temporary database.
  const request = { fileName: 'offline-peer.xlsx', sheetName: 'authors', rows: [{ sourceRow: 682,
    platform: 'douyin', name: 'Offline fixture', douyinId: '80336194274', videoId: '7686424948055891786', status: 'resolvable' }] };
  db.prepare(`INSERT INTO author_resolution_jobs(id,user_id,actor_name,file_name,sheet_name,status,phase,total_authors,request_json,result_json,created_at,finished_at,updated_at)
    VALUES(?,?,?,?,?,'completed','completed',1,?,?,?,?,?)`).run(jobId, authData.user.id, 'offline-peer', request.fileName, request.sheetName,
      JSON.stringify(request), JSON.stringify({ skipped: [] }), now, now, now);
  instance.path = `/api/author-spreadsheet/jobs/${jobId}/authorised-detail`;
  instance.db = db; instance.request = request;
  instance.snapshot = () => ({ jobs: db.prepare('SELECT * FROM author_resolution_jobs ORDER BY id').all(),
    queue: db.prepare('SELECT * FROM author_resolution_queue ORDER BY id').all(),
    targets: db.prepare('SELECT * FROM targets ORDER BY id').all(), snapshots: db.prepare('SELECT * FROM snapshots ORDER BY id').all(),
    sources: db.prepare('SELECT * FROM author_resolution_import_sources ORDER BY id').all(),
    proofs: db.prepare('SELECT * FROM author_resolution_success_receipts ORDER BY id').all() });
  instance.waitEvent = kind => until(() => events.find(event => event.kind === kind), `Missing ${kind}; logs=${logs}`);
  instance.complete = id => child.send({ peer: true, kind: 'complete', id });
  return instance;
}

test('HTTP peer: concurrent authorised checks admit one collector and retain cooldown without data mutation', { timeout: 15000 }, async t => {
  const f = await fixture(t), before = f.snapshot();
  const first = json(f, f.path, { body: { sourceRow: 682 } });
  const event = await f.waitEvent('collector-started');
  const second = await json(f, f.path, { body: { sourceRow: 682 } });
  assert.equal(second.status, 429); assert.equal(f.events.filter(e => e.kind === 'collector-started').length, 1);
  f.complete(event.id);
  const accepted = await first;
  assert.equal(accepted.status, 200); assert.equal(accepted.data.monitoringChanged, false);
  assert.equal(accepted.data.result.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(accepted.data), /PRIVATE_PEER/);
  assert.equal((await json(f, f.path, { body: { sourceRow: 682 } })).status, 429);
  assert.deepEqual(f.snapshot(), before);
});

test('HTTP peer: a valid natural identity result rejected by admission returns safe 409 and preserves original state', { timeout: 15000 }, async t => {
  const f = await fixture(t, { successfulDetail: true }), now = new Date().toISOString();
  const row = f.request.rows[0], evidence = buildAuthorEvidenceRequests([row])[0];
  f.db.prepare(`INSERT INTO author_resolution_queue(identity_key,name,douyin_id,video_ids_json,source_rows_json,
    file_name,sheet_name,status,attempts,next_attempt_at,last_error,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'rejected',5,?,?,?,?)`).run(evidence.key, row.name, row.douyinId,
      JSON.stringify(evidence.videoIds), '[682]', f.request.fileName, f.request.sheetName, now,
      '达到公开核验重试上限；HTTP 403；identity_mismatch；PRIVATE_PEER_ORIGINAL_EXCEPTION; SENSITIVE_PEER_TOKEN=old', now, now);
  f.db.prepare(`INSERT INTO targets(type,label,locator,provider,enabled,metadata_json,created_at,updated_at)
    VALUES('account','原人工暂停账号','MS4wLjABAAAAPeerHttpAuthor000000001','public-web',0,?,?,?)`)
    .run(JSON.stringify({ platform: 'douyin', note: 'Original paused target must remain byte-for-byte unchanged' }), now, now);
  const before = f.snapshot();
  const request = json(f, f.path.replace(/authorised-detail$/, 'authorised-monitor'), { body: { sourceRow: 682 } });
  f.complete((await f.waitEvent('collector-started')).id);
  const rejected = await request;
  assert.equal(rejected.status, 409);
  assert.equal(rejected.data.result.status, 'ok', 'observed identity success is not admission success');
  assert.equal(rejected.data.result.candidate.uniqueId, row.douyinId);
  assert.equal(rejected.data.result.evidence.response.aweme_detail.aweme_id, row.videoId);
  assert.equal(rejected.data.monitoringChanged, false);
  assert.equal(rejected.data.code, 'AUTHORISED_ADMISSION_NOT_ELIGIBLE');
  assert.equal(rejected.data.error, '本行暂未通过安全入库检查；没有启用新账号，请查看核验记录');
  assert.equal(rejected.data.admission, undefined);
  assert.doesNotMatch(JSON.stringify(rejected.data), /PRIVATE_PEER|SENSITIVE_PEER_TOKEN|identity_mismatch|达到公开核验重试上限/);
  assert.deepEqual(f.snapshot(), before, 'target, original queue/error, source, historical job and success proofs remain unchanged');
  assert.equal(f.snapshot().proofs.length, 0, 'a successful observation cannot create a false success receipt');
  assert.equal(f.snapshot().targets[0].enabled, 0);
  assert.doesNotMatch(f.logs(), /PRIVATE_PEER|SENSITIVE_PEER_TOKEN/);
});

test('HTTP peer: disconnect cancels the collector and a late callback cannot admit a second probe', { timeout: 15000 }, async t => {
  const f = await fixture(t, { abortDelayMs: 150 }), before = f.snapshot(), controller = new AbortController();
  const first = json(f, f.path, { body: { sourceRow: 682 }, signal: controller.signal }).then(
    value => ({ value }), error => ({ error }));
  const started = await f.waitEvent('collector-started'); controller.abort();
  await f.waitEvent('collector-aborted');
  assert.equal((await json(f, f.path, { body: { sourceRow: 682 } })).status, 429);
  // A collector callback arriving after the socket closes must be suppressed
  // by the real provider's cancellation recheck and the route close guard.
  f.complete(started.id);
  await f.waitEvent('collector-settled');
  assert.ok((await first).error);
  assert.equal((await json(f, f.path, { body: { sourceRow: 682 } })).status, 429);
  assert.equal(f.events.filter(e => e.kind === 'collector-started').length, 1);
  assert.deepEqual(f.snapshot(), before);
  assert.doesNotMatch(f.logs(), /PRIVATE_PEER/);
});

test('HTTP peer: shutdown waits for the admitted authorised collector cleanup, not just its forced-closed socket', { timeout: 15000 }, async t => {
  const f = await fixture(t, { abortDelayMs: 2500 });
  const first = json(f, f.path, { body: { sourceRow: 682 } }).then(value => ({ value }), error => ({ error }));
  await f.waitEvent('collector-started'); f.child.kill('SIGTERM');
  await f.waitEvent('collector-aborted');
  await until(() => f.child.exitCode !== null || f.child.signalCode !== null, 'Server shutdown did not settle', 6000);
  assert.ok(f.events.some(event => event.kind === 'collector-settled'), 'Server exited before its admitted collector confirmed cleanup');
  const outcome = await first;
  assert.notEqual(outcome.value?.status, 200);
  assert.doesNotMatch(f.logs(), /PRIVATE_PEER/);
});

test('HTTP peer: embedded server.close also cancels and drains an admitted authorised collector', { timeout: 15000 }, async t => {
  const f = await fixture(t, { abortDelayMs: 2500 });
  const first = json(f, f.path, { body: { sourceRow: 682 } }).then(value => ({ value }), error => ({ error }));
  await f.waitEvent('collector-started'); f.child.send({ peer: true, kind: 'close-server' });
  await until(() => f.child.exitCode !== null || f.child.signalCode !== null, 'Embedded server close did not settle', 6500);
  assert.ok(f.events.some(event => event.kind === 'collector-aborted'), 'Embedded close did not cancel admitted collector');
  assert.ok(f.events.some(event => event.kind === 'collector-settled'), 'Embedded close completed before collector cleanup');
  assert.ok(f.events.findIndex(event => event.kind === 'collector-settled') < f.events.findIndex(event => event.kind === 'server-close-complete'));
  assert.notEqual((await first).value?.status, 200);
});
