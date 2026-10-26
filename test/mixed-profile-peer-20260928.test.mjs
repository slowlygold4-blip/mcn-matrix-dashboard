import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyDouyinAliasContinuity } from '../lib/identity-continuity.mjs';
import { getSourceWorkIdentityRequest, verifySourceWorkIdentity } from '../lib/source-work-identity.mjs';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';
import { normalizeBrowserWorks } from '../scripts/douyin_browser_collector.mjs';

// Independent data: no production DB, browser, platform request or clock mutation.
const SEC = 'MS4wLjABAAAAmixedPeerCanonicalAccount123456789';
const OTHER = 'MS4wLjABAAAAmixedPeerDifferentAccount123456789';
const UID = '101115710975', ORIGINAL = 'peer_original', VIDEO = '7000000000000000123';
const PROFILE = 'https://www.douyin.com/aweme/v1/web/user/profile/other/';
const POST = 'https://www.douyin.com/aweme/v1/web/aweme/post/';
const DETAIL = 'https://www.douyin.com/aweme/v1/web/aweme/detail/';
const AT = '2026-09-28T12:00:00.000Z', REF = '2026-09-28T12:02:00.000Z';
const hash = raw => createHash('sha256').update(JSON.stringify(raw)).digest('hex');
const post = () => ({ aweme_id: '7000000000000000456', desc: 'fixture', create_time: 1700000000,
  author: { sec_uid: SEC, uid: UID }, statistics: { digg_count: 0 } });
const browserProvenance = () => ({ mode: 'douyin-authorised-browser-post-response', sessionLoaded: true,
  authorisedSessionUsed: true, authenticated: null, authenticationStatus: 'not-verified',
  paidAPI: false, runtimeAI: false, noChallengeBypass: true });
function profile({ at = AT, unique = 'peer_current', normal = false } = {}) {
  const mode = 'guest-ttwid-unsigned-profile';
  return { capturedAt: at, accountStatus: 'validated', accountError: null,
    profile: { user: { sec_uid: SEC, uid: UID, unique_id: unique, short_id: '0', nickname: '独立测试',
      follower_count: 0, total_favorited: 10, aweme_count: 2 } },
    worksCoverage: 'unavailable', worksError: null, worksErrorCode: normal ? 'blocked' : 'deferred',
    works: normal ? { aweme_list: [], stopReason: 'request-failed' }
      : { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } },
    provenance: { mode: normal ? `${mode}-a-bogus-posts` : mode, profileMode: mode, profileEndpoint: PROFILE,
      accountLocator: 'sec_uid', cookiePersisted: false, runtimeAI: false, paidAPI: false } };
}
function mixed(options = {}) {
  const raw = profile(options), complete = options.complete === true;
  raw.profile.user.aweme_count = complete ? 1 : 2;
  raw.worksCoverage = complete ? 'complete' : 'latest-public-window'; raw.worksErrorCode = null;
  raw.provenance.worksFallback = browserProvenance();
  raw.worksRequestPolicy = { version: 1, endpoint: 'douyin.author_posts', scope: 'endpoint-transport',
    anonymous: { transport: 'anonymous-http', attempted: false, deferred: true, errorCode: 'blocked' },
    browser: { transport: 'authorised-browser', attempted: true, deferred: false, errorCode: null } };
  raw.works = { aweme_list: [post()], has_more: !complete, max_cursor: 1700000000,
    public_window_limited: !complete, stopReason: complete ? 'browser-end-of-list' : 'browser-public-window',
    pagination: { evidenceScope: 'browser-response-sanitized', requestedLimit: 30, requestCount: 1, collectedCount: 1,
      pages: [{ endpoint: POST, response: { source: 'authorised-browser', has_more: !complete, max_cursor: 1700000000 } }] } };
  return raw;
}
function fixture({ mixedHistory = false, original = true } = {}) {
  const target = { id: 91, type: 'account', provider: 'public-web', enabled: true, locator: SEC,
    metadata: { platform: 'douyin', douyinId: ORIGINAL, evidenceVideoId: VIDEO,
      importSource: { type: 'author-spreadsheet', fileName: 'independent.xlsx', sheetName: 'roster', sourceRow: 12 } } };
  const old = (mixedHistory ? mixed : profile)({ at: '2026-09-27T12:00:00.000Z', unique: original ? ORIGINAL : 'unrelated', normal: !mixedHistory });
  const f = { target, stored: structuredClone(target), raw: mixed(), reads: 0,
    rows: [{ id: 11, target_id: target.id, captured_at: old.capturedAt, account_status: 'available', quality_status: 'warning',
      source_checksum: hash(old), raw_json: JSON.stringify(old) }] };
  f.database = { db: { prepare(sql) {
    assert.match(sql.trim(), /^SELECT/);
    if (/AS policy/.test(sql)) return { all: () => [] };
    if (/FROM snapshots/.test(sql)) return { all: () => structuredClone(f.rows) };
    return { get: () => { f.reads++; f.onRead?.(f.reads); return { ...structuredClone(f.stored),
      metadata_json: JSON.stringify(f.stored.metadata), identity_blocked: f.blocked ? 1 : 0 }; } };
  } } };
  return f;
}
const alias = f => verifyDouyinAliasContinuity(f.database, f.target, f.raw, { reference: REF });
const request = f => getSourceWorkIdentityRequest(f.database, f.target, f.raw);
function evidence() { return { capturedAt: '2026-09-28T12:01:00.000Z', requestedVideoId: VIDEO,
  provenance: { mode: 'guest-ttwid-a-bogus-video-detail', endpoint: DETAIL, cookiePersisted: false, runtimeAI: false, paidAPI: false },
  response: { status_code: 0, aweme_detail: { aweme_id: VIDEO, author: { uid: UID, sec_uid: SEC, unique_id: ORIGINAL } } } }; }
function source(f, e = evidence(), patch = {}) {
  const req = request(f);
  return verifySourceWorkIdentity(f.database, f.target, { ...f.raw, sourceIdentityEvidence: e }, {
    provider: 'public-web', operation: 'identity-work', requestedVideoId: VIDEO, requestedAccountId: SEC,
    sourceBindingChecksum: req?.sourceBindingChecksum, observedAt: REF, ...patch });
}

for (const complete of [false, true]) test(`mixed peer: legal mixed current complete=${complete} preserves profile identity without rewriting coverage`, () => {
  const f = fixture(); f.raw = mixed({ complete }); const before = JSON.stringify(f.raw);
  const result = alias(f); assert.ok(result); assert.equal(result.currentRawSha256, hash(f.raw));
  assert.equal(result.uid, UID); assert.equal(result.observedAt, AT); assert.equal(f.raw.profile.user.follower_count, 0);
  assert.equal(f.raw.worksCoverage, complete ? 'complete' : 'latest-public-window'); assert.equal(JSON.stringify(f.raw), before);
});

test('mixed peer: hashed mixed history can anchor a later normal or deferred same-account response', () => {
  for (const normal of [true, false]) {
    const f = fixture({ mixedHistory: true }); f.raw = profile({ normal });
    const result = alias(f); assert.ok(result); assert.equal(result.priorSnapshotId, 11);
  }
});

test('mixed peer: legacy authenticated label alone does not become new session proof or invalidate old bytes', () => {
  const f = fixture(); f.raw.provenance.worksFallback = { mode: 'douyin-authorised-browser-post-response',
    authenticated: true, paidAPI: false, runtimeAI: false, noChallengeBypass: true };
  assert.ok(alias(f)); assert.equal(f.raw.provenance.worksFallback.sessionLoaded, undefined);
  assert.equal(f.raw.provenance.worksFallback.authenticated, true);
});

test('mixed peer: source-work request still requires a fresh original work and current dual identity', () => {
  const f = fixture({ original: false }); assert.equal(alias(f), null);
  assert.equal(request(f)?.sourceVideoId, VIDEO); assert.ok(source(f));
  const stale = evidence(); stale.capturedAt = '2026-09-27T12:01:00.000Z'; assert.equal(source(f, stale), null);
  const wrong = evidence(); wrong.response.aweme_detail.author.uid = '101115710976'; assert.equal(source(f, wrong), null);
  assert.equal(verifySourceWorkIdentity(f.database, f.target, f.raw), null);
});

const shapeAttacks = [
  ['missing page evidence', r => { r.works.pagination.pages = []; }],
  ['wrong works endpoint', r => { r.works.pagination.pages[0].endpoint = 'https://example.com/posts'; }],
  ['wrong page source', r => { r.works.pagination.pages[0].response.source = 'manual'; }],
  ['contradictory page cursor', r => { r.works.pagination.pages[0].response.max_cursor++; }],
  ['contradictory has-more', r => { r.works.pagination.pages[0].response.has_more = false; }],
  ['missing request count', r => { delete r.works.pagination.requestCount; }],
  ['claimed collected count', r => { r.works.pagination.collectedCount = 5; }],
  ['bad limit', r => { r.works.pagination.requestedLimit = 101; }],
  ['profile endpoint', r => { r.provenance.profileEndpoint = POST; }],
  ['profile mode', r => { r.provenance.profileMode = 'manual'; }],
  ['wrong works author sec_uid', r => { r.works.aweme_list[0].author.sec_uid = OTHER; }],
  ['wrong works author uid', r => { r.works.aweme_list[0].author.uid = '101115710976'; }],
  ['duplicate works', r => { r.works.aweme_list.push(post()); r.works.pagination.collectedCount = 2; }],
  ['invented work ID', r => { r.works.aweme_list[0].aweme_id = 'garbage'; }],
  ['browser not attempted', r => { r.worksRequestPolicy.browser.attempted = false; }],
  ['browser failure', r => { r.worksRequestPolicy.browser.errorCode = 'blocked'; }],
  ['anonymous not deferred', r => { r.worksRequestPolicy.anonymous.deferred = false; }],
  ['policy scope', r => { r.worksRequestPolicy.scope = 'all-platform'; }],
  ['fallback mode', r => { r.provenance.worksFallback.mode = 'manual'; }],
  ['challenge bypass', r => { r.provenance.worksFallback.noChallengeBypass = false; }],
  ['failed profile', r => { r.accountStatus = 'unavailable'; }],
];
for (const [name, mutate] of shapeAttacks) test(`mixed peer: ${name} cannot gain profile acceptance`, () => {
  const f = fixture(); mutate(f.raw); assert.equal(alias(f), null); assert.equal(request(f), null);
});

test('mixed peer: incomplete or contradicted end-of-list cannot assert complete', () => {
  for (const mutate of [r => r.profile.user.aweme_count++, r => r.works.has_more = true,
    r => r.works.public_window_limited = true, r => r.works.stopReason = 'browser-public-window']) {
    const f = fixture(); f.raw = mixed({ complete: true }); mutate(f.raw); assert.equal(alias(f), null);
  }
});

test('mixed peer: corrupted historical hash, unknown original, changed identity and future time still fail closed', () => {
  for (const mutate of [f => f.rows[0].source_checksum = '0'.repeat(64),
    f => f.raw.profile.user.uid = '101115710976', f => f.raw.profile.user.sec_uid = OTHER,
    f => f.raw.capturedAt = '2026-09-29T00:00:00.000Z', f => f.raw.capturedAt = f.rows[0].captured_at]) {
    const f = fixture(); mutate(f); assert.equal(alias(f), null);
  }
  assert.equal(alias(fixture({ original: false })), null);
});

test('mixed peer: source binding and last-moment pause remain effective for both evidence paths', () => {
  const paused = fixture(); paused.stored.enabled = false; assert.equal(alias(paused), null); assert.equal(request(paused), null);
  const race = fixture(); race.onRead = n => { if (n === 2) race.stored.enabled = false; }; assert.equal(alias(race), null);
  const changed = fixture(); changed.stored.metadata.importSource.sourceRow++;
  assert.equal(request(changed), null); assert.equal(source(changed), null);
  const blocked = fixture(); blocked.blocked = true; assert.equal(request(blocked), null);
  assert.equal(source(fixture(), evidence(), { sourceBindingChecksum: '0'.repeat(64) }), null);
});

test('mixed peer: real provider merge retains accepted profile and only the verified public works window', async () => {
  const f = fixture(), calls = [];
  const provider = new PublicWebProvider({ publicPostsPerAccount: 30 }, { database: f.database, accountBrowserFallback: true,
    execFileImpl() { throw new Error('No subprocess allowed'); }, fetchImpl: async () => { throw new Error('No network allowed'); } });
  // Isolated policy fixture, never a production cooldown change.
  for (let i = 0; i < 3; i++) provider.worksRequestPolicy.record('anonymous-http', { targetKey: `fixture-${i}`, errorCode: 'blocked' });
  provider.run = async (operation, args) => { calls.push(operation); assert.equal(operation, 'account'); assert.ok(args.includes('deferred')); return profile(); };
  provider.runBrowserWorks = async input => { calls.push('browser-fixture'); assert.equal(input.secUid, SEC);
    return { items: [{ key: String(f.target.id), status: 'ok', worksCoverage: 'latest-public-window', posts: [post()], hasMore: true, maxCursor: 1700000000 }], provenance: browserProvenance() }; };
  const result = await provider.collect(f.target);
  assert.deepEqual(calls, ['account', 'browser-fixture']);
  assert.equal(result.snapshot.followers, 0); assert.equal(result.snapshot.totalLikes, 10); assert.equal(result.snapshot.totalPosts, 2);
  assert.equal(result.posts.length, 1); assert.equal(result.worksCoverage, 'limited');
  assert.ok(result.verifiedIdentity.aliasEvent); assert.equal(result.sourceChecksum, hash(result.raw));
  assert.equal(result.verifiedIdentity.aliasEvent.currentRawSha256, result.sourceChecksum);
});

test('mixed peer: real browser sanitizer missing work UID and cursor do not weaken the profile dual-ID requirement', () => {
  const upstream = post(); delete upstream.author.uid;
  const normalized = normalizeBrowserWorks({ status_code: 0, aweme_list: [upstream], has_more: 1 }, SEC, 30);
  assert.equal(normalized.posts[0].author.uid, ''); assert.equal(normalized.maxCursor, null);
  const f = fixture();
  f.raw.works.aweme_list = normalized.posts; f.raw.works.max_cursor = normalized.maxCursor;
  f.raw.works.pagination.pages[0].response.max_cursor = normalized.maxCursor;
  assert.ok(alias(f)); assert.ok(source(f));
  delete f.raw.profile.user.uid;
  assert.equal(alias(f), null); assert.equal(request(f), null);
});

test('mixed peer: current and legacy session forms cannot be combined into an invented login claim', () => {
  for (const change of [p => p.authenticated = true, p => p.sessionLoaded = false,
    p => p.authorisedSessionUsed = false, p => p.authenticationStatus = 'authenticated',
    p => delete p.sessionLoaded, p => delete p.authenticationStatus]) {
    const f = fixture(); change(f.raw.provenance.worksFallback); assert.equal(alias(f), null); assert.equal(request(f), null);
  }
  const f = fixture(); f.raw.provenance.worksFallback = { mode: 'douyin-authorised-browser-post-response',
    authenticated: false, paidAPI: false, runtimeAI: false, noChallengeBypass: true };
  assert.equal(alias(f), null);
});

test('mixed peer: both cursor copies must be null or nonnegative safe integers, not equal malformed values', () => {
  for (const cursor of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '1700000000', '9007199254740992999999999', '']) {
    const f = fixture(); f.raw.works.max_cursor = cursor;
    f.raw.works.pagination.pages[0].response.max_cursor = cursor;
    assert.equal(alias(f), null, `cursor ${String(cursor)}`); assert.equal(request(f), null);
  }
  for (const cursor of [0, Number.MAX_SAFE_INTEGER, null]) {
    const f = fixture(); f.raw.works.max_cursor = cursor;
    f.raw.works.pagination.pages[0].response.max_cursor = cursor; assert.ok(alias(f));
  }
});

test('mixed peer: explicit empty complete evidence is distinct from missing works evidence', () => {
  const f = fixture(); f.raw = mixed({ complete: true });
  f.raw.profile.user.aweme_count = 0; f.raw.works.aweme_list = []; f.raw.works.pagination.collectedCount = 0;
  assert.ok(alias(f)); assert.equal(f.raw.worksCoverage, 'complete');
  delete f.raw.works.aweme_list; assert.equal(alias(f), null);
});

test('mixed peer: second supported profile transport still rejects a contradictory supplied profile response', () => {
  const f = fixture(); f.raw.provenance.mode = f.raw.provenance.profileMode = 'guest-ttwid-unsigned-profile-with-x-bogus-fallback';
  assert.ok(alias(f));
  f.raw.profileResponse = { status_code: 0, user: structuredClone(f.raw.profile.user) };
  assert.ok(alias(f));
  f.raw.profileResponse.user.uid = '101115710976'; assert.equal(alias(f), null);
  f.raw.profileResponse.user.uid = UID; f.raw.profileResponse.need_login = true;
  assert.equal(alias(f), null);
});

test('mixed peer: old source-work identity event cannot replace a fresh current transport proof', () => {
  const f = fixture({ original: false }); f.target.metadata.identityVerification = {
    method: 'source-work', verifiedAt: '2026-09-27T12:00:00.000Z', uid: UID, secUid: SEC,
    sourceVideoId: VIDEO, sourceBindingChecksum: '0'.repeat(64) };
  f.stored = structuredClone(f.target);
  assert.equal(alias(f), null); assert.equal(verifySourceWorkIdentity(f.database, f.target, f.raw), null);
  const before = JSON.stringify(f.target); assert.ok(source(f)); assert.equal(JSON.stringify(f.target), before);
  const delayed = fixture(); delayed.raw.capturedAt = '2026-09-28T12:03:00.000Z';
  assert.equal(source(delayed), null);
});

test('mixed peer: source-work target read catches a pause after request selection and before verification', () => {
  const f = fixture({ original: false }); const req = request(f); const before = JSON.stringify(f.rows);
  f.stored.enabled = false;
  assert.equal(verifySourceWorkIdentity(f.database, f.target, { ...f.raw, sourceIdentityEvidence: evidence() }, {
    provider: 'public-web', operation: 'identity-work', requestedVideoId: VIDEO, requestedAccountId: SEC,
    sourceBindingChecksum: req.sourceBindingChecksum, observedAt: REF }), null);
  assert.equal(JSON.stringify(f.rows), before);
});
