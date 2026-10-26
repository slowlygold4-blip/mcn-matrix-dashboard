import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MonitorDatabase } from '../lib/database.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer(); probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

// Explicit loopback socket with arbitrary Host/proxy headers, never DNS or an
// external origin. No request in this test carries a session cookie.
function accessRequest(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path: '/api/access', method: 'GET',
      agent: false, headers: { host: `127.0.0.1:${port}`, ...headers } }, response => {
      let text = '';
      response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        try { resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(text) }); }
        catch (error) { reject(error); }
      });
      response.on('error', reject);
    });
    request.setTimeout(1500, () => request.destroy(new Error('isolated HTTP response timed out')));
    request.on('error', reject); request.end();
  });
}

const configurations = [
  { name: 'configured HTTPS origin wins over a fresh Quick Tunnel', value: 'https://mcn.example.com', kind: 'configured' },
  { name: 'invalid userinfo configuration fails closed instead of falling back', value: 'https://operator@mcn.example.com', kind: 'invalid' },
  { name: 'absent configuration retains the fresh Quick Tunnel legacy contract', value: undefined, kind: 'tunnel' },
  { name: 'legacy temporary URL follows only the current tunnel heartbeat', value: 'https://old-expired-fixture.trycloudflare.com', kind: 'tunnel' },
];

for (const scenario of configurations) test(`isolated HTTP public entry: ${scenario.name}`, { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'monitor-public-entry-http-'));
  const databasePath = join(directory, 'douyin-monitor.sqlite');
  const initial = new MonitorDatabase(databasePath);
  assert.equal(initial.listTargets().length, 0); initial.close();
  const observedAt = new Date().toISOString();
  const tunnelUrl = 'https://entry-http-fixture.trycloudflare.com';
  await writeFile(join(directory, 'public-entry.json'), JSON.stringify({ status: 'running', url: tunnelUrl, updatedAt: observedAt }));
  const port = await freePort();
  assert.notEqual(port, 4188, 'the fixture must never bind the production port');
  const env = { ...process.env, NODE_ENV: 'test', DATA_DIR: directory, HOST: '127.0.0.1', PORT: String(port),
    TRUST_PROXY: 'cloudflare', PYTHON_BIN: join(directory, 'nonexistent-platform-collector'),
    DOUYIN_ACCOUNT_BROWSER_FALLBACK: 'false', DOUYIN_TOPIC_RESOLVER_MODE: 'public' };
  delete env.PUBLIC_BASE_URL;
  if (scenario.value !== undefined) env.PUBLIC_BASE_URL = scenario.value;
  let logs = '';
  const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-12_000); });
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-12_000); });
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', error => resolve({ code: null, error }));
  });
  let stopPromise;
  const stop = () => stopPromise ||= (async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 3000);
    try { return await exited; } finally { clearTimeout(force); }
  })();
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });

  let owner;
  for (let attempt = 0; attempt < 120; attempt++) {
    try { const result = await accessRequest(port); if (result.status === 200) { owner = result; break; } }
    catch { /* Wait only for this child, never probe the production server. */ }
    if (child.exitCode !== null || child.signalCode !== null) break;
    await pause(30);
  }
  assert.equal(owner?.status, 200, `isolated child did not become ready: ${logs}`);
  assert.ok(Array.isArray(owner.body.members), 'a direct local owner receives the admin access overview');
  if (scenario.kind === 'configured') {
    assert.equal(owner.body.publicBaseUrl, 'https://mcn.example.com');
    assert.deepEqual(owner.body.publicEntry, { url: 'https://mcn.example.com', status: 'configured', source: 'configuration',
      verificationStatus: 'unverified', verifiedAt: null, updatedAt: null });
  } else if (scenario.kind === 'invalid') {
    assert.equal(owner.body.publicBaseUrl, null);
    assert.equal(owner.body.publicEntry, null, 'invalid configured URL cannot silently switch to the tunnel host');
  } else {
    assert.equal(owner.body.publicBaseUrl, tunnelUrl);
    assert.deepEqual(owner.body.publicEntry, { url: tunnelUrl, status: 'running', updatedAt: observedAt });
  }

  const forged = [
    ['external Host', { host: 'mcn.example.com' }],
    ['forwarded external client', { 'x-forwarded-for': '203.0.113.10' }],
    ['forged loopback Forwarded identity', { forwarded: 'for=127.0.0.1;host=mcn.example.com;proto=https' }],
    ['forged Cloudflare headers', { host: 'mcn.example.com', 'x-forwarded-proto': 'https',
      'x-forwarded-host': 'mcn.example.com', 'cf-ray': 'fixture-only', 'cf-connecting-ip': '203.0.113.10' }],
    ['proxy headers cannot become local owner by claiming localhost', { 'x-forwarded-host': 'localhost', 'x-real-ip': '127.0.0.1' }],
  ];
  for (const [label, headers] of forged) {
    const rejected = await accessRequest(port, headers);
    assert.equal(rejected.status, 401, label);
    assert.equal(rejected.body.code, 'authentication_required', label);
    assert.equal(rejected.headers['set-cookie'], undefined, `${label} must not receive an owner cookie`);
    assert.equal(rejected.body.publicEntry, undefined, `${label} must not receive the admin entry metadata`);
    assert.equal(rejected.body.publicBaseUrl, undefined);
  }

  const exit = await stop();
  assert.equal(exit.code, 0, `child must shut down normally: ${logs}`);
  assert.equal(exit.signal, null);
  const saved = new DatabaseSync(databasePath, { readOnly: true });
  try {
    for (const table of ['targets', 'runs', 'audits', 'snapshots']) {
      assert.equal(saved.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0, `${table} must remain empty: this is an entry/auth test, not collection`);
    }
  } finally { saved.close(); }
});
