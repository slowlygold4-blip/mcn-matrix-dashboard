import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { recordWorksOnlyObservation, readWorksOnlyAnchor } from '../lib/works-only-observation.mjs';
import { loadVerifiedWorksOnlyRows, readTrustedWorksResume } from '../lib/works-observation.mjs';

const ANCHOR = '2026-10-02T10:30:00.000Z', START = '2026-10-02T10:31:25.168Z';
const PAGE = '2026-10-02T10:31:49.622Z', END = '2026-10-02T10:31:53.455Z';
const SEC = 'MS4wLjABAAAAPhase117TimeoutAccount1234', UID = '12345678';
const CURSOR = 1784307235000;
const post = n => ({ aweme_id: String(7200000000000000000n + BigInt(n)),
  author: { sec_uid: SEC, uid: UID }, statistics: { digg_count: n } });

function setup(t, change = () => {}) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(ANCHOR) });
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const db = database.db;
  const target = database.createTarget({ type: 'account', provider: 'public-web', label: 'isolated', locator: SEC });
  const raw = { capturedAt: ANCHOR, accountStatus: 'validated', accountError: null,
    profile: { user: { sec_uid: SEC, uid: UID, follower_count: 10, total_favorited: 10, aweme_count: 87 } },
    worksCoverage: 'unavailable', worksErrorCode: 'deferred', works: { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } },
    provenance: { mode: 'guest-ttwid-unsigned-profile', profileMode: 'guest-ttwid-unsigned-profile',
      profileEndpoint: 'https://www.douyin.com/aweme/v1/web/user/profile/other/', accountLocator: 'sec_uid', cookiePersisted: false, runtimeAI: false, paidAPI: false } };
  database.saveCollection(target, null, normalizeCollection(target, raw, { capturedAt: ANCHOR }));
  t.mock.timers.setTime(Date.parse(START));
  const anchor = readWorksOnlyAnchor(db, target.id);
  const runId = database.beginRun('works-only', target.id, 1);
  const result = { status: 'ok', posts: Array.from({ length: 17 }, (_, i) => post(i + 1)), hasMore: true, maxCursor: CURSOR,
    errorCode: 'collector_error', pagination: { version: 1, maxPages: 3, requestCount: 1, collectedCount: 17,
      stopReason: 'page-timeout', errorCode: 'collector_error', pages: [{ requestCursor: 0, response: { max_cursor: CURSOR, has_more: true },
        rawCount: 17, acceptedCount: 17, filteredCount: 0, duplicateCount: 0, truncated: false, observedAt: PAGE }] },
    failureDiagnostics: { version: 1, navigation: { observed: true, committed: true, failed: false, timedOut: false },
      requests: { candidate: 1, matched: 1, rejected: { nonMainFrame: 0, frameUnavailable: 0, beforeCommit: 0, accountIdentity: 0, firstCursor: 0, method: 0, capacity: 0 } },
      responses: { matched: 1, invalidBodies: 0, bodyTimeouts: 0 },
      runtime: { pageErrorCount: null, pageErrorKinds: [], boundRequestFailedCount: 0, navigationErrorKind: 'none' },
      httpStatuses: [200], businessStatusCodes: [0], finalPageKind: 'profile', elapsedMs: 28287, stopReason: 'deadline' } };
  const input = { targetId: target.id, runId, anchorSnapshotId: anchor.snapshotId, anchorChecksum: anchor.sourceChecksum,
    requestStartedAt: START, requestFinishedAt: END, requestedLimit: 30, result };
  change(input, db, target);
  t.mock.timers.setTime(Date.parse(END));
  recordWorksOnlyObservation(db, input, { now: Date.parse(END) });
  database.finishRun(runId, { status: 'partial', processedCount: 1, successCount: 1, warningCount: 1 });
  return { db, database, target, anchor, runId, input,
    resume: (identity = anchor, asOf = END) => readTrustedWorksResume(db, target.id, identity, asOf) };
}

test('actual2908 shape: no further recorded bound request yields only its known cursor, not complete coverage', t => {
  const f = setup(t);
  const rows = loadVerifiedWorksOnlyRows(f.db, END, f.target.id);
  assert.equal(rows.length, 1); assert.equal(rows[0].coverage, 'limited');
  assert.deepEqual(f.resume(), { version: 1, observationId: rows[0].observation_id, runId: f.runId,
    sourceChecksum: rows[0].source_checksum, cursor: CURSOR, depth: 1 });
  assert.equal(rows[0].raw.pagination.stopReason, 'page-timeout');
  assert.equal(rows[0].raw.errorCode, 'collector_error');
});

for (const [name, change] of [
  ['actual2800 rejected first cursor', x => { x.result.failureDiagnostics.requests.candidate = 2; x.result.failureDiagnostics.requests.rejected.firstCursor = 1; }],
  ['missing diagnostics', x => { delete x.result.failureDiagnostics; }],
  ['collector ownership failure', x => { x.result.failureCode = 'BROWSER_CLEANUP_UNCERTAIN'; }],
  ['provider validation failure', x => { x.result.failureStage = 'provider-validation'; }],
  ['unknown HTTP evidence', x => { x.result.failureDiagnostics.httpStatuses = []; }],
  ['unknown business evidence', x => { x.result.failureDiagnostics.businessStatusCodes = []; }],
  ['cleanup still uncertain', x => { x.result.failureDiagnostics.resourceObservation = { version: 1, captureBoundary: 'page-close-timeout', phase: 'closed' }; }],
  ['CDP explicit author endpoint failure', x => { x.result.failureDiagnostics.cdpObservation = {
    version: 1, captureBoundary: 'page-close-return', phase: 'closed', state: 'closed',
    failuresByPhase: Object.fromEntries(['beforeStop', 'afterStop', 'cleanup'].map(phase => [phase, {
      authorPosts: { 'current-document': phase === 'beforeStop' ? 1 : 0, 'prior-document': 0, unbound: 0 },
      authorPostsEndpoint: { 'current-document': 0, 'prior-document': 0, unbound: 0 } }])) }; }],
  ['request dispatched but no response', x => { x.result.pagination.requestCount = 2; x.result.failureDiagnostics.requests.candidate = 2; x.result.failureDiagnostics.requests.matched = 2; }],
  ['unbound account candidate', x => { x.result.failureDiagnostics.requests.rejected.accountIdentity = 1; }],
  ['body timeout', x => { x.result.failureDiagnostics.responses.bodyTimeouts = 1; }],
  ['invalid body', x => { x.result.failureDiagnostics.responses.invalidBodies = 1; }],
  ['bound request failure', x => { x.result.failureDiagnostics.runtime.boundRequestFailedCount = 1; }],
  ['HTTP403', x => { x.result.failureDiagnostics.httpStatuses = [200, 403]; }],
  ['business2483', x => { x.result.failureDiagnostics.businessStatusCodes = [0, 2483]; }],
  ['login final page', x => { x.result.failureDiagnostics.finalPageKind = 'login'; }],
  ['failed navigation', x => { x.result.failureDiagnostics.navigation.failed = true; }],
  ['network error', x => { x.result.errorCode = x.result.pagination.errorCode = 'network_error'; }],
  ['http rejection', x => { x.result.pagination.stopReason = 'http-rejection'; }],
  ['filtered row', x => { const p = x.result.pagination.pages[0]; p.rawCount++; p.filteredCount++; }],
  ['pinned duplicate', x => { const p = x.result.pagination.pages[0]; p.rawCount++; p.duplicateCount++; }],
  ['truncated deleted inventory', x => { const p = x.result.pagination.pages[0]; p.rawCount++; p.truncated = true; }],
  ['non-progress cursor', x => { x.result.pagination.pages[0].response.max_cursor = x.result.maxCursor = 0; }],
  ['terminal end', x => { x.result.pagination.pages[0].response.has_more = x.result.hasMore = false; }],
]) test(`no timeout resume: ${name}`, t => {
  const f = setup(t, change); assert.equal(f.resume(), null);
});

test('timeout checkpoint cannot borrow another stable UID or outlive seven days', t => {
  const f = setup(t);
  assert.equal(f.resume({ ...f.anchor, uid: '99999999' }), null);
  assert.equal(f.resume(f.anchor, '2026-10-09T10:31:53.456Z'), null);
});

for (const [name, status, observation] of [['HTTP403', 'error', 'blocked'], ['cancelled', 'interrupted', 'collector_error'],
  ['failed before observation commit', 'error', null], ['unproven success run', 'partial', null]]) {
  test(`timeout exception never skips subsequent ${name}`, t => {
    const f = setup(t);
    t.mock.timers.setTime(Date.parse(END) + 1000);
    const later = f.database.beginRun('works-only', f.target.id, 1);
    if (observation) recordWorksOnlyObservation(f.db, { ...f.input, runId: later,
      requestStartedAt: new Date().toISOString(), requestFinishedAt: new Date().toISOString(),
      result: { status: 'unavailable', posts: [], errorCode: observation } }, { now: Date.now() });
    f.database.finishRun(later, { status, processedCount: 1, errorCount: 1 });
    assert.equal(f.resume(f.anchor, new Date().toISOString()), null);
  });
}

test('timeout cursor can be re-bound in a future ordinary run with a new page, preserving all old samples and limited coverage', t => {
  const f = setup(t), continuation = f.resume();
  assert.equal(continuation?.cursor, CURSOR);
  const original = JSON.stringify(f.db.prepare('SELECT * FROM works_observations ORDER BY id').all());
  const profiles = JSON.stringify(['targets', 'snapshots', 'audits'].map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()));
  t.mock.timers.setTime(Date.parse(END) + 1000);
  const runId = f.database.beginRun('works-only', f.target.id, 1), started = new Date().toISOString();
  t.mock.timers.setTime(Date.now() + 20); const observedAt = new Date().toISOString();
  const result = { status: 'ok', posts: [post(18)], hasMore: false, maxCursor: 0, errorCode: null,
    pagination: { version: 3, baseVersion: 1, startCursor: CURSOR, maxPages: 3, requestCount: 1, collectedCount: 1,
      stopReason: 'end-of-list', errorCode: null, pages: [{ requestCursor: CURSOR, response: { max_cursor: 0, has_more: false },
        rawCount: 1, acceptedCount: 1, filteredCount: 0, duplicateCount: 0, truncated: false, observedAt }] } };
  t.mock.timers.setTime(Date.now() + 20);
  const written = recordWorksOnlyObservation(f.db, { targetId: f.target.id, runId, anchorSnapshotId: f.anchor.snapshotId,
    anchorChecksum: f.anchor.sourceChecksum, requestStartedAt: started, requestFinishedAt: new Date().toISOString(),
    requestedLimit: 30, continuation, result });
  f.database.finishRun(runId, { status: 'partial', processedCount: 1, successCount: 1, warningCount: 1 });
  assert.equal(written.coverage, 'limited');
  const rows = loadVerifiedWorksOnlyRows(f.db, new Date().toISOString(), f.target.id);
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.coverage === 'limited'));
  assert.equal(f.db.prepare('SELECT count(*) n FROM post_metrics').get().n, 18);
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM works_observations ORDER BY id LIMIT 1').all()), original);
  assert.equal(JSON.stringify(['targets', 'snapshots', 'audits'].map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all())), profiles);
  assert.equal(f.resume(f.anchor, new Date().toISOString()), null, 'end-of-list continuation is not a further checkpoint or complete archive');
});

for (const [name, change] of [
  ['other author', x => { x.result.posts[0].author.sec_uid += 'x'; }],
  ['future page', x => { x.result.pagination.pages[0].observedAt = '2026-10-02T10:31:54.000Z'; }],
  ['unsafe count', x => { x.result.posts[0].statistics.digg_count = Number.MAX_SAFE_INTEGER + 1; }],
  ['missing row count', x => { x.result.pagination.pages[0].acceptedCount--; }],
]) test(`unchanged append guard: ${name}`, t => {
  assert.throws(() => setup(t, change), { code: 'WORKS_OBSERVATION_INVALID' });
});
