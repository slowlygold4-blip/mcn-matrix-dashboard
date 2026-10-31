import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';
import { createOwnedCollectorExecutor } from '../lib/collector-ownership.mjs';
import { prepareImportWorkAuthorCandidate } from '../lib/douyin-work-author-candidate.mjs';
import { validateAuthorisedDetailResult, AUTHORISED_DETAIL_FINAL_URL_SCOPE } from '../lib/douyin-authorised-detail.mjs';

const START = '2026-10-09T19:20:00.000Z', END = '2026-10-09T19:20:01.000Z';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function inputFixture({ share = false } = {}) {
  return prepareImportWorkAuthorCandidate({ id: 'c9895a58-14ef-4f1f-8c88-428fb3ce8d6f', status: 'completed',
    request: { rows: [{ sourceRow: 294, platform: 'douyin', douyinId: '这是填错的中文昵称',
      ...(share ? { shareUrl: 'https://v.douyin.com/Fixture001/' } : { videoId: '7686424948055891786' }) }] } }, { sourceRow: 294 });
}
const input = inputFixture();
function result(item = input) {
  const videoId = item.videoId ?? '7686424948055891786';
  const response = { status_code: 0, aweme_detail: { aweme_id: videoId, author: {
    sec_uid: 'MS4wLjABAAAAWorkAuthorCandidateFixture001', uid: '12345678901', unique_id: 'public.fixture',
  } } };
  const responseSha256 = hash(response), responseSha256Scope = 'work-author-candidate-public-projection-v1';
  return { status: 'candidate-only', scope: 'source-work-author-candidate', submittedIdentityVerified: false,
    metricsSampled: false, monitoringEnabled: false, ...item, ...(item.shareUrl ? { videoId } : {}),
    requestStartedAt: START, requestFinishedAt: END,
    candidate: { videoId, secUid: response.aweme_detail.author.sec_uid, uid: '12345678901', uniqueId: 'public.fixture', shortId: '',
      provenance: 'authorised-browser-natural-detail', observedAt: END, responseSha256, responseSha256Scope },
    evidence: { version: 1, kind: 'natural-main-frame-work-author-candidate-response', origin: 'https://www.douyin.com',
      path: '/aweme/v1/web/aweme/detail/', method: 'GET', httpStatus: 200, requestedVideoId: videoId,
      ...(item.shareUrl ? { requestedShareUrl: item.shareUrl, finalUrl: `https://www.douyin.com/video/${videoId}`,
        finalVideoId: videoId, finalUrlSha256: 'a'.repeat(64), finalUrlScope: AUTHORISED_DETAIL_FINAL_URL_SCOPE } : {}),
      observedAt: END, responseSha256, responseSha256Scope, response },
    provenance: { mode: 'authorised-browser-natural-detail', authorisedSessionUsed: true, authenticated: null,
      authenticationStatus: 'not-verified', noChallengeBypass: true, runtimeAI: false, paidAPI: false } };
}
function fixture({ output = result(), error = null, enabled = true, signal, after = () => {}, settings = {} } = {}) {
  const seen = []; let now = START;
  const provider = new PublicWebProvider(settings, { ...(enabled === undefined ? {} : { workAuthorCandidateEnabled: enabled }),
    signal, now: () => Date.parse(now), execFileImpl: (file, args, options, done) => {
      const call = { file, args, options }; seen.push(call);
      return { stdin: { end: value => { call.input = JSON.parse(value); now = END; after();
        done(error, JSON.stringify({ ok: true, data: output }), 'SECRET_SESSION'); } } };
    } });
  for (const method of ['run', 'resolveDouyinAuthors', 'resolveAuthorisedDetail', 'collect']) {
    provider[method] = async () => { throw new Error('Unexpected collection or admission fallback'); };
  }
  return { provider, seen };
}

test('source-bound single candidate uses bounded owned-collector contract without identity admission', async () => {
  const f = fixture(), value = await f.provider.resolveWorkAuthorCandidate({ items: [input] });
  assert.equal(value.status, 'candidate-only');
  assert.equal(value.monitoringEnabled, false); assert.equal(value.metricsSampled, false); assert.equal(value.submittedIdentityVerified, false);
  assert.deepEqual(value.source, input.source); assert.equal(value.candidate.uniqueId, 'public.fixture');
  assert.equal(f.seen.length, 1); assert.equal(f.seen[0].file, process.execPath);
  assert.equal(f.seen[0].options.timeout, 45_000); assert.equal(f.seen[0].options.maxBuffer, 256 * 1024);
  assert.equal(f.seen[0].options.env.DOUYIN_WORK_AUTHOR_CANDIDATE_ENABLED, '1');
  assert.match(f.seen[0].args[0], /douyin_work_author_candidate\.mjs$/);
  assert.deepEqual(f.seen[0].input, { items: [input] }); assert.equal(Object.hasOwn(f.seen[0].input.items[0], 'submittedId'), false);
  assert.equal(f.provider.authorResolverMode, 'signed-only'); assert.equal(f.provider.authorisedDetailEnabled, false);
});

test('candidate channel is default off and cannot be enabled by uploaded settings', async () => {
  const f = fixture({ enabled: false, settings: { workAuthorCandidateEnabled: true } });
  await assert.rejects(f.provider.resolveWorkAuthorCandidate({ items: [input] }), { code: 'WORK_AUTHOR_CANDIDATE_DISABLED' });
  assert.equal(f.seen.length, 0);
  assert.equal(new PublicWebProvider({ workAuthorCandidateEnabled: true }).workAuthorCandidateEnabled, false);
  assert.equal(new PublicWebProvider({}, { workAuthorCandidateEnabled: 'true' }).workAuthorCandidateEnabled, false);
});

test('one original short link retains its source and final work as candidate evidence, never a submitted ID', async () => {
  const item = inputFixture({ share: true }), f = fixture({ output: result(item) });
  const value = await f.provider.resolveWorkAuthorCandidate({ items: [item] });
  assert.equal(value.status, 'candidate-only'); assert.equal(value.shareUrl, item.shareUrl);
  assert.equal(value.videoId, '7686424948055891786'); assert.equal(value.evidence.requestedShareUrl, item.shareUrl);
  assert.deepEqual(f.seen[0].input, { items: [item] }); assert.equal(Object.hasOwn(f.seen[0].input.items[0], 'videoId'), false);
  assert.equal(Object.hasOwn(value, 'submittedId'), false);
  const output = result(item); output.evidence.finalUrl = 'https://www.douyin.com.evil.invalid/video/7686424948055891786';
  const bad = fixture({ output });
  await assert.rejects(bad.provider.resolveWorkAuthorCandidate({ items: [item] }), { code: 'WORK_AUTHOR_CANDIDATE_UNVERIFIED' });
});

test('multiple inputs, caller submitted ID and source-key mismatch are rejected before launching', async () => {
  for (const payload of [{ items: [input, input] }, { items: [{ ...input, submittedId: 'guessed' }] },
    { items: [{ ...input, source: { ...input.source, sourceRow: 295 } }] }, { items: [input], runtime: { ownership: {} } }]) {
    const f = fixture(); await assert.rejects(f.provider.resolveWorkAuthorCandidate(payload), { code: 'invalid_input' });
    assert.equal(f.seen.length, 0);
  }
});

test('parent verifies source, response identity, scope and time independently of the child', async () => {
  for (const mutate of [r => r.source.sourceRow++, r => r.candidate.uniqueId = 'other',
    r => r.evidence.response.aweme_detail.aweme_id = '7686424948055891787', r => r.metricsSampled = true,
    r => r.monitoringEnabled = true, r => r.submittedIdentityVerified = true, r => r.status = 'ok',
    r => r.evidence.responseSha256Scope = 'public-identity-projection-v1', r => r.requestFinishedAt = '2026-10-09T19:20:02.000Z']) {
    const output = structuredClone(result()); mutate(output); const f = fixture({ output });
    await assert.rejects(f.provider.resolveWorkAuthorCandidate({ items: [input] }), { code: 'WORK_AUTHOR_CANDIDATE_UNVERIFIED' });
    assert.equal(f.seen.length, 1);
  }
});

test('candidate even relabelled is not a strict admission proof', async () => {
  const f = fixture(), value = await f.provider.resolveWorkAuthorCandidate({ items: [input] });
  assert.throws(() => validateAuthorisedDetailResult({ key: input.key, videoId: input.videoId, submittedId: 'public.fixture' },
    { ...value, status: 'ok', submittedId: 'public.fixture' }, { startedAt: START, finishedAt: END }));
});

test('access gates return safe unavailable projections without retry or fallback', async () => {
  for (const errorCode of ['blocked', 'login_required', 'challenge_required', 'rate_limited']) {
    const output = { ...result(), status: 'unavailable', errorCode, secret: 'SECRET_SESSION' };
    delete output.candidate; delete output.evidence; delete output.provenance;
    const f = fixture({ output }), value = await f.provider.resolveWorkAuthorCandidate({ items: [input] });
    assert.equal(value.errorCode, errorCode); assert.equal(value.status, 'unavailable'); assert.equal(f.seen.length, 1);
    assert.doesNotMatch(JSON.stringify(value), /SECRET|secret/); assert.equal(Object.hasOwn(value, 'candidate'), false);
  }
});

test('secret-bearing errors are masked and shared-lane failure retains its safe code', async () => {
  for (const [error, expected] of [[new Error('SECRET_SESSION'), 'WORK_AUTHOR_CANDIDATE_UNVERIFIED'],
    [Object.assign(new Error('SECRET_SESSION'), { code: 'BROWSER_LANE_BUSY' }), 'BROWSER_LANE_BUSY']]) {
    const f = fixture({ error });
    await assert.rejects(f.provider.resolveWorkAuthorCandidate({ items: [input] }), actual => {
      assert.equal(actual.code, expected); assert.doesNotMatch(actual.message, /SECRET/); return true;
    }); assert.equal(f.seen.length, 1);
  }
});

test('cancel before or during collector cannot surface candidate as a success', async () => {
  for (const before of [true, false]) {
    const controller = new AbortController(); if (before) controller.abort();
    const f = fixture({ signal: controller.signal, after: () => controller.abort() });
    await assert.rejects(f.provider.resolveWorkAuthorCandidate({ items: [input] }), { name: 'AbortError' });
    assert.equal(f.seen.length, before ? 0 : 1);
  }
});

test('candidate CLI stays retired even with explicit legacy enable', () => {
  const script = fileURLToPath(new URL('../scripts/douyin_work_author_candidate.mjs', import.meta.url));
  for (const enabled of [false, true]) {
    const env = { ...process.env }; delete env.MCN_BROWSER_OWNERSHIP_NONCE;
    delete env.DOUYIN_WORK_AUTHOR_CANDIDATE_ENABLED;
    if (enabled) env.DOUYIN_WORK_AUTHOR_CANDIDATE_ENABLED = '1';
    const child = spawnSync(process.execPath, [script], { env, input: JSON.stringify({ items: [input] }), encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 1);
    const response = JSON.parse(child.stdout);
    assert.equal(response.ok, false); assert.equal(response.errorCode, 'DOUYIN_BROWSER_RETIRED');
    assert.equal(response.runtimeAI, false);
    assert.doesNotMatch(child.stdout, /candidate-only|SECRET/);
  }
});

test('retired command remains fail-closed without locking the lane or fabricating browser release', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'candidate-cli-no-session-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executor = createOwnedCollectorExecutor();
  const output = await new Promise(resolve => {
    const child = executor.exec(process.execPath, [fileURLToPath(new URL('../scripts/douyin_work_author_candidate.mjs', import.meta.url))], {
      timeout: 5000, maxBuffer: 16384, env: { ...process.env, NODE_OPTIONS: '',
        DOUYIN_WORK_AUTHOR_CANDIDATE_ENABLED: '1', DOUYIN_ACCOUNT_BROWSER_STATE: join(directory, 'does-not-exist.json') },
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    child.stdin.end(JSON.stringify({ items: [input] }));
  });
  assert.equal(output.error?.code, 'BROWSER_COLLECTOR_EXIT');
  assert.doesNotMatch(output.stdout, /candidate-only/);
  assert.equal(output.stderr, ''); assert.deepEqual(executor.state(), { busy: false, locked: false, reason: null });
});
