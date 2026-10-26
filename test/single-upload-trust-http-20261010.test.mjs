import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function cookieFrom(response) {
  return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
}

test('source-poller capability accepts only loopback sockets and loopback HTTP origins', async () => {
  const capability = await import('../lib/internal-source-capability.mjs');
  for (const address of ['127.0.0.1', '127.255.1.2', '::1', '::ffff:127.0.0.1']) {
    assert.equal(capability.isLoopbackAddress(address), true, address);
  }
  for (const address of ['', '0.0.0.0', '192.168.1.2', '10.0.0.2', '::', '2001:db8::1']) {
    assert.equal(capability.isLoopbackAddress(address), false, address);
  }
  assert.equal(capability.normalizeLoopbackHttpOrigin('http://127.0.0.1:4188/'), 'http://127.0.0.1:4188');
  assert.equal(capability.normalizeLoopbackHttpOrigin('http://localhost:4188'), 'http://localhost:4188');
  assert.equal(capability.normalizeLoopbackHttpOrigin('http://[::1]:4188/'), 'http://[::1]:4188');
  for (const origin of ['https://127.0.0.1:4188', 'http://0.0.0.0:4188', 'http://192.168.1.2:4188',
    'http://example.com:4188', 'http://user:secret@127.0.0.1:4188', 'http://127.0.0.1:4188/api']) {
    assert.throws(() => capability.normalizeLoopbackHttpOrigin(origin), /loopback HTTP/);
  }
});

async function request(origin, path, { method = 'GET', cookie, csrf, body, headers = {} } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, payload: await response.json() };
}

test('single-file commit reparses exact bytes and never trusts submitted preview rows or board catalog', { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mcn-single-upload-trust-'));
  process.env.DATA_DIR = directory;
  process.env.NODE_ENV = 'test';
  const { server } = await import('../server.mjs');
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const origin = `http://127.0.0.1:${server.address().port}`;
  const sessionResponse = await fetch(`${origin}/api/auth/session`);
  const session = await sessionResponse.json();
  const auth = { cookie: cookieFrom(sessionResponse), csrf: session.csrfToken };
  const source = Buffer.from('作者名称,sec_uid,板块\n真实作者,MS4wLjABAAAAtrustedSingleUpload12345678901234567890,真实板块\n', 'utf8');
  const changed = Buffer.from('作者名称,sec_uid,板块\n另一作者,MS4wLjABAAAAchangedSingleUpload123456789012345678,错误板块\n', 'utf8');
  const preview = await request(origin, '/api/author-spreadsheet/preview', {
    method: 'POST', ...auth, body: { fileName: '可信名单.csv', contentBase64: source.toString('base64') },
  });
  assert.equal(preview.response.status, 200);
  assert.equal(preview.payload.uploadSha256, createHash('sha256').update(source).digest('hex'));

  const forgedClientProjection = {
    fileName: '可信名单.csv', sheetName: 'CSV', uploadSha256: preview.payload.uploadSha256,
    rows: [{ sourceRow: 2, name: '伪造作者', platform: 'douyin', status: 'ready', locator: 'MS4wLjABAAAAforgedClientRow12345678901234567890', board: '伪造板块' }],
    boardCatalog: [{ name: '伪造目录' }], defaultBoard: '默认板块',
  };

  const missingBytes = await request(origin, '/api/author-spreadsheet/auto-monitor', {
    method: 'POST', ...auth, body: forgedClientProjection,
  });
  assert.equal(missingBytes.response.status, 400);
  assert.match(missingBytes.payload.error, /上传内容|文件校验/);

  const changedBytes = await request(origin, '/api/author-spreadsheet/auto-monitor', {
    method: 'POST', ...auth, body: { ...forgedClientProjection, contentBase64: changed.toString('base64') },
  });
  assert.equal(changedBytes.response.status, 409);
  assert.match(changedBytes.payload.error, /文件内容与预览时不同/);

  const before = new DatabaseSync(join(directory, 'douyin-monitor.sqlite'), { readOnly: true });
  assert.equal(before.prepare('SELECT COUNT(*) AS count FROM author_resolution_jobs').get().count, 0, 'rejected submissions create no durable jobs');
  assert.equal(before.prepare("SELECT COUNT(*) AS count FROM board_catalog WHERE board_name IN ('伪造板块','伪造目录','错误板块')").get().count, 0, 'rejected projections create no boards');
  before.close();

  const accepted = await request(origin, '/api/author-spreadsheet/auto-monitor', {
    method: 'POST', ...auth, body: { ...forgedClientProjection, contentBase64: source.toString('base64') },
  });
  assert.equal(accepted.response.status, 202, JSON.stringify(accepted.payload));
  assert.match(accepted.payload.id, /^[0-9a-f-]{36}$/i);

  const db = new DatabaseSync(join(directory, 'douyin-monitor.sqlite'), { readOnly: true });
  const stored = JSON.parse(db.prepare('SELECT request_json FROM author_resolution_jobs WHERE id=?').get(accepted.payload.id).request_json);
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.rows[0].name, '真实作者');
  assert.equal(stored.rows[0].locator, 'MS4wLjABAAAAtrustedSingleUpload12345678901234567890');
  assert.equal(stored.rows[0].board, '真实板块', 'explicit source board wins over the blank-row fallback');
  assert.deepEqual(stored.boardCatalog, [{ name: '真实板块' }], 'client catalog is replaced by source-derived memberships');
  assert.equal(JSON.stringify(stored).includes('伪造'), false);
  db.close();
});

test('Bitable row submissions require the private source-poller capability and never persist it', { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mcn-bitable-capability-'));
  process.env.DATA_DIR = directory;
  process.env.NODE_ENV = 'test';
  // Use a query string so this module gets its own server/database singleton
  // even though the previous test imported server.mjs in the same process.
  const { server } = await import(`../server.mjs?bitable-capability=${Date.now()}`);
  const capabilityModule = await import('../lib/internal-source-capability.mjs');
  const { trustedBitableRequestHeaders } = await import('../scripts/source-poller.mjs');
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const origin = `http://127.0.0.1:${server.address().port}`;
  const sessionResponse = await fetch(`${origin}/api/auth/session`);
  const session = await sessionResponse.json();
  const auth = { cookie: cookieFrom(sessionResponse), csrf: session.csrfToken };
  const body = {
    sourceType: 'lark-bitable',
    fileName: '可信多维表.json',
    sheetName: '数据表',
    sourceUrl: 'https://fixture.feishu.cn/base/BitableObject12345?table=tblRecordTable123',
    sourceTitle: '可信来源',
    sourceRevision: 1,
    sourceSheetId: 'tblRecordTable123',
    sourceSha256: 'a'.repeat(64),
    sourceReadAt: new Date(Date.now() - 1_000).toISOString(),
    defaultBoard: '一条小团团切片矩阵',
    rows: [{
      sourceRow: 2,
      sourceRecordId: 'recTrustedRecord123',
      name: '可信多维表作者',
      platform: 'douyin',
      status: 'ready',
      locator: 'MS4wLjABAAAAbitableCapability1234567890123456789012',
      board: '一条小团团切片矩阵',
    }],
  };

  const missing = await request(origin, '/api/author-spreadsheet/auto-monitor', {
    method: 'POST', ...auth, body,
  });
  assert.equal(missing.response.status, 403);
  assert.match(missing.payload.error, /本机已授权的来源检查器/);

  const invalid = await request(origin, '/api/author-spreadsheet/auto-monitor', {
    method: 'POST', ...auth, body, headers: { [capabilityModule.SOURCE_POLLER_CAPABILITY_HEADER]: 'b'.repeat(64) },
  });
  assert.equal(invalid.response.status, 403);

  const capabilityPath = capabilityModule.sourcePollerCapabilityPath(directory);
  const capability = (await readFile(capabilityPath, 'utf8')).trim();
  assert.match(capability, /^[a-f0-9]{64}$/);
  assert.equal((await stat(capabilityPath)).mode & 0o777, 0o600);
  const trustedHeaders = await trustedBitableRequestHeaders({}, { dataDirectory: directory });
  assert.equal(trustedHeaders[capabilityModule.SOURCE_POLLER_CAPABILITY_HEADER], capability);

  const accepted = await request(origin, '/api/author-spreadsheet/auto-monitor', {
    method: 'POST', ...auth, body, headers: trustedHeaders,
  });
  assert.equal(accepted.response.status, 202, JSON.stringify(accepted.payload));

  const db = new DatabaseSync(join(directory, 'douyin-monitor.sqlite'), { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM author_resolution_jobs').get().count, 1);
  const stored = db.prepare('SELECT request_json FROM author_resolution_jobs WHERE id=?').get(accepted.payload.id).request_json;
  assert.equal(JSON.parse(stored).sourceType, 'lark-bitable');
  assert.equal(stored.includes(capability), false, 'private capability never enters durable job data');
  db.close();

  const lanAddress = Object.values(networkInterfaces()).flat()
    .find(item => item?.family === 'IPv4' && !item.internal)?.address;
  if (lanAddress) {
    const remoteOrigin = `http://${lanAddress}:${server.address().port}`;
    const invite = await request(origin, '/api/access/invites', {
      method: 'POST', ...auth, body: { role: 'editor', hours: 1, maxUses: 1, label: 'loopback-boundary-test' },
    });
    assert.equal(invite.response.status, 201, JSON.stringify(invite.payload));
    const joined = await request(remoteOrigin, '/api/auth/join', {
      method: 'POST', body: { code: invite.payload.code, displayName: '远端边界测试' },
    });
    assert.equal(joined.response.status, 200, JSON.stringify(joined.payload));
    const remoteAuth = { cookie: cookieFrom(joined.response), csrf: joined.payload.csrfToken };
    const remote = await request(remoteOrigin, '/api/author-spreadsheet/auto-monitor', {
      method: 'POST', ...remoteAuth, body, headers: trustedHeaders,
    });
    assert.equal(remote.response.status, 403, JSON.stringify(remote.payload));
    assert.match(remote.payload.error, /本机已授权的来源检查器/);
    const afterRemote = new DatabaseSync(join(directory, 'douyin-monitor.sqlite'), { readOnly: true });
    assert.equal(afterRemote.prepare('SELECT COUNT(*) AS count FROM author_resolution_jobs').get().count, 1,
      'a replayed capability over a non-loopback socket creates no job');
    afterRemote.close();
  }

  const publicAttempt = await fetch(`${origin}/source-poll/${capabilityModule.SOURCE_POLLER_CAPABILITY_FILENAME}`);
  assert.equal(publicAttempt.status, 404, 'private capability is outside the public web root');
});
