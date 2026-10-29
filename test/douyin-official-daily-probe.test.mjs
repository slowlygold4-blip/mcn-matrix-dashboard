import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { officialDailyReadiness, parseOfficialDaily, probeOfficialDaily } from '../lib/douyin-official-daily-probe.mjs';
const retrievedAt = '2026-10-29T16:10:00.000Z'; // Beijing Oct30, not Oct29.
const credentials = { accountKey: 'test:author', openId: 'test-openid', accessToken: 'act.fixture-not-real', scopes: ['data.external.user'] };
const envelope = rows => ({ data: { error_code: '0', result_list: rows }, extra: { error_code: 0 } });
const parse = (rows, kind = 'fans') => parseOfficialDaily(envelope(rows), { kind, days: 7, retrievedAt });

test('official numeric strings preserve zero, signed reported changes and absent fields', () => {
  const { rows } = parse([{ date: '2026-10-29', new_fans: '-3', total_fans: '0' }, { date: '2026-10-28', total_fans: 3 }]);
  assert.deepEqual(rows.map(row => row.values), [{ new_fans: null, total_fans: 3 }, { new_fans: -3, total_fans: 0 }]);
  const work = parse([{ date: '2026-10-29', new_issue: '-1', new_play: '0' }], 'works');
  assert.deepEqual(work.rows[0].values, { new_issue: -1, new_play: 0, total_issue: null });
  assert.equal(work.dailyPublicationCount, null); // Never relabel stock change as new publications.
});

test('missing days and empty success remain missing, not an invented zero series', () => {
  const result = parse([]);
  assert.equal(result.returnedDays, 0);
  assert.equal(result.missingDays, 7);
  assert.deepEqual(result.rows, []);
  assert.equal(parse([{ date: '2026-10-29' }], 'likes').rows[0].values.new_like, null);
});

test('strict Beijing historical window rejects today, old, impossible and duplicate dates', () => {
  for (const date of ['2026-10-30', '2026-10-22', '2026-02-30', 'yyyy-MM-dd', '', null]) {
    assert.throws(() => parse([{ date }]), { code: 'invalid_date' });
  }
  assert.equal(parse([{ date: '2026-10-23' }]).returnedDays, 1);
  assert.throws(() => parse([{ date: '2026-10-29' }, { date: '2026-10-29' }]), { code: 'invalid_date' });
});

test('rejects lossy, empty, boolean and negative cumulative values', () => {
  for (const total_fans of ['', '1.5', '1e3', '9007199254740993', Number.MAX_SAFE_INTEGER + 1, true, {}, -1]) {
    assert.throws(() => parse([{ date: '2026-10-29', total_fans }]), { code: 'invalid_metric' });
  }
  assert.throws(() => parse([{ date: '2026-10-29', new_play: -1 }], 'works'), { code: 'invalid_metric' });
});

test('malformed shapes and business errors cannot pass as a valid empty dataset', () => {
  for (const body of [{}, { data: { error_code: 0, result_list: null } },
    { data: { error_code: 1, result_list: [] } }, { ...envelope([]), extra: { error_code: 1 } }]) {
    assert.throws(() => parseOfficialDaily(body, { kind: 'fans', days: 7, retrievedAt }), /invalid_response|platform_error/);
  }
  assert.throws(() => parse(Array.from({ length: 8 }, () => ({ date: '2026-10-29' }))), { code: 'invalid_response' });
  assert.throws(() => parseOfficialDaily({ data: { error_code: '2190008', description: credentials.accessToken } },
    { kind: 'fans', days: 7, retrievedAt }), { code: 'platform_error', officialErrorCode: 2190008, message: 'platform_error' });
});

test('all three endpoints run serially using official host, token header and actual day counts', async () => {
  const paths = [], clock = () => retrievedAt;
  const r = await probeOfficialDaily(credentials, { clock, fetchImpl: async (url, opts) => {
    paths.push(url.pathname);
    assert.equal(url.origin, 'https://open.douyin.com');
    assert.equal(url.searchParams.get('date_type'), '7');
    assert.equal(url.searchParams.has('access_token'), false);
    assert.equal(opts.redirect, 'error');
    assert.equal(opts.credentials, 'omit');
    assert.equal(opts.headers['access-token'], credentials.accessToken);
    return new Response(JSON.stringify(envelope([{ date: '2026-10-29', total_fans: 100, new_like: 4, new_play: 900 }])));
  } });
  assert.deepEqual(paths, ['/data/external/user/fans/', '/data/external/user/like/', '/data/external/user/item/']);
  assert.equal(r.networkRequests, 3);
  assert.equal(r.datasets[2].rows[0].values.new_play, 900);
  assert.equal(r.datasets[2].rows[0].values.new_issue, null);
  assert.equal(r.modelCalls, 0); assert.equal(r.databaseWrites, 0);
  assert.equal(r.identityBindingVerified, false); assert.equal(r.productionAdmitted, false);
  assert.ok(!JSON.stringify(r).includes(credentials.accessToken));
  assert.ok(!JSON.stringify(r).includes(credentials.openId));
});

test('missing authorization/scope, bad inputs and pre-cancellation make zero requests', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw Error('unexpected'); };
  for (const [changes, code] of [[{ accessToken: null }, 'authorization_required'], [{ scopes: ['video.list'] }, 'scope_required'],
    [{ days: 1 }, 'invalid_input'], [{ accountKey: '../bad' }, 'invalid_input']]) {
    await assert.rejects(probeOfficialDaily({ ...credentials, ...changes }, { fetchImpl }), { code });
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(probeOfficialDaily(credentials, { fetchImpl, signal: controller.signal }), { code: 'cancelled' });
  assert.equal(calls, 0);
  assert.ok(!JSON.stringify(officialDailyReadiness(credentials)).includes(credentials.accessToken));
});

test('refusals stop immediately without retries or next endpoint and never leak messages', async () => {
  for (const [status, code] of [[401, 'authorization_required'], [403, 'permission_denied'], [429, 'rate_limited'], [500, 'upstream_http_error']]) {
    let calls = 0;
    await assert.rejects(probeOfficialDaily(credentials, { fetchImpl: async () => {
      calls++; return new Response(credentials.accessToken, { status });
    } }), { code, message: code });
    assert.equal(calls, 1);
  }
});

test('failure after one successful endpoint cannot be reported as a successful three-metric trial', async () => {
  let calls = 0;
  await assert.rejects(probeOfficialDaily(credentials, { clock: () => retrievedAt, fetchImpl: async () =>
    ++calls === 1 ? new Response(JSON.stringify(envelope([]))) : new Response('denied', { status: 403 }) }), { code: 'permission_denied' });
  assert.equal(calls, 2);
});

test('HTML, oversized responses, broken dates and credential-bearing transport exceptions stay safe', async () => {
  for (const [text, code] of [['<html>login</html>', 'invalid_response'], [' '.repeat(65537), 'response_too_large']]) {
    await assert.rejects(probeOfficialDaily(credentials, { fetchImpl: async () => new Response(text) }), { code });
  }
  await assert.rejects(probeOfficialDaily(credentials, { fetchImpl: async () => { throw Error(credentials.accessToken); } }), { code: 'network_error', message: 'network_error' });
  assert.throws(() => parseOfficialDaily(envelope([]), { kind: 'fans', days: 7, retrievedAt: 'bad' }), { code: 'invalid_input' });
});

test('readiness CLI is network-free and reports unavailable credentials without secret values', () => {
  const env = { ...process.env };
  for (const key of ['DOUYIN_OPEN_ACCESS_TOKEN', 'DOUYIN_OPEN_ID', 'DOUYIN_OPEN_SCOPES']) delete env[key];
  const child = spawnSync(process.execPath, ['scripts/probe-douyin-official-daily.mjs'], { cwd: new URL('../', import.meta.url), env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const r = JSON.parse(child.stdout);
  assert.equal(r.accessTokenPresent, false); assert.equal(r.networkRequests, 0);
  assert.equal(r.modelCalls, 0); assert.equal(r.databaseWrites, 0);
});
