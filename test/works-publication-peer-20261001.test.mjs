import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { collectOne } from '../scripts/douyin_browser_collector.mjs';
import { classifyBrowserWorksFailure } from '../lib/douyin-browser-failure.mjs';
import { BrowserWorksPagination } from '../lib/browser-works-pagination.mjs';
import { validatedBrowserPagination } from '../lib/official-profile-evidence.mjs';
import { sanitizeBrowserWorksDiagnostics } from '../lib/douyin-browser-diagnostics.mjs';
import { MonitorDatabase } from '../lib/database.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { readWorksOnlyAnchor, recordWorksOnlyObservation } from '../lib/works-only-observation.mjs';
import { loadVerifiedWorksOnlyRows } from '../lib/works-observation.mjs';

const SEC = 'MS4wLjABAAAAWorksPublicationPeer567890', UID = '123456789';
const PROFILE = `https://www.douyin.com/user/${SEC}`;
const ENDPOINT = `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${SEC}&max_cursor=0`;
const ANCHOR = '2026-10-01T02:00:00.000Z', START = '2026-10-01T03:00:00.000Z', END = '2026-10-01T03:00:01.000Z';
const secret = 'WORKS_PEER_SECRET_DO_NOT_EXPORT';
const forbidden = () => { throw new Error(secret); };

class Page extends EventEmitter {
  constructor(mode) { super(); this.mode = mode; this.address = 'about:blank'; this.frame = { url: () => this.address };
    this.reads = 0; this.bodyReads = 0; this.wheels = 0; this.mouse = { move: forbidden, wheel: () => { this.wheels++; throw new Error(secret); } }; }
  mainFrame() { return this.frame; }
  url() { return this.address; }
  request(kind, url, navigation = false) { const r = { resourceType: () => kind, url: () => url,
    isNavigationRequest: () => navigation, frame: () => this.frame, method: () => 'GET', redirectedFrom: () => null,
    headers: forbidden, failure: forbidden, postData: forbidden }; this.emit('request', r); return r; }
  response(r, status) { this.emit('response', { request: () => r, url: r.url, status: () => status,
    json: () => { this.bodyReads++; throw new Error(secret); }, headers: forbidden, body: forbidden, text: forbidden }); }
  async goto() { const doc = this.request('document', PROFILE, true); this.address = PROFILE; this.response(doc, 200);
    this.emit('framenavigated', this.frame); this.emit('requestfinished', doc);
    const script = this.request('script', 'https://static.invalid/ordinary-script.js'); this.response(script, 200); this.emit('requestfinished', script);
    for (let i = 0; i < 13; i++) { const r = this.request('fetch', `https://public.invalid/fetch-${i}`); this.emit('requestfailed', r); }
    if (this.mode === 'bound403') this.response(this.request('xhr', ENDPOINT), 403);
    if (this.mode === 'foreign403') this.response(this.request('xhr', ENDPOINT.replace(SEC, `${SEC}Foreign`)), 403);
  }
  async evaluate() { this.reads++; return { observation: 'observed', readyState: 'loading', bodyPresent: false, scriptCount: 12 }; }
}

test('peer: successful main document/scripts and unknown fetch failures do not prove network failure or zero works', { timeout: 1000 }, async t => {
  const page = new Page('no-bound'); const r = await collectOne(page, { key: 'peer', secUid: SEC, limit: 30 }, { timeoutMs: 80, signal: t.signal });
  assert.equal(r.errorCode, 'collector_error'); assert.equal(r.worksCoverage, 'unavailable'); assert.deepEqual(r.posts, []);
  assert.equal(r.failureDiagnostics.stopReason, 'no-bound-request'); assert.equal(r.failureDiagnostics.requests.matched, 0);
  const resource = r.failureDiagnostics.resourceObservation;
  assert.equal(resource.documents.lastStatus, 200); assert.equal(resource.resources.script.finished, 1);
  assert.equal(resource.failuresByPhase.beforeStop.kinds.unknown, 13); assert.equal(resource.failuresByPhase.beforeStop.kinds.dns, 0);
  assert.equal(page.bodyReads, 0); assert.equal(page.wheels, 0);
  assert.doesNotMatch(JSON.stringify(r.failureDiagnostics), new RegExp(`${secret}|https?:|${SEC}`));
});

test('peer: precise author_posts 403 overrides document 200 and cannot trigger secret reads, scrolling or success', { timeout: 1000 }, async t => {
  const page = new Page('bound403'); const r = await collectOne(page, { key: 'peer', secUid: SEC, limit: 30 }, { timeoutMs: 80, signal: t.signal });
  assert.equal(r.errorCode, 'blocked'); assert.deepEqual(r.posts, []); assert.equal(r.worksCoverage, 'unavailable');
  assert.deepEqual(r.failureDiagnostics.httpStatuses, [403]); assert.equal(r.failureDiagnostics.requests.matched, 1);
  assert.equal(r.failureDiagnostics.resourceObservation.documents.lastStatus, 200);
  assert.equal(page.bodyReads, 0); assert.equal(page.wheels, 0);
});

test('peer: another author 403 is aggregate telemetry, never this author login or refusal evidence', { timeout: 1000 }, async t => {
  const page = new Page('foreign403'); const r = await collectOne(page, { key: 'peer', secUid: SEC, limit: 30 }, { timeoutMs: 80, signal: t.signal });
  assert.equal(r.errorCode, 'collector_error'); assert.deepEqual(r.failureDiagnostics.httpStatuses, []);
  assert.equal(r.failureDiagnostics.requests.rejected.accountIdentity, 1); assert.equal(r.failureDiagnostics.requests.matched, 0);
  assert.equal(r.failureDiagnostics.resourceObservation.resources.xhr.statusCounts[0].status, 403);
  assert.equal(page.bodyReads, 0); assert.deepEqual(r.posts, []);
});

test('peer: diagnostics cannot manufacture authentication, works, author identity or transport error detail', () => {
  const d = sanitizeBrowserWorksDiagnostics({ version: 1, stopReason: 'no-bound-request', requests: { matched: 0, candidate: 0 },
    navigation: { failed: false, timedOut: false }, worksCoverage: 'complete', posts: [{ aweme_id: '7200000000000000001' }],
    cookie: secret, errorText: secret, resourceObservation: { version: 1, documents: { lastStatus: 200, lastTarget: 'same-profile', secUid: SEC },
      resources: { script: { requested: 140, finished: 140, cookie: secret } } } });
  assert.equal(classifyBrowserWorksFailure({ failureDiagnostics: d }).errorCode, 'collector_error');
  assert.doesNotMatch(JSON.stringify(d), new RegExp(`${secret}|${SEC}|worksCoverage|aweme_id|errorText`));
  assert.deepEqual(sanitizeBrowserWorksDiagnostics(JSON.parse(JSON.stringify(d))), d);
});

const normalized = posts => ({ posts, maxCursor: 10, filteredCount: 0, duplicateCount: 0, locallyTruncated: false });
test('peer: missing terminator remains unknown; explicit has_more false is required for completion', () => {
  const post = { aweme_id: '7200000000000000001' };
  const incomplete = new BrowserWorksPagination(); incomplete.accept({ requestCursor: 0, body: { aweme_list: [post], max_cursor: 10 }, normalized: normalized([post]), observedAt: START });
  assert.equal(incomplete.result(1).pagination.stopReason, 'unknown-pagination'); assert.equal(incomplete.result(1).coverage, 'latest-public-window');
  const complete = new BrowserWorksPagination(); complete.accept({ requestCursor: 0, body: { aweme_list: [post], max_cursor: 10, has_more: false }, normalized: normalized([post]), observedAt: START });
  assert.equal(complete.result(1).pagination.stopReason, 'end-of-list'); assert.equal(complete.result(1).coverage, 'complete');
});

test('peer: repeated cursor and incomplete page counts cannot masquerade as complete history', () => {
  const post = { aweme_id: '7200000000000000001' }; const p = new BrowserWorksPagination();
  p.accept({ requestCursor: 0, body: { aweme_list: [post], has_more: true, max_cursor: 0 }, normalized: { ...normalized([post]), maxCursor: 0 }, observedAt: START });
  assert.equal(p.result(1).pagination.stopReason, 'cursor-not-progressing'); assert.equal(p.result(1).coverage, 'latest-public-window');
  const forged = p.result(1).pagination; forged.stopReason = 'end-of-list'; forged.pages[0].response.has_more = false;
  forged.pages[0].rawCount = 2;
  assert.equal(validatedBrowserPagination(forged, { limit: 30, posts: [post], hasMore: false, maxCursor: 0 }), null);
});

function unavailableFixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(ANCHOR) });
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const target = database.createTarget({ type: 'account', label: 'offline-only', provider: 'public-web', locator: SEC });
  const raw = { capturedAt: ANCHOR, accountStatus: 'validated', accountError: null,
    profile: { user: { sec_uid: SEC, uid: UID, follower_count: 12, total_favorited: 33, aweme_count: 2 } },
    worksCoverage: 'unavailable', worksErrorCode: 'deferred', works: { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } },
    provenance: { mode: 'guest-ttwid-unsigned-profile', profileMode: 'guest-ttwid-unsigned-profile',
      profileEndpoint: 'https://www.douyin.com/aweme/v1/web/user/profile/other/', accountLocator: 'sec_uid', cookiePersisted: false, runtimeAI: false, paidAPI: false } };
  database.saveCollection(target, null, normalizeCollection(target, raw, { capturedAt: ANCHOR }));
  t.mock.timers.setTime(Date.parse(START)); const anchor = readWorksOnlyAnchor(database.db, target.id);
  const runId = database.beginRun('works-only', target.id, 1);
  const input = { targetId: target.id, runId, anchorSnapshotId: anchor.snapshotId, anchorChecksum: anchor.sourceChecksum,
    requestStartedAt: START, requestFinishedAt: END, requestedLimit: 30,
    result: { status: 'unavailable', posts: [], errorCode: 'blocked', failureDiagnostics: {
      version: 1, stopReason: 'http-rejection', httpStatuses: [403], resourceObservation: { version: 1, documents: { lastStatus: 200 } } } } };
  t.mock.timers.setTime(Date.parse(END)); recordWorksOnlyObservation(database.db, input, { now: Date.parse(END) });
  database.finishRun(runId, { status: 'error', targetCount: 1, processedCount: 1, successCount: 0, errorCount: 1, details: [] });
  return { database, runId, target };
}

test('peer: a persisted refusal remains immutable unavailable and never refreshes profile or creates zero metrics', t => {
  const { database, runId } = unavailableFixture(t); const db = database.db;
  const rows = loadVerifiedWorksOnlyRows(db, END, null, { runId }); assert.equal(rows.length, 1);
  assert.equal(rows[0].coverage, 'unavailable'); assert.equal(rows[0].observed_at, null); assert.equal(rows[0].list_count, null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM snapshots').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, 0); assert.equal(db.prepare('SELECT COUNT(*) n FROM post_metrics').get().n, 0);
  assert.throws(() => db.exec("UPDATE works_observations SET coverage='limited'"), /immutable/);
});

test('peer: an anchor of another author cannot lend its successful profile evidence to the refusal', t => {
  const { database, runId } = unavailableFixture(t); database.db.prepare('UPDATE targets SET locator=?').run(`${SEC}Foreign`);
  assert.deepEqual(loadVerifiedWorksOnlyRows(database.db, END, null, { runId }), []);
});

test('peer: future completion and wrong run target are not admitted by history reader', async t => {
  for (const mode of ['future', 'other-target']) await t.test(mode, st => {
    const { database, runId } = unavailableFixture(st);
    if (mode === 'future') database.db.prepare('UPDATE runs SET finished_at=? WHERE id=?').run('2026-10-01T03:00:02.000Z', runId);
    else database.db.prepare('UPDATE runs SET target_id=NULL WHERE id=?').run(runId);
    assert.deepEqual(loadVerifiedWorksOnlyRows(database.db, END, null, { runId }), []);
  });
});
