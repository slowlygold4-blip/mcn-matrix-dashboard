import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { collectOne, collectBrowserWorks } from '../scripts/douyin_browser_collector.mjs';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';
import { sanitizeBrowserWorksDiagnostics } from '../lib/douyin-browser-diagnostics.mjs';
import { projectWorksOnlyFailure } from '../lib/works-only-failure.mjs';
import { validateWorksOnlyEvidence } from '../lib/works-only-observation.mjs';
import { MonitorDatabase } from '../lib/database.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { readWorksOnlyAnchor, recordWorksOnlyObservation } from '../lib/works-only-observation.mjs';
import { loadVerifiedWorksOnlyRows } from '../lib/works-observation.mjs';
import { checksum } from '../lib/utils.mjs';

const SEC = 'MS4wLjABAAAAResourceIndependentFixture56789', UID = '123456789';
const PROFILE = `https://www.douyin.com/user/${SEC}`;
const SECRET = 'INDEPENDENT_RESOURCE_SECRET_DO_NOT_EXPORT';
const AT = '2026-10-01T00:25:00.000Z';
const WORKS = `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${SEC}&max_cursor=0&signed=${SECRET}`;
const forbidden = () => { throw new Error(SECRET); };

class AttackPage extends EventEmitter {
  constructor(scenario) {
    super(); this.scenario = scenario; this.address = 'about:blank'; this.bodyReads = 0; this.domReads = 0;
    this.frame = { url: () => this.address }; this.pending = []; this.closed = false;
  }
  mainFrame() { return this.frame; }
  url() { return this.address; }
  request(kind, { url = PROFILE, navigation = false, frame = this.frame, previous = null } = {}) {
    return { resourceType: () => kind, url: () => url, isNavigationRequest: () => navigation,
      frame: () => frame, method: () => 'GET', redirectedFrom: () => previous,
      failure: forbidden, headers: forbidden, allHeaders: forbidden, postData: forbidden };
  }
  response(request, status, json = forbidden) {
    return { request: () => request, url: () => request.url(), status: () => status,
      json: async () => { this.bodyReads++; return json(); }, body: forbidden, text: forbidden, headers: forbidden };
  }
  emitRequest(request) { this.emit('request', request); return request; }
  document(status, url = PROFILE) {
    const request = this.emitRequest(this.request('document', { url, navigation: true }));
    this.address = url; this.emit('response', this.response(request, status)); this.emit('framenavigated', this.frame);
    return request;
  }
  async goto() { await this.scenario(this); }
  async evaluate() { this.domReads++; return { observation: 'observed', readyState: 'loading', bodyPresent: false }; }
  async close() {
    this.closed = true;
    for (const request of this.pending) this.emit('requestfailed', request);
    this.resolveBody?.({ status_code: 0, has_more: false, max_cursor: 0,
      aweme_list: [{ aweme_id: '7200000000000000091', author: { sec_uid: SEC, uid: UID }, statistics: { digg_count: 99 } }] });
    await Promise.resolve();
  }
}
const collect = (page, t, options = {}) => collectOne(page, { key: '42', secUid: SEC, limit: 30 },
  { timeoutMs: 500, failureGraceMs: 1, signal: t.signal, ...options });
function assertPrivate(value) {
  assert.doesNotMatch(JSON.stringify(value), new RegExp(`${SECRET}|${SEC}|https?:|errorText|cookie|headers`));
}
function clock(t) { t.mock.timers.enable({ apis: ['Date'], now: Date.parse(AT) }); }
function provider(item, id = 42, actualAnchor = null) {
  const p = new PublicWebProvider({}, { accountBrowserFallback: true, now: () => Date.parse(AT),
    worksRequestPolicyOptions: { now: () => Date.parse(AT) }, fetchImpl: forbidden,
    execFileImpl: (_file, _args, _options, callback) => callback(null,
      JSON.stringify({ ok: true, data: { items: [item] }, cookies: SECRET }), SECRET) });
  return p.collectWorksOnly({ id, type: 'account', provider: 'public-web', enabled: true, locator: SEC, metadata: {} },
    actualAnchor ?? { snapshotId: 4, sourceChecksum: 'a'.repeat(64), capturedAt: AT, secUid: SEC, uid: UID });
}

test('independent resource integration: synchronous HTTP refusal separates before/after stop and never reads secret methods', { timeout: 2000 }, async t => {
  clock(t);
  const page = new AttackPage(p => {
    const before = p.emitRequest(p.request('script', { url: `https://external.invalid/${SECRET}` }));
    p.emit('requestfailed', before);
    p.document(500);
    const after = p.emitRequest(p.request('font')); p.emit('requestfailed', after);
    p.emitRequest(p.request('image'));
  });
  const result = await collect(page, t), r = result.failureDiagnostics.resourceObservation;
  assert.equal(result.errorCode, 'network_error'); assert.deepEqual(result.posts, []);
  assert.equal(result.failureDiagnostics.stopReason, 'http-rejection');
  assert.equal(r.captureBoundary, 'attempt-return'); assert.equal(r.phase, 'closed');
  assert.equal(r.failuresByPhase.beforeStop.total, 1); assert.equal(r.failuresByPhase.afterStop.total, 1);
  assert.equal(r.failuresByPhase.cleanup.total, 0); assert.equal(r.resources.image.unresolvedAtClose, 1);
  assert.equal(r.trackedRequests, 0); assert.equal(page.bodyReads, 0); assert.equal(page.domReads, 0);
  assertPrivate(r); assert.equal(page.listenerCount('requestfailed'), 0);
  const before = JSON.stringify(result); page.emit('response', page.response(page.request('document'), 401));
  assert.equal(JSON.stringify(result), before, 'events after detachment cannot mutate the returned attempt');
});

test('independent resource integration: batch cleanup observes late terminal events but refuses late old body and old document status', { timeout: 3000 }, async t => {
  clock(t);
  const page = new AttackPage(async p => {
    const old = p.emitRequest(p.request('document', { navigation: true }));
    p.address = PROFILE; p.emit('framenavigated', p.frame);
    const work = p.emitRequest(p.request('fetch', { url: WORKS }));
    p.pending.push(work);
    p.emit('response', p.response(work, 200, () => new Promise(resolve => { p.resolveBody = resolve; })));
    await Promise.resolve(); await Promise.resolve();
    p.document(500);
    p.emit('response', p.response(old, 503));
  });
  let contexts = 0, browsers = 0;
  const batch = await collectBrowserWorks({ items: [{ key: '42', secUid: SEC, limit: 30 }] }, {
    executablePath: '/offline/no-real-browser', collectOptions: { timeoutMs: 500, failureGraceMs: 1, signal: t.signal },
    runtime: { readState: async () => ({ cookies: [], origins: [] }), access: async () => {},
      launch: async () => ({ newContext: async () => ({ newPage: async () => page, close: async () => { contexts++; } }), close: async () => { browsers++; } }) },
  });
  const result = batch.items[0], r = result.failureDiagnostics.resourceObservation;
  assert.equal(result.status, 'unavailable'); assert.equal(result.errorCode, 'network_error'); assert.deepEqual(result.posts, []);
  assert.equal(r.captureBoundary, 'page-close-return'); assert.equal(r.phase, 'closed');
  assert.equal(r.documents.lastStatus, 500); assert.equal(r.documents.lastRelation, 'new-document');
  assert.ok(r.resources.document.statusCounts.some(item => item.status === 500));
  assert.ok(r.resources.document.statusCounts.some(item => item.status === 503), 'late old response remains aggregate telemetry only');
  assert.equal(page.bodyReads, 1, 'the old bound body was actually pending before refusal');
  assert.equal(r.failuresByPhase.cleanup.total, 1); assert.equal(r.failuresByPhase.beforeStop.total, 0);
  assert.equal(r.resources.fetch.failed, 1); assert.equal(r.trackedRequests, 0);
  assert.equal(page.closed, true); assert.equal(contexts, 1); assert.equal(browsers, 1);
  assertPrivate(r); assert.equal(page.listenerCount('response'), 0);
  const fixed = JSON.stringify(result); await Promise.resolve(); await Promise.resolve();
  assert.equal(JSON.stringify(result), fixed, 'old response body cannot install posts after cleanup');
});

test('independent resource integration: JSON child envelope crosses real parent provider and canonical ledger projection without secrets', { timeout: 2000 }, async t => {
  clock(t);
  const page = new AttackPage(p => p.document(500));
  const child = await collect(page, t);
  child.failureDiagnostics.resourceObservation.secret = SECRET;
  child.failureDiagnostics.resourceObservation.documents.rawUrl = `${PROFILE}?secret=${SECRET}`;
  child.failureDiagnostics.resourceObservation.resources.document.headers = SECRET;
  const response = await provider(child), result = response.result;
  assert.equal(result.failureStage, 'browser-page'); assert.equal(result.errorCode, 'network_error'); assert.deepEqual(result.posts, []);
  const safe = sanitizeBrowserWorksDiagnostics(child.failureDiagnostics);
  assert.deepEqual(result.failureDiagnostics, safe); assertPrivate(result.failureDiagnostics);
  assert.deepEqual(projectWorksOnlyFailure(JSON.parse(JSON.stringify(result))), projectWorksOnlyFailure(result));
  const canonical = validateWorksOnlyEvidence({ version: 1, kind: 'works-only-observation', source: 'authorised-browser',
    targetId: 42, runId: 2109, anchorSnapshotId: 4, anchorChecksum: 'a'.repeat(64), requestedLimit: 30,
    identity: { secUid: SEC, uid: UID }, requestStartedAt: AT, requestFinishedAt: AT, observedAt: null,
    status: 'unavailable', coverage: 'unavailable', errorCode: result.errorCode, posts: [], pagination: null,
    ...projectWorksOnlyFailure(result) }, { now: Date.parse(AT) });
  assert.deepEqual(canonical.failureDiagnostics, safe); assert.equal(canonical.coverage, 'unavailable');
  assert.equal(checksum(canonical), checksum(validateWorksOnlyEvidence(JSON.parse(JSON.stringify(canonical)), { now: Date.parse(AT) })));
  assert.equal(canonical.posts.length, 0); assertPrivate(canonical.failureDiagnostics);
});

test('independent resource integration: foreign-profile document status remains telemetry and cannot authorize body reads or global login gate', { timeout: 2000 }, async t => {
  clock(t);
  const page = new AttackPage(p => {
    p.document(403, `${PROFILE}Foreign`);
    p.document(500);
  });
  const result = await collect(page, t), r = result.failureDiagnostics.resourceObservation;
  assert.equal(result.errorCode, 'network_error'); assert.deepEqual(result.failureDiagnostics.httpStatuses, [500]);
  assert.equal(r.documents.targets['other-profile'], 1); assert.equal(r.documents.targets['same-profile'], 1);
  assert.equal(result.failureDiagnostics.businessStatusCodes.length, 0); assert.equal(page.bodyReads, 0);
  const returned = await provider(result);
  assert.equal(returned.requestPolicy.browser.errorCode, 'network_error');
  assert.equal(returned.requestPolicy.browser.deferred, false);
  assertPrivate(returned.result.failureDiagnostics);
});

test('independent resource integration: saturation bounds strong tracked requests and parent status arrays, never upgrades works success', { timeout: 2000 }, async t => {
  clock(t);
  const page = new AttackPage(p => {
    for (let i = 0; i < 400; i++) p.emitRequest(p.request('image', { url: `https://external.invalid/${SECRET}/${i}` }));
    p.document(500);
  });
  const child = await collect(page, t), r = child.failureDiagnostics.resourceObservation;
  assert.equal(child.errorCode, 'network_error'); assert.deepEqual(child.posts, []);
  assert.equal(r.resources.image.requested, 256); assert.equal(r.resources.image.unresolvedAtClose, 256);
  assert.equal(r.discarded.capacity, 145); assert.equal(r.trackedRequests, 0);
  r.resources.image.statusCounts = Array.from({ length: 500 }, (_, i) => ({ status: 100 + i, count: 1, secret: SECRET }));
  r.resources.image.failed = SECRET; r.limits.maxRequests = 999999;
  r.documents.lastTarget = PROFILE; r.failuresByPhase.cleanup.kinds.unknown = -1;
  const parent = (await provider(child)).result.failureDiagnostics.resourceObservation;
  assert.equal(parent.resources.image.statusCounts.length, 32); assert.equal(parent.resources.image.failed, null);
  assert.equal(parent.limits.maxRequests, null); assert.equal(parent.documents.lastTarget, 'unknown');
  assert.equal(parent.failuresByPhase.cleanup.kinds.unknown, null); assertPrivate(parent);
  assert.deepEqual(sanitizeBrowserWorksDiagnostics({ version: 1, resourceObservation: parent }).resourceObservation, parent);
});

test('independent resource integration: hostile successful envelope with wrong author is still rejected despite same-profile telemetry', async () => {
  const diagnostics = sanitizeBrowserWorksDiagnostics({ version: 1, resourceObservation: { version: 1,
    documents: { lastTarget: 'same-profile', lastStatus: 200 } } });
  const response = await provider({ key: '42', status: 'ok', posts: [{ aweme_id: '7200000000000000092',
    author: { sec_uid: `${SEC}Foreign`, uid: UID }, statistics: { digg_count: 0 } }],
    failureDiagnostics: diagnostics, worksCoverage: 'complete', errorCode: null });
  assert.equal(response.result.status, 'unavailable'); assert.deepEqual(response.result.posts, []);
  assert.equal(response.result.errorCode, 'upstream_changed'); assert.equal(response.result.failureStage, 'provider-validation');
});

test('independent resource integration: immutable in-memory DB ledger retains safe resource failure without writing profile or works metrics', { timeout: 2000 }, async t => {
  clock(t);
  // This writer is deliberately :memory:, never the production database.
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const target = database.createTarget({ type: 'account', provider: 'public-web', locator: SEC, label: 'offline-independent-ledger' });
  const raw = { capturedAt: AT, accountStatus: 'validated', accountError: null,
    profile: { user: { sec_uid: SEC, uid: UID, follower_count: 12, total_favorited: 33, aweme_count: 2 } },
    worksCoverage: 'unavailable', worksErrorCode: 'deferred', works: { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } },
    provenance: { mode: 'guest-ttwid-unsigned-profile', profileMode: 'guest-ttwid-unsigned-profile',
      profileEndpoint: 'https://www.douyin.com/aweme/v1/web/user/profile/other/', accountLocator: 'sec_uid', cookiePersisted: false, runtimeAI: false, paidAPI: false } };
  database.saveCollection(target, null, normalizeCollection(target, raw, { capturedAt: AT }));
  const anchor = readWorksOnlyAnchor(database.db, target.id, { now: Date.parse(AT) });
  const page = new AttackPage(p => p.document(500)), child = await collect(page, t); child.key = String(target.id);
  const response = await provider(child, target.id, anchor);
  const before = Object.fromEntries(['targets', 'snapshots', 'audits', 'posts', 'post_metrics'].map(table => [table, database.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]));
  const runId = database.beginRun('works-only', target.id, 1);
  recordWorksOnlyObservation(database.db, { targetId: target.id, runId, anchorSnapshotId: anchor.snapshotId,
    anchorChecksum: anchor.sourceChecksum, requestedLimit: response.requestedLimit,
    requestStartedAt: response.requestStartedAt, requestFinishedAt: response.requestFinishedAt, result: response.result }, { now: Date.parse(AT) });
  database.db.prepare("UPDATE runs SET status='error',processed_count=1,error_count=1,finished_at=? WHERE id=?").run(AT, runId);
  const after = Object.fromEntries(Object.keys(before).map(table => [table, database.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]));
  assert.deepEqual(after, before);
  const stored = database.db.prepare('SELECT source_checksum,raw_json FROM works_observations WHERE run_id=?').get(runId);
  assert.equal(checksum(JSON.parse(stored.raw_json)), stored.source_checksum);
  const verified = loadVerifiedWorksOnlyRows(database.db, AT, null, { runIds: [runId] });
  assert.equal(verified.length, 1); assert.equal(verified[0].coverage, 'unavailable'); assert.equal(verified[0].raw.posts.length, 0);
  assert.deepEqual(verified[0].raw.failureDiagnostics, response.result.failureDiagnostics);
  assertPrivate(verified[0].raw.failureDiagnostics);
});

test('independent resource integration: real bounded page-close timeout is not mislabeled return or fabricated network failure', { timeout: 5000 }, async t => {
  clock(t);
  const page = new AttackPage(p => { p.emitRequest(p.request('image')); p.document(500); });
  page.close = () => new Promise(resolve => { page.resolveClose = resolve; });
  const batch = await collectBrowserWorks({ items: [{ key: '42', secUid: SEC, limit: 30 }] }, {
    executablePath: '/offline/no-real-browser', collectOptions: { timeoutMs: 500, signal: t.signal },
    runtime: { readState: async () => ({ cookies: [], origins: [] }), access: async () => {},
      launch: async () => ({ newContext: async () => ({ newPage: async () => page, close: async () => {} }), close: async () => {} }) },
  });
  const result = batch.items[0], r = result.failureDiagnostics.resourceObservation;
  assert.equal(result.errorCode, 'network_error'); assert.deepEqual(result.posts, []);
  assert.equal(r.captureBoundary, 'page-close-timeout'); assert.equal(r.phase, 'closed');
  assert.equal(r.resources.image.unresolvedAtClose, 1); assert.equal(r.resources.image.failed, 0);
  assert.equal(r.failuresByPhase.cleanup.total, 0); assert.equal(r.trackedRequests, 0);
  assertPrivate(r); assert.equal(page.listenerCount('requestfailed'), 0);
  const before = JSON.stringify(result); page.emit('requestfailed', page.request('image')); page.resolveClose();
  await Promise.resolve(); assert.equal(JSON.stringify(result), before);
  const parent = (await provider(result)).result.failureDiagnostics.resourceObservation;
  assert.equal(parent.captureBoundary, 'page-close-timeout'); assert.deepEqual(parent, r);
});
