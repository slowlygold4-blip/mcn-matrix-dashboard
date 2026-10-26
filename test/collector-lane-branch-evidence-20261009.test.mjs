import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';
import { safeOwnershipFailure } from '../lib/collector-ownership.mjs';
import { projectWorksOnlyFailure } from '../lib/works-only-failure.mjs';
import { validateWorksOnlyEvidence, recordWorksOnlyObservation } from '../lib/works-only-observation.mjs';
import { MonitorDatabase } from '../lib/database.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { checksum } from '../lib/utils.mjs';

const SEC = 'MS4wLjABAAAALaneBranchEvidenceFixture1234';
const AT = '2026-10-09T08:00:00.000Z', now = Date.parse(AT);
const evidence = () => ({ version: 1, kind: 'works-only-observation', source: 'authorised-browser', targetId: 42, runId: 8,
  anchorSnapshotId: 4, anchorChecksum: 'a'.repeat(64), requestedLimit: 30,
  identity: { secUid: SEC, uid: '12345678' }, requestStartedAt: AT, requestFinishedAt: AT,
  observedAt: null, status: 'unavailable', coverage: 'unavailable', errorCode: 'collector_error', posts: [], pagination: null });

test('lane branch evidence: old observations retain exact canonical hash and no invented branch', () => {
  for (const legacy of [evidence(), { ...evidence(), failureStage: 'collector-ownership', failureCode: 'BROWSER_PROTOCOL_INVALID' }]) {
    const before = JSON.stringify(legacy), hash = checksum(legacy);
    assert.equal(JSON.stringify(validateWorksOnlyEvidence(legacy, { now })), before);
    assert.equal(checksum(validateWorksOnlyEvidence(legacy, { now })), hash);
    assert.equal(Object.hasOwn(validateWorksOnlyEvidence(legacy, { now }), 'failureBranch'), false);
  }
});

test('lane branch evidence: provider failure retains allowlisted branch through safe executor wrappers', async () => {
  const p = new PublicWebProvider({}, { accountBrowserFallback: true, now: () => now,
    worksRequestPolicyOptions: { now: () => now }, fetchImpl: () => { throw new Error('NO_NETWORK'); },
    execFileImpl: (_file, _args, _options, done) => done(Object.assign(new Error('PRIVATE_SECRET'), {
      code: 'BROWSER_LANE_LOCKED', ownershipBranch: 'released-group-still-present', privatePid: 123, cookie: 'PRIVATE_SECRET',
    }), '', 'PRIVATE_SECRET') });
  const result = (await p.collectWorksOnly({ id: 42, type: 'account', enabled: true, provider: 'public-web', locator: SEC, metadata: {} },
    { snapshotId: 4, sourceChecksum: 'a'.repeat(64), capturedAt: AT, secUid: SEC, uid: '12345678' })).result;
  assert.equal(result.failureCode, 'BROWSER_LANE_LOCKED');
  assert.equal(result.failureStage, 'collector-ownership');
  assert.equal(result.failureBranch, 'released-group-still-present');
  assert.equal(result.status, 'unavailable');
  const sealed = { ...evidence(), ...projectWorksOnlyFailure(result) };
  const checked = validateWorksOnlyEvidence(sealed, { now });
  assert.deepEqual(checked, sealed); assert.equal(checksum(checked), checksum(sealed));
  assert.equal(checked.observedAt, null);
  assert.equal(JSON.stringify(checked).includes('PRIVATE_SECRET'), false);
  assert.equal(Object.hasOwn(checked, 'privatePid'), false);
});

test('lane branch evidence: private/unknown/incorrectly scoped branches cannot enter sealed records', () => {
  assert.equal(safeOwnershipFailure({ code: 'BROWSER_LANE_LOCKED', ownershipBranch: 'PRIVATE_SECRET' }).ownershipBranch, undefined);
  for (const input of [
    { failureBranch: 'released-group-still-present' },
    { failureCode: 'BROWSER_CLEANUP_UNCERTAIN', failureStage: 'browser-page', failureBranch: 'released-group-still-present' },
    { failureCode: 'BROWSER_CLEANUP_UNCERTAIN', failureStage: 'collector-ownership', failureBranch: 'PRIVATE_SECRET' },
    { failureCode: 'PRIVATE_SECRET', failureStage: 'collector-ownership', failureBranch: 'released-group-still-present' },
  ]) {
    assert.equal(Object.hasOwn(projectWorksOnlyFailure(input), 'failureBranch'), false);
    assert.throws(() => validateWorksOnlyEvidence({ ...evidence(), ...input }, { now }), { code: 'WORKS_OBSERVATION_INVALID' });
  }
});

test('lane branch evidence: diagnostic branch cannot turn unavailable into observed/complete data', () => {
  const sealed = { ...evidence(), failureStage: 'collector-ownership', failureCode: 'BROWSER_CLEANUP_UNCERTAIN', failureBranch: 'released-group-still-present' };
  for (const invalid of [{ observedAt: AT }, { coverage: 'complete' }, { status: 'accepted', errorCode: null }, { followers: 0 }])
    assert.throws(() => validateWorksOnlyEvidence({ ...sealed, ...invalid }, { now }), { code: 'WORKS_OBSERVATION_INVALID' });
});

test('lane branch evidence: real in-memory append persists branch without modifying profile history', t => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const target = database.createTarget({ type: 'account', provider: 'public-web', locator: SEC, label: 'offline branch fixture' });
  const raw = { capturedAt: AT, accountStatus: 'validated', accountError: null,
    profile: { user: { sec_uid: SEC, uid: '12345678', follower_count: 12, total_favorited: 33, aweme_count: 1 } },
    worksCoverage: 'unavailable', worksErrorCode: 'deferred', works: { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } },
    provenance: { mode: 'guest-ttwid-unsigned-profile', profileMode: 'guest-ttwid-unsigned-profile',
      profileEndpoint: 'https://www.douyin.com/aweme/v1/web/user/profile/other/', accountLocator: 'sec_uid', cookiePersisted: false, runtimeAI: false, paidAPI: false } };
  const profileRun = database.beginRun('scheduled', target.id, 1);
  database.saveCollection(target, profileRun, normalizeCollection(target, raw, { capturedAt: AT }));
  database.finishRun(profileRun, { status: 'success', successCount: 1, processedCount: 1 });
  const protectedRows = () => JSON.stringify(['targets', 'snapshots', 'audits'].map(table => database.db.prepare(`SELECT * FROM ${table}`).all()));
  const before = protectedRows(), runId = database.beginRun('works-only', target.id, 1);
  const input = { targetId: target.id, runId, anchorSnapshotId: database.db.prepare('SELECT id FROM snapshots').get().id,
    anchorChecksum: checksum(raw), requestStartedAt: AT, requestFinishedAt: AT, requestedLimit: 30,
    result: { status: 'unavailable', posts: [], errorCode: 'collector_error', failureStage: 'collector-ownership',
      failureCode: 'BROWSER_CLEANUP_UNCERTAIN', failureBranch: 'released-group-still-present' } };
  const saved = recordWorksOnlyObservation(database.db, input, { now });
  const row = database.db.prepare('SELECT * FROM works_observations WHERE id=?').get(saved.id);
  const sealed = JSON.parse(row.raw_json);
  assert.equal(sealed.failureBranch, 'released-group-still-present');
  assert.equal(checksum(validateWorksOnlyEvidence(sealed, { now })), row.source_checksum);
  assert.equal(saved.observedAt, null); assert.equal(saved.status, 'unavailable');
  assert.equal(protectedRows(), before);
  assert.equal(database.db.prepare('SELECT count(*) n FROM posts').get().n, 0);
  assert.equal(recordWorksOnlyObservation(database.db, input, { now }).duplicate, true);
});
