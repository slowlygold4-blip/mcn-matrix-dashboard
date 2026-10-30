import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { miniappDailyReadiness, parseMiniappDaily, probeMiniappDaily } from '../lib/douyin-miniapp-daily-probe.mjs';

const retrievedAt = '2026-10-29T16:10:00.000Z'; // Beijing Oct30.
const clock = () => retrievedAt;
const credentials = { accountKey: 'fixture:author', openId: 'fixture-miniapp-openid',
  accessToken: 'act.fixture-not-real', scopes: ['ma.user.data'] };
const envelope = rows => ({ err_no: 0, data: { data: { result_list: rows }, extra: { error_code: '0', sub_error_code: '0' } } });
const parse = (rows, kind = 'fans', days = 7) => parseMiniappDaily(envelope(rows), { kind, days, retrievedAt });

test('current nested envelope preserves actual zero, signed fields and missing values', () => {
  assert.deepEqual(parse([{ date: '2026-10-29', total_fans: '0', new_fans: '-2' }, { date: '2026-10-28' }]).rows,
    [{ date: '2026-10-28', values: { new_fans: null, total_fans: null } },
      { date: '2026-10-29', values: { new_fans: -2, total_fans: 0 } }]);
  const work = parse([{ date: '2026-10-29', new_issue: '-1', new_play: '0' }], 'works');
  assert.equal(work.rows[0].values.new_play, 0);
  assert.equal(work.rows[0].values.total_issue, null);
  assert.equal(work.dailyPublicationCount, null);
  assert.equal(work.endpoint, '/api/apps/v1/user/get_item/');
  assert.equal(parse([], 'likes').missingDays, 7);
});

test('7 and 15 days are allowed; the general authorization page does not justify 30 days here', () => {
  assert.equal(parse([{ date: '2026-10-15', new_like: 2 }], 'likes', 15).returnedDays, 1);
  assert.throws(() => parse([], 'fans', 30), { code: 'invalid_input' });
  assert.throws(() => parseMiniappDaily(envelope([]), { kind: 'video_plays', days: 7, retrievedAt }), { code: 'invalid_input' });
});

test('missing, duplicate, future and out-of-range days are never fabricated or accepted', () => {
  for (const date of ['2026-10-30', '2026-10-22', '2026-02-30', 'yyyy-MM-dd']) {
    assert.throws(() => parse([{ date }]), { code: 'invalid_date' });
  }
  assert.throws(() => parse([{ date: '2026-10-29' }, { date: '2026-10-29' }]), { code: 'invalid_date' });
  assert.equal(parse([]).returnedDays, 0);
  for (const total_fans of [-1, true, '', '1e3', '9007199254740993']) {
    assert.throws(() => parse([{ date: '2026-10-29', total_fans }]), { code: 'invalid_metric' });
  }
});

test('top-level success is mandatory and legacy or malformed envelopes are rejected', () => {
  for (const body of [{}, { err_no: '0', data: envelope([]).data }, { err_no: 0 },
    { data: { error_code: 0, result_list: [] } }, { err_no: 0, data: { data: { result_list: null } } }]) {
    assert.throws(() => parseMiniappDaily(body, { kind: 'fans', days: 7, retrievedAt }), { code: 'invalid_response' });
  }
});

test('HTTP200 business refusals retain only bounded codes, never credentials in error descriptions', () => {
  for (const [err_no, code] of [[28001003, 'authorization_required'], [28001008, 'authorization_required'],
    [28001018, 'permission_denied'], [28001019, 'permission_denied'], [28001016, 'application_unavailable'],
    [28003017, 'quota_exhausted'], [28001005, 'platform_error']]) {
    assert.throws(() => parseMiniappDaily({ err_no, err_msg: credentials.accessToken }, { kind: 'fans', days: 7, retrievedAt }),
      { code, message: code, officialErrorCode: err_no });
  }
  const inner = envelope([]);
  inner.data.extra.sub_error_code = '28001018';
  inner.data.extra.description = credentials.accessToken;
  assert.throws(() => parseMiniappDaily(inner, { kind: 'fans', days: 7, retrievedAt }), { code: 'platform_error', officialErrorCode: 28001018 });
  const body = envelope([]); body.data.data.error_code = 28001003;
  assert.throws(() => parseMiniappDaily(body, { kind: 'fans', days: 7, retrievedAt }), { code: 'authorization_required' });
});

test('three serial requests use the new official paths and explicit token header, not a browser or vendor', async () => {
  const paths = [];
  const result = await probeMiniappDaily(credentials, { clock, fetchImpl: async (url, options) => {
    paths.push(url.pathname);
    assert.equal(url.origin, 'https://open.douyin.com');
    assert.equal(url.searchParams.get('date_type'), '7');
    assert.equal(url.searchParams.get('open_id'), credentials.openId);
    assert.equal(url.searchParams.has('access_token'), false);
    assert.equal(options.headers['access-token'], credentials.accessToken);
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    return new Response(JSON.stringify(envelope([{ date: '2026-10-29', total_fans: 1200, new_like: 5, new_play: 33 }])));
  } });
  assert.deepEqual(paths, ['/api/apps/v1/user/get_fans/', '/api/apps/v1/user/get_like/', '/api/apps/v1/user/get_item/']);
  assert.equal(result.datasets[2].rows[0].values.new_play, 33);
  assert.equal(result.networkRequests, 3);
  assert.equal(result.platformPermissionVerified, true);
  assert.equal(result.identityBindingVerified, false); assert.equal(result.productionAdmitted, false);
  assert.equal(result.authorWorksComplete, false); assert.equal(result.modelCalls, 0); assert.equal(result.databaseWrites, 0);
  for (const secret of [credentials.openId, credentials.accessToken]) assert.ok(!JSON.stringify(result).includes(secret));
});

test('missing credentials, legacy scope, invalid days/key/clock and cancellation stop before network', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw Error('must not call'); };
  for (const [changes, code] of [[{ accessToken: '' }, 'authorization_required'], [{ openId: '' }, 'authorization_required'],
    [{ scopes: ['data.external.user'] }, 'scope_required'], [{ days: 30 }, 'invalid_input'], [{ accountKey: '../x' }, 'invalid_input']]) {
    await assert.rejects(probeMiniappDaily({ ...credentials, ...changes }, { fetchImpl, clock }), { code });
  }
  for (const value of ['bad', '2026-10-30', '2026-10-30T10:00:00']) {
    await assert.rejects(probeMiniappDaily(credentials, { fetchImpl, clock: () => value }), { code: 'invalid_clock' });
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(probeMiniappDaily(credentials, { fetchImpl, signal: controller.signal }), { code: 'cancelled' });
  assert.equal(calls, 0);
});

test('HTTP refusals stop at the first endpoint without retries or leaked upstream text', async () => {
  for (const [status, code] of [[401, 'authorization_required'], [403, 'permission_denied'], [429, 'rate_limited'], [503, 'upstream_http_error']]) {
    let calls = 0;
    await assert.rejects(probeMiniappDaily(credentials, { clock, fetchImpl: async () => {
      calls++; return new Response(credentials.accessToken, { status });
    } }), { code, message: code });
    assert.equal(calls, 1);
  }
});

test('second-endpoint failure cannot become successful partial statistics', async () => {
  let calls = 0;
  await assert.rejects(probeMiniappDaily(credentials, { clock, fetchImpl: async () => {
    return new Response(JSON.stringify(++calls === 1 ? envelope([]) : { err_no: 28003017 }));
  } }), { code: 'quota_exhausted' });
  assert.equal(calls, 2);
});

test('HTML, oversized bodies and credential-bearing transport errors fail safely', async () => {
  for (const [text, code] of [['<html>login</html>', 'invalid_response'], [' '.repeat(65537), 'response_too_large']]) {
    await assert.rejects(probeMiniappDaily(credentials, { clock, fetchImpl: async () => new Response(text) }), { code });
  }
  await assert.rejects(probeMiniappDaily(credentials, { clock, fetchImpl: async () => { throw Error(credentials.accessToken); } }),
    { code: 'network_error', message: 'network_error' });
});

test('readiness exposes restrictions but no credential values or claim of authorization', () => {
  const r = miniappDailyReadiness(credentials);
  assert.equal(r.miniappUserDataScopeDeclared, true); assert.equal(r.platformPermissionVerified, false);
  assert.deepEqual(r.supportedDays, [7, 15]); assert.equal(r.todayIncluded, false);
  assert.equal(r.identityBindingVerified, false);
  for (const secret of [credentials.openId, credentials.accessToken]) assert.ok(!JSON.stringify(r).includes(secret));
});

test('CLI readiness and explicit run without credentials make no platform requests or writes', () => {
  const env = { ...process.env, DOUYIN_MINIAPP_ACCESS_TOKEN: '', DOUYIN_MINIAPP_OPEN_ID: '', DOUYIN_MINIAPP_SCOPES: '' };
  const script = new URL('../scripts/probe-douyin-miniapp-daily.mjs', import.meta.url);
  const check = spawnSync(process.execPath, [script.pathname], { env, encoding: 'utf8' });
  assert.equal(check.status, 0); assert.equal(JSON.parse(check.stdout).networkRequests, 0);
  const run = spawnSync(process.execPath, [script.pathname, '--run', '--account-key', 'fixture'], { env, encoding: 'utf8' });
  assert.equal(run.status, 1); assert.equal(JSON.parse(run.stdout).code, 'authorization_required');
  const invalid = spawnSync(process.execPath, [script.pathname, '--run'], { env, encoding: 'utf8' });
  assert.equal(invalid.status, 2);
});
