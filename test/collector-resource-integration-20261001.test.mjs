import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { collectOne, collectBrowserWorks } from '../scripts/douyin_browser_collector.mjs';
import { sanitizeBrowserWorksDiagnostics } from '../lib/douyin-browser-diagnostics.mjs';
import { createBrowserResourceObservation } from '../lib/browser-resource-observation.mjs';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';
import { projectWorksOnlyFailure } from '../lib/works-only-failure.mjs';
import { checksum } from '../lib/utils.mjs';

const secUid = 'MS4wLjABAAAAIntegrationPassiveResources12345';
const profile = `https://www.douyin.com/user/${secUid}`;
const SECRET = 'SIGNED_URL_CREDENTIAL_BODY_PRIVATE_123';
const item = { key: 'fixture', secUid, limit: 30 };
class Page extends EventEmitter {
  constructor(script) { super(); this.script = script; this.current = profile; this.navigationCount = 0; this.pendingScripts = []; }
  mainFrame() { return this; }
  url() { return this.current; }
  request(kind, url = `https://fixture.invalid/${SECRET}`, previous = null) {
    return { resourceType: () => kind, url: () => url, redirectedFrom: () => previous,
      isNavigationRequest: () => kind === 'document', frame: () => this,
      method: () => 'GET', failure() { throw new Error(`forbidden ${SECRET}`); },
      headers() { throw new Error(`forbidden ${SECRET}`); } };
  }
  response(request, status) { return { request: () => request, status: () => status, url: () => request.url(),
    json() { throw new Error(`forbidden ${SECRET}`); }, body() { throw new Error(`forbidden ${SECRET}`); } }; }
  document(status = 200, url = profile, previous = null) {
    const r = this.request('document', url, previous); this.emit('request', r);
    this.emit('response', this.response(r, status)); this.current = url; this.emit('framenavigated', this);
    this.emit('requestfinished', r); return r;
  }
  async goto() { this.navigationCount++; await this.script?.(this); }
  async close() { for (const r of this.pendingScripts) this.emit('requestfailed', r); this.pendingScripts = []; this.emit('close'); }
}
const run = page => collectOne(page, item, { timeoutMs: 25, failureGraceMs: 1 });
const safe = value => {
  const text = JSON.stringify(value);
  for (const raw of [SECRET, secUid, profile, 'https:', 'errorText', 'headers']) assert.equal(text.includes(raw), false, raw);
};

test('collector records unrelated script transport/HTTP evidence without reading failures/bodies or accepting works', async () => {
  const page = new Page(p => {
    p.document(); const a = p.request('script'), b = p.request('stylesheet');
    p.emit('request', a); p.emit('response', p.response(a, 503)); p.emit('requestfailed', a);
    p.emit('request', b); p.pendingScripts.push(b);
  });
  const result = await run(page), r = result.failureDiagnostics.resourceObservation;
  assert.equal(result.status, 'unavailable'); assert.deepEqual(result.posts, []);
  assert.equal(result.failureDiagnostics.stopReason, 'no-bound-request');
  assert.equal(result.failureDiagnostics.runtime.boundRequestFailedCount, 0);
  assert.equal(r.resources.script.failed, 1);
  assert.deepEqual(r.resources.script.statusCounts, [{ status: 503, count: 1 }]);
  assert.equal(r.failuresByPhase.beforeStop.kinds.unknown, 1);
  assert.equal(r.resources.stylesheet.unresolvedAtClose, 1);
  assert.equal(r.phase, 'closed'); assert.equal(r.captureBoundary, 'attempt-return');
  assert.equal(page.navigationCount, 1); safe(r);
  const frozen = JSON.stringify(result); await page.close(); assert.equal(JSON.stringify(result), frozen);
  for (const event of ['request', 'response', 'requestfailed', 'requestfinished', 'framenavigated']) assert.equal(page.listenerCount(event), 0);
});

test('normal collector page-close failures occur only in cleanup, round trip remains bounded/idempotent', async () => {
  const page = new Page(p => { p.document(); const r = p.request('script'); p.emit('request', r); p.pendingScripts.push(r); });
  let browserCloses = 0, contextCloses = 0;
  const result = await collectBrowserWorks({ items: [item] }, { collectOptions: { timeoutMs: 25 }, runtime: {
    readState: async () => ({ cookies: [] }), access: async () => {},
    launch: async () => ({ newContext: async () => ({ newPage: async () => page,
      close: async () => { contextCloses++; } }), close: async () => { browserCloses++; } }),
  } });
  const original = result.items[0], r = original.failureDiagnostics.resourceObservation;
  assert.equal(r.captureBoundary, 'page-close-return'); assert.equal(r.phase, 'closed');
  assert.equal(r.resources.script.failed, 1); assert.equal(r.resources.script.unresolvedAtClose, 0);
  assert.equal(r.failuresByPhase.beforeStop.total, 0); assert.equal(r.failuresByPhase.cleanup.total, 1);
  assert.equal(original.status, 'unavailable'); assert.deepEqual(original.posts, []);
  assert.equal(browserCloses, 1); assert.equal(contextCloses, 1); assert.equal(page.navigationCount, 1);
  const parent = sanitizeBrowserWorksDiagnostics(JSON.parse(JSON.stringify(original.failureDiagnostics)));
  assert.deepEqual(parent, original.failureDiagnostics); safe(parent.resourceObservation);
  assert.equal(page.listenerCount('requestfailed'), 0);
});

test('linked redirect and true same-document change are not mixed, target classification does not authorize works', async () => {
  const page = new Page(p => {
    const first = p.request('document', profile); p.emit('request', first); p.emit('response', p.response(first, 302)); p.emit('requestfinished', first);
    p.document(200, `${profile}/?tracking=${SECRET}`, first);
    p.current = `${profile}/?tracking=ordinary`; p.emit('framenavigated', p);
    p.document(200, 'https://www.douyin.com/user/foreign');
  });
  const result = await run(page), r = result.failureDiagnostics.resourceObservation;
  assert.equal(r.documents.relations['linked-http-redirect'], 1);
  assert.equal(r.documents.relations['same-document'], 1);
  assert.equal(r.documents.relations['new-document'], 1);
  assert.equal(r.documents.lastTarget, 'other-profile');
  assert.equal(result.status, 'unavailable'); assert.equal(result.failureDiagnostics.requests.matched, 0); safe(r);
});

test('child and parent sanitizer reject secrets/unknown fields, cap arrays/counts and preserve unknown not zero', () => {
  const o = createBrowserResourceObservation({ secUid }), r = o.close();
  r.captureBoundary = 'page-close-return'; r.secret = SECRET; r.resources.script.url = profile;
  r.resources.script.failed = SECRET; r.documents.lastTarget = profile;
  r.resources.script.statusCounts = Array.from({ length: 100 }, (_, i) => ({ status: 100 + i, count: 1, secret: SECRET }));
  r.failuresByPhase.cleanup.kinds.unknown = 1_000_001;
  const child = sanitizeBrowserWorksDiagnostics({ version: 1, resourceObservation: r });
  assert.equal(child.resourceObservation.resources.script.failed, null);
  assert.equal(child.resourceObservation.documents.lastTarget, 'unknown');
  assert.equal(child.resourceObservation.failuresByPhase.cleanup.kinds.unknown, null);
  assert.equal(child.resourceObservation.resources.script.statusCounts.length, 32);
  assert.deepEqual(sanitizeBrowserWorksDiagnostics(JSON.parse(JSON.stringify(child))), child); safe(child.resourceObservation);
  assert.equal(sanitizeBrowserWorksDiagnostics({ version: 1, resourceObservation: { version: 2 } }).resourceObservation, undefined);
  assert.equal(sanitizeBrowserWorksDiagnostics({ version: 1 }).resourceObservation, undefined);
});

test('document refusal retains existing error/gates while a subsequent resource failure is afterStop', async () => {
  const page = new Page(p => {
    p.document(500); const script = p.request('script'); p.emit('request', script); p.emit('requestfailed', script);
  });
  const result = await run(page), r = result.failureDiagnostics.resourceObservation;
  assert.equal(result.errorCode, 'network_error'); assert.equal(result.failureDiagnostics.stopReason, 'http-rejection');
  assert.deepEqual(result.failureDiagnostics.httpStatuses, [500]); assert.equal(r.documents.lastStatus, 500);
  assert.equal(r.failuresByPhase.beforeStop.total, 0); assert.equal(r.failuresByPhase.afterStop.total, 1);
  assert.equal(r.failuresByPhase.cleanup.total, 0); assert.equal(result.worksCoverage, 'unavailable');
  assert.deepEqual(result.posts, []); assert.equal(page.navigationCount, 1); safe(r);
});

test('normal collector resource cap drops observations without evicting or changing works rules', async () => {
  const page = new Page(p => {
    p.document();
    for (let i = 0; i < 400; i++) { const r = p.request('script'); p.emit('request', r); p.pendingScripts.push(r); }
  });
  const result = await run(page), r = result.failureDiagnostics.resourceObservation;
  assert.equal(r.resources.script.requested, 256); assert.equal(r.discarded.capacity, 144);
  assert.equal(r.resources.script.unresolvedAtClose, 256); assert.equal(r.trackedRequests, 0);
  assert.equal(result.failureDiagnostics.requests.matched, 0);
  assert.equal(result.failureDiagnostics.stopReason, 'no-bound-request'); assert.deepEqual(result.posts, []);
});

test('actual parent provider and works-only projection keep child resource evidence but remove injected secrets', async () => {
  const page = new Page(p => { p.document(); const r = p.request('script'); p.emit('request', r); p.emit('requestfailed', r); });
  const child = await run(page);
  const incoming = JSON.parse(JSON.stringify(child));
  incoming.failureDiagnostics.resourceObservation.headers = { authorization: SECRET };
  incoming.failureDiagnostics.resourceObservation.resources.script.rawError = SECRET;
  const raw = { capturedAt: '2026-10-01T00:19:53.000Z', profile: { user: { sec_uid: secUid,
    nickname: '离线测试', follower_count: 10, total_favorited: 20, aweme_count: 2 } },
    worksCoverage: 'unavailable', worksErrorCode: 'blocked', works: { aweme_list: [] }, warnings: [] };
  let calls = 0;
  const provider = new PublicWebProvider({ publicPostsPerAccount: 30 }, { accountBrowserFallback: true,
    execFileImpl(file, _args, _options, callback) {
      const browser = file === process.execPath; if (browser) calls++;
      callback(null, JSON.stringify({ ok: true, data: browser ? { items: [incoming] } : raw }), '');
    } });
  const result = await provider.collect({ id: 1, type: 'account', label: '离线资源测试', locator: secUid, metadata: {} });
  assert.equal(calls, 1); assert.equal(result.worksCoverage, 'unavailable'); assert.deepEqual(result.posts, []);
  assert.equal(result.snapshot.followers, 10); assert.equal(result.snapshot.totalLikes, 20); assert.equal(result.snapshot.totalPosts, 2);
  assert.deepEqual(result.raw.worksFallbackDiagnostics, child.failureDiagnostics);
  assert.equal(result.sourceChecksum, checksum(result.raw)); safe(result.raw.worksFallbackDiagnostics.resourceObservation);
  const failure = projectWorksOnlyFailure({ failureStage: 'browser-page', failureDiagnostics: incoming.failureDiagnostics });
  assert.deepEqual(failure.failureDiagnostics, child.failureDiagnostics); assert.equal(failure.failureStage, 'browser-page');
});

test('a terminal accepted page marks stop before unrelated later resource failures', async () => {
  const page = new Page(async p => {
    p.document(); const script = p.request('script'); p.emit('request', script);
    const works = p.request('xhr', `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${secUid}&max_cursor=0`);
    p.emit('request', works); p.emit('response', { ...p.response(works, 200),
      json: async () => ({ status_code: 0, aweme_list: [], has_more: 0 }) });
    await new Promise(resolve => setImmediate(resolve));
    p.emit('requestfailed', script);
  });
  const result = await run(page), r = result.failureDiagnostics.resourceObservation;
  assert.equal(result.status, 'ok'); assert.equal(result.worksCoverage, 'complete');
  assert.equal(result.failureDiagnostics.stopReason, 'success');
  assert.equal(r.failuresByPhase.beforeStop.total, 0); assert.equal(r.failuresByPhase.afterStop.total, 1);
  assert.equal(result.failureDiagnostics.requests.matched, 1);
});

test('page close timeout has its own boundary, unresolved cleanup is not browser-close confirmation', async () => {
  const page = new Page(p => { p.document(); const r = p.request('script'); p.emit('request', r); p.pendingScripts.push(r); });
  page.close = () => new Promise(() => {});
  const started = Date.now();
  const result = await collectBrowserWorks({ items: [item] }, { collectOptions: { timeoutMs: 25 }, runtime: {
    readState: async () => ({ cookies: [] }), access: async () => {},
    launch: async () => ({ newContext: async () => ({ newPage: async () => page, close: async () => {} }), close: async () => {} }),
  } });
  const r = result.items[0].failureDiagnostics.resourceObservation;
  assert.ok(Date.now() - started >= 2_000);
  assert.equal(r.captureBoundary, 'page-close-timeout'); assert.equal(r.phase, 'closed');
  assert.equal(r.resources.script.unresolvedAtClose, 1); assert.equal(r.resources.script.failed, 0);
  assert.equal(r.failuresByPhase.cleanup.total, 0); assert.equal(r.trackedRequests, 0);
  const frozen = JSON.stringify(result);
  for (const request of page.pendingScripts) page.emit('requestfailed', request);
  assert.equal(JSON.stringify(result), frozen); assert.equal(page.listenerCount('requestfailed'), 0);
  assert.deepEqual(sanitizeBrowserWorksDiagnostics(JSON.parse(JSON.stringify(result.items[0].failureDiagnostics))), result.items[0].failureDiagnostics);
});
