import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';
const START = '2026-10-09T16:00:00.000Z', END = '2026-10-09T16:00:01.000Z';
const input = { key: 'queue:1', videoId: '7686424948055891786', submittedId: '80336194274' };
function result() {
  const response = { status_code: 0, aweme_detail: { aweme_id: input.videoId, author: {
    sec_uid: 'MS4wLjABAAAAAuthorisedDetailFixture0000001', uid: '12345678901', unique_id: input.submittedId,
  } } };
  const responseSha256 = createHash('sha256').update(JSON.stringify(response)).digest('hex');
  const responseSha256Scope = 'public-identity-projection-v1';
  return { status: 'ok', ...input, requestStartedAt: START, requestFinishedAt: END,
    candidate: { videoId: input.videoId, secUid: response.aweme_detail.author.sec_uid,
      uid: '12345678901', uniqueId: input.submittedId, shortId: '', provenance: 'authorised-browser-natural-detail',
      observedAt: END, responseSha256, responseSha256Scope },
    evidence: { version: 1, kind: 'natural-main-frame-detail-response', origin: 'https://www.douyin.com',
      path: '/aweme/v1/web/aweme/detail/', method: 'GET', httpStatus: 200, requestedVideoId: input.videoId,
      observedAt: END, responseSha256, responseSha256Scope, response },
    provenance: { mode: 'authorised-browser-natural-detail', authorisedSessionUsed: true, authenticated: null,
      authenticationStatus: 'not-verified', noChallengeBypass: true, runtimeAI: false, paidAPI: false } };
}
function fixture({ output = result(), error = null, enabled = true, signal, after = () => {} } = {}) {
  const seen = []; let now = START;
  const provider = new PublicWebProvider({}, { authorisedDetailEnabled: enabled, signal, now: () => Date.parse(now),
    execFileImpl: (file, args, options, done) => {
      seen.push({ file, args, options });
      return { stdin: { end: value => { seen[0].input = JSON.parse(value); now = END; after();
        done(error, JSON.stringify({ ok: true, data: output }), 'SECRET_COOKIE'); } } };
    } });
  provider.run = async () => { throw new Error('anonymous fallback prohibited'); };
  return { provider, seen };
}
test('single authorized detail uses bounded shared-executor-compatible contract and validates evidence', async () => {
  const f = fixture(), value = await f.provider.resolveAuthorisedDetail({ items: [input] });
  assert.equal(value.status, 'ok'); assert.equal(value.candidate.uniqueId, input.submittedId);
  assert.equal(f.seen.length, 1); assert.equal(f.seen[0].options.timeout, 45000);
  assert.equal(f.seen[0].options.env.DOUYIN_AUTHORISED_DETAIL_ENABLED, '1');
  assert.match(f.seen[0].args[0], /douyin_authorised_detail\.mjs$/);
  assert.deepEqual(f.seen[0].input, { items: [input] });
  assert.equal(f.provider.authorResolverMode, 'signed-only');
});
test('default-off and invalid multi-item input do not start collector', async () => {
  const f = fixture({ enabled: false });
  await assert.rejects(f.provider.resolveAuthorisedDetail({ items: [input] }), { code: 'AUTHORISED_DETAIL_DISABLED' });
  assert.equal(f.seen.length, 0);
  const g = fixture(); await assert.rejects(g.provider.resolveAuthorisedDetail({ items: [input, input] }));
  assert.equal(g.seen.length, 0);
});
test('mismatched evidence and secret-bearing errors fail closed without anonymous fallback', async () => {
  const bad = result(); bad.candidate.uniqueId = 'wrong';
  for (const options of [{ output: bad }, { error: new Error('SECRET_CREDENTIAL') }]) {
    const f = fixture(options);
    await assert.rejects(f.provider.resolveAuthorisedDetail({ items: [input] }), error => {
      assert.equal(error.code, 'AUTHORISED_DETAIL_UNVERIFIED'); assert.doesNotMatch(error.message, /SECRET/); return true;
    }); assert.equal(f.seen.length, 1);
  }
});
test('access denial is returned as unavailable and does not trigger retries', async () => {
  const f = fixture({ output: { status: 'unavailable', ...input, requestStartedAt: START, requestFinishedAt: END,
    errorCode: 'blocked', secret: 'SECRET' } });
  const value = await f.provider.resolveAuthorisedDetail({ items: [input] });
  assert.equal(value.errorCode, 'blocked'); assert.equal('secret' in value, false); assert.equal(f.seen.length, 1);
});
test('cancellation before and during collector cannot return success', async () => {
  for (const before of [true, false]) {
    const controller = new AbortController(); if (before) controller.abort();
    const f = fixture({ signal: controller.signal, after: () => controller.abort() });
    await assert.rejects(f.provider.resolveAuthorisedDetail({ items: [input] }), { name: 'AbortError' });
    assert.equal(f.seen.length, before ? 0 : 1);
  }
});
