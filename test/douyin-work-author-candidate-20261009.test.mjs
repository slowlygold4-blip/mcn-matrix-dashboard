import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { prepareImportWorkAuthorCandidate, normalizeWorkAuthorCandidateInput, collectDouyinWorkAuthorCandidate,
  validateWorkAuthorCandidateResult, WORK_AUTHOR_CANDIDATE_HASH_SCOPE } from '../lib/douyin-work-author-candidate.mjs';
import { normalizeAuthorisedDetailInput, collectAuthorisedDetail, validateAuthorisedDetailResult } from '../lib/douyin-authorised-detail.mjs';

const JOB = 'c9895a58-14ef-4f1f-8c88-428fb3ce8d6f', VIDEO = '7690702905876096104';
const SEC = 'MS4wLjABAAAACandidateSourceAuthor001', UID = '1234567890123456789';
const SHARE = 'https://v.douyin.com/OfflineToken/', URL = `https://www.douyin.com/video/${VIDEO}`;
const DETAIL = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${VIDEO}&a_bogus=PRIVATE_SIGNATURE`;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const job = (changes = {}, options = {}) => ({ id: JOB, status: 'completed', request: { rows: [{ sourceRow: 294, platform: 'douyin',
  name: '不得搜索此昵称', douyinId: '原表昵称', status: 'resolvable', shareUrl: SHARE, ...changes }] }, ...options });
const prepared = (direct = false) => prepareImportWorkAuthorCandidate(job(direct ? { shareUrl: '', videoId: VIDEO, videoLink: URL } : {}), { sourceRow: 294 });
const body = () => ({ status_code: 0, aweme_detail: { aweme_id: VIDEO,
  author: { sec_uid: SEC, uid: UID, unique_id: 'actual_author', short_id: '000123', nickname: 'PRIVATE_NAME' },
  video: { play_addr: 'PRIVATE_PLAY_URL' } }, headers: { cookie: 'PRIVATE_COOKIE' } });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
class Page extends EventEmitter {
  constructor(scenario) { super(); this.scenario = scenario; this.current = 'about:blank'; this.frame = { url: () => this.current }; this.reads = 0; this.gotos = []; }
  mainFrame() { return this.frame; }
  url() { return this.current; }
  move(url) { this.current = url; this.emit('framenavigated', this.frame); }
  request({ url = DETAIL, frame = this.frame, method = 'GET', navigation = false, redirect = null } = {}) {
    return { url: () => url, frame: () => frame, method: () => method, isNavigationRequest: () => navigation, redirectedFrom: () => redirect };
  }
  respond({ data = body(), status = 200, url = DETAIL, request = this.request({ url }), requestEvent = true, text } = {}) {
    if (requestEvent) this.emit('request', request);
    this.emit('response', { request: () => request, url: () => url, status: () => status,
      text: async () => { this.reads++; return text ? text() : JSON.stringify(data); } });
  }
  async goto(url) { this.gotos.push(url); this.move(url); return this.scenario(this); }
  async close() {}
}
function fixture(scenario = page => { page.move(URL); page.respond(); }) {
  const page = new Page(scenario), calls = [], child = { pid: 23456, exitCode: null, signalCode: null };
  const server = { process: () => child, wsEndpoint: () => 'ws://127.0.0.1/PRIVATE_ENDPOINT',
    close: async () => { calls.push('server.close'); child.exitCode = 0; }, kill: async () => { calls.push('server.kill'); child.signalCode = 'SIGKILL'; } };
  const context = { newPage: async () => page, close: async () => { calls.push('context.close'); } };
  const browser = { newContext: async () => context, close: async () => { calls.push('browser.close'); } };
  const runtime = { readState: async () => { calls.push('state'); return { cookies: [{ name: 'fixture', value: 'PRIVATE_STATE' }] }; }, access: async () => {},
    ownership: { remainingExecutionMs: () => 45_000, send: async kind => { calls.push(kind); } },
    chromium: { launchServer: async options => { calls.push('launchServer'); assert.equal(options.host, '127.0.0.1'); assert.equal(options.port, 0); return server; }, connect: async () => browser } };
  const collect = (input = prepared(), options = {}) => collectDouyinWorkAuthorCandidate({ items: [input] }, { enabled: true, runtime, ...options });
  return { page, runtime, calls, child, server, collect };
}
function closed(f) { for (const event of ['request', 'response', 'framenavigated']) assert.equal(f.page.listenerCount(event), 0); }
const bounds = result => ({ startedAt: result.requestStartedAt, finishedAt: result.requestFinishedAt });

test('source preparation only accepts malformed or missing original IDs and binds the exact original row hash', () => {
  for (const sourceRow of [294, 336, 1532, 1724, 2045]) {
    const source = job({ sourceRow }), before = JSON.stringify(source), input = prepareImportWorkAuthorCandidate(source, { sourceRow });
    assert.equal(input.shareUrl, SHARE); assert.equal(input.source.sourceRow, sourceRow);
    assert.equal(input.source.sourceRowSha256, hash(source.request.rows[0])); assert.equal(input.source.jobId, JOB);
    assert.equal(Object.hasOwn(input, 'submittedId'), false); assert.doesNotMatch(JSON.stringify(input), /昵称|不得搜索/);
    assert.equal(JSON.stringify(source), before);
  }
  assert.ok(prepareImportWorkAuthorCandidate(job({ douyinId: '' }), { sourceRow: 294 }));
  for (const douyinId of ['valid_handle', ' @VALID_HANDLE ', '00123', '123', 123, null, {}, 'bad\nname']) {
    assert.throws(() => prepareImportWorkAuthorCandidate(job({ douyinId }), { sourceRow: 294 }), { code: 'invalid_input' });
  }
});
test('source selection rejects canonical, conflicting, already-bound, cross-platform or multi-work records', () => {
  for (const changes of [{ locator: SEC }, { secUid: SEC }, { accountLocator: SEC }, { targetId: 7 }, { resolvedTargetId: 7 },
    { status: 'ready' }, { status: 'existing' }, { status: 'identity_conflict' }, { status: 'rejected' }, { identityConflict: 'conflict' },
    { rejectedLink: 'bad' }, { platform: 'bilibili' }, { bilibiliId: '123' }, { videoIds: [VIDEO] }, { shareUrls: [SHARE] },
    { contentId: VIDEO }, { videoLink: SHARE + ' https://v.douyin.com/OtherToken/' }, { videoHyperlink: 'https://evil.example/work' },
    { shareUrl: SHARE + '?x=1' }, { shareUrl: 'https://v.douyin.com:443/OfflineToken/' }, { shareUrl: 'https://%76.douyin.com/OfflineToken/' }]) {
    assert.throws(() => prepareImportWorkAuthorCandidate(job(changes), { sourceRow: 294 }), { code: 'invalid_input' }, JSON.stringify(changes));
  }
  for (const options of [{ sourceRow: '294' }, { sourceRow: 294, shareUrl: SHARE }, { sourceRow: 999 }]) assert.throws(() => prepareImportWorkAuthorCandidate(job(), options));
  const duplicate = job(); duplicate.request.rows.push({ ...duplicate.request.rows[0] }); assert.throws(() => prepareImportWorkAuthorCandidate(duplicate, { sourceRow: 294 }));
  assert.throws(() => prepareImportWorkAuthorCandidate(job({}, { status: 'running' }), { sourceRow: 294 }));
  assert.ok(prepared(true));
  assert.throws(() => prepareImportWorkAuthorCandidate(job({ videoId: VIDEO, videoLink: URL, shareUrl: SHARE }), { sourceRow: 294 }));
});
test('input has no submitted-ID escape hatch and is default-off before state or browser access', async () => {
  const f = fixture(), input = prepared();
  await assert.rejects(collectDouyinWorkAuthorCandidate({ items: [input] }, { runtime: f.runtime }), { code: 'disabled' });
  await assert.rejects(collectDouyinWorkAuthorCandidate({ items: [input] }, { enabled: true }), { code: 'ownership_required' });
  for (const changed of [{ ...input, submittedId: 'placeholder' }, { ...input, expectedSecUid: SEC }, { ...input, videoId: VIDEO },
    { ...input, key: 'other' }, { ...input, source: { ...input.source, sourceRow: 336 } }, { ...input, source: { ...input.source, token: 'PRIVATE' } }]) {
    assert.throws(() => normalizeWorkAuthorCandidateInput({ items: [changed] }), { code: 'invalid_input' });
  }
  assert.throws(() => normalizeAuthorisedDetailInput({ items: [input] }), { code: 'invalid_input' }); assert.deepEqual(f.calls, []);
});
test('one exact natural share or work returns candidate-only, safe public fields and independent hash domain', async () => {
  for (const direct of [false, true]) {
    const finalUrl = URL + '?tracking=PRIVATE_TRACKING', input = prepared(direct);
    const f = fixture(page => { if (!direct) page.move(finalUrl); page.respond(); });
    const result = await f.collect(input); assert.equal(result.status, 'candidate-only');
    assert.equal(result.scope, 'source-work-author-candidate'); assert.equal(result.submittedIdentityVerified, false);
    assert.equal(result.metricsSampled, false); assert.equal(result.monitoringEnabled, false);
    assert.equal(result.candidate.uniqueId, 'actual_author'); assert.equal(result.candidate.secUid, SEC);
    assert.equal(result.candidate.responseSha256Scope, WORK_AUTHOR_CANDIDATE_HASH_SCOPE);
    assert.equal(result.evidence.responseSha256, hash(result.evidence.response)); assert.equal(result.videoId, VIDEO);
    if (!direct) { assert.equal(result.evidence.finalUrl, URL); assert.equal(result.evidence.finalUrlSha256, createHash('sha256').update(finalUrl).digest('hex')); }
    assert.deepEqual(validateWorkAuthorCandidateResult(input, result, bounds(result)), result);
    assert.deepEqual(f.page.gotos, [direct ? URL : SHARE]); assert.equal(f.page.reads, 1); assert.ok(f.calls.includes('released'));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|tracking=|nickname|"submittedId"|"admission"/); closed(f);
  }
});
test('missing or malformed public handles never fall back to UID or nickname, and numeric canonical/UID fields stay rejected', async () => {
  for (const change of [data => { delete data.aweme_detail.author.unique_id; delete data.aweme_detail.author.short_id; },
    data => { data.aweme_detail.author.unique_id = '0'; data.aweme_detail.author.short_id = '0'; },
    data => { data.aweme_detail.author.unique_id = '...'; delete data.aweme_detail.author.short_id; },
    data => { data.aweme_detail.author.uid = Number(UID); }, data => { delete data.aweme_detail.author.uid; },
    data => { data.aweme_detail.author.sec_uid = 123; }, data => { data.aweme_detail.aweme_id = Number(VIDEO); },
    data => { data.aweme_detail.aweme_id = '7690702905876096105'; }, data => { data.aweme_detail.author.user_deleted = true; }]) {
    const data = body(); change(data); const f = fixture(page => { page.move(URL); page.respond({ data }); }); const result = await f.collect();
    assert.equal(result.status, 'unavailable'); assert.equal(result.candidate, undefined); assert.equal(result.evidence, undefined); closed(f);
  }
});
test('HTTP, body and navigation access barriers take precedence over candidate availability', async () => {
  for (const [status, errorCode] of [[401, 'login_required'], [403, 'blocked'], [429, 'rate_limited']]) {
    const f = fixture(page => { page.move(URL); page.respond({ status }); }); const result = await f.collect();
    assert.equal(result.errorCode, errorCode); assert.equal(result.candidate, undefined); assert.equal(f.page.reads, 0);
  }
  for (const [field, errorCode] of [['need_login', 'login_required'], ['captcha_required', 'challenge_required']]) {
    const f = fixture(page => { page.move(URL); page.respond({ data: { ...body(), [field]: true } }); }); const result = await f.collect();
    assert.equal(result.errorCode, errorCode); assert.equal(result.candidate, undefined);
  }
  for (const [url, errorCode] of [['https://www.douyin.com/login', 'login_required'], ['https://www.douyin.com/verify/', 'challenge_required'],
    ['https://evil.example/work', 'navigation_error']]) {
    const f = fixture(page => { page.move(url); page.respond(); }); const result = await f.collect();
    assert.equal(result.errorCode, errorCode); assert.equal(result.candidate, undefined); assert.equal(f.page.reads, 0);
  }
});
test('unattributed, iframe, post and redirected detail responses cannot become candidates', async () => {
  for (const scenario of [page => page.respond(), page => { page.move(URL); page.respond({ requestEvent: false }); },
    page => { page.move(URL); page.respond({ request: page.request({ frame: {} }) }); },
    page => { page.move(URL); page.respond({ request: page.request({ method: 'POST' }) }); },
    page => { page.move(URL); page.respond({ request: page.request({ redirect: page.request() }) }); }]) {
    const f = fixture(scenario), result = await f.collect(prepared(), { timeoutMs: 35 });
    assert.equal(result.status, 'unavailable'); assert.equal(result.candidate, undefined); assert.equal(f.page.reads, 0); closed(f);
  }
});
test('off-domain redirect chains and another official work are rejected before reading detail', async () => {
  for (const middle of ['https://evil.example/work', 'https://v.douyin.com/OtherToken/', 'https://www.douyin.com/video/7690702905876096105']) {
    const f = fixture(page => {
      const first = page.request({ url: SHARE, navigation: true }), second = page.request({ url: middle, navigation: true, redirect: first });
      const final = page.request({ url: URL, navigation: true, redirect: second }); page.emit('request', final); page.move(URL); page.respond();
    }); const result = await f.collect(); assert.equal(result.errorCode, 'navigation_error'); assert.equal(result.candidate, undefined); assert.equal(f.page.reads, 0); closed(f);
  }
});
test('parent candidate validator binds source/work/time/gates/hash and strips unrelated values', async () => {
  const input = prepared(), result = await fixture().collect(input), before = JSON.stringify(result);
  for (const mutate of [x => { delete x.source; }, x => { x.source.sourceRow = 336; }, x => { x.source.sourceRowSha256 = 'f'.repeat(64); },
    x => { x.scope = 'admitted'; }, x => { x.metricsSampled = true; }, x => { x.monitoringEnabled = true; },
    x => { x.submittedIdentityVerified = true; }, x => { x.submittedId = 'actual_author'; }, x => { x.admission = {}; },
    x => { x.videoId = '7690702905876096105'; }, x => { x.evidence.finalUrl = 'https://evil.example/work'; },
    x => { x.evidence.responseSha256 = '0'.repeat(64); }, x => { x.candidate.uniqueId = 'other'; },
    x => { x.evidence.response.aweme_detail.author.uid = Number(UID); }, x => { x.evidence.response.need_login = true; },
    x => { x.provenance.noChallengeBypass = false; }, x => { x.evidence.observedAt = '2099-01-01T00:00:00.000Z'; },
    x => { x.requestFinishedAt = new Date(Date.parse(x.requestStartedAt) + 45_001).toISOString(); }]) {
    const changed = structuredClone(result); mutate(changed); assert.throws(() => validateWorkAuthorCandidateResult(input, changed, bounds(result)));
  }
  const extra = structuredClone(result); extra.raw = 'PRIVATE'; extra.candidate.raw = 'PRIVATE'; extra.evidence.response.raw = 'PRIVATE'; extra.provenance.raw = 'PRIVATE';
  assert.doesNotMatch(JSON.stringify(validateWorkAuthorCandidateResult(input, extra, bounds(result))), /PRIVATE/);
  assert.equal(JSON.stringify(result), before);
});
test('cleanup refusal and cancellation discard candidate; late body completion cannot resurrect it', async () => {
  const cleanup = fixture(); cleanup.runtime.ownership.send = async kind => { if (kind === 'released') throw new Error('PRIVATE_CLEANUP'); };
  const stopped = await cleanup.collect(); assert.equal(stopped.errorCode, 'cleanup_uncertain'); assert.equal(stopped.candidate, undefined);
  const controller = new AbortController(), wait = deferred();
  const f = fixture(page => { page.move(URL); page.respond({ text: async () => { controller.abort(); return wait.promise; } }); });
  const pending = f.collect(prepared(), { signal: controller.signal }); const result = await pending;
  wait.resolve(JSON.stringify(body())); await Promise.resolve(); await Promise.resolve();
  assert.equal(result.errorCode, 'cancelled'); assert.equal(result.candidate, undefined); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/); closed(f);
});
test('candidate status, kind and hash scope cannot masquerade as strict admission; strict mismatch still drops public projection', async () => {
  const input = prepared(true), candidate = await fixture(page => page.respond()).collect(input);
  const strict = { key: input.key, videoId: VIDEO, submittedId: 'actual_author' };
  assert.throws(() => validateAuthorisedDetailResult(strict, candidate, bounds(candidate)), { code: 'invalid_evidence' });
  assert.throws(() => validateAuthorisedDetailResult(strict, { ...candidate, status: 'ok', submittedId: 'actual_author' }, bounds(candidate)), { code: 'invalid_evidence' });
  const f = fixture(page => page.respond());
  const mismatch = await collectAuthorisedDetail({ items: [{ ...strict, submittedId: 'wrong_id' }] }, { enabled: true, runtime: f.runtime });
  assert.equal(mismatch.errorCode, 'identity_mismatch'); assert.equal(mismatch.diagnostic.reason, 'submitted_id_mismatch');
  assert.equal(mismatch.candidate, undefined); assert.equal(mismatch.evidence, undefined);
});
