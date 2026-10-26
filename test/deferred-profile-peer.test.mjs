import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyDouyinAliasContinuity } from '../lib/identity-continuity.mjs';
import { getSourceWorkIdentityRequest, verifySourceWorkIdentity } from '../lib/source-work-identity.mjs';

// Deliberately independent fixtures: no production database, MonitorDatabase,
// network, cookies, browser, current clock replacement, or collector subprocess.
const SEC = 'MS4wLjABAAAApeerDeferredCanonicalAccount123';
const OTHER_SEC = 'MS4wLjABAAAApeerDeferredDifferentAccount123';
const UID = '222523170759696';
const ORIGINAL = 'Original_123';
const VIDEO = '7000000000000000001';
const PROFILE = 'https://www.douyin.com/aweme/v1/web/user/profile/other/';
const DETAIL = 'https://www.douyin.com/aweme/v1/web/aweme/detail/';
const AT = '2026-09-28T12:00:00.000Z';
const REFERENCE = new Date('2026-09-28T12:01:00.000Z');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function profile({ deferred = true, at = AT, unique = 'New_alias' } = {}) {
  const mode = 'guest-ttwid-unsigned-profile';
  return {
    capturedAt: at, accountStatus: 'validated', accountError: null,
    profile: { user: { sec_uid: SEC, uid: UID, unique_id: unique, short_id: '0',
      follower_count: 0, total_favorited: 200, aweme_count: 7 } },
    worksCoverage: 'unavailable', worksErrorCode: deferred ? 'deferred' : 'login_required',
    works: deferred ? { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } }
      : { aweme_list: [], stopReason: 'unavailable' },
    provenance: { mode: deferred ? mode : `${mode}-a-bogus-posts`, profileMode: mode,
      profileEndpoint: PROFILE, accountLocator: 'sec_uid', cookiePersisted: false,
      runtimeAI: false, paidAPI: false },
  };
}

function fixture({ historyDeferred = false, originalInHistory = true } = {}) {
  const target = { id: 7, type: 'account', provider: 'public-web', locator: SEC, enabled: true,
    metadata: { platform: 'douyin', douyinId: ORIGINAL, evidenceVideoId: VIDEO,
      resolution: { evidenceVideoId: VIDEO },
      importSource: { type: 'author-spreadsheet', fileName: 'peer-fixture.xlsx', sheetName: 'accounts', sourceRow: 2 } } };
  const old = profile({ deferred: historyDeferred, at: '2026-09-27T12:00:00.000Z', unique: originalInHistory ? ORIGINAL : 'Unrelated_display' });
  const row = { id: 1, target_id: target.id, captured_at: old.capturedAt, quality_status: 'warning',
    account_status: 'available', raw_json: JSON.stringify(old), source_checksum: hash(old) };
  const f = { target, stored: structuredClone(target), rows: [row], raw: profile(), reads: 0, beforeRead: null };
  f.database = { db: { prepare(sql) {
    assert.match(sql.trim(), /^SELECT\b/, 'identity verifier must be read-only');
    if (/FROM snapshots/.test(sql)) return { all: () => structuredClone(f.rows) };
    return { get: () => { f.reads++; f.beforeRead?.(f.reads); return f.stored
      ? { ...structuredClone(f.stored), metadata_json: JSON.stringify(f.stored.metadata), identity_blocked: f.identityBlocked ? 1 : 0 }
      : undefined; } };
  } } };
  return f;
}
const alias = f => verifyDouyinAliasContinuity(f.database, f.target, f.raw, { reference: REFERENCE });
function changeOld(f, mutate, recompute = true) {
  const raw = JSON.parse(f.rows[0].raw_json); mutate(raw);
  f.rows[0].raw_json = JSON.stringify(raw);
  if (recompute) f.rows[0].source_checksum = hash(raw);
}

for (const deferred of [false, true]) test(`peer: legitimate current profile deferred=${deferred} proves only identity, not works`, () => {
  const f = fixture(); f.raw = profile({ deferred }); const before = JSON.stringify({ target: f.target, stored: f.stored, rows: f.rows, raw: f.raw });
  const event = alias(f); assert.ok(event); assert.equal(event.currentRawSha256, hash(f.raw));
  assert.equal(event.mode, 'verified-snapshot-dual-id-continuity'); assert.equal(event.observedAt, AT);
  assert.equal(event.historicalSnapshotCount, 1); assert.equal(event.submittedAccountId, ORIGINAL);
  assert.equal(f.raw.worksCoverage, 'unavailable'); assert.equal(f.raw.profile.user.follower_count, 0);
  assert.equal(JSON.stringify({ target: f.target, stored: f.stored, rows: f.rows, raw: f.raw }), before);
});

test('peer: old envelope with no endpoint additions remains compatible; deferred history can anchor later identity', () => {
  const legacy = fixture(); changeOld(legacy, raw => { delete raw.provenance.profileMode; delete raw.provenance.profileEndpoint; });
  assert.ok(alias(legacy)); const deferred = fixture({ historyDeferred: true }); assert.ok(alias(deferred));
});

const provenanceAttacks = [
  ['different endpoint', p => { p.profileEndpoint = 'https://example.com/profile'; }],
  ['endpoint query', p => { p.profileEndpoint = PROFILE + '?untrusted=1'; }],
  ['endpoint missing on deferred', p => { delete p.profileEndpoint; }],
  ['profile mode missing on deferred', p => { delete p.profileMode; }],
  ['inconsistent profile mode', p => { p.profileMode = 'guest-ttwid-x-bogus-profile'; }],
  ['manual mode', p => { p.mode = 'manual'; }],
  ['cookie persistence', p => { p.cookiePersisted = true; }],
  ['AI provenance', p => { p.runtimeAI = true; }],
  ['paid provenance', p => { p.paidAPI = true; }],
  ['wrong platform', p => { p.platform = 'bilibili'; }],
];
for (const [label, mutate] of provenanceAttacks) test(`peer: deferred rejects ${label}`, () => {
  const f = fixture(); mutate(f.raw.provenance); assert.equal(alias(f), null);
  assert.equal(getSourceWorkIdentityRequest(f.database, f.target, f.raw), null);
});

test('peer: explicit wrong endpoint or profile mode cannot hide inside accepted legacy mode', () => {
  for (const mutate of [p => { p.profileEndpoint = 'https://example.com/'; }, p => { p.profileMode = 'manual'; }]) {
    const f = fixture(); f.raw = profile({ deferred: false }); mutate(f.raw.provenance);
    assert.equal(alias(f), null);
  }
});

test('peer: deferred marker is exact and contradictory works evidence cannot gain acceptance', () => {
  for (const mutate of [
    r => { r.worksErrorCode = 'login_required'; }, r => { r.worksCoverage = 'complete'; },
    r => { r.works.stopReason = 'public-window'; }, r => { r.works.pagination.requestCount = 1; },
    r => { r.works.pagination.pages = [{ endpoint: 'not-fetched' }]; },
    r => { r.works.aweme_list = []; }, r => { r.works.aweme_list = [{ aweme_id: VIDEO }]; },
    r => { r.accountStatus = 'available'; }, r => { r.accountError = 'invalid profile'; },
  ]) { const f = fixture(); mutate(f.raw); assert.equal(alias(f), null); }
});

test('peer: optional full profile response cannot contradict successful deferred profile', () => {
  const f = fixture();
  f.raw.profileResponse = { status_code: 0, user: structuredClone(f.raw.profile.user) };
  assert.ok(alias(f));
  for (const mutate of [
    r => { r.status_code = false; }, r => { r.status_code = '0'; }, r => { r.status_code = 8; },
    r => { r.user.uid = '222523170759697'; }, r => { r.user.sec_uid = OTHER_SEC; },
    r => { r.need_login = true; }, r => { r.captcha_required = true; },
    r => { r.user_info = structuredClone(r.user); }, r => { r.user.user_deleted = true; },
  ]) {
    const candidate = fixture(); const response = { status_code: 0, user: structuredClone(candidate.raw.profile.user) };
    mutate(response); candidate.raw.profileResponse = response;
    assert.equal(alias(candidate), null); assert.equal(getSourceWorkIdentityRequest(candidate.database, candidate.target, candidate.raw), null);
  }
});

test('peer: wrong stable identity and coerced numeric UID never prove an alias', () => {
  for (const patch of [{ sec_uid: OTHER_SEC }, { uid: '222523170759697' }, { uid: Number(UID) },
    { uid: '' }, { sec_uid: '' }, { user_deleted: true }, { unique_id: '' }]) {
    const f = fixture(); Object.assign(f.raw.profile.user, patch); assert.equal(alias(f), null);
  }
});

test('peer: raw error, manual wrapping and malformed profile response remain rejected', () => {
  for (const patch of [{ status_code: 8 }, { accountStatus: 'unavailable' }, { source: 'manual' },
    { roster: {} }, { snapshot: {} }, { profileResponse: { status_code: 8, user: {} } }]) {
    const f = fixture(); Object.assign(f.raw, patch); assert.equal(alias(f), null);
  }
});

test('peer: original ID is required in real prior profile, no primary flag or name inference', () => {
  const f = fixture({ originalInHistory: false }); f.target.metadata.accountIdMode = 'sec_uid-primary';
  f.stored.metadata = structuredClone(f.target.metadata); assert.equal(alias(f), null);
});

test('peer: exact historical raw/hash, raw time and every historical identity remain binding', () => {
  for (const mutate of [
    f => { f.rows[0].source_checksum = '0'.repeat(64); },
    f => changeOld(f, r => { r.profile.user.uid = '222523170759697'; }, false),
    f => changeOld(f, r => { r.profile.user.uid = '222523170759697'; }),
    f => { f.rows[0].captured_at = '2026-09-27T13:00:00.000Z'; },
    f => { f.rows[0].quality_status = 'rejected'; },
    f => { f.rows[0].account_status = 'unknown'; },
  ]) { const f = fixture(); mutate(f); assert.equal(alias(f), null); }
});

test('peer: future, equal-history timestamp, impossible day and non-UTC input fail closed', () => {
  for (const at of ['2026-09-29T12:00:00.000Z', '2026-09-27T12:00:00.000Z',
    '2026-02-30T12:00:00.000Z', '2026-09-28T12:00:00', '2026-09-28']) {
    const f = fixture(); f.raw.capturedAt = at; assert.equal(alias(f), null);
  }
});

test('peer: paused target, changed locator and pause at final read do not inherit identity', () => {
  for (const mutate of [f => { f.target.enabled = false; }, f => { f.stored.enabled = false; },
    f => { f.stored.locator = OTHER_SEC; }, f => { f.stored = null; },
    f => { f.beforeRead = n => { if (n === 2) f.stored.enabled = false; }; }]) {
    const f = fixture(); mutate(f); assert.equal(alias(f), null);
  }
});

function sourceFixture() {
  const f = fixture({ originalInHistory: false });
  f.evidence = { capturedAt: '2026-09-28T12:00:01.000Z', requestedVideoId: VIDEO,
    response: { status_code: 0, aweme_detail: { aweme_id: VIDEO,
      author: { sec_uid: SEC, uid: UID, short_id: ORIGINAL }, statistics: { digg_count: 9999999 } } },
    provenance: { mode: 'guest-ttwid-a-bogus-video-detail', endpoint: DETAIL,
      cookiePersisted: false, runtimeAI: false, paidAPI: false } };
  // A textual non-numeric ORIGINAL matches unique_id, never coercion of short_id.
  f.evidence.response.aweme_detail.author.unique_id = ORIGINAL;
  f.transport = { provider: 'public-web', operation: 'identity-work', requestedVideoId: VIDEO,
    requestedAccountId: SEC, sourceBindingChecksum: getSourceWorkIdentityRequest(f.database, f.target, f.raw)?.sourceBindingChecksum,
    observedAt: '2026-09-28T12:00:02.000Z' };
  return f;
}
const sourceVerify = f => verifySourceWorkIdentity(f.database, f.target,
  { ...f.raw, sourceIdentityEvidence: f.evidence }, f.transport);

test('peer: deferred source-work requires a new exact original-work proof, not alias guessing', () => {
  const f = sourceFixture(); assert.equal(alias(f), null); assert.ok(f.transport.sourceBindingChecksum);
  const event = sourceVerify(f); assert.ok(event); assert.equal(event.mode, 'official-source-work-profile-cross-check');
  assert.equal(event.currentRawSha256, hash({ ...f.raw, sourceIdentityEvidence: f.evidence }));
  assert.equal(event.sourceVideoId, VIDEO); assert.equal(event.sourceMatchField, 'unique_id');
  assert.equal(f.raw.profile.user.total_favorited, 200); assert.equal(f.raw.worksCoverage, 'unavailable');
});

test('peer: both actual unsigned deferred modes retain all identity checks', () => {
  const mode = 'guest-ttwid-unsigned-profile-with-x-bogus-fallback';
  const f = fixture(); f.raw.provenance.mode = mode; f.raw.provenance.profileMode = mode;
  assert.ok(alias(f));
  const source = sourceFixture(); source.raw.provenance.mode = mode; source.raw.provenance.profileMode = mode;
  assert.ok(sourceVerify(source));
  source.raw.profile.user.uid = '222523170759697'; assert.equal(sourceVerify(source), null);
});

test('peer: historical 610-like work receipt cannot substitute for this attempt or resurrect missing original ID', () => {
  const f = sourceFixture(); f.evidence.capturedAt = '2026-09-13T13:12:50.000Z'; assert.equal(sourceVerify(f), null);
  const injected = { ...f.raw, sourceIdentityEvidence: f.evidence };
  assert.equal(getSourceWorkIdentityRequest(f.database, f.target, injected), null);
  f.evidence.capturedAt = '2026-09-28T12:00:01.000Z';
  f.evidence.response.aweme_detail.author.unique_id = 'Not_original';
  f.evidence.response.aweme_detail.author.short_id = '0'; assert.equal(sourceVerify(f), null);
});

test('peer: source-work rejects changed video, either stable ID, endpoint, business result and future proof', () => {
  for (const mutate of [
    f => { f.evidence.response.aweme_detail.aweme_id = '7000000000000000002'; },
    f => { f.evidence.response.aweme_detail.author.sec_uid = OTHER_SEC; },
    f => { f.evidence.response.aweme_detail.author.uid = '222523170759697'; },
    f => { f.evidence.response.aweme_detail.author.uid = Number(UID); },
    f => { f.evidence.provenance.endpoint = 'https://example.com/'; },
    f => { f.evidence.response.status_code = 2483; },
    f => { f.evidence.response.status_code = '0'; },
    f => { f.evidence.capturedAt = '2026-09-29T12:00:01.000Z'; },
    f => { f.transport.sourceBindingChecksum = 'f'.repeat(64); },
    f => { f.transport.operation = 'account'; },
  ]) { const f = sourceFixture(); mutate(f); assert.equal(sourceVerify(f), null); }
});

test('peer: source-work rechecks pause, original row binding and pending identity conflict at return', () => {
  for (const mutate of [
    f => { f.stored.enabled = false; }, f => { f.stored.locator = OTHER_SEC; },
    f => { f.stored.metadata.importSource.sourceRow = 3; },
    f => { f.stored.metadata.evidenceVideoId = '7000000000000000002'; },
    f => { f.stored.metadata.douyinId = 'Changed_Original'; }, f => { f.identityBlocked = true; },
  ]) { const f = sourceFixture(); assert.ok(f.transport.sourceBindingChecksum); mutate(f); assert.equal(sourceVerify(f), null); }
});
